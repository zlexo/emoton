import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { paths } from "../pipeline/project.ts";
import type { ShortDocument, ShortPreview } from "../shared/api.ts";
import { ctx, lib, temp, type Temp } from "./fixtures/helpers.ts";
import { quietTts, ttsCalls as calls } from "./fixtures/quiet-tts.ts";

const FX = new URL("fixtures/codetyper/", import.meta.url);
const fx = (n: string) => JSON.parse(readFileSync(new URL(n, FX), "utf8"));
const ep3 = () => fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9", series: "perdix" });

async function short(t: Temp) {
  const L = lib(t, { tts: quietTts });
  const d = await L.createShort("", ep3());
  assert.ok(!("errors" in d));
  return { L, id: d.summary.id, dir: d.dir };
}

test("a Short's voice job: made when missing, kept while the script holds, made again when a line changes", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await short(t);
    assert.deepEqual(await L.plan(id, "make"), [{ stage: "voice", chapter: 1, lane: "media" }]);
    const c = ctx();
    for (const s of await L.plan(id, "voice")) await L.runStep(id, s, c);
    const P = paths(dir);
    assert.ok(existsSync(P.audio(1)) && existsSync(P.timing(1)), "the voice is in chapter 1's files");
    assert.deepEqual(calls.at(-1)![1], [
      "He spawned magenta. Like everything I make, at first.", "Let's get a closer look.",
      "No face. No name. No idea where he is. Honestly? Relatable.",
      "Every legend needs a name. I named him after the engine, because creativity is expensive.", "Perdix.", "And a face.",
    ], "one voice part per spoken scene, markers taken out");
    assert.deepEqual(await L.plan(id, "voice"), [], "nothing to do while the script holds");

    const cur = await L.shortDocument(id);
    const doc = structuredClone(cur.document);
    doc.scenes[0]!.push = 1.04;
    const saved = (await L.saveShortDocument(id, doc, cur.revision)) as ShortDocument;
    assert.deepEqual(await L.plan(id, "voice"), [], "a change that is not narration keeps the voice");
    doc.scenes[0]!.say![0] = "Last time, the world got textures. Now it gets a resident.";
    await L.saveShortDocument(id, doc, saved.revision);
    assert.deepEqual(await L.plan(id, "voice"), [{ stage: "voice", chapter: 1, lane: "media" }]);

    await assert.rejects(L.plan(id, "outline"), { status: 400, message: /no outline job/ });
    await assert.rejects(L.runStep(id, { stage: "join", lane: "media" }, ctx()), { status: 400 });
    assert.deepEqual(await L.plan(id, "render"), [{ stage: "voice", chapter: 1, lane: "media" }, { stage: "render", lane: "media" }], "the changed line is voiced before the export");
  } finally {
    t.done();
  }
});

test("previewShort: a silent estimate before the voice, the voice and the shots on disk after", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await short(t);
    const before = (await L.previewShort(id)) as ShortPreview;
    assert.equal(before.voiced, false);
    assert.equal(before.props.media.voice, undefined);
    assert.equal(before.props.short.scenes.length, 6);

    for (const s of await L.plan(id, "voice")) await L.runStep(id, s, ctx());
    mkdirSync(join(dir, "shots"), { recursive: true });
    writeFileSync(join(dir, "shots", "walk.mp4"), "mp4");
    const after = (await L.previewShort(id)) as ShortPreview;
    assert.equal(after.voiced, true);
    assert.match(after.props.media.voice!, new RegExp(`^/media/${id}/audio/ch1\\.wav\\?v=\\d+$`));
    assert.deepEqual(Object.keys(after.props.media.footage), ["walk"], "a shot not rendered yet is left to its placeholder");
    // the voice is what the timeline follows: 6 parts, its last line 1 s long
    const last = after.props.short.sentences.at(-1)!;
    assert.equal(+(last.end - last.start).toFixed(3), 1);

    // a line changed since the voice: back to the estimate, silent, until it is voiced again
    const cur = await L.shortDocument(id);
    const doc = structuredClone(cur.document);
    doc.scenes[1]!.say![2] = "No face. No name. No clue where he is.";
    const saved = (await L.saveShortDocument(id, doc, cur.revision)) as ShortDocument;
    const stale = (await L.previewShort(id)) as ShortPreview;
    assert.equal(stale.voiced, false);
    assert.equal(stale.props.media.voice, undefined);

    // rewriting a line a shot's cue is pinned to leaves the cue naming nothing: refused with the reason
    doc.scenes[1]!.say![4] = "Perdix! [boom]";
    await L.saveShortDocument(id, doc, saved.revision);
    assert.deepEqual(await L.previewShort(id), { errors: ['scene born knob TAG_AT: no line "perdix." in the script'] });
  } finally {
    t.done();
  }
});

