import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChapterTiming } from "../schema/storyboard.ts";
import type { ChapterVoice, PauseEdits } from "../shared/api.ts";
import type { Tts } from "../pipeline/voice.ts";
import { paths, readJson, writeJson } from "../pipeline/project.ts";
import { isPauseEdits, tidy } from "../pipeline/voice-edits.ts";
import { readWav, writeWav } from "../pipeline/wav.ts";
import { snapshot, videoState } from "../pipeline/state.ts";
import { ctx, fixture, lib, readyBundle, temp, type Temp } from "./fixtures/helpers.ts";

const SR = 24000;

/** A voice for a timing: a tone where each sentence is, silence between. */
function voiceFor(t: Pick<ChapterTiming, "duration" | "beats">): Float32Array {
  const a = new Float32Array(Math.round(t.duration * SR));
  for (const b of t.beats) for (const s of b.sentences) for (let i = Math.round(s.start * SR); i < Math.round(s.end * SR); i++) a[i] = Math.sin(i * 0.07) * 0.4;
  return a;
}

/** The fixture video, ready, with chapter 1's stand-in WAV replaced by a real one that fits its timing. */
async function ready(t: Temp, extra = {}) {
  const L = lib(t, extra);
  const dir = await readyBundle(t);
  const id = (await L.tree()).videos[0]!.id;
  const P = paths(dir);
  writeWav(P.audio(1), { sr: SR, audio: voiceFor(readJson<ChapterTiming>(P.timing(1))) });
  return { L, dir, id, P };
}

const isChapter = (x: ChapterVoice | { errors: string[] }): ChapterVoice => {
  if ("errors" in x) throw new Error(x.errors.join("; "));
  return x;
};

/** A TTS writing a real WAV: one second of tone per sentence, 0.3 s between. */
const toneTts: Tts = async (job) => {
  let t = job.gaps.leadIn;
  const beats = job.beats.map((b) => {
    const start = t;
    const sentences = b.say.map((text) => {
      const s = { start: t, end: t + 1, text };
      t += 1.3;
      return s;
    });
    return { start, end: t, sentences };
  });
  const timing = { duration: t + 1, beats };
  writeWav(job.out, { sr: SR, audio: voiceFor(timing) });
  return JSON.stringify({ leadIn: job.gaps.leadIn, ...timing, stats: { synthesised: 1, cached: 0 } });
};

test("the Voice tab lists every voiced chapter; a chapter voiced before edits plays as spoken", async () => {
  const t = temp();
  try {
    const { L, id, P } = await ready(t);
    // chapter 2 as the voice made it before word times existed
    const t2 = readJson<ChapterTiming>(P.timing(2));
    for (const b of t2.beats) for (const s of b.sentences) delete s.words;
    writeJson(P.timing(2), t2);
    const v = await L.voice(id);
    assert.deepEqual(v.chapters.map((c) => c.n), [1, 2, 3, 4]);
    const c = v.chapters[0]!;
    assert.deepEqual(c.spoken.beats.map((b) => b.start), c.timing.beats.map((b) => b.start));
    assert.ok(c.timing.beats.flatMap((b) => b.sentences).every((s) => s.words?.length && !s.estimated), "the voice's own word times");
    assert.ok(v.chapters[1]!.timing.beats.flatMap((b) => b.sentences).every((s) => s.words?.length && s.estimated), "words estimated where the voice gave none");
    assert.match(c.timing.audio, new RegExp(`^/media/${id}/audio/ch1\\.wav\\?v=\\d+$`));
    assert.deepEqual(c.dropped, []);
  } finally {
    t.done();
  }
});

