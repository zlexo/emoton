/** Ported unchanged from Code Typer (src/beat.ts there). A placeholder edit beat, cut to a montage's timeline: a taste of the drop under the hook, a
    lighter build under the story with a whoosh on every cut, a riser and a beat of silence, then
    the drop on the reveal. Synthesized and seeded, so it is the same every render, in one of a few
    styles that share the arrangement. A real song replaces it through the job's music.file. */
import { impact, riser, SR } from "./synth.ts";

export const STYLES = ["trap", "phonk", "house", "chiptune"] as const;
export type Style = (typeof STYLES)[number];

export type BeatPlan = {
  bpm: number;
  /** Seconds, all on the montage's timeline. */
  total: number;
  hookEnd: number;
  drop: number;
  cuts: number[];
  seed?: number;
  style?: Style;
};

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const buf = (seconds: number) => new Float32Array(Math.max(1, Math.round(SR * seconds)));
const note = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/* ---------- instruments ---------- */

function kick(r: () => number, punch = 1): Float32Array {
  const s = buf(0.4);
  let ph = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (44 + 120 * Math.exp(-t * 28))) / SR;
    s[i] = Math.tanh(1.6 * punch * Math.sin(ph) * Math.exp(-t * 7)) + (r() * 2 - 1) * Math.exp(-t * 260) * 0.35;
  }
  return s;
}

function snare(r: () => number): Float32Array {
  const s = buf(0.3);
  let lp = 0, prev = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    lp += 0.45 * ((r() * 2 - 1) - lp);
    const hp = lp - prev;
    prev = lp;
    s[i] = (hp * 1.4 + lp * 0.5) * Math.exp(-t * 16) + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30) * 0.45;
  }
  return s;
}

/** Three quick noise bursts, high-passed: a clap. */
function clap(r: () => number): Float32Array {
  const s = buf(0.32);
  let lp = 0, prev = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    lp += 0.5 * ((r() * 2 - 1) - lp);
    const hp = lp - prev;
    prev = lp;
    const bursts = t < 0.03 ? Math.exp(-((t % 0.01) * 400)) : Math.exp(-(t - 0.03) * 14);
    s[i] = hp * 1.6 * bursts;
  }
  return s;
}

function hat(r: () => number, open: boolean): Float32Array {
  const s = buf(open ? 0.22 : 0.06);
  let a = 0, b = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    const n = r() * 2 - 1;
    const h1 = n - a; a = n;
    const h2 = h1 - b; b = h1; // twice high-passed: the hiss, not the rumble
    s[i] = h2 * 0.5 * Math.exp(-t * (open ? 18 : 90));
  }
  return s;
}

/** An 808-ish bass: a sine with a short glide down into the note, saturated by `drive`. */
function bass(freq: number, seconds: number, drive = 2.4): Float32Array {
  const s = buf(seconds);
  let ph = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * freq * (1 + 0.5 * Math.exp(-t * 40))) / SR;
    const env = Math.min(1, t / 0.005) * Math.min(1, (seconds - t) / 0.06);
    s[i] = Math.tanh(drive * Math.sin(ph)) * env * (0.55 * 2.4 / Math.max(2.4, drive * 0.9));
  }
  return s;
}

/** A plucked saw through a lowpass that closes as it decays; `bright` 0 to 1 opens it. */
function pluck(freq: number, seconds: number, bright: number): Float32Array {
  const s = buf(seconds);
  let ph = 0, lp = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    ph = (ph + freq / SR) % 1;
    lp += (0.02 + 0.3 * bright * Math.exp(-t * 9)) * ((ph * 2 - 1) - lp);
    s[i] = lp * Math.exp(-t * 7) * Math.min(1, t / 0.003) * 0.5;
  }
  return s;
}

