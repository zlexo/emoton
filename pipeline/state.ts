/**
 * File-derived stage state. Each stage records the hash of its inputs in
 * <bundle>/state.json when it finishes. A stage is "ok" when its output exists
 * and the recorded hash equals the hash of its current inputs, "stale" when
 * the output exists but the inputs changed, "missing" otherwise. A stage whose
 * own output is ok but whose upstream is not ok shows "stale" too (its output
 * will change once the upstream re-runs).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ChapterState, StageName, StageStatus, VideoState, VideoStatus } from "../shared/api.ts";
import type { PlannedStep, PlanOptions } from "../shared/library.ts";
import type { ChapterTiming, Outline } from "../schema/storyboard.ts";
import { GAPS, beatPauses, gapsFor } from "../src/core/estimate.ts";
import type { SourceSummary } from "./ingest.ts";
import { ROOT, Storyboard, isFile, isUrl, loadProject, maybe, paths, readJson, sourceFile, writeJson, type Project } from "./project.ts";
import { Outline as OutlineSchema } from "../schema/storyboard.ts";
import { RENDER_SETTINGS, propsFrom } from "./render.ts";
import { MASTER_VERSION } from "./loudness.ts";
import { badInput, conflict } from "../library/errors.ts";

export type Quality = "1080p" | "720p";
export type StageRecord = {
  hash: string;
  at: string;
  quality?: Quality;
  /** render: the hash of the props alone, so `rehash` can adopt a new renderer-version formula without re-rendering. */
  props?: string;
};
export type StateFile = {
  version: 1;
  /** "ingest", "outline", "storyboard:N", "voice:N", "render:N", "join" */
  stages: Record<string, StageRecord>;
  /** Per-source ingest result (pages, chunks, no text). */
  sources?: Record<string, SourceSummary>;
  lastError?: VideoState["lastError"];
};

export const stageKey = (stage: StageName, n?: number) => (n === undefined ? stage : `${stage}:${n}`);

// ---------------------------------------------------------------- hashing

/** JSON with sorted keys, so equal data always hashes equal. */
export function stable(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map((v) => (v === undefined ? "null" : stable(v))).join(",")}]`;
  if (x && typeof x === "object")
    return `{${Object.keys(x)
      .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(x) ?? "null";
}

export const sha = (x: unknown) => createHash("sha256").update(typeof x === "string" ? x : stable(x)).digest("hex").slice(0, 32);

const fileHashes = new Map<string, { sig: string; hash: string }>();
/** Content hash of a file, cached by size and mtime. */
export function fileHash(file: string): string | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = fileHashes.get(file);
  if (hit?.sig === sig) return hit.hash;
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32);
  fileHashes.set(file, { sig, hash });
  return hash;
}

function sourceFiles(dirs: string[], skip: (rel: string, name: string) => boolean): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(d, e.name);
      if (skip(relative(ROOT, f), e.name)) continue;
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) files.push(f);
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return files;
}

/** Packages whose code draws the video; their installed versions are part of the renderer version. */
export const RENDER_PACKAGES = ["remotion", "@remotion/renderer", "katex", "prism-react-renderer"];

let rendererHash: string | null = null;
/**
 * Hash of everything that decides how a storyboard looks: the code in
 * src/remotion (not the Studio demo) and src/core, the installed versions of
 * the render packages, and the render settings. Dotfiles never count.
 * Computed once per process (the render bundle is made once per process too).
 * The schema is not part of it: the storyboard itself is in the props.
 */
export function rendererVersion(): string {
  if (rendererHash) return rendererHash;
  const files = sourceFiles(["src/remotion", "src/core"], (rel, name) => name.startsWith(".") || rel === join("src", "remotion", "demo.ts"));
  const versions = RENDER_PACKAGES.map((p) => [p, maybe(() => readJson<{ version: string }>(join(ROOT, "node_modules", p, "package.json")).version) ?? "missing"]);
  rendererHash = sha({ v: 2, files: files.map((f) => [relative(ROOT, f), fileHash(f)]), versions, settings: RENDER_SETTINGS });
  return rendererHash;
}

/** The first formula (every file in src/remotion, src/core and schema). Only `rehash` uses it, to recognise renders recorded with it. */
export function rendererVersionV1(): string {
  return sha(sourceFiles(["src/remotion", "src/core", "schema"], () => false).map((f) => [relative(ROOT, f), fileHash(f)]));
}

