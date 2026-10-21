/**
 * A chapter's voice down to the word, and pause edits on it. The voice step
 * (tts/speak.py) reports each sentence's words with their start and end; an
 * edit adds or takes away silence after a word, or after a sentence, and
 * everything later moves with it: the audio, the words, the sentences, and so
 * the reveals and captions timed from them. Ported from Code Typer's voice
 * editor (src/voice.ts there), where it was made for the Perdix devlogs.
 */
import type { BeatTiming, SentenceTiming, WordTiming } from "../schema/storyboard.ts";
import { estimateWords, keySentences } from "../src/core/words.ts";

export { estimateWords };

export type Word = WordTiming;
export type Sentence = SentenceTiming;
export type Beat = BeatTiming;
/** The part of a ChapterTiming this works on; any other fields are carried through. */
export type Timing = { duration: number; beats: Beat[] };

/** Pause edits, in milliseconds added (negative takes away), saved beside a job as <job>.voice.json.
    Keyed by the sentence's text (see sentenceKey), so they survive re-voicing and moved chapters;
    `words[k]` is the pause after word k, `after` the pause after the sentence. */
export type PauseEdits = { version: 1; sentences: Record<string, { words?: Record<string, number>; after?: number }> };

export const noEdits = (): PauseEdits => ({ version: 1, sentences: {} });

/** A sentence's key: its text, lowercased with its spacing tidied; a repeat of the same text gets
    "#2", "#3" in the order it is spoken. */
export function sentenceKeys(timing: Timing): string[][] {
  const flat = keySentences(timing.beats.flatMap((b) => b.sentences.map((s) => s.text)));
  let k = 0;
  return timing.beats.map((b) => b.sentences.map(() => flat[k++]!));
}

/** Every sentence with words: the voice step's, or estimated. */
export function withWords<T extends Timing>(timing: T): T {
  return { ...timing, beats: timing.beats.map((b) => ({ ...b, sentences: b.sentences.map((s) => (s.words?.length ? s : { ...s, words: estimateWords(s), estimated: true })) })) };
}

type Cut = { at: number; samples: number }; // at a sample of the original; samples > 0 inserts silence, < 0 removes

const GUARD = 0.01; // seconds of the natural pause always kept on each side of a cut that takes silence away
const FADE = 0.003; // seconds faded out and in around an inserted pause, so a cut through sound does not click
const REACH = 0.08; // seconds either side of a guessed word boundary searched for its quietest point

/** The quietest 10 ms in [a, b) seconds, as a sample index; `a` itself when the span is shorter. */
function quietest(audio: Float32Array, sr: number, a: number, b: number): number {
  const i0 = Math.max(0, Math.round(a * sr)), i1 = Math.min(audio.length, Math.round(b * sr));
  const win = Math.round(0.01 * sr);
  if (i1 - i0 <= win) return i0;
  let best = i0 + (win >> 1), bestE = Infinity;
  for (let i = i0; i + win <= i1; i += Math.max(1, win >> 2)) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += audio[j]! * audio[j]!;
    if (e < bestE) { bestE = e; best = i + (win >> 1); }
  }
  return best;
}

/** Applies `edits` to the voice: the audio with each pause lengthened or shortened, the timing with
    every later time moved by as much. A pause is only ever shortened down to GUARD of its natural
    silence on each side, never into a word. Returns what it applied and the edits whose sentence is
    gone from the script. */
