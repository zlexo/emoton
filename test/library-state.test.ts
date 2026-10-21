import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StageStatus, VideoState } from "../shared/api.ts";
import type { Tts } from "../pipeline/voice.ts";
import type { Writer } from "../pipeline/write.ts";
import { jobRender, readState, renderInput, renderProps, rendererVersionV1, sha, snapshot } from "../pipeline/state.ts";
import { propsFrom } from "../pipeline/render.ts";
import { rehash } from "../pipeline/stages.ts";
import { writeJson } from "../pipeline/project.ts";
import { MASTER_VERSION } from "../pipeline/loudness.ts";
import { SLUG, ctx, fixture, fixtureChunks, lib, readyBundle, temp, type Temp } from "./fixtures/helpers.ts";

/** Every stage that is not ok, as "stage" or "stage n". */
function notOk(st: VideoState): string[] {
  const out: string[] = [];
  for (const k of ["ingest", "outline", "join"] as const) if (st[k] !== "ok") out.push(`${k} ${st[k]}`);
  for (const c of st.chapters)
    for (const k of ["storyboard", "voice", "render"] as const) if (c[k] !== "ok") out.push(`${k} ${c.n} ${c[k] as StageStatus}`);
  return out.sort();
}

async function ready(t: Temp, extra = {}) {
  const L = lib(t, extra);
  const dir = await readyBundle(t);
  const id = (await L.tree()).videos[0]!.id;
  return { L, dir, id };
}

/** Writes the fixture outline, or the fixture chapter the prompt asks for. */
const fakeWriter = (calls: string[] = [], outline = fixture("outline.json")): Writer => async (prompt, schema) => {
  if (JSON.stringify(schema).includes('"hook"')) {
    calls.push("outline");
    return outline;
  }
  const n = Number(/STORYBOARD for chapter (\d+)/.exec(prompt)![1]);
  calls.push(`chapter ${n}`);
  return fixture("storyboard.json").chapters[n - 1];
};

/** Writes a placeholder WAV and one second per sentence, reporting progress like speak.py. */
const fakeTts = (calls: string[] = []): Tts => async (job, o) => {
  calls.push(job.out);
  writeFileSync(job.out, "fake wav");
  let t = job.gaps.leadIn, done = 0;
  const total = job.beats.reduce((s, b) => s + b.say.length, 0);
  const beats = job.beats.map((b) => {
    const start = t;
    const sentences = b.say.map((text) => {
      o.onStderrLine?.(`progress ${++done} ${total}`);
      const s = { start: t, end: t + 1, text };
      t += 1.3;
      return s;
    });
    t += 0.5;
    return { start, end: t, sentences };
  });
  return JSON.stringify({ leadIn: job.gaps.leadIn, duration: t + 1, beats, stats: { synthesised: total, cached: 0 } });
};

test("migrated fixture: every stage ok and status ready", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    const d = await L.detail(id);
    assert.deepEqual(notOk(d.state), []);
    assert.equal(d.summary.status, "ready");
    assert.equal(d.summary.chapters, 4);
    assert.equal(d.markers?.length, 4);
    assert.equal(d.video, `/media/${id}/out/${SLUG}.mp4`);
  } finally {
    t.done();
  }
});

test("a narration edit makes voice n, render n and join stale, and nothing else", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    const ch = fixture("storyboard.json").chapters[1];
    ch.beats[0].say[0] = "A different first sentence.";
    const r = await L.saveChapter(id, 2, ch);
    assert.ok(!("errors" in r), JSON.stringify(r));
    assert.deepEqual(notOk(await L.state(id)), ["join stale", "render 2 stale", "voice 2 stale"]);
    assert.equal((await L.detail(id)).summary.status, "partial");
  } finally {
    t.done();
  }
});

test("a visual-only edit keeps the voice ok and makes render n stale", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    const ch = fixture("storyboard.json").chapters[0];
    ch.beats[0].visual = { type: "title", title: "A new opening title" };
    assert.ok(!("errors" in (await L.saveChapter(id, 1, ch))));
    assert.deepEqual(notOk(await L.state(id)), ["join stale", "render 1 stale"]);
  } finally {
    t.done();
  }
});

test("an outline edit makes that chapter's storyboard stale, and what follows it", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    const o = fixture("outline.json");
    o.chapters[2].goal = "See why partial reads need per-connection buffers.";
    const r = await L.saveOutline(id, o);
    assert.ok(!("errors" in r), JSON.stringify(r));
    assert.deepEqual(notOk(await L.state(id)), ["join stale", "render 3 stale", "storyboard 3 stale", "voice 3 stale"]);
  } finally {
    t.done();
  }
});

