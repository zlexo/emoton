import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { badInput } from "../library/errors.ts";
import { z } from "zod/v4";
import { Chapter, Outline } from "../schema/storyboard.ts";

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** A video bundle directory ends with this suffix; that is how the library tells videos from folders. */
export const BUNDLE_EXT = ".emoton";

export const Source = z.object({
  id: z.string().regex(/^[a-z0-9]+$/),
  title: z.string(),
  /** Bundle-relative ("sources/notes.pdf"), a URL, or (old repo layout) an absolute or ~ path. */
  path: z.string(),
});
export type Source = z.infer<typeof Source>;

export const Voice = z.object({ engine: z.enum(["kokoro", "say"]), voice: z.string(), speed: z.number() });

export const Project = z.object({
  /** uuid; absent only in an old repo-layout project. */
  id: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  /** True while the title was made from the topic; the outline stage then replaces it. */
  titleAuto: z.boolean().optional(),
  title: z.string(),
  topic: z.string(),
  audience: z.string(),
  minutes: z.number().min(1).max(30),
  sources: z.array(Source).default([]),
  rules: z.array(z.string()).default([]),
  voice: Voice,
  pronounce: z.record(z.string(), z.string()).default({}),
  writerModel: z.string().default("opus"),
  captions: z.boolean().default(true),
  /** "slides" or "stage"; absent = "stage", so videos made before slides keep their look. */
  layout: z.enum(["slides", "stage"]).optional(),
  /** A narrated explainer, or a Short (short.json holds it); absent = explainer. */
  kind: z.enum(["explainer", "short"]).optional(),
});
export type Project = z.infer<typeof Project>;

/** Chapters may be null while not written yet (chapters are written one at a time). */
export const Storyboard = z.object({ title: z.string(), chapters: z.array(Chapter.nullable()) });
export type Storyboard = z.infer<typeof Storyboard>;

export type Chunk = { id: string; source: string; text: string };

export const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
export const isUrl = (p: string) => /^https?:\/\//i.test(p);

/** The slug of a bundle dir: its name without ".emoton". */
export const slugOf = (dir: string) => basename(dir).replace(/\.emoton$/, "");

/** Everything about one video lives in its bundle dir (`<anything>/<slug>.emoton/`). */
export function paths(dir: string) {
  const slug = slugOf(dir);
  return {
    dir,
    slug,
    project: join(dir, "project.json"),
    state: join(dir, "state.json"),
    sources: join(dir, "sources"),
    chunks: join(dir, "chunks.json"),
    outline: join(dir, "outline.json"),
    storyboard: join(dir, "storyboard.json"),
    prompts: join(dir, "prompts"),
    audio: (n: number) => join(dir, "audio", `ch${n}.wav`),
    audioRel: (n: number) => `audio/ch${n}.wav`,
    /** The voice as spoken, before pause edits; audio(n) is it with the edits applied. */
    spokenAudio: (n: number) => join(dir, "audio", `ch${n}.spoken.wav`),
    spokenAudioRel: (n: number) => `audio/ch${n}.spoken.wav`,
    spokenTiming: (n: number) => join(dir, "render", `ch${n}.spoken.timing.json`),
    voiceEdits: join(dir, "voice-edits.json"),
    ttsCache: join(dir, "audio", "cache"),
    timing: (n: number) => join(dir, "render", `ch${n}.timing.json`),
    chapterMp4: (n: number) => join(dir, "render", `ch${n}.mp4`),
    final: join(dir, "out", `${slug}.mp4`),
    finalRel: `out/${slug}.mp4`,
    markers: join(dir, "out", "markers.json"),
    thumb: join(dir, "thumb.jpg"),
    /** A Short's document, its media (clips, songs, proxies) and its rendered Perdix shots. */
    short: join(dir, "short.json"),
    assets: join(dir, "assets"),
    shots: join(dir, "shots"),
  };
}
export type Paths = ReturnType<typeof paths>;

/**
 * Absolute path of a source file. In a .emoton bundle it must stay inside the
 * bundle's sources/ folder (also through symlinks); only the old repo layout
 * may use absolute or ~ paths. Throws a 400 LibraryError otherwise.
 */
export function sourceFile(dir: string, src: Source): string {
  const p = expand(src.path);
  const bundle = dir.endsWith(BUNDLE_EXT);
  if (isAbsolute(p)) {
    if (bundle) throw badInput(`source ${src.id}: ${src.path} is not inside the video's sources folder`);
    return p;
  }
  const base = join(dir, "sources");
  const abs = resolve(dir, p);
  const inside = (f: string, b: string) => f.startsWith(b + sep);
  let ok = !bundle || inside(abs, base);
  if (ok && bundle && existsSync(abs)) ok = inside(realpathSync(abs), realpathSync(base));
  if (!ok) throw badInput(`source ${src.id}: ${src.path} is not inside the video's sources folder`);
  return abs;
}

/**
 * CLI argument to a bundle dir: an existing directory (a `.emoton` bundle, or
 * any folder holding a project.json), else the old repo slug `videos/<slug>`.
 */
export function resolveBundle(arg: string): string {
  const abs = resolve(expand(arg));
  if (existsSync(join(abs, "project.json"))) return abs;
  const legacy = join(ROOT, "videos", arg);
  if (existsSync(join(legacy, "project.json"))) return legacy;
  throw new Error(`no video at ${arg} (give a bundle dir holding a project.json)`);
}

export function readJson<T>(file: string, schema?: z.ZodType<T>): T {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  return schema ? schema.parse(data) : (data as T);
}

/** Written through a temp file and a rename, so a crash never leaves half a file. */
export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

export const exists = (file: string) => existsSync(file);
export const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

export const loadProject = (dir: string) => readJson(paths(dir).project, Project);
export const loadOutline = (dir: string) => readJson(paths(dir).outline, Outline);
export const loadStoryboard = (dir: string) => readJson(paths(dir).storyboard, Storyboard);
export const loadChunks = (dir: string) => readJson<Chunk[]>(paths(dir).chunks);

export const maybe = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
