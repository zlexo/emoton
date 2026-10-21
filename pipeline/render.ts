import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChapterMarker } from "../shared/api.ts";
import type { Chapter, ChapterTiming } from "../schema/storyboard.ts";
import { estimateTiming } from "../src/core/estimate.ts";
import { slideTotal, slidesBefore } from "../src/core/slides.ts";
import type { ChapterProps } from "../src/remotion/ChapterVideo.tsx";
import { master } from "./loudness.ts";
import { Cancelled, run, throwIfAborted } from "./proc.ts";
import { ROOT, isFile, paths, readJson, writeJson, type Project, type Storyboard } from "./project.ts";

/** The props the renderer (and the in-app preview) gets for chapter n. */
export function propsFrom(p: Project, sb: Storyboard, n: number, timing: ChapterTiming): ChapterProps {
  const chapter = sb.chapters[n - 1];
  if (!chapter) throw new Error(`no chapter ${n} in the storyboard`);
  return {
    videoTitle: sb.title, index: n, count: sb.chapters.length, chapter, timing,
    sources: Object.fromEntries(p.sources.map((s) => [s.id, s.title])), captions: p.captions,
    // only slides videos carry these, so a stage video's props (and its render's hash) are as before
    ...(p.layout === "slides" ? { layout: "slides" as const, slideBase: slidesBefore(sb.chapters, n) + 1, slideTotal: slideTotal(sb.chapters) } : {}),
  };
}

/** The voiced timing when there is one, else estimated (silent, audio ""). */
export function chapterProps(dir: string, p: Project, sb: Storyboard, n: number, voiced: boolean): ChapterProps {
  const chapter = sb.chapters[n - 1];
  if (!chapter) throw new Error(`no chapter ${n} in the storyboard`);
  const P = paths(dir);
  const timing = voiced && isFile(P.timing(n)) ? readJson<ChapterTiming>(P.timing(n)) : estimateTiming(chapter, undefined, p.layout);
  return propsFrom(p, sb, n, timing);
}

