/**
 * Loudness: every chapter's voice levelled to the same loudness, and every
 * finished video mastered to the same loudness, so one video never needs the
 * volume button after another. Taken from Code Typer's devlog master.
 */
import { renameSync, rmSync } from "node:fs";
import { run, runChild } from "./proc.ts";

/** A chapter's voice, as the voice step makes it. */
export const VOICE_LUFS = -16;
/** The finished video: YouTube's loudness, which turns loud videos down but never quiet ones up. */
export const TARGET_LUFS = -14;
/** True peaks of the finished video stay under this, in dBTP. */
export const CEILING_DBTP = -1;
/** Part of the join's input hash: change it when the master changes, so videos are joined again. */
export const MASTER_VERSION = 1;

/**
 * Levels a voice WAV in place to VOICE_LUFS with true peaks under -1.5 dBTP
 * (ffmpeg loudnorm). The file keeps its length and rate and nothing moves in
 * time (checked sample for sample on a Kokoro chapter), so word times hold.
 */
export async function levelVoice(file: string, sr: number, signal?: AbortSignal) {
  const tmp = file.replace(/\.wav$/, ".level.part.wav");
  try {
    await run("ffmpeg", ["-loglevel", "error", "-y", "-i", file, "-af", `loudnorm=I=${VOICE_LUFS}:TP=-1.5:LRA=7`, "-ar", String(sr), "-c:a", "pcm_s16le", tmp], { signal });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type Loudness = { I: number; peak: number };

/** Integrated loudness (LUFS) and true peak (dBTP) of what `args` feed ffmpeg's EBU R128 meter. */
export async function measure(args: string[], signal?: AbortSignal): Promise<Loudness> {
  const r = await runChild("ffmpeg", ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], { signal });
  if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}: ${r.stderr.trim().split("\n").slice(-4).join("\n")}`);
  const summary = r.stderr.split("Summary:").pop() ?? "";
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
  if (!Number.isFinite(I) || !Number.isFinite(peak)) throw new Error("the loudness meter gave no reading");
  return { I, peak };
}

/**
 * A gentle compressor first: the voice arrives limited at -1.5 dBFS, about 15
 * dB over its average, so a gain to the target alone would leave a limiter
 * cutting a third of the loud moments.
 */
const COMPRESS = "acompressor=threshold=-22dB:ratio=2.5:attack=5:release=120:knee=4";

/**
 * Copies `input` (an MP4) to `output` with its audio mastered to TARGET_LUFS,
 * true peaks under CEILING_DBTP: compressor, gain, 17 kHz low-pass (AAC rings
 * over whatever a limiter cuts), limiter at 4x for peaks between samples. The
 * gain is found from measured encodes, since the limiter takes back part of
 * each step. The picture, metadata and chapters are copied. Throws when the
 * encoded file misses the target by more than 0.5 LU or peaks over the ceiling.
 */
export async function master(input: string, output: string, o: { signal?: AbortSignal; log?: (l: string) => void } = {}): Promise<Loudness & { gain: number }> {
  const before = await measure(["-i", input, "-af", `${COMPRESS},ebur128=peak=true`], o.signal);
  const tries: [number, number][] = [];
  let gain = TARGET_LUFS - before.I, limit = CEILING_DBTP - 1;
  let got = before;
  for (let pass = 0; pass < 5; pass++) {
    const chain = `${COMPRESS},volume=${gain.toFixed(2)}dB,lowpass=f=17000,aresample=192000,alimiter=limit=${(10 ** (limit / 20)).toFixed(4)}:level=0:attack=2:release=80,aresample=48000`;
    await run("ffmpeg", ["-loglevel", "error", "-y", "-i", input, "-map", "0:v", "-map", "0:a", "-map_metadata", "0", "-map_chapters", "0", "-af", chain, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output], { signal: o.signal });
    got = await measure(["-i", output, "-af", "ebur128=peak=true"], o.signal);
    if (Math.abs(got.I - TARGET_LUFS) <= 0.3 && got.peak <= CEILING_DBTP) break;
    tries.push([gain, got.I]);
    if (got.peak > CEILING_DBTP) limit -= got.peak - CEILING_DBTP + 0.2;
    // the next gain on the line through the last two tries, or a whole step after the first
    const [g1, i1] = tries.at(-2) ?? [gain - 1, got.I - 1];
    const slope = (got.I - i1) / (gain - g1);
    gain += (TARGET_LUFS - got.I) / (slope > 0.2 ? slope : 1);
  }
  o.log?.(`master: ${before.I.toFixed(1)} LUFS compressed, ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB → ${got.I.toFixed(1)} LUFS, true peak ${got.peak.toFixed(1)} dBTP`);
  if (Math.abs(got.I - TARGET_LUFS) > 0.5 || got.peak > CEILING_DBTP)
    throw new Error(`the master missed: ${got.I.toFixed(1)} LUFS, ${got.peak.toFixed(1)} dBTP (want ${TARGET_LUFS} LUFS, peaks under ${CEILING_DBTP} dBTP)`);
  return { ...got, gain };
}
