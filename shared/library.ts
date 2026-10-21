/**
 * THE SEAM between lane A (library/ + pipeline/: what a stage does, files on
 * disk, state) and lane B (server/: HTTP, jobs, lanes, events).
 *
 * Lane A: `library/index.ts` exports `createLibrary(opts): Library`.
 * Lane B: the server receives a `Library` and never touches bundle files
 * directly (except serving /media, via `resolveMedia`).
 *
 * The Library knows nothing about jobs. It reports file-derived state
 * (missing / ok / stale). The server overlays running / failed / making.
 */
import type {
  AddSourcesRequest, Brief, ChapterVoice, CreateVideoRequest, ExportRequest, JobKind, Lane,
  LibraryTree, NewShortRequest, Peaks, SeriesOverview, ShortDocument, ShortPreview, ShortTake, SoundLibrary, StageName, StartCandidate, VideoDetail, VideoState, VideoVoice, ValidationError,
} from "./api.ts";

export type LibraryOptions = {
  /** Absolute library root, e.g. ~/Emoton. Created if missing. */
  root: string;
  /** Merged under each brief's own pronounce map when voicing. */
  globalPronounce?: Record<string, string>;
  /** The sound effects library (Settings soundsRoot); its keys/ folder feeds the built-in keyboard sounds. */
  soundsRoot?: string;
  /** Defaults for fields a CreateVideoRequest leaves out. */
  defaults: Omit<Brief, "title" | "topic" | "layout">;
};

/** A file uploaded by the browser (multipart), already saved to a temp path by the server. */
export type Upload = { name: string; tmpPath: string };

/** One unit of work a job runs. The server runs a job's steps in order. */
export type PlannedStep = {
  stage: StageName | "export";
  chapter?: number;
  lane: Lane;
  note?: string;
  draft?: boolean;
};

export type StepContext = {
  /** Aborting must stop the step promptly and kill any child process tree (python TTS, claude CLI, Remotion's Chrome). */
  signal: AbortSignal;
  /** 0..1 within the step, plus a short human detail ("chapter 2 of 4, 43%"). */
  progress(p: number, detail?: string): void;
  log(line: string): void;
};

export type PlanOptions = {
  chapter?: number;
  note?: string;
  draft?: boolean;
  /** make: stop after outline (the plan ends with the outline step). */
  pauseAfterOutline?: boolean;
};

export interface Library {
  readonly root: string;

  // ---- tree and folders (paths are library-relative, "" = root)
  /** Scans the root. Every VideoSummary.status here is file-derived (draft / outline-review / partial / ready). */
  tree(): Promise<LibraryTree>;
  createFolder(parent: string, name: string): Promise<string>;
  /** Rename and/or move. Returns the new path. */
  updateFolder(path: string, change: { name?: string; parent?: string }): Promise<string>;
  /** Moves the folder to ~/.Trash (keeps a unique name there). */
  trashFolder(path: string): Promise<void>;

  // ---- videos
  /**
   * Creates `<folder>/<slug>.emoton/`, copies sources into `sources/`,
   * fetches URLs, writes project.json (with a new uuid) and runs ingest.
   * Title: brief.title, else the first words of the topic (the outline stage
   * replaces an auto title with the outline's title).
   */
  createVideo(req: CreateVideoRequest, uploads?: Upload[]): Promise<VideoDetail>;
  /** Absolute bundle dir for an id, or throws "unknown video". */
  resolve(id: string): Promise<string>;
  detail(id: string): Promise<VideoDetail>;
  state(id: string): Promise<VideoState>;
  updateBrief(id: string, patch: Partial<Brief>): Promise<VideoDetail>;
  /** Validates (schema + grounding); writes only when valid. */
  saveOutline(id: string, outline: unknown): Promise<VideoDetail | ValidationError>;
  saveChapter(id: string, n: number, chapter: unknown): Promise<VideoDetail | ValidationError>;
  addSources(id: string, req: AddSourcesRequest, uploads?: Upload[]): Promise<VideoDetail>;
  removeSource(id: string, sourceId: string): Promise<VideoDetail>;
  moveVideo(id: string, folder: string): Promise<VideoDetail>;
  duplicateVideo(id: string): Promise<VideoDetail>;
  trashVideo(id: string): Promise<void>;
  /** ChapterProps for the in-app Remotion Player. audio is `/media/<id>/audio/chN.wav` or "" when not voiced. */
  previewProps(id: string, n: number): Promise<unknown>;
  /** The Voice tab: every chapter whose voice is up to date, spoken and edited, with its pause edits. */
  voice(id: string): Promise<VideoVoice>;
  /** The Slides PDF of a slides video: made (one still per slide, about a minute) or the cached one. Absolute path. */
  slidesPdf(id: string, ctx?: { signal?: AbortSignal; log?: (l: string) => void }): Promise<string>;
  /** Saves chapter n's pause edits and remakes its voice (about a second). Returns the chapter as `voice` would. */
  saveVoiceEdits(id: string, n: number, edits: unknown): Promise<ChapterVoice | ValidationError>;

