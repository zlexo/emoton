import { test } from "node:test";
import assert from "node:assert/strict";
import { Short as ShortSchema, type Short, type Scene } from "../schema/short.ts";
import { checkShort, parseLine, resolveShort, ShortError, SOUND_GAIN_DB, type VoiceTiming } from "../src/core/short/resolve.ts";
import { keySentences } from "../src/core/words.ts";

/** A voice for these spoken scenes: every word 0.3 s, 0.2 s between lines, 0.5 s between scenes, 0.3 s lead-in, 1 s tail. */
function voiced(scenes: string[][]): VoiceTiming {
  let t = 0.3;
  const beats = scenes.map((lines, b) => {
    if (b > 0) t += 0.5 - 0.2;
    const start = t;
    const sentences = lines.map((raw) => {
      const text = parseLine(raw).text;
      const s0 = t;
      const words = text.split(/\s+/).map((w) => {
        const word = { text: w, start: t, end: t + 0.3 };
        t += 0.3;
        return word;
      });
      const s = { start: s0, end: t, text, words };
      t += 0.2;
      return s;
    });
    return { start, end: t - 0.2, sentences };
  });
  return { duration: t - 0.2 + 1, beats };
}

const shot = (kind = "walk", knobs: Record<string, unknown> = {}): Scene["visual"] => ({ type: "shot", source: "perdix", kind, knobs: knobs as never, build: "c0bece9" });
const clip = (asset: string, from?: number): Scene["visual"] => ({ type: "clip", asset, ...(from !== undefined ? { from } : {}) });

function doc(scenes: Scene[], extra: Partial<Short> = {}): Short {
  return ShortSchema.parse({
    version: 1, title: "t", template: "devlog", canvas: { w: 1080, h: 1920, fps: 60 },
    scenes, text: [], captions: { style: { maxWords: 3, highlight: false }, overrides: [] }, fx: [], sfx: [], music: null, ...extra,
  });
}
const spokenLines = (d: Short) => d.scenes.filter((s) => s.say).map((s) => s.say!);

test("parseLine takes markers out and keeps unknown brackets apart", () => {
  assert.deepEqual(parseLine("Perdix. [boom]"), { text: "Perdix.", marks: ["boom"], unknown: [] });
  assert.deepEqual(parseLine("[scratch] Let's look [ding] closer."), { text: "Let's look closer.", marks: ["scratch", "ding"], unknown: [] });
  assert.deepEqual(parseLine("Hi [code:yoink]").unknown, ["code:yoink"]);
});

test("spoken scenes cut a quarter second before their first line and run to the next cut", () => {
  const d = doc([
    { id: "a", say: ["One two three."], visual: shot() },
    { id: "b", say: ["Four five."], visual: shot() },
  ]);
  const v = voiced(spokenLines(d));
  const r = resolveShort(d, { voice: v });
  const b0 = v.beats[1]!.start;
  assert.equal(r.scenes[0]!.from, 0);
  assert.equal(r.scenes[0]!.seconds, +(b0 - 0.25).toFixed(3));
  assert.equal(r.scenes[1]!.from, r.scenes[0]!.seconds);
  assert.equal(r.duration, +v.duration.toFixed(3));
  assert.deepEqual(r.voice, [{ at: 0, from: 0, to: +v.duration.toFixed(3) }]);
});

test("a held scene opens a hole in the voice: lead before it, after it, and everything later moves", () => {
  const d = doc([
    { id: "a", say: ["Look at this."], visual: shot() },
    { id: "code", hold: 5, visual: { type: "code", files: [{ path: "A.java" }] } },
    { id: "b", say: ["And it works."], visual: shot() },
  ]);
  const v = voiced(spokenLines(d));
  const r = resolveShort(d, { voice: v });
  const aEnd = v.beats[0]!.end;
  const code = r.scenes[1]!;
  assert.equal(code.from, +(aEnd + 0.3).toFixed(3), "starts lead (0.3 s) after the line before");
  assert.equal(code.seconds, 5);
  const bLine = r.sentences.find((s) => s.scene === "b")!;
  assert.equal(bLine.start, +(aEnd + 0.3 + 5 + 0.9).toFixed(3), "the next line starts after (0.9 s) past the held scene");
  assert.equal(r.scenes[2]!.from, +(aEnd + 0.3 + 5).toFixed(3), "the scene after a held one cuts in when it ends");
  const open = aEnd + 0.3 + 5 + 0.9 - v.beats[1]!.start;
  assert.deepEqual(r.voice, [
    { at: 0, from: 0, to: +(aEnd + 0.05).toFixed(3) },
    { at: +(aEnd + 0.05 + open).toFixed(3), from: +(aEnd + 0.05).toFixed(3), to: +v.duration.toFixed(3) },
  ]);
  assert.equal(r.duration, +(v.duration + open).toFixed(3));
});

