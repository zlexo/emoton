import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Chapter, ChapterTiming } from "../schema/storyboard.ts";
import { beatPauses, gapsFor, type Gaps } from "../src/core/estimate.ts";
import { levelVoice } from "./loudness.ts";
import { run, type ChildOptions } from "./proc.ts";
import { ROOT, paths, readJson, writeJson, type Project } from "./project.ts";
import { applyChapterEdits } from "./voice-edits.ts";

export type TtsJob = {
  engine: "kokoro" | "say"; voice: string; speed: number;
  gaps: Gaps; cacheDir: string; out: string; pronounce: Record<string, string>;
  /** after: the pause after the beat in seconds (speak.py falls back to the aha or beat gap). */
  beats: { say: string[]; aha: boolean; after?: number }[];
};

/** Runs speak.py (or a fake in tests). Returns its stdout (the timings JSON). */
export type Tts = (job: TtsJob, o: Pick<ChildOptions, "signal" | "onStderrLine">) => Promise<string>;

/** The voice step's sample rate (tts/speak.py SR). */
export const VOICE_SR = 24000;

/** speak.py, then the voice levelled to VOICE_LUFS, so every chapter plays at the same loudness. */
export const speakPy: Tts = async (job, o) => {
  const py = join(ROOT, "tts", ".venv", "bin", "python");
  if (!existsSync(py)) throw new Error("the voice engine is not set up (run `cd tts && uv sync`)");
  const out = await run(py, [join(ROOT, "tts", "speak.py")], { ...o, input: JSON.stringify(job) });
  await levelVoice(job.out, VOICE_SR, o.signal);
  return out;
};

export type VoiceOptions = {
  signal?: AbortSignal;
  /** Brief pronounce already merged over the global list. */
  pronounce: Record<string, string>;
  onProgress?: (done: number, total: number) => void;
  log?: (line: string) => void;
  tts?: Tts;
};

/** Voices one chapter (audio/chN.spoken.wav and its timing), then applies the chapter's pause edits (audio/chN.wav and its timing). */
export async function voiceChapter(dir: string, n: number, p: Project, ch: Chapter, o: VoiceOptions): Promise<ChapterTiming> {
  const P = paths(dir);
  const part = P.audio(n).replace(/\.wav$/, ".part.wav");
  const pauses = beatPauses(ch, p.layout);
  const job: TtsJob = {
    engine: p.voice.engine, voice: p.voice.voice, speed: p.voice.speed,
    gaps: gapsFor(p.layout), cacheDir: P.ttsCache, out: part, pronounce: o.pronounce,
    beats: ch.beats.map((b, i) => ({ say: b.say, aha: b.aha ?? false, ...(p.layout === "slides" ? { after: pauses[i] } : {}) })),
  };
  mkdirSync(dirname(part), { recursive: true });
  let out: string;
  try {
    out = await (o.tts ?? speakPy)(job, {
      signal: o.signal,
      onStderrLine: (line) => {
        const m = /^progress (\d+) (\d+)$/.exec(line.trim());
        if (m) o.onProgress?.(Number(m[1]), Number(m[2]));
        else if (line.trim()) o.log?.(line);
      },
    });
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const r = JSON.parse(out) as ChapterTiming & { stats: { synthesised: number; cached: number } };
  renameSync(part, P.spokenAudio(n));
  writeJson(P.spokenTiming(n), { leadIn: r.leadIn, duration: r.duration, audio: P.spokenAudioRel(n), beats: r.beats } satisfies ChapterTiming);
  const e = applyChapterEdits(dir, n);
  const timing = readJson<ChapterTiming>(P.timing(n));
  o.log?.(`voice ch${n}: ${r.duration.toFixed(1)} s, ${r.stats.synthesised} sentences synthesised, ${r.stats.cached} cached`);
  if (e.applied) o.log?.(`voice ch${n}: ${e.applied} pause edit(s) applied, ${timing.duration.toFixed(1)} s`);
  if (e.dropped.length) o.log?.(`voice ch${n}: ${e.dropped.length} pause edit(s) for sentences no longer in the chapter`);
  return timing;
}
