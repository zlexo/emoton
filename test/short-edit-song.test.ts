import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeAudio, clipMotion, liveliest, motionOf, type ClipMotion } from "../pipeline/beats.ts";
import { writeWav } from "../pipeline/wav.ts";
import type { ShortPreview } from "../shared/api.ts";
import { Short } from "../schema/short.ts";
import { editFromSong, type ClipInfo } from "../src/core/short/edit-song.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";
import { checkShort, resolveShort } from "../src/core/short/resolve.ts";
import { lib, temp } from "./fixtures/helpers.ts";

const noFfmpeg = spawnSync("ffmpeg", ["-version"]).status !== 0;

const quiet = { signal: new AbortController().signal, progress() {}, log() {} };

/** A song with kicks on every beat from `firstBeat`, quiet until `dropBar`, then a held bass, louder kicks and off-beat hats. */
function song(o: { sr: number; seconds: number; bpm: number; firstBeat: number; dropBar: number }): { audio: Float32Array; dropAt: number } {
  const n = Math.round(o.sr * o.seconds), x = new Float32Array(n), beat = 60 / o.bpm;
  const dropAt = o.firstBeat + o.dropBar * 4 * beat;
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let t = o.firstBeat; t < o.seconds; t += beat) {
    const loud = t >= dropAt - 1e-6;
    const k0 = Math.round(t * o.sr);
    for (let k = 0; k < 0.09 * o.sr && k0 + k < n; k++) x[k0 + k]! += (loud ? 0.6 : 0.2) * Math.exp(-k / (0.025 * o.sr)) * Math.sin((2 * Math.PI * 60 * k) / o.sr);
    if (loud) {
      const h0 = Math.round((t + beat / 2) * o.sr);
      for (let k = 0; k < 0.03 * o.sr && h0 + k < n; k++) x[h0 + k]! += 0.15 * Math.exp(-k / (0.008 * o.sr)) * noise();
    }
  }
  for (let k = Math.round(dropAt * o.sr); k < n; k++) x[k]! += 0.35 * Math.sin((2 * Math.PI * 55 * k) / o.sr);
  return { audio: x, dropAt };
}

test("a song's tempo, first beat and drop are found", () => {
  for (const s of [{ bpm: 128, firstBeat: 0.31, dropBar: 8 }, { bpm: 96, firstBeat: 0.12, dropBar: 6 }, { bpm: 150, firstBeat: 0.2, dropBar: 12 }]) {
    const { audio, dropAt } = song({ sr: 11025, seconds: 40, ...s });
    const a = analyzeAudio(audio, 11025);
    assert.ok(Math.abs(a.bpm - s.bpm) <= 0.5, `${s.bpm} BPM found as ${a.bpm}`);
    const beat = 60 / s.bpm;
    const off = Math.abs(((a.firstBeat - s.firstBeat + beat / 2) % beat + beat) % beat - beat / 2);
    assert.ok(off < 0.03, `first beat ${s.firstBeat} found as ${a.firstBeat}`);
    assert.ok(Math.abs(a.dropAt - dropAt) < 0.1, `the drop at ${dropAt.toFixed(2)} found at ${a.dropAt}`);
    assert.equal(a.seconds, 40);
  }
});

test("a clip's liveliest stretch is where it moves most, and repeats look elsewhere", () => {
  const w = 4, h = 4, still = new Uint8Array(w * h).fill(40);
  const frames: Uint8Array[] = [];
  for (let f = 0; f < 80; f++) frames.push(f >= 40 && f < 56 ? new Uint8Array(w * h).map((_, i) => (f * 37 + i * 11) % 255) : still);
  const m: ClipMotion = { fps: 8, seconds: 10, motion: motionOf(Uint8Array.from(frames.flatMap((x) => [...x])), w, h) };
  assert.equal(m.motion.length, 80);
  assert.equal(liveliest(m, 2), 5, "frames 40 to 56 move: 5 s to 7 s");
  const second = liveliest(m, 2, [5]);
  assert.ok(Math.abs(second - 5) >= 2, "the next stretch avoids the first");
  assert.equal(liveliest({ ...m, motion: m.motion.slice(0, 8) }, 2), 0, "a clip shorter than the stretch starts at 0");
});

test("clip motion from a real file: a still second, then a moving one", { skip: noFfmpeg }, () => {
  const t = temp();
  try {
    const f = join(t.base, "c.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:size=180x320:rate=24:duration=2", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=24:duration=2",
      "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", f]);
    return clipMotion(t.base, f).then((m) => {
      assert.ok(Math.abs(m.seconds - 4) < 0.3, `${m.seconds} s`);
      assert.ok(liveliest(m, 1) >= 1.9, `the moving half: ${liveliest(m, 1)}`);
    }).finally(() => t.done());
  } catch (e) {
    t.done();
    throw e;
  }
});

const clip = (asset: string, seconds: number): ClipInfo => ({ asset, seconds, lively: (len, used) => (used.length * len) % Math.max(1, seconds - len) });

