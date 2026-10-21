/**
 * The Emoton server: REST + SSE per shared/api.ts, jobs, /media, the built UI.
 * `createServer()` takes the Library factory (dependency injection), so tests
 * run it over an in-memory fake and `main.ts` wires the real one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT, PROTOCOL,
  type AddSourcesRequest, type Brief, type CreateMode, type CreateVideoRequest, type DoctorCheck, type ExportFormat,
  type ExportRequest, type Health, type Job, type JobKind, type JobRequest, type Lane, type NewShortRequest, type ServerEvent, type Settings,
  type VideoDetail, type ValidationError,
} from "../shared/api.ts";
import type { Library, LibraryOptions, Upload } from "../shared/library.ts";
import { downloadVoiceModel, runDoctor, type DoctorEnv } from "./doctor.ts";
import { EventHub } from "./events.ts";
import { safeJoin, sendFile, sendUi } from "./files.ts";
import { errorMessage, HttpError, isObject, readJson, Router, sendJson, statusForError, ValidationFailed, type Params } from "./http.ts";
import { JobRunner } from "./jobs.ts";
import { overlayDetail, overlaySummary } from "./overlay.ts";
import { defaultSettingsPath, expandHome, loadSettings, validateSettings, VoiceSchema, writeJsonAtomic, zodErrors } from "./settings.ts";
import { isMultipart, parseMultipart, type UploadOptions } from "./uploads.ts";
import { SAMPLE_TEXT, Voices, type SystemVoice } from "./voices.ts";
import { perdixCommit, perdixTools, shotKinds, startToolBuild } from "../pipeline/shots.ts";
import { SERIES } from "../src/core/short/series.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ServerOptions = {
  /** Builds a Library for a root; called again when settings change. */
  createLibrary(opts: LibraryOptions): Library;
  settingsPath?: string;
  /** 0 = any free port. Default: env EMOTON_PORT, else DEFAULT_PORT. */
  port?: number;
  host?: string;
  /** The repo checkout (tts/, node_modules/, package.json). */
  repoRoot?: string;
  /** The built UI. Default <repoRoot>/app/dist. */
  uiDir?: string;
  /** Where multipart uploads land before the library copies them. */
  tmpDir?: string;
  voiceCacheDir?: string;
  /** The macOS voices to offer. Default: what `say -v ?` lists (tests pass their own). */
  systemVoices?: () => Promise<SystemVoice[]>;
  /** Levels a voice sample WAV in place. Default: ffmpeg loudnorm, as the voice stage does (tests pass their own). */
  levelVoice?: (wav: string) => Promise<void>;
  /** /api/fs/list is limited to this directory. Default: the user's home. */
  homeDir?: string;
  laneLimits?: Record<Lane, number>;
  /** Upload limits and (tests) the file opener. */
  uploads?: Omit<UploadOptions, "tmpRoot">;
  events?: { heartbeatMs?: number; jobIntervalMs?: number };
  /** Doctor overrides; `path` replaces the PATH the server started with (tests use fake binaries). */
  doctor?: Partial<Pick<DoctorEnv, "modelFiles" | "diskWarn" | "diskError" | "path" | "downloadTimeoutMs" | "downloadStallMs">>;
  log?(msg: string): void;
};

export type EmotonServer = {
  server: http.Server;
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly url: string;
  readonly runner: JobRunner;
  readonly events: EventHub;
  settings(): Settings;
};

const JOB_KINDS: Exclude<JobKind, "export">[] = ["make", "outline", "storyboard", "voice", "render", "redo", "draft", "ask"];
const MODES: CreateMode[] = ["make", "outline-first", "draft"];
const FORMATS: ExportFormat[] = ["mp4", "mp4-720", "m4a", "srt", "md", "bundle", "slides-pdf"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "tauri.localhost"]);

