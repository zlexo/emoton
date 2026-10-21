import { test } from "node:test";
import assert from "node:assert/strict";
import type { Chapter, DiagramVisual } from "../schema/storyboard.ts";
import { KATEX_MAIN, fontWidths } from "../scripts/font-widths.ts";
import { resolveDiagrams, type DiagramScene } from "../src/core/diagram.ts";
import { AREA, EDGE_FONT, NODE_FONT, crosses, drawEdge, layoutDiagram, nodeRect, nodeSize, type DiagramLayout, type DrawnEdge, type Rect } from "../src/core/diagramLayout.ts";
import { KATEX_MAIN_EM } from "../src/core/fontWidths.ts";
import { textWidth } from "../src/core/textWidth.ts";
import { stageBox } from "../src/remotion/Slides.tsx";
import { fixture } from "./fixtures/helpers.ts";

/** The segments of a chapter as the renderer groups them: a diagram and the beats that continue it. */
function segments(ch: Chapter): DiagramScene[][] {
  const scenes = resolveDiagrams(ch), out: DiagramScene[][] = [];
  ch.beats.forEach((b, i) => {
    if (b.visual?.type === "diagram" && b.visual.continue && out.length) out[out.length - 1]!.push(scenes[i]!);
    else if (scenes[i]) out.push([scenes[i]!]);
  });
  return out;
}
const one = (v: Omit<DiagramVisual, "type">) => segments({ title: "t", beats: [{ say: ["One.", "Two.", "Three."], visual: { type: "diagram", ...v } }] } as Chapter)[0]!;

const overlap = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const hitsPath = (d: DrawnEdge, r: Rect) => d.pts.some((p, i) => i > 0 && crosses(d.pts[i - 1]!, p, r));

/** Everything that collides in a laid-out segment, among things on screen at the same time. */
function problems(scenes: DiagramScene[], L: DiagramLayout): string[] {
  const last = scenes[scenes.length - 1]!, out: string[] = [];
  const moments = scenes.flatMap((sc) => [sc.initial, ...sc.steps.map((s) => s.visible)]);
  const edge = new Map(last.edges.map((e) => [e.id, e]));
  const on = (m: Set<string>, id: string) => m.has(id) && (!edge.get(id) || (m.has(edge.get(id)!.from) && m.has(edge.get(id)!.to)));
  const together = (a: string, b: string) => moments.some((m) => on(m, a) && on(m, b));
  const labels = new Map(last.nodes.map((n) => [n.id, new Set([n.label, ...scenes.flatMap((sc) => [sc.initialLabels[n.id], ...sc.steps.map((s) => s.labels[n.id])]).filter((l): l is string => !!l)])]));
  const rect = (id: string) => {
    const n = last.nodes.find((x) => x.id === id)!;
    return nodeRect(L.pos[id]!, { w: Math.max(...[...labels.get(id)!].map((l) => nodeSize(l, n.shape).w)), h: 100 }, n.shape);
  };
  for (const n of last.nodes) for (const l of labels.get(n.id)!) if (textWidth(l, NODE_FONT) > nodeSize(l, n.shape).w - 16) out.push(`text of "${l}" overflows its box`);
  const drawn = new Map(last.edges.filter((e) => L.edges[e.id]).map((e) => [e.id, drawEdge(L.edges[e.id]!.route, L.pos[e.from]!, rect(e.from), L.pos[e.to]!, rect(e.to))]));
  for (const e of last.edges) {
    const d = drawn.get(e.id);
    if (!d) {
      out.push(`${e.id} is not drawn`);
      continue;
    }
    for (const n of last.nodes) if (n.id !== e.from && n.id !== e.to && together(n.id, e.id) && hitsPath(d, rect(n.id))) out.push(`${e.id} cuts through ${n.id}`);
    const l = L.edges[e.id]!.label;
    if (!e.label || !l) continue;
    const h = EDGE_FONT * 1.2, r = { x0: l.x - l.w / 2 + 1, x1: l.x + l.w / 2 - 1, y0: l.y - h / 2 + 1, y1: l.y + h / 2 - 1 };
    for (const n of last.nodes) if (together(n.id, e.id) && overlap(r, rect(n.id))) out.push(`label "${e.label}" covers ${n.id}`);
    for (const [id, o] of drawn) if (together(id, e.id) && hitsPath(o, r)) out.push(`label "${e.label}" sits on ${id === e.id ? "its own arrow" : id}`);
  }
  return out;
}

