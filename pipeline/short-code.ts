/**
 * The code a Short types out: each code scene's files read (at their commit
 * through git, so what is on screen stays what it was whatever the checkout
 * moves on to), their line ranges joined by a blank line, cleaned for a
 * phone (Code Typer's cleanJava), checked by the privacy scan, and laid out
 * as a typing timeline the scene's length long. Cached per process by what
 * they are made from.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { CodeVisual, Short } from "../schema/short.ts";
import { buildTimeline, type Timeline } from "../src/core/short/code/timeline.ts";
import { cleanJava } from "../src/core/short/code/source.ts";
import { scan } from "./safety.ts";
import type { ResolvedShort } from "../src/core/short/resolve.ts";

export type SceneCode = { tl: Timeline; caption?: string; timer?: number };
const cache = new Map<string, SceneCode>();

const expand = (p: string, dir: string) => {
  const h = p.replace(/^~(?=\/)/, homedir());
  return isAbsolute(h) ? h : join(dir, h);
};

/** One file of a code scene as text: the commit's version when it names one, its ranges joined by a blank line. */
export function readCode(f: CodeVisual["files"][number], dir: string): { name: string; text: string } {
  const text = f.repo && f.ref
    ? execFileSync("git", ["-C", expand(f.repo, dir), "show", `${f.ref}:${f.path}`], { encoding: "utf8", maxBuffer: 1 << 26 })
    : readFileSync(expand(f.path, dir), "utf8");
  const all = text.split("\n");
  const picked = f.lines ? f.lines.map(([a, b]) => all.slice(a - 1, b).join("\n")).join("\n\n") : text;
  return { name: basename(f.path), text: cleanJava(picked) };
}

/** Each code scene's typing timeline; throws when a file cannot be read or the privacy scan finds something. */
export function sceneCode(dir: string, doc: Short, r: ResolvedShort): Record<string, SceneCode> {
  const out: Record<string, SceneCode> = {};
  for (const sc of doc.scenes) {
    const v = sc.visual;
    if (v?.type !== "code") continue;
    const seconds = r.scenes.find((x) => x.id === sc.id)?.seconds ?? sc.hold ?? 5;
    const key = JSON.stringify({ dir, files: v.files, seconds, seed: v.seed ?? 3, caption: v.caption, timer: v.timer });
    let hit = cache.get(key);
    if (!hit) {
      const files = v.files.map((f) => readCode(f, dir));
      const hits = files.flatMap((f) => scan(f.name, f.text));
      if (hits.length) throw new Error(`scene ${sc.id}: the privacy scan refused ${hits.map((h) => `${h.file}:${h.line} (${h.rule})`).join(", ")}`);
      // a timer target like "2:14:07" in seconds, for the speedrun's clock
      const timer = v.timer ? v.timer.split(":").map(Number).reduce((a, n) => a * 60 + n, 0) : undefined;
      hit = { tl: buildTimeline(files, seconds, v.seed ?? 3), ...(v.caption ? { caption: v.caption } : {}), ...(timer !== undefined && Number.isFinite(timer) ? { timer } : {}) };
      cache.set(key, hit);
    }
    out[sc.id] = hit;
  }
  return out;
}
