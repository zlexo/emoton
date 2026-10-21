/**
 * THE CONTRACT between the Emoton server (server/), the UI (app/) and the
 * Tauri shell (src-tauri/). The server, the UI and the shell are written
 * against it, so it changes first and on its own.
 *
 * All paths in the API are library-relative unless named `dir`/`abs`.
 * All timestamps are ISO 8601 strings. Chapter numbers are 1-based.
 */
import type { Chapter, ChapterTiming, Outline } from "../schema/storyboard.ts";
import type { Short } from "../schema/short.ts";
import type { ShortVideoProps } from "../src/remotion/shorts/props.ts";
import type { VoiceTiming } from "../src/core/short/resolve.ts";
import type { Series } from "../src/core/short/series.ts";

export type { Series };

export const PROTOCOL = 1;
export const DEFAULT_PORT = 8891;

// ---------------------------------------------------------------- stages

/** proxies: a Short's footage made light for the editor's player. */
export type StageName = "ingest" | "outline" | "storyboard" | "voice" | "render" | "join" | "proxies" | "shots" | "draft" | "ask";

/**
 * File-derived: "missing" (no output), "ok" (output matches its inputs' hash),
 * "stale" (output exists, inputs changed). The server overlays job-derived
 * "running" and "failed".
 */
export type StageStatus = "missing" | "ok" | "stale" | "running" | "failed";

export type ChapterState = {
  n: number;
  title: string;
  storyboard: StageStatus;
  voice: StageStatus;
  render: StageStatus;
  /** Seconds, once voiced. */
  duration?: number;
};

export type VideoState = {
  ingest: StageStatus;
  outline: StageStatus;
  join: StageStatus;
  chapters: ChapterState[];
  lastError?: { stage: StageName | "export"; chapter?: number; message: string; at: string };
};

/**
 * draft: no outline yet. outline-review: outline ok, no storyboard yet.
 * partial: some later stages missing or stale. ready: join ok.
 * making / failed / interrupted come from jobs (server overlay).
 */
export type VideoStatus = "draft" | "outline-review" | "partial" | "ready" | "making" | "failed" | "interrupted";

// ---------------------------------------------------------------- library

export type Voice = { engine: "kokoro" | "say"; voice: string; speed: number };

// ---------------------------------------------------------------- voice editor

/**
 * One chapter's pause edits, in ms added after a word or a sentence (negative
 * takes away). Keyed by the sentence's text, lowercased with its spacing
 * tidied, a repeat getting "#2"; `words[k]` is the pause after word k.
 */
export type PauseEdits = { version: 1; sentences: Record<string, { words?: Record<string, number>; after?: number }> };

/** A voiced chapter as the Voice tab shows it. */
export type ChapterVoice = {
  n: number;
  title: string;
  /** The voice as spoken; every sentence has words (`estimated` where the voice gave none). */
  spoken: ChapterTiming;
  /** With the edits applied: what plays. Its `audio` is a `/media/...` URL. */
  timing: ChapterTiming;
  /** Each sentence's edit key, by beat. */
  keys: string[][];
  edits: PauseEdits;
  /** Edit keys whose sentence is no longer in the chapter. */
  dropped: string[];
};

/** GET /api/videos/:id/voice: every chapter whose voice is up to date (others are left out). */
export type VideoVoice = { voice: Voice; chapters: ChapterVoice[] };

export type Brief = {
  title: string;
  topic: string;
  audience: string;
  minutes: number;
  rules: string[];
  voice: Voice;
  pronounce: Record<string, string>;
  writerModel: string;
  captions: boolean;
  /** "slides": slides to follow with an animation panel; "stage": the full-stage look. */
  layout: "slides" | "stage";
};

export type SourceInfo = {
  /** Chunk id prefix, e.g. "notes" (chunks are "notes:p6"). */
  id: string;
  title: string;
  kind: "pdf" | "text" | "url" | "youtube";
  /** Bundle-relative file ("sources/notes.pdf"), or the URL. */
  ref: string;
  pages?: number;
  chunks: number;
  /** True when ingest found no text (scanned PDF). */
  noText?: boolean;
};

export type JobBrief = { id: string; kind: JobKind; status: JobStatus; progress: number; detail?: string };

/** A narrated explainer (chapters, slides) or a Short (one short.json, edited on a timeline). */
export type VideoKind = "explainer" | "short";

export type VideoSummary = {
  id: string;
  slug: string;
  kind: VideoKind;
  title: string;
  /** Library-relative folder path, "" = library root. */
  folder: string;
  status: VideoStatus;
  /** Target minutes from the brief. */
  minutes: number;
  /** Seconds of the joined video, when ready. */
  duration?: number;
  chapters: number;
  /** URL (/media/...) of thumb.jpg, when it exists. */
  thumb?: string;
  created: string;
  updated: string;
  /** The running or last job for this video (server overlay). */
  job?: JobBrief;
};