/** The 808 cowbell: two square waves a fifth-ish apart, band-limited, ringing out. Pitched by `freq`. */
function cowbell(freq: number, seconds: number): Float32Array {
  const s = buf(seconds);
  let p1 = 0, p2 = 0, lp = 0, prev = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    p1 = (p1 + freq / SR) % 1;
    p2 = (p2 + (freq * 1.48) / SR) % 1;
    const sq = (p1 < 0.5 ? 1 : -1) + (p2 < 0.5 ? 1 : -1);
    lp += 0.35 * (sq - lp);
    const bp = lp - prev;
    prev = lp;
    s[i] = (bp * 0.6 + lp * 0.25) * (Math.exp(-t * 9) * 0.8 + Math.exp(-t * 40) * 0.4) * 0.5;
  }
  return s;
}

/** A detuned saw chord, low-passed: the house stab. */
function stab(midis: number[], seconds: number, bright: number): Float32Array {
  const s = buf(seconds);
  const ph = midis.flatMap(() => [0, 0]);
  let lp = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    let x = 0;
    midis.forEach((m, k) => {
      for (const [j, det] of [[0, 0.996], [1, 1.004]] as const) {
        ph[k * 2 + j] = (ph[k * 2 + j]! + (note(m) * det) / SR) % 1;
        x += ph[k * 2 + j]! * 2 - 1;
      }
    });
    lp += (0.04 + 0.25 * bright) * (x / (midis.length * 2) - lp);
    s[i] = lp * Math.exp(-t * 6) * Math.min(1, t / 0.004) * 0.9;
  }
  return s;
}

/** A pulse wave with a quarter duty cycle, the NES lead. */
function pulse(freq: number, seconds: number, duty = 0.25): Float32Array {
  const s = buf(seconds);
  let ph = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    ph = (ph + freq / SR) % 1;
    s[i] = (ph < duty ? 1 : -1) * 0.22 * Math.min(1, t / 0.002) * Math.min(1, (seconds - t) / 0.01);
  }
  return s;
}

/** A stepped triangle: the NES bass. */
function triangle(freq: number, seconds: number): Float32Array {
  const s = buf(seconds);
  let ph = 0;
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    ph = (ph + freq / SR) % 1;
    const tri = ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4;
    s[i] = (Math.round(tri * 7.5) / 7.5) * 0.5 * Math.min(1, (seconds - t) / 0.01);
  }
  return s;
}

/** 8-bit noise: held random steps at `rate` a second, decaying. Low rates thump, high ones hiss. */
function chipNoise(r: () => number, seconds: number, rate: number, decay: number): Float32Array {
  const s = buf(seconds);
  const hold = Math.max(1, Math.round(SR / rate));
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    if (i % hold === 0) v = r() < 0.5 ? 1 : -1;
    s[i] = v * Math.exp((-i / SR) * decay) * 0.35;
  }
  return s;
}

function whoosh(r: () => number): Float32Array {
  const s = buf(0.42);
  let lp = 0;
  for (let i = 0; i < s.length; i++) {
    const x = i / s.length;
    lp += (0.01 + 0.5 * x * x) * ((r() * 2 - 1) - lp);
    s[i] = lp * Math.sin(Math.PI * x) ** 2 * 0.9;
  }
  return s;
}

/* ---------- styles ---------- */

type Add = (src: Float32Array, at: number, gain: number) => void;
/** A style: what one bar of the drop and one bar of the build sound like, and its roll's hit. */
type Kit = {
  drop: (add: Add, at: number, bar: number, until: number) => void;
  build: (add: Add, at: number, bar: number, into: number, until: number) => void;
  roll: Float32Array;
};

// A minor, four bars round: Am F C G. Roots for the bass, chord tones for the rest.
const ROOTS = [33, 29, 36, 31];
const CHORDS = [[69, 72, 76, 81], [65, 69, 72, 77], [72, 76, 79, 84], [67, 71, 74, 79]];

