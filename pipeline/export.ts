/** The six export formats of the concept's export table. */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ExportFormat } from "../shared/api.ts";
import type { Chapter, ChapterTiming } from "../schema/storyboard.ts";
import { run, throwIfAborted } from "./proc.ts";
import { isFile, loadProject, loadStoryboard, maybe, paths, readJson } from "./project.ts";
import { effective, ownStatuses, snapshot } from "./state.ts";
import { renderedDuration } from "./render.ts";
import { slidesPdf } from "./slides-pdf.ts";

export const EXPORT_NAMES: Record<ExportFormat, (t: string) => string> = {
  mp4: (t) => `${t}.mp4`,
  "mp4-720": (t) => `${t} (720p).mp4`,
  m4a: (t) => `${t}.m4a`,
  srt: (t) => `${t}.srt`,
  md: (t) => `${t}.md`,
  bundle: (t) => `${t}.emoton.zip`,
  "slides-pdf": (t) => `${t} (slides).pdf`,
};

/** "notes:p6" -> "Notes p.6" (the same label the video shows). */
export function citeLabel(id: string, sources: Record<string, string>) {
  const [src, page] = id.split(":");
  const name = sources[src ?? ""] ?? src;
  return page ? `${name} ${page.replace(/^p/, "p.")}` : name ?? id;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function srtTime(t: number) {
  const ms = Math.max(0, Math.round(t * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}
const clock = (t: number) => `${Math.floor(t / 60)}:${pad(Math.floor(t % 60))}`;

type Loaded = { title: string; chapters: Chapter[]; timings: (ChapterTiming | undefined)[]; sources: Record<string, string> };

function load(dir: string): Loaded {
  const P = paths(dir), p = loadProject(dir);
  const sb = isFile(P.storyboard) ? loadStoryboard(dir) : { title: p.title, chapters: [] };
  const chapters = sb.chapters.filter((c): c is Chapter => !!c);
  if (chapters.length !== sb.chapters.length || !chapters.length) throw new Error(`"${p.title}" has no complete storyboard yet`);
  const timings = chapters.map((_, i) => (isFile(P.timing(i + 1)) ? maybe(() => readJson<ChapterTiming>(P.timing(i + 1))) : undefined));
  return { title: p.title, chapters, timings, sources: Object.fromEntries(p.sources.map((s) => [s.id, s.title])) };
}

/** SRT, one cue per sentence, times across the joined video. */
export function toSrt(v: Loaded): string {
  if (v.timings.some((t) => !t)) throw new Error(`"${v.title}" is not fully voiced yet (captions need the voice timings)`);
  const cues: string[] = [];
  let offset = 0;
  v.timings.forEach((t) => {
    for (const b of t!.beats) for (const s of b.sentences) cues.push(`${cues.length + 1}\n${srtTime(offset + s.start)} --> ${srtTime(offset + s.end)}\n${s.text}\n`);
    offset += renderedDuration(t!.duration);
  });
  return cues.join("\n");
}

/** Markdown transcript: chapters (with start times when `timed`), narration, [Notes p.6] citations. */
export function toMarkdown(v: Loaded, timed = v.timings.every((t) => t)): string {
  const out = [`# ${v.title}`, ""];
  let offset = 0;
  v.chapters.forEach((c, i) => {
    out.push(`## ${i + 1}. ${c.title}${timed ? ` (${clock(offset)})` : ""}`, "");
    for (const b of c.beats) {
      const cites = (b.cite ?? []).map((id) => citeLabel(id, v.sources));
      out.push(b.say.join(" ") + (cites.length ? ` [${cites.join("; ")}]` : ""), "");
    }
    if (timed) offset += renderedDuration(v.timings[i]!.duration);
  });
  const src = Object.entries(v.sources);
  if (src.length) out.push("## Sources", "", ...src.map(([id, t]) => `- ${t} (${id})`), "");
  return out.join("\n");
}

export type ExportCtx = {
  signal?: AbortSignal;
  log?: (l: string) => void;
  progress?: (p: number, detail?: string) => void;
  /** The library's global pronunciation list (part of the voice inputs, so of "is it up to date"). */
  globalPronounce?: Record<string, string>;
};

/** True when the joined video matches the current script, voice and renders (join ok). */
export const finished = (dir: string, globalPronounce: Record<string, string> = {}) =>
  effective(ownStatuses(snapshot(dir, globalPronounce))).join === "ok";

/**
 * What a video lacks for these formats, or null when it can export them all.
 * mp4, mp4-720, m4a and srt need a finished video (join ok), so the files match
 * what the viewer watches. md needs only a complete storyboard: it has chapter
 * start times when the video is finished, and none otherwise.
 */
export function missingFor(dir: string, formats: ExportFormat[], globalPronounce: Record<string, string> = {}): string | null {
  const title = maybe(() => loadProject(dir).title) ?? basename(dir);
  if (formats.some((f) => f === "mp4" || f === "mp4-720" || f === "m4a" || f === "srt") && !finished(dir, globalPronounce)) {
    return isFile(paths(dir).final) ? `"${title}" has changes that are not in its video yet: make it first` : `"${title}" has no finished video yet`;
  }
  if (formats.includes("md")) {
    try {
      load(dir);
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (formats.includes("slides-pdf") && maybe(() => loadProject(dir).layout) !== "slides") return `"${title}" is not a slides video, so it has no Slides PDF`;
  return null;
}

/** Writes one video's formats into destDir. Returns the files written. */
export async function exportOne(dir: string, formats: ExportFormat[], destDir: string, ctx: ExportCtx = {}): Promise<string[]> {
  const P = paths(dir);
  const title = loadProject(dir).title;
  const safe = safeName(title);
  mkdirSync(destDir, { recursive: true });
  const written: string[] = [];
  for (const [k, f] of formats.entries()) {
    throwIfAborted(ctx.signal);
    ctx.progress?.(k / formats.length, `${title}: ${f}`);
    const name = unique(destDir, EXPORT_NAMES[f](safe));
    const out = join(destDir, name);
    const part = join(destDir, `.${name}.part${extname(name) === ".zip" ? ".zip" : extname(name)}`);
    try {
      switch (f) {
        case "mp4":
          copyFileSync(P.final, part);
          break;
        case "mp4-720":
          await run("ffmpeg", ["-loglevel", "error", "-y", "-i", P.final, "-map", "0:v", "-map", "0:a", "-map_metadata", "0", "-map_chapters", "0", "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "copy", "-movflags", "+faststart", part], { signal: ctx.signal });
          break;
        case "m4a":
          await run("ffmpeg", ["-loglevel", "error", "-y", "-i", P.final, "-vn", "-map_metadata", "0", "-map_chapters", "0", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "ipod", part], { signal: ctx.signal });
          break;
        case "srt":
          writeFileSync(part, toSrt(load(dir)));
          break;
        case "md":
          writeFileSync(part, toMarkdown(load(dir), finished(dir, ctx.globalPronounce)));
          break;
        case "slides-pdf":
          copyFileSync(await slidesPdf(dir, { signal: ctx.signal, log: ctx.log, globalPronounce: ctx.globalPronounce }), part);
          break;
        case "bundle": {
          const b = basename(dir);
          await run("zip", ["-r", "-q", "-X", part, b, "-x", `${b}/audio/cache/*`, "-x", "*.part.*", "-x", "*/.DS_Store"], { cwd: dirname(dir), signal: ctx.signal });
          break;
        }
      }
      throwIfAborted(ctx.signal);
      renameSync(part, out);
      written.push(out);
      ctx.log?.(`export: ${out}`);
    } finally {
      rmSync(part, { force: true });
    }
  }
  return written;
}

function unique(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const m = /^(.*?)((?: \(720p\))?(?:\.emoton\.zip|\.[a-z0-9]+))$/i.exec(name);
  const [stem, ext] = m ? [m[1]!, m[2]!] : [name, ""];
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} ${i}${ext}`))) return `${stem} ${i}${ext}`;
}

export function safeName(title: string): string {
  const s = title.replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120).trim();
  return s || "Untitled";
}