test("brief edits invalidate what they feed: voice, captions, audience, global pronounce", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t);
    await L.updateBrief(id, { captions: false });
    assert.deepEqual(notOk(await L.state(id)), ["join stale", "render 1 stale", "render 2 stale", "render 3 stale", "render 4 stale"]);
    await L.updateBrief(id, { captions: true });
    assert.deepEqual(notOk(await L.state(id)), []);
    await L.updateBrief(id, { voice: { engine: "kokoro", voice: "bf_emma", speed: 1 } });
    assert.ok(notOk(await L.state(id)).includes("voice 3 stale"));
    await L.updateBrief(id, { voice: { engine: "kokoro", voice: "af_heart", speed: 1 } });
    await L.updateBrief(id, { audience: "someone else" });
    const st = await L.state(id);
    assert.equal(st.outline, "stale");
    assert.equal(st.ingest, "ok");
    await L.updateBrief(id, { audience: fixture("project.json").audience, title: "Renamed" });
    assert.deepEqual(notOk(await L.state(id)), [], "the title is no stage's input");
    await assert.rejects(L.updateBrief(id, { minutes: 99 }), { status: 422 });
    // The global pronunciation list is merged under the brief's own.
    const L2 = lib(t, { globalPronounce: { socket: "sock-it" } });
    assert.ok(notOk(await L2.state(id)).includes("voice 1 stale"));
    const L3 = lib(t, { globalPronounce: { JSON: "overridden by the brief" } });
    assert.deepEqual(notOk(await L3.state(id)), [], "the brief's own entry wins over the global one");
    void dir;
  } finally {
    t.done();
  }
});

test("plan: nothing / make / make with pause / redo / voice only / render / draft", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    const s = (steps: { stage: string; chapter?: number; note?: string; draft?: boolean; lane: string }[]) =>
      steps.map((x) => `${x.stage}${x.chapter ? ` ${x.chapter}` : ""}${x.note ? ` "${x.note}"` : ""}${x.draft ? " draft" : ""}:${x.lane}`);
    assert.deepEqual(await L.plan(id, "make"), [], "a ready video has nothing to do");
    assert.deepEqual(await L.plan(id, "make", { draft: true }), [], "a 1080p render satisfies a draft");
    assert.deepEqual(s(await L.plan(id, "redo", { chapter: 3, note: "slower" })), ['storyboard 3 "slower":write', "voice 3:media", "render 3:media", "join:media"]);

    const ch = fixture("storyboard.json").chapters[1];
    ch.beats[0].say[0] = "A different first sentence.";
    await L.saveChapter(id, 2, ch);
    assert.deepEqual(s(await L.plan(id, "make")), ["voice 2:media", "render 2:media", "join:media"]);
    assert.deepEqual(s(await L.plan(id, "voice")), ["voice 2:media"]);
    assert.deepEqual(s(await L.plan(id, "voice", { chapter: 1 })), [], "chapter 1 is voiced");
    assert.deepEqual(s(await L.plan(id, "render", { draft: true })), ["voice 2:media", "render 2:media", "join:media"], "voice first (it is stale); the other chapters are 1080p, so no draft");
    assert.deepEqual(s(await L.plan(id, "render", { chapter: 2 })), ["voice 2:media", "render 2:media", "join:media"]);
    assert.deepEqual(s(await L.plan(id, "storyboard", { chapter: 1, note: "slower" })), ['storyboard 1 "slower":write'], "a note rewrites an up-to-date chapter");
    assert.deepEqual(s(await L.plan(id, "storyboard", { chapter: 1 })), []);
    assert.deepEqual(s(await L.plan(id, "outline", { note: "more on keep-alive" })), ['outline "more on keep-alive":write']);
    await assert.rejects(L.plan(id, "redo", { chapter: 9 }), { status: 400, message: "there is no chapter 9" });

    // A new video: ingest done at creation, the rest unknown until the outline exists.
    const d = await L.createVideo({ folder: "", brief: { topic: "event loops" }, mode: "draft" });
    assert.deepEqual(s(await L.plan(d.summary.id, "make")), ["outline:write", "storyboard:write", "voice:media", "render:media", "join:media"]);
    assert.deepEqual(s(await L.plan(d.summary.id, "make", { pauseAfterOutline: true })), ["outline:write"]);
  } finally {
    t.done();
  }
});