test("a make job plans the voice first, then shots that can render and proxies for footage without a fresh one", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await short(t);
    mkdirSync(join(dir, "shots"), { recursive: true });
    writeFileSync(join(dir, "shots", "walk.mp4"), "mp4");
    assert.deepEqual(await L.plan(id, "make"), [{ stage: "voice", chapter: 1, lane: "media" }, { stage: "proxies", lane: "media" }]);
    // with a shot tool for the shots' build, the voice's new timing may make them stale: they follow it
    const none = process.env.EMOTON_SHOT_TOOLS;
    process.env.EMOTON_SHOT_TOOLS = join(t.base, "tools");
    mkdirSync(process.env.EMOTON_SHOT_TOOLS);
    writeFileSync(join(process.env.EMOTON_SHOT_TOOLS, "shot-c0bece9"), "");
    try {
      assert.deepEqual(await L.plan(id, "make"), [{ stage: "voice", chapter: 1, lane: "media" }, { stage: "shots", lane: "media" }, { stage: "proxies", lane: "media" }]);
    } finally {
      process.env.EMOTON_SHOT_TOOLS = none;
    }
    assert.deepEqual(await L.plan(id, "voice"), [{ stage: "voice", chapter: 1, lane: "media" }], "a voice job leaves the proxies alone");
    // a proxy newer than its footage is fresh
    mkdirSync(join(dir, "proxies", "shots"), { recursive: true });
    writeFileSync(join(dir, "proxies", "shots", "walk.mp4"), "proxy");
    assert.deepEqual(await L.plan(id, "make"), [{ stage: "voice", chapter: 1, lane: "media" }]);
    const p = (await L.previewShort(id)) as ShortPreview;
    assert.match(p.props.media.footage.walk!, /\/proxies\/shots\/walk\.mp4\?v=/);
  } finally {
    t.done();
  }
});


test("peaks: the loudest sample per hundredth of a second, 0 to 255", async () => {
  const { peaksOf } = await import("../pipeline/peaks.ts");
  const sr = 1000, audio = new Float32Array(2000);
  audio[5] = -0.5; // first hundredth
  audio[1500] = 1; // the 151st
  const p = peaksOf(audio, sr);
  const bytes = [...Buffer.from(p.peaks, "base64")];
  assert.equal(p.seconds, 2);
  assert.equal(bytes.length, 200);
  assert.equal(bytes[0], 128);
  assert.equal(bytes[150], 255);
  assert.equal(bytes.filter((b) => b > 0).length, 2);
});

test("a Short's voice in the Voice API: pauses edited once voiced, renamed with a rewritten line", async () => {
  const t = temp();
  try {
    const { L, id, dir } = await short(t);
    assert.deepEqual((await L.voice(id)).chapters, [], "nothing until it is voiced");
    await assert.rejects(L.saveVoiceEdits(id, 1, { version: 1, sentences: {} }), { status: 409 });
    for (const s of await L.plan(id, "voice")) await L.runStep(id, s, ctx());
    const v = await L.voice(id);
    assert.equal(v.chapters.length, 1);
    assert.equal(v.chapters[0]!.keys.flat().length, 17);
    assert.match(v.chapters[0]!.timing.audio, new RegExp(`^/media/${id}/audio/ch1\\.wav\\?v=\\d+$`));
    const before = v.chapters[0]!.timing.duration;
    const c = await L.saveVoiceEdits(id, 1, { version: 1, sentences: { "perdix.": { after: 500 } } });
    assert.ok(!("errors" in c));
    assert.equal(+(c.timing.duration - before).toFixed(3), 0.5, "the pause is in the voice at once");
    await assert.rejects(L.saveVoiceEdits(id, 2, { version: 1, sentences: {} }), { status: 404 });

    await L.renameShortPauses(id, [{ from: "perdix.", to: "perdix!", words: 1 }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "voice-edits.json"), "utf8")).chapters["1"], { "perdix!": { after: 500 } });
  } finally {
    t.done();
  }
});