test("a montage: held scenes back to back from 0, with no voice", () => {
  const d = doc([
    { id: "a", hold: 2, visual: clip("assets/a.mp4", 0.25), in: "cut" },
    { id: "b", hold: 1.5, visual: clip("assets/b.mp4") },
    { id: "c", hold: 1.2, continue: true },
  ], { template: "montage" });
  const r = resolveShort(d);
  assert.deepEqual(r.scenes.map((s) => [s.from, s.seconds]), [[0, 2], [2, 1.5], [3.5, 1.2]]);
  assert.deepEqual(r.scenes[0]!.footage, { scene: "a", from: 0.25 });
  assert.deepEqual(r.scenes[2]!.footage, { scene: "b", from: 1.5 }, "a continue plays on in the clip before it");
  assert.equal(r.duration, 4.7);
  assert.deepEqual(r.voice, []);
});

test("held scenes before the first line push the voice back to start after them", () => {
  const d = doc([
    { id: "a", hold: 3, visual: clip("assets/a.mp4") },
    { id: "b", say: ["Follow."], visual: shot() },
  ]);
  const v = voiced(spokenLines(d));
  const r = resolveShort(d, { voice: v });
  assert.equal(r.sentences[0]!.start, +(3 + 0.9).toFixed(3));
  assert.equal(r.voice[0]!.at, +(3 + 0.9 - v.beats[0]!.start).toFixed(3));
  assert.equal(r.voice[0]!.from, 0);
});

test("markers: a scratch before its line, the rest after it; a boom punches in", () => {
  const d = doc([{ id: "a", say: ["[scratch] Hey there.", "Perdix. [boom] [ding]"], visual: shot() }]);
  const v = voiced(spokenLines(d));
  const r = resolveShort(d, { voice: v });
  const [s1, s2] = v.beats[0]!.sentences;
  const [k1, k2] = keySentences(["Hey there.", "Perdix."]);
  assert.deepEqual(r.sfx, [
    { kind: "scratch", at: +(s1!.start - 0.05).toFixed(3), gainDb: SOUND_GAIN_DB.scratch, source: { marker: { sentence: k1, n: 0 } }, take: 0 },
    { kind: "boom", at: +(s2!.end + 0.02).toFixed(3), gainDb: SOUND_GAIN_DB.boom, source: { marker: { sentence: k2, n: 0 } }, take: 0 },
    { kind: "ding", at: +(s2!.end + 0.02).toFixed(3), gainDb: SOUND_GAIN_DB.ding, source: { marker: { sentence: k2, n: 1 } }, take: 0 },
  ]);
  assert.deepEqual(r.fx, [{ kind: "punch", at: +(s2!.end + 0.02).toFixed(3), source: { boom: 1 } }], "the punch names the boom it came with");
  assert.ok(Math.abs(SOUND_GAIN_DB.boom - 20 * Math.log10(0.56)) < 1e-9);
});