export type FolderNode = {
  path: string;
  name: string;
  folders: FolderNode[];
  /** Videos directly in this folder. */
  videos: number;
  /** Videos in this folder and below. */
  total: number;
};

export type LibraryTree = { root: string; tree: FolderNode; videos: VideoSummary[] };

export type ChapterMarker = { title: string; start: number; end: number };

export type VideoDetail = {
  summary: VideoSummary;
  /** Absolute path of the .emoton bundle. */
  dir: string;
  brief: Brief;
  sources: SourceInfo[];
  outline?: Outline;
  chapters: (Chapter | null)[];
  state: VideoState;
  /** URL (/media/...) of the joined MP4, when ready. */
  video?: string;
  markers?: ChapterMarker[];
};

// ---------------------------------------------------------------- requests

export type CreateMode = "make" | "outline-first" | "draft";

/**
 * POST /api/videos. Either JSON with this body (sources by absolute path, as
 * the Tauri shell gives them), or multipart/form-data with a "request" field
 * holding this JSON plus one "files" part per uploaded file (browser drop).
 */
export type CreateVideoRequest = {
  folder: string;
  brief: Partial<Brief> & { topic: string };
  sourcePaths?: string[];
  urls?: string[];
  mode: CreateMode;
};

/** POST /api/videos/:id/sources: same two shapes, minus brief/folder/mode. */
export type AddSourcesRequest = { sourcePaths?: string[]; urls?: string[] };

export type ValidationError = { errors: string[] };

/**
 * A Short's document and its revision (a hash of the file as saved). A save
 * names the revision it was made from and is refused when the file has
 * changed since, so two editors never overwrite each other.
 */
export type ShortDocument = { document: Short; revision: string };

/**
 * What the in-app player plays for a Short: the composition's props, whether
 * they carry the real voice or a silent estimate, and that timing, so the
 * editor re-resolves its edits itself without a round trip.
 */
export type ShortPreview = { props: ShortVideoProps; voiced: boolean; timing: VoiceTiming; exports: ShortExport[]; shots: ShotState[]; clips: string[]; proxies: string[]; draft?: DraftNotes; ask?: AskProposal };
/** Ask's pending change: the request, Claude's summary, the revision it was made against, the proposed document. */
export type AskProposal = { at: string; request: string; summary: string; base: string; document: Short };
/** What Claude wants the maker to check after a draft: claims, shots no kind makes yet, the build. */
export type DraftNotes = { at: string; attempts: number; notes: string[] };

/** A Perdix shot of the Short: rendered from its knobs as they are, from older ones, not yet, or with no shot tool built at its commit. */
export type ShotState = { scene: string; kind: string; build: string; state: "ready" | "stale" | "missing" | "no-tool" };
/** A start a search found for a walking shot. */
/** What a start search found: a place and heading to start from, or (a life search) a seed and what that life does. */
export type StartCandidate = { x: number; z: number; yaw: number; note: string } | { seed: number; note: string };
/** The shot tools: the commits built, the ones building (and how it went), and Perdix's main. */
export type PerdixTools = { built: string[]; building: Record<string, { state: "building" | "failed"; log: string }>; main: string | null; behind: Record<string, number> };

/** A file the last export wrote into the Short's out/ folder. */
export type ShortExport = { name: string; url: string; size: number; at: string };

/** A sound in the sound effects library: its path in the library, name, category (its folder) and size in bytes. */
export type LibrarySound = { path: string; name: string; category: string; size: number };
export type SoundLibrary = { root: string; sounds: LibrarySound[] };

/** A named take: the document as it was when saved. */
export type ShortTake = { name: string; saved: string; document: Short };

/** POST /api/shorts: a Short started from a template, on a series' settings when one is named. The brief is kept for the drafter. */
export type NewShortRequest = { folder: string; template: Short["template"]; series?: string; title?: string; brief?: string };
/** A series' episode in the library. */
export type SeriesEpisode = { id: string; title: string; episode?: number; seconds?: number; status: VideoStatus; build?: string };
/** GET /api/series/:id: its settings, the next episode's number, the episodes made, and the Perdix build they use against Perdix's main. */
export type SeriesOverview = { series: Series; next: number; episodes: SeriesEpisode[]; build: { pinned?: string; main?: string; behind?: number } };

/** A track's waveform: the loudest sample per 1/rate s, 0 to 255, base64. */
export type Peaks = { rate: number; seconds: number; peaks: string };

