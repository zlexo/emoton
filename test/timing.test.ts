import { test } from "node:test";
import assert from "node:assert/strict";
import { revealTimes, stepAt } from "../src/core/timing.ts";

const beat = {
  start: 10,
  end: 19,
  sentences: [
    { start: 10, end: 12, text: "a" },
    { start: 12.5, end: 15, text: "b" },
    { start: 15.5, end: 19, text: "c" },
  ],
};

test("item k fires at sentence k", () => {
  assert.deepEqual(revealTimes(3, beat), [10, 12.5, 15.5]);
});

test("fewer items than sentences", () => {
  assert.deepEqual(revealTimes(1, beat), [10]);
});

test("extra items share the last sentence evenly, in order", () => {
  const t = revealTimes(5, beat);
  assert.deepEqual(t.slice(0, 2), [10, 12.5]);
  assert.equal(t[2], 15.5);
  assert.ok(t[3]! > t[2]! && t[4]! > t[3]! && t[4]! < 19);
});

test("stepAt finds the latest fired step", () => {
  const t = [10, 12.5, 15.5];
  assert.equal(stepAt(t, 9), -1);
  assert.equal(stepAt(t, 10), 0);
  assert.equal(stepAt(t, 13), 1);
  assert.equal(stepAt(t, 99), 2);
});

import { ticks } from "../src/remotion/visuals/Graph.tsx";
test("graph ticks are round numbers", () => {
  assert.deepEqual(ticks(0, 12000), [0, 2000, 4000, 6000, 8000, 10000, 12000]);
  assert.deepEqual(ticks(-4, 67), [0, 20, 40, 60]);
  assert.deepEqual(ticks(0, 1), [0, 0.2, 0.4, 0.6, 0.8, 1]);
});

test("captions: the spoken word is the last one started, kept through the pause after it", async () => {
  const { spokenWord, wordsOf } = await import("../src/core/words.ts");
  const words = [{ text: "One", start: 1, end: 1.3 }, { text: "thread,", start: 1.3, end: 1.7 }, { text: "many", start: 2, end: 2.3 }];
  assert.deepEqual([0.5, 1, 1.29, 1.3, 1.8, 2, 9].map((t) => spokenWord(words, t)), [-1, 0, 0, 1, 1, 2, 2]);
  // a sentence the voice did not time gets its words by letters
  assert.deepEqual(wordsOf({ start: 0, end: 1, text: "ab cd" }).map((w) => [w.text, w.start]), [["ab", 0], ["cd", 0.5]]);
  assert.equal(wordsOf({ start: 0, end: 1, text: "x y", words }).length, 3);
});
