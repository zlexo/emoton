import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { mixArgs, mixLayers, phoneBitrate, PHONE_LIMIT, sceneFrames, sceneKey } from "../pipeline/short-export.ts";
import { Short } from "../schema/short.ts";
import { resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { shortFrames } from "../src/remotion/shorts/props.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${n}`, import.meta.url), "utf8"));
const voice = fx("perdix-ep3.timing.json") as VoiceTiming;
const ep3 = () => Short.parse(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" }));

test("scene frames run back to back from 0 to the composition's last frame", () => {
  const s = resolveShort(ep3(), { voice });
  const r = sceneFrames(s);
  assert.equal(r[0]!.first, 0);
  assert.equal(r.at(-1)!.last, shortFrames(s) - 1);
  for (let i = 1; i < r.length; i++) assert.equal(r[i]!.first, r[i - 1]!.last + 1);
  assert.equal(r.length, 6);
});

test("a scene's key changes only when something that shows during it changes", () => {
  const d = ep3();
  const s = resolveShort(d, { voice });
  const before = s.scenes.map((_, i) => sceneKey(s, i, undefined, "code"));
  assert.equal(new Set(before).size, 6, "every scene has its own key");
  // a caption chunk in the walk scene hidden: only walk's key changes
  const walkLine = s.sentences.find((x) => x.scene === "walk" && x.line === 1)!;
  const hidden = { ...d, captions: { ...d.captions, overrides: [{ word: { s: walkLine.key, w: 0 }, op: "hide" as const }] } };
  const s2 = resolveShort(hidden, { voice });
  const after = s2.scenes.map((_, i) => sceneKey(s2, i, undefined, "code"));
  assert.deepEqual(after.map((k, i) => k !== before[i]), [false, false, true, false, false, false]);
  // the end card's text changed: only the last scene
  const card = { ...d, text: d.text.map((t) => (t.role === "end" ? { ...t, text: "PART 4" } : t)) };
  const s3 = resolveShort(card, { voice });
  assert.deepEqual(s3.scenes.map((_, i) => sceneKey(s3, i, undefined, "code") !== before[i]), [false, false, false, false, false, true]);
  // the drawing code changed: every scene
  assert.ok(s.scenes.every((_, i) => sceneKey(s, i, undefined, "other code") !== before[i]));
});

test("the mix's layers: the voice's pieces, the music (a song ducked), every sound at its time", () => {
  const d = ep3();
  const s = resolveShort(d, { voice });
  const sounds = Object.fromEntries(s.sfx.filter((x) => x.take !== undefined).map((x) => [`${x.kind}:${x.take}`, `/c/${x.kind}-${x.take}.wav`]));
  const all = mixLayers(s, { voice: "/v.wav", music: "/score.wav", sounds, assets: {} }, { music: true });
  assert.equal(all.filter((l) => l.file === "/v.wav").length, 1, "one voice piece: ep3 has no held scenes");
  assert.deepEqual(all.find((l) => l.file === "/score.wav"), { file: "/score.wav", at: 0, from: 0, gainDb: s.music!.gainDb }, "the score carries its own ducking");
  assert.equal(all.filter((l) => l.file.startsWith("/c/")).length, s.sfx.length);
  assert.equal(mixLayers(s, { voice: "/v.wav", music: "/score.wav", sounds, assets: {} }, { music: false }).some((l) => l.file === "/score.wav"), false, "no music: no music layer");

  const song = Short.parse({ ...d, music: { source: { file: { asset: "assets/music/s.mp3", dropAt: 30, align: { scene: "walk", edge: "start" } } }, gainDb: -12, duck: { depthDb: -10, hold: 0.4 } } });
  const ss = resolveShort(song, { voice });
  const m = mixLayers(ss, { voice: "/v.wav", music: "/s.mp3", sounds, assets: {} }, { music: true }).find((l) => l.file === "/s.mp3")!;
  assert.equal(m.from, +(30 - ss.scenes[2]!.from).toFixed(3), "the song starts so its drop lands on walk");
  assert.ok(m.duck && m.duck.spans.length > 0 && m.duck.spans.length < ss.sentences.length, "ducked under the voice, short gaps held");
});

test("mixArgs: each file read once and split per use, each layer trimmed, gained, ducked and delayed, all mixed to the length", () => {
  const args = mixArgs([
    { file: "/v.wav", at: 0, from: 0, to: 10, gainDb: 0 },
    { file: "/v.wav", at: 15, from: 10, to: 20, gainDb: 0 },
    { file: "/boom.wav", at: 2.5, gainDb: -5 },
    { file: "/s.mp3", at: 0, from: 4, gainDb: -12, duck: { depthDb: -10, spans: [[1, 3]] } },
  ], 25, "/out.wav");
  assert.deepEqual(args.filter((a, i) => args[i - 1] === "-i"), ["/v.wav", "/boom.wav", "/s.mp3"]);
  const graph = args[args.indexOf("-filter_complex") + 1]!;
  assert.match(graph, /\[0:a\]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2\[i0_0\]\[i0_1\]/);
  assert.match(graph, /\[i0_1\]atrim=start=10:end=20,asetpts=PTS-STARTPTS,adelay=15000:all=1\[l1\]/);
  assert.match(graph, /\[i1_0\]volume=-5\.00dB,adelay=2500:all=1\[l2\]/);
  assert.match(graph, /volume='if\(between\(t,1,3\),0\.3162,1\)':eval=frame/);
  assert.match(graph, /amix=inputs=4:normalize=0:duration=longest,apad,atrim=end=25\[mix\]$/);
  assert.equal(args.at(-1), "/out.wav");
});

test("a phone copy's bitrate keeps it under 6 MB with its sound", () => {
  for (const seconds of [20, 52.7, 61, 90]) {
    const kbps = phoneBitrate(seconds);
    assert.ok(((kbps + 128) * 1000 * seconds) / 8 <= PHONE_LIMIT * 0.91, `${seconds} s at ${kbps} kbit/s`);
  }
  assert.equal(phoneBitrate(5), 2500, "a short clip is capped at a sharp 2.5 Mbit/s");
});