function readVersion(repoRoot: string): string {
  try {
    return (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function readGitHash(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------- validation

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function checkSources(b: Record<string, unknown>, errors: string[]) {
  if (b.sourcePaths !== undefined) {
    if (!isStrArray(b.sourcePaths)) errors.push("sourcePaths: must be a list of paths");
    else for (const p of b.sourcePaths) if (!isAbsolute(p)) errors.push(`sourcePaths: ${p} is not an absolute path`);
  }
  if (b.urls !== undefined) {
    if (!isStrArray(b.urls)) errors.push("urls: must be a list of links");
    else for (const u of b.urls) if (!/^https?:\/\//i.test(u)) errors.push(`urls: ${u} is not an http(s) link`);
  }
}

function validateCreate(body: unknown): CreateVideoRequest {
  const errors: string[] = [];
  if (!isObject(body)) throw new ValidationFailed(["body: must be an object"]);
  const folder = body.folder ?? "";
  if (!isStr(folder)) errors.push("folder: must be a library-relative path");
  const brief = body.brief;
  if (!isObject(brief)) errors.push("brief: required");
  else {
    if (!isStr(brief.topic) || !brief.topic.trim()) errors.push("brief.topic: required");
    if (brief.title !== undefined && !isStr(brief.title)) errors.push("brief.title: must be text");
    if (brief.minutes !== undefined && !(typeof brief.minutes === "number" && brief.minutes >= 1 && brief.minutes <= 30)) {
      errors.push("brief.minutes: must be a number from 1 to 30");
    }
  }
  checkSources(body, errors);
  if (!MODES.includes(body.mode as CreateMode)) errors.push(`mode: must be one of ${MODES.join(", ")}`);
  if (errors.length) throw new ValidationFailed(errors);
  return { ...(body as unknown as CreateVideoRequest), folder: folder as string };
}

function validateAddSources(body: unknown, uploads: number): AddSourcesRequest {
  const errors: string[] = [];
  if (!isObject(body)) throw new ValidationFailed(["body: must be an object"]);
  checkSources(body, errors);
  const n = (isStrArray(body.sourcePaths) ? body.sourcePaths.length : 0) + (isStrArray(body.urls) ? body.urls.length : 0) + uploads;
  if (!errors.length && n === 0) errors.push("give at least one source (sourcePaths, urls or files)");
  if (errors.length) throw new ValidationFailed(errors);
  return body as AddSourcesRequest;
}

function validateJob(body: unknown): JobRequest {
  const errors: string[] = [];
  if (!isObject(body)) throw new ValidationFailed(["body: must be an object"]);
  if (!isStr(body.videoId) || !body.videoId) errors.push("videoId: required");
  if (!JOB_KINDS.includes(body.kind as never)) errors.push(`kind: must be one of ${JOB_KINDS.join(", ")}`);
  if (body.chapter !== undefined && !isPosInt(body.chapter)) errors.push("chapter: must be a chapter number (1 or more)");
  if (body.kind === "redo" && body.chapter === undefined) errors.push("chapter: redo needs a chapter");
  if (body.kind === "ask" && !(isStr(body.note) && body.note.trim())) errors.push("note: ask needs the request");
  if (body.note !== undefined && !isStr(body.note)) errors.push("note: must be text");
  if (body.draft !== undefined && typeof body.draft !== "boolean") errors.push("draft: must be true or false");
  if (body.pauseAfterOutline !== undefined && typeof body.pauseAfterOutline !== "boolean") errors.push("pauseAfterOutline: must be true or false");
  if (errors.length) throw new ValidationFailed(errors);
  return body as unknown as JobRequest;
}

function validateExport(body: unknown): ExportRequest {
  const errors: string[] = [];
  if (!isObject(body)) throw new ValidationFailed(["body: must be an object"]);
  const hasIds = body.videoIds !== undefined, hasFolder = body.folder !== undefined;
  if (hasIds && !(isStrArray(body.videoIds) && body.videoIds.length > 0)) errors.push("videoIds: must be a non-empty list");
  if (hasFolder && !isStr(body.folder)) errors.push("folder: must be a library-relative path");
  if (!hasIds && !hasFolder) errors.push("give videoIds or folder");
  if (!(Array.isArray(body.formats) && body.formats.length > 0 && body.formats.every((f) => FORMATS.includes(f as ExportFormat)))) {
    errors.push(`formats: a non-empty list of ${FORMATS.join(", ")}`);
  }
  if (!isStr(body.dest) || !isAbsolute(body.dest)) errors.push("dest: must be an absolute folder path");
  if (errors.length) throw new ValidationFailed(errors);
  return body as unknown as ExportRequest;
}

function chapterParam(p: Params): number {
  const n = Number(p.n);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "chapter must be a number (1 or more)");
  return n;
}

function isValidationError(r: unknown): r is ValidationError {
  return isObject(r) && Array.isArray(r.errors) && !("summary" in r);
}

// ---------------------------------------------------------------- server

export async function createServer(opts: ServerOptions): Promise<EmotonServer> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const uiDir = opts.uiDir ?? join(repoRoot, "app", "dist");
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const home = opts.homeDir ?? homedir();
  const tmpRoot = opts.tmpDir ?? tmpdir();
  const version = readVersion(repoRoot);
  const gitHash = readGitHash(repoRoot);
  const startPath = process.env.PATH ?? "";

  let settings = await loadSettings(settingsPath, log);
  let library: Library | null = null;
  let libraryError = "";
  let swapping = false;

  const libOptions = (s: Settings): LibraryOptions => ({
    root: s.libraryRoot,
    soundsRoot: s.soundsRoot,
    globalPronounce: s.pronounce,
    defaults: {
      audience: s.defaults.audience,
      minutes: s.defaults.minutes,
      rules: [],
      voice: s.defaults.voice,
      pronounce: {},
      writerModel: s.defaults.writerModel,
      captions: s.defaults.captions,
    },
  });

  function buildLibrary(s: Settings): Library | null {
    try {
      libraryError = "";
      return opts.createLibrary(libOptions(s));
    } catch (e) {
      libraryError = errorMessage(e);
      log(`library: cannot open ${s.libraryRoot}: ${libraryError}`);
      return null;
    }
  }

  const lib = (): Library => {
    if (!library) throw new HttpError(503, `the library is not available: ${libraryError || "unknown error"}`);
    return library;
  };

  const hello = (): ServerEvent => ({ type: "hello", protocol: PROTOCOL, version });
  const events = new EventHub(hello, opts.events);

  // "library" and "video" events coalesce within one tick.
  let libraryPending = false;
  const videoPending = new Set<string>();
  const emitLibrary = () => {
    if (libraryPending) return;
    libraryPending = true;
    setImmediate(() => {
      libraryPending = false;
      events.send({ type: "library" });
    });
  };
  const emitVideo = (id: string) => {
    if (!id || videoPending.has(id)) return;
    videoPending.add(id);
    setImmediate(() => {
      videoPending.delete(id);
      events.send({ type: "video", id });
    });
  };

  const newRunner = (root: string) =>
    new JobRunner(
      root,
      {
        library: lib,
        onJob: (job, final) => events.job(job, final),
        onVideo: emitVideo,
        onLibrary: emitLibrary,
        log,
      },
      opts.laneLimits,
    );

  library = buildLibrary(settings);
  let runner = newRunner(settings.libraryRoot);
  await runner.load();

  const doctorEnv = (): DoctorEnv => ({ repoRoot, libraryRoot: settings.libraryRoot, path: startPath, ...opts.doctor });
  const voices = new Voices(repoRoot, opts.voiceCacheDir ?? join(tmpRoot, "emoton-voice-samples"), log, opts.systemVoices, opts.levelVoice);
  let download: { running: boolean; error?: string } = { running: false };

  async function doctorChecks(): Promise<DoctorCheck[]> {
    const checks = await runDoctor(doctorEnv());
    return checks.map((c) => {
      if (c.id !== "voice-model" || c.level === "ok") return c;
      if (download.running) return { ...c, level: "warn", detail: "Downloading the voice model (about 120 MB)...", action: undefined };
      if (download.error) return { ...c, detail: `${c.detail}. The last download failed: ${download.error}` };
      return c;
    });
  }

  // ---------------------------------------------------------------- helpers

  const detailOf = (d: VideoDetail) => overlayDetail(d, runner);

  function pauseFor(minutes: number): boolean {
    const t = settings.pauseAfterOutlineOverMinutes;
    return t !== null && minutes > t;
  }

  function startJob(req: JobRequest): Promise<Job> {
    return starting(() => startJobNow(req));
  }

  async function startJobNow(req: JobRequest): Promise<Job> {
    const d = await lib().detail(req.videoId);
    let pauseAfterOutline = req.pauseAfterOutline;
    if (req.kind === "make" && pauseAfterOutline === undefined) pauseAfterOutline = pauseFor(d.brief.minutes);
    const job = await runner.start({
      videoId: req.videoId,
      videoTitle: d.brief.title || d.summary.title,
      kind: req.kind,
      ...(req.chapter !== undefined ? { chapter: req.chapter } : {}),
      ...(req.note !== undefined ? { note: req.note } : {}),
      // omitted = the render quality setting; stored on the job, so resume keeps it
      draft: req.draft ?? settings.renderQuality === "720p",
      ...(req.kind === "make" ? { pauseAfterOutline } : {}),
    });
    emitLibrary();
    emitVideo(req.videoId);
    return job;
  }

  function refuseIfActive(videoId: string, what: string) {
    if (runner.activeFor(videoId)) throw new HttpError(409, `a job is running on this video; cancel it before you ${what}`);
  }

  async function refuseIfFolderBusy(path: string, what: string) {
    const active = runner.activeVideoIds();
    if (active.size === 0) return;
    const t = await lib().tree();
    const inside = t.videos.some((v) => active.has(v.id) && (path === "" || v.folder === path || v.folder.startsWith(path + "/")));
    if (inside) throw new HttpError(409, `a job is running on a video in this folder; cancel it before you ${what}`);
  }

  async function withBody<T>(req: IncomingMessage, fn: (body: unknown, uploads: Upload[] | undefined) => Promise<T>): Promise<T> {
    if (!isMultipart(req)) return fn(await readJson(req), undefined);
    const mp = await parseMultipart(req, { tmpRoot, ...opts.uploads });
    try {
      return await fn(mp.request, mp.uploads);
    } finally {
      await mp.cleanup();
    }
  }

  /** PUT /api/settings calls run one at a time. */
  let settingsLock: Promise<unknown> = Promise.resolve();
  function applySettings(next: Settings): Promise<void> {
    const run = settingsLock.then(() => applySettingsNow(next));
    settingsLock = run.catch(() => {});
    return run;
  }

  async function applySettingsNow(next: Settings) {
    const rootChanged = next.libraryRoot !== settings.libraryRoot;
    if (!rootChanged) {
      await writeJsonAtomic(settingsPath, next);
      settings = next;
      library = buildLibrary(next); // defaults and pronounce are Library options
      emitLibrary();
      return;
    }
    // Closed to new jobs first, then checked: a job start already past its own check is counted in startsInFlight.
    swapping = true;
    try {
      if (runner.hasActive() || startsInFlight > 0) {
        throw new HttpError(409, "jobs are running; wait for them or cancel them before moving the library");
      }
      await writeJsonAtomic(settingsPath, next);
      await runner.close();
      settings = next;
      library = buildLibrary(next);
      runner = newRunner(next.libraryRoot);
      await runner.load();
    } finally {
      swapping = false;
    }
    events.send(hello());
    emitLibrary();
  }

  /** Every job start goes through here, so a library switch never races one. */
  let startsInFlight = 0;
  async function starting<T>(fn: () => Promise<T>): Promise<T> {
    if (swapping) throw new HttpError(503, "the library is switching; try again in a moment");
    startsInFlight++;
    try {
      return await fn();
    } finally {
      startsInFlight--;
    }
  }

  // ---------------------------------------------------------------- routes

  const r = new Router();
  const json = (res: ServerResponse, body: unknown, status = 200) => sendJson(res, status, body);

  r.add("GET", "/api/health", (_q, res) => {
    const h: Health = { ok: true, protocol: PROTOCOL, version, gitHash, pid: process.pid, libraryRoot: settings.libraryRoot };
    json(res, h);
  });

  r.add("GET", "/api/doctor", async (_q, res) => json(res, await doctorChecks()));

  r.add("POST", "/api/doctor/fix", async (req, res) => {
    const body = await readJson(req);
    const action = isObject(body) ? body.action : undefined;
    if (action === "create-library") {
      await mkdir(settings.libraryRoot, { recursive: true });
      if (!runner.hasActive()) library = buildLibrary(settings);
      emitLibrary();
    } else if (action === "download-voice-model") {
      if (!download.running) {
        download = { running: true };
        void downloadVoiceModel(doctorEnv(), log).then(
          () => {
            download = { running: false };
            events.send(hello());
          },
          (e) => {
            download = { running: false, error: errorMessage(e) };
            log(`doctor: voice model download failed: ${download.error}`);
            events.send(hello());
          },
        );
      }
    } else {
      throw new ValidationFailed(['action: must be "download-voice-model" or "create-library"']);
    }
    json(res, await doctorChecks(), 202);
  });

  r.add("GET", "/api/library", async (_q, res) => {
    const t = await lib().tree();
    json(res, { ...t, videos: t.videos.map((v) => overlaySummary(v, runner)) });
  });

  r.add("POST", "/api/folders", async (req, res) => {
    const b = await readJson(req);
    const errors: string[] = [];
    if (!isObject(b)) throw new ValidationFailed(["body: must be an object"]);
    const parent = b.parent ?? "";
    if (!isStr(parent)) errors.push("parent: must be a library-relative path");
    if (!isStr(b.name) || !b.name.trim()) errors.push("name: required");
    if (errors.length) throw new ValidationFailed(errors);
    const path = await lib().createFolder(parent as string, (b.name as string).trim());
    emitLibrary();
    json(res, { path }, 201);
  });

  r.add("PATCH", "/api/folders", async (req, res) => {
    const b = await readJson(req);
    const errors: string[] = [];
    if (!isObject(b)) throw new ValidationFailed(["body: must be an object"]);
    if (!isStr(b.path) || !b.path) errors.push("path: required (the library root cannot be renamed)");
    if (b.name !== undefined && (!isStr(b.name) || !b.name.trim())) errors.push("name: must be a non-empty name");
    if (b.parent !== undefined && !isStr(b.parent)) errors.push("parent: must be a library-relative path");
    if (b.name === undefined && b.parent === undefined) errors.push("give name or parent");
    if (errors.length) throw new ValidationFailed(errors);
    await refuseIfFolderBusy(b.path as string, "rename or move it");
    const change: { name?: string; parent?: string } = {};
    if (b.name !== undefined) change.name = (b.name as string).trim();
    if (b.parent !== undefined) change.parent = b.parent as string;
    const path = await lib().updateFolder(b.path as string, change);
    emitLibrary();
    json(res, { path });
  });

  r.add("DELETE", "/api/folders", async (_q, res, _p, url) => {
    const path = url.searchParams.get("path");
    if (!path) throw new ValidationFailed(["path: required (the library root cannot be deleted)"]);
    await refuseIfFolderBusy(path, "delete it");
    await lib().trashFolder(path);
    emitLibrary();
    json(res, { ok: true });
  });

  r.add("POST", "/api/videos", async (req, res) => {
    let mode: CreateMode = "draft";
    const created = await withBody(req, async (body, uploads) => {
      const cr = validateCreate(body);
      mode = cr.mode;
      return lib().createVideo(cr, uploads);
    });
    emitLibrary();
    if (mode !== "draft") {
      const id = created.summary.id;
      // outline-first = make that stops after the outline; make = the settings decide.
      await startJob({ videoId: id, kind: "make", ...(mode === "outline-first" ? { pauseAfterOutline: true } : {}) });
      return json(res, detailOf(await lib().detail(id)), 201);
    }
    json(res, detailOf(created), 201);
  });

  r.add("GET", "/api/videos/:id", async (_q, res, p) => json(res, detailOf(await lib().detail(p.id!))));

  r.add("PATCH", "/api/videos/:id/brief", async (req, res, p) => {
    const b = await readJson(req);
    if (!isObject(b)) throw new ValidationFailed(["body: must be an object"]);
    const d = await lib().updateBrief(p.id!, b as Partial<Brief>);
    emitLibrary();
    emitVideo(p.id!);
    json(res, detailOf(d));
  });

  r.add("PUT", "/api/videos/:id/outline", async (req, res, p) => {
    const out = await lib().saveOutline(p.id!, await readJson(req));
    if (isValidationError(out)) return json(res, out, 422);
    emitLibrary();
    emitVideo(p.id!);
    json(res, detailOf(out));
  });

  r.add("PUT", "/api/videos/:id/chapters/:n", async (req, res, p) => {
    const n = chapterParam(p);
    const out = await lib().saveChapter(p.id!, n, await readJson(req));
    if (isValidationError(out)) return json(res, out, 422);
    emitLibrary();
    emitVideo(p.id!);
    json(res, detailOf(out));
  });

  r.add("POST", "/api/videos/:id/sources", async (req, res, p) => {
    refuseIfActive(p.id!, "change its sources");
    const d = await withBody(req, async (body, uploads) => lib().addSources(p.id!, validateAddSources(body, uploads?.length ?? 0), uploads));
    emitLibrary();
    emitVideo(p.id!);
    json(res, detailOf(d));
  });

  r.add("DELETE", "/api/videos/:id/sources/:sourceId", async (_q, res, p) => {
    refuseIfActive(p.id!, "change its sources");
    const d = await lib().removeSource(p.id!, p.sourceId!);
    emitLibrary();
    emitVideo(p.id!);
    json(res, detailOf(d));
  });

  r.add("POST", "/api/videos/:id/move", async (req, res, p) => {
    const b = await readJson(req);
    if (!isObject(b) || !isStr(b.folder)) throw new ValidationFailed(["folder: must be a library-relative path"]);
    refuseIfActive(p.id!, "move it");
    const d = await lib().moveVideo(p.id!, b.folder);
    emitLibrary();
    emitVideo(p.id!);
    json(res, detailOf(d));
  });

  r.add("POST", "/api/videos/:id/duplicate", async (_q, res, p) => {
    const d = await lib().duplicateVideo(p.id!);
    emitLibrary();
    json(res, detailOf(d), 201);
  });

  r.add("DELETE", "/api/videos/:id", async (_q, res, p) => {
    refuseIfActive(p.id!, "delete it");
    await lib().trashVideo(p.id!);
    emitLibrary();
    json(res, { ok: true });
  });

  r.add("GET", "/api/videos/:id/preview/:n", async (_q, res, p) => json(res, await lib().previewProps(p.id!, chapterParam(p))));

  r.add("GET", "/api/videos/:id/voice", async (_q, res, p) => json(res, await lib().voice(p.id!)));

  r.add("GET", "/api/shorts/:id/document", async (_q, res, p) => json(res, await lib().shortDocument(p.id!)));

  r.add("PUT", "/api/shorts/:id/document", async (req, res, p) => {
    const body = (await readJson(req)) as { document?: unknown; revision?: unknown };
    if (typeof body?.revision !== "string") throw new HttpError(400, "a save names the revision it was made from");
    // no refusal while a job runs: each stage reads the document when it starts, and what changed after shows as stale (shots, voice) and is made again
    const out = await lib().saveShortDocument(p.id!, body.document, body.revision);
    if (isValidationError(out)) return json(res, out, 422);
    emitLibrary();
    emitVideo(p.id!);
    json(res, out);
  });

  r.add("GET", "/api/shorts/:id/takes", async (_q, res, p) => json(res, await lib().shortTakes(p.id!)));

  r.add("GET", "/api/sounds", async (_q, res) => json(res, await lib().sounds()));

  r.add("GET", "/api/perdix/kinds", (_q, res) => json(res, shotKinds()));
  r.add("GET", "/api/perdix/tools", (_q, res) => json(res, perdixTools()));
  r.add("POST", "/api/perdix/tools", async (req, res) => {
    const body = (await readJson(req)) as { commit?: unknown };
    if (typeof body?.commit !== "string" || !/^[\w.-]{1,64}$/.test(body.commit)) throw new HttpError(400, "which commit: {commit}");
    const commit = perdixCommit(body.commit);
    if (!commit) throw new HttpError(404, `no commit ${body.commit} in Perdix`);
    startToolBuild(commit, () => emitLibrary());
    json(res, perdixTools(), 202);
  });
  r.add("POST", "/api/shorts/:id/shots/:scene/search", async (_q, res, p) => json(res, await lib().searchShotStarts(p.id!, p.scene!)));
  r.add("POST", "/api/shorts", async (req, res) => {
    const out = await lib().newShort((await readJson(req)) as NewShortRequest);
    if (isValidationError(out)) return json(res, out, 422);
    emitLibrary();
    json(res, out, 201);
  });
  r.add("GET", "/api/series", async (_q, res) => json(res, Object.values(SERIES)));
  r.add("GET", "/api/series/:id", async (_q, res, p) => json(res, await lib().seriesOverview(p.id!)));
  r.add("DELETE", "/api/shorts/:id/ask", async (_q, res, p) => {
    await lib().dropShortProposal(p.id!);
    emitVideo(p.id!);
    json(res, { ok: true });
  });
  r.add("POST", "/api/shorts/:id/music", async (req, res, p) => {
    const out = await withBody(req, (_body, uploads) => lib().addShortMusic(p.id!, uploads ?? []));
    emitVideo(p.id!);
    json(res, out, 201);
  });
  r.add("POST", "/api/shorts/:id/clips", async (req, res, p) => {
    const out = await withBody(req, (_body, uploads) => lib().addShortClips(p.id!, uploads ?? []));
    emitVideo(p.id!);
    json(res, out, 201);
  });

  r.add("GET", "/api/sounds/file", async (req, res, _p, url) => {
    const file = await lib().soundFile(url.searchParams.get("path") ?? "");
    if (!file || !(await sendFile(req, res, file, { "Cache-Control": "no-cache" }))) throw new HttpError(404, "no such sound");
  });

  r.add("POST", "/api/shorts/:id/sounds", async (req, res, p) => {
    const body = (await readJson(req)) as { path?: unknown };
    if (typeof body?.path !== "string") throw new HttpError(400, "which sound: {path}");
    json(res, await lib().importSound(p.id!, body.path));
  });

  r.add("POST", "/api/shorts/:id/voice/rename", async (req, res, p) => {
    const body = (await readJson(req)) as { renames?: unknown };
    await lib().renameShortPauses(p.id!, body?.renames as { from: string; to: string; words?: number }[]);
    json(res, { ok: true });
  });

  r.add("POST", "/api/shorts/:id/takes", async (req, res, p) => {
    const body = (await readJson(req)) as { name?: unknown };
    if (typeof body?.name !== "string") throw new HttpError(400, "a take needs a name");
    json(res, await lib().saveShortTake(p.id!, body.name), 201);
  });

  r.add("POST", "/api/shorts/:id/takes/restore", async (req, res, p) => {
    const body = (await readJson(req)) as { name?: unknown; revision?: unknown };
    if (typeof body?.name !== "string" || typeof body?.revision !== "string") throw new HttpError(400, "restore names the take and the revision it replaces");
    const out = await lib().restoreShortTake(p.id!, body.name, body.revision);
    emitLibrary();
    emitVideo(p.id!);
    json(res, out);
  });

  r.add("GET", "/api/shorts/:id/peaks/:track", async (_q, res, p) => {
    if (p.track !== "voice" && p.track !== "music") throw new HttpError(404, "no such track: voice or music");
    json(res, await lib().shortPeaks(p.id!, p.track));
  });

  r.add("GET", "/api/shorts/:id/preview", async (_q, res, p) => {
    const out = await lib().previewShort(p.id!);
    if (isValidationError(out)) return json(res, out, 422);
    json(res, out);
  });

  r.add("GET", "/api/videos/:id/slides.pdf", async (req, res, p) => {
    // stills share the machine with renders: not while a job runs on this video
    refuseIfActive(p.id!, "make its Slides PDF");
    const file = await lib().slidesPdf(p.id!, { log });
    const title = (await lib().detail(p.id!)).summary.title;
    const name = `${title.replace(/[\\/:*?"<>|]/g, "").trim() || "slides"} (slides).pdf`;
    if (!(await sendFile(req, res, file, { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-cache" }))) throw new HttpError(500, "the Slides PDF was not written");
  });

  r.add("PUT", "/api/videos/:id/voice/:n", async (req, res, p) => {
    const n = chapterParam(p);
    const body = await readJson(req);
    // checked after the body has arrived, right before the save: a job could start while it was arriving
    refuseIfActive(p.id!, "edit its pauses");
    const out = await lib().saveVoiceEdits(p.id!, n, body);
    if (isValidationError(out)) return json(res, out, 422);
    emitLibrary();
    emitVideo(p.id!);
    json(res, out);
  });

  r.add("GET", "/api/jobs", (_q, res) => json(res, runner.list()));

  r.add("POST", "/api/jobs", async (req, res) => json(res, await startJob(validateJob(await readJson(req))), 201));

  r.add("POST", "/api/jobs/:id/cancel", (_q, res, p) => json(res, runner.cancel(p.id!)));

  r.add("POST", "/api/jobs/:id/resume", async (_q, res, p) => {
    const job = await starting(async () => {
      const old = runner.get(p.id!);
      if (old && old.kind !== "export") await lib().detail(old.videoId); // a deleted video: 404, like POST /api/jobs
      return runner.resume(p.id!);
    });
    emitLibrary();
    emitVideo(job.videoId);
    json(res, job, 201);
  });

  r.add("POST", "/api/export", async (req, res) => {
    const er = validateExport(await readJson(req));
    const job = await starting(async () => {
      let title: string;
      if (er.videoIds?.length === 1) {
        const d = await lib().detail(er.videoIds[0]!);
        title = d.brief.title || d.summary.title;
      } else if (er.videoIds) title = `${er.videoIds.length} videos`;
      else title = er.folder ? `Folder ${er.folder}` : "Whole library";
      return runner.start({ videoId: er.videoIds?.[0] ?? "", videoTitle: title, kind: "export", exportRequest: er });
    });
    json(res, job, 201);
  });

  r.add("GET", "/api/voices", async (_q, res) => json(res, await voices.list()));

  r.add("POST", "/api/voices/sample", async (req, res) => {
    const b = await readJson(req);
    if (!isObject(b)) throw new ValidationFailed(["body: must be an object"]);
    const v = VoiceSchema.safeParse(b.voice);
    const errors = v.success ? [] : zodErrors(v.error).map((e) => `voice.${e}`);
    if (b.text !== undefined && !(isStr(b.text) && b.text.trim() && b.text.length <= 300)) errors.push("text: 1 to 300 characters");
    if (errors.length || !v.success) throw new ValidationFailed(errors);
    const text = isStr(b.text) ? b.text.trim() : SAMPLE_TEXT;
    const file = await voices.sample(v.data, text, settings.pronounce);
    if (!(await sendFile(req, res, file, { "Cache-Control": "private, max-age=3600" }))) throw new HttpError(500, "the sample was not written");
  });

  r.add("GET", "/api/settings", (_q, res) => json(res, settings));

  r.add("PUT", "/api/settings", async (req, res) => {
    const v = validateSettings(await readJson(req));
    if (!v.ok) throw new ValidationFailed(v.errors);
    await applySettings(v.settings);
    json(res, settings);
  });

  r.add("GET", "/api/events", (req, res) => events.attach(req, res));

  r.add("GET", "/api/fs/list", async (_q, res, _p, url) => {
    const homeReal = await realpath(home);
    const asked = url.searchParams.get("dir");
    const target = resolve(expandHome(asked && asked.trim() ? asked : home));
    let dir: string;
    try {
      dir = await realpath(target);
    } catch {
      throw new HttpError(404, `${target} does not exist`);
    }
    if (dir !== homeReal && !dir.startsWith(homeReal + sep)) throw new HttpError(403, "only folders inside your home folder can be listed");
    if (!(await stat(dir)).isDirectory()) throw new HttpError(400, `${dir} is not a folder`);
    const entries: { name: string; dir: boolean }[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = await stat(join(dir, e.name)).then((s) => s.isDirectory(), () => false);
      entries.push({ name: e.name, dir: isDir });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    json(res, { dir, entries });
  });

  // ---------------------------------------------------------------- dispatch

  async function media(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const segs = pathname.split("/").slice(2); // ["", "media", id, ...rest]
    const notFound = () => json(res, { error: "not found" }, 404);
    if (segs.length < 2) return notFound();
    let id: string, rel: string;
    try {
      id = decodeURIComponent(segs[0]!);
      const parts = segs.slice(1).map((s) => decodeURIComponent(s));
      if (parts.some((s) => s === ".." || s === "." || s === "" || s.includes("\0") || s.includes("/") || s.includes("\\"))) return notFound();
      rel = parts.join("/");
    } catch {
      return notFound();
    }
    let abs: string | null;
    try {
      abs = await lib().resolveMedia(id, rel);
    } catch {
      return notFound();
    }
    // Library files are untrusted: an HTML/SVG/XML file must never run script in the app's origin.
    const active = abs ? /\.(html?|svg|xml|xhtml)$/i.test(abs) : false;
    const headers: Record<string, string> = { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", ...(active ? { "Content-Security-Policy": "sandbox" } : {}) };
    if (!abs || !(await sendFile(req, res, abs, headers))) return notFound();
  }

  function hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return true;
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
    return LOCAL_HOSTS.has(name.toLowerCase());
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin || origin === "null") return true;
    try {
      const u = new URL(origin);
      if (u.protocol === "tauri:") return true;
      return LOCAL_HOSTS.has(u.hostname.toLowerCase()) || LOCAL_HOSTS.has(`[${u.hostname}]`);
    } catch {
      return false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    try {
      // Guards against other websites driving the local server (DNS rebinding, cross-site POSTs).
      if (!hostAllowed(req)) throw new HttpError(403, "forbidden host");
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && !originAllowed(req)) throw new HttpError(403, "forbidden origin");
      if (url.pathname.startsWith("/api/")) {
        const m = r.match(method, url.pathname);
        if (m === null) throw new HttpError(404, `no such endpoint: ${method} ${url.pathname}`);
        if (m === "method") throw new HttpError(405, `method ${method} not allowed on ${url.pathname}`);
        await m.handler(req, res, m.params, url);
        return;
      }
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
      if (url.pathname.startsWith("/media/")) return await media(req, res, url.pathname);
      await sendUi(req, res, uiDir, url.pathname);
    } catch (e) {
      if (res.headersSent) {
        log(`server: ${method} ${url.pathname} failed after the response started: ${errorMessage(e)}`);
        res.destroy();
        return;
      }
      if (e instanceof ValidationFailed) return json(res, { errors: e.errors }, 422);
      const status = statusForError(e);
      if (status >= 500 && !(e instanceof HttpError)) log(`server: ${method} ${url.pathname}: ${(e as Error)?.stack ?? errorMessage(e)}`);
      // a library 422 (LibraryError with status) keeps the ValidationError shape the contract promises
      if (status === 422) return json(res, { error: errorMessage(e), errors: [errorMessage(e)] }, 422);
      json(res, { error: errorMessage(e) }, status);
    }
  }

  const server = http.createServer((req, res) => void handle(req, res));
  server.keepAliveTimeout = 5000;

  let port = opts.port ?? (process.env.EMOTON_PORT ? Number(process.env.EMOTON_PORT) : DEFAULT_PORT);
  const host = opts.host ?? "127.0.0.1";

  return {
    server,
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get runner() {
      return runner;
    },
    events,
    settings: () => settings,
    listen: () =>
      new Promise<number>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          port = (server.address() as AddressInfo).port;
          resolveListen(port);
        });
      }),
    close: async () => {
      events.close();
      await runner.close();
      await new Promise<void>((res) => {
        server.close(() => res());
        server.closeAllConnections();
      });
    },
  };
}
