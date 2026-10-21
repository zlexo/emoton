import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromDevlogJob, fromMontageJob, type DevlogJob, type MontageJob } from "../pipeline/codetyper.ts";
import { Short } from "../schema/short.ts";
import { resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { shortFrames } from "../src/remotion/shorts/props.ts";

// Fixtures: Code Typer's job files, the voice timing it made for them (its TTS cache plus the
// job's pause edits, through its own voiceover.ts), and what it resolved: public/gen/<job>-props.json
// and each shot's key file (shots/perdix/out/<job>-<shot>.key: the knobs it rendered with).
const fx = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${name}`, import.meta.url), "utf8"));
type Expected = {
  props: { segs: { from?: number; seconds: number; cont?: boolean; drop?: boolean; zoom?: [number, number] }[]; subs: { text: string; from: number; to: number }[]; punches: number[]; end?: { seconds: number } };
  shots: Record<string, { kind: string; frames: number; env: Record<string, string> }>;
};

for (const ep of ["perdix-ep1", "perdix-ep2", "perdix-ep3"]) {
  test(`${ep}: resolving the imported episode gives Code Typer's props`, () => {
    const job = fx(`${ep}.job.json`) as DevlogJob;
    const want = fx(`${ep}.expected.json`) as Expected;
    const doc = Short.parse(fromDevlogJob(job, { build: "c0bece9", series: "perdix" }));
    const r = resolveShort(doc, { voice: fx(`${ep}.timing.json`) as VoiceTiming });
    const p = want.props;

    assert.deepEqual(r.scenes.map((s) => s.seconds), p.segs.map((s) => s.seconds), "scene lengths");
    assert.deepEqual(r.scenes.map((s) => s.footage.from), p.segs.map((s) => s.from ?? 0), "where each scene starts in its footage");
    assert.deepEqual(r.scenes.map((s) => s.in), p.segs.map((s) => (s.drop ? "drop" : s.cont ? "cut" : "flash")), "how each scene comes in");
    assert.deepEqual(r.scenes.map((s) => s.push[1]), p.segs.map((s) => s.zoom?.[1] ?? 1.06), "push-ins");
    // ep1 was voiced on 10-10 before Emoton's 0d8aa06 moved Kokoro's word times 40 ms to where the
    // sound is; its lines still match to the millisecond, its words cannot be made again
    if (ep === "perdix-ep1") assert.deepEqual(r.captions.map((c) => c.text), p.subs.map((c) => c.text), "caption chunks");
    else assert.deepEqual(r.captions.map((c) => ({ text: c.text, from: c.from, to: c.to })), p.subs, "caption chunks");
    assert.deepEqual(r.fx.filter((f) => f.kind === "punch").map((f) => f.at), p.punches, "punch-ins");
    const total = p.segs.reduce((t, s) => t + s.seconds, 0);
    assert.ok(Math.abs(r.duration - total) < 0.002, `length ${r.duration} against ${total}`);
    const end = r.text.find((t) => t.role === "end")!;
    assert.ok(Math.abs(end.from - (total - p.end!.seconds)) < 0.002 && end.to === r.duration, "the end card over the last seconds");

    // every shot Code Typer rendered, with the knobs it rendered with
    for (const [name, key] of Object.entries(want.shots)) {
      const s = r.shots.find((x) => x.scene === name);
      if (!s) continue; // a key left behind by a shot the job no longer has
      assert.equal(s.kind, key.kind, `${name} kind`);
      assert.equal(Math.ceil(s.seconds * 60) + 8, key.frames, `${name} frames`);
      assert.deepEqual(Object.keys(s.knobs).sort(), Object.keys(key.env).sort(), `${name} knob names`);
      for (const [k, v] of Object.entries(key.env)) {
        const got: unknown = s.knobs[k];
        assert.ok(typeof got === "number" ? got === Number(v) : String(got) === v, `${name} ${k}: ${got} against ${v}`);
      }
    }
    // ep1 was rendered before Code Typer kept key files: it has none to compare
    if (Object.keys(want.shots).length) assert.ok(r.shots.every((s) => want.shots[s.scene]), "no shot Code Typer did not render");
  });
}

test("perdix-ep2: the code chapter opens a hole in the voice", () => {
  const doc = Short.parse(fromDevlogJob(fx("perdix-ep2.job.json"), { build: "c0bece9" }));
  const voice = fx("perdix-ep2.timing.json") as VoiceTiming;
  const r = resolveShort(doc, { voice });
  assert.equal(r.voice.length, 2);
  const code = r.scenes.find((s) => s.id === "code-yoink")!;
  const hole = r.voice[1]!.at - r.voice[0]!.to;
  assert.ok(Math.abs(r.voice[0]!.to - (voice.beats[2]!.end + 0.05)) < 0.001, "the hole starts just after the line before the code");
  assert.ok(Math.abs(r.duration - (voice.duration + hole)) < 0.002, "everything after it moves by the hole");
  assert.equal(code.seconds, 5);
  assert.deepEqual(r.sfx.filter((s) => ["mash", "keys", "riser", "impact"].includes(s.kind)).map((s) => s.kind), ["mash", "keys", "riser", "impact"]);
});

test("perdix-milestones: the montage's segments, captions, hook and drop", () => {
  const job = fx("perdix-milestones.job.json") as MontageJob;
  const doc = Short.parse(fromMontageJob(job, { media: (p) => `assets/${p.split("/").pop()}` }));
  const r = resolveShort(doc);
  let t = 0;
  const starts = job.segs.map((s) => ((t += s.seconds), +(t - s.seconds).toFixed(3)));
  assert.deepEqual(r.scenes.map((s) => s.from), starts);
  assert.deepEqual(r.scenes.map((s) => s.footage.from), job.segs.map((s) => s.from ?? 0));
  const src = r.music!.source as { synth: { cuts: number[]; drop: number; hookEnd: number } };
  assert.deepEqual(src.synth.cuts, starts.filter((_, i) => !job.segs[i]!.cont), "the cuts the beat hears");
  assert.equal(src.synth.drop, starts[job.segs.findIndex((s) => s.drop)]);
  assert.equal(src.synth.hookEnd, job.hook!.seconds);
  assert.deepEqual(r.text.filter((x) => x.role === "big").map((x) => [x.text, x.sub]), job.segs.filter((s) => s.big).map((s) => [s.big, s.small]));
});

test("the composition lasts as long as Code Typer's renders: ep3 3,160 frames, the milestones 1,338", () => {
  const ep3 = resolveShort(Short.parse(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" })), { voice: fx("perdix-ep3.timing.json") as VoiceTiming });
  const ms = resolveShort(Short.parse(fromMontageJob(fx("perdix-milestones.job.json"), { media: (p) => `assets/${p.split("/").pop()}` })));
  // the frame counts ffprobe reports for out/perdix-ep3.mp4 and out/perdix-milestones-no-music.mp4
  assert.equal(shortFrames(ep3), 3160);
  assert.equal(shortFrames(ms), 1338);
});
