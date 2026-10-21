/**
 * Edits to a Short document: each a pure function from a document (and the
 * resolved Short it was shown as) to a new document, so the editor can keep
 * an undo history of whole documents and the preview re-resolves at once.
 * Nothing here mutates its input.
 */
import { MARKERS, type Anchor, type Fx, type KnobValue, type Marker, type Scene, type Short, type ShotVisual, type Sound, type TextClip } from "../../../schema/short.ts";
import { keySentences } from "../words.ts";
import { parseLine, type ResolvedShort } from "./resolve.ts";

const clone = <T>(x: T): T => structuredClone(x);
const r3 = (x: number) => +x.toFixed(3);

/** Where the line with this sentence key is: scene index and line index. */
export function lineOfKey(doc: Short, key: string): { scene: number; line: number } | null {
  const where: { scene: number; line: number }[] = [];
  const texts: string[] = [];
  doc.scenes.forEach((s, si) => (s.say ?? []).forEach((l, li) => (where.push({ scene: si, line: li }), texts.push(parseLine(l).text))));
  const i = keySentences(texts).indexOf(key);
  return i >= 0 ? where[i]! : null;
}

/** The line with its n-th marker (counting markers only) taken out. */
export function withoutMarker(line: string, n: number): string {
  let k = -1;
  return line.replace(/\s*\[([^\]\n]{0,40})\]/g, (m, name: string) => ((MARKERS as readonly string[]).includes(name.trim()) && ++k === n ? "" : m)).trim();
}

/** Where a marker plays when it is not pinned (resolve.ts's rule), as an anchor. */
export const markerAnchor = (kind: Marker, key: string): Anchor =>
  kind === "scratch" ? { sentence: key, edge: "start", offset: -0.05 } : { sentence: key, edge: "end", offset: 0.02 };

// ---------------------------------------------------------------- sounds and effects

/**
 * Sound i of the resolved Short pinned to `at`. A marker leaves its line and
 * becomes a pinned sound; a pinned one moves. Its punch (a boom's) follows.
 */
export function moveSound(doc: Short, r: ResolvedShort, i: number, at: Anchor): Short {
  const s = r.sfx[i];
  if (!s) return doc;
  const d = clone(doc);
  if ("sfx" in s.source) d.sfx[s.source.sfx]!.at = at;
  else {
    const where = lineOfKey(d, s.source.marker.sentence);
    if (!where) return doc;
    const say = d.scenes[where.scene]!.say!;
    say[where.line] = withoutMarker(say[where.line]!, s.source.marker.n);
    d.sfx.push({ kind: s.kind, at });
  }
  return d;
}

/** Sound i's settings changed; a marker is pinned at its own place first, since a line cannot carry settings. */
export function setSound(doc: Short, r: ResolvedShort, i: number, patch: Partial<Pick<Sound, "gainDb" | "punch" | "kind" | "asset">>): Short {
  const s = r.sfx[i];
  if (!s) return doc;
  let d = doc, index: number;
  if ("sfx" in s.source) index = s.source.sfx;
  else {
    d = moveSound(doc, r, i, markerAnchor(s.kind as Marker, s.source.marker.sentence));
    index = d.sfx.length - 1;
  }
  d = d === doc ? clone(doc) : d;
  const cur = d.sfx[index]!;
  const next: Sound = { ...cur, ...patch };
  for (const k of Object.keys(next) as (keyof Sound)[]) if (next[k] === undefined) delete next[k];
  if (next.kind !== "file") delete next.asset;
  d.sfx[index] = next;
  return d;
}

export function addSound(doc: Short, sound: Sound): Short {
  const d = clone(doc);
  d.sfx.push(sound);
  return d;
}

/** Sound i gone: a marker leaves its line, a pinned sound its list. */
export function removeSound(doc: Short, r: ResolvedShort, i: number): Short {
  const s = r.sfx[i];
  if (!s) return doc;
  const d = clone(doc);
  if ("sfx" in s.source) d.sfx.splice(s.source.sfx, 1);
  else {
    const where = lineOfKey(d, s.source.marker.sentence);
    if (!where) return doc;
    const say = d.scenes[where.scene]!.say!;
    say[where.line] = withoutMarker(say[where.line]!, s.source.marker.n);
  }
  return d;
}

