import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { Short } from "../schema/short.ts";
import {
  addSound, lineAt, lineOfKey, moveFx, moveScene, moveSound, removeFx, removeScene, removeSound, setScene, setSound, snap, splitScene, toggleCaption, wordAt, withoutMarker,
} from "../src/core/short/edit.ts";
import { checkShort, resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${n}`, import.meta.url), "utf8"));
const voice = fx("perdix-ep3.timing.json") as VoiceTiming;
const ep3 = () => Short.parse(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" }));
const R = (d: Short) => resolveShort(d, { voice });

test("withoutMarker takes the n-th marker out, leaving other brackets and markers", () => {
  assert.equal(withoutMarker("Perdix. [boom] [ding]", 0), "Perdix. [ding]");
  assert.equal(withoutMarker("Perdix. [boom] [ding]", 1), "Perdix. [boom]");
  assert.equal(withoutMarker("[scratch] Hey [boom] you.", 1), "[scratch] Hey you.");
});

test("dragging a marker's sound pins it to a word: the line loses the marker, the punch follows, nothing else moves", () => {
  const d = ep3(), r = R(d);
  const i = r.sfx.findIndex((s) => s.kind === "boom");
  const before = r.sfx.map((s) => s.at);
  const key = r.sentences[3]!.key;
  const moved = moveSound(d, r, i, { word: { s: key, w: 1 } });
  assert.deepEqual(checkShort(moved, { voice }), []);
  assert.equal(moved.scenes[1]!.say![0], "He spawned magenta. Like everything I make, at first.");
  const r2 = R(moved);
  const pinned = r2.sfx.find((s) => "sfx" in s.source)!;
  assert.equal(pinned.at, r2.sentences[3]!.words[1]!.start);
  assert.ok(r2.fx.some((f) => f.at === pinned.at && f.kind === "punch"), "its punch-in moved with it");
  assert.deepEqual(r2.sfx.filter((s) => !("sfx" in s.source)).map((s) => s.at).sort(), before.filter((_, k) => k !== i).sort(), "the other sounds stay");
  // and moving the pinned one again only changes its anchor
  const again = moveSound(moved, r2, r2.sfx.indexOf(pinned), { t: 1 });
  assert.deepEqual(again.sfx.at(-1)!.at, { t: 1 });
});

test("a marker's gain pins it at its own place first, so it sounds the same, louder", () => {
  const d = ep3(), r = R(d);
  const i = r.sfx.findIndex((s) => s.kind === "scratch");
  const e = setSound(d, r, i, { gainDb: -2 });
  const r2 = R(e);
  const s = r2.sfx.find((x) => "sfx" in x.source)!;
  assert.equal(s.at, r.sfx[i]!.at, "same moment");
  assert.equal(s.gainDb, -2);
});

test("removing sounds and effects: a marker leaves its line, a boom's punch is switched off on the boom", () => {
  const d = ep3(), r = R(d);
  const ding = r.sfx.findIndex((s) => s.kind === "ding");
  const noDing = removeSound(d, r, ding);
  assert.equal(R(noDing).sfx.length, r.sfx.length - 1);
  assert.equal(noDing.scenes[0]!.say![1], "So I added a player.");
  const punch = r.fx.findIndex((f) => f.kind === "punch");
  const still = removeFx(d, r, punch);
  const r2 = R(still);
  assert.equal(r2.fx.length, r.fx.length - 1);
  assert.equal(r2.sfx.length, r.sfx.length, "the boom still sounds");
  assert.ok(still.sfx.some((s) => s.kind === "boom" && s.punch === false));
  // moving a boom's punch moves the boom
  const moved = moveFx(d, r, punch, { t: 2 });
  assert.ok(moved.sfx.some((s) => s.kind === "boom" && "t" in s.at && s.at.t === 2));
  assert.equal(R(addSound(d, { kind: "pop", at: { t: 3 } })).sfx.at(-1)!.at, 3);
});

test("snap: to the nearest word edge, beat or scene edge within the tolerance, else a fixed time", () => {
  const d = ep3(), r = R(d);
  const w = r.sentences[2]!.words[0]!;
  assert.deepEqual(snap(r, w.start + 0.02, { words: true, beats: false, scenes: false }, 0.05).at, { word: { s: r.sentences[2]!.key, w: 0 } });
  const beat = 60 / 84;
  assert.deepEqual(snap(r, 10 * beat + 0.01, { words: false, beats: true, scenes: false }, 0.05).at, { beat: 10 });
  const walk = r.scenes.find((s) => s.id === "walk")!;
  assert.deepEqual(snap(r, walk.from - 0.01, { words: false, beats: false, scenes: true }, 0.05).at, { scene: "walk", edge: "start" });
  assert.deepEqual(snap(r, 0.111, { words: false, beats: false, scenes: false }, 0.05), { at: { t: 0.111 }, t: 0.111 });
  assert.deepEqual(wordAt(r, w.start + 0.01), { word: { s: r.sentences[2]!.key, w: 0 } });
});

test("splitting a scene: the rest of its lines carry on its footage; its end's anchors follow the second half", () => {
  const d = ep3(), r = R(d);
  const at = lineAt(r, r.sentences.find((s) => s.scene === "horizon" && s.line === 1)!.start + 0.1)!;
  assert.deepEqual(at, { scene: "horizon", line: 1 });
  const split = splitScene(d, "horizon", 1);
  // voiced again, the scene's lines are two voice parts
  const [s0, ...rest] = voice.beats[5]!.sentences;
  const parts = [{ start: s0!.start, end: s0!.end, sentences: [s0!] }, { start: rest[0]!.start, end: rest.at(-1)!.end, sentences: rest }];
  assert.deepEqual(checkShort(split, { voice: { ...voice, beats: [...voice.beats.slice(0, 5), ...parts] } }), []);
  const second = split.scenes[6]!;
  assert.equal(second.id, "horizon-b");
  assert.equal(second.continue, true);
  assert.deepEqual(split.text[0]!.to, { scene: "horizon-b", edge: "end" }, "the end card stays on the last scene's end");
});

test("scene settings, order and removal", () => {
  const d = ep3();
  assert.equal(setScene(d, "walk", { in: "flash", push: 1.05 }).scenes[2]!.in, "flash");
  assert.deepEqual(moveScene(d, "pov", -1).scenes.map((s) => s.id).slice(2, 4), ["pov", "walk"]);
  const r = R(d);
  const noStuck = removeScene(d, "stuck");
  assert.equal(noStuck.scenes.length, 5);
  assert.equal(noStuck.sfx.length, 0);
  assert.equal(lineOfKey(noStuck, r.sentences.find((s) => s.scene === "stuck")!.key), null);
  assert.equal(removeScene(Short.parse({ ...d, scenes: [d.scenes[0]] }), "world").scenes.length, 1, "the last scene stays");
});

test("caption overrides toggle on and off", () => {
  const d = ep3(), r = R(d);
  const key = r.sentences[0]!.key;
  const on = toggleCaption(d, key, 3, "break");
  assert.deepEqual(on.captions.overrides, [{ word: { s: key, w: 3 }, op: "break" }]);
  assert.deepEqual(toggleCaption(on, key, 3, "break").captions.overrides, []);
  assert.notDeepEqual(R(on).captions.map((c) => c.text), r.captions.map((c) => c.text));
});

test("edits never change the document they were given", () => {
  const d = ep3(), r = R(d);
  const snapshot = JSON.stringify(d);
  moveSound(d, r, 0, { t: 1 });
  setSound(d, r, 1, { gainDb: 0 });
  removeSound(d, r, 2);
  splitScene(d, "born", 2);
  removeScene(d, "walk");
  toggleCaption(d, r.sentences[0]!.key, 0, "hide");
  assert.equal(JSON.stringify(d), snapshot);
});