// ---------------------------------------------------------------- jobs

export type JobKind = "make" | "outline" | "storyboard" | "voice" | "render" | "redo" | "export" | "draft" | "ask";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
export type Lane = "write" | "media";

export type JobStep = {
  stage: StageName | "export";
  chapter?: number;
  lane: Lane;
  status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";
  /** 0..1 within this step. */
  progress: number;
  detail?: string;
};

/** POST /api/jobs */
export type JobRequest = {
  videoId: string;
  kind: Exclude<JobKind, "export">;
  /** storyboard / voice / render / redo: one chapter; omitted = all needed. */
  chapter?: number;
  /** redo: the viewer's note ("slower, show EAGAIN step by step"); ask: what to change in the Short. */
  note?: string;
  /** 720p draft render. */
  draft?: boolean;
  /**
   * make: stop after the outline. Omitted = the server decides from
   * settings.pauseAfterOutlineOverMinutes and the brief's minutes.
   */
  pauseAfterOutline?: boolean;
};

export type Job = {
  id: string;
  videoId: string;
  videoTitle: string;
  kind: JobKind;
  chapter?: number;
  note?: string;
  draft?: boolean;
  status: JobStatus;
  steps: JobStep[];
  /** 0..1 over all steps. */
  progress: number;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /** Last 200 log lines. */
  log: string[];
  /** export: the files written. */
  files?: string[];
};

// ---------------------------------------------------------------- export

export type ExportFormat = "mp4" | "mp4-720" | "m4a" | "srt" | "md" | "bundle" | "slides-pdf";

/** POST /api/export → Job (kind "export"). Give videoIds or folder. */
export type ExportRequest = {
  videoIds?: string[];
  folder?: string;
  formats: ExportFormat[];
  /** Absolute destination directory. Folder export makes one subfolder per video. */
  dest: string;
};

// ---------------------------------------------------------------- settings, doctor, voices

export type StylePreset = { name: string; rules: string[] };

export type Settings = {
  libraryRoot: string;
  /** The sound effects library: a folder of downloaded sounds (subfolders are categories; keys/ feeds the keyboard sounds). */
  soundsRoot: string;
  defaults: { voice: Voice; minutes: number; writerModel: string; audience: string; captions: boolean };
  /** Make pauses after the outline when the brief is longer than this. null = never pause. */
  pauseAfterOutlineOverMinutes: number | null;
  renderQuality: "1080p" | "720p";
  /** Global pronunciation list, merged under each brief's own. */
  pronounce: Record<string, string>;
  stylePresets: StylePreset[];
};

export type DoctorCheckId =
  | "node" | "ffmpeg" | "pdftotext" | "yt-dlp" | "claude-login"
  | "python-tts" | "voice-model" | "render-browser" | "disk" | "library";

export type DoctorCheck = {
  id: DoctorCheckId;
  label: string;
  level: "ok" | "warn" | "error";
  detail: string;
  /** A command the user can run. */
  fix?: string;
  /** Something the server can do itself via POST /api/doctor/fix. */
  action?: "download-voice-model" | "create-library";
};

/**
 * A voice on this machine. `group` is how pickers list it ("Recommended" first,
 * then Kokoro by accent and gender, then macOS). `timed`: the voice reports
 * word times, so its pauses can be edited exactly; without them words are
 * estimated and a pause can only be added.
 */
export type VoiceOption = { engine: "kokoro" | "say"; voice: string; label: string; accent: string; gender?: "f" | "m"; group: string; timed: boolean };

// ---------------------------------------------------------------- events (GET /api/events, SSE)

export type ServerEvent =
  | { type: "hello"; protocol: number; version: string }
  | { type: "job"; job: Job }
  | { type: "library" } // tree changed: refetch /api/library
  | { type: "video"; id: string }; // detail changed: refetch /api/videos/:id

export type Health = { ok: true; protocol: number; version: string; gitHash: string; pid: number; libraryRoot: string };

