import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { Short } from "../schema/short.ts";
import { checkShort, resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";
import { applyPauseRules, renameEdits, rewriteLine, type PauseEdits } from "../src/core/short/voice.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${n}`, import.meta.url), "utf8"));
const ep3 = () => Short.parse(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" }));

test("rewriting a line a cue is pinned to: the cue follows to the new words, and the document still resolves", () => {
  const d = ep3();
  // TAG_AT is pinned to the start of the line "Perdix."
  const { doc, renames } = rewriteLine(d, "born", 4, "Perdix! [boom]");
  assert.deepEqual(renames, [{ from: "perdix.", to: "perdix!", words: 1 }]);
  const v = doc.scenes[1]!.visual!;
  assert.ok(v.type === "shot");
  assert.deepEqual(v.knobs.TAG_AT, { sentence: "perdix!", edge: "start" });
  assert.deepEqual(checkShort(doc, { voice: estimatedVoice(doc) }), []);
  assert.equal(doc.scenes[1]!.say![4], "Perdix! [boom]");
  assert.equal(d.scenes[1]!.say![4], "Perdix. [boom]", "the given document is untouched");
});

test("a word pin on a shortened line lands on its last word; caption overrides past it go", () => {
  const d = ep3();
  const key = "last time, this world got its textures. today, it gets someone to live in it.";
  const pinned = { ...d, sfx: [{ kind: "pop" as const, at: { word: { s: key, w: 12 } } }], captions: { ...d.captions, overrides: [{ word: { s: key, w: 2 }, op: "emphasize" as const }, { word: { s: key, w: 10 }, op: "hide" as const }] } };
  const { doc, renames } = rewriteLine(pinned, "world", 0, "Last time, this world got its textures.");
  assert.deepEqual(renames, [{ from: key, to: "last time, this world got its textures.", words: 7 }]);
  assert.deepEqual(doc.sfx[0]!.at, { word: { s: "last time, this world got its textures.", w: 6 } });
  assert.deepEqual(doc.captions.overrides, [{ word: { s: "last time, this world got its textures.", w: 2 }, op: "emphasize" }]);
});

test("a repeated line's numbering moves with a rewrite", () => {
  const d = ep3();
  const twice = { ...d, scenes: d.scenes.map((s, i) => (i === 2 ? { ...s, say: ["Walk.", "Walk.", "Sprint.", "Sprint-jump."] } : s)) } as Short;
  const { renames } = rewriteLine(twice, "walk", 0, "Stroll.");
  assert.deepEqual(renames, [{ from: "walk.", to: "stroll.", words: 1 }, { from: "walk.#2", to: "walk." }]);
});

test("pause edits follow renamed lines; word edits past a shortened line's end are dropped", () => {
  const e: PauseEdits = { version: 1, sentences: { "a b c d.": { words: { "0": 100, "2": 200 }, after: 300 }, "kept.": { after: 50 } } };
  assert.deepEqual(renameEdits(e, [{ from: "a b c d.", to: "a b.", words: 2 }]), { version: 1, sentences: { "kept.": { after: 50 }, "a b.": { words: { "0": 100 }, after: 300 } } });
  assert.equal(renameEdits(e, []), e);
});

test("pause rules: commas, colons, a boom line, before a short last line; existing edits are left alone", () => {
  const d = ep3();
  const r = resolveShort(d, { voice: fx("perdix-ep3.timing.json") as VoiceTiming });
  const first = "last time, this world got its textures. today, it gets someone to live in it.";
  const { edits, added } = applyPauseRules(d, r, { version: 1, sentences: { [first]: { words: { "1": 125 } } } });
  assert.equal(edits.sentences[first]!.words!["1"], 125, "a hand edit stays");
  assert.equal(edits.sentences[first]!.words!["7"], 175, "after \"today,\"");
  assert.equal(edits.sentences["he spawned magenta. like everything i make, at first."]!.after, 250, "a line ending on a boom");
  const colon = "he just stands there. his legs don't even move: minecraft only swings your legs when you actually get somewhere.";
  assert.equal(edits.sentences[colon]!.words!["8"], 225, "a colon with a long clause after it");
  assert.equal(edits.sentences["perdix."]!.after, 400, "before the short last line \"And a face.\"");
  assert.ok(added >= 5);
  assert.equal(applyPauseRules(d, r, edits).added, 0, "applied twice adds nothing");
});
