/**
 * The built-in sound effects, synthesized and seeded so a render repeats.
 * boom, ding, scratch, mash and riser are Code Typer's (src/audio.ts and
 * src/sfx.ts there), unchanged; pop, whoosh and keys are new. Keystrokes for
 * mash and keys come from recordings in the sound library's keys/ folder
 * (sliced at their onsets), else synthesized clicks.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Marker } from "../../schema/short.ts";

export const SR = 48000;

/** A seeded random source (mulberry32). */
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

/** Any audio file, mono at SR (ffmpeg). */
export function decode(file: string): Float32Array {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}

/** A typing recording split into single keystrokes at their onsets. */
export function sliceKeystrokes(buf: Float32Array): Float32Array[] {
  const win = Math.round(SR * 0.002);
  const env: number[] = [];
  for (let i = 0; i < buf.length; i += win) {
    let m = 0;
    for (let j = i; j < Math.min(buf.length, i + win); j++) m = Math.max(m, Math.abs(buf[j]!));
    env.push(m);
  }
  const sorted = [...env].sort((a, b) => a - b);
  const peak = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const floor = sorted[Math.floor(sorted.length * 0.3)] ?? 0;
  const hi = floor + (peak - floor) * 0.35, lo = floor + (peak - floor) * 0.12;
  const minGap = Math.round(0.04 / 0.002);
  const onsets: number[] = [];
  let armed = true, last = -minGap;
  env.forEach((e, k) => {
    if (armed && e >= hi && k - last >= minGap) (onsets.push(k), (last = k), (armed = false));
    else if (!armed && e < lo) armed = true;
  });
  const slices: Float32Array[] = [];
  onsets.forEach((k, idx) => {
    const a = Math.max(0, k * win - Math.round(SR * 0.003));
    const next = onsets[idx + 1];
    const b = Math.min(buf.length, a + Math.round(SR * 0.12), next !== undefined ? next * win - Math.round(SR * 0.002) : Infinity);
    if (b - a < SR * 0.02) return;
    const s = buf.slice(a, b);
    const fade = Math.min(s.length, Math.round(SR * 0.012));
    for (let i = 0; i < fade; i++) s[s.length - 1 - i]! *= i / fade;
    slices.push(s);
  });
  return slices;
}

/** Keystrokes from every recording in `dir` (a file over 0.4 s is sliced), none when there are none. */
export function loadKeySlices(dir: string | undefined): Float32Array[] {
  if (!dir) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.(wav|mp3|m4a|ogg|flac|aiff?)$/i.test(f)).sort();
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const buf = decode(join(dir, f));
    return buf.length > SR * 0.4 ? sliceKeystrokes(buf) : [buf];
  });
}

function synthKey(r: () => number, low: boolean): Float32Array {
  const n = Math.round(SR * 0.07);
  const s = new Float32Array(n);
  const f = low ? 140 : 190 + r() * 40;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lp += 0.35 * ((r() * 2 - 1) - lp);
    s[i] = lp * Math.exp(-t * 180) * 0.8 + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 60) * 0.5;
  }
  return s;
}

export function riser(seconds: number, r: () => number): Float32Array {
  const n = Math.round(SR * seconds);
  const s = new Float32Array(n);
  let ph = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    ph += (2 * Math.PI * (120 + 900 * x * x)) / SR;
    lp += (0.05 + 0.6 * x) * ((r() * 2 - 1) - lp);
    s[i] = (Math.sin(ph) * 0.25 + lp * 0.45) * x * x;
  }
  return s;
}

export function impact(r: () => number): Float32Array {
  const n = Math.round(SR * 1.2);
  const s = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lp += 0.2 * ((r() * 2 - 1) - lp);
    const boom = Math.sin(2 * Math.PI * (38 + 60 * Math.exp(-t * 12)) * t) * Math.exp(-t * 3.5);
    s[i] = boom * 0.9 + lp * Math.exp(-t * 14) * 0.6;
  }
  return s;
}

function ding(): Float32Array {
  const s = new Float32Array(Math.round(SR * 0.9));
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    s[i] = (Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-t * 5) + 0.45 * Math.sin(2 * Math.PI * 1320 * 2.76 * t) * Math.exp(-t * 11)) * Math.min(1, t / 0.002) * 0.5;
  }
  return s;
}

function scratch(r: () => number): Float32Array {
  const s = new Float32Array(Math.round(SR * 0.38));
  let lp = 0, prev = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    const stroke = Math.sin(2 * Math.PI * 5.5 * t);
    const cut = 0.05 + 0.35 * Math.abs(stroke);
    lp += cut * ((r() * 2 - 1) - lp);
    const band = lp - prev * 0.6;
    prev = lp;
    s[i] = band * (0.6 + 0.4 * stroke) * Math.min(1, t / 0.005) * Math.min(1, (0.38 - t) / 0.05) * 1.3;
  }
  return s;
}

/** How long the keyboard mash runs. */
export const MASH_SECONDS = 0.8;