/** Effect i moved: one of the document's moves; a boom's punch moves its boom. */
export function moveFx(doc: Short, r: ResolvedShort, i: number, at: Anchor): Short {
  const f = r.fx[i];
  if (!f) return doc;
  if ("boom" in f.source) return moveSound(doc, r, f.source.boom, at);
  const d = clone(doc);
  d.fx[f.source.fx]!.at = at;
  return d;
}

export function setFx(doc: Short, r: ResolvedShort, i: number, patch: Partial<Pick<Fx, "kind" | "dur" | "amount">>): Short {
  const f = r.fx[i];
  if (!f || !("fx" in f.source)) return doc;
  const d = clone(doc);
  const next: Fx = { ...d.fx[f.source.fx]!, ...patch };
  for (const k of Object.keys(next) as (keyof Fx)[]) if (next[k] === undefined) delete next[k];
  d.fx[f.source.fx] = next;
  return d;
}

export function addFx(doc: Short, fx: Fx): Short {
  const d = clone(doc);
  d.fx.push(fx);
  return d;
}

/** Effect i gone; a boom's punch is turned off on its boom (pinned first if it was a marker). */
export function removeFx(doc: Short, r: ResolvedShort, i: number): Short {
  const f = r.fx[i];
  if (!f) return doc;
  if ("boom" in f.source) return setSound(doc, r, f.source.boom, { punch: false });
  const d = clone(doc);
  d.fx.splice(f.source.fx, 1);
  return d;
}

// ---------------------------------------------------------------- text and captions

export function setText(doc: Short, i: number, patch: Partial<TextClip>): Short {
  if (!doc.text[i]) return doc;
  const d = clone(doc);
  const next: TextClip = { ...d.text[i]!, ...patch };
  if (!next.sub) delete next.sub;
  d.text[i] = next;
  return d;
}

export function addText(doc: Short, clip: TextClip): Short {
  const d = clone(doc);
  d.text.push(clip);
  return d;
}

export function removeText(doc: Short, i: number): Short {
  if (!doc.text[i]) return doc;
  const d = clone(doc);
  d.text.splice(i, 1);
  return d;
}

/** A caption override on or off at word w of sentence s. */
export function toggleCaption(doc: Short, s: string, w: number, op: "break" | "join" | "hide" | "emphasize"): Short {
  const d = clone(doc);
  const at = d.captions.overrides.findIndex((o) => o.word.s === s && o.word.w === w && o.op === op);
  if (at >= 0) d.captions.overrides.splice(at, 1);
  else d.captions.overrides.push({ word: { s, w }, op });
  return d;
}

export function setCaptionStyle(doc: Short, patch: Partial<Short["captions"]["style"]>): Short {
  const d = clone(doc);
  d.captions.style = { ...d.captions.style, ...patch };
  if (d.captions.style.top === undefined) delete d.captions.style.top;
  return d;
}

// ---------------------------------------------------------------- scenes

const sceneIndex = (doc: Short, id: string) => doc.scenes.findIndex((s) => s.id === id);

export function setScene(doc: Short, id: string, patch: Partial<Pick<Scene, "in" | "push" | "hold" | "lead" | "after">>): Short {
  const i = sceneIndex(doc, id);
  if (i < 0) return doc;
  const d = clone(doc);
  const next: Scene = { ...d.scenes[i]!, ...patch };
  if (next.hold !== undefined) next.hold = Math.max(0.1, r3(next.hold));
  d.scenes[i] = next;
  return d;
}

/** A shot's knob set (a number, a switch, a word, or an anchor); undefined removes it. */
export function setKnob(doc: Short, id: string, name: string, value: KnobValue | undefined): Short {
  const i = sceneIndex(doc, id);
  const v = doc.scenes[i]?.visual;
  if (!v || v.type !== "shot") return doc;
  const d = clone(doc);
  const knobs = (d.scenes[i]!.visual as ShotVisual).knobs;
  if (value === undefined) delete knobs[name];
  else knobs[name] = value;
  return d;
}