export function applyPauses<T extends Timing>(audio: Float32Array, sr: number, timing: T, edits: PauseEdits): { audio: Float32Array; timing: T; applied: number; dropped: string[] } {
  const keys = sentenceKeys(timing);
  const cuts: Cut[] = [];
  const used = new Set<string>();
  const sentences = timing.beats.flatMap((b) => b.sentences);
  const flatKeys = keys.flat();
  sentences.forEach((s, i) => {
    // own keys only: a sentence reading "constructor" must not find Object's
    const edit = Object.hasOwn(edits.sentences, flatKeys[i]!) ? edits.sentences[flatKeys[i]!] : undefined;
    if (!edit) return;
    used.add(flatKeys[i]!);
    const words = s.words?.length ? s.words : estimateWords(s);
    // a sentence timed by letters (a voice with no word times) has guessed boundaries: a pause added
    // there goes to the quietest point within REACH of the guess, a real gap between words, and none
    // is taken away, since where the pause is is not known
    const guessed = !!s.estimated || !s.words?.length;
    for (const [k, ms] of Object.entries(edit.words ?? {})) {
      const w = words[Number(k)], next = words[Number(k) + 1];
      if (!w || !next || !ms || (guessed && ms < 0)) continue;
      cuts.push(guessed
        ? cutBetween(audio, sr, Math.max(s.start, w.end - REACH), Math.min(s.end, next.start + REACH), ms / 1000)
        : cutBetween(audio, sr, w.end, next.start, ms / 1000));
    }
    if (edit.after) {
      const next = sentences[i + 1];
      cuts.push(cutBetween(audio, sr, s.end, next ? next.start : timing.duration, edit.after / 1000));
    }
  });
  const order = cuts.filter((c) => c.samples !== 0).sort((a, b) => a.at - b.at);

  // the audio, rebuilt cut by cut; a short fade either side of each cut, applied after, so a cut
  // through sound does not click (in silence it changes nothing)
  const out = new Float32Array(audio.length + order.reduce((n, c) => n + c.samples, 0));
  const joins: number[] = [];
  let from = 0, o = 0;
  for (const c of order) {
    out.set(audio.subarray(from, c.at), o);
    o += c.at - from;
    joins.push(o);
    if (c.samples > 0) {
      o += c.samples; // zeros
      joins.push(o);
      from = c.at;
    } else {
      from = c.at - c.samples; // the removed silence is skipped
    }
  }
  out.set(audio.subarray(from), o);
  const fade = Math.round(FADE * sr);
  for (let k = 0; k < joins.length; k++) {
    const j0 = joins[k]!;
    for (let j = 1; j <= fade && j0 - j >= 0; j++) out[j0 - j]! *= (j - 1) / fade;
    for (let j = 0; j < fade && j0 + j < out.length; j++) out[j0 + j]! *= j / fade;
  }

  // every time moved by the cuts before it. A start at a cut moves past inserted silence and an end
  // at a cut stays before it, so words that ran together are pulled apart by exactly the pause; a
  // time inside removed silence lands on its cut.
  const move = (t: number, isStart: boolean) => {
    // compared as whole samples: a word's time falls between samples, its cut on one, and a word
    // ending at a cut must stay on its side of it
    const i = Math.round(t * sr);
    let shift = 0;
    for (const c of order) {
      if (isStart ? c.at > i : c.at >= i) break;
      if (c.samples < 0 && i < c.at - c.samples) return (c.at + shift) / sr;
      shift += c.samples;
    }
    return t + shift / sr;
  };
  const moved: T = {
    ...timing,
    duration: out.length / sr,
    beats: timing.beats.map((b) => ({
      start: move(b.start, true), end: move(b.end, false),
      sentences: b.sentences.map((s) => ({ ...s, start: move(s.start, true), end: move(s.end, false), words: s.words?.map((w) => ({ ...w, start: move(w.start, true), end: move(w.end, false) })) })),
    })),
  };
  const dropped = Object.keys(edits.sentences).filter((k) => !used.has(k));
  return { audio: out, timing: moved, applied: order.length, dropped };
}

/** A cut in the pause between `a` and `b` seconds: silence inserted at its quietest point, or taken
    away from around it, never more than the pause has beyond GUARD on each side. */
function cutBetween(audio: Float32Array, sr: number, a: number, b: number, seconds: number): Cut {
  const at = quietest(audio, sr, a, Math.max(a, b));
  if (seconds > 0) return { at, samples: Math.round(seconds * sr) };
  const room = Math.max(0, Math.round((b - a - 2 * GUARD) * sr));
  const take = Math.min(room, Math.round(-seconds * sr));
  const start = Math.max(Math.round((a + GUARD) * sr), Math.min(at - (take >> 1), Math.round((b - GUARD) * sr) - take));
  return { at: start, samples: -take };
}
