/** Ported unchanged from Code Typer (src/score.ts there). The devlog's score: a slow, warm, "motivational" bed under a voiceover. I V vi IV in C, layered up
    at the timeline's lifts (pad, then piano and bass, then strings and soft drums, then everything for
    the climax), ducked under every spoken sentence. Synthesized and seeded, so a render repeats. */
import { SR } from "./synth.ts";

export type ScorePlan = {
  bpm: number;
  total: number;
  /** Seconds where the score adds a layer: [piano + bass, strings + drums, climax]. */
  lifts: [number, number, number];
  /** Spoken intervals, in seconds: the score sinks under each one. */
  speech: [number, number][];
  /** The score's level under speech, against 1 in the gaps. */
  duck?: number;
  /** Pauses shorter than this many seconds stay ducked. */
  hold?: number;
  seed?: number;
};

const note = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
// C G Am F, a bar each: the chord tones, and the bass root
const CHORDS = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];
const ROOTS = [36, 31, 33, 29];

export function score(plan: ScorePlan): Float32Array {
  let seed = plan.seed ?? 11;
  const r = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const n = Math.round(SR * plan.total);
  const out = new Float32Array(n);
  const beat = 60 / plan.bpm, bar = 4 * beat;
  const [lift1, lift2, climax] = plan.lifts;
  const level = (t: number) => (t >= climax ? 3 : t >= lift2 ? 2 : t >= lift1 ? 1 : 0);
  const add = (at: number, len: number, voice: (t: number) => number, gain: number) => {
    const o = Math.round(at * SR);
    for (let i = 0; i < Math.round(len * SR); i++) {
      const j = o + i;
      if (j >= 0 && j < n) out[j]! += voice(i / SR) * gain;
    }
  };

  for (let at = 0, k = 0; at < plan.total; at += bar, k++) {
    const chord = CHORDS[k % 4]!, root = ROOTS[k % 4]!, lv = level(at);
    // the pad: three detuned saws a note, slow in and out, opening as the score lifts
    for (const m of chord) {
      const f = note(m), cut = 0.012 + 0.012 * lv;
      let lp = 0;
      const ph = [r(), r(), r()];
      add(at, bar + 0.8, (t) => {
        let x = 0;
        [0.995, 1, 1.006].forEach((d, i) => { ph[i] = (ph[i]! + (f * d) / SR) % 1; x += ph[i]! * 2 - 1; });
        lp += cut * (x / 3 - lp);
        const env = Math.min(1, t / 0.7) * Math.min(1, Math.max(0, (bar + 0.8 - t) / 0.8));
        return lp * env;
      }, 0.5);
    }
    // the piano: a soft bell-like tone on the eighths, chord tones climbing
    if (lv >= 1) {
      for (let e = 0; e < 8; e++) {
        const m = chord[e % 3]! + 12 + (e >= 4 ? 12 : 0) * (lv >= 3 ? 1 : 0);
        const f = note(m);
        add(at + e * (beat / 2), 1.6, (t) => {
          const a = Math.min(1, t / 0.004) * Math.exp(-t * 3.2);
          return a * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t * 6) + 0.12 * Math.sin(6 * Math.PI * f * t) * Math.exp(-t * 9));
        }, lv >= 3 ? 0.16 : 0.12);
      }
      // the bass: the root, held
      const fb = note(root);
      add(at, bar, (t) => Math.sin(2 * Math.PI * fb * t) * Math.min(1, t / 0.02) * Math.min(1, (bar - t) / 0.1), 0.32);
    }
    // the strings: the chord an octave up with a slow vibrato, swelling in
    if (lv >= 2) {
      for (const m of chord) {
        const f = note(m + 12);
        let ph = r();
        add(at, bar + 0.6, (t) => {
          ph = (ph + (f * (1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t))) / SR) % 1;
          const tri = ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4;
          return tri * Math.min(1, t / 1.2) * Math.min(1, Math.max(0, (bar + 0.6 - t) / 0.6));
        }, lv >= 3 ? 0.11 : 0.07);
      }
    }
    // soft drums: a felt kick on 1 and 3, a brushed clap on 2 and 4; eighth hats at the climax
    if (lv >= 2) {
      for (let b = 0; b < 4; b++) {
        const t0 = at + b * beat;
        if (b % 2 === 0) add(t0, 0.35, (t) => Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9), 0.5);
        else {
          let lp = 0;
          add(t0, 0.25, (t) => { lp += 0.3 * ((r() * 2 - 1) - lp); return lp * Math.exp(-t * 18); }, 0.35);
        }
        if (lv >= 3) {
          for (const h of [0, 0.5]) {
            let a = 0, b2 = 0;
            add(t0 + h * beat, 0.05, (t) => { const x = r() * 2 - 1; const h1 = x - a; a = x; const h2 = h1 - b2; b2 = h1; return h2 * Math.exp(-t * 90); }, 0.12);
          }
        }
      }
    }
  }

  // duck under speech: a gain that sinks to `duck` while the voice talks, easing in and out. Pauses
  // shorter than `hold` seconds stay ducked, so the score does not swell between two sentences.
  const duck = plan.duck ?? 0.3;
  const gain = new Float32Array(n).fill(1);
  const spans: [number, number][] = [];
  for (const [s, e] of [...plan.speech].sort((a, b) => a[0] - b[0])) {
    const last = spans[spans.length - 1];
    if (last && s - last[1] < (plan.hold ?? 1.0)) last[1] = Math.max(last[1], e);
    else spans.push([s, e]);
  }
  for (const [s, e] of spans) {
    for (let i = Math.max(0, Math.round((s - 0.15) * SR)); i < Math.min(n, Math.round((e + 0.25) * SR)); i++) gain[i] = duck;
  }
  let g = 1;
  const k = 1 - Math.exp(-1 / (0.08 * SR)); // about 80 ms either way
  let peak = 0;
  for (let i = 0; i < n; i++) {
    g += (gain[i]! - g) * k;
    const fade = Math.min(1, i / (SR * 1.5), (n - i) / (SR * 2.5));
    out[i] = Math.tanh(1.1 * out[i]!) * g * fade;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) out[i]! *= norm;
  return out;
}