/** Scene `id` moved `by` places (negative: earlier). */
export function moveScene(doc: Short, id: string, by: number): Short {
  const i = sceneIndex(doc, id), j = i + by;
  if (i < 0 || j < 0 || j >= doc.scenes.length || by === 0) return doc;
  const d = clone(doc);
  const [s] = d.scenes.splice(i, 1);
  d.scenes.splice(j, 0, s!);
  return d;
}

/** Every anchor in the document, with a setter, so an edit can follow scenes and lines that change. */
function eachAnchor(d: Short, fn: (a: Anchor) => Anchor | null): void {
  const fix = (a: Anchor) => fn(a) ?? a;
  for (const t of d.text) (t.from = fix(t.from), t.to = fix(t.to));
  for (const f of d.fx) f.at = fix(f.at);
  for (const s of d.sfx) s.at = fix(s.at);
  for (const s of d.scenes) {
    if (s.visual?.type !== "shot") continue;
    for (const [k, v] of Object.entries(s.visual.knobs)) if (typeof v === "object") s.visual.knobs[k] = fix(v);
    if (s.visual.sweep) s.visual.sweep.at = fix(s.visual.sweep.at);
  }
  const m = d.music;
  if (m && "synth" in m.source) {
    if (m.source.synth.lifts) m.source.synth.lifts = m.source.synth.lifts.map(fix);
    if (m.source.synth.drop) m.source.synth.drop = fix(m.source.synth.drop);
  } else if (m && "file" in m.source && m.source.file.align) m.source.file.align = fix(m.source.file.align);
}

const freeId = (doc: Short, base: string) => {
  let id = base.slice(0, 28);
  for (let n = 2; doc.scenes.some((s) => s.id === id); n++) id = `${base.slice(0, 26)}-${n}`;
  return id;
};

/**
 * Spoken scene `id` split before its line `at`: the lines from there on form
 * a new scene that carries on the same footage (continue) on a plain cut.
 * Anything pinned to the old scene's end now points at the new scene's end.
 */
export function splitScene(doc: Short, id: string, at: number): Short {
  const i = sceneIndex(doc, id);
  const s = doc.scenes[i];
  if (!s?.say || at <= 0 || at >= s.say.length) return doc;
  const d = clone(doc);
  const first = d.scenes[i]!;
  const nid = freeId(d, `${id}-b`);
  const second: Scene = { id: nid, say: first.say!.slice(at), continue: true, in: "cut", ...(first.push !== undefined ? { push: first.push } : {}) };
  first.say = first.say!.slice(0, at);
  d.scenes.splice(i + 1, 0, second);
  eachAnchor(d, (a) => ("scene" in a && a.scene === id && a.edge === "end" ? { ...a, scene: nid } : null));
  return d;
}

/** Scene `id` removed, with every sound, effect and text pinned to it or to its lines. */
export function removeScene(doc: Short, id: string): Short {
  const i = sceneIndex(doc, id);
  if (i < 0 || doc.scenes.length === 1) return doc;
  const keys = new Set<string>();
  const texts: string[] = [];
  const mine: boolean[] = [];
  doc.scenes.forEach((s, si) => (s.say ?? []).forEach((l) => (texts.push(parseLine(l).text), mine.push(si === i))));
  keySentences(texts).forEach((k, n) => mine[n] && keys.add(k));
  const gone = (a: Anchor) => ("scene" in a && a.scene === id) || ("sentence" in a && keys.has(a.sentence)) || ("word" in a && keys.has(a.word.s));
  const d = clone(doc);
  d.scenes.splice(i, 1);
  d.text = d.text.filter((t) => !gone(t.from) && !gone(t.to));
  d.fx = d.fx.filter((f) => !gone(f.at));
  d.sfx = d.sfx.filter((s) => !gone(s.at));
  d.captions.overrides = d.captions.overrides.filter((o) => !keys.has(o.word.s));
  return d;
}

