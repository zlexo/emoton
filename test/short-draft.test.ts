import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { ShortDraft, draftPrompt, draftShort, fromDraft, recentCommits, type ShotKinds } from "../pipeline/short-draft.ts";
import { writerSchema } from "../schema/storyboard.ts";
import { shotKinds } from "../pipeline/shots.ts";
import type { Writer } from "../pipeline/write.ts";
import type { ShortPreview } from "../shared/api.ts";
import { Short } from "../schema/short.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";
import { checkShort, resolveShort } from "../src/core/short/resolve.ts";
import { SERIES } from "../src/core/short/series.ts";
import { startShort } from "../src/core/short/templates.ts";
import { lib, readyBundle, temp } from "./fixtures/helpers.ts";

const perdix = SERIES.perdix!;
const kinds = shotKinds() as ShotKinds;
const start = () => startShort("devlog", { title: "perdix-ep4", series: perdix, episode: 4 });
const quiet = { signal: new AbortController().signal, progress() {}, log() {} };

const DRAFT: ShortDraft = {
  title: "Perdix gets a life",
  scenes: [
    { id: "intro", say: ["Last time, Perdix walked into one block and stood there. Forever.", "So today, I gave him a life. [boom]"], shot: { kind: "perdix-stuck", knobs: { SIDE: 3 } } },
    { id: "stroll", say: ["Every few seconds he picks a spot and walks to it.", "Then he breaks into a sprint, for no reason."], shot: { kind: "perdix-walk", cues: [{ knob: "WALK_FROM", word: "walks" }, { knob: "SPRINT_FROM", word: "sprint," }, { knob: "JUMP_FROM", word: "leap" }] } },
    { id: "stare", say: ["Sometimes he stares at me. For a long time. [boom]"], shot: { kind: "perdix-dance", knobs: {} }, card: { title: "He stares" } },
    { id: "same", say: ["Same spot, still staring."], continue: true },
    { id: "code", hold: 4, code: { path: "src/game/life.cpp", ref: "a1b2c3d", lines: [{ from: 10, to: 40 }], caption: "life mode" } },
    { id: "outro", say: ["So you tell me: what does he learn next? Follow. [scratch]"], shot: { kind: "stream", knobs: { GROW: 1.2, WOBBLE: 3 } } },
  ],
  notes: ["Check that life mode is on main the day this goes out."],
};

test("a draft becomes a document on the series' settings: cues on their words, unknown kinds and knobs left out with a note", () => {
  const { doc, notes } = fromDraft(DRAFT, start(), { build: "abc1234", kinds, repo: "~/yt/perdix", series: perdix });
  assert.deepEqual(checkShort(Short.parse(doc), { voice: estimatedVoice(doc) }), []);
  assert.deepEqual(doc.voice, perdix.voice, "the series' voice, captions and music stay");
  assert.deepEqual(doc.music, perdix.music);
  assert.ok(doc.scenes.every((s) => s.in === "cut" && s.push === 1.02));

  const stroll = doc.scenes[1]!.visual!;
  assert.equal(stroll.type, "shot");
  if (stroll.type !== "shot") return;
  assert.equal(stroll.build, "abc1234");
  assert.deepEqual(stroll.knobs.WALK_FROM, { word: { s: "every few seconds he picks a spot and walks to it.", w: 8 } });
  assert.deepEqual(stroll.knobs.SPRINT_FROM, { word: { s: "then he breaks into a sprint, for no reason.", w: 5 } }, "punctuation does not stop a word matching");
  assert.equal(stroll.knobs.JUMP_FROM, undefined);
  assert.deepEqual(doc.scenes[2]!.visual, { type: "card", title: "He stares" }, "a kind Perdix cannot make yet: its card stands in");
  assert.equal(doc.scenes[3]!.continue, true);
  assert.deepEqual(doc.scenes[4]!.visual, { type: "code", files: [{ path: "src/game/life.cpp", repo: "~/yt/perdix", ref: "a1b2c3d", lines: [[10, 40]] }], caption: "life mode" });
  assert.equal(doc.scenes[4]!.hold, 4);
  const outro = doc.scenes[5]!.visual!;
  assert.ok(outro.type === "shot" && outro.knobs.GROW === 1.2 && !("WOBBLE" in outro.knobs));

  const end = doc.text.find((t) => t.role === "end")!;
  assert.equal(end.text, "PART 4");
  assert.deepEqual(end.to, { scene: "outro", edge: "end" }, "the end card moves to the drafted last scene");
  assert.deepEqual(notes, [
    "Check that life mode is on main the day this goes out.",
    'stare: no shot kind "perdix-dance" yet; a card stands in',
    "outro: stream has no knob WOBBLE",
    'stroll: the cue JUMP_FROM names "leap", which its lines do not say',
  ]);
  const r = resolveShort(doc, { voice: estimatedVoice(doc) });
  assert.ok(r.shots.find((x) => x.scene === "stroll")!.knobs.SPRINT_FROM! > r.shots.find((x) => x.scene === "stroll")!.knobs.WALK_FROM!, "the sprint cue resolves after the walk cue");
});