test("an edit cuts a bar at a time up to the drop, then every two beats with a punch per bar; its song's drop lands on the drop", () => {
  const s = { asset: "assets/music/s.mp3", bpm: 120, firstBeat: 0.25, dropAt: 0.25 + 8 * 2, seconds: 60 };
  const d = Short.parse(editFromSong({ title: "Edit", song: s, clips: [clip("assets/clips/a.mp4", 20), clip("assets/clips/b.mp4", 20), clip("assets/clips/c.mp4", 1)] }));
  assert.deepEqual(checkShort(d, { voice: estimatedVoice(d) }), []);
  assert.deepEqual(d.scenes.slice(0, 5).map((x) => [x.id, x.hold, x.in]), [["b1", 2, "cut"], ["b2", 2, "cut"], ["b3", 2, "cut"], ["b4", 2, "cut"], ["drop", 1, "drop"]]);
  assert.equal(d.scenes.length, 4 + 16);
  assert.equal(d.fx.filter((f) => f.kind === "punch").length, 8, "a punch on every bar after the drop");
  const m = d.music!.source;
  assert.ok("file" in m && m.file.dropAt === s.dropAt && JSON.stringify(m.file.align) === '{"scene":"drop","edge":"start"}');
  assert.ok(d.exportPresets!.includes("nomusic"));
  const r = resolveShort(d, { voice: estimatedVoice(d) });
  assert.equal(r.scenes.find((x) => x.id === "drop")!.from, 8, "four bars of two seconds before the drop");
  // a clip shorter than its cut plays from its start
  assert.ok(d.scenes.filter((x) => x.visual?.type === "clip" && x.visual.asset.endsWith("c.mp4")).every((x) => x.visual?.type === "clip" && x.visual.from === undefined));
  // the same seed cuts the same; another re-rolls the order
  const again = editFromSong({ title: "Edit", song: s, clips: [clip("assets/clips/a.mp4", 20), clip("assets/clips/b.mp4", 20), clip("assets/clips/c.mp4", 1)] });
  assert.deepEqual(again, d);
  const orders = new Set([2, 3, 4, 5, 6].map((seed) => editFromSong({ title: "Edit", song: s, seed, clips: [clip("a", 20), clip("b", 20), clip("c", 20)] }).scenes.slice(0, 3).map((x) => (x.visual as { asset: string }).asset).join()));
  assert.ok(orders.size > 1, "re-rolls change the order");
  // a song whose drop comes early gets fewer bars before it
  const early = editFromSong({ title: "E", song: { ...s, dropAt: 0.25 + 2 * 2 }, clips: [clip("a", 20)] });
  assert.equal(early.scenes.filter((x) => x.id.startsWith("b")).length, 2);
});

test("an edit's draft job: it needs a song and clips; it cuts them to the song and says what it heard", { skip: noFfmpeg }, async () => {
  const t = temp();
  try {
    const L = lib(t);
    const d = await L.newShort({ folder: "", template: "edit", title: "Week one" });
    assert.ok(!("errors" in d));
    const id = d.summary.id;
    await assert.rejects(L.plan(id, "draft"), { status: 400, message: /add one first/ });
    const { audio } = song({ sr: 22050, seconds: 30, bpm: 128, firstBeat: 0.31, dropBar: 6 });
    const wav = join(t.base, "beat.wav");
    writeWav(wav, { sr: 22050, audio });
    const { asset } = await L.addShortMusic(id, [{ name: "Beat.wav", tmpPath: wav }]);
    assert.equal(asset, "assets/music/Beat.wav");
    await assert.rejects(L.addShortMusic(id, [{ name: "x.txt", tmpPath: wav }]), { status: 400 });
    await assert.rejects(L.plan(id, "draft"), { status: 400, message: /clips/ });
    const clipFile = join(t.base, "run.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=24:duration=6", "-pix_fmt", "yuv420p", clipFile]);
    await L.addShortClips(id, [{ name: "run.mp4", tmpPath: clipFile }, { name: "jump.mp4", tmpPath: clipFile }]);
    const steps = await L.plan(id, "draft");
    assert.deepEqual(steps, [{ stage: "draft", lane: "media" }], "no brief needed: the song is the brief");
    await L.runStep(id, steps[0]!, quiet);
    const doc = (await L.shortDocument(id)).document;
    assert.ok(doc.scenes.length > 4 && doc.scenes.every((s) => s.visual?.type === "clip"));
    const m = doc.music!.source;
    assert.ok("file" in m && m.file.asset === asset && m.file.bpm === 128, JSON.stringify(m));
    const p = (await L.previewShort(id)) as ShortPreview;
    assert.match(p.draft!.notes[0]!, /^128 BPM, first beat at 0\.3\d* s, the drop at /);
    assert.ok(readFileSync(join(d.dir, "short.json"), "utf8").includes('"template": "edit"'));
    const reroll = await L.plan(id, "draft", { note: "reroll" });
    assert.deepEqual(reroll, [{ stage: "draft", lane: "media", note: "reroll" }]);
  } finally {
    t.done();
  }
});