// ---------------------------------------------------------------- state file + locking

const locks = new Map<string, Promise<unknown>>();
/** Serialises read-modify-write of one bundle's files within this process. */
export function withLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = locks.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(dir, tail);
  tail.then(() => {
    if (locks.get(dir) === tail) locks.delete(dir);
  });
  return next;
}

export function readState(dir: string): StateFile {
  const s = maybe(() => readJson<StateFile>(paths(dir).state));
  return s && s.version === 1 && s.stages ? s : { version: 1, stages: {} };
}

/** Read-modify-write of state.json. Call only while holding withLock(dir). */
export function mutateState(dir: string, fn: (s: StateFile) => void): StateFile {
  const s = readState(dir);
  fn(s);
  writeJson(paths(dir).state, s);
  return s;
}

export const updateState = (dir: string, fn: (s: StateFile) => void) => withLock(dir, () => mutateState(dir, fn));

// ---------------------------------------------------------------- snapshot

export type Snapshot = {
  dir: string;
  P: ReturnType<typeof paths>;
  project: Project;
  outline?: Outline;
  sb?: Storyboard;
  state: StateFile;
  /** Chapter count: the outline's, else the storyboard's. */
  count: number;
  globalPronounce: Record<string, string>;
};

export function snapshot(dir: string, globalPronounce: Record<string, string> = {}): Snapshot {
  const P = paths(dir);
  const project = loadProject(dir);
  const outline = isFile(P.outline) ? maybe(() => readJson(P.outline, OutlineSchema)) : undefined;
  const sb = isFile(P.storyboard) ? maybe(() => readJson(P.storyboard, Storyboard)) : undefined;
  const count = outline?.chapters.length ?? sb?.chapters.length ?? 0;
  return { dir, P, project, outline, sb, state: readState(dir), count, globalPronounce };
}

// ---------------------------------------------------------------- inputs

export function ingestInput(s: Snapshot): string {
  return sha({
    sources: s.project.sources.map((src) => {
      if (isUrl(src.path)) return { id: src.id, ref: src.path };
      const file = maybe(() => sourceFile(s.dir, src));
      return { id: src.id, ref: (file && fileHash(file)) ?? `missing:${src.path}` };
    }),
  });
}

export function outlineInput(s: Snapshot): string {
  const p = s.project;
  return sha({ topic: p.topic, audience: p.audience, minutes: p.minutes, rules: p.rules, writerModel: p.writerModel, ingest: ingestInput(s) });
}

export function storyboardInput(s: Snapshot, n: number): string | null {
  const c = s.outline?.chapters[n - 1];
  if (!c) return null;
  // a slides storyboard is written differently, so switching layout rewrites it; stage hashes as before
  return s.project.layout === "slides" ? sha({ chapter: c, layout: "slides" }) : sha(c);
}

export const mergedPronounce = (s: Snapshot) => ({ ...s.globalPronounce, ...s.project.pronounce });

export function voiceInput(s: Snapshot, n: number): string | null {
  const ch = s.sb?.chapters[n - 1];
  if (!ch) return null;
  const base = { beats: ch.beats.map((b) => ({ say: b.say, aha: !!b.aha })), voice: s.project.voice, pronounce: mergedPronounce(s), gaps: GAPS };
  // a slides video's pauses depend on where its slides start; a stage video's voice hashes as before
  return sha(s.project.layout === "slides" ? { ...base, gaps: gapsFor("slides"), pauses: beatPauses(ch, "slides") } : base);
}

export function readTiming(s: Snapshot, n: number): ChapterTiming | undefined {
  return isFile(s.P.timing(n)) ? maybe(() => readJson<ChapterTiming>(s.P.timing(n))) : undefined;
}

/** The hash of chapter n's render props (audio path normalised: a render does not go stale when the video moves). */
export function renderProps(s: Snapshot, n: number): string | null {
  const timing = readTiming(s, n);
  if (!s.sb?.chapters[n - 1] || !timing) return null;
  return sha(propsFrom(s.project, s.sb, n, { ...timing, audio: s.P.audioRel(n) }));
}

