import type { Tts } from "../../pipeline/voice.ts";
import { writeWav } from "../../pipeline/wav.ts";

/** A voice that says each line in a second, in silence, timed by letters (no word times). */
const SR = 24000;
/** The lines each call was asked to say, by voice part. */
export const ttsCalls: string[][][] = [];
export const quietTts: Tts = async (job) => {
  ttsCalls.push(job.beats.map((b) => b.say));
  let t = job.gaps.leadIn;
  const beats = job.beats.map((b, i) => {
    if (i) t += job.gaps.beat;
    const start = t;
    const sentences = b.say.map((text, k) => {
      if (k) t += job.gaps.sentence;
      const s = { start: t, end: t + 1, text };
      t += 1;
      return s;
    });
    return { start, end: t, sentences };
  });
  const duration = t + job.gaps.tail;
  writeWav(job.out, { sr: SR, audio: new Float32Array(Math.round(duration * SR)) });
  return JSON.stringify({ leadIn: job.gaps.leadIn, duration, beats, stats: { synthesised: 1, cached: 0 } });
};
