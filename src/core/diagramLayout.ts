import type { DiagramNode } from "../../schema/storyboard.ts";
import type { DiagramScene } from "./diagram.ts";
import { textWidth } from "./textWidth.ts";

/**
 * Where a diagram's boxes, arrows and labels go. Worked out once per segment
 * (a diagram and the beats that continue it) from everything the segment ever
 * shows, so nothing moves as it builds:
 * - a box is as wide as its text needs;
 * - columns sit on the 360 px grid and only move apart when an arrow between
 *   neighbours needs room for its label;
 * - an arrow that would cut through a box bends around it; an arrow from a
 *   node to itself is a loop;
 * - a label goes where it touches no box, no line and no other label;
 * - the drawing is scaled down, never up, when it would leave the stage.
 * Only things that are on screen at the same time are kept apart.
 */

export const GRID = { x0: 240, dx: 360, y0: 250, dy: 245 };
export const NODE_H = 100;
export const NODE_FONT = 38;
export const EDGE_FONT = 34;
/** Space between a box and the end of an arrow touching it. */
export const EDGE_GAP = 12;
/** A stack (a queue or buffer) draws two copies behind it, up to this far up and to the right. */
export const STACK_SHIFT = 24;
/** The shortest arrow between neighbours that still reads as one. */
const MIN_ARROW = 64;
const LABEL_H = Math.round(EDGE_FONT * 1.25);
/** Room a label keeps from its arrow, from boxes and from other labels. */
const CLEAR = 10;
/** The part of the 1920 x 1080 stage a diagram may cover: clear of the citation chip above and the captions below. */
export const AREA = { x0: 40, y0: 120, x1: 1880, y1: 865 };
const CENTRE = { x: 960, y: 500 };
/** Points sampled along every edge, for the collision checks. */
const SAMPLES = 24;

export type Pt = { x: number; y: number };
export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type Size = { w: number; h: number };
export type Shape = DiagramNode["shape"];

/** A box wide enough for its text, never narrower than 190 px. Pills keep more room for their round ends. */
export function nodeSize(label: string, shape?: Shape): Size {
  const pad = shape === "pill" ? 52 : 44;
  return { w: Math.max(190, Math.ceil(textWidth(label, NODE_FONT)) + 2 * pad), h: NODE_H };
}

/** What a node covers around its centre, a stack's copies included. */
export function nodeRect(p: Pt, s: Size, shape?: Shape, margin = 0): Rect {
  const k = shape === "stack" ? STACK_SHIFT : 0;
  return { x0: p.x - s.w / 2 - margin, x1: p.x + s.w / 2 + k + margin, y0: p.y - s.h / 2 - k - margin, y1: p.y + s.h / 2 + margin };
}

export type Route =
  | { kind: "line"; offset: number }
  | { kind: "curve"; control: Pt }
  | { kind: "loop"; side: "up" | "down" | "right" };

/** An edge as drawn: its SVG path, points along it, and where its arrowhead sits and points. */
export type DrawnEdge = { d: string; pts: Pt[]; end: Pt; angle: number };

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const quad = (a: Pt, c: Pt, b: Pt, t: number) => lerp(lerp(a, c, t), lerp(c, b, t), t);
const cubic = (a: Pt, c1: Pt, c2: Pt, b: Pt, t: number) => quad(lerp(a, c1, t), lerp(c1, c2, t), lerp(c2, b, t), t);
const fmt = (p: Pt) => `${+p.x.toFixed(2)} ${+p.y.toFixed(2)}`;
const shift = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy });
const grow = (r: Rect, m: number): Rect => ({ x0: r.x0 - m, x1: r.x1 + m, y0: r.y0 - m, y1: r.y1 + m });
const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const labelRect = (c: Pt, w: number): Rect => ({ x0: c.x - w / 2, x1: c.x + w / 2, y0: c.y - LABEL_H / 2, y1: c.y + LABEL_H / 2 });