function mash(slices: Float32Array[], r: () => number, seconds = MASH_SECONDS): Float32Array {
  const bank = slices.length ? slices : Array.from({ length: 8 }, (_, i) => synthKey(r, i % 3 === 0));
  const out = new Float32Array(Math.round(SR * seconds));
  for (let t = 0; t < seconds - 0.05; t += 0.012 + r() * 0.02) {
    const src = bank[Math.floor(r() * bank.length)]!, rate = 0.85 + r() * 0.55, gain = 0.6 + r() * 0.5;
    const o = Math.round(t * SR);
    for (let i = 0; i * rate < src.length - 1 && o + i < out.length; i++) {
      const p = i * rate, k = Math.floor(p), f = p - k;
      out[o + i]! += ((src[k] ?? 0) * (1 - f) + (src[k + 1] ?? 0) * f) * gain;
    }
  }
  let held = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % 3 === 0) held = Math.round(Math.tanh(out[i]! * 6) * 12) / 12;
    out[i] = held * Math.min(1, i / (SR * 0.004)) * Math.min(1, (out.length - i) / (SR * 0.03));
  }
  return out;
}

/** A short bubble pop: a sine that drops fast. */
function pop(): Float32Array {
  const s = new Float32Array(Math.round(SR * 0.12));
  let ph = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (900 * Math.exp(-t * 40) + 260)) / SR;
    s[i] = Math.sin(ph) * Math.exp(-t * 38) * Math.min(1, t / 0.001) * 0.8;
  }
  return s;
}

/** A whoosh: noise swept up and down through a band, swelling in the middle. */
function whoosh(r: () => number): Float32Array {
  const n = Math.round(SR * 0.55);
  const s = new Float32Array(n);
  let lp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const cut = 0.02 + 0.3 * Math.sin(Math.PI * x);
    lp += cut * ((r() * 2 - 1) - lp);
    s[i] = (lp - prev * 0.5) * Math.sin(Math.PI * x) ** 2 * 1.4;
    prev = lp;
  }
  return s;
}

/** A few seconds of typing, each press a random keystroke at a random pitch and gain. */
function keys(slices: Float32Array[], r: () => number, seconds = 1.6): Float32Array {
  const bank = slices.length ? slices : Array.from({ length: 8 }, (_, i) => synthKey(r, i % 3 === 0));
  const norm = bank.map((s) => {
    let m = 0;
    for (const x of s) m = Math.max(m, Math.abs(x));
    return m > 0 ? 0.3 / m : 1;
  });
  const out = new Float32Array(Math.round(SR * seconds));
  for (let t = 0.01; t < seconds - 0.12; t += 0.07 + r() * 0.09) {
    const i = Math.floor(r() * bank.length), rate = 0.93 + r() * 0.14, gain = norm[i]! * (0.75 + r() * 0.35);
    const src = bank[i]!, o = Math.round(t * SR);
    for (let j = 0; j * rate < src.length - 1 && o + j < out.length; j++) {
      const p = j * rate, k = Math.floor(p), f = p - k;
      out[o + j]! += ((src[k] ?? 0) * (1 - f) + (src[k + 1] ?? 0) * f) * gain;
    }
  }
  return out;
}

const KEY_KIND: Record<string, { rate: number; gain: number }> = {
  key: { rate: 1, gain: 1 }, space: { rate: 0.88, gain: 1.1 }, enter: { rate: 0.82, gain: 1.35 }, backspace: { rate: 1.06, gain: 0.95 },
};

/**
 * Typing that follows a code scene's own keystrokes (Code Typer's mixTrack, src/audio.ts there, without its riser
 * and impact, which are sounds of their own here): each press a random keystroke, never the same twice running,
 * at a random pitch and gain, soft-limited. `keys`: when each key goes down, from the scene's start.
 */
export function typing(keys: { t: number; kind: string }[], seconds: number, slices: Float32Array[], seed: number): Float32Array {
  const r = rng(seed ^ 0x5eed);
  const out = new Float32Array(Math.ceil(seconds * SR));
  const bank = slices.length ? slices : Array.from({ length: 8 }, (_, i) => synthKey(r, i % 3 === 0));
  const norm = bank.map((s) => {
    let m = 0;
    for (const x of s) m = Math.max(m, Math.abs(x));
    return m > 0 ? 0.3 / m : 1;
  });
  let prev = -1;
  for (const k of keys) {
    let i = Math.floor(r() * bank.length);
    if (bank.length > 1 && i === prev) i = (i + 1) % bank.length;
    prev = i;
    const kind = KEY_KIND[k.kind] ?? KEY_KIND.key!;
    const rate = kind.rate * (0.93 + r() * 0.14);
    const gain = kind.gain * norm[i]! * (0.75 + r() * 0.35);
    const src = bank[i]!, o = Math.round(k.t * SR);
    for (let j = 0; j * rate < src.length - 1; j++) {
      const p = j * rate, q = Math.floor(p), f = p - q, at = o + j;
      if (at >= 0 && at < out.length) out[at]! += ((src[q] ?? 0) * (1 - f) + (src[q + 1] ?? 0) * f) * gain;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]! * 1.1) * 0.9;
  return out;
}

/** Built-in sound `kind`, take `variant` (0 to SOUND_TAKES - 1, src/core/short/resolve.ts). `keyDir`: the sound library's keys/ folder. */
export function builtIn(kind: Marker, variant: number, keyDir?: string): Float32Array {
  const r = rng(0x5ff + variant * 7919 + kind.length * 31);
  switch (kind) {
    case "boom": return impact(r);
    case "impact": return impact(rng(0x1a7 + variant));
    case "ding": return ding();
    case "scratch": return scratch(r);
    case "mash": return mash(loadKeySlices(keyDir), r);
    case "keys": return keys(loadKeySlices(keyDir), r);
    case "pop": return pop();
    case "riser": return riser(1.4, r);
    case "whoosh": return whoosh(r);
  }
}
