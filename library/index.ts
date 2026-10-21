/**
 * Lane A: the Library (shared/library.ts) over real directories.
 *
 * Folders are directories under the root; a video is a directory ending in
 * `.emoton`. Ids live in each bundle's project.json and map to dirs by
 * scanning (cached, rescanned on a miss). All stage work goes through
 * pipeline/stages.ts, so the CLI and the app keep state.json the same way.
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type {
  AddSourcesRequest, Brief, ChapterVoice, CreateVideoRequest, ExportRequest, FolderNode, LibraryTree, SeriesEpisode, ShortDocument, ShortTake, SourceInfo,
  ValidationError, VideoDetail, VideoState, VideoSummary,
} from "../shared/api.ts";
import type { Library, LibraryOptions, PlannedStep, PlanOptions, StepContext, Upload } from "../shared/library.ts";
import type { ChapterMarker } from "../shared/api.ts";
import type { Chapter } from "../schema/storyboard.ts";
import { Short } from "../schema/short.ts";
import { exportOne, missingFor, safeName } from "../pipeline/export.ts";
import { isYouTube } from "../pipeline/ingest.ts";
import { throwIfAborted } from "../pipeline/proc.ts";
import { BUNDLE_EXT, Project, isFile, isUrl, maybe, paths, readJson, slugOf, sourceFile, writeJson, type Chunk, type Source } from "../pipeline/project.ts";
import { chapterProps } from "../pipeline/render.ts";
import { runStage, storeChapter, storeOutline, type StageDeps } from "../pipeline/stages.ts";
import {
  mutateState, outlineInput, ownStatuses, planSteps, snapshot, storyboardInput, videoState, videoStatus, withLock, type Snapshot,
} from "../pipeline/state.ts";
import type { Tts } from "../pipeline/voice.ts";
import { chapterVoice, isPauseEdits, loadVideoEdits, saveChapterEdits } from "../pipeline/voice-edits.ts";
import { renameEdits, type Rename } from "../src/core/short/voice.ts";
import { slidesPdf } from "../pipeline/slides-pdf.ts";
import { SHORT_VOICE, loadShort, shortPreview, spokenScenes, voiceShort, voiceStatus } from "../pipeline/short.ts";
import { footageFiles, makeProxy, needsProxy } from "../pipeline/proxy.ts";
import { filePeaks } from "../pipeline/peaks.ts";
import { bundleNameFor, ensureSoundsRoot, listSounds, soundFile } from "../pipeline/sounds.ts";
import { exportShort } from "../pipeline/short-export.ts";
import { PERDIX_REPO, behindMain, hasTool, perdixCommit, renderShot, searchStarts, shotKinds, shotStates } from "../pipeline/shots.ts";
import { DRAFT_FILE, draftShort } from "../pipeline/short-draft.ts";
import { ASK_FILE, askShort, type AskProposal } from "../pipeline/short-ask.ts";
import { analyzeSong, clipMotion, liveliest, type ClipMotion } from "../pipeline/beats.ts";
import { editFromSong } from "../src/core/short/edit-song.ts";
import { estimatedVoice, voiceMatches } from "../src/core/short/estimate.ts";
import { resolveShort } from "../src/core/short/resolve.ts";
import { SERIES, episodeOf, nextEpisode } from "../src/core/short/series.ts";
import { TEMPLATES, startShort } from "../src/core/short/templates.ts";
import type { ChapterTiming } from "../schema/storyboard.ts";
import { defaultSoundsRoot } from "../pipeline/sounds-root.ts";
import type { Writer } from "../pipeline/write.ts";
import { badInput, conflict, invalid, notFound } from "./errors.ts";
import { autoTitle, checkFolderName, defaultTrash, moveAcross, moveToTrash, slugify, tildePath, uniqueName } from "./files.ts";

export { LibraryError } from "./errors.ts";

export type CreateLibraryOptions = LibraryOptions & {
  /** Where trashed folders, videos and sources go. Default ~/.Trash. */
  trashDir?: string;
  /** Replaces the claude CLI (tests). */
  writer?: Writer;
  /** Replaces speak.py (tests). */
  tts?: Tts;
};

const isBundleName = (name: string) => name.endsWith(BUNDLE_EXT) && name.length > BUNDLE_EXT.length;
const hidden = (name: string) => name.startsWith(".");
const now = () => new Date().toISOString();
const quiet: StepContext = { signal: new AbortController().signal, progress: () => {}, log: () => {} };

