/**
 * What each stage does to a bundle dir, including recording its input hash.
 * Shared by the Library (runStep) and the CLI, so both keep state.json right.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Chapter, ChapterTiming, Outline } from "../schema/storyboard.ts";
import type { PlannedStep, StepContext } from "../shared/library.ts";
import { ingest } from "./ingest.ts";
import { throwIfAborted } from "./proc.ts";
import { Project, Storyboard, isFile, loadOutline, loadProject, maybe, paths, readJson, writeJson, type Chunk } from "./project.ts";
import { concat, propsFrom, renderChapter } from "./render.ts";
import {
  effective, ingestInput, jobRender, joinInput, mergedPronounce, mutateState, outlineInput, ownStatuses, readTiming,
  rehashRenders, renderInput, renderProps, sha, snapshot, stageKey, storyboardInput, voiceInput, withLock, type Quality, type Snapshot,
} from "./state.ts";
import { voiceChapter, type Tts } from "./voice.ts";
import { dropChapterEdits } from "./voice-edits.ts";
import { conflict } from "../library/errors.ts";
import { checkChapter, checkOutline, writeChapter, writeOutline, type Writer } from "./write.ts";

export type StageDeps = {
  globalPronounce?: Record<string, string>;
  /** Replaces the claude CLI (tests). */
  writer?: Writer;
  /** Replaces speak.py (tests). */
  tts?: Tts;
};

const now = () => new Date().toISOString();

/** Bumps project.updated. Call while holding the lock. */
function touch(dir: string, change?: (p: Project) => void) {
  const file = paths(dir).project;
  const raw = readJson<Record<string, unknown>>(file);
  const p = Project.parse(raw);
  change?.(p);
  // Keep keys the schema does not know about.
  writeJson(file, { ...raw, ...p, updated: now() });
}

function record(dir: string, key: string, hash: string, extra: { quality?: Quality; props?: string } = {}) {
  mutateState(dir, (s) => {
    s.stages[key] = { hash, at: now(), ...extra };
  });
}

/** Removes a chapter's generated files and records (the outline shrank). */
function dropChapterOutputs(dir: string, n: number) {
  const P = paths(dir);
  for (const f of [P.audio(n), P.timing(n), P.spokenAudio(n), P.spokenTiming(n), P.chapterMp4(n), `${P.dir}/render/ch${n}.props.json`]) rmSync(f, { force: true });
  mutateState(dir, (s) => {
    for (const st of ["storyboard", "voice", "render"] as const) delete s.stages[stageKey(st, n)];
  });
  dropChapterEdits(dir, n);
}

// ---------------------------------------------------------------- storing (shared with user edits)

export type Validation = { errors: string[] };

/** What a writer step saw when it started: the outline's or chapter n's content hash ("none" when absent). */
export function outlineContent(dir: string): string {
  const P = paths(dir);
  const o = isFile(P.outline) ? maybe(() => readJson<unknown>(P.outline)) : undefined;
  return o === undefined ? "none" : sha(o);
}
export function chapterContent(dir: string, n: number): string {
  const P = paths(dir);
  const sb = isFile(P.storyboard) ? maybe(() => readJson(P.storyboard, Storyboard)) : undefined;
  const c = sb?.chapters[n - 1];
  return c ? sha(c) : "none";
}

/**
 * Validates and stores an outline (schema + grounding). `hash` = the outline input hash to record.
 * `expect` (writer steps): the outline content the step started from; if a user saved an edit
 * meanwhile, the step fails with a 409 and the edit is kept.
 */
