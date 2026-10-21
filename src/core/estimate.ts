import type { Chapter, ChapterTiming, Layout } from "../../schema/storyboard.ts";

/** The same gaps the voice stage uses, so previews and final renders pace alike. */
export const GAPS = { leadIn: 1.8, sentence: 0.3, beat: 0.65, aha: 1.4, tail: 1.2 };

/**
 * A slides video teaches at a calmer pace: time to read the point and look at
 * the panel before the narrator moves on, a longer pause before a new slide,
 * and the chapter's last slide (its takeaway) held briefly at the end. The hold
 * was 3.5 s; with the next chapter's lead-in that left over 5 s of silence at
 * every chapter break, which played as dead air.
 */
export const SLIDE_GAPS = { leadIn: 1.8, sentence: 0.55, beat: 1.4, aha: 2.4, tail: 1.5, slide: 2.4 };

export type Gaps = typeof GAPS;

export const gapsFor = (layout: Layout | undefined): Gaps => {
  if (layout !== "slides") return GAPS;
  const { slide: _slide, ...g } = SLIDE_GAPS;
  return g;
};

/** The pause after each beat: the aha pause, a new-slide pause before a beat that starts a slide (slides layout), else the beat pause. */
export function beatPauses(ch: Chapter, layout: Layout | undefined): number[] {
  const slides = layout === "slides";
  const g = slides ? SLIDE_GAPS : GAPS;
  return ch.beats.map((b, i) => {
    const next = ch.beats[i + 1];
    const base = b.aha ? g.aha : g.beat;
    return slides && next?.slide ? Math.max(base, SLIDE_GAPS.slide) : base;
  });
}

/** Timings from word counts (about 2.6 words per second), for silent previews. */
export function estimateTiming(ch: Chapter, wps = 2.6, layout?: Layout): ChapterTiming {
  const G = gapsFor(layout);
  const pauses = beatPauses(ch, layout);
  let t = G.leadIn;
  const beats = ch.beats.map((b, bi) => {
    const start = t;
    const sentences = b.say.map((text, k) => {
      const s = t;
      t += Math.max(1.2, text.split(/\s+/).length / wps);
      const out = { start: s, end: t, text };
      if (k < b.say.length - 1) t += G.sentence;
      return out;
    });
    const end = t;
    t += pauses[bi]!;
    return { start, end, sentences };
  });
  return { leadIn: G.leadIn, duration: t + G.tail, audio: "", beats };
}