test("a pause after a sentence: the voice remade longer, later times moved, only that chapter's render stale", async () => {
  const t = temp();
  try {
    const { L, id, dir, P } = await ready(t);
    const before = readJson<ChapterTiming>(P.timing(1));
    const original = readFileSync(P.audio(1));
    const key = (await L.voice(id)).chapters[0]!.keys[0]![0]!;
    const c = isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 400 } } } satisfies PauseEdits));
    // the spoken files are the voice from before, kept as it was
    assert.deepEqual(readFileSync(P.spokenAudio(1)), original);
    assert.deepEqual(readJson<ChapterTiming>(P.spokenTiming(1)).beats, before.beats);
    // the voice is 0.4 s longer, and so is its timing; the first sentence did not move, the second did
    const after = readJson<ChapterTiming>(P.timing(1));
    assert.equal(readWav(P.audio(1)).audio.length, readWav(P.spokenAudio(1)).audio.length + 0.4 * SR);
    assert.ok(Math.abs(after.duration - before.duration - 0.4) < 1e-6);
    const s0 = before.beats.flatMap((b) => b.sentences), s1 = after.beats.flatMap((b) => b.sentences);
    assert.equal(s1[0]!.start, s0[0]!.start);
    assert.ok(Math.abs(s1[1]!.start - s0[1]!.start - 0.4) < 1e-6);
    assert.equal(after.audio, "audio/ch1.wav");
    assert.equal(c.edits.sentences[key]!.after, 400);
    // voice stays ok everywhere; only chapter 1's render needs doing again
    const st = videoState(snapshot(dir));
    assert.deepEqual(st.chapters.map((x) => x.voice), ["ok", "ok", "ok", "ok"]);
    assert.deepEqual(st.chapters.map((x) => x.render), ["stale", "ok", "ok", "ok"]);
  } finally {
    t.done();
  }
});

test("putting a pause back leaves the spoken voice, byte for byte, and no edit behind", async () => {
  const t = temp();
  try {
    const { L, id, dir, P } = await ready(t);
    const key = (await L.voice(id)).chapters[0]!.keys[0]![0]!;
    isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 400 } } }));
    isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 0, words: { "0": 0 } } } }));
    assert.deepEqual(readFileSync(P.audio(1)), readFileSync(P.spokenAudio(1)));
    assert.deepEqual(readJson(P.voiceEdits), { version: 1, chapters: {} });
    assert.deepEqual(videoState(snapshot(dir)).chapters.map((x) => x.render), ["ok", "ok", "ok", "ok"]);
  } finally {
    t.done();
  }
});

test("a re-voice keeps the edits by sentence text; an edit whose sentence is gone is reported", async () => {
  const t = temp();
  try {
    const { L, id, P } = await ready(t, { tts: toneTts });
    const ch = fixture("storyboard.json").chapters[0];
    const kept = ch.beats[0].say[0] as string;
    ch.beats[1].say[0] = "A sentence that was not there before.";
    await L.saveChapter(id, 1, ch);
    await L.runStep(id, { stage: "voice", chapter: 1, lane: "media" }, ctx());
    const keyKept = kept.toLowerCase().replace(/\s+/g, " ").trim();
    isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { [keyKept]: { after: 250 }, "a sentence nobody says.": { after: 100 } } }));
    // a narration change elsewhere in the chapter: voiced again, the kept sentence's edit still applied
    ch.beats[1].say[0] = "Another new sentence.";
    await L.saveChapter(id, 1, ch);
    const c2 = ctx();
    await L.runStep(id, { stage: "voice", chapter: 1, lane: "media" }, c2);
    assert.equal(readWav(P.audio(1)).audio.length, readWav(P.spokenAudio(1)).audio.length + 0.25 * SR);
    assert.ok(c2.logs.some((l) => /1 pause edit\(s\) applied/.test(l)), c2.logs.join("\n"));
    const c = (await L.voice(id)).chapters[0]!;
    assert.deepEqual(c.dropped, ["a sentence nobody says."]);
  } finally {
    t.done();
  }
});

test("edits are refused when malformed, and while the chapter's voice is out of date", async () => {
  const t = temp();
  try {
    const { L, id } = await ready(t);
    for (const bad of [null, { version: 2, sentences: {} }, { version: 1, sentences: { a: { after: "x" } } }, { version: 1, sentences: { a: { after: 99999 } } }, { version: 1, sentences: { a: { words: { x: 1 } } } }])
      assert.ok("errors" in (await L.saveVoiceEdits(id, 1, bad)), JSON.stringify(bad));
    const ch = fixture("storyboard.json").chapters[1];
    ch.beats[0].say[0] = "Changed, not voiced yet.";
    await L.saveChapter(id, 2, ch);
    await assert.rejects(L.saveVoiceEdits(id, 2, { version: 1, sentences: {} }), /not up to date/);
    assert.deepEqual((await L.voice(id)).chapters.map((c) => c.n), [1, 3, 4]);
  } finally {
    t.done();
  }
});