export function storeOutline(dir: string, data: unknown, hash: string, expect?: string): Promise<Outline | Validation> {
  return withLock(dir, () => {
    const P = paths(dir);
    if (expect !== undefined && outlineContent(dir) !== expect)
      throw conflict("the outline was edited while it was being rewritten; your edit was kept");
    if (!isFile(P.chunks)) return { errors: ["the sources are not read yet (ingest first)"] };
    const ids = new Set(readJson<Chunk[]>(P.chunks).map((c) => c.id));
    const r = checkOutline(data, ids);
    if ("errors" in r) return r;
    const outline = r.ok;
    writeJson(P.outline, outline);
    const sb = isFile(P.storyboard) ? maybe(() => readJson(P.storyboard, Storyboard)) : undefined;
    if (sb && sb.chapters.length > outline.chapters.length) {
      for (let n = outline.chapters.length + 1; n <= sb.chapters.length; n++) dropChapterOutputs(dir, n);
      sb.chapters = sb.chapters.slice(0, outline.chapters.length);
      writeJson(P.storyboard, sb);
    }
    record(dir, "outline", hash);
    touch(dir, (p) => {
      if (p.titleAuto) {
        p.title = outline.title;
        p.titleAuto = false;
      }
    });
    return outline;
  });
}

/** Validates and stores chapter n (schema + cross-checks). `hash` = the storyboard n input hash to record; `expect` as in storeOutline. */
export function storeChapter(dir: string, n: number, data: unknown, hash: string | null, expect?: string): Promise<Chapter | Validation> {
  return withLock(dir, () => {
    const P = paths(dir);
    if (expect !== undefined && chapterContent(dir, n) !== expect)
      throw conflict(`chapter ${n} was edited while it was being rewritten; your edit was kept`);
    if (!isFile(P.outline)) return { errors: ["there is no outline yet"] };
    const outline = loadOutline(dir);
    if (!Number.isInteger(n) || n < 1 || n > outline.chapters.length) return { errors: [`the outline has no chapter ${n}`] };
    const r = checkChapter(data, loadProject(dir).layout ?? "stage");
    if ("errors" in r) return r;
    const sb: Storyboard = isFile(P.storyboard) ? readJson(P.storyboard, Storyboard) : { title: outline.title, chapters: [] };
    while (sb.chapters.length < outline.chapters.length) sb.chapters.push(null);
    sb.chapters[n - 1] = r.ok;
    writeJson(P.storyboard, sb);
    if (hash) record(dir, stageKey("storyboard", n), hash);
    touch(dir);
    return r.ok;
  });
}

// ---------------------------------------------------------------- running

const need = (s: Snapshot, stage: "storyboard" | "voice" | "render", quality?: Quality) => {
  const e = effective(ownStatuses(s, quality));
  return e.chapters.map((c, i) => (c[stage] !== "ok" ? i + 1 : 0)).filter(Boolean);
};

/** Runs one planned step on a bundle dir. Throws on failure after recording lastError. */
export async function runStage(dir: string, step: PlannedStep, ctx: StepContext, deps: StageDeps = {}): Promise<void> {
  try {
    await doStage(dir, step, ctx, deps);
    await withLock(dir, () =>
      mutateState(dir, (s) => {
        if (s.lastError && s.lastError.stage === step.stage && s.lastError.chapter === step.chapter) delete s.lastError;
      }),
    );
  } catch (e) {
    if (!ctx.signal.aborted) {
      const message = e instanceof Error ? e.message : String(e);
      await withLock(dir, () =>
        mutateState(dir, (s) => {
          s.lastError = { stage: step.stage, ...(step.chapter !== undefined ? { chapter: step.chapter } : {}), message, at: now() };
        }),
      ).catch(() => {});
    }
    throw e;
  }
}

