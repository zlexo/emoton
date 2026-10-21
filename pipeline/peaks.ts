/**
 * A sound file's waveform for the timeline: the loudest sample in each
 * 1/RATE of a second, 0 to 255, base64. A WAV is read directly, anything
 * else (a song) decoded by ffmpeg first. Cached beside the bundle's render
 * files and made again when the file changes.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "./proc.ts";
import { maybe, readJson, writeJson } from "./project.ts";
import { readWav } from "./wav.ts";

export const PEAK_RATE = 100;
export type Peaks = { rate: number; seconds: number; peaks: string };

export function peaksOf(audio: Float32Array, sr: number, rate = PEAK_RATE): Peaks {
  const step = sr / rate, n = Math.ceil(audio.length / step);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * step), end = Math.min(audio.length, Math.floor((i + 1) * step)); j < end; j++) m = Math.max(m, Math.abs(audio[j]!));
    out[i] = Math.min(255, Math.round(m * 255));
  }
  return { rate, seconds: audio.length / sr, peaks: Buffer.from(out).toString("base64") };
}

/** The file's peaks, from the cache in `cacheDir` when the file has not changed. */
export async function filePeaks(file: string, cacheDir: string, signal?: AbortSignal): Promise<Peaks> {
  const st = statSync(file);
  const cache = join(cacheDir, `peaks-${basename(file)}.json`);
  const hit = existsSync(cache) ? maybe(() => readJson<Peaks & { of: string }>(cache)) : undefined;
  const of = `${st.size}:${st.mtimeMs}`;
  if (hit?.of === of) return { rate: hit.rate, seconds: hit.seconds, peaks: hit.peaks };
  let p: Peaks;
  if (file.toLowerCase().endsWith(".wav")) {
    const w = readWav(file);
    p = peaksOf(w.audio, w.sr);
  } else {
    const tmp = mkdtempSync(join(tmpdir(), "emoton-peaks-"));
    try {
      const wav = join(tmp, "a.wav");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-ac", "1", "-ar", "8000", wav], { signal });
      const w = readWav(wav);
      p = peaksOf(w.audio, w.sr);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  writeJson(cache, { ...p, of });
  return p;
}
