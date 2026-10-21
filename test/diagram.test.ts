import { test } from "node:test";
import assert from "node:assert/strict";
import { placeNodes, resolveDiagrams } from "../src/core/diagram.ts";
import type { Chapter } from "../schema/storyboard.ts";

test("unplaced nodes spread across the middle row, no two share a cell", () => {
  const p = placeNodes([{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]);
  assert.deepEqual(p.map((n) => [n.col, n.row]), [[0, 1], [2, 1], [4, 1]]);
});

test("given cells are kept and free nodes avoid them", () => {
  const p = placeNodes([{ id: "a", label: "A", col: 1, row: 1 }, { id: "b", label: "B" }]);
  const cells = new Set(p.map((n) => `${n.col},${n.row}`));
  assert.equal(cells.size, 2);
  assert.equal(p.find((n) => n.id === "a")!.col, 1);
});

const say = ["one.", "two."];
const ch: Chapter = {
  title: "t",
  beats: [
    {
      say,
      visual: {
        type: "diagram",
        nodes: [{ id: "c1", label: "client" }, { id: "s", label: "server" }],
        edges: [{ id: "e1", from: "c1", to: "s", label: "connect" }],
        steps: [{ show: ["c1", "s"] }, { show: ["e1"], highlight: ["s"] }],
      },
    },
    {
      say,
      visual: {
        type: "diagram",
        continue: true,
        nodes: [{ id: "q", label: "queue" }],
        edges: [],
        steps: [{ relabel: [{ id: "s", label: "one worker" }] }, { highlight: ["q"] }],
      },
    },
    { say, visual: { type: "title", title: "break" } },
  ],
};

test("a continued diagram starts from the previous final state", () => {
  const [a, b, c] = resolveDiagrams(ch);
  assert.deepEqual([...a!.steps[1]!.visible].sort(), ["c1", "e1", "s"]);
  assert.deepEqual([...b!.initial].sort(), ["c1", "e1", "s"]);
  // positions of carried nodes never move
  assert.deepEqual(
    b!.nodes.filter((n) => n.id !== "q").map((n) => [n.col, n.row]),
    a!.nodes.map((n) => [n.col, n.row]),
  );
  // the new node is never mentioned in a show, so it appears with step 1
  assert.deepEqual(b!.steps[0]!.shown, ["q"]);
  assert.equal(b!.steps[0]!.labels.s, "one worker");
  assert.equal(b!.steps[1]!.labels.s, "one worker", "relabel persists");
  assert.equal(c, null);
});

test("highlight lasts one step", () => {
  const [a] = resolveDiagrams(ch);
  assert.deepEqual([...a!.steps[0]!.highlight], []);
  assert.deepEqual([...a!.steps[1]!.highlight], ["s"]);
});
