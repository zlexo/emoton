/**
 * What changed between two documents, in the editor's words: scenes added,
 * removed, moved or changed (a line rewritten, the visual, its timing), and
 * the sounds, effects, text, music and captions. Ask shows a proposal this
 * way before it is kept. Pure, shared by the app and the server.
 */
import type { Scene, Short } from "../../../schema/short.ts";
import { parseLine } from "./resolve.ts";

export type Change = {
  /** What it is about: a scene id, or the track. */
  on: string;
  kind: "added" | "removed" | "changed" | "moved";
  label: string;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const visualLabel = (s: Scene) => (s.continue ? "carries on the footage before" : s.visual?.type === "shot" ? `shot ${s.visual.kind}` : s.visual?.type === "clip" ? `clip ${s.visual.asset.split("/").pop()}` : s.visual?.type === "code" ? `code ${s.visual.files.map((f) => f.path.split("/").pop()).join(", ")}` : s.visual?.type === "card" ? `card "${s.visual.title}"` : "no visual");
const quote = (l: string) => `"${parseLine(l).text}"`;

function sceneChanges(a: Scene, b: Scene): string[] {
  const out: string[] = [];
  const la = a.say ?? [], lb = b.say ?? [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === lb[i]) continue;
    if (la[i] === undefined) out.push(`line added: ${quote(lb[i]!)}`);
    else if (lb[i] === undefined) out.push(`line removed: ${quote(la[i]!)}`);
    else if (parseLine(la[i]!).text === parseLine(lb[i]!).text) out.push(`sounds in line ${i + 1}: ${parseLine(lb[i]!).marks.join(", ") || "none"}`);
    else out.push(`line ${i + 1}: ${quote(la[i]!)} → ${quote(lb[i]!)}`);
  }
  if (!same(a.visual, b.visual) || !!a.continue !== !!b.continue) {
    out.push(visualLabel(a) === visualLabel(b) ? `${visualLabel(b)}: settings changed` : `${visualLabel(a)} → ${visualLabel(b)}`);
  }
  for (const k of ["hold", "lead", "after", "in", "push"] as const) {
    if (a[k] !== b[k]) out.push(`${k} ${a[k] ?? "default"} → ${b[k] ?? "default"}`);
  }
  return out;
}

/** Items of a list matched by content: what only one side has. */
function listChanges<T>(on: string, a: T[], b: T[], label: (x: T) => string): Change[] {
  const left = a.map((x) => JSON.stringify(x)), right = b.map((x) => JSON.stringify(x));
  const out: Change[] = [];
  const rest = [...right];
  a.forEach((x, i) => {
    const j = rest.indexOf(left[i]!);
    if (j >= 0) rest.splice(j, 1);
    else out.push({ on, kind: "removed", label: label(x) });
  });
  const left2 = [...left];
  b.forEach((x, i) => {
    const j = left2.indexOf(right[i]!);
    if (j >= 0) left2.splice(j, 1);
    else out.push({ on, kind: "added", label: label(x) });
  });
  return out;
}

const at = (x: { at: unknown }) => {
  const a = x.at as { word?: { s: string; w: number }; t?: number; scene?: string; sentence?: string; beat?: number };
  return a.word ? `on "${a.word.s.split(/\s+/)[a.word.w] ?? a.word.s}"` : a.t !== undefined ? `at ${a.t} s` : a.scene ? `at ${a.scene}` : a.sentence ? `on "${a.sentence}"` : `on beat ${a.beat}`;
};

/** The longest increasing subsequence of a list of distinct numbers. */
function longestRun(xs: number[]): number[] {
  const tails: number[] = [], prev: number[] = new Array(xs.length).fill(-1);
  xs.forEach((x, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]!]! < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.unshift(xs[i]!);
  return out;
}

export function diffShort(a: Short, b: Short): Change[] {
  const out: Change[] = [];
  const ida = a.scenes.map((s) => s.id), idb = b.scenes.map((s) => s.id);
  for (const s of a.scenes) if (!idb.includes(s.id)) out.push({ on: s.id, kind: "removed", label: `scene ${s.id} (${visualLabel(s)})` });
  for (const s of b.scenes) if (!ida.includes(s.id)) out.push({ on: s.id, kind: "added", label: `scene ${s.id}: ${visualLabel(s)}${s.say?.length ? `, ${s.say.length} line${s.say.length > 1 ? "s" : ""}` : ""}` });
  // among the scenes both have, the ones outside the longest run still in order moved
  const common = ida.filter((x) => idb.includes(x));
  const order = idb.filter((x) => ida.includes(x)).map((x) => common.indexOf(x));
  const stay = new Set(longestRun(order).map((i) => common[i]!));
  for (const id of idb) if (ida.includes(id) && !stay.has(id)) out.push({ on: id, kind: "moved", label: `scene ${id} moved to place ${idb.indexOf(id) + 1}` });
  for (const id of common) {
    const sa = a.scenes.find((s) => s.id === id)!, sb = b.scenes.find((s) => s.id === id)!;
    for (const label of sceneChanges(sa, sb)) out.push({ on: id, kind: "changed", label: `${id}: ${label}` });
  }
  out.push(...listChanges("sounds", a.sfx, b.sfx, (x) => `${x.kind === "file" ? x.asset?.split("/").pop() : x.kind} ${at(x)}`));
  out.push(...listChanges("effects", a.fx, b.fx, (x) => `${x.kind} ${at(x)}`));
  out.push(...listChanges("text", a.text, b.text, (x) => `${x.role} "${x.text}"`));
  if (!same(a.music, b.music)) out.push({ on: "music", kind: "changed", label: !b.music ? "music removed" : !a.music ? "music added" : "music changed" });
  if (!same(a.captions.style, b.captions.style)) out.push({ on: "captions", kind: "changed", label: "caption style changed" });
  if (!same(a.captions.overrides, b.captions.overrides)) out.push({ on: "captions", kind: "changed", label: `caption breaks and highlights: ${a.captions.overrides.length} → ${b.captions.overrides.length}` });
  for (const k of ["title", "voice", "soundKit", "exportPresets", "canvas", "target"] as const) {
    if (!same(a[k], b[k])) out.push({ on: k, kind: "changed", label: `${k} changed` });
  }
  return out;
}
