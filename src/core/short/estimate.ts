/** A silent stand-in for a Short's voice, so it previews (and edits) before it is voiced. Pure: the server and the editor share it. */
import type { Short } from "../../../schema/short.ts";
import { parseLine, type VoiceTiming } from "./resolve.ts";

/** Code Typer's devlog gaps (DEFAULT_GAPS there), for a Short whose voice names none. */
export const SHORT_GAPS = { leadIn: 0.6, sentence: 0.35, beat: 0.75, aha: 1.0, tail: 3.2 };

/** What the voice stage speaks: each spoken scene's lines, markers taken out. */
export const spokenScenes = (doc: Short): string[][] => doc.scenes.filter((s) => s.say).map((s) => s.say!.map((l) => parseLine(l).text));

/** Timing from word counts (about 2.6 words a second), with the Short's gaps. */
export function estimatedVoice(doc: Short, wps = 2.6): VoiceTiming {
  const g = doc.voice?.gaps ?? SHORT_GAPS;
  let t = g.leadIn;
  const beats = spokenScenes(doc).map((lines, b, all) => {
    const start = t;
    const sentences = lines.map((text, k) => {
      const s = t;
      t += Math.max(0.5, text.split(/\s+/).length / wps);
      const out = { start: s, end: t, text };
      if (k < lines.length - 1) t += g.sentence;
      return out;
    });
    const end = t;
    if (b < all.length - 1) t += g.beat;
    return { start, end, sentences };
  });
  return { duration: t + g.tail, beats };
}

/** True when the timing was voiced from exactly the document's spoken lines. */
export function voiceMatches(doc: Short, voice: VoiceTiming): boolean {
  const want = spokenScenes(doc);
  return voice.beats.length === want.length && voice.beats.every((b, i) => b.sentences.length === want[i]!.length && b.sentences.every((s, k) => s.text.toLowerCase().replace(/\s+/g, " ").trim() === want[i]![k]!.toLowerCase().replace(/\s+/g, " ").trim()));
}
