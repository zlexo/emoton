/** A sentence's words in time: the voice step's own, or split by letters. Pure, shared by the renderer and the voice editor. */
import type { SentenceTiming, WordTiming } from "../../schema/storyboard.ts";

/** Words timed by their letters, for a sentence the voice step could not time. */
export function estimateWords(s: Pick<SentenceTiming, "start" | "end" | "text">): WordTiming[] {
  const texts = s.text.split(/\s+/).filter(Boolean);
  const letters = texts.reduce((n, w) => n + w.length, 0) || 1;
  let t = s.start;
  return texts.map((text) => {
    const len = ((s.end - s.start) * text.length) / letters;
    const w = { text, start: t, end: t + len };
    t += len;
    return w;
  });
}

/** The sentence's words: its own when the voice timed them, else estimated. */
export const wordsOf = (s: SentenceTiming): WordTiming[] => (s.words?.length ? s.words : estimateWords(s));

/**
 * The word being spoken at `t`: the last word that has started, so the
 * highlight stays on a word through the short pause after it; -1 before the
 * first word.
 */
export function spokenWord(words: WordTiming[], t: number): number {
  let k = -1;
  for (let i = 0; i < words.length && words[i]!.start <= t; i++) k = i;
  return k;
}

/**
 * Each sentence's key, in the order spoken: its text lowercased with its
 * spacing tidied, a repeat of the same text getting "#2", "#3". Pause edits
 * and a Short's word anchors both name sentences this way, so they survive a
 * re-voice and a moved scene.
 */
export function keySentences(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = text.toLowerCase().replace(/\s+/g, " ").trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}