/** A new held scene showing a clip (bundle path), after scene `after` (else at the end), coming in on a cut. */
export function addClipScene(doc: Short, asset: string, seconds = 3, after?: string): Short {
  const d = clone(doc);
  const base = (asset.split("/").pop() ?? "clip").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "clip";
  const scene: Scene = { id: freeId(d, base), hold: Math.max(0.1, r3(seconds)), visual: { type: "clip", asset }, in: "cut" };
  const i = after ? d.scenes.findIndex((s) => s.id === after) : -1;
  d.scenes.splice(i >= 0 ? i + 1 : d.scenes.length, 0, scene);
  return d;
}

/** Clips as new held scenes in their order, the first after scene `after` (else all at the end). */
export function addClipScenes(doc: Short, assets: string[], seconds = 3, after?: string): Short {
  let d = doc;
  for (const a of assets) {
    const before = new Set(d.scenes.map((s) => s.id));
    d = addClipScene(d, a, seconds, after);
    after = d.scenes.find((s) => !before.has(s.id))!.id;
  }
  return d;
}

/** Scene `id` shows a clip (from its start) instead of its own visual or the footage it carried on. */
export function useClip(doc: Short, id: string, asset: string): Short {
  const i = sceneIndex(doc, id);
  if (i < 0) return doc;
  const d = clone(doc);
  const s = d.scenes[i]!;
  delete s.continue;
  s.visual = { type: "clip", asset };
  return d;
}

// ---------------------------------------------------------------- music

export function setMusic(doc: Short, music: Short["music"]): Short {
  const d = clone(doc);
  d.music = music;
  return d;
}

// ---------------------------------------------------------------- snapping

export type SnapTo = { words: boolean; beats: boolean; scenes: boolean };

/**
 * The anchor nearest to time t within `tolerance` seconds: a word's start or
 * end, a beat, a scene's start, a scene's end (in that order of preference
 * when as near); else a fixed time.
 */
export function snap(r: ResolvedShort, t: number, to: SnapTo, tolerance: number): { at: Anchor; t: number } {
  let best: { at: Anchor; t: number; d: number; rank: number } | null = null;
  const consider = (at: Anchor, ct: number, rank: number) => {
    const dist = Math.abs(ct - t);
    if (dist > tolerance) return;
    if (!best || dist < best.d - 1e-9 || (Math.abs(dist - best.d) < 1e-9 && rank < best.rank)) best = { at, t: ct, d: dist, rank };
  };
  if (to.words) for (const s of r.sentences) s.words.forEach((w, k) => (consider({ word: { s: s.key, w: k } }, w.start, 0), consider({ word: { s: s.key, w: k }, edge: "end" }, w.end, 0)));
  const g = r.music?.grid;
  if (to.beats && g) {
    const beat = 60 / g.bpm;
    const n = Math.round((t - g.first) / beat);
    for (const k of [n - 1, n, n + 1]) if (k >= 0) consider({ beat: k }, g.first + k * beat, 1);
  }
  // at a cut, the next scene's start wins over the last one's end: the item then moves with the scene it sits in
  if (to.scenes) for (const s of r.scenes) (consider({ scene: s.id, edge: "start" }, s.from, 2), consider({ scene: s.id, edge: "end" }, s.from + s.seconds, 3));
  const b = best as { at: Anchor; t: number } | null;
  return b ? { at: b.at, t: r3(b.t) } : { at: { t: Math.max(0, r3(t)) }, t: Math.max(0, r3(t)) };
}

/** The word being spoken at t, or the next one to start: where B puts a boom. */
export function wordAt(r: ResolvedShort, t: number): Anchor | null {
  let next: { s: string; w: number; start: number } | null = null;
  for (const s of r.sentences) {
    for (const [k, w] of s.words.entries()) {
      if (w.start <= t && t < w.end) return { word: { s: s.key, w: k } };
      if (w.start > t && (!next || w.start < next.start)) next = { s: s.key, w: k, start: w.start };
    }
  }
  return next ? { word: { s: next.s, w: next.w } } : null;
}

/** The line spoken at t (or the one after it), as scene id and line index: where S splits. */
export function lineAt(r: ResolvedShort, t: number): { scene: string; line: number } | null {
  const x = r.sentences.find((s) => t < s.end) ?? null;
  return x ? { scene: x.scene, line: x.line } : null;
}