test("the width table is KaTeX_Main's own advances, read from the installed font", () => {
  const font = fontWidths(KATEX_MAIN);
  assert.equal(font.size, Object.keys(KATEX_MAIN_EM).length, "the table covers every character the font has");
  for (const [c, w] of font) assert.equal(KATEX_MAIN_EM[c], +w.toFixed(4), `U+${c.toString(16)}`);
});

test("text widths add up the font's advances; a character the font lacks counts as wide", () => {
  assert.equal(textWidth("ab", 100), (KATEX_MAIN_EM[97]! + KATEX_MAIN_EM[98]!) * 100);
  assert.ok(textWidth("WWW", 38) > textWidth("iii", 38) * 2, "proportional, not a count of characters");
  assert.equal(KATEX_MAIN_EM[96], undefined, "the font has no backtick");
  assert.equal(textWidth("`", 10), 6, "a missing character counts 0.6 em");
  assert.equal(textWidth("\u{1F600}", 10), 10, "emoji and CJK count 1 em");
});

test("a box is wide enough for its text and never narrower than 190 px", () => {
  assert.equal(nodeSize("a").w, 190);
  const long = "derivability undecidable";
  assert.ok(nodeSize(long).w >= textWidth(long, NODE_FONT) + 2 * 44, "text plus room on both sides");
  assert.ok(nodeSize(long, "pill").w > nodeSize(long).w, "a pill keeps more room for its round ends");
});

test("five boxes in a row, every arrow labelled: no label touches a box and every arrow is at least 64 px", () => {
  const ch = fixture("storyboard.json").chapters[0] as Chapter;
  const seg = segments(ch).find((s) => s[s.length - 1]!.nodes.length >= 6)!;
  const L = layoutDiagram(seg);
  assert.deepEqual(problems(seg, L), []);
  const last = seg[seg.length - 1]!;
  for (const e of last.edges.filter((x) => x.label && last.nodes.find((n) => n.id === x.from)!.row === last.nodes.find((n) => n.id === x.to)!.row)) {
    const d = drawEdge(L.edges[e.id]!.route, L.pos[e.from]!, nodeRect(L.pos[e.from]!, nodeSize(e.from)), L.pos[e.to]!, nodeRect(L.pos[e.to]!, nodeSize(e.to)));
    const len = Math.hypot(d.pts[d.pts.length - 1]!.x - d.pts[0]!.x, d.pts[d.pts.length - 1]!.y - d.pts[0]!.y);
    assert.ok(len >= 64 || L.edges[e.id]!.route.kind !== "line", `${e.id}: ${len.toFixed(0)} px`);
  }
  assert.ok(L.scale < 1 && L.scale > 0.8, `scaled to fit the stage: ${L.scale.toFixed(3)}`);
});

test("short labels keep the grid: columns 360 px apart, centred, nothing scaled", () => {
  const seg = one({ nodes: [{ id: "a", label: "a", col: 0, row: 1 }, { id: "b", label: "b", col: 2, row: 1 }, { id: "c", label: "c", col: 4, row: 1 }], edges: [{ id: "e", from: "a", to: "b", label: "go" }], steps: [{ show: ["a", "b", "c", "e"] }] });
  const L = layoutDiagram(seg);
  assert.deepEqual([L.pos.a, L.pos.b, L.pos.c], [{ x: 240, y: 500 }, { x: 960, y: 500 }, { x: 1680, y: 500 }]);
  assert.deepEqual([L.scale, L.tx, L.ty], [1, 0, 0]);
});

test("an arrow that would cut through a box bends around it", () => {
  const seg = one({
    nodes: [{ id: "a", label: "readme:s1", col: 0, row: 1 }, { id: "m", label: "outline claim", col: 2, row: 1 }, { id: "b", label: "beat", col: 4, row: 1 }],
    edges: [{ id: "am", from: "a", to: "m", label: "cite 1 to 4" }, { id: "ab", from: "a", to: "b", label: "cite" }],
    steps: [{ show: ["a", "m", "am"] }, { show: ["b", "ab"] }],
  });
  const L = layoutDiagram(seg);
  assert.equal(L.edges.ab!.route.kind, "curve");
  assert.deepEqual(problems(seg, L), []);
});

