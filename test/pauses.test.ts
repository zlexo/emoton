import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPauses, estimateWords, noEdits, sentenceKeys, type Timing } from "../pipeline/pauses.ts";

const SR = 1000; // a sample a millisecond keeps the arithmetic readable

/** One second: a tone where each word is, silence between. */
function fixture(words: [number, number][]): { audio: Float32Array; timing: Timing } {
  const audio = new Float32Array(SR);
  for (const [a, b] of words) for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) audio[i] = Math.sin(i * 0.9) * 0.5;
  const texts = ["one", "two", "three", "four"];
  const timing: Timing = {
    duration: 1,
    beats: [{ start: words[0]![0], end: words.at(-1)![1], sentences: [{ start: words[0]![0], end: words.at(-1)![1], text: texts.slice(0, words.length).join(" "), words: words.map(([start, end], i) => ({ text: texts[i]!, start, end })) }] }],
  };
  return { audio, timing };
}

const peak = (a: Float32Array, from: number, to: number) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
};

test("a longer pause: silence inside the gap, later words moved, earlier ones not", () => {
  const { audio, timing } = fixture([[0.1, 0.3], [0.4, 0.6], [0.65, 0.85]]);
  const r = applyPauses(audio, SR, timing, { version: 1, sentences: { "one two three": { words: { "0": 200 } } } });
  assert.equal(r.applied, 1);
  assert.equal(r.audio.length, SR + 200);
  const w = r.timing.beats[0]!.sentences[0]!.words!;
  assert.equal(w[0]!.end, 0.3);
  assert.ok(Math.abs(w[1]!.start - 0.6) < 1e-9, String(w[1]!.start));
  assert.ok(Math.abs(w[2]!.end - 1.05) < 1e-9, String(w[2]!.end));
  // the pause is silent from the first word's end to the second's start
  assert.ok(peak(r.audio, 301, 599) < 1e-6, `peak ${peak(r.audio, 301, 599)}`);
  // and the second word's sound starts where its time says
  assert.ok(peak(r.audio, 610, 640) > 0.3);
});

test("a shorter pause takes silence only, never more than the gap holds beyond its guards", () => {
  const { audio, timing } = fixture([[0.1, 0.3], [0.4, 0.6], [0.65, 0.85]]);
  const r = applyPauses(audio, SR, timing, { version: 1, sentences: { "one two three": { words: { "0": -500 } } } });
  // the 100 ms gap keeps 10 ms each side: 80 ms go, not 500
  assert.equal(r.audio.length, SR - 80);
  const w = r.timing.beats[0]!.sentences[0]!.words!;
  assert.ok(Math.abs(w[1]!.start - 0.32) < 1e-9, String(w[1]!.start));
  // both words kept whole: as much sound as before
  assert.ok(peak(r.audio, 100, 300) > 0.3 && peak(r.audio, 320, 520) > 0.3);
  assert.ok(peak(r.audio, 301, 319) < 1e-6);
});

test("words that run together are pulled apart by exactly the pause", () => {
  const { audio, timing } = fixture([[0.1, 0.3], [0.3, 0.5]]);
  const r = applyPauses(audio, SR, timing, { version: 1, sentences: { "one two": { words: { "0": 100 } } } });
  const w = r.timing.beats[0]!.sentences[0]!.words!;
  assert.equal(w[0]!.end, 0.3);
  assert.ok(Math.abs(w[1]!.start - 0.4) < 1e-9, String(w[1]!.start));
  // the cut fades out and back in rather than clicking
  assert.ok(Math.abs(r.audio[299]!) < 0.01, String(r.audio[299]));
  assert.ok(Math.abs(r.audio[400]!) < 0.01, String(r.audio[400]));
});

test("a pause after a sentence moves the next sentence; edits for a sentence no longer there are reported", () => {
  const a = fixture([[0.1, 0.3]]), b = fixture([[0.5, 0.7]]);
  const audio = new Float32Array(SR);
  audio.set(a.audio.subarray(0, 400));
  audio.set(b.audio.subarray(400), 400);
  const timing: Timing = {
    duration: 1,
    beats: [{ start: 0.1, end: 0.7, sentences: [{ ...a.timing.beats[0]!.sentences[0]! }, { ...b.timing.beats[0]!.sentences[0]!, text: "two" }] }],
  };
  const r = applyPauses(audio, SR, timing, { version: 1, sentences: { one: { after: 300 }, gone: { after: 100 } } });
  const s = r.timing.beats[0]!.sentences;
  assert.equal(s[0]!.end, 0.3);
  assert.ok(Math.abs(s[1]!.start - 0.8) < 1e-9, String(s[1]!.start));
  assert.deepEqual(r.dropped, ["gone"]);
});