export function writeProps(dir: string, props: ChapterProps) {
  const file = join(dir, "render", `ch${props.index}.props.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(props));
  return file;
}

// ---------------------------------------------------------------- bundling

/**
 * One Remotion bundle per process, shared by every video in every library.
 * Its public dir is a private temp folder (symlinked into the bundle, never
 * copied); before a render the chapter's WAV is hard-linked into it under a
 * content-derived name, and the props point at that name. So a video can move
 * between folders, and no library content is ever copied into a bundle.
 */
let bundled: Promise<{ serveUrl: string; publicDir: string }> | null = null;

/** Frames per second of the Chapter composition (src/remotion/Root.tsx). */
export const FPS = 30;

/** Every render setting that changes the output. Part of the renderer version, so changing one makes renders stale. */
export const RENDER_SETTINGS = { codec: "h264", fps: FPS, scale: { "1080p": 1, "720p": 2 / 3 } } as const;
/** Temp dirs this process made (bundle output, public dir); removed on exit. Never anyone else's. */
const ours = new Set<string>();
let cleanupHooked = false;

/** The shared bundle, made again when macOS has purged its temp folder under a long-running server. */
export async function getBundle(log?: (l: string) => void) {
  if (bundled) {
    const b = await bundled.catch(() => null);
    if (b && !(existsSync(join(b.serveUrl, "index.html")) && existsSync(b.publicDir) && existsSync(join(b.serveUrl, "public")))) {
      log?.("render: the renderer's temp folder was cleaned up by the system; bundling again");
      for (const d of [b.publicDir, b.serveUrl]) {
        rmSync(d, { recursive: true, force: true });
        ours.delete(d);
      }
      bundled = null;
    }
  }
  if (!bundled) {
    bundled = (async () => {
      const { bundle } = await import("@remotion/bundler");
      const publicDir = mkdtempSync(join(tmpdir(), "emoton-public-"));
      ours.add(publicDir);
      log?.("render: bundling the renderer (once per process)");
      const serveUrl = await bundle({ entryPoint: join(ROOT, "src/remotion/index.ts"), publicDir, symlinkPublicDir: true });
      ours.add(serveUrl);
      if (!cleanupHooked) {
        cleanupHooked = true;
        process.on("exit", () => {
          for (const d of ours) {
            try {
              rmSync(d, { recursive: true, force: true });
            } catch {
              /* best effort */
            }
          }
        });
      }
      return { serveUrl, publicDir };
    })();
    bundled.catch(() => (bundled = null));
  }
  return bundled;
}

/** The file hard-linked into the bundle's public folder under a content-derived name (keeping its extension); that name. */
export function linkInto(publicDir: string, file: string): string {
  const st = statSync(file);
  const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(file)?.[0] ?? ".bin").toLowerCase();
  const name = `a-${createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16)}${ext}`;
  const to = join(publicDir, name);
  if (!existsSync(to)) {
    try {
      linkSync(file, to);
    } catch {
      copyFileSync(file, to);
    }
  }
  return name;
}

export type RenderOptions = {
  signal?: AbortSignal;
  draft?: boolean;
  onProgress?: (p: number) => void;
  log?: (line: string) => void;
};

/** Renders chapter n to render/chN.mp4 (1080p, or 720p when draft). props.timing.audio is bundle-relative. */
export async function renderChapter(dir: string, n: number, props: ChapterProps, o: RenderOptions = {}) {
  const P = paths(dir);
  if (!props.timing.audio) throw new Error(`chapter ${n} has no voice yet: voice it first`);
  const { openBrowser, renderMedia, selectComposition, makeCancelSignal } = await import("@remotion/renderer");
  const { serveUrl, publicDir } = await getBundle(o.log);
  throwIfAborted(o.signal);
  const audioName = linkInto(publicDir, join(dir, props.timing.audio));
  const inputProps = { ...props, timing: { ...props.timing, audio: audioName } } as unknown as Record<string, unknown>;
  const part = P.chapterMp4(n).replace(/\.mp4$/, ".part.mp4");
  mkdirSync(dirname(part), { recursive: true });
  const { cancelSignal, cancel } = makeCancelSignal();
  const onAbort = () => cancel();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  // Our own browser, closed in finally: a cancelled or crashed render leaves no Chrome behind.
  const browser = await openBrowser("chrome");
  try {
    throwIfAborted(o.signal);
    const composition = await selectComposition({ serveUrl, id: "Chapter", inputProps, puppeteerInstance: browser });
    throwIfAborted(o.signal);
    await renderMedia({
      composition, serveUrl, codec: RENDER_SETTINGS.codec, outputLocation: part, inputProps, puppeteerInstance: browser,
      scale: RENDER_SETTINGS.scale[o.draft ? "720p" : "1080p"], cancelSignal, overwrite: true,
      onProgress: ({ progress }) => o.onProgress?.(progress),
    });
    throwIfAborted(o.signal);
    renameSync(part, P.chapterMp4(n));
  } catch (e) {
    rmSync(part, { force: true });
    if (o.signal?.aborted) throw new Cancelled();
    throw e;
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    rmSync(join(publicDir, audioName), { force: true });
    await browser.close({ silent: true }).catch(() => {});
  }
  o.log?.(`render ch${n}: done${o.draft ? " (720p draft)" : ""}`);
}

// ---------------------------------------------------------------- join


/** A chapter renders to whole frames, so its video is ceil(duration * FPS) / FPS long. Sum these, never the raw durations. */
export const renderedDuration = (d: number) => Math.ceil(d * FPS - 1e-6) / FPS;

/** FFMETADATA escaping: = ; # \ and newlines. */
const meta = (s: string) => s.replace(/[=;#\\\n]/g, (c) => "\\" + c);

export function markersFrom(chapters: Chapter[], timings: ChapterTiming[]): ChapterMarker[] {
  let t = 0;
  return chapters.map((c, i) => {
    const d = renderedDuration(timings[i]!.duration);
    const m = { title: c.title, start: +t.toFixed(3), end: +(t + d).toFixed(3) };
    t += d;
    return m;
  });
}

/**
 * Joins chapter files (the picture without re-encoding, the sound mastered to
 * one loudness) and adds chapter markers players can show; writes out/markers.json and thumb.jpg (a frame from chapter 1's first beat).
 */
export async function concat(dir: string, sb: Storyboard, o: { signal?: AbortSignal; log?: (l: string) => void } = {}): Promise<ChapterMarker[]> {
  const P = paths(dir);
  const chapters = sb.chapters.map((c, i) => {
    if (!c) throw new Error(`chapter ${i + 1} has no storyboard`);
    if (!isFile(P.chapterMp4(i + 1))) throw new Error(`chapter ${i + 1} is not rendered`);
    return c;
  });
  if (!chapters.length) throw new Error("nothing to join: no chapters");
  const timings = chapters.map((_, i) => readJson<ChapterTiming>(P.timing(i + 1)));
  const markers = markersFrom(chapters, timings);
  mkdirSync(dirname(P.final), { recursive: true });
  const list = join(dir, "render", "concat.txt");
  const metaFile = join(dir, "render", "chapters.txt");
  const q = (f: string) => `'${f.replace(/'/g, "'\\''")}'`;
  writeFileSync(list, chapters.map((_, i) => `file ${q(P.chapterMp4(i + 1))}`).join("\n") + "\n");
  const marks = markers.map((m) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(m.start * 1000)}\nEND=${Math.round(m.end * 1000)}\ntitle=${meta(m.title)}\n`);
  writeFileSync(metaFile, `;FFMETADATA1\ntitle=${meta(sb.title)}\n\n${marks.join("\n")}`);
  const joined = P.final.replace(/\.mp4$/, ".joined.part.mp4");
  const part = P.final.replace(/\.mp4$/, ".part.mp4");
  try {
    await run("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", metaFile, "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", joined], { signal: o.signal });
    // the whole video's sound to one loudness (the picture is copied)
    await master(joined, part, { signal: o.signal, log: o.log });
    renameSync(part, P.final);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  } finally {
    rmSync(joined, { force: true });
  }
  writeJson(P.markers, markers);
  await thumbnail(dir, timings[0]!, o.signal).catch((e) => {
    if (o.signal?.aborted) throw e;
    o.log?.(`thumb: ${(e as Error).message}`);
  });
  const total = markers[markers.length - 1]!.end;
  o.log?.(`video: ${P.final} (${(total / 60).toFixed(1)} min, ${chapters.length} chapters)`);
  return markers;
}

/** A frame from the end of chapter 1's first beat: the title beat, fully drawn, before it fades. */
export async function thumbnail(dir: string, t1: ChapterTiming, signal?: AbortSignal) {
  const P = paths(dir);
  const b = t1.beats[0];
  const at = Math.min(b ? b.end : 1, Math.max(0, t1.duration - 0.2));
  const part = P.thumb.replace(/\.jpg$/, ".part.jpg");
  try {
    await run("ffmpeg", ["-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", P.chapterMp4(1), "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", part], { signal });
    renameSync(part, P.thumb);
  } finally {
    rmSync(part, { force: true });
  }
}