test("only things on screen together are kept apart: a hidden box does not bend an arrow", () => {
  const nodes = [{ id: "a", label: "a", col: 0, row: 1 }, { id: "m", label: "middle", col: 2, row: 1 }, { id: "b", label: "b", col: 4, row: 1 }];
  const hidden = layoutDiagram(one({ nodes, edges: [{ id: "ab", from: "a", to: "b" }], steps: [{ show: ["a", "m"] }, { hide: ["m"], show: ["b", "ab"] }] }));
  assert.equal(hidden.edges.ab!.route.kind, "line");
  const shown = layoutDiagram(one({ nodes, edges: [{ id: "ab", from: "a", to: "b" }], steps: [{ show: ["a", "m"] }, { show: ["b", "ab"] }] }));
  assert.equal(shown.edges.ab!.route.kind, "curve");
});

test("a vertical arrow's label sits beside it, not across it", () => {
  const seg = one({ nodes: [{ id: "a", label: "input", col: 2, row: 0 }, { id: "b", label: "output", col: 2, row: 1 }], edges: [{ id: "e", from: "a", to: "b", label: "now serving" }], steps: [{ show: ["a", "b", "e"] }] });
  const L = layoutDiagram(seg);
  assert.deepEqual(problems(seg, L), []);
  assert.ok(Math.abs(L.edges.e!.label!.x - L.pos.a!.x) >= L.edges.e!.label!.w / 2, "the label's edge is clear of the arrow's line");
});

test("an arrow from a node to itself is a loop, drawn on the free side, its label clear of every box", () => {
  const seg = one({ nodes: [{ id: "x", label: "[f(f(a))]", col: 2, row: 1 }, { id: "y", label: "above", col: 2, row: 0 }], edges: [{ id: "self", from: "x", to: "x", label: "f" }], steps: [{ show: ["x", "y", "self"] }] });
  const L = layoutDiagram(seg);
  assert.deepEqual(L.edges.self!.route, { kind: "loop", side: "down" }, "a box sits above it, so the loop goes below");
  assert.deepEqual(problems(seg, L), []);
  assert.ok(L.edges.self!.label!.y > L.pos.x!.y + 50, "the label sits beyond the loop, below the box");
});

test("a row too wide for the stage is scaled down, never off the stage", () => {
  const long = "a label as long as forty characters is ok".slice(0, 40);
  const seg = one({ nodes: [0, 1, 2, 3, 4].map((c) => ({ id: `n${c}`, label: long, col: c, row: 1 })), edges: [0, 1, 2, 3].map((c) => ({ id: `e${c}`, from: `n${c}`, to: `n${c + 1}`, label: "step" })), steps: [{}] });
  const L = layoutDiagram(seg);
  assert.ok(L.scale < 0.6, `scale ${L.scale.toFixed(3)}`);
  assert.ok(L.bounds.x0 >= AREA.x0 - 0.5 && L.bounds.x1 <= AREA.x1 + 0.5 && L.bounds.y0 >= AREA.y0 - 0.5 && L.bounds.y1 <= AREA.y1 + 0.5, JSON.stringify(L.bounds));
  assert.deepEqual(problems(seg, L), []);
});

test("slides: the panel's box holds everything the diagram draws, wherever its columns are", () => {
  const v: DiagramVisual = { type: "diagram", nodes: [{ id: "a", label: "a node", col: 0, row: 0 }, { id: "b", label: "another node", col: 2, row: 1 }], edges: [{ id: "e", from: "a", to: "b", label: "maps to" }], steps: [{}] };
  const seg = one(v);
  const box = stageBox(v, seg), b = layoutDiagram(seg).bounds;
  assert.ok(box.x <= b.x0 && box.y <= b.y0 && box.x + box.w >= b.x1 && box.y + box.h >= b.y1, `${JSON.stringify(box)} holds ${JSON.stringify(b)}`);
});

test("every diagram in the fixture video lays out with nothing overlapping", () => {
  const sb = fixture("storyboard.json");
  let count = 0;
  for (const ch of sb.chapters as Chapter[]) for (const seg of segments(ch)) {
    count++;
    assert.deepEqual(problems(seg, layoutDiagram(seg)), [], `${ch.title}, segment ${count}`);
  }
  assert.ok(count >= 9, `${count} segments`);
});