export function createLibrary(opts: CreateLibraryOptions): Library {
  const root = opts.root;
  mkdirSync(root, { recursive: true });
  const trashDir = opts.trashDir ?? defaultTrash();
  const deps: StageDeps = { globalPronounce: opts.globalPronounce ?? {}, writer: opts.writer, tts: opts.tts };
  const ids = new Map<string, string>();

  // ------------------------------------------------------------ paths

  /** Library-relative folder path -> absolute dir. "" = root. Throws on escapes and bundles. */
  function folderAbs(rel: string, mustExist = true): string {
    const r = (rel ?? "").replace(/^\/+|\/+$/g, "");
    if (!r) return root;
    const norm = normalize(r);
    if (isAbsolute(norm) || norm.split(sep).some((s) => s === ".." || s === "." || hidden(s) || isBundleName(s)))
      throw badInput(`not a folder: ${rel}`);
    const abs = join(root, norm);
    if (mustExist && !(existsSync(abs) && statSync(abs).isDirectory())) throw notFound(`no folder ${rel}`);
    return abs;
  }
  const relOf = (abs: string) => relative(root, abs).split(sep).join("/");

  // ------------------------------------------------------------ scanning

  type Scan = { tree: FolderNode; bundles: { dir: string; folder: string }[] };

  function scan(): Scan {
    const found: { dir: string; folder: string; raw: Record<string, unknown> }[] = [];
    const walk = (abs: string): FolderNode => {
      const node: FolderNode = { path: relOf(abs), name: abs === root ? basename(root) : basename(abs), folders: [], videos: 0, total: 0 };
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return node;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || hidden(e.name)) continue;
        const child = join(abs, e.name);
        if (isBundleName(e.name)) {
          const raw = maybe(() => readJson<Record<string, unknown>>(join(child, "project.json")));
          if (!raw) continue;
          found.push({ dir: child, folder: node.path, raw });
          node.videos++;
        } else {
          node.folders.push(walk(child));
        }
      }
      node.total = node.videos + node.folders.reduce((s, f) => s + f.total, 0);
      return node;
    };
    const tree = walk(root);
    assignIds(found);
    return { tree, bundles: found.map(({ dir, folder }) => ({ dir, folder })) };
  }

  /**
   * Gives every bundle a unique id. A bundle without one gets a new one. When
   * several share an id (a Finder duplicate), the original keeps it, decided
   * the same way on every scan: older `created`, then older birth time, then
   * a name without "copy", then path order. The others get fresh ids.
   */
  function assignIds(found: { dir: string; raw: Record<string, unknown> }[]) {
    const give = (f: { dir: string; raw: Record<string, unknown> }) => {
      const id = randomUUID();
      f.raw = { ...f.raw, id, created: f.raw.created ?? now(), updated: now() };
      writeJson(join(f.dir, "project.json"), f.raw);
    };
    const groups = new Map<string, typeof found>();
    for (const f of found) {
      if (typeof f.raw.id !== "string" || !f.raw.id) give(f);
      const id = f.raw.id as string;
      groups.set(id, [...(groups.get(id) ?? []), f]);
    }
    const created = (f: (typeof found)[number]) => {
      const t = Date.parse(String(f.raw.created ?? ""));
      return Number.isNaN(t) ? Infinity : t;
    };
    const born = (f: (typeof found)[number]) => maybe(() => statSync(f.dir).birthtimeMs) || Infinity;
    const copyish = (f: (typeof found)[number]) => (/[\s-]copy(\s\d+|-\d+)?\.emoton$/i.test(basename(f.dir)) ? 1 : 0);
    ids.clear();
    for (const [id, group] of groups) {
      group.sort((a, b) => created(a) - created(b) || born(a) - born(b) || copyish(a) - copyish(b) || a.dir.localeCompare(b.dir));
      ids.set(id, group[0]!.dir);
      for (const copy of group.slice(1)) {
        give(copy);
        ids.set(copy.raw.id as string, copy.dir);
      }
    }
  }

  async function resolve(id: string): Promise<string> {
    const hit = ids.get(id);
    if (hit && maybe(() => readJson<{ id?: string }>(join(hit, "project.json")).id) === id) return hit;
    scan();
    const dir = ids.get(id);
    if (!dir) throw notFound("unknown video");
    return dir;
  }

  // ------------------------------------------------------------ views

  const snap = (dir: string) => snapshot(dir, deps.globalPronounce);

  function summaryOf(s: Snapshot, st: VideoState): VideoSummary {
    const p = s.project;
    const markers = readMarkers(s);
    // a Short has none of the explainer's stages: it is a draft until it is exported
    const status = p.kind === "short" ? (isFile(s.P.final) ? "ready" : "draft") : videoStatus(st);
    return {
      id: p.id!,
      slug: slugOf(s.dir),
      kind: p.kind ?? "explainer",
      title: p.title,
      folder: relOf(dirname(s.dir)),
      status,
      minutes: p.minutes,
      ...(status === "ready" && markers?.length ? { duration: markers[markers.length - 1]!.end } : {}),
      chapters: s.count,
      ...(isFile(s.P.thumb) ? { thumb: `/media/${p.id}/thumb.jpg` } : {}),
      created: p.created ?? p.updated ?? now(),
      updated: p.updated ?? p.created ?? now(),
    };
  }

  const readMarkers = (s: Snapshot) => (isFile(s.P.markers) ? maybe(() => readJson<ChapterMarker[]>(s.P.markers)) : undefined);

  function briefOf(p: Project): Brief {
    return {
      title: p.title, topic: p.topic, audience: p.audience, minutes: p.minutes, rules: p.rules,
      voice: p.voice, pronounce: p.pronounce, writerModel: p.writerModel, captions: p.captions, layout: p.layout ?? "stage",
    };
  }

  function sourcesOf(s: Snapshot): SourceInfo[] {
    const sum = s.state.sources ?? {};
    let counts: Record<string, number> | undefined;
    const count = (id: string) => {
      counts ??= (maybe(() => readJson<Chunk[]>(s.P.chunks)) ?? []).reduce<Record<string, number>>((m, c) => ((m[c.source] = (m[c.source] ?? 0) + 1), m), {});
      return counts[id] ?? 0;
    };
    return s.project.sources.map((src) => {
      const k = sum[src.id];
      const kind: SourceInfo["kind"] = isUrl(src.path) ? (isYouTube(src.path) ? "youtube" : "url") : src.path.toLowerCase().endsWith(".pdf") ? "pdf" : "text";
      const chunks = k?.chunks ?? count(src.id);
      return {
        id: src.id, title: src.title, kind, ref: src.path,
        ...(k?.pages !== undefined ? { pages: k.pages } : {}),
        chunks,
        ...(k?.noText || (isFile(s.P.chunks) && chunks === 0) ? { noText: true } : {}),
      };
    });
  }

  /** Chapter n as the Voice tab shows it, or null when its voice is missing or out of date. */
  function voicedChapter(id: string, s: Snapshot, n: number): ChapterVoice | null {
    if (ownStatuses(s).chapters[n - 1]?.voice !== "ok") return null;
    const c = chapterVoice(s.dir, n);
    if (!c) return null;
    const title = s.sb?.chapters[n - 1]?.title ?? s.outline?.chapters[n - 1]?.title ?? `Chapter ${n}`;
    // the file's time in the URL, so a player holding the old voice fetches the edited one
    const audio = `/media/${encodeURIComponent(id)}/${s.P.audioRel(n)}?v=${Math.round(statSync(s.P.audio(n)).mtimeMs)}`;
    return { ...c, title, timing: { ...c.timing, audio } };
  }

  async function detailOf(dir: string): Promise<VideoDetail> {
    const s = snap(dir);
    const st = videoState(s);
    const markers = readMarkers(s);
    const chapters: (Chapter | null)[] = Array.from({ length: s.count }, (_, i) => s.sb?.chapters[i] ?? null);
    return {
      summary: summaryOf(s, st),
      dir,
      brief: briefOf(s.project),
      sources: sourcesOf(s),
      ...(s.outline ? { outline: s.outline } : {}),
      chapters,
      state: st,
      ...(isFile(s.P.final) ? { video: `/media/${s.project.id}/${s.P.finalRel}` } : {}),
      ...(markers ? { markers } : {}),
    };
  }

  // ------------------------------------------------------------ Shorts

  const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  /** The revision of a short.json: a hash of the file as saved. */
  const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

  function shortFile(dir: string): { text: string; revision: string } {
    if (readJson(paths(dir).project, Project).kind !== "short") throw badInput("this video is not a Short");
    const file = paths(dir).short;
    if (!isFile(file)) throw notFound("the Short has no short.json");
    const text = readFileSync(file, "utf8");
    return { text, revision: revisionOf(text) };
  }

  function readShort(dir: string): ShortDocument {
    const { text, revision } = shortFile(dir);
    const json = maybe(() => JSON.parse(text) as unknown);
    if (json === undefined) throw invalid("short.json is not JSON");
    const parsed = Short.safeParse(json);
    if (!parsed.success) throw invalid(`short.json: ${issues(parsed.error).join("; ")}`);
    return { document: parsed.data, revision };
  }

  const projectOf = (dir: string) => readJson(paths(dir).project, Project);
  const isShort = (dir: string) => projectOf(dir).kind === "short";
  const shortPronounce = (p: Project) => ({ ...deps.globalPronounce, ...p.pronounce });

  /**
   * A Short's stages outside its editor: its voice (make, voice or render),
   * then its shots and the proxies of its footage (make), each only when
   * missing or stale, and its export (render: always, it renders only the
   * scenes that changed).
   */
  function planShort(dir: string, kind: string, note?: string): PlannedStep[] {
    if (kind === "ask") {
      if (!note?.trim()) throw badInput("ask what to change: the request is the job's note");
      return [{ stage: "ask", lane: "write", note: note.trim() }];
    }
    if (kind === "draft") {
      if (loadShort(dir).template === "edit") {
        if (!songOf(dir)) throw badInput("an edit is cut to a song: add one first");
        if (!clipsOf(dir).length) throw badInput("an edit cuts clips to the song: add some first");
        return [{ stage: "draft", lane: "media", ...(note ? { note } : {}) }];
      }
      if (!projectOf(dir).topic.trim()) throw badInput("a draft needs a brief: give the Short one first");
      return [{ stage: "draft", lane: "write" }];
    }
    if (kind !== "make" && kind !== "voice" && kind !== "render") throw badInput(`a Short is made in its editor: it has no ${kind} job`);
    const doc = loadShort(dir), p = projectOf(dir);
    const steps: PlannedStep[] = [];
    // the voice first: its timing moves every cue pinned to a word, so shots rendered before it would render again
    const voice = spokenScenes(doc).length && voiceStatus(dir, doc, p, shortPronounce(p)) !== "ok";
    if (voice) steps.push({ stage: "voice", chapter: SHORT_VOICE, lane: "media" });
    // (whether a shot goes stale is known once the voice is made: plan the step when any shot could render)
    const renderable = voice && doc.scenes.some((s) => s.visual?.type === "shot" && hasTool(s.visual.build));
    if (kind === "make" && (renderable || shotsToRender(dir).length)) steps.push({ stage: "shots", lane: "media" });
    if (kind === "make" && (renderable || footageFiles(doc).some((f) => needsProxy(dir, f)))) steps.push({ stage: "proxies", lane: "media" });
    if (kind === "render") steps.push({ stage: "render", lane: "media" });
    return steps;
  }

  /** The Short resolved as it plays now (its voice while it matches, else the estimate). */
  function resolvedNow(dir: string) {
    const doc = loadShort(dir), P = paths(dir);
    const voiced = isFile(P.timing(SHORT_VOICE)) ? maybe(() => readJson<ChapterTiming>(P.timing(SHORT_VOICE))) : undefined;
    return resolveShort(doc, { voice: voiced && voiceMatches(doc, voiced) ? voiced : estimatedVoice(doc) });
  }
  /** The shots whose render is missing or older than their knobs, and that have a tool to render them. */
  function shotsToRender(dir: string) {
    const r = maybe(() => resolvedNow(dir));
    if (!r) return [];
    const st = shotStates(dir, r);
    return r.shots.filter((x) => ["stale", "missing"].includes(st.find((s) => s.scene === x.scene)?.state ?? ""));
  }

  /** A series' Shorts in the library, by episode. */
  function seriesEpisodes(id: string): SeriesEpisode[] {
    const out: SeriesEpisode[] = [];
    for (const b of scan().bundles) {
      try {
        if (!isShort(b.dir)) continue;
        const doc = loadShort(b.dir);
        if (doc.series !== id) continue;
        const s = snap(b.dir), sum = summaryOf(s, videoState(s));
        const r = maybe(() => resolvedNow(b.dir));
        const last = r?.scenes.at(-1);
        const shot = doc.scenes.map((x) => x.visual).find((v) => v?.type === "shot");
        out.push({
          id: sum.id, title: sum.title, status: sum.status, episode: episodeOf(doc),
          ...(last ? { seconds: +(last.from + last.seconds).toFixed(2) } : {}),
          ...(shot?.type === "shot" ? { build: shot.build } : {}),
        });
      } catch {
        /* an unreadable bundle is left out */
      }
    }
    return out.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title));
  }

  /** The build a draft's shots use: Perdix's main when its tool is built, else the series' last episode's, else main. */
  function draftBuild(doc: Short): { build: string; note?: string } {
    const main = perdixCommit("main");
    if (main && hasTool(main)) return { build: main };
    const pinned = doc.series ? [...seriesEpisodes(doc.series)].reverse().find((e) => e.build)?.build : undefined;
    if (pinned) {
      const behind = behindMain(pinned);
      return { build: pinned, ...(behind ? { note: `the shots use ${pinned}, the last episode's build; Perdix's main is ${behind} commits ahead (Rebuild at main in the shot panel)` } : {}) };
    }
    return main ? { build: main, note: `no shot tool at Perdix's main (${main}) yet: Rebuild at main in the shot panel` } : { build: "0000000", note: "no Perdix checkout found: the shots have no build" };
  }

  const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg)$/i, VIDEO = /\.(mp4|mov|m4v|webm)$/i;
  const filesIn = (dir: string, sub: string, re: RegExp) => {
    const d = join(dir, "assets", sub);
    return existsSync(d) ? readdirSync(d).filter((f) => re.test(f) && !f.includes(".part.")).map((f) => `assets/${sub}/${f}`) : [];
  };
  /** The song an edit is cut to: the one it uses, else the newest in assets/music/. */
  function songOf(dir: string): string | undefined {
    const m = loadShort(dir).music?.source;
    if (m && "file" in m && isFile(join(dir, m.file.asset))) return m.file.asset;
    return filesIn(dir, "music", AUDIO).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
  }
  const clipsOf = (dir: string) => filesIn(dir, "clips", VIDEO);

  /** An edit's draft: the song's beats and drop, each clip's liveliest stretches, cut by editFromSong ("reroll": a new order). */
  async function cutToSong(dir: string, step: PlannedStep, ctx: StepContext) {
    const start = loadShort(dir), song = songOf(dir)!, clips = clipsOf(dir);
    ctx.progress(0.02, "finding the song's beats and drop");
    const a = await analyzeSong(dir, join(dir, song), ctx.signal);
    const motion: ClipMotion[] = [];
    for (const [i, c] of clips.entries()) {
      ctx.progress(0.2 + (0.75 * i) / clips.length, `finding the liveliest moments (clip ${i + 1} of ${clips.length})`);
      motion.push(await clipMotion(dir, join(dir, c), ctx.signal));
    }
    const seed = step.note === "reroll" ? Math.floor(Math.random() * 1e9) : 1;
    const doc = editFromSong({
      title: start.title, seed, song: { asset: song, ...a },
      clips: clips.map((asset, i) => ({ asset, seconds: motion[i]!.seconds, lively: (len, used) => liveliest(motion[i]!, len, used) })),
    });
    // a series' episode keeps its series and its numbered end card, on the last cut
    const end = start.text.find((x) => x.role === "end"), last = doc.scenes.at(-1)!.id;
    if (start.series) doc.series = start.series;
    if (end) doc.text.push({ ...end, from: { scene: last, edge: "end", offset: -Math.min(3, doc.scenes.at(-1)!.hold ?? 3) }, to: { scene: last, edge: "end" } });
    await withLock(dir, () => {
      writeJson(paths(dir).short, doc);
      writeJson(join(dir, DRAFT_FILE), { at: now(), attempts: 1, notes: [`${a.bpm} BPM, first beat at ${a.firstBeat} s, the drop at ${a.dropAt} s into the song: if a cut feels off the beat, set the tempo or the drop in the music inspector and re-roll`] });
      const file = paths(dir).project;
      writeJson(file, { ...readJson<Record<string, unknown>>(file), updated: now() });
    });
    ctx.log(`draft: ${doc.scenes.length} cuts on ${a.bpm} BPM, the drop at ${a.dropAt} s`);
    ctx.progress(1);
  }

  async function runShortStep(dir: string, step: PlannedStep, ctx: StepContext) {
    if (step.stage === "draft" && loadShort(dir).template === "edit") return cutToSong(dir, step, ctx);
    if (step.stage === "ask") {
      const { document, revision } = readShort(dir), p = projectOf(dir);
      const timing = isFile(paths(dir).timing(SHORT_VOICE)) ? maybe(() => readJson<ChapterTiming>(paths(dir).timing(SHORT_VOICE))) : undefined;
      ctx.progress(0.05, "Claude is working on it");
      const out = await askShort(document, step.note!, {
        writer: deps.writer, model: p.writerModel, kinds: shotKinds(), voice: timing, signal: ctx.signal, log: ctx.log,
        onAttempt: (n) => ctx.progress(0.05 + (n - 1) * 0.3, n === 1 ? "Claude is working on it" : `Claude is fixing its change (try ${n} of 3)`),
      });
      const proposal: AskProposal = { at: now(), request: step.note!, summary: out.summary, base: revision, document: out.document };
      await withLock(dir, () => writeJson(join(dir, ASK_FILE), proposal));
      ctx.log(`ask: a change proposed in ${out.attempts} ${out.attempts === 1 ? "try" : "tries"}`);
      return ctx.progress(1);
    }
    if (step.stage === "draft") {
      const start = loadShort(dir), p = projectOf(dir);
      const { build, note } = draftBuild(start);
      ctx.progress(0.05, "Claude is drafting");
      const out = await draftShort(start, {
        writer: deps.writer, model: p.writerModel, brief: p.topic, build, kinds: shotKinds(), repo: tildePath(PERDIX_REPO), signal: ctx.signal, log: ctx.log,
        onAttempt: (n) => ctx.progress(0.05 + (n - 1) * 0.3, n === 1 ? "Claude is drafting" : `Claude is fixing the draft (try ${n} of 3)`),
      });
      await withLock(dir, () => {
        writeJson(paths(dir).short, out.doc);
        writeJson(join(dir, DRAFT_FILE), { at: now(), attempts: out.attempts, notes: [...(note ? [note] : []), ...out.notes] });
        const file = paths(dir).project;
        writeJson(file, { ...readJson<Record<string, unknown>>(file), updated: now() });
      });
      ctx.log(`draft: ${out.doc.scenes.length} scenes in ${out.attempts} ${out.attempts === 1 ? "try" : "tries"}`);
      return ctx.progress(1);
    }
    if (step.stage === "shots") {
      const todo = shotsToRender(dir);
      for (const [i, x] of todo.entries()) {
        ctx.progress(i / todo.length, `rendering shot ${x.scene} (${i + 1} of ${todo.length})`);
        await renderShot(dir, x, { signal: ctx.signal, progress: (p) => ctx.progress((i + p) / todo.length, `rendering shot ${x.scene} (${i + 1} of ${todo.length})`) });
      }
      ctx.log(`shots: ${todo.length} rendered`);
      return ctx.progress(1);
    }
    if (step.stage === "proxies") {
      const todo = footageFiles(loadShort(dir)).filter((f) => needsProxy(dir, f));
      for (const [i, f] of todo.entries()) {
        ctx.progress(i / todo.length, `proxy ${i + 1} of ${todo.length}: ${f}`);
        await makeProxy(dir, f, ctx.signal);
      }
      ctx.log(`proxies: ${todo.length} made`);
      return ctx.progress(1);
    }
    if (step.stage === "render") {
      try {
        await exportShort(dir, { soundsRoot: opts.soundsRoot, signal: ctx.signal, log: ctx.log, progress: ctx.progress });
      } catch (e) {
        if (!ctx.signal.aborted) {
          const message = e instanceof Error ? e.message : String(e);
          await withLock(dir, () => mutateState(dir, (s) => void (s.lastError = { stage: "render", message, at: now() }))).catch(() => {});
        }
        throw e;
      }
      await withLock(dir, () => mutateState(dir, (s) => void delete s.lastError));
      return;
    }
    if (step.stage !== "voice") throw badInput(`a Short is made in its editor: it has no ${step.stage} stage`);
    try {
      await voiceShort(dir, {
        signal: ctx.signal, pronounce: shortPronounce(projectOf(dir)), tts: deps.tts, log: ctx.log,
        onProgress: (d, t) => ctx.progress(d / t, `voicing, sentence ${d} of ${t}`),
      });
    } catch (e) {
      // recorded like an explainer stage's failure, so the app shows it on the video
      if (!ctx.signal.aborted) {
        const message = e instanceof Error ? e.message : String(e);
        await withLock(dir, () => mutateState(dir, (s) => void (s.lastError = { stage: "voice", chapter: SHORT_VOICE, message, at: now() }))).catch(() => {});
      }
      throw e;
    }
    await withLock(dir, () => mutateState(dir, (s) => void delete s.lastError));
    ctx.progress(1);
  }

  // ------------------------------------------------------------ sources

  function sourceId(base: string, taken: Set<string>): string {
    const first = base.toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? "src";
    const stem = first.slice(0, 8);
    let id = stem;
    for (let i = 2; taken.has(id); i++) id = `${stem}${i}`;
    taken.add(id);
    return id;
  }

  /** Copies files into sources/ and turns files and URLs into Source entries. */
  function addSourceEntries(dir: string, existing: Source[], files: { name: string; path: string }[], urls: string[]): Source[] {
    const taken = new Set(existing.map((s) => s.id));
    const out: Source[] = [];
    const srcDir = paths(dir).sources;
    mkdirSync(srcDir, { recursive: true });
    for (const f of files) {
      if (!isFile(f.path)) throw badInput(`no file at ${f.path}`);
      const clean = basename(f.name).replace(/[\/\\\x00-\x1f]/g, "_").replace(/^\.+/, "") || "source";
      const name = uniqueName(srcDir, clean, true);
      copyFileSync(f.path, join(srcDir, name));
      const stem = name.slice(0, name.length - extname(name).length);
      out.push({ id: sourceId(stem, taken), title: stem.replace(/[_\s-]+/g, " ").trim() || stem, path: `sources/${name}` });
    }
    for (const u of urls) {
      const url = u.trim();
      if (!isUrl(url)) throw badInput(`not a web address: ${u}`);
      const parsed = new URL(url);
      const yt = isYouTube(url);
      out.push({
        id: sourceId(yt ? "yt" : parsed.hostname.replace(/^www\./, "").split(".")[0] ?? "web", taken),
        title: yt ? "YouTube video" : (parsed.hostname.replace(/^www\./, "") + parsed.pathname).replace(/\/$/, "").slice(0, 60),
        path: url,
      });
    }
    return out;
  }

  const fileList = (sourcePaths: string[] | undefined, uploads: Upload[] | undefined) => [
    ...(sourcePaths ?? []).map((p) => ({ name: basename(p), path: p })),
    ...(uploads ?? []).map((u) => ({ name: u.name, path: u.tmpPath })),
  ];

  /** Re-reads the sources. A failure is recorded as lastError (the video stays usable); never throws. */
  async function ingestQuietly(dir: string) {
    await runStage(dir, { stage: "ingest", lane: "write" }, quiet, deps).catch(() => {});
  }

  async function editProject(dir: string, fn: (raw: Record<string, unknown>, p: Project) => Project | void) {
    await withLock(dir, () => {
      const file = paths(dir).project;
      const raw = readJson<Record<string, unknown>>(file);
      const p = Project.parse(raw);
      const next = fn(raw, p) ?? p;
      const checked = Project.safeParse({ ...raw, ...next });
      if (!checked.success) throw invalid(checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      writeJson(file, { ...raw, ...checked.data, updated: now() });
    });
  }

  /** Renames a bundle dir, keeping out/<slug>.mp4 named after the new slug. */
  async function renameBundle(from: string, to: string, oldSlug = slugOf(from)) {
    await moveAcross(from, to);
    const b = paths(to);
    const oldFinal = join(to, "out", `${oldSlug}.mp4`);
    if (oldSlug !== b.slug && existsSync(oldFinal)) renameSync(oldFinal, b.final);
  }

  const uniqueBundle = (folder: string, slug: string) => {
    let s = slug;
    for (let i = 2; existsSync(join(folder, s + BUNDLE_EXT)); i++) s = `${slug}-${i}`;
    return join(folder, s + BUNDLE_EXT);
  };

  // ------------------------------------------------------------ the Library

  const lib: Library = {
    root,

    async tree(): Promise<LibraryTree> {
      const { tree, bundles } = scan();
      const videos: VideoSummary[] = [];
      for (const b of bundles) {
        try {
          const s = snap(b.dir);
          videos.push(summaryOf(s, videoState(s)));
        } catch {
          /* an unreadable bundle is left out, not fatal */
        }
      }
      return { root, tree, videos };
    },

    async createFolder(parent, name) {
      const abs = join(folderAbs(parent), checkFolderName(name));
      if (existsSync(abs)) throw conflict(`${name.trim()} already exists`);
      mkdirSync(abs);
      return relOf(abs);
    },

    async updateFolder(path, change) {
      const from = folderAbs(path);
      if (from === root) throw badInput("the library root cannot be renamed here");
      const parent = change.parent !== undefined ? folderAbs(change.parent) : dirname(from);
      const to = join(parent, change.name !== undefined ? checkFolderName(change.name) : basename(from));
      if (to === from) return relOf(from);
      if (to.startsWith(from + sep)) throw conflict("a folder cannot move into itself");
      const sameDir = maybe(() => {
        const x = statSync(from), y = statSync(to);
        return x.ino === y.ino && x.dev === y.dev;
      });
      if (sameDir) {
        // Only the case changed (docs -> Docs) on a case-insensitive disk: go through a temporary name.
        const tmp = join(dirname(to), `.${basename(to)}.renaming-${randomUUID().slice(0, 8)}`);
        renameSync(from, tmp);
        renameSync(tmp, to);
        ids.clear();
        return relOf(to);
      }
      if (existsSync(to)) throw conflict(`${relOf(to)} already exists`);
      await moveAcross(from, to);
      ids.clear();
      return relOf(to);
    },

    async trashFolder(path) {
      const abs = folderAbs(path);
      if (abs === root) throw badInput("the library root cannot be trashed");
      await moveToTrash(abs, trashDir);
      ids.clear();
    },

    async createVideo(req: CreateVideoRequest, uploads?: Upload[]) {
      const folder = folderAbs(req.folder);
      const topic = req.brief.topic?.trim();
      if (!topic) throw badInput("say what the video should explain");
      const given = req.brief.title?.trim();
      const title = given || autoTitle(topic);
      // new videos are slides videos unless the request says otherwise
      const brief: Brief = { ...opts.defaults, layout: "slides", ...req.brief, title, topic } as Brief;
      const dir = uniqueBundle(folder, slugify(title));
      mkdirSync(dir);
      try {
        const sources = addSourceEntries(dir, [], fileList(req.sourcePaths, uploads), req.urls ?? []);
        const t = now();
        const parsed = Project.safeParse({ id: randomUUID(), created: t, updated: t, titleAuto: !given, ...brief, sources });
        if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        const project = parsed.data;
        writeJson(paths(dir).project, project);
        writeJson(paths(dir).state, { version: 1, stages: {} });
        ids.set(project.id!, dir);
      } catch (e) {
        rmSync(dir, { recursive: true, force: true }); // only what this call just made
        throw e;
      }
      await ingestQuietly(dir);
      return detailOf(dir);
    },

    resolve,

    async detail(id) {
      return detailOf(await resolve(id));
    },

    async state(id) {
      return videoState(snap(await resolve(id)));
    },

    async updateBrief(id, patch) {
      const dir = await resolve(id);
      const keys = ["title", "topic", "audience", "minutes", "rules", "voice", "pronounce", "writerModel", "captions", "layout"] as const;
      await editProject(dir, (_raw, p) => {
        const next: Project = { ...p };
        for (const k of keys) if (patch[k] !== undefined) (next as Record<string, unknown>)[k] = patch[k];
        if (patch.title !== undefined) {
          next.title = patch.title.trim();
          if (!next.title) throw badInput("a video needs a title");
          next.titleAuto = false;
        }
        return next;
      });
      return detailOf(dir);
    },

    async saveOutline(id, outline): Promise<VideoDetail | ValidationError> {
      const dir = await resolve(id);
      const r = await storeOutline(dir, outline, outlineInput(snap(dir)));
      if ("errors" in r) return r;
      return detailOf(dir);
    },

    async saveChapter(id, n, chapter): Promise<VideoDetail | ValidationError> {
      const dir = await resolve(id);
      const r = await storeChapter(dir, n, chapter, storyboardInput(snap(dir), n));
      if ("errors" in r) return r;
      return detailOf(dir);
    },

    async addSources(id, req: AddSourcesRequest, uploads?: Upload[]) {
      const dir = await resolve(id);
      await editProject(dir, (_raw, p) => {
        const added = addSourceEntries(dir, p.sources, fileList(req.sourcePaths, uploads), req.urls ?? []);
        return { ...p, sources: [...p.sources, ...added] };
      });
      await ingestQuietly(dir);
      return detailOf(dir);
    },

    async removeSource(id, sourceId) {
      const dir = await resolve(id);
      let file: string | undefined;
      await editProject(dir, (_raw, p) => {
        const src = p.sources.find((s) => s.id === sourceId);
        if (!src) throw notFound(`no source ${sourceId}`);
        // Only a file inside this bundle's sources/ folder is ever moved to the Trash.
        if (!isUrl(src.path)) file = maybe(() => sourceFile(dir, src));
        return { ...p, sources: p.sources.filter((s) => s.id !== sourceId) };
      });
      if (file && existsSync(file)) await moveToTrash(file, trashDir);
      await withLock(dir, () => mutateState(dir, (s) => void (s.sources && delete s.sources[sourceId])));
      await ingestQuietly(dir);
      return detailOf(dir);
    },

    async moveVideo(id, folder) {
      const dir = await resolve(id);
      const target = folderAbs(folder);
      if (dirname(dir) === target) return detailOf(dir);
      const to = uniqueBundle(target, slugOf(dir));
      await withLock(dir, () => renameBundle(dir, to));
      ids.set(id, to);
      return detailOf(to);
    },

    async duplicateVideo(id) {
      const dir = await resolve(id);
      const to = uniqueBundle(dirname(dir), `${slugOf(dir)}-copy`);
      const tmp = join(dirname(dir), `.${basename(to)}.copying`);
      await rm(tmp, { recursive: true, force: true }); // a copy an earlier crash left behind
      await withLock(dir, () => cp(dir, tmp, { recursive: true, preserveTimestamps: true }));
      try {
        await renameBundle(tmp, to, slugOf(dir));
        const file = paths(to).project;
        const raw = readJson<Record<string, unknown>>(file);
        const newId = randomUUID();
        const t = now();
        writeJson(file, { ...raw, id: newId, title: `${raw.title as string} (copy)`, titleAuto: false, created: t, updated: t });
        await withLock(to, () => mutateState(to, (s) => void delete s.lastError));
        ids.set(newId, to);
      } catch (e) {
        await rm(tmp, { recursive: true, force: true });
        throw e;
      }
      return detailOf(to);
    },

    async trashVideo(id) {
      const dir = await resolve(id);
      await withLock(dir, () => moveToTrash(dir, trashDir));
      ids.delete(id);
    },

    async previewProps(id, n) {
      const dir = await resolve(id);
      const s = snap(dir);
      if (!s.sb?.chapters[n - 1]) throw notFound(`chapter ${n} has no storyboard yet`);
      // Voiced timing only when it matches the current narration; otherwise estimated and silent.
      const voiced = ownStatuses(s).chapters[n - 1]?.voice === "ok";
      const props = chapterProps(dir, s.project, s.sb, n, voiced);
      // the file's time in the URL, so the player fetches the voice again after a pause edit
      props.timing = { ...props.timing, audio: voiced ? `/media/${id}/${s.P.audioRel(n)}?v=${Math.round(statSync(s.P.audio(n)).mtimeMs)}` : "" };
      return props;
    },

    async voice(id) {
      const dir = await resolve(id);
      if (isShort(dir)) {
        // a Short's voice is chapter 1's files, while it matches the script
        const doc = loadShort(dir), p = projectOf(dir);
        const c = voiceStatus(dir, doc, p, shortPronounce(p)) === "ok" ? chapterVoice(dir, SHORT_VOICE) : null;
        const audio = c && `/media/${encodeURIComponent(id)}/${paths(dir).audioRel(SHORT_VOICE)}?v=${Math.round(statSync(paths(dir).audio(SHORT_VOICE)).mtimeMs)}`;
        return { voice: doc.voice ? { engine: doc.voice.engine, voice: doc.voice.voice, speed: doc.voice.speed } : p.voice, chapters: c ? [{ ...c, title: doc.title, timing: { ...c.timing, audio: audio! } }] : [] };
      }
      const s = snap(dir);
      const chapters: ChapterVoice[] = [];
      for (let n = 1; n <= s.count; n++) {
        const c = voicedChapter(id, s, n);
        if (c) chapters.push(c);
      }
      return { voice: s.project.voice, chapters };
    },

    async slidesPdf(id, ctx) {
      const dir = await resolve(id);
      try {
        return await slidesPdf(dir, { ...ctx, globalPronounce: opts.globalPronounce });
      } catch (e) {
        if (/only a slides video|not written yet/.test((e as Error).message)) throw conflict((e as Error).message);
        throw e;
      }
    },

    async saveVoiceEdits(id, n, edits): Promise<ChapterVoice | ValidationError> {
      const dir = await resolve(id);
      if (!isPauseEdits(edits)) return { errors: ["edits: must be {version: 1, sentences: {<sentence>: {words?: {<word index>: ms}, after?: ms}}}, each change at most 10000 ms"] };
      if (isShort(dir)) {
        if (n !== SHORT_VOICE) throw notFound(`a Short's voice is chapter ${SHORT_VOICE}`);
        return withLock(dir, async () => {
          const doc = loadShort(dir), p = projectOf(dir);
          if (voiceStatus(dir, doc, p, shortPronounce(p)) !== "ok") throw conflict("the voice no longer matches the script: voice it before editing its pauses");
          saveChapterEdits(dir, SHORT_VOICE, edits);
          return (await lib.voice(id)).chapters[0]!;
        });
      }
      return withLock(dir, () => {
        const s = snap(dir);
        if (ownStatuses(s).chapters[n - 1]?.voice !== "ok") throw conflict(`chapter ${n}'s voice is not up to date: voice it before editing its pauses`);
        saveChapterEdits(dir, n, edits);
        const c = voicedChapter(id, snap(dir), n);
        if (!c) throw new Error(`chapter ${n}'s voice could not be read back after the edit`);
        return c;
      });
    },

    async createShort(folder, document): Promise<VideoDetail | ValidationError> {
      const parsed = Short.safeParse(document);
      if (!parsed.success) return { errors: issues(parsed.error) };
      const doc = parsed.data;
      const dir = uniqueBundle(folderAbs(folder), slugify(doc.title));
      mkdirSync(dir);
      try {
        const t = now();
        const voice = doc.voice ? { engine: doc.voice.engine, voice: doc.voice.voice, speed: doc.voice.speed } : opts.defaults.voice;
        const project = Project.parse({ ...opts.defaults, id: randomUUID(), created: t, updated: t, kind: "short", title: doc.title, topic: "", minutes: 1, voice });
        writeJson(paths(dir).project, project);
        writeJson(paths(dir).state, { version: 1, stages: {} });
        writeJson(paths(dir).short, doc);
        ids.set(project.id!, dir);
      } catch (e) {
        rmSync(dir, { recursive: true, force: true }); // only what this call just made
        throw e;
      }
      return detailOf(dir);
    },

    async newShort(req) {
      if (!TEMPLATES.some((t) => t.id === req?.template)) return { errors: [`template: one of ${TEMPLATES.map((t) => t.id).join(", ")}`] };
      const series = req.series ? SERIES[req.series] : undefined;
      if (req.series && !series) return { errors: [`series: no series "${req.series}"`] };
      const episode = series ? nextEpisode(series, seriesEpisodes(series.id).map((e) => e.episode)) : undefined;
      const title = req.title?.trim() || (series ? `${series.slug}-ep${episode}` : "New Short");
      const made = await lib.createShort(req.folder ?? "", startShort(req.template, { title, series, episode }));
      if ("errors" in made) return made;
      const brief = req.brief?.trim();
      if (brief) {
        const file = paths(made.dir).project;
        writeJson(file, { ...readJson<Record<string, unknown>>(file), topic: brief });
      }
      return detailOf(made.dir);
    },

    async dropShortProposal(id) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      await withLock(dir, () => rmSync(join(dir, ASK_FILE), { force: true }));
    },

    async seriesOverview(id) {
      const series = SERIES[id];
      if (!series) throw notFound(`no series "${id}"`);
      const episodes = seriesEpisodes(id);
      const pinned = [...episodes].reverse().find((e) => e.build)?.build;
      const main = perdixCommit("main");
      const behind = pinned ? behindMain(pinned) : undefined;
      return { series, next: nextEpisode(series, episodes.map((e) => e.episode)), episodes, build: { ...(pinned ? { pinned } : {}), ...(main ? { main } : {}), ...(behind !== undefined ? { behind } : {}) } };
    },

    async shortDocument(id) {
      return readShort(await resolve(id));
    },

    async saveShortDocument(id, document, revision): Promise<ShortDocument | ValidationError> {
      const dir = await resolve(id);
      const parsed = Short.safeParse(document);
      if (!parsed.success) return { errors: issues(parsed.error) };
      return withLock(dir, () => {
        if (shortFile(dir).revision !== revision) throw conflict("the Short changed since this edit began: open it again");
        writeJson(paths(dir).short, parsed.data);
        // the library shows the document's title
        const file = paths(dir).project;
        const raw = readJson<Record<string, unknown>>(file);
        writeJson(file, { ...raw, title: parsed.data.title, titleAuto: false, updated: now() });
        return readShort(dir);
      });
    },

    async previewShort(id) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      // the file's time in the URL, so a player holding an old voice or shot fetches the new one
      const url = (rel: string) => `/media/${encodeURIComponent(id)}/${rel}?v=${Math.round(statSync(join(dir, rel)).mtimeMs)}`;
      const r = shortPreview(dir, url, { soundsRoot: opts.soundsRoot });
      return "problems" in r ? { errors: r.problems.map((p) => `${p.at}: ${p.message}`) } : r;
    },

    async shortPeaks(id, track) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      const P = paths(dir);
      const m = loadShort(dir).music;
      const file = track === "voice" ? P.audio(SHORT_VOICE) : m && "file" in m.source ? join(dir, m.source.file.asset) : undefined;
      if (!file || !isFile(file)) throw notFound(`no ${track} track yet`);
      return filePeaks(file, join(dir, "render"));
    },

    async addShortMusic(id, uploads) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      const u = uploads[0];
      if (!u || uploads.length > 1) throw badInput("one song at a time");
      const clean = basename(u.name).replace(/[\/\\\x00-\x1f]/g, "_").replace(/^\.+/, "") || "song.mp3";
      if (!AUDIO.test(clean)) throw badInput(`${clean}: a song is an mp3, wav, m4a, aac, flac or ogg file`);
      const folder = join(dir, "assets", "music");
      mkdirSync(folder, { recursive: true });
      const name = uniqueName(folder, clean, true);
      copyFileSync(u.tmpPath, join(folder, name));
      return { asset: `assets/music/${name}` };
    },

    async addShortClips(id, uploads) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      const folder = join(dir, "assets", "clips");
      mkdirSync(folder, { recursive: true });
      const assets: string[] = [];
      for (const u of uploads) {
        const clean = basename(u.name).replace(/[\/\\\x00-\x1f]/g, "_").replace(/^\.+/, "") || "clip.mp4";
        if (!/\.(mp4|mov|m4v|webm)$/i.test(clean)) throw badInput(`${clean}: a clip is an mp4, mov, m4v or webm file`);
        const name = uniqueName(folder, clean, true);
        copyFileSync(u.tmpPath, join(folder, name));
        assets.push(`assets/clips/${name}`);
      }
      return { assets };
    },

    async searchShotStarts(id, scene) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      const r = resolvedNow(dir);
      const shot = r.shots.find((x) => x.scene === scene);
      if (!shot) throw notFound(`scene ${scene} has no Perdix shot`);
      return searchStarts(shot.build, shot.kind, shot.knobs);
    },

    async renameShortPauses(id, renames) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      if (!Array.isArray(renames) || !renames.every((r) => r && typeof r.from === "string" && typeof r.to === "string" && (r.words === undefined || Number.isInteger(r.words)))) throw badInput("renames: [{from, to, words?}]");
      await withLock(dir, () => {
        const all = loadVideoEdits(dir);
        const mine = all.chapters[String(SHORT_VOICE)];
        if (!mine) return;
        const next = renameEdits({ version: 1, sentences: mine }, renames as Rename[]).sentences;
        if (Object.keys(next).length) all.chapters[String(SHORT_VOICE)] = next;
        else delete all.chapters[String(SHORT_VOICE)];
        writeJson(paths(dir).voiceEdits, all);
      });
    },

    async sounds() {
      const root = opts.soundsRoot ?? defaultSoundsRoot();
      ensureSoundsRoot(root);
      return { root, sounds: listSounds(root) };
    },

    async soundFile(path) {
      return soundFile(opts.soundsRoot ?? defaultSoundsRoot(), path);
    },

    async importSound(id, path) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      const from = soundFile(opts.soundsRoot ?? defaultSoundsRoot(), path);
      if (!from) throw notFound(`no sound ${path} in the sound library`);
      const asset = bundleNameFor(path);
      const to = join(dir, asset);
      // the same file again is kept; a different one under the same name replaces it (the library is the source)
      if (!isFile(to) || statSync(to).size !== statSync(from).size) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      return { asset };
    },

    async shortTakes(id) {
      const dir = await resolve(id);
      if (!isShort(dir)) throw badInput("this video is not a Short");
      const folder = join(dir, "takes");
      if (!existsSync(folder)) return [];
      const takes = readdirSync(folder).filter((f) => f.endsWith(".json")).flatMap((f) => {
        const t = maybe(() => readJson<ShortTake>(join(folder, f)));
        return t && Short.safeParse(t.document).success ? [t] : [];
      });
      return takes.sort((a, b) => b.saved.localeCompare(a.saved));
    },

    async saveShortTake(id, name) {
      const dir = await resolve(id);
      const clean = name.trim().slice(0, 60);
      if (!clean) throw badInput("a take needs a name");
      const take: ShortTake = { name: clean, saved: now(), document: readShort(dir).document };
      writeJson(join(dir, "takes", `${slugify(clean) || "take"}.json`), take);
      return take;
    },

    async restoreShortTake(id, name, revision) {
      const dir = await resolve(id);
      const take = (await lib.shortTakes(id)).find((t) => t.name === name);
      if (!take) throw notFound(`no take named ${name}`);
      const out = await lib.saveShortDocument(id, take.document, revision);
      if ("errors" in out) throw invalid(out.errors.join("; "));
      return out;
    },

    async plan(id, kind, o?: PlanOptions): Promise<PlannedStep[]> {
      const dir = await resolve(id);
      if (isShort(dir)) return planShort(dir, kind, o?.note);
      if (kind === "draft") throw badInput("only a Short is drafted: an explainer is made from its outline");
      if (kind === "ask") throw badInput("only a Short has Ask: an explainer is revised with a note on its chapter");
      return planSteps(snap(dir), kind, o);
    },

    async runStep(id, step, ctx) {
      const dir = await resolve(id);
      if (isShort(dir)) return runShortStep(dir, step, ctx);
      await runStage(dir, step, ctx, deps);
    },

    async exportVideos(req: ExportRequest, ctx: StepContext) {
      if (!isAbsolute(req.dest)) throw badInput("export needs an absolute destination folder");
      if (!req.formats.length) throw badInput("pick at least one format");
      let items: { dir: string; sub?: string }[];
      if (req.folder !== undefined) {
        const base = folderAbs(req.folder);
        const { bundles } = scan();
        const inside = bundles.filter((b) => b.dir.startsWith(base === root ? root : base + sep));
        items = [];
        for (const b of inside) {
          const miss = missingFor(b.dir, req.formats, deps.globalPronounce);
          if (miss) ctx.log(`skipped: ${miss}`);
          else items.push({ dir: b.dir });
        }
        if (!items.length) throw conflict("nothing in that folder is ready to export");
        const used = new Set<string>();
        for (const it of items) {
          const t = safeName(readJson(paths(it.dir).project, Project).title);
          let sub = t;
          for (let i = 2; used.has(sub.toLowerCase()); i++) sub = `${t} ${i}`;
          used.add(sub.toLowerCase());
          it.sub = sub;
        }
      } else {
        if (!req.videoIds?.length) throw badInput("export needs videos or a folder");
        items = await Promise.all(req.videoIds.map(async (v) => ({ dir: await resolve(v) })));
        const miss = items.map((it) => missingFor(it.dir, req.formats, deps.globalPronounce)).filter(Boolean);
        if (miss.length) throw conflict(miss.join("\n"));
      }
      const written: string[] = [];
      for (const [i, it] of items.entries()) {
        throwIfAborted(ctx.signal);
        const dest = it.sub ? join(req.dest, it.sub) : req.dest;
        written.push(
          ...(await exportOne(it.dir, req.formats, dest, {
            signal: ctx.signal, log: ctx.log, globalPronounce: deps.globalPronounce,
            progress: (p, d) => ctx.progress((i + p) / items.length, d),
          })),
        );
      }
      ctx.progress(1, `${written.length} files`);
      return written;
    },

    async resolveMedia(id, rel) {
      let dir: string;
      try {
        dir = await resolve(id);
      } catch {
        return null;
      }
      const clean = normalize(rel.replace(/^\/+/, ""));
      if (!clean || isAbsolute(clean) || clean.split(sep).includes("..")) return null;
      const abs = join(dir, clean);
      try {
        const real = realpathSync(abs), realDir = realpathSync(dir);
        if (!real.startsWith(realDir + sep) || !statSync(real).isFile()) return null;
        return abs;
      } catch {
        return null;
      }
    },
  };
  return lib;
}