function kitFor(style: Style, r: () => number, S: number): Kit {
  const B = 4 * S;
  const kickS = kick(r), snareS = snare(r), clapS = clap(r);
  const each = (at: number, until: number, steps: number[], fn: (t: number, i: number) => void) => {
    for (const i of steps) {
      const t = at + i * S;
      if (t < until) fn(t, i);
    }
  };
  const all16 = [...Array(16).keys()];
  switch (style) {
    case "trap":
      return {
        roll: snareS,
        drop: (add, at, k, until) => {
          const chord = CHORDS[k % 4]!, root = ROOTS[k % 4]!;
          each(at, until, all16, (t, i) => {
            if ([0, 6, 8, 11].includes(i)) add(kickS, t, 0.95);
            if (i === 4 || i === 12) add(snareS, t, 0.8);
            add(hat(r, i === 14), t, i % 4 === 2 ? 0.5 : 0.28 + r() * 0.1);
            if (i === 0 || i === 6 || i === 10) add(bass(note(root), Math.min(i === 0 ? 6 * S : 4 * S, until - t)), t, 0.9);
            add(pluck(note(chord[(i * 3) % 4]! + (i >= 8 ? 12 : 0)), 3 * S, 0.9), t, 0.32);
          });
        },
        build: (add, at, k, into, until) => {
          const chord = CHORDS[k % 4]!;
          each(at, until, [0, 2, 4, 6, 8, 10, 12, 14], (t, i) => {
            add(hat(r, false), t, 0.22 + 0.12 * into);
            if (i === 0 || i === 8) add(kickS, t, 0.5);
            if (i % 4 === 0) add(pluck(note(chord[(i / 4) % 4]!), 2 * B, 0.15 + 0.7 * into), t, 0.4);
          });
        },
      };
    case "phonk": {
      // the cowbell riff, in semitones over A: the drift-phonk shape, a bar long
      const RIFF = [12, null, 12, 10, null, 12, 7, null, 12, null, 15, 12, 10, null, 7, 5];
      return {
        roll: clapS,
        drop: (add, at, k, until) => {
          const root = ROOTS[k % 4]!;
          each(at, until, all16, (t, i) => {
            if ([0, 3, 8, 10].includes(i)) add(kickS, t, 0.9);
            if (i === 4 || i === 12) add(clapS, t, 0.75);
            add(hat(r, false), t + (i % 2 ? 0.018 : 0), i % 2 ? 0.2 : 0.32); // swung
            const n = RIFF[i];
            if (n !== null && n !== undefined) add(cowbell(note(57 + n), 2 * S), t, 0.55);
            if (i === 0 || i === 10) add(bass(note(root), Math.min(i === 0 ? 8 * S : 6 * S, until - t), 4.5), t, 0.8);
          });
        },
        build: (add, at, _k, into, until) => {
          each(at, until, all16, (t, i) => {
            const n = RIFF[i];
            if (n !== null && n !== undefined) add(cowbell(note(57 + n), 2 * S), t, 0.15 + 0.25 * into);
            if (i % 4 === 0) add(hat(r, false), t, 0.18 + 0.1 * into);
            if (i === 0) add(kickS, t, 0.45);
          });
        },
      };
    }
    case "house":
      return {
        roll: clapS,
        drop: (add, at, k, until) => {
          const chord = CHORDS[k % 4]!, root = ROOTS[k % 4]!;
          each(at, until, all16, (t, i) => {
            if (i % 4 === 0) add(kickS, t, 0.95);
            if (i === 4 || i === 12) add(clapS, t, 0.6);
            if (i % 4 === 2) add(hat(r, true), t, 0.32);
            else add(hat(r, false), t, 0.12);
            // the stab and the bass on the off-beat, where the kick's ducking lets them breathe
            if (i % 4 === 2) add(stab(chord.slice(0, 3), 2 * S, 0.8), t, 0.5);
            if (i % 4 === 2) add(bass(note(root + 12), Math.min(1.6 * S, until - t), 1.4), t, 0.7);
          });
        },
        build: (add, at, k, into, until) => {
          const chord = CHORDS[k % 4]!;
          each(at, until, all16, (t, i) => {
            if (i % 4 === 0) add(kickS, t, 0.35 + 0.35 * into);
            if (i % 4 === 2) add(stab(chord.slice(0, 3), 2 * S, 0.1 + 0.6 * into), t, 0.35);
            if (i % 2 === 0) add(hat(r, false), t, 0.1 + 0.08 * into);
          });
        },
      };
    case "chiptune":
      return {
        roll: chipNoise(r, 0.12, 9000, 30),
        drop: (add, at, k, until) => {
          const chord = CHORDS[k % 4]!, root = ROOTS[k % 4]!;
          each(at, until, all16, (t, i) => {
            if (i === 0 || i === 8 || i === 10) add(chipNoise(r, 0.15, 900, 25), t, 0.9); // the noise channel's kick
            if (i === 4 || i === 12) add(chipNoise(r, 0.18, 7000, 18), t, 0.7);         // and its snare
            if (i % 2 === 1) add(chipNoise(r, 0.03, 14000, 120), t, 0.3);
            add(pulse(note(chord[i % 4]! + 12), S * 0.9, 0.125), t, 0.5);                  // the fast arpeggio
            if (i % 2 === 0) add(triangle(note(root + 12 + (i % 4 === 2 ? 12 : 0)), S * 1.8), t, 0.7);
            if (i === 0) add(pulse(note(chord[0]! + 24), Math.min(B * 2, until - t), 0.5), t, 0.25);
          });
        },
        build: (add, at, k, into, until) => {
          const chord = CHORDS[k % 4]!;
          each(at, until, all16, (t, i) => {
            if (i % 2 === 0) add(pulse(note(chord[(i / 2) % 4]! + 12), S * 1.6, 0.25), t, 0.18 + 0.25 * into);
            if (i % 4 === 2) add(chipNoise(r, 0.03, 14000, 120), t, 0.15 + 0.15 * into);
          });
        },
      };
  }
}