async function doStage(dir: string, step: PlannedStep, ctx: StepContext, deps: StageDeps) {
  const { signal } = ctx;
  const log = (l: string) => ctx.log(l);
  const snap = () => snapshot(dir, deps.globalPronounce);
  throwIfAborted(signal);
  switch (step.stage) {
    case "ingest": {
      const s = snap();
      const hash = ingestInput(s);
      ctx.progress(0, "reading sources");
      const r = await ingest(s.project, dir, { signal, log });
      throwIfAborted(signal);
      await withLock(dir, () => {
        writeJson(paths(dir).chunks, r.chunks);
        mutateState(dir, (st) => {
          st.stages.ingest = { hash, at: now() };
          st.sources = r.sources;
        });
        touch(dir);
      });
      log(`ingest: ${r.chunks.length} chunks`);
      return ctx.progress(1);
    }
    case "outline": {
      const hash = outlineInput(snap());
      const before = outlineContent(dir);
      ctx.progress(0, "writing the outline");
      const outline = await writeOutline(dir, {
        signal, writer: deps.writer, note: step.note, log,
        onAttempt: (a) => a > 1 && ctx.progress(0.3 * (a - 1), `writing the outline (attempt ${a})`),
      });
      throwIfAborted(signal);
      const r = await storeOutline(dir, outline, hash, before);
      if ("errors" in r) throw new Error(`outline rejected:\n${r.errors.join("\n")}`);
      log(`outline: ${r.chapters.length} chapters`);
      return ctx.progress(1);
    }
    case "storyboard": {
      const list = step.chapter !== undefined ? [step.chapter] : need(snap(), "storyboard");
      for (const [i, n] of list.entries()) {
        throwIfAborted(signal);
        const hash = storyboardInput(snap(), n);
        const before = chapterContent(dir, n);
        const label = `writing chapter ${n} of ${snap().count}`;
        ctx.progress(i / list.length, label);
        const ch = await writeChapter(dir, n, {
          signal, writer: deps.writer, note: step.note, log,
          onAttempt: (a) => a > 1 && ctx.progress((i + 0.3 * (a - 1)) / list.length, `${label} (attempt ${a})`),
        });
        throwIfAborted(signal);
        const r = await storeChapter(dir, n, ch, hash, before);
        if ("errors" in r) throw new Error(`chapter ${n} rejected:\n${r.errors.join("\n")}`);
        log(`storyboard: chapter ${n} written`);
      }
      return ctx.progress(1);
    }
    case "voice": {
      const list = step.chapter !== undefined ? [step.chapter] : need(snap(), "voice");
      for (const [i, n] of list.entries()) {
        throwIfAborted(signal);
        const s = snap();
        const ch = s.sb?.chapters[n - 1];
        if (!ch) throw new Error(`chapter ${n} has no storyboard yet`);
        const hash = voiceInput(s, n)!;
        if (ownStatuses(s).chapters[n - 1]?.voice === "ok") {
          log(`voice ch${n}: up to date`);
          continue;
        }
        ctx.progress(i / list.length, `voicing chapter ${n} of ${s.count}`);
        await voiceChapter(dir, n, s.project, ch, {
          signal, pronounce: mergedPronounce(s), tts: deps.tts, log,
          onProgress: (d, t) => ctx.progress((i + d / t) / list.length, `voicing chapter ${n} of ${s.count}, sentence ${d} of ${t}`),
        });
        await withLock(dir, () => {
          record(dir, stageKey("voice", n), hash);
          touch(dir);
        });
      }
      return ctx.progress(1);
    }
    case "render": {
      // With a chapter, the plan already chose the quality; without one, choose it now for the whole job.
      const job = step.chapter !== undefined ? undefined : jobRender(snap(), !!step.draft);
      const quality: Quality = job?.quality ?? (step.draft ? "720p" : "1080p");
      const list = job?.chapters ?? [step.chapter!];
      if (job && step.draft && quality === "1080p") log("render: other chapters are 1080p, so these render at 1080p too (no mixed video)");
      for (const [i, n] of list.entries()) {
        throwIfAborted(signal);
        const s = snap();
        if (ownStatuses(s, quality).chapters[n - 1]?.render === "ok") {
          log(`render ch${n}: up to date`);
          continue;
        }
        const timing = readTiming(s, n);
        if (!timing || !isFile(s.P.audio(n))) throw new Error(`chapter ${n} has no voice yet: voice it first`);
        if (!s.sb) throw new Error("there is no storyboard yet");
        const props = propsFrom(s.project, s.sb, n, { ...timing, audio: s.P.audioRel(n) });
        const hash = renderInput(s, n, quality)!;
        const propsHash = renderProps(s, n)!;
        const label = `rendering chapter ${n} of ${s.count}`;
        ctx.progress(i / list.length, label);
        await renderChapter(dir, n, props, {
          signal, draft: quality === "720p", log,
          onProgress: (p) => ctx.progress((i + p) / list.length, `${label}, ${Math.floor(p * 100)}%`),
        });
        await withLock(dir, () => {
          record(dir, stageKey("render", n), hash, { quality, props: propsHash });
          touch(dir);
        });
      }
      return ctx.progress(1);
    }
    case "join": {
      const s = snap();
      if (!s.sb || !s.count) throw new Error("nothing to join: there is no storyboard yet");
      if (ownStatuses(s).join === "ok") return log("join: up to date");
      const q = new Set<Quality>();
      for (let n = 1; n <= s.count; n++) {
        if (!isFile(s.P.chapterMp4(n))) throw new Error(`chapter ${n} is not rendered yet`);
        q.add(s.state.stages[stageKey("render", n)]?.quality ?? "1080p");
      }
      if (q.size > 1) throw new Error("some chapters are 720p drafts and some are 1080p: render them at one quality first");
      const hash = joinInput(s);
      ctx.progress(0, "joining chapters");
      await concat(dir, { ...s.sb, chapters: s.sb.chapters.slice(0, s.count) }, { signal, log });
      if (hash)
        await withLock(dir, () => {
          record(dir, "join", hash);
          touch(dir);
        });
      return ctx.progress(1);
    }
    case "export":
      throw new Error("export runs through exportVideos");
  }
}

