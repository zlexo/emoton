/**
 * Footage proxies: what the editor's player plays instead of the full file.
 * 540x960 H.264 with a keyframe every 6 frames, so scrubbing seeks at once
 * on an 8 GB Mac; no sound. proxies/<path> mirrors the footage's bundle path,
 * and a proxy older than its footage is made again. Exports read the
 * originals.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Short } from "../schema/short.ts";
import { run } from "./proc.ts";

export const proxyRel = (rel: string) => `proxies/${rel}`;

/** Every footage file the document plays, bundle-relative: each Perdix shot's render and each clip. */
export function footageFiles(doc: Short): string[] {
  const out = new Set<string>();
  for (const s of doc.scenes) {
    if (s.visual?.type === "shot") out.add(`shots/${s.id}.mp4`);
    else if (s.visual?.type === "clip") out.add(s.visual.asset);
  }
  return [...out];
}

const mtime = (f: string) => statSync(f).mtimeMs;

/** True when the footage is on disk and its proxy is missing or older than it. */
export function needsProxy(dir: string, rel: string): boolean {
  const src = join(dir, rel), p = join(dir, proxyRel(rel));
  if (!existsSync(src)) return false;
  return !existsSync(p) || mtime(p) < mtime(src);
}

/** The proxy when it is fresh, else the footage itself. */
export const playable = (dir: string, rel: string) => (existsSync(join(dir, proxyRel(rel))) && !needsProxy(dir, rel) ? proxyRel(rel) : rel);

export async function makeProxy(dir: string, rel: string, signal?: AbortSignal) {
  const out = join(dir, proxyRel(rel));
  const part = out.replace(/\.[^./]+$/, ".part.mp4");
  mkdirSync(dirname(out), { recursive: true });
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, rel),
      "-vf", "scale=540:960:force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "6", "-keyint_min", "6", "-sc_threshold", "0",
      "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", part,
    ], { signal });
    renameSync(part, out);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}
