import type { BeatTiming } from "../../schema/storyboard.ts";

/**
 * When does reveal item k of a beat appear? Item k fires at the start of
 * sentence k. Items past the last sentence share the last sentence evenly,
 * so a 6-step diagram under 3 sentences still builds in order.
 */
export function revealTimes(itemCount: number, beat: BeatTiming): number[] {
  const s = beat.sentences;
  if (itemCount <= 0) return [];
  if (s.length === 0) return Array.from({ length: itemCount }, () => beat.start);
  const out: number[] = [];
  const direct = Math.min(itemCount, s.length - 1);
  for (let k = 0; k < direct; k++) out.push(s[k]!.start);
  const last = s[s.length - 1]!;
  const rest = itemCount - direct;
  const span = Math.max(0, last.end - last.start);
  for (let j = 0; j < rest; j++) out.push(last.start + (j * span) / rest);
  return out;
}

/** Index of the last time in `times` that is <= t, or -1. */
export function stepAt(times: number[], t: number): number {
  let k = -1;
  for (let i = 0; i < times.length; i++) if (times[i]! <= t + 1e-6) k = i;
  return k;
}
