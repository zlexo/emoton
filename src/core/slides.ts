/**
 * The slides layout's timeline, as pure functions of a chapter. A slide spans
 * consecutive beats, from a beat with `slide` to the next one. Inside it, the
 * panel shows one visual at a time: a piece. A beat with `full` is a piece of
 * its own that fills the screen. A beat without a visual keeps showing the
 * visual before it.
 */
import type { Beat, BeatTiming, Chapter, ChapterTiming, Slide, Visual } from "../../schema/storyboard.ts";

export type SlideSpan = { slide: Slide; first: number; last: number };

/** The chapter's slides in order. Beats before the first `slide` (not allowed by the cross-check) join the first. */
export function slideSpans(ch: Chapter): SlideSpan[] {
  const spans: SlideSpan[] = [];
  ch.beats.forEach((b, i) => {
    if (b.slide || spans.length === 0) spans.push({ slide: b.slide ?? { title: ch.title }, first: i, last: i });
    else spans[spans.length - 1]!.last = i;
  });
  return spans;
}

export type Piece = {
  kind: "panel" | "full";
  /** Index into slideSpans. */
  span: number;
  /** Beats this piece is on screen for, first to last. */
  first: number;
  last: number;
  /** The beats whose visuals it draws, in order (a diagram that continues has several). */
  visuals: number[];
};

const continues = (v: Visual | undefined) => v?.type === "diagram" && !!v.continue;

/**
 * Splits the chapter into pieces: a new piece starts at a new slide, when the
 * full flag changes, and at a visual that does not continue the one before.
 */
export function pieces(ch: Chapter): Piece[] {
  const spans = slideSpans(ch);
  const spanOf = (i: number) => spans.findIndex((s) => i >= s.first && i <= s.last);
  const out: Piece[] = [];
  let lastVisual = -1;
  ch.beats.forEach((b, i) => {
    const kind = b.full ? "full" : "panel";
    const span = spanOf(i);
    const cur = out[out.length - 1];
    const joins = cur && cur.span === span && cur.kind === kind && (!b.visual || continues(b.visual));
    if (joins) {
      cur.last = i;
      if (b.visual) cur.visuals.push(i);
    } else {
      // a beat without a visual (after a new slide or a full beat) shows the last visual there was
      out.push({ kind, span, first: i, last: i, visuals: b.visual ? [i] : lastVisual >= 0 ? [lastVisual] : [] });
    }
    // a title or bullets visual is only ever full screen: a later point-only beat must not pull it into the panel
    if (b.visual && b.visual.type !== "title" && b.visual.type !== "bullets") lastVisual = i;
  });
  return out;
}

/**
 * A beat that shows its point first: the point appears as the narrator states
 * it in the first sentence, and the panel's visual starts on the second, so the
 * viewer reads before the picture moves.
 */
export const pointFirst = (b: Beat) => !!b.point && !!b.visual && !b.full && b.say.length >= 2;

/** The beat's timing as its visual sees it: from the second sentence on for a point-first beat. */
export function visualTiming(b: Beat, bt: BeatTiming): BeatTiming {
  if (!pointFirst(b) || bt.sentences.length < 2) return bt;
  const sentences = bt.sentences.slice(1);
  return { start: sentences[0]!.start, end: bt.end, sentences };
}

export type Window = { start: number; end: number };

/**
 * When each slide and each piece is on screen. A slide runs from just before
 * its first beat to the next slide; a piece from just before its visual starts
 * (the second sentence of a point-first beat) to the next piece, within its slide.
 */
export function timeline(ch: Chapter, timing: ChapterTiming): { spans: Window[]; pieces: Window[] } {
  const sp = slideSpans(ch), ps = pieces(ch);
  const beatStart = (i: number) => timing.beats[i]!.start - 0.25;
  const spanStart = sp.map((s) => beatStart(s.first));
  const spans = sp.map((_, s) => ({ start: spanStart[s]!, end: spanStart[s + 1] ?? timing.duration }));
  const pieceStart = ps.map((p) => {
    const b = ch.beats[p.first]!;
    const own = p.kind === "panel" && p.visuals[0] === p.first ? visualTiming(b, timing.beats[p.first]!).start - 0.25 : beatStart(p.first);
    return Math.max(spans[p.span]!.start, own);
  });
  return { spans, pieces: ps.map((p, k) => ({ start: pieceStart[k]!, end: Math.min(pieceStart[k + 1] ?? timing.duration, spans[p.span]!.end) })) };
}

/** Slides before chapter n (1-based) across the storyboard, so chapter n's first slide is this + 1. */
export function slidesBefore(chapters: (Chapter | null)[], n: number): number {
  return chapters.slice(0, n - 1).reduce((k, c) => k + (c ? slideSpans(c).length : 0), 0);
}

export function slideTotal(chapters: (Chapter | null)[]): number {
  return slidesBefore(chapters, chapters.length + 1);
}

/** Text with KaTeX between $...$, split into runs ("\$" is a literal dollar). */
export function mathRuns(s: string): { tex: boolean; text: string }[] {
  const runs: { tex: boolean; text: string }[] = [];
  let buf = "", tex = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "$") {
      buf += "$";
      i++;
    } else if (c === "$") {
      if (buf) runs.push({ tex, text: buf });
      buf = "";
      tex = !tex;
    } else buf += c;
  }
  if (buf) runs.push({ tex, text: buf });
  return runs;
}