test("draft renders do not satisfy a full-quality make", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t);
    // Pretend chapter 1 was rendered as a 720p draft.
    const st = readState(dir);
    st.stages["render:1"] = { hash: renderInput(snapshot(dir), 1, "720p")!, at: "x", quality: "720p" };
    st.stages.join = { hash: "x", at: "x" };
    writeJson(join(dir, "state.json"), st);
    assert.deepEqual(notOk(await L.state(id)), ["join stale"], "the draft itself shows ok");
    const steps = async (o: { draft?: boolean; chapter?: number }, kind: "make" | "render" | "redo" = "make") =>
      (await L.plan(id, kind, o)).map((x) => `${x.stage}${x.chapter ?? ""}${x.draft ? " draft" : ""}`);
    assert.deepEqual(await steps({}), ["render1", "join"]);
    assert.deepEqual(await steps({ draft: true }), ["render1", "join"], "a 720p chapter among 1080p ones is re-rendered, never joined mixed");
    // All four chapters drafts: a draft make needs only the join; a full make re-renders everything.
    for (const n of [2, 3, 4]) st.stages[`render:${n}`] = { hash: renderInput(snapshot(dir), n, "720p")!, at: "x", quality: "720p" };
    writeJson(join(dir, "state.json"), st);
    assert.deepEqual(await steps({ draft: true }), ["join"]);
    assert.deepEqual(await steps({}), ["render1", "render2", "render3", "render4", "join"]);
    // One chapter at full quality among drafts: rendered, but not joined (that would mix).
    assert.deepEqual(await steps({ chapter: 2 }, "render"), ["render2"]);
    assert.deepEqual(await steps({ chapter: 2, draft: true }, "redo"), ["storyboard2", "voice2", "render2 draft", "join"]);
  } finally {
    t.done();
  }
});

test("validation: saveOutline and saveChapter return errors and write nothing", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t);
    const before = readFileSync(join(dir, "outline.json"), "utf8");
    const o = fixture("outline.json");
    o.chapters[0].claims[0].cite = ["readme:s999"];
    const r1 = await L.saveOutline(id, o);
    assert.deepEqual(r1, { errors: ["cites unknown chunk readme:s999"] });
    const r2 = await L.saveOutline(id, { title: "x" });
    assert.ok("errors" in r2 && r2.errors.some((e) => e.startsWith("hook")));
    assert.equal(readFileSync(join(dir, "outline.json"), "utf8"), before);

    const sbBefore = readFileSync(join(dir, "storyboard.json"), "utf8");
    const ch = fixture("storyboard.json").chapters[0];
    ch.beats[1].visual = { type: "diagram", nodes: [{ id: "a", label: "A" }], edges: [{ id: "e", from: "a", to: "ghost" }], steps: [{ show: ["a"] }] };
    const r3 = await L.saveChapter(id, 1, ch);
    assert.ok("errors" in r3 && r3.errors.some((e) => e.includes("ghost")), JSON.stringify(r3));
    const r4 = await L.saveChapter(id, 7, fixture("storyboard.json").chapters[0]);
    assert.deepEqual(r4, { errors: ["the outline has no chapter 7"] });
    assert.equal(readFileSync(join(dir, "storyboard.json"), "utf8"), sbBefore);
    assert.deepEqual(notOk(await L.state(id)), []);
  } finally {
    t.done();
  }
});

test("an outline with fewer chapters drops the extra chapters' storyboard, audio and render", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t);
    const o = fixture("outline.json");
    o.chapters = o.chapters.slice(0, 3);
    assert.ok(!("errors" in (await L.saveOutline(id, o))));
    const d = await L.detail(id);
    assert.equal(d.chapters.length, 3);
    for (const f of ["audio/ch4.wav", "render/ch4.mp4", "render/ch4.timing.json"]) assert.ok(!existsSync(join(dir, f)), f);
    assert.ok(existsSync(join(dir, "render/ch3.mp4")));
    assert.equal(JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")).chapters.length, 3);
    assert.ok(!("storyboard:4" in readState(dir).stages));
    // 3 chapters of 4 x 1-of-4 labels: every render and the join changed.
    assert.deepEqual(notOk(d.state), ["join stale", "render 1 stale", "render 2 stale", "render 3 stale"]);
  } finally {
    t.done();
  }
});