/*
 * ENDPOINTS (all JSON unless noted; errors are { error: string } with 4xx/5xx,
 * validation failures are 422 ValidationError)
 *
 * GET    /api/health                         Health
 * GET    /api/doctor                         DoctorCheck[]
 * POST   /api/doctor/fix  {action}           Job-less; 202 then "library"/"hello" events; returns DoctorCheck[]
 * GET    /api/library                        LibraryTree
 * POST   /api/folders     {parent, name}     FolderNode path  -> { path }
 * PATCH  /api/folders     {path, name?, parent?}              -> { path }
 * DELETE /api/folders?path=                  moves to ~/.Trash (409 if a job runs inside)
 * POST   /api/videos      CreateVideoRequest (JSON or multipart) -> VideoDetail (and queues a job unless mode "draft")
 * GET    /api/videos/:id                     VideoDetail
 * PATCH  /api/videos/:id/brief  Partial<Brief>                 -> VideoDetail
 * PUT    /api/videos/:id/outline  Outline                      -> VideoDetail | 422
 * PUT    /api/videos/:id/chapters/:n  Chapter                  -> VideoDetail | 422
 * GET    /api/shorts/:id/document                             ShortDocument
 * PUT    /api/shorts/:id/document  {document, revision}       -> ShortDocument | 409 (changed since) | 422
 * GET    /api/shorts/:id/preview                              ShortPreview | 422 (the document does not resolve)
 * GET    /api/shorts/:id/peaks/voice|music                    Peaks | 404 (no such track yet)
 * GET    /api/shorts/:id/takes                                ShortTake[]
 * POST   /api/shorts/:id/takes  {name}                        -> ShortTake (201)
 * POST   /api/shorts/:id/takes/restore  {name, revision}      -> ShortDocument | 404 | 409
 * POST   /api/shorts/:id/voice/rename  {renames: [{from, to, words?}]}  -> {ok}   (a rewritten line's pause edits follow it)
 * GET    /api/perdix/kinds                                    the shot kinds and their knobs (sources/perdix/kinds.json)
 * GET    /api/perdix/tools                                    PerdixTools
 * POST   /api/perdix/tools  {commit}                          starts building the shot tool at a commit ("main" = Perdix's main) -> PerdixTools
 * POST   /api/shorts/:id/shots/:scene/search                  StartCandidate[] (walk-search or stuck-search with the scene's knobs)
 * POST   /api/shorts  NewShortRequest                       VideoDetail (201) | 422
 * GET    /api/series                                          Series[]
 * GET    /api/series/:id                                      SeriesOverview
 * DELETE /api/shorts/:id/ask                                 drops Ask's pending proposal
 * POST   /api/shorts/:id/music  multipart "files" (one)       -> {asset}: a song copied into the Short (assets/music/)
 * POST   /api/shorts/:id/clips  multipart "files"             -> {assets}: videos copied into the Short (assets/clips/)
 * GET    /api/sounds                                          SoundLibrary (the folder is made, with its starting folders, the first time)
 * GET    /api/sounds/file?path=<library path>                 the sound (ranges)
 * POST   /api/shorts/:id/sounds  {path}                       -> {asset}: the sound copied into the Short (assets/sounds/ or assets/music/)
 *        A Short's voice is chapter 1: GET /api/videos/:id/voice and PUT /api/videos/:id/voice/1 work on it.
 * POST   /api/videos/:id/sources  AddSourcesRequest (JSON or multipart) -> VideoDetail
 * DELETE /api/videos/:id/sources/:sourceId                     -> VideoDetail
 * POST   /api/videos/:id/move  {folder}                        -> VideoDetail
 * POST   /api/videos/:id/duplicate                             -> VideoDetail
 * DELETE /api/videos/:id                     moves to ~/.Trash (409 if a job runs)
 * GET    /api/videos/:id/preview/:n          ChapterProps (src/remotion/ChapterVideo.tsx);
 *                                            timing.audio is a /media URL, or "" (estimated, silent) before voice
 * GET    /api/videos/:id/slides.pdf          the Slides PDF (made on first request, then cached; 409 for a stage video,
 *                                            an unwritten chapter, or while a job runs)
 * GET    /api/videos/:id/voice               VideoVoice (chapters whose voice is up to date)
 * PUT    /api/videos/:id/voice/:n  PauseEdits ChapterVoice; remakes chapter n's voice with the edits
 *                                            (422 bad edits, 409 voice not up to date or a job runs)
 * GET    /api/jobs                           Job[] (newest first, last 100)
 * POST   /api/jobs        JobRequest         Job
 * POST   /api/jobs/:id/cancel                Job
 * POST   /api/jobs/:id/resume                Job (a new job continuing an interrupted/failed one)
 * POST   /api/export      ExportRequest      Job
 * GET    /api/voices                         VoiceOption[]
 * POST   /api/voices/sample {voice: Voice, text?} -> audio/wav
 * GET    /api/settings                       Settings
 * PUT    /api/settings    Settings           Settings
 * GET    /api/events                         text/event-stream of ServerEvent (data: JSON), heartbeat comment every 15 s
 * GET    /api/fs/list?dir=                   { dir, entries: {name, dir: boolean}[] } browser-only fallback for picking a destination
 * GET    /media/:id/<bundle-relative path>   file bytes, HTTP Range support (video seeking), no path escape
 * GET    /*                                  the built UI (app/dist), SPA fallback to index.html
 */