test("pinned sounds, effects and text follow their words when a pause moves", () => {
  const scenes: Scene[] = [{ id: "a", say: ["Walk. Sprint. Jump."], visual: shot() }];
  const key = keySentences(["Walk. Sprint. Jump."])[0]!;
  const d = doc(scenes, {
    sfx: [{ kind: "boom", at: { word: { s: key, w: 2 } }, punch: false }, { kind: "pop", at: { word: { s: key, w: 1 }, edge: "end", offset: 0.1 } }],
    fx: [{ kind: "shake", at: { sentence: key, edge: "end" }, dur: 0.2 }],
    text: [{ role: "label", text: "JUMP", from: { word: { s: key, w: 2 } }, to: { scene: "a", edge: "end" } }],
  });
  const v = voiced(spokenLines(d));
  const r1 = resolveShort(d, { voice: v });
  const w = v.beats[0]!.sentences[0]!.words!;
  assert.equal(r1.sfx[0]!.at, +w[2]!.start.toFixed(3));
  assert.equal(r1.sfx[1]!.at, +(w[1]!.end + 0.1).toFixed(3));
  assert.deepEqual(r1.fx, [{ kind: "shake", at: +v.beats[0]!.sentences[0]!.end.toFixed(3), dur: 0.2, source: { fx: 0 } }], "punch: false keeps the boom still");
  assert.deepEqual(r1.sfx.map((x) => x.source), [{ sfx: 0 }, { sfx: 1 }]);
  assert.equal(r1.text[0]!.from, +w[2]!.start.toFixed(3));
  // a longer pause after "Sprint." moves the jump and everything pinned to it, nothing before it
  const longer = structuredClone(v);
  const ws = longer.beats[0]!.sentences[0]!.words!;
  ws[2]!.start += 0.5; ws[2]!.end += 0.5;
  longer.beats[0]!.sentences[0]!.end += 0.5; longer.beats[0]!.end += 0.5; longer.duration += 0.5;
  const r2 = resolveShort(d, { voice: longer });
  assert.equal(r2.sfx[0]!.at, +(r1.sfx[0]!.at + 0.5).toFixed(3));
  assert.equal(r2.sfx[1]!.at, r1.sfx[1]!.at);
  assert.equal(r2.text[0]!.from, +(r1.text[0]!.from + 0.5).toFixed(3));
});

test("captions: up to maxWords, broken after punctuation, shown until the next chunk", () => {
  const d = doc([{ id: "a", say: ["No face, no name, no idea where he is today."], visual: shot() }]);
  const v = voiced(spokenLines(d));
  const r = resolveShort(d, { voice: v });
  assert.deepEqual(r.captions.map((c) => c.text), ["No face", "no name", "no idea where", "he is today"]);
  const w = v.beats[0]!.sentences[0]!.words!;
  assert.equal(r.captions[0]!.to, +w[2]!.start.toFixed(3));
  assert.equal(r.captions[3]!.to, +v.beats[0]!.sentences[0]!.end.toFixed(3), "the last chunk lasts to the line's end");
});

test("caption overrides: break, join, hide, emphasize", () => {
  const line = "One two three four five six.";
  const key = keySentences([line])[0]!;
  const d = doc([{ id: "a", say: [line], visual: shot() }], {
    captions: {
      style: { maxWords: 3, highlight: true },
      overrides: [
        { word: { s: key, w: 1 }, op: "break" },
        { word: { s: key, w: 4 }, op: "join" },
        { word: { s: key, w: 4 }, op: "emphasize" },
        { word: { s: key, w: 0 }, op: "hide" },
      ],
    },
  });
  const r = resolveShort(d, { voice: voiced(spokenLines(d)) });
  assert.deepEqual(r.captions.map((c) => c.text), ["two three four five", "six"]);
  assert.deepEqual(r.captions[0]!.words.filter((w) => w.emphasis).map((w) => w.text), ["five"]);
});

test("shot knobs pinned to words are seconds from the shot's start; a continue lengthens the shot", () => {
  const key = keySentences(["Walk.", "Sprint.", "And on."])
  const d = doc([
    { id: "intro", say: ["Hello there."], visual: shot("stream") },
    { id: "walk", say: ["Walk.", "Sprint."], visual: shot("perdix-walk", { WALK_FROM: { sentence: key[0], edge: "start" }, JUMP_FROM: { word: { s: key[1], w: 0 }, edge: "end" }, VIEW: 8, LINES: true }) },
    { id: "more", say: ["And on."], continue: true },
  ]);
  const v = voiced(spokenLines(d));
  const r = resolveShort(d, { voice: v });
  const walk = r.shots.find((s) => s.scene === "walk")!;
  const cut = v.beats[1]!.start - 0.25;
  assert.equal(walk.knobs.WALK_FROM, +(v.beats[1]!.sentences[0]!.start - cut).toFixed(3));
  assert.equal(walk.knobs.JUMP_FROM, +(v.beats[1]!.sentences[1]!.words![0]!.end - cut).toFixed(3));
  assert.equal(walk.knobs.VIEW, 8);
  assert.equal(walk.knobs.LINES, true);
  assert.equal(walk.seconds, +(v.duration - cut).toFixed(3), "the run covers the continue to the end");
  assert.equal(r.shots.length, 2);
  assert.deepEqual(r.scenes[2]!.footage, { scene: "walk", from: +(v.beats[2]!.start - 0.25 - cut).toFixed(3) });
});