test("previewProps: the voiced timing with a /media URL, else estimated and silent", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    const p = (await L.previewProps(id, 2)) as { timing: { audio: string; duration: number; beats: unknown[] }; index: number; count: number; sources: Record<string, string> };
    // the file's time rides along, so a player fetches the voice again after a pause edit
    assert.match(p.timing.audio, new RegExp(`^/media/${id}/audio/ch2\\.wav\\?v=\\d+$`));
    assert.equal(p.timing.duration, fixture("render/ch2.timing.json").duration);
    assert.deepEqual([p.index, p.count], [2, 4]);
    assert.deepEqual(p.sources, { readme: "README", schema: "Storyboard schema" });

    const ch = fixture("storyboard.json").chapters[1];
    ch.beats.push({ say: ["One more beat."], visual: { type: "title", title: "More" } });
    await L.saveChapter(id, 2, ch);
    const q = (await L.previewProps(id, 2)) as typeof p;
    assert.equal(q.timing.audio, "");
    assert.equal(q.timing.beats.length, ch.beats.length, "estimated timing covers the new beat");
    await assert.rejects(L.previewProps(id, 5), /no storyboard/);
  } finally {
    t.done();
  }
});

test("runStep: a new video through outline, storyboard and voice with a fake writer and voice", async () => {
  const t = temp();
  try {
    const src = join(t.base, "notes.txt");
    writeFileSync(src, "Notes.");
    const writes: string[] = [], voices: string[] = [];
    const L = lib(t, { writer: fakeWriter(writes), tts: fakeTts(voices) });
    // the fixture storyboard is drawn for the stage layout
    const d = await L.createVideo({ folder: "", brief: { topic: "how sources become a narrated video", layout: "stage" }, sourcePaths: [src], mode: "make" });
    const id = d.summary.id;
    assert.equal(d.summary.title, "How sources become a narrated video");
    // The fixture outline cites readme/schema chunks; give the bundle matching chunks.
    writeJson(join(d.dir, "chunks.json"), fixtureChunks());
    const plan = await L.plan(id, "make");
    assert.deepEqual(plan.map((x) => x.stage), ["outline", "storyboard", "voice", "render", "join"], "ingest ran at creation (its hash covers the sources, not chunks.json)");
    const c = ctx();
    await L.runStep(id, { stage: "outline", lane: "write" }, c);
    const after = await L.detail(id);
    assert.equal(after.summary.title, fixture("outline.json").title, "the outline replaces an auto title");
    assert.equal(after.summary.status, "outline-review");
    await L.runStep(id, { stage: "storyboard", lane: "write" }, c);
    assert.deepEqual(writes, ["outline", "chapter 1", "chapter 2", "chapter 3", "chapter 4"]);
    await L.runStep(id, { stage: "voice", lane: "media" }, c);
    assert.equal(voices.length, 4);
    assert.ok(c.progressCalls.some(([, d]) => /voicing chapter 2 of 4, sentence 3 of \d+/.test(d ?? "")), "per-sentence progress");
    const st = await L.state(id);
    assert.deepEqual(notOk(st), ["join missing", "render 1 missing", "render 2 missing", "render 3 missing", "render 4 missing"]);
    assert.equal(st.chapters[0]!.duration! > 10, true);
    // Voicing again is a no-op: every chapter is up to date.
    await L.runStep(id, { stage: "voice", chapter: 1, lane: "media" }, c);
    assert.equal(voices.length, 4);
    // The auto title is replaced once; a later outline keeps a user title.
    await L.updateBrief(id, { title: "Mine" });
    await L.runStep(id, { stage: "outline", lane: "write" }, c);
    assert.equal((await L.detail(id)).summary.title, "Mine");
  } finally {
    t.done();
  }
});

test("runStep records lastError on failure and clears it after a success", async () => {
  const t = temp();
  try {
    let good = false;
    const writer: Writer = async (p, s, m, sig) => (good ? fakeWriter()(p, s, m, sig) : { title: "no chapters" });
    const { L, id } = await ready(t, { writer });
    await assert.rejects(L.runStep(id, { stage: "outline", lane: "write" }, ctx()), /still invalid after 3 attempts/);
    const st = await L.state(id);
    assert.equal(st.lastError?.stage, "outline");
    assert.match(st.lastError!.message, /invalid/);
    good = true;
    await L.runStep(id, { stage: "outline", lane: "write" }, ctx());
    assert.equal((await L.state(id)).lastError, undefined);
  } finally {
    t.done();
  }
});