test("the draft's JSON Schema is one the claude CLI accepts: no union types, no tuples", () => {
  const bad: string[] = [];
  const walk = (x: unknown, at: string) => {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${at}/${i}`));
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (k === "prefixItems") bad.push(`${at}: prefixItems (a tuple)`);
      if (k === "type" && typeof v !== "string") bad.push(`${at}: type ${JSON.stringify(v)} (a union)`);
      walk(v, `${at}/${k}`);
    }
  };
  walk(writerSchema(ShortDraft), "#");
  assert.deepEqual(bad, []);
});

test("the commit list reads a repo given from the home folder", () => {
  // this repo, named from ~ when it lives there: the log must come back either way
  const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const home = process.env.HOME ?? "";
  const named = here.startsWith(home + "/") ? `~${here.slice(home.length)}` : here;
  assert.ok(recentCommits(named, 3).length > 0, `no commits read from ${named}`);
});

test("the prompt carries the series' rules, the shot kinds and the brief; a rejected draft goes back with its problems", async () => {
  const p = draftPrompt({ title: "perdix-ep4", template: "devlog", brief: "Perdix gets a life.", series: perdix, kinds, commits: "abc1234 Life mode: strolls\nsrc/game/life.cpp" });
  for (const want of ['say "I built", never "I coded"', "perdix-walk:", "SPRINT_FROM (time: pin it with a cue)", "Perdix gets a life.", "abc1234 Life mode", "PART {n}", "CAM default 0 (0 beside him, 1 from your eyes, 2 a god's orbit)", "its own SEED"]) assert.ok(p.includes(want), want);

  const prompts: string[] = [];
  const bad = structuredClone(DRAFT);
  bad.scenes[0]!.say = ["Last time, I coded a block he could not climb."];
  const noFile = structuredClone(DRAFT);
  noFile.scenes[4]!.code!.path = "src/game/nope.cpp";
  const answers = [bad, noFile, DRAFT];
  const writer: Writer = async (prompt, _schema, _model, _signal, system) => {
    prompts.push(prompt);
    assert.match(system ?? "", /vertical Shorts/);
    return answers.shift();
  };
  const hasFile = (_repo: string, ref: string, path: string) => ref === "a1b2c3d" && path === "src/game/life.cpp";
  const out = await draftShort(start(), { writer, model: "opus", brief: "Perdix gets a life.", build: "abc1234", kinds, repo: "~/yt/perdix", commits: "", hasFile });
  assert.equal(out.attempts, 3);
  assert.match(prompts[1]!, /intro: "I coded" \(the series says "I built"\)/);
  assert.match(prompts[2]!, /code: src\/game\/nope\.cpp is not in Perdix at a1b2c3d/, "a code scene must name a real file");
  assert.equal(out.doc.scenes.length, 6);

  const never: Writer = async () => ({ title: "x", scenes: [{ id: "a", say: ["I coded it."] }], notes: [] });
  await assert.rejects(draftShort(start(), { writer: never, model: "opus", brief: "x", build: "abc1234", kinds, repo: "~", commits: "" }), /still invalid after 3 attempts/);
});

test("a draft job: only for a Short with a brief; it replaces the document and leaves its notes for the editor", async () => {
  const t = temp();
  try {
    // no code scene: this library's Perdix repo has no such commit
    const writer: Writer = async () => ({ ...DRAFT, scenes: DRAFT.scenes.filter((s) => !s.code) });
    const L = lib(t, { writer });
    const ep3 = await L.createShort("", fromDevlogJob(JSON.parse(readFileSync(new URL("fixtures/codetyper/perdix-ep3.job.json", import.meta.url), "utf8")), { build: "c0bece9", series: "perdix" }));
    assert.ok(!("errors" in ep3));
    const empty = await L.newShort({ folder: "", template: "devlog", series: "perdix" });
    assert.ok(!("errors" in empty));
    await assert.rejects(L.plan(empty.summary.id, "draft"), { status: 400, message: /needs a brief/ });

    const d = await L.newShort({ folder: "", template: "devlog", series: "perdix", brief: "Perdix gets a life." });
    assert.ok(!("errors" in d));
    assert.equal(d.summary.title, "perdix-ep5", "ep4 above took 4");
    const steps = await L.plan(d.summary.id, "draft");
    assert.deepEqual(steps, [{ stage: "draft", lane: "write" }]);
    await L.runStep(d.summary.id, steps[0]!, quiet);
    const doc = (await L.shortDocument(d.summary.id)).document;
    assert.deepEqual(doc.scenes.map((s) => s.id), ["intro", "stroll", "stare", "same", "outro"]);
    assert.equal(doc.text.find((x) => x.role === "end")!.text, "PART 5");
    const walk = doc.scenes[1]!.visual!;
    assert.ok(walk.type === "shot" && walk.build.length >= 7, "shots carry a build");
    const p = (await L.previewShort(d.summary.id)) as ShortPreview;
    assert.ok(p.draft && p.draft.attempts === 1 && p.draft.notes.includes('stare: no shot kind "perdix-dance" yet; a card stands in'));
    assert.ok(existsSync(join(d.dir, "draft.json")));

    const video = await readyBundle(t);
    const id = JSON.parse(readFileSync(join(video, "project.json"), "utf8")).id as string;
    await assert.rejects(L.plan(id, "draft"), { status: 400, message: /only a Short is drafted/ });
  } finally {
    t.done();
  }
});