export function renderInput(s: Snapshot, n: number, quality: Quality, renderer = rendererVersion()): string | null {
  const props = renderProps(s, n);
  return props && sha({ props, renderer, quality });
}

/**
 * After a change to the renderer-version formula (not to the renderer): gives
 * every existing render whose props are unchanged the hash under the current
 * formula, and the join too when it was up to date. Renders whose props
 * changed stay stale. Returns the chapters re-hashed. Call inside withLock.
 */
export function rehashRenders(dir: string, globalPronounce: Record<string, string> = {}): number[] {
  const s = snapshot(dir, globalPronounce);
  const done: number[] = [];
  const st = s.state;
  const joinWasOk = st.stages.join && st.stages.join.hash === joinInput(s);
  let v1: string | undefined;
  for (let n = 1; n <= s.count; n++) {
    const key = stageKey("render", n), rec = st.stages[key];
    const props = renderProps(s, n);
    if (!rec || !props || !isFile(s.P.chapterMp4(n))) continue;
    const q = rec.quality ?? "1080p";
    const same = rec.props ? rec.props === props : rec.hash === sha({ props: propsFrom(s.project, s.sb!, n, { ...readTiming(s, n)!, audio: s.P.audioRel(n) }), renderer: (v1 ??= rendererVersionV1()), quality: q });
    if (!same) continue;
    st.stages[key] = { ...rec, hash: sha({ props, renderer: rendererVersion(), quality: q }), props };
    done.push(n);
  }
  if (joinWasOk && isFile(s.P.final)) {
    const h = joinInput(s);
    if (h) st.stages.join = { ...st.stages.join!, hash: h };
  }
  writeJson(s.P.state, st);
  return done;
}

export function joinInput(s: Snapshot): string | null {
  const hashes: string[] = [];
  for (let n = 1; n <= s.count; n++) {
    const r = s.state.stages[stageKey("render", n)];
    if (!r) return null;
    hashes.push(r.hash);
  }
  // the master is part of the joined video: a new one joins every video again (no chapter re-renders)
  return hashes.length ? sha({ renders: hashes, master: MASTER_VERSION }) : null;
}

// ---------------------------------------------------------------- statuses

type Own = "missing" | "ok" | "stale";

function own(s: Snapshot, key: string, exists: boolean, current: string | null | (string | null)[]): Own {
  if (!exists) return "missing";
  const rec = s.state.stages[key];
  const cur = Array.isArray(current) ? current : [current];
  return rec && cur.some((c) => c !== null && c === rec.hash) ? "ok" : "stale";
}

export type Statuses = {
  ingest: Own;
  outline: Own;
  join: Own;
  chapters: { storyboard: Own; voice: Own; render: Own }[];
};

/** Own status of every stage (no propagation). `quality` decides which render hashes count as ok. */
export function ownStatuses(s: Snapshot, quality?: Quality): Statuses {
  const { P } = s;
  const chapters = Array.from({ length: s.count }, (_, i) => {
    const n = i + 1;
    const rq = quality ? (quality === "720p" ? (["720p", "1080p"] as const) : (["1080p"] as const)) : [s.state.stages[stageKey("render", n)]?.quality ?? "1080p"];
    return {
      storyboard: own(s, stageKey("storyboard", n), !!s.sb?.chapters[i], storyboardInput(s, n)),
      voice: own(s, stageKey("voice", n), isFile(P.audio(n)) && isFile(P.timing(n)), voiceInput(s, n)),
      render: own(s, stageKey("render", n), isFile(P.chapterMp4(n)), rq.map((q) => renderInput(s, n, q))),
    };
  });
  return {
    ingest: own(s, "ingest", isFile(P.chunks), ingestInput(s)),
    outline: own(s, "outline", isFile(P.outline) && !!s.outline, outlineInput(s)),
    join: own(s, "join", isFile(P.final), joinInput(s)),
    chapters,
  };
}

/** Propagates: an ok stage below a stage that is not ok is stale. */
export function effective(o: Statuses): Statuses {
  const down = (self: Own, ...up: Own[]): Own => (self === "ok" && up.some((u) => u !== "ok") ? "stale" : self);
  const ingest = o.ingest;
  const outline = down(o.outline, ingest);
  const chapters = o.chapters.map((c) => {
    const storyboard = down(c.storyboard, outline);
    const voice = down(c.voice, storyboard);
    const render = down(c.render, voice);
    return { storyboard, voice, render };
  });
  const join = down(o.join, ...chapters.map((c) => c.render));
  return { ingest, outline, join, chapters };
}