test("orbiting shots chain their angle from the one before", () => {
  const d = doc([
    { id: "a", hold: 2, visual: { type: "shot", source: "perdix", kind: "cube", knobs: {}, build: "c0bece9", orbit: 0.15 } },
    { id: "b", hold: 3, visual: { type: "shot", source: "perdix", kind: "chunk", knobs: {}, build: "c0bece9", orbit: 0.1 } },
  ]);
  const r = resolveShort(d);
  assert.deepEqual([r.shots[0]!.knobs.START, r.shots[0]!.knobs.SPIN], [0.55, 0.15]);
  assert.deepEqual([r.shots[1]!.knobs.START, r.shots[1]!.knobs.SPIN], [+(0.55 + 0.3).toFixed(4), 0.1]);
});

test("beat anchors: the score's tempo from 0, a song's grid moved to where its drop lands", () => {
  const scenes: Scene[] = [{ id: "a", hold: 4, visual: clip("assets/a.mp4") }, { id: "b", hold: 4, visual: clip("assets/b.mp4"), in: "drop" }];
  const synth = doc(scenes, { template: "montage", music: { source: { synth: { style: "trap", bpm: 120 } }, gainDb: -6, duck: { depthDb: -9 } }, fx: [{ kind: "flash", at: { beat: 6 } }] });
  const r1 = resolveShort(synth);
  assert.equal(r1.fx[0]!.at, 3);
  assert.deepEqual(r1.music!.source, { synth: { style: "trap", bpm: 120, lifts: [8, 8, 8], drop: 4, cuts: [0, 4], hookEnd: 0 } });
  const song = doc(scenes, {
    template: "edit",
    music: { source: { file: { asset: "assets/song.mp3", dropAt: 30, align: { scene: "b", edge: "start" }, bpm: 100, firstBeat: 0.2 } }, gainDb: -3, duck: { depthDb: -12 } },
    fx: [{ kind: "flash", at: { beat: 50 } }],
  });
  const r2 = resolveShort(song);
  assert.deepEqual(r2.music!.source, { file: { asset: "assets/song.mp3", offset: 26 } }, "the song starts 26 s in, so its 30 s drop lands at 4 s");
  assert.equal(r2.fx[0]!.at, +(0.2 + 30 - 26).toFixed(3), "beat 50 at 100 bpm is song second 30.2, timeline 4.2");
});

test("the length against the target is a warning, not a refusal", () => {
  const d = doc([{ id: "a", hold: 20, visual: clip("assets/a.mp4") }], { target: { minSeconds: 60 } });
  assert.deepEqual(resolveShort(d).warnings, ["20.0 s is under the target of 60 s"]);
});

test("refusals come as one list", () => {
  const d = doc([
    { id: "a", say: ["Hello [kaboom] there."], visual: shot() },
    { id: "a", hold: 2 } as Scene,
    { id: "c", say: ["Hi."], hold: 2, visual: shot() },
  ]);
  const p = checkShort(d, { voice: voiced(spokenLines(d)) }).map((x) => `${x.at}: ${x.message}`);
  assert.ok(p.some((m) => m.startsWith("scene a: the id is used twice")), p.join("\n"));
  assert.ok(p.some((m) => m.includes("[kaboom] is not a marker")), p.join("\n"));
  assert.ok(p.some((m) => m.startsWith("scene a: needs a visual")), p.join("\n"));
  assert.ok(p.some((m) => m.startsWith("scene c: a scene either speaks")), p.join("\n"));
  assert.throws(() => resolveShort(d, { voice: voiced(spokenLines(d)) }), ShortError);
});

test("a stale voice is refused: the line changed since it was voiced", () => {
  const d = doc([{ id: "a", say: ["A better joke."], visual: shot() }]);
  const old = voiced([["The old joke."]]);
  assert.deepEqual(checkShort(d, { voice: old }), [{ at: "scene a line 1", message: 'the voice says "The old joke." (voice it again)' }]);
  assert.deepEqual(checkShort(d), [{ at: "voice", message: "the Short has narration but no voice timing (voice it first)" }]);
});

