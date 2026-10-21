// Ported unchanged from Code Typer (src/timeline.ts there).
/**
 * The typing timeline: how N files of any size fit a fixed code burst.
 *
 * One rule replaces "typing modes": a file gets a keystroke budget (its time share x
 * MAX_KEYS_PER_SEC). If it has fewer characters than that, every key is one character
 * (real typing, with jitter and the odd typo). If it has more, each key reveals a chunk
 * cut at a whitespace boundary: a word per key reads as impossibly fast typing, a few
 * lines per key reads as the screen flying. Sound density never exceeds what a keyboard
 * can make, whatever the file size. Pure and seeded, so a job always renders the same.
 */

export type KeyKind = "key" | "space" | "enter" | "backspace";
export type KeyEvent = { t: number; kind: KeyKind };
/** Visible state from time t on: the first `len` chars, plus a wrong char if mid-typo. */
export type Step = { t: number; len: number; typo?: string };
export type FileTrack = { name: string; text: string; start: number; end: number; steps: Step[]; lineStarts: number[] };
export type Timeline = { duration: number; files: FileTrack[]; keys: KeyEvent[]; totalLines: number };

export const MAX_KEYS_PER_SEC = 22;
const MIN_FILE_SECONDS = 0.35;
/**
 * Each file finishes before its slot ends: a beat on the finished file before the next
 * tab opens. Fixed minimum so the beat survives short slots when a job has many files.
 */
const pauseFor = (slot: number) => Math.min(Math.max(slot * 0.08, 0.18), slot * 0.3);
const TYPO_RATE = 0.012;

/** mulberry32: tiny seeded PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Time per file ∝ size^0.6 (big files get more, small ones still get a beat), floored. */
export function shareTime(sizes: number[], seconds: number): number[] {
  const n = sizes.length;
  if (n * MIN_FILE_SECONDS >= seconds) return sizes.map(() => seconds / n);
  const w = sizes.map((s) => Math.pow(Math.max(1, s), 0.6));
  let fixed = new Set<number>();
  for (;;) {
    const free = seconds - fixed.size * MIN_FILE_SECONDS;
    const wSum = w.reduce((a, x, i) => (fixed.has(i) ? a : a + x), 0);
    const t = w.map((x, i) => (fixed.has(i) ? MIN_FILE_SECONDS : (free * x) / wSum));
    const under = t.findIndex((x, i) => !fixed.has(i) && x < MIN_FILE_SECONDS);
    if (under < 0) return t;
    fixed = new Set(fixed).add(under);
  }
}

/** Chunk ends for `n` keys over `text`: cut at the first whitespace at/after each even target. */
export function chunkEnds(text: string, n: number): number[] {
  const ends: number[] = [];
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    if (k === n) { ends.push(text.length); break; }
    let p = Math.max(prev + 1, Math.round((text.length * k) / n));
    while (p < text.length && !/\s/.test(text[p - 1]!)) p++;
    if (p >= text.length) { ends.push(text.length); break; }
    ends.push(p);
    prev = p;
  }
  return ends;
}

function kindFor(chunk: string): KeyKind {
  const last = chunk[chunk.length - 1];
  return last === "\n" ? "enter" : last === " " ? "space" : "key";
}

export function lineStartsOf(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") s.push(i + 1);
  return s;
}

export function buildTimeline(files: { name: string; text: string }[], seconds: number, seed = 1): Timeline {
  const rand = rng(seed);
  const shares = shareTime(files.map((f) => f.text.length), seconds);
  const keys: KeyEvent[] = [];
  const tracks: FileTrack[] = [];
  let start = 0;

  files.forEach((f, fi) => {
    const slot = shares[fi]!;
    const span = slot - pauseFor(slot);
    const n = Math.max(1, Math.min(f.text.length, Math.floor(slot * MAX_KEYS_PER_SEC)));
    const perChar = n === f.text.length;
    const ends = perChar ? Array.from({ length: n }, (_, i) => i + 1) : chunkEnds(f.text, n);

    // Interval weights: jitter, and in per-char mode a breath at line ends.
    const weights = ends.map((e, k) => {
      const chunk = f.text.slice(k ? ends[k - 1]! : 0, e);
      let w = 0.6 + rand() * 0.8;
      if (perChar && chunk.endsWith("\n")) w *= 2.6;
      return w;
    });
    const wSum = weights.reduce((a, b) => a + b, 0);

    const steps: Step[] = [];
    let t = start;
    ends.forEach((e, k) => {
      const d = (span * weights[k]!) / wSum;
      const chunk = f.text.slice(k ? ends[k - 1]! : 0, e);
      const before = e - chunk.length;
      if (perChar && /[a-z]/i.test(chunk) && rand() < TYPO_RATE) {
        // Wrong letter, backspace, right letter, inside the same interval.
        const wrong = String.fromCharCode(97 + Math.floor(rand() * 26));
        steps.push({ t, len: before, typo: wrong });
        keys.push({ t, kind: "key" });
        steps.push({ t: t + d / 3, len: before });
        keys.push({ t: t + d / 3, kind: "backspace" });
        steps.push({ t: t + (2 * d) / 3, len: e });
        keys.push({ t: t + (2 * d) / 3, kind: kindFor(chunk) });
      } else {
        steps.push({ t, len: e });
        keys.push({ t, kind: kindFor(chunk) });
      }
      t += d;
    });

    tracks.push({ name: f.name, text: f.text, start, end: start + slot, steps, lineStarts: lineStartsOf(f.text) });
    start += slot;
  });

  const totalLines = tracks.reduce((a, tr) => a + tr.lineStarts.length, 0);
  return { duration: seconds, files: tracks, keys, totalLines };
}

/** Index of the file on screen at time t (the last one stays up after the burst). */
export function fileAt(tl: Timeline, t: number): number {
  for (let i = 0; i < tl.files.length; i++) if (t < tl.files[i]!.end) return i;
  return tl.files.length - 1;
}

/** Visible state of a track at time t (binary search over steps). */
export function stateAt(tr: FileTrack, t: number): { len: number; typo?: string } {
  const s = tr.steps;
  if (!s.length || t < s[0]!.t) return { len: 0 };
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]!.t <= t) lo = mid; else hi = mid - 1;
  }
  return { len: s[lo]!.len, typo: s[lo]!.typo };
}

/** Cursor line/col for a char offset. */
export function cursorOf(tr: FileTrack, len: number): { line: number; col: number } {
  const ls = tr.lineStarts;
  let lo = 0, hi = ls.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ls[mid]! <= len) lo = mid; else hi = mid - 1;
  }
  return { line: lo, col: len - ls[lo]! };
}