/** Does the segment pq cross rectangle r? (Liang-Barsky clipping.) */
export function crosses(p: Pt, q: Pt, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [num, den] of [[p.x - r.x0, -dx], [r.x1 - p.x, dx], [p.y - r.y0, -dy], [r.y1 - p.y, dy]] as const) {
    if (den === 0) {
      if (num < 0) return false;
    } else {
      const t = num / den;
      if (den < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}
const pathCrosses = (pts: Pt[], r: Rect) => pts.some((p, i) => i > 0 && crosses(pts[i - 1]!, p, r));

/** Where the line from c towards p leaves rectangle r, plus the arrow gap (never past p). */
function exitPoint(c: Pt, toward: Pt, r: Rect): Pt {
  const dx = toward.x - c.x, dy = toward.y - c.y;
  const sx = dx === 0 ? Infinity : ((dx > 0 ? r.x1 - c.x : c.x - r.x0) + EDGE_GAP) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : ((dy > 0 ? r.y1 - c.y : c.y - r.y0) + EDGE_GAP) / Math.abs(dy);
  const k = Math.min(sx, sy, 1);
  return { x: c.x + dx * k, y: c.y + dy * k };
}

/** Draws an edge between the boxes ra (around a) and rb (around b); a loop uses a and ra only. */
export function drawEdge(route: Route, a: Pt, ra: Rect, b: Pt, rb: Rect): DrawnEdge {
  const n = Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES);
  if (route.kind === "loop") {
    let s: Pt, e: Pt, c1: Pt, c2: Pt;
    if (route.side === "right") {
      const x = ra.x1 + 4;
      [s, e, c1, c2] = [{ x, y: a.y - 26 }, { x, y: a.y + 26 }, { x: x + 130, y: a.y - 95 }, { x: x + 130, y: a.y + 95 }];
    } else {
      const dir = route.side === "up" ? -1 : 1, y = (dir < 0 ? ra.y0 : ra.y1) + dir * 4;
      [s, e, c1, c2] = [{ x: a.x + 28, y }, { x: a.x - 28, y }, { x: a.x + 95, y: y + dir * 130 }, { x: a.x - 95, y: y + dir * 130 }];
    }
    return { d: `M ${fmt(s)} C ${fmt(c1)} ${fmt(c2)} ${fmt(e)}`, pts: n.map((t) => cubic(s, c1, c2, e, t)), end: e, angle: Math.atan2(e.y - c2.y, e.x - c2.x) };
  }
  if (route.kind === "curve") {
    const c = route.control, p1 = exitPoint(a, c, ra), p2 = exitPoint(b, c, rb);
    return { d: `M ${fmt(p1)} Q ${fmt(c)} ${fmt(p2)}`, pts: n.map((t) => quad(p1, c, p2, t)), end: p2, angle: Math.atan2(p2.y - c.y, p2.x - c.x) };
  }
  // A second edge between the same two nodes runs parallel, `offset` px to its left.
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ox = (-(b.y - a.y) / len) * route.offset, oy = ((b.x - a.x) / len) * route.offset;
  const a2 = { x: a.x + ox, y: a.y + oy }, b2 = { x: b.x + ox, y: b.y + oy };
  const p1 = exitPoint(a2, b2, shift(ra, ox, oy)), p2 = exitPoint(b2, a2, shift(rb, ox, oy));
  return { d: `M ${fmt(p1)} L ${fmt(p2)}`, pts: n.map((t) => lerp(p1, p2, t)), end: p2, angle: Math.atan2(p2.y - p1.y, p2.x - p1.x) };
}

export type EdgeLayout = { route: Route; label?: { x: number; y: number; w: number } };

export type DiagramLayout = {
  /** Node centres, in drawing coordinates. */
  pos: Record<string, Pt>;
  edges: Record<string, EdgeLayout>;
  /** A stage point is scale * a drawing point + (tx, ty). */
  scale: number;
  tx: number;
  ty: number;
  /** Everything the segment draws, on the stage (after the scale). */
  bounds: Rect;
};

/** Lays out the segment whose scenes these are (the last scene holds every node and edge). */
export function layoutDiagram(scenes: DiagramScene[]): DiagramLayout {
  const last = scenes[scenes.length - 1];
  if (!last) throw new Error("a diagram layout needs at least one scene");
  const { nodes, edges } = last;
  const node = new Map(nodes.map((n) => [n.id, n]));

  // Every label a node shows: it is spaced for the widest.
  const labels = new Map(nodes.map((n) => [n.id, new Set([n.label])]));
  for (const sc of scenes) {
    for (const [id, l] of Object.entries(sc.initialLabels)) labels.get(id)?.add(l);
    for (const st of sc.steps) for (const [id, l] of Object.entries(st.labels)) labels.get(id)?.add(l);
  }
  const size = new Map(nodes.map((n) => [n.id, { w: Math.max(...[...labels.get(n.id)!].map((l) => nodeSize(l, n.shape).w)), h: NODE_H }]));

  // Which ids are ever on screen together; an edge is on screen with both its ends.
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const moments = scenes.flatMap((sc) => [sc.initial, ...sc.steps.map((s) => s.visible)]);
  const onScreen = (m: Set<string>, id: string) => {
    const e = edgeById.get(id);
    return m.has(id) && (!e || (m.has(e.from) && m.has(e.to)));
  };
  const when = new Map([...node.keys(), ...edgeById.keys()].map((id) => [id, new Set(moments.flatMap((m, i) => (onScreen(m, id) ? [i] : [])))]));
  const together = (a: string, b: string) => [...when.get(a)!].some((i) => when.get(b)!.has(i));

  // Columns: the old grid, pushed apart where neighbours in a row need room for their arrow and its label.
  const right = (id: string) => size.get(id)!.w / 2 + (node.get(id)!.shape === "stack" ? STACK_SHIFT : 0);
  const left = (id: string) => size.get(id)!.w / 2;
  const cols = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b);
  const colX = new Map<number, number>();
  cols.forEach((c, i) => {
    const p = cols[i - 1];
    let x = p === undefined ? GRID.x0 + c * GRID.dx : colX.get(p)! + (c - p) * GRID.dx;
    for (const v of nodes.filter((n) => n.col === c)) {
      const u = nodes.filter((n) => n.row === v.row && n.col < c).sort((a, b) => b.col - a.col)[0];
      if (!u) continue;
      const linked = edges.filter((e) => (e.from === u.id && e.to === v.id) || (e.from === v.id && e.to === u.id));
      const room = linked.length
        ? 2 * EDGE_GAP + Math.max(MIN_ARROW, ...linked.map((e) => (e.label ? textWidth(e.label, EDGE_FONT) + 2 * CLEAR : 0)))
        : 2 * CLEAR;
      x = Math.max(x, colX.get(u.col)! + right(u.id) + left(v.id) + room);
    }
    colX.set(c, x);
  });
  // Centred on the stage the way the grid always was: by the node centres.
  const xs = nodes.map((n) => colX.get(n.col)!), ys = nodes.map((n) => GRID.y0 + n.row * GRID.dy);
  const cx = CENTRE.x - (Math.min(...xs) + Math.max(...xs)) / 2, cy = CENTRE.y - (Math.min(...ys) + Math.max(...ys)) / 2;
  const pos: Record<string, Pt> = {};
  for (const n of nodes) pos[n.id] = { x: colX.get(n.col)! + cx, y: GRID.y0 + n.row * GRID.dy + cy };
  const rectOf = (id: string, m = 0) => nodeRect(pos[id]!, size.get(id)!, node.get(id)!.shape, m);

  // Routes: straight, a bow around boxes in the way, or a loop.
  const out: Record<string, EdgeLayout> = {};
  const drawn = new Map<string, DrawnEdge>();
  const pairs = new Map<string, number>();
  for (const e of edges) {
    const a = node.get(e.from), b = node.get(e.to);
    if (!a || !b) continue;
    const busy = (col: number, row: number) => nodes.some((n) => n.col === col && n.row === row && n.id !== a.id && together(n.id, e.id));
    let route: Route;
    if (a.id === b.id) route = { kind: "loop", side: !busy(a.col, a.row - 1) ? "up" : !busy(a.col, a.row + 1) ? "down" : "right" };
    else {
      const key = [e.from, e.to].sort().join("|");
      const nth = pairs.get(key) ?? 0;
      pairs.set(key, nth + 1);
      route = { kind: "line", offset: nth === 0 ? 0 : 26 * (e.from < e.to ? 1 : -1) };
      const blockers = nodes.filter((n) => n.id !== a.id && n.id !== b.id && together(n.id, e.id)).map((n) => rectOf(n.id, CLEAR));
      const blocked = (d: DrawnEdge) => blockers.some((r) => pathCrosses(d.pts, r));
      if (blocked(drawEdge(route, pos[a.id]!, rectOf(a.id), pos[b.id]!, rectOf(b.id)))) {
        const pa = pos[a.id]!, pb = pos[b.id]!, mid = lerp(pa, pb, 0.5), len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
        const nx = -(pb.y - pa.y) / len, ny = (pb.x - pa.x) / len;
        bow: for (const k of [120, 170, 230, 300, 380, 470]) {
          for (const side of [1, -1]) {
            const curve: Route = { kind: "curve", control: { x: mid.x + nx * k * side, y: mid.y + ny * k * side } };
            if (!blocked(drawEdge(curve, pa, rectOf(a.id), pb, rectOf(b.id)))) {
              route = curve;
              break bow;
            }
          }
        }
      }
    }
    out[e.id] = { route };
    drawn.set(e.id, drawEdge(route, pos[a.id]!, rectOf(a.id), pos[b.id]!, rectOf(b.id)));
  }

  // Labels: the first candidate that touches nothing, else the one that touches least.
  const placed: { id: string; r: Rect }[] = [];
  for (const e of edges) {
    const d = drawn.get(e.id);
    if (!e.label || !d) continue;
    const w = textWidth(e.label, EDGE_FONT);
    const boxes = nodes.filter((n) => together(n.id, e.id)).map((n) => rectOf(n.id, CLEAR));
    const lines = edges.filter((o) => drawn.has(o.id) && together(o.id, e.id)).map((o) => drawn.get(o.id)!.pts);
    const others = placed.filter((p) => together(p.id, e.id)).map((p) => grow(p.r, CLEAR));
    const cost = (c: Pt) => {
      const r = labelRect(c, w);
      let s = 0;
      for (const b of boxes) s += area(r, b);
      for (const o of others) s += area(r, o);
      for (const pts of lines) if (pathCrosses(pts, grow(r, CLEAR / 2))) s += 2000;
      return s;
    };
    let best: Pt | undefined, bestCost = Infinity;
    for (const c of labelSpots(out[e.id]!.route, d, w)) {
      const k = cost(c);
      if (k < bestCost) [best, bestCost] = [c, k];
      if (k === 0) break;
    }
    out[e.id]!.label = { x: best!.x, y: best!.y, w };
    placed.push({ id: e.id, r: labelRect(best!, w) });
  }

  // Bounds of everything ever drawn, then the fit: identity while it fits the stage area.
  const ever = (id: string) => when.get(id)!.size > 0;
  const rects = [
    ...nodes.filter((n) => ever(n.id)).map((n) => rectOf(n.id)),
    ...edges.filter((e) => ever(e.id) && drawn.has(e.id)).flatMap((e) => {
      const l = out[e.id]!.label;
      return [...drawn.get(e.id)!.pts.map((p) => grow({ x0: p.x, x1: p.x, y0: p.y, y1: p.y }, 4)), ...(l ? [labelRect(l, l.w)] : [])];
    }),
  ];
  const all = rects.length ? rects : nodes.map((n) => rectOf(n.id));
  const B = all.reduce((u, r) => ({ x0: Math.min(u.x0, r.x0), y0: Math.min(u.y0, r.y0), x1: Math.max(u.x1, r.x1), y1: Math.max(u.y1, r.y1) }));
  let scale = 1, tx = 0, ty = 0;
  if (B.x0 < AREA.x0 || B.x1 > AREA.x1 || B.y0 < AREA.y0 || B.y1 > AREA.y1) {
    scale = Math.min(1, (AREA.x1 - AREA.x0) / (B.x1 - B.x0), (AREA.y1 - AREA.y0) / (B.y1 - B.y0));
    tx = (AREA.x0 + AREA.x1) / 2 - (scale * (B.x0 + B.x1)) / 2;
    ty = (AREA.y0 + AREA.y1) / 2 - (scale * (B.y0 + B.y1)) / 2;
  }
  const bounds = { x0: scale * B.x0 + tx, x1: scale * B.x1 + tx, y0: scale * B.y0 + ty, y1: scale * B.y1 + ty };
  return { pos, edges: out, scale, tx, ty, bounds };
}