test("no edits change nothing", () => {
  const { audio, timing } = fixture([[0.1, 0.3], [0.4, 0.6]]);
  const r = applyPauses(audio, SR, timing, noEdits());
  assert.equal(r.applied, 0);
  assert.deepEqual(Array.from(r.audio), Array.from(audio));
  assert.deepEqual(r.timing.beats, timing.beats);
});

test("sentence keys: tidied text, repeats numbered in speaking order", () => {
  const t: Timing = { duration: 1, beats: [{ start: 0, end: 1, sentences: [{ start: 0, end: 0.4, text: "Follow.  " }, { start: 0.5, end: 1, text: "follow." }] }] };
  assert.deepEqual(sentenceKeys(t), [["follow.", "follow.#2"]]);
});

test("estimated words split a sentence by letters", () => {
  const w = estimateWords({ start: 1, end: 2, text: "ab abcd ab" });
  assert.deepEqual(w.map((x) => x.text), ["ab", "abcd", "ab"]);
  assert.ok(Math.abs(w[1]!.start - 1.25) < 1e-9 && Math.abs(w[1]!.end - 1.75) < 1e-9);
});

test("at 48 kHz, with times between samples as real ones are, a word ending at a cut stays before it", () => {
  // ep2's first sentence: "time," ends at 0.912632 s, 43,806.3 samples, and the cut falls at 43,806
  const sr = 48000;
  const audio = new Float32Array(sr * 2);
  for (let i = Math.round(0.572281 * sr); i < Math.round(0.980702 * sr); i++) audio[i] = Math.sin(i * 0.05) * 0.5;
  const timing: Timing = {
    duration: 2,
    beats: [{ start: 0.572281, end: 0.980702, sentences: [{ start: 0.572281, end: 0.980702, text: "time, I", words: [{ text: "time,", start: 0.572281, end: 0.912632 }, { text: "I", start: 0.912632, end: 0.980702 }] }] }],
  };
  const r = applyPauses(audio, sr, timing, { version: 1, sentences: { "time, i": { words: { "0": 100 } } } });
  const w = r.timing.beats[0]!.sentences[0]!.words!;
  assert.equal(w[0]!.end, 0.912632);
  assert.ok(Math.abs(w[1]!.start - w[0]!.end - 0.1) < 1e-6, `pause ${w[1]!.start - w[0]!.end}`);
});

test("a pause in a sentence timed by letters goes to the real gap near the guess, and none is taken away", () => {
  // the words are guessed to meet at 0.27 s, inside the first word's sound; the silence between them
  // is 0.30 to 0.40, within reach of the guess
  const { audio } = fixture([[0.1, 0.3], [0.4, 0.6]]);
  const timing: Timing = { duration: 1, beats: [{ start: 0.1, end: 0.6, sentences: [{ start: 0.1, end: 0.6, text: "one two", estimated: true, words: [{ text: "one", start: 0.1, end: 0.27 }, { text: "two", start: 0.27, end: 0.6 }] }] }] };
  const r = applyPauses(audio, SR, timing, { version: 1, sentences: { "one two": { words: { "0": 100 } } } });
  // the inserted silence starts in the real gap: the first word's sound is whole, before it
  assert.ok(peak(r.audio, 100, 300) > 0.3);
  assert.ok(peak(r.audio, 301, 499) < 1e-6, `peak ${peak(r.audio, 301, 499)}`);
  const shorter = applyPauses(audio, SR, timing, { version: 1, sentences: { "one two": { words: { "0": -50 } } } });
  assert.equal(shorter.applied, 0);
});

test("fields beyond the timing's beats are carried through", () => {
  const { audio, timing } = fixture([[0.1, 0.3], [0.4, 0.6]]);
  const r = applyPauses(audio, SR, { ...timing, leadIn: 0.1, audio: "audio/ch1.wav" }, { version: 1, sentences: { "one two": { words: { "0": 100 } } } });
  assert.equal(r.timing.leadIn, 0.1);
  assert.equal(r.timing.audio, "audio/ch1.wav");
  assert.ok(Math.abs(r.timing.duration - 1.1) < 1e-9);
});
