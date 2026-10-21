/**
 * What an edit cuts to: a song's tempo, its first beat and its drop, and how
 * much moves in each clip second by second. The analysis is plain signal
 * work on audio and tiny grey frames decoded by ffmpeg; results are cached
 * per file (path, size and time) under the bundle's render/analysis/.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readJson, writeJson } from "./project.ts";
import { run } from "./proc.ts";
import { readWav } from "./wav.ts";

export type SongAnalysis = { bpm: number; firstBeat: number; dropAt: number; seconds: number };
export type ClipMotion = { fps: number; seconds: number; motion: number[] };

const SR = 11025, HOP = 256;

/** Energy per hop of a signal (sum of squares over the hop). */
function hopEnergy(x: Float32Array): Float64Array {
  const n = Math.floor(x.length / HOP), e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * HOP; k < (i + 1) * HOP; k++) s += x[k]! * x[k]!;
    e[i] = s;
  }
  return e;
}

/** A one-pole low-pass at `hz`: the bass of the signal. */
function lowpass(x: Float32Array, hz: number, sr: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * hz) / sr), y = new Float32Array(x.length);
  let p = 0;
  for (let i = 0; i < x.length; i++) y[i] = p = (1 - a) * x[i]! + a * p;
  // twice, for a steeper slope
  p = 0;
  for (let i = 0; i < y.length; i++) y[i] = p = (1 - a) * y[i]! + a * p;
  return y;
}

/** How sharply energy rises at each hop (full band plus the bass), half-wave rectified. */
function onsets(full: Float64Array, bass: Float64Array): Float64Array {
  const o = new Float64Array(full.length);
  for (let i = 1; i < full.length; i++) {
    const f = Math.log(1e-9 + full[i]!) - Math.log(1e-9 + full[i - 1]!);
    const b = Math.log(1e-9 + bass[i]!) - Math.log(1e-9 + bass[i - 1]!);
    o[i] = Math.max(0, f) + Math.max(0, b);
  }
  return o;
}

const at = (xs: Float64Array, i: number) => {
  const k = Math.floor(i), f = i - k;
  return k < 0 || k + 1 >= xs.length ? 0 : xs[k]! * (1 - f) + xs[k + 1]! * f;
};
const mean = (xs: Float64Array, from: number, to: number) => {
  const a = Math.max(0, Math.floor(from)), b = Math.min(xs.length, Math.floor(to));
  let s = 0;
  for (let i = a; i < b; i++) s += xs[i]!;
  return b > a ? s / (b - a) : 0;
};

/** Tempo, first beat and drop of a mono signal at `sr`. */
export function analyzeAudio(audio: Float32Array, sr: number): SongAnalysis {
  if (sr !== SR) throw new Error(`analyzeAudio expects ${SR} Hz`);
  const seconds = audio.length / sr, fr = sr / HOP;
  const full = hopEnergy(audio), bass = hopEnergy(lowpass(audio, 150, sr));
  const o = onsets(full, bass);
  const avg = mean(o, 0, o.length);
  for (let i = 0; i < o.length; i++) o[i] = Math.max(0, o[i]! - avg);

  // tempo candidates: the autocorrelation's strongest peaks over 60 to 200 BPM, with their doubles and halves
  const r = (lag: number) => {
    let s = 0;
    const k = Math.floor(lag);
    for (let i = 0; i + k + 1 < o.length; i++) s += o[i]! * at(o, i + lag);
    return s;
  };
  const scan: { bpm: number; v: number }[] = [];
  for (let b = 60; b <= 200; b += 0.5) scan.push({ bpm: b, v: r((fr * 60) / b) });
  const peaks: { bpm: number; v: number }[] = [];
  for (const x of scan.filter((x, i) => i > 0 && i < scan.length - 1 && x.v >= scan[i - 1]!.v && x.v >= scan[i + 1]!.v).sort((a, b) => b.v - a.v)) {
    if (peaks.length < 6 && !peaks.some((p) => Math.abs(p.bpm - x.bpm) < p.bpm * 0.04)) peaks.push(x);
  }
  const candidates = new Set<number>();
  for (const p of peaks) for (const m of [0.5, 1, 2]) if (p.bpm * m >= 60 && p.bpm * m <= 200) candidates.add(Math.round(p.bpm * m * 2) / 2);

  // each candidate refined to the tempo and phase whose beat grid stands out most (the mean onset on it), leaning
  // toward 120 BPM; a 1 BPM error drifts a third of a second over a song, so the grid pins the tempo down
  const sm = new Float64Array(o.length);
  for (let i = 1; i + 1 < o.length; i++) sm[i] = 0.25 * o[i - 1]! + 0.5 * o[i]! + 0.25 * o[i + 1]!;
  const prior = (b: number) => Math.exp(-0.5 * (Math.log2(b / 120) / 0.8) ** 2);
  let bpm = 120, bestPhase = 0, best = -Infinity;
  for (const c of candidates) {
    // the scan's peak can sit a few BPM off at this resolution: refine within 3% of it
    for (let b = c * 0.97; b <= c * 1.03; b += 0.05) {
      const period = 60 / b;
      for (let ph = 0; ph < period; ph += 0.005) {
        let s = 0, n = 0;
        for (let t = ph; t < seconds; t += period) (s += at(sm, t * fr)), n++;
        const score = (s / Math.max(1, n)) * prior(b);
        if (score > best) [best, bpm, bestPhase] = [score, b, ph];
      }
    }
  }
  bpm = Math.abs(bpm - Math.round(bpm)) < 0.15 ? Math.round(bpm) : Math.round(bpm * 20) / 20;
  const period = 60 / bpm;

  // drop: the beat where the mix jumps the most over the next two bars against the two before (bass counted
  // double), and that a dip just before sets off (the half-beat gap or filtered bar many songs drop out of);
  // between 15% and 85% of the song
  let dropAt = bestPhase, jump = -Infinity;
  const ratio = (xs: Float64Array, a0: number, a1: number, b0: number, b1: number) => Math.log((1e-9 + mean(xs, a0 * fr, a1 * fr)) / (1e-9 + mean(xs, b0 * fr, b1 * fr)));
  for (let t = bestPhase + 4 * period; t < seconds * 0.85; t += period) {
    if (t < seconds * 0.15) continue;
    const span = Math.min(8 * period, t - bestPhase, seconds - t);
    const score = ratio(bass, t, t + span, t - span, t) + 0.5 * ratio(full, t, t + span, t - span, t) + 0.5 * ratio(full, t, t + 2 * period, t - period / 2, t);
    if (score > jump) [jump, dropAt] = [score, t];
  }
  return { bpm, firstBeat: +bestPhase.toFixed(3), dropAt: +dropAt.toFixed(3), seconds: +seconds.toFixed(3) };
}