/** Candidate label centres for an edge, best first: beside the middle of the arrow, then further along it. */
function labelSpots(route: Route, d: DrawnEdge, w: number): Pt[] {
  const at = (t: number) => {
    const i = Math.min(SAMPLES - 1, Math.floor(t * SAMPLES)), f = t * SAMPLES - i;
    return lerp(d.pts[i]!, d.pts[i + 1]!, f);
  };
  if (route.kind === "loop") {
    const apex = at(0.5);
    const out = route.side === "right" ? { x: CLEAR + w / 2, y: 0 } : { x: 0, y: (route.side === "up" ? -1 : 1) * (CLEAR + LABEL_H / 2) };
    return [{ x: apex.x + out.x, y: apex.y + out.y }, { x: apex.x + out.x + w / 2 + CLEAR, y: apex.y + out.y }, { x: apex.x + out.x - w / 2 - CLEAR, y: apex.y + out.y }];
  }
  // A bow's label goes on its outside first; a straight arrow's below (left-to-right) as it always did.
  const p1 = d.pts[0]!, p2 = d.pts[SAMPLES]!;
  let prefer = 1;
  if (route.kind === "curve") {
    const mid = lerp(p1, p2, 0.5), nx = -(p2.y - p1.y), ny = p2.x - p1.x;
    prefer = nx * (route.control.x - mid.x) + ny * (route.control.y - mid.y) < 0 ? -1 : 1;
  }
  const spots: Pt[] = [];
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    const p = at(t), q = at(Math.min(1, t + 0.02)), o = at(Math.max(0, t - 0.02));
    const len = Math.hypot(q.x - o.x, q.y - o.y) || 1, ux = (q.x - o.x) / len, uy = (q.y - o.y) / len;
    for (const side of [prefer, -prefer]) {
      const nx = -uy * side, ny = ux * side;
      const dist = (Math.abs(nx) * w) / 2 + (Math.abs(ny) * LABEL_H) / 2 + CLEAR;
      spots.push({ x: p.x + nx * dist, y: p.y + ny * dist });
    }
  }
  return spots;
}