export function beat(plan: BeatPlan): Float32Array {
  const r = mulberry(plan.seed ?? 7);
  const out = buf(plan.total);
  const add: Add = (src, at, gain) => {
    const o = Math.round(at * SR);
    for (let i = 0; i < src.length; i++) {
      const j = o + i;
      if (j >= 0 && j < out.length) out[j]! += src[i]! * gain;
    }
  };
  const B = 60 / plan.bpm;
  const S = B / 4;
  const kit = kitFor(plan.style ?? "trap", r, S);
  const gapAt = plan.drop - B / 2; // half a beat of silence before the drop

  // the hook: a taste of the drop
  for (let at = 0, k = 0; at < plan.hookEnd - 1e-6; at += 16 * S, k++) kit.drop(add, at, k, plan.hookEnd);
  // the build, opening up toward the drop
  for (let at = plan.hookEnd, k = 0; at < gapAt - 1e-6; at += 16 * S, k++) {
    kit.build(add, at, k, (at - plan.hookEnd) / Math.max(0.001, gapAt - plan.hookEnd), gapAt);
  }
  // the last bar before the drop: a roll that speeds up, under a riser
  const rollFrom = gapAt - 4 * B;
  for (let t = rollFrom, step = 2 * S; t < gapAt - 1e-6; t += step) {
    const into = (t - rollFrom) / (gapAt - rollFrom);
    add(kit.roll, t, 0.25 + 0.45 * into);
    step = into > 0.5 ? S / 2 : S;
  }
  add(riser(gapAt - rollFrom, r), rollFrom, 0.9);
  // silence before the drop, then the drop
  out.fill(0, Math.round(gapAt * SR), Math.round(plan.drop * SR));
  add(impact(r), plan.drop, 0.85);
  for (let at = plan.drop, k = 0; at < plan.total - 1e-6; at += 16 * S, k++) kit.drop(add, at, k, plan.total);
  // a whoosh on every cut but the drop's
  for (const c of plan.cuts) if (Math.abs(c - plan.drop) > 0.01 && c > 0) add(whoosh(r), c - 0.28, 0.5);

  // soft clip, fade the last half second, then peak at -1 dBFS
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const fade = Math.min(1, (out.length - i) / (SR * 0.5));
    out[i] = Math.tanh(1.3 * out[i]!) * fade;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i]! *= g;
  return out;
}