/** Records the current input hash of every stage whose output exists (migration: trust what is on disk). */
export function adoptOutputs(dir: string, deps: StageDeps = {}, quality: Quality = "1080p") {
  return withLock(dir, () => {
    const s = snapshot(dir, deps.globalPronounce);
    const P = s.P;
    mutateState(dir, (st) => {
      const set = (key: string, hash: string | null, ok: boolean, extra: { quality?: Quality; props?: string } = {}) => {
        if (ok && hash) st.stages[key] = { hash, at: now(), ...extra };
      };
      set("ingest", ingestInput(s), isFile(P.chunks));
      set("outline", outlineInput(s), !!s.outline);
      for (let n = 1; n <= s.count; n++) {
        set(stageKey("storyboard", n), storyboardInput(s, n), !!s.sb?.chapters[n - 1]);
        set(stageKey("voice", n), voiceInput(s, n), isFile(P.audio(n)) && isFile(P.timing(n)));
        set(stageKey("render", n), renderInput(s, n, quality), isFile(P.chapterMp4(n)), { quality, props: renderProps(s, n) ?? undefined });
      }
      s.state = st;
      set("join", joinInput(s), existsSync(P.final));
    });
  });
}

/**
 * `rehash` for one bundle, or every bundle under a folder (a whole library):
 * adopts the current renderer-version formula for renders whose props are
 * unchanged (see rehashRenders). Returns what it did per bundle.
 */
export async function rehash(target: string, deps: StageDeps = {}): Promise<{ dir: string; chapters: number[] }[]> {
  const bundles: string[] = [];
  const walk = (d: string) => {
    if (isFile(join(d, "project.json"))) return void bundles.push(d);
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory() && !e.name.startsWith(".")) walk(join(d, e.name));
  };
  walk(target);
  const out: { dir: string; chapters: number[] }[] = [];
  for (const dir of bundles.sort()) out.push({ dir, chapters: await withLock(dir, () => rehashRenders(dir, deps.globalPronounce)) });
  return out;
}
