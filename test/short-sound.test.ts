import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { ensureScore, ensureSoundClips, synthesizeScore } from "../pipeline/sound/render.ts";
import { bundleNameFor, ensureSoundsRoot, listSounds, soundFile } from "../pipeline/sounds.ts";
import { readWav } from "../pipeline/wav.ts";
import { Short } from "../schema/short.ts";
import type { ShortDocument, ShortPreview } from "../shared/api.ts";
import { resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { lib, temp } from "./fixtures/helpers.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${n}`, import.meta.url), "utf8"));
const ep3 = () => Short.parse(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" }));

test("the sound library: made once with its folders and README, listed by category, only its own files served", () => {
  const t = temp();
  try {
    const root = join(t.base, "Emoton Sounds");
    ensureSoundsRoot(root);
    assert.ok(existsSync(join(root, "README.txt")));
    assert.ok(["boom", "ding", "scratch", "whoosh", "keys", "songs"].every((f) => existsSync(join(root, f))));
    writeFileSync(join(root, "boom", "Big Boom.wav"), "x");
    writeFileSync(join(root, "songs", "track.mp3"), "xx");
    writeFileSync(join(root, "loose.ogg"), "xxx");
    writeFileSync(join(root, "boom", "notes.txt"), "not a sound");
    ensureSoundsRoot(root); // an existing library is left alone
    assert.deepEqual(listSounds(root), [
      { path: "loose.ogg", name: "loose", category: "", size: 3 },
      { path: "boom/Big Boom.wav", name: "Big Boom", category: "boom", size: 1 },
      { path: "songs/track.mp3", name: "track", category: "songs", size: 2 },
    ]);
    assert.equal(soundFile(root, "boom/Big Boom.wav"), join(root, "boom", "Big Boom.wav"));
    for (const bad of ["../outside.wav", "/etc/passwd", "boom/notes.txt", "missing.wav"]) assert.equal(soundFile(root, bad), null, bad);
    assert.equal(bundleNameFor("boom/Big Boom.wav"), "assets/sounds/boom-Big Boom.wav");
    assert.equal(bundleNameFor("songs/track.mp3"), "assets/music/track.mp3");
  } finally {
    t.done();
  }
});

test("a library sound used in a Short is copied in; the kit's file and a one-off file reach the player", async () => {
  const t = temp();
  try {
    const root = join(t.base, "Emoton Sounds");
    const L = lib(t, { soundsRoot: root });
    const d = await L.createShort("", ep3());
    assert.ok(!("errors" in d));
    const id = d.summary.id;
    assert.deepEqual((await L.sounds()).sounds, [], "a new library is empty");
    writeFileSync(join(root, "boom", "huge.wav"), "boom!");
    const { asset } = await L.importSound(id, "boom/huge.wav");
    assert.equal(readFileSync(join(d.dir, asset), "utf8"), "boom!");
    await assert.rejects(L.importSound(id, "../nope.wav"), { status: 404 });

    const cur = await L.shortDocument(id);
    const doc = { ...cur.document, soundKit: { boom: asset } };
    (await L.saveShortDocument(id, doc, cur.revision)) as ShortDocument;
    const p = (await L.previewShort(id)) as ShortPreview;
    const booms = p.props.short.sfx.filter((x) => x.kind === "boom");
    assert.ok(booms.length > 0 && booms.every((x) => x.asset === asset && x.take === undefined), "every boom plays the kit's file");
    assert.match(p.props.media.files![asset]!, new RegExp(`^/media/${id}/assets/sounds/boom-huge\\.wav\\?v=`));
    // the other kinds play built-in clips, made once; the score is rendered from the document
    const others = p.props.short.sfx.filter((x) => x.kind !== "boom");
    assert.ok(others.every((x) => p.props.media.sounds![`${x.kind}:${x.take}`]), "every built-in sound has its clip");
    assert.match(p.props.media.music!, /\/render\/score-[0-9a-f]{12}\.wav\?v=/);
    assert.equal(readdirSync(join(d.dir, "render")).filter((f) => f.startsWith("score-")).length, 1);
  } finally {
    t.done();
  }
});

test("the score is made again only when its plan changes, and the older one goes", () => {
  const t = temp();
  try {
    const dir = join(t.base, "x.emoton");
    mkdirSync(dir);
    const d = ep3();
    const voice = fx("perdix-ep3.timing.json") as VoiceTiming;
    const a = ensureScore(dir, resolveShort(d, { voice }))!;
    assert.equal(ensureScore(dir, resolveShort(d, { voice })), a, "the same plan: the same file");
    const faster = { ...d, music: { ...d.music!, source: { synth: { style: "pad" as const, bpm: 96 } } } };
    const b = ensureScore(dir, resolveShort(faster, { voice }))!;
    assert.notEqual(b, a);
    assert.deepEqual(readdirSync(join(dir, "render")), [b.split("/")[1]]);
    const w = readWav(join(dir, b));
    assert.equal(w.sr, 48000);
    assert.ok(Math.abs(w.audio.length / 48000 - 52.653) < 0.01);
    // clips: one per kind and take, synthesized, under the peak
    const clips = ensureSoundClips(dir, resolveShort(d, { voice }));
    assert.deepEqual(Object.keys(clips).sort(), ["boom:0", "boom:1", "boom:2", "ding:0", "ding:1", "scratch:0", "scratch:1", "scratch:2"]);
    for (const rel of Object.values(clips)) assert.ok(readWav(join(dir, rel)).audio.every((v) => Math.abs(v) <= 0.951));
  } finally {
    t.done();
  }
});

/** Code Typer's render of the same score, on a machine that has a Code Typer checkout (CODE_TYPER, default ~/yt/code-typer). */
const CT_SCORE = join(process.env.CODE_TYPER ?? join(homedir(), "yt", "code-typer"), "public", "gen", "perdix-ep3-score.wav");

test("the imported ep3's score matches Code Typer's own score file", { skip: !existsSync(CT_SCORE) }, () => {
  const s = resolveShort(ep3(), { voice: fx("perdix-ep3.timing.json") as VoiceTiming });
  const ours = synthesizeScore(s.music!, s.duration)!;
  const theirs = readWav(CT_SCORE).audio;
  let max = 0;
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) max = Math.max(max, Math.abs(theirs[i]! - Math.max(-1, Math.min(1, ours[i]!))));
  assert.ok(max < 0.001, `largest sample difference ${max}`);
});
