import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beatLines, rulerTicks, selectionTime, timelineItems } from "../app/src/pages/short/layout.ts";
import { lineParts } from "../app/src/pages/short/ScriptPanel.tsx";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${n}`, import.meta.url), "utf8"));
const ep3 = () => resolveShort(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" }), { voice: fx("perdix-ep3.timing.json") as VoiceTiming });

test("the timeline's tracks hold every scene, text, chunk, line, effect and sound of the Short", () => {
  const s = ep3();
  const items = timelineItems(s);
  const count = (t: string) => items.filter((i) => i.track === t).length;
  assert.equal(count("scenes"), 6);
  assert.equal(count("text"), 1, "the end card");
  assert.equal(count("captions"), s.captions.length);
  assert.equal(count("voice"), 17);
  assert.equal(count("fx"), 4, "a punch per boom");
  assert.equal(count("sfx"), s.sfx.length);
  assert.equal(count("music"), 1);
  const walk = items.find((i) => i.key === "scene:walk")!;
  assert.deepEqual([walk.start, +(walk.end - walk.start).toFixed(3)], [23.369, 7.028]);
  assert.equal(selectionTime(s, walk.sel), 23.369);
  assert.equal(selectionTime(s, { kind: "sfx", i: 0 }), s.sfx[0]!.at);
});

test("ruler ticks keep their labels apart; beat lines follow the score's tempo", () => {
  assert.deepEqual(rulerTicks(10, 40), { step: 2, ticks: [0, 2, 4, 6, 8, 10] });
  assert.equal(rulerTicks(60, 300).step, 0.25);
  const beats = beatLines(ep3());
  assert.equal(beats[1], +(60 / 84).toFixed(3));
  assert.ok(beats.every((b) => b <= 52.653));
});

test("a script line shows as text and marker chips, an unknown bracket as text", () => {
  assert.deepEqual(lineParts("Perdix. [boom] Yes [kaboom] no."), [{ text: "Perdix." }, { marker: "boom" }, { text: "Yes" }, { text: "[kaboom]" }, { text: "no." }]);
});
