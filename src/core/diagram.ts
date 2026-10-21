import type { Chapter, DiagramEdge, DiagramNode, DiagramVisual } from "../../schema/storyboard.ts";

export const GRID = { cols: 5, rows: 3 };

export type PlacedNode = DiagramNode & { col: number; row: number };

/** One diagram beat, fully resolved: everything the renderer needs, no lookups. */
export type DiagramScene = {
  nodes: PlacedNode[];
  edges: DiagramEdge[];
  /** Ids visible when the beat starts (carried over from a continued diagram). */
  initial: Set<string>;
  initialLabels: Record<string, string>;
  /** Per step: visible ids, labels, highlighted ids after that step fires. */
  steps: { visible: Set<string>; labels: Record<string, string>; highlight: Set<string>; shown: string[] }[];
};

/** Fill in grid cells for nodes without one. Keeps given cells; never stacks two nodes. */
export function placeNodes(nodes: DiagramNode[], fixed: PlacedNode[] = []): PlacedNode[] {
  const taken = new Set(fixed.map((n) => `${n.col},${n.row}`));
  const placed: PlacedNode[] = [];
  const free: DiagramNode[] = [];
  for (const n of nodes) {
    if (n.col !== undefined && n.row !== undefined && !taken.has(`${n.col},${n.row}`)) {
      taken.add(`${n.col},${n.row}`);
      placed.push({ ...n, col: n.col, row: n.row });
    } else free.push(n);
  }
  // Free nodes: a centred middle row first (reads left to right), then the other rows.
  const order: [number, number][] = [];
  const mid = Math.floor(GRID.rows / 2);
  const rows = [mid, ...Array.from({ length: GRID.rows }, (_, r) => r).filter((r) => r !== mid)];
  const count = free.length + [...taken].filter((c) => c.endsWith(`,${mid}`)).length;
  const midCols = spreadCols(Math.min(count, GRID.cols));
  for (const c of midCols) order.push([c, mid]);
  for (const r of rows) for (let c = 0; c < GRID.cols; c++) order.push([c, r]);
  for (const n of free) {
    const cell = order.find(([c, r]) => !taken.has(`${c},${r}`));
    if (!cell) throw new Error(`diagram grid is full (${GRID.cols}x${GRID.rows})`);
    taken.add(`${cell[0]},${cell[1]}`);
    placed.push({ ...n, col: cell[0], row: cell[1] });
  }
  return placed;
}

function spreadCols(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [2];
  if (n === 2) return [1, 3];
  if (n === 3) return [0, 2, 4];
  if (n === 4) return [0, 1, 3, 4];
  return [0, 1, 2, 3, 4];
}

/** Resolve every diagram beat of a chapter. Non-diagram beats, and beats without a visual, map to null. */
export function resolveDiagrams(ch: Chapter): (DiagramScene | null)[] {
  let prev: DiagramScene | null = null;
  return ch.beats.map((b) => {
    const v = b.visual;
    // no visual (slides layout): the diagram on screen stays, and a later beat can continue it
    if (!v) return null;
    if (v.type !== "diagram") {
      prev = null;
      return null;
    }
    const scene = resolveOne(v, v.continue ? prev : null);
    prev = scene;
    return scene;
  });
}

function resolveOne(v: DiagramVisual, base: DiagramScene | null): DiagramScene {
  const baseNodes = base?.nodes ?? [];
  const fresh = v.nodes.filter((n) => !baseNodes.some((b) => b.id === n.id));
  const nodes = [...baseNodes, ...placeNodes(fresh, baseNodes)];
  const edges = [...(base?.edges ?? []), ...v.edges.filter((e) => !(base?.edges ?? []).some((b) => b.id === e.id))];

  const last = base?.steps[base.steps.length - 1];
  const initial = new Set(last?.visible ?? []);
  const initialLabels: Record<string, string> = { ...(last?.labels ?? {}) };
  for (const n of nodes) initialLabels[n.id] ??= n.label;

  // Anything new that no step ever shows appears with the first step.
  const mentioned = new Set(v.steps.flatMap((s) => s.show ?? []));
  const implicit = [...fresh.map((n) => n.id), ...v.edges.map((e) => e.id)].filter(
    (id) => !mentioned.has(id) && !initial.has(id),
  );

  const visible = new Set(initial);
  const labels = { ...initialLabels };
  const steps = v.steps.map((s, k) => {
    const shown = [...(k === 0 ? implicit : []), ...(s.show ?? [])].filter((id) => !visible.has(id));
    for (const id of shown) visible.add(id);
    for (const id of s.hide ?? []) visible.delete(id);
    for (const r of s.relabel ?? []) labels[r.id] = r.label;
    // An edge is only drawn when both ends are visible.
    return { visible: new Set(visible), labels: { ...labels }, highlight: new Set(s.highlight ?? []), shown };
  });
  return { nodes, edges, initial, initialLabels, steps };
}