export function videoState(s: Snapshot): VideoState {
  const e = effective(ownStatuses(s));
  const chapters: ChapterState[] = e.chapters.map((c, i) => {
    const n = i + 1;
    const t = readTiming(s, n);
    return {
      n,
      title: s.sb?.chapters[i]?.title ?? s.outline?.chapters[i]?.title ?? `Chapter ${n}`,
      storyboard: c.storyboard as StageStatus,
      voice: c.voice as StageStatus,
      render: c.render as StageStatus,
      ...(t ? { duration: t.duration } : {}),
    };
  });
  return { ingest: e.ingest, outline: e.outline, join: e.join, chapters, ...(s.state.lastError ? { lastError: s.state.lastError } : {}) };
}

export function videoStatus(st: VideoState): VideoStatus {
  if (st.outline === "missing") return "draft";
  if (st.join === "ok") return "ready";
  if (!st.chapters.some((c) => c.storyboard !== "missing")) return "outline-review";
  return "partial";
}

// ---------------------------------------------------------------- plan

type Kind = "make" | "outline" | "storyboard" | "voice" | "render" | "redo";

/**
 * Steps a job needs now (see Library.plan). Downstream of a planned step is
 * planned too, because its output will change. When the outline itself is
 * (re)written, the chapter count is not known yet, so the chapter stages are
 * planned as one step each without a chapter: runStep then does every chapter
 * that needs it.
 */
export function planSteps(s: Snapshot, kind: Kind, opts: PlanOptions = {}): PlannedStep[] {
  const steps = planAt(s, kind, opts);
  if (!opts.draft) return steps;
  // Chapters of one video are joined without re-encoding, so they must share one
  // quality: a draft is only a draft when no kept chapter is already 1080p.
  const planned = new Set(steps.filter((x) => x.stage === "render").map((x) => x.chapter));
  // A render step without a chapter (the outline is being written, so the chapters are not
  // known yet) applies the same rule when it runs: see jobRender.
  if (planned.has(undefined)) return steps;
  const final = new Set(
    Array.from({ length: s.count }, (_, i) => i + 1)
      .filter((n) => planned.has(n) || isFile(s.P.chapterMp4(n)))
      .map((n) => (planned.has(n) ? "720p" : recordedQuality(s, n))),
  );
  return final.size > 1 ? planAt(s, kind, { ...opts, draft: false }) : steps;
}

const recordedQuality = (s: Snapshot, n: number): Quality => s.state.stages[stageKey("render", n)]?.quality ?? "1080p";

/**
 * The chapters a render step without a chapter must render, and at which
 * quality, so that every chapter of the video ends up at one quality: a
 * draft request among kept 1080p chapters renders at 1080p instead.
 */
export function jobRender(s: Snapshot, draft: boolean): { quality: Quality; chapters: number[] } {
  const need = (q: Quality) => effective(ownStatuses(s, q)).chapters.map((c, i) => (c.render !== "ok" ? i + 1 : 0)).filter(Boolean);
  if (!draft) return { quality: "1080p", chapters: need("1080p") };
  const chapters = need("720p");
  const final = new Set(
    Array.from({ length: s.count }, (_, i) => i + 1)
      .filter((n) => chapters.includes(n) || isFile(s.P.chapterMp4(n)))
      .map((n) => (chapters.includes(n) ? "720p" : recordedQuality(s, n))),
  );
  return final.size > 1 ? { quality: "1080p", chapters: need("1080p") } : { quality: "720p", chapters };
}