test("a writer step never overwrites an edit saved while it ran (chapter and outline)", async () => {
  const t = temp();
  try {
    let release!: () => void, called!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    let started = new Promise<void>((r) => (called = r));
    const writer: Writer = async (p, sch, m, sig) => {
      called();
      await gate;
      return fakeWriter()(p, sch, m, sig);
    };
    const { L, id, dir } = await ready(t, { writer });
    const step = L.runStep(id, { stage: "storyboard", chapter: 2, lane: "write", note: "slower" }, ctx());
    await started;
    const mine = fixture("storyboard.json").chapters[1];
    mine.beats[0].say[0] = "My own edit.";
    assert.ok(!("errors" in (await L.saveChapter(id, 2, mine))));
    release();
    await assert.rejects(step, { status: 409, message: "chapter 2 was edited while it was being rewritten; your edit was kept" });
    assert.equal(JSON.parse(readFileSync(join(dir, "storyboard.json"), "utf8")).chapters[1].beats[0].say[0], "My own edit.");

    gate = new Promise<void>((r) => (release = r));
    started = new Promise<void>((r) => (called = r));
    const ostep = L.runStep(id, { stage: "outline", lane: "write" }, ctx());
    await started;
    const o = fixture("outline.json");
    o.hook = "My own hook?";
    assert.ok(!("errors" in (await L.saveOutline(id, o))));
    release();
    await assert.rejects(ostep, { status: 409 });
    assert.equal(JSON.parse(readFileSync(join(dir, "outline.json"), "utf8")).hook, "My own hook?");
  } finally {
    t.done();
  }
});

test("a render step without a chapter picks one quality for the whole video", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t, { tts: fakeTts() });
    // As after an outline rewrite that changed only chapter 3's narration.
    const ch = fixture("storyboard.json").chapters[2];
    ch.beats[0].say[0] = "A new first sentence.";
    await L.saveChapter(id, 3, ch);
    await L.runStep(id, { stage: "voice", chapter: 3, lane: "media" }, ctx());
    assert.deepEqual(jobRender(snapshot(dir), true), { quality: "1080p", chapters: [3] }, "the kept chapters are 1080p");
    assert.deepEqual(jobRender(snapshot(dir), false), { quality: "1080p", chapters: [3] });
    const st = readState(dir);
    for (const n of [1, 2, 4]) st.stages[`render:${n}`] = { hash: renderInput(snapshot(dir), n, "720p")!, at: "x", quality: "720p" };
    writeJson(join(dir, "state.json"), st);
    assert.deepEqual(jobRender(snapshot(dir), true), { quality: "720p", chapters: [3] }, "every kept chapter is a draft");
    assert.deepEqual(jobRender(snapshot(dir), false), { quality: "1080p", chapters: [1, 2, 3, 4] });
  } finally {
    t.done();
  }
});

test("rehash adopts a new renderer-version formula without re-rendering, but never for changed props", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t);
    // Pretend every render and the join were recorded with the first formula.
    const s0 = snapshot(dir);
    const st = readState(dir);
    const hashes: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const props = propsFrom(s0.project, s0.sb!, n, { ...fixture(`render/ch${n}.timing.json`), audio: `audio/ch${n}.wav` });
      const h = sha({ props, renderer: rendererVersionV1(), quality: "1080p" });
      st.stages[`render:${n}`] = { hash: h, at: "x", quality: "1080p" };
      hashes.push(h);
    }
    st.stages.join = { hash: sha(hashes), at: "x" };
    writeJson(join(dir, "state.json"), st);
    // Chapter 1 recorded under some older formula but with its props hash: adoptable too.
    const st2 = readState(dir);
    st2.stages["render:1"] = { hash: "an older formula", at: "x", quality: "1080p", props: renderProps(snapshot(dir), 1)! };
    st2.stages.join = { hash: sha(["an older formula", ...hashes.slice(1)]), at: "x" };
    writeJson(join(dir, "state.json"), st2);
    // Chapter 2's narration changed since: that render must stay stale.
    const ch = fixture("storyboard.json").chapters[1];
    ch.beats[0].say[0] = "A different first sentence.";
    await L.saveChapter(id, 2, ch);
    assert.ok(notOk(await L.state(id)).includes("render 3 stale"), "the new formula alone makes renders stale");

    const r = await rehash(t.root);
    assert.deepEqual(r.map((x) => x.chapters), [[1, 3, 4]]);
    assert.deepEqual(notOk(await L.state(id)), ["join stale", "render 2 stale", "voice 2 stale"]);
  } finally {
    t.done();
  }
});

test("rehash brings a whole ready library back to ready", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await ready(t);
    const st = readState(dir);
    for (let n = 1; n <= 4; n++) st.stages[`render:${n}`]!.hash = "formula v0";
    st.stages.join!.hash = sha({ renders: ["formula v0", "formula v0", "formula v0", "formula v0"], master: MASTER_VERSION });
    writeJson(join(dir, "state.json"), st);
    assert.equal((await L.detail(id)).summary.status, "partial");
    await rehash(t.root);
    assert.equal((await L.detail(id)).summary.status, "ready");
  } finally {
    t.done();
  }
});
