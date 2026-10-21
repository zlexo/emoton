/** The Short composition's props, shared by the renderer, the preview and the CLI (no CSS imports here). */
import type { ResolvedShort } from "../../core/short/resolve.ts";
import type { Timeline } from "../../core/short/code/timeline.ts";

/**
 * Where the Short's files are: each value a URL (the preview's /media/...)
 * or a name in the renderer's public folder. `footage` is keyed by the scene
 * that owns the visual (a Perdix shot's render, a clip); `files` by bundle
 * path, for file sounds and card backgrounds.
 */
export type ShortMedia = {
  footage: Record<string, string>;
  voice?: string;
  /** The music as one file: a song, or the score rendered from the document. */
  music?: string;
  /** The built-in sound clips, keyed `${kind}:${take}`. */
  sounds?: Record<string, string>;
  files?: Record<string, string>;
  /** Each code scene's typing timeline (and caption, and a speedrun's timer target in seconds). */
  code?: Record<string, { tl: Timeline; caption?: string; timer?: number }>;
  /** Files for single sounds by their place in the resolved sfx list, over the clips (a code scene's typing follows its keystrokes). */
  sfx?: Record<number, string>;
};

export type ShortVideoProps = { short: ResolvedShort; media: ShortMedia };

/** Frames the composition lasts: its scenes back to back, as Code Typer's Montage sums them. */
export function shortFrames(s: ResolvedShort): number {
  const last = s.scenes[s.scenes.length - 1];
  const total = last ? last.from + last.seconds : s.duration;
  return Math.max(1, Math.ceil(total * s.canvas.fps));
}
