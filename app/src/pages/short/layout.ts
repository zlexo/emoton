/**
 * The timeline's model, from a resolved Short: which items sit on which
 * track, from when to when, and what selecting one points at. Pure, so the
 * timeline, the inspector and the tests share it.
 */
import type { ResolvedShort } from "../../../../src/core/short/resolve.ts";

export const TRACKS = ["scenes", "text", "captions", "voice", "fx", "sfx", "music"] as const;
export type Track = (typeof TRACKS)[number];
export const TRACK_LABEL: Record<Track, string> = { scenes: "Scenes", text: "Text", captions: "Captions", voice: "Voice", fx: "FX", sfx: "Sounds", music: "Music" };

export type Selection =
  | { kind: "scene"; id: string }
  | { kind: "text"; i: number }
  | { kind: "caption"; i: number }
  | { kind: "sentence"; key: string }
  | { kind: "fx"; i: number }
  | { kind: "sfx"; i: number }
  | { kind: "music" };

export type Item = { key: string; track: Track; start: number; end: number; label: string; sel: Selection; point?: boolean };

/** How long a point event (an effect, a sound) shows on its track, in seconds. */
const POINT = 0.18;

export function timelineItems(s: ResolvedShort): Item[] {
  const items: Item[] = [];
  for (const sc of s.scenes) {
    const kind = sc.visual.type === "shot" ? sc.visual.kind : sc.visual.type;
    items.push({ key: `scene:${sc.id}`, track: "scenes", start: sc.from, end: sc.from + sc.seconds, label: `${sc.id} · ${kind}`, sel: { kind: "scene", id: sc.id } });
  }
  s.text.forEach((t, i) => items.push({ key: `text:${i}`, track: "text", start: t.from, end: t.to, label: t.sub ? `${t.text} · ${t.sub}` : t.text, sel: { kind: "text", i } }));
  s.captions.forEach((c, i) => items.push({ key: `caption:${i}`, track: "captions", start: c.from, end: c.to, label: c.text, sel: { kind: "caption", i } }));
  for (const x of s.sentences) items.push({ key: `sentence:${x.key}`, track: "voice", start: x.start, end: x.end, label: x.text, sel: { kind: "sentence", key: x.key } });
  s.fx.forEach((f, i) => items.push({ key: `fx:${i}`, track: "fx", start: f.at, end: f.at + (f.dur ?? POINT), label: f.kind, sel: { kind: "fx", i }, point: f.dur === undefined }));
  s.sfx.forEach((x, i) => items.push({ key: `sfx:${i}`, track: "sfx", start: x.at, end: x.at + POINT, label: x.kind, sel: { kind: "sfx", i }, point: true }));
  if (s.music) items.push({ key: "music", track: "music", start: 0, end: s.duration, label: "file" in s.music.source ? s.music.source.file.asset.split("/").pop()! : `Score · ${s.music.source.synth.style}, ${s.music.source.synth.bpm} BPM`, sel: { kind: "music" } });
  return items;
}

export const sameSelection = (a: Selection | null, b: Selection | null) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/** Ruler ticks: a round step that leaves at least `minPx` between labels. */
export function rulerTicks(duration: number, pxPerSecond: number, minPx = 64): { step: number; ticks: number[] } {
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * pxPerSecond >= minPx) ?? 60;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += step) ticks.push(+t.toFixed(3));
  return { step, ticks };
}

/** Beat lines on the timeline, from the music's grid (none without one). */
export function beatLines(s: ResolvedShort): number[] {
  const g = s.music?.grid;
  if (!g) return [];
  const beat = 60 / g.bpm, out: number[] = [];
  for (let t = g.first + Math.ceil(-g.first / beat) * beat; t <= s.duration; t += beat) out.push(+t.toFixed(3));
  return out;
}

/** Where the selection is on the timeline, to seek to when it is picked. */
export function selectionTime(s: ResolvedShort, sel: Selection): number | null {
  switch (sel.kind) {
    case "scene": return s.scenes.find((x) => x.id === sel.id)?.from ?? null;
    case "text": return s.text[sel.i]?.from ?? null;
    case "caption": return s.captions[sel.i]?.from ?? null;
    case "sentence": return s.sentences.find((x) => x.key === sel.key)?.start ?? null;
    case "fx": return s.fx[sel.i]?.at ?? null;
    case "sfx": return s.sfx[sel.i]?.at ?? null;
    case "music": return null;
  }
}

export const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
