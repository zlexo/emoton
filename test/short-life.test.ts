import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStarts, shotKinds } from "../pipeline/shots.ts";

test("a search's lines: walking starts, and lives with what each does", () => {
  const out = [
    "WALK_X=60.5 WALK_Z=40.5 WALK_YAW=0.7854  walked 31.2, spire 0.00",
    "SEED=10  strolls 2.70 6.10 | looks at you 1.60 | looks around 8.80 | jumps 3.20 4.50 | ends 12.4 blocks away",
    "noise from the tool",
    "SEED=3  strolls | looks at you 7.40 | looks around 1.40 | jumps | ends 0.0 blocks away",
  ].join("\n");
  assert.deepEqual(parseStarts(out), [
    { x: 60.5, z: 40.5, yaw: 0.7854, note: "walked 31.2, spire 0.00" },
    { seed: 10, note: "strolls 2.70 6.10, looks at you 1.60, looks around 8.80, jumps 3.20 4.50, ends 12.4 blocks away" },
    { seed: 3, note: "strolls, looks at you 7.40, looks around 1.40, jumps, ends 0.0 blocks away" },
  ]);
});

test("perdix-life's knobs: a seed, where you stand, the camera, a stare pinned to a word; its life search", () => {
  const k = shotKinds();
  const life = k.kinds["perdix-life"]!;
  for (const name of ["SEED", "MODE", "YOU_AHEAD", "YOU_SIDE", "CAM", "STARE_FROM", "STARE_FOR", "WARMUP"]) assert.ok(name in life.knobs, name);
  assert.equal(life.knobs.STARE_FROM!.time, true, "a stare can be pinned to a word");
  assert.ok(Object.values(life.knobs).every((s) => Number.isFinite(s.default)), "every knob has a number for its default");
  assert.deepEqual(k.searches["life-search"]!.for, ["perdix-life"]);
});