function planAt(s: Snapshot, kind: Kind, opts: PlanOptions): PlannedStep[] {
  const quality: Quality = opts.draft ? "720p" : "1080p";
  /** After rendering `planned` at `quality`, would every chapter have one quality? */
  const oneQuality = (planned: number[]) =>
    Array.from({ length: s.count }, (_, i) => i + 1).every((n) => (planned.includes(n) ? quality : recordedQuality(s, n)) === quality);
  const o = ownStatuses(s, quality);
  const e = effective(o);
  const draft = opts.draft ? { draft: true } : {};
  const steps: PlannedStep[] = [];
  const chapters = opts.chapter ? [opts.chapter] : Array.from({ length: s.count }, (_, i) => i + 1);
  const inRange = (n: number) => n >= 1 && n <= s.count;
  if (opts.chapter !== undefined && !inRange(opts.chapter) && kind !== "make" && kind !== "outline")
    throw badInput(`there is no chapter ${opts.chapter}`);
  const renderExists = (n: number) => o.chapters[n - 1]!.render !== "missing";

  switch (kind) {
    case "make": {
      const ingest = e.ingest !== "ok";
      const outline = ingest || e.outline !== "ok";
      if (ingest) steps.push({ stage: "ingest", lane: "write" });
      if (outline) {
        steps.push({ stage: "outline", lane: "write" });
        if (opts.pauseAfterOutline) return steps;
        steps.push({ stage: "storyboard", lane: "write" }, { stage: "voice", lane: "media" }, { stage: "render", lane: "media", ...draft }, { stage: "join", lane: "media" });
        return steps;
      }
      const all = Array.from({ length: s.count }, (_, i) => i + 1);
      const sb = all.filter((n) => e.chapters[n - 1]!.storyboard !== "ok");
      const voice = all.filter((n) => sb.includes(n) || e.chapters[n - 1]!.voice !== "ok");
      const render = all.filter((n) => voice.includes(n) || e.chapters[n - 1]!.render !== "ok");
      for (const n of sb) steps.push({ stage: "storyboard", chapter: n, lane: "write" });
      for (const n of voice) steps.push({ stage: "voice", chapter: n, lane: "media" });
      for (const n of render) steps.push({ stage: "render", chapter: n, lane: "media", ...draft });
      if (render.length || e.join !== "ok") steps.push({ stage: "join", lane: "media" });
      return steps;
    }
    case "outline": {
      // Asked for explicitly: the outline is (re)written even when it is ok.
      if (e.ingest !== "ok") steps.push({ stage: "ingest", lane: "write" });
      steps.push({ stage: "outline", lane: "write", ...(opts.note ? { note: opts.note } : {}) });
      return steps;
    }
    case "redo": {
      const n = opts.chapter;
      if (n === undefined) throw badInput("redo needs a chapter");
      steps.push(
        { stage: "storyboard", chapter: n, lane: "write", note: opts.note ?? "make it clearer" },
        { stage: "voice", chapter: n, lane: "media" },
        { stage: "render", chapter: n, lane: "media", ...draft },
      );
      if (Array.from({ length: s.count }, (_, i) => i + 1).every((m) => m === n || renderExists(m)) && oneQuality([n])) steps.push({ stage: "join", lane: "media" });
      return steps;
    }
    case "storyboard":
      if (!s.outline) throw conflict("write the outline first");
      // A note on one chapter always rewrites it, even when it is up to date.
      for (const n of chapters)
        if (e.chapters[n - 1]!.storyboard !== "ok" || (opts.note && opts.chapter === n))
          steps.push({ stage: "storyboard", chapter: n, lane: "write", ...(opts.note ? { note: opts.note } : {}) });
      return steps;
    case "voice":
      for (const n of chapters) if (s.sb?.chapters[n - 1] && o.chapters[n - 1]!.voice !== "ok") steps.push({ stage: "voice", chapter: n, lane: "media" });
      return steps;
    case "render": {
      // A chapter whose voice is stale (or missing) is voiced first: never render over old audio.
      const voice = chapters.filter((n) => s.sb?.chapters[n - 1] && o.chapters[n - 1]!.voice !== "ok");
      const render = chapters.filter((n) => s.sb?.chapters[n - 1] && (voice.includes(n) || o.chapters[n - 1]!.render !== "ok"));
      for (const n of voice) steps.push({ stage: "voice", chapter: n, lane: "media" });
      for (const n of render) steps.push({ stage: "render", chapter: n, lane: "media", ...draft });
      const all = Array.from({ length: s.count }, (_, i) => i + 1);
      if (s.count && all.every((m) => render.includes(m) || renderExists(m)) && oneQuality(render) && (render.length || o.join !== "ok"))
        steps.push({ stage: "join", lane: "media" });
      return steps;
    }
  }
}