test("an edit that applies nothing (its sentence is gone) leaves the voice as spoken and the render ok", async () => {
  const t = temp();
  try {
    const { L, id, dir, P } = await ready(t);
    const before = readJson<ChapterTiming>(P.timing(1));
    // as speak.py writes them: the timing's duration rounded to the millisecond, the WAV a few samples longer
    const v = voiceFor(before);
    writeWav(P.audio(1), { sr: SR, audio: Float32Array.from({ length: v.length + 7 }, (_, i) => v[i] ?? 0) });
    const c = isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { "a sentence nobody says.": { after: 300 } } }));
    assert.deepEqual(c.dropped, ["a sentence nobody says."]);
    assert.deepEqual(readFileSync(P.audio(1)), readFileSync(P.spokenAudio(1)));
    assert.equal(readJson<ChapterTiming>(P.timing(1)).duration, before.duration);
    assert.deepEqual(videoState(snapshot(dir)).chapters.map((x) => x.render), ["ok", "ok", "ok", "ok"]);
  } finally {
    t.done();
  }
});

test("a voice that cannot be made leaves the saved edits and the voice as they were", async () => {
  const t = temp();
  try {
    const { L, id, P } = await ready(t);
    const key = (await L.voice(id)).chapters[0]!.keys[0]![0]!;
    isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 100 } } }));
    const edits = readFileSync(P.voiceEdits, "utf8"), voice = readFileSync(P.audio(1));
    writeFileSync(P.spokenAudio(1), "not a wav");
    await assert.rejects(L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 200 } } }), /not a WAV/);
    assert.equal(readFileSync(P.voiceEdits, "utf8"), edits);
    assert.deepEqual(readFileSync(P.audio(1)), voice);
  } finally {
    t.done();
  }
});

test("the edited voice replaces chN.wav by a rename: a hard link a render holds keeps its bytes", async () => {
  const t = temp();
  try {
    const { L, id, P, dir } = await ready(t);
    const held = join(dir, "held.wav");
    linkSync(P.audio(1), held);
    const original = readFileSync(held);
    const key = (await L.voice(id)).chapters[0]!.keys[0]![0]!;
    isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 100 } } }));
    isChapter(await L.saveVoiceEdits(id, 1, { version: 1, sentences: {} }));
    assert.deepEqual(readFileSync(held), original);
    assert.notEqual(statSync(held).ino, statSync(P.audio(1)).ino);
    assert.deepEqual(readdirSync(join(dir, "audio")).filter((f) => f.includes(".part.")), [], "no staging file left behind");
  } finally {
    t.done();
  }
});

test("a chapter dropped from the outline takes its edits with it", async () => {
  const t = temp();
  try {
    const { L, id, P } = await ready(t);
    writeJson(P.voiceEdits, { version: 1, chapters: { "4": { "so what does this mean?": { after: 300 } }, "1": { x: { after: 100 } } } });
    const outline = fixture("outline.json");
    outline.chapters.pop();
    const r = await L.saveOutline(id, outline);
    assert.ok(!("errors" in r), JSON.stringify(r));
    assert.deepEqual(readJson(P.voiceEdits), { version: 1, chapters: { "1": { x: { after: 100 } } } });
  } finally {
    t.done();
  }
});

test("edit keys that name Object's own properties stay ordinary keys", () => {
  const e = JSON.parse('{"version":1,"sentences":{"__proto__":{"after":100},"constructor":{"after":0}}}');
  assert.ok(isPauseEdits(e));
  const t = tidy(e);
  assert.deepEqual(Object.keys(t), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
});

test("a save that fails after the voice is made leaves no staging file", async () => {
  const t = temp();
  try {
    const { L, id, P, dir } = await ready(t);
    const key = (await L.voice(id)).chapters[0]!.keys[0]![0]!;
    // a directory where the edits file goes: the voice is made, then saving the edits fails
    mkdirSync(P.voiceEdits);
    await assert.rejects(L.saveVoiceEdits(id, 1, { version: 1, sentences: { [key]: { after: 100 } } }));
    assert.deepEqual(readdirSync(join(dir, "audio")).filter((f) => f.includes(".part.")), []);
  } finally {
    t.done();
  }
});

test("an edits file that cannot be read does not stop an outline save", async () => {
  const t = temp();
  try {
    const { L, id, P } = await ready(t);
    writeFileSync(P.voiceEdits, JSON.stringify({ version: 2 }));
    const outline = fixture("outline.json");
    outline.chapters.pop();
    const r = await L.saveOutline(id, outline);
    assert.ok(!("errors" in r), JSON.stringify(r));
    assert.equal((await L.detail(id)).chapters.length, 3);
  } finally {
    t.done();
  }
});