/** Motion per frame: the mean absolute change of tiny grey frames. */
export function motionOf(frames: Uint8Array, w: number, h: number): number[] {
  const size = w * h, n = Math.floor(frames.length / size), out = [0];
  for (let f = 1; f < n; f++) {
    let s = 0;
    for (let i = 0; i < size; i++) s += Math.abs(frames[f * size + i]! - frames[(f - 1) * size + i]!);
    out.push(s / size);
  }
  return out;
}

/** Where a stretch of `len` seconds moves the most (its start, in seconds). */
export function liveliest(m: ClipMotion, len: number, not: number[] = []): number {
  const span = Math.max(1, Math.round(len * m.fps));
  if (m.motion.length <= span) return 0;
  let best = -1, from = 0;
  for (let i = 0; i + span <= m.motion.length; i++) {
    const t = i / m.fps;
    if (not.some((x) => Math.abs(x - t) < len)) continue;
    let s = 0;
    for (let k = i; k < i + span; k++) s += m.motion[k]!;
    if (s > best) [best, from] = [s, t];
  }
  return +from.toFixed(3);
}

const cacheFile = (dir: string, file: string, what: string) => {
  const st = statSync(file);
  return join(dir, "render", "analysis", `${basename(file)}.${what}.${st.size}-${Math.round(st.mtimeMs)}.json`);
};

async function cached<T>(dir: string, file: string, what: string, make: () => Promise<T>): Promise<T> {
  const f = cacheFile(dir, file, what);
  if (existsSync(f)) return readJson<T>(f);
  const out = await make();
  mkdirSync(join(dir, "render", "analysis"), { recursive: true });
  writeJson(f, out);
  return out;
}

export function analyzeSong(dir: string, file: string, signal?: AbortSignal): Promise<SongAnalysis> {
  return cached(dir, file, "beats", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "emoton-beats-"));
    try {
      const wav = join(tmp, "song.wav");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-ac", "1", "-ar", String(SR), "-c:a", "pcm_f32le", wav], { signal });
      const { audio, sr } = readWav(wav);
      return analyzeAudio(audio, sr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

const MW = 48, MH = 84, MFPS = 8;
export function clipMotion(dir: string, file: string, signal?: AbortSignal): Promise<ClipMotion> {
  return cached(dir, file, "motion", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "emoton-motion-"));
    try {
      const raw = join(tmp, "frames.raw");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-an", "-vf", `fps=${MFPS},scale=${MW}:${MH}:flags=area,format=gray`, "-f", "rawvideo", raw], { signal });
      const motion = motionOf(new Uint8Array(readFileSync(raw)), MW, MH);
      return { fps: MFPS, seconds: +(motion.length / MFPS).toFixed(3), motion: motion.map((x) => +x.toFixed(2)) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