  // ---- Shorts
  /** Creates `<folder>/<slug>.emoton/` holding a Short: project.json (kind "short") and the document as short.json. */
  createShort(folder: string, document: unknown): Promise<VideoDetail | ValidationError>;
  /** A Short from a template (on a series' settings, numbered as its next episode), with the brief kept for the drafter. */
  newShort(req: NewShortRequest): Promise<VideoDetail | ValidationError>;
  /** Drops Ask's pending proposal (kept or not wanted). */
  dropShortProposal(id: string): Promise<void>;
  /** A series' settings, next episode, episodes in the library and the Perdix build they use. */
  seriesOverview(id: string): Promise<SeriesOverview>;
  shortDocument(id: string): Promise<ShortDocument>;
  /** Writes the document when it is valid and `revision` is still the file's (else 409). */
  saveShortDocument(id: string, document: unknown, revision: string): Promise<ShortDocument | ValidationError>;
  /** The Short composition's props for the player (media as /media URLs), or why the document does not resolve. */
  previewShort(id: string): Promise<ShortPreview | ValidationError>;
  /** The voice's or the song's waveform for the timeline (404 when the track has no file yet). */
  shortPeaks(id: string, track: "voice" | "music"): Promise<Peaks>;
  /** A song copied into the Short (assets/music/, a name made unique); its bundle path. */
  addShortMusic(id: string, uploads: Upload[]): Promise<{ asset: string }>;
  /** Video files copied into the Short (assets/clips/, a name made unique); their bundle paths. A make job makes their proxies. */
  addShortClips(id: string, uploads: Upload[]): Promise<{ assets: string[] }>;
  /** Starts for a scene's walking shot, found by the shot tool's search with the scene's knobs. */
  searchShotStarts(id: string, scene: string): Promise<StartCandidate[]>;
  /** A rewritten line's pause edits moved to its new sentence key (and any repeat keys that moved with it); the voice is remade by the next voice job. */
  renameShortPauses(id: string, renames: { from: string; to: string; words?: number }[]): Promise<void>;
  /** The sound effects library (made with its starting folders the first time). */
  sounds(): Promise<SoundLibrary>;
  /** A library sound's file, or null when the path is outside the library. */
  soundFile(path: string): Promise<string | null>;
  /** A library sound copied into the Short; its bundle path, to use in the document. */
  importSound(id: string, path: string): Promise<{ asset: string }>;
  /** Named takes of a Short, newest first (takes/<name>.json in its bundle). */
  shortTakes(id: string): Promise<ShortTake[]>;
  /** The current document kept as a take; a take of the same name is replaced. */
  saveShortTake(id: string, name: string): Promise<ShortTake>;
  /** A take made the current document again (refused, 409, when the document changed since `revision`). */
  restoreShortTake(id: string, name: string, revision: string): Promise<ShortDocument>;

  // ---- work
  /**
   * The steps a job of this kind needs right now, from file state: only
   * missing or stale work. make = ingest? → outline? → per chapter
   * storyboard → voice → render → join. redo n = storyboard n (with note,
   * always) → voice n → render n → join. An empty plan means nothing to do.
   * A Short's stages are its footage proxies and its voice (make plans both, voice only the voice, each when missing or stale); other kinds are refused (400).
   */
  plan(id: string, kind: Exclude<JobKind, "export">, opts?: PlanOptions): Promise<PlannedStep[]>;
  /** Runs one step. Throws on failure (message shown to the user); records lastError in state. */
  runStep(id: string, step: PlannedStep, ctx: StepContext): Promise<void>;
  /** Export (media lane). Returns absolute paths written. */
  exportVideos(req: ExportRequest, ctx: StepContext): Promise<string[]>;

  // ---- files
  /** Absolute path for a /media request, or null if outside the bundle or missing. */
  resolveMedia(id: string, rel: string): Promise<string | null>;
}