test("anchors that name nothing are refused", () => {
  const key = keySentences(["Two words."])[0]!;
  const d = doc([{ id: "a", say: ["Two words."], visual: shot() }], {
    sfx: [{ kind: "ding", at: { word: { s: key, w: 2 } } }, { kind: "ding", at: { sentence: "gone.", edge: "end" } }],
    fx: [{ kind: "flash", at: { beat: 1 } }, { kind: "flash", at: { scene: "zz", edge: "start" } }],
    captions: { style: { maxWords: 3, highlight: false }, overrides: [{ word: { s: key, w: 9 }, op: "hide" }] },
    text: [{ role: "big", text: "X", from: { scene: "a", edge: "end" }, to: { scene: "a", edge: "start" } }],
  });
  const p = checkShort(d, { voice: voiced(spokenLines(d)) }).map((x) => `${x.at}: ${x.message}`);
  const end = (0.3 + 0.6).toFixed(3);
  assert.deepEqual(p.sort(), [
    "caption override 1: \"two words.\" has no word 9",
    "effect 1: a beat anchor needs a beat grid (the score's bpm, or the song's bpm)",
    "effect 2: no scene zz",
    "sound 1: \"two words.\" has 2 words, no word 2",
    "sound 2: no line \"gone.\" in the script",
    `text 1: "X" ends before it starts (${(+end + 1).toFixed(3)} to 0.000 s)`,
  ]);
});

test("the schema refuses what the resolver cannot draw", () => {
  const base = { version: 1, title: "t", template: "devlog", canvas: { w: 1080, h: 1920, fps: 60 }, text: [], captions: { style: { maxWords: 3, highlight: false }, overrides: [] }, fx: [], sfx: [], music: null };
  const bad = (scenes: unknown) => !ShortSchema.safeParse({ ...base, scenes }).success;
  assert.ok(bad([{ id: "a", hold: 2, visual: { type: "clip", asset: "../outside.mp4" } }]), "an asset outside the bundle");
  assert.ok(bad([{ id: "a", hold: 2, visual: { type: "shot", source: "perdix", kind: "walk", knobs: { lower: 1 }, build: "c0bece9" } }]), "a knob not named like an env variable");
  assert.ok(bad([{ id: "a b", hold: 2, visual: { type: "card", title: "x" } }]), "an id with a space");
  assert.ok(bad([{ id: "a", hold: 2, visual: { type: "card", title: "x" }, extra: 1 }]), "an unknown field");
  assert.ok(!bad([{ id: "a", hold: 2, visual: { type: "card", title: "x" } }]));
});

test("each caption names its first word; the music's beat grid; subtitles under the platforms' buttons warn", () => {
  const line = "One two three four.";
  const d = doc([{ id: "a", say: [line], visual: shot() }], { music: { source: { synth: { style: "pad", bpm: 90 } }, gainDb: -18, duck: { depthDb: -9 } } });
  const r = resolveShort(d, { voice: voiced(spokenLines(d)) });
  assert.deepEqual(r.captions.map((c) => c.first), [0, 3]);
  assert.deepEqual(r.music!.grid, { first: 0, bpm: 90 });
  assert.deepEqual(r.warnings, [], "the default caption place (1300 px) clears every zone");
  const low = doc([{ id: "a", say: [line], visual: shot() }], { captions: { style: { maxWords: 3, highlight: false, top: 1450 }, overrides: [] } });
  assert.deepEqual(resolveShort(low, { voice: voiced(spokenLines(low)) }).warnings, ["captions sit under TikTok caption band, Shorts title band: move them (style top)"]);
  const song = doc([{ id: "a", hold: 4, visual: clip("assets/a.mp4") }], { music: { source: { file: { asset: "assets/s.mp3", dropAt: 10, align: { t: 2 }, bpm: 120, firstBeat: 0.5 } }, gainDb: -3, duck: { depthDb: -12 } } });
  assert.deepEqual(resolveShort(song).music!.grid, { first: -7.5, bpm: 120 }, "the song starts 8 s in, so its first beat (0.5 s) is 7.5 s before the timeline starts");
});

test("built-in sounds take turns through their takes; a kit file replaces a kind's built-in sound", () => {
  const d = doc([{ id: "a", say: ["One. [boom]", "Two. [boom]", "Three. [boom]", "Four. [boom] [ding]"], visual: shot() }], { soundKit: { ding: "assets/sounds/bell.wav" } });
  const r = resolveShort(d, { voice: voiced(spokenLines(d)) });
  assert.deepEqual(r.sfx.map((x) => [x.kind, x.take, x.asset]), [["boom", 0, undefined], ["boom", 1, undefined], ["boom", 2, undefined], ["boom", 0, undefined], ["ding", undefined, "assets/sounds/bell.wav"]]);
});

