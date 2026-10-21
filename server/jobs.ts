/**
 * The job runner. A job's steps come from `library.plan()` and run in order;
 * each step waits for a slot in its lane (write x2, media x1). One active job
 * per video. Jobs persist to `<libraryRoot>/.emoton/jobs.json`; after a
 * restart, queued or running jobs become "interrupted".
 */
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ExportRequest, Job, JobKind, JobStep, Lane } from "../shared/api.ts";
import type { Library, PlannedStep, StepContext } from "../shared/library.ts";
import { errorMessage, HttpError } from "./http.ts";
import { LaneSlots } from "./lanes.ts";
import { writeJsonAtomic } from "./settings.ts";

export const MAX_JOBS = 100;
export const MAX_LOG = 200;

/** What a job needs to be re-created by resume. Persisted, never sent to clients. */
type JobParams = {
  pauseAfterOutline?: boolean;
  exportRequest?: ExportRequest;
  /** redo only: the chapter was already rewritten by an earlier job in this resume chain. */
  skipStoryboard?: boolean;
};
type JobRecord = Job & { params?: JobParams };

export type StartJob = {
  videoId: string;
  videoTitle: string;
  kind: JobKind;
  chapter?: number;
  note?: string;
  draft?: boolean;
  /** make only: already decided by the caller (request or settings). */
  pauseAfterOutline?: boolean;
  /** export only. */
  exportRequest?: ExportRequest;
  /** redo resume chains: do not rewrite the chapter again. */
  skipStoryboard?: boolean;
};

export type RunnerHooks = {
  library(): Library;
  /** A job changed. `final` is true for the change that ends it. */
  onJob(job: Job, final: boolean): void;
  /** A video's detail changed (a step finished, a job ended). */
  onVideo(id: string): void;
  /** The library tree changed. */
  onLibrary(): void;
  log(msg: string): void;
};

const ACTIVE = new Set(["queued", "running"]);
export const isActive = (j: Job) => ACTIVE.has(j.status);

const STAGE_LABEL: Record<string, string> = {
  ingest: "Reading sources",
  outline: "Writing the outline",
  storyboard: "Writing chapter",
  voice: "Voicing chapter",
  render: "Rendering chapter",
  join: "Joining chapters",
  export: "Exporting",
};

export function stepLabel(s: { stage: string; chapter?: number }): string {
  const base = STAGE_LABEL[s.stage] ?? s.stage;
  if (s.chapter !== undefined && base.endsWith("chapter")) return `${base} ${s.chapter}`;
  if (s.chapter !== undefined) return `${base} (chapter ${s.chapter})`;
  return base.endsWith("chapter") ? `${base}s` : base;
}

const now = () => new Date().toISOString();

function publicJob(j: JobRecord): Job {
  const { params: _p, ...rest } = j;
  return structuredClone(rest);
}

type Run = {
  controller: AbortController;
  planned: PlannedStep[];
  /** Resolves when the run loop has fully unwound (step promise settled, lane slot released). */
  settled: Promise<void>;
};

export class JobRunner {
  private jobs: JobRecord[] = [];
  private runs = new Map<string, Run>();
  /** videoId -> the settle promise of the last run on it, so a new job never overlaps a stopping one. */
  private videoTail = new Map<string, Promise<void>>();
  readonly lanes: Record<Lane, LaneSlots>;
  private writing: Promise<void> | null = null;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private closed = false;
  readonly file: string;

  constructor(libraryRoot: string, private hooks: RunnerHooks, limits: Record<Lane, number> = { write: 2, media: 1 }) {
    this.file = join(libraryRoot, ".emoton", "jobs.json");
    this.lanes = { write: new LaneSlots(limits.write), media: new LaneSlots(limits.media) };
  }

  // ------------------------------------------------------------ persistence

  /** Reads jobs.json. Queued or running jobs from a previous run become interrupted. */
  async load() {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.hooks.log(`jobs: cannot read ${this.file}: ${errorMessage(e)}`);
      return;
    }
    let jobs: JobRecord[];
    try {
      const data = JSON.parse(raw) as { jobs?: JobRecord[] };
      if (!Array.isArray(data.jobs)) throw new Error("no jobs array");
      const bad = data.jobs.findIndex((j) => !isJobShape(j));
      if (bad >= 0) throw new Error(`entry ${bad} is not a job`);
      jobs = data.jobs;
    } catch (e) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      this.hooks.log(`jobs: ${this.file} is unreadable (${errorMessage(e)}), moved to ${aside}`);
      await rename(this.file, aside).catch(() => {});
      return;
    }
    let changed = false;
    for (const j of jobs) {
      if (!isActive(j)) continue;
      changed = true;
      j.status = "interrupted";
      j.endedAt = now();
      j.error = "Emoton stopped while this job was running";
      for (const s of j.steps) {
        if (s.status === "running") {
          s.status = "cancelled";
          s.detail = "interrupted";
        } else if (s.status === "pending") {
          s.status = "skipped"; // like the failure path; resume replans from files
        }
      }
      pushLog(j, "Interrupted: Emoton stopped while this job was running.");
    }
    this.jobs = jobs.slice(0, MAX_JOBS);
    if (changed) await this.save();
  }

  /**
   * Writes jobs.json. Writes never overlap; changes that arrive while one is
   * in flight are folded into a single follow-up write of the latest state.
   * The promise resolves once the state as of this call is on disk.
   */
  save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = true;
    if (!this.writing) this.writing = this.drain();
    return this.writing;
  }

  private async drain() {
    while (this.dirty) {
      this.dirty = false;
      const data = JSON.stringify({ version: 1, jobs: this.jobs });
      try {
        await writeJsonAtomic(this.file, JSON.parse(data));
      } catch (e) {
        this.hooks.log(`jobs: cannot write ${this.file}: ${errorMessage(e)}`);
      }
    }
    this.writing = null;
  }

  /** Coalesces frequent changes (progress, log) into one write. */
  private saveSoon() {
    if (this.closed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  // ------------------------------------------------------------ queries

  list(): Job[] {
    return this.jobs.map(publicJob);
  }

  get(id: string): Job | undefined {
    const j = this.jobs.find((x) => x.id === id);
    return j && publicJob(j);
  }

  /** The active (queued or running) non-export job for a video. */
  activeFor(videoId: string): Job | undefined {
    const j = this.jobs.find((x) => x.videoId === videoId && x.kind !== "export" && isActive(x));
    return j && publicJob(j);
  }

  /** The newest non-export job for a video (active or not). */
  lastFor(videoId: string): Job | undefined {
    const j = this.jobs.find((x) => x.videoId === videoId && x.kind !== "export");
    return j && publicJob(j);
  }

  /**
   * The newest finished job for a video that decides its status: done, failed
   * or interrupted (a cancelled job decides nothing, so it is skipped).
   */
  outcomeFor(videoId: string): Job | undefined {
    const j = this.jobs.find((x) => x.videoId === videoId && x.kind !== "export" && ["done", "failed", "interrupted"].includes(x.status));
    return j && publicJob(j);
  }

  hasActive(): boolean {
    return this.jobs.some(isActive);
  }

  activeVideoIds(): Set<string> {
    return new Set(this.jobs.filter((j) => isActive(j) && j.kind !== "export").map((j) => j.videoId));
  }

  // ------------------------------------------------------------ commands

  async start(input: StartJob): Promise<Job> {
    return this.startWith(input, (plan) => plan);
  }

  /** A new job with the same kind and parameters as a failed, interrupted or cancelled one. */
  async resume(id: string): Promise<Job> {
    const old = this.jobs.find((x) => x.id === id);
    if (!old) throw new HttpError(404, "unknown job");
    if (!["failed", "interrupted", "cancelled"].includes(old.status)) {
      throw new HttpError(409, `only a failed, interrupted or cancelled job can be resumed (this one is ${old.status})`);
    }
    // redo always rewrites its storyboard chapter. When the old job already did
    // that, resuming must not write it again: continue with what came after.
    // Carried forward, so resuming a resumed redo (which has no storyboard step) still skips it.
    const skipStoryboard =
      old.kind === "redo" && (old.params?.skipStoryboard === true || old.steps.some((s) => s.stage === "storyboard" && s.status === "done"));
    return this.startWith(
      {
        videoId: old.videoId,
        videoTitle: old.videoTitle,
        kind: old.kind,
        chapter: old.chapter,
        note: old.note,
        draft: old.draft,
        pauseAfterOutline: old.params?.pauseAfterOutline,
        exportRequest: old.params?.exportRequest,
        ...(skipStoryboard ? { skipStoryboard: true } : {}),
      },
      (plan) => (skipStoryboard ? plan.filter((s) => s.stage !== "storyboard") : plan),
      old.id,
    );
  }

  private async startWith(input: StartJob, adjust: (p: PlannedStep[]) => PlannedStep[], resumedFrom?: string): Promise<Job> {
    if (this.closed) throw new HttpError(503, "server is shutting down");
    if (input.kind !== "export" && this.activeFor(input.videoId)) {
      throw new HttpError(409, "a job is already running for this video");
    }
    const job: JobRecord = {
      id: randomUUID(),
      videoId: input.videoId,
      videoTitle: input.videoTitle,
      kind: input.kind,
      ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
      status: "queued",
      steps: [],
      progress: 0,
      createdAt: now(),
      log: [],
      params: {
        ...(input.pauseAfterOutline !== undefined ? { pauseAfterOutline: input.pauseAfterOutline } : {}),
        ...(input.exportRequest ? { exportRequest: input.exportRequest } : {}),
        ...(input.skipStoryboard ? { skipStoryboard: true } : {}),
      },
    };
    if (resumedFrom) pushLog(job, `Resumed from job ${resumedFrom}.`);
    if (input.kind === "make" && input.pauseAfterOutline) pushLog(job, "Will pause after the outline.");
    const controller = new AbortController();
    // Registered synchronously, before any await: a second request for the same video sees it.
    this.jobs.unshift(job);
    this.prune();
    const run: Run = { controller, planned: [], settled: Promise.resolve() };
    this.runs.set(job.id, run);
    this.changed(job, false, true);

    let planned: PlannedStep[];
    try {
      planned = input.exportRequest
        ? [{ stage: "export", lane: "media" }]
        : adjust(
            await this.hooks.library().plan(input.videoId, input.kind as Exclude<JobKind, "export">, {
              ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
              ...(input.note !== undefined ? { note: input.note } : {}),
              ...(input.draft !== undefined ? { draft: input.draft } : {}),
              ...(input.pauseAfterOutline !== undefined ? { pauseAfterOutline: input.pauseAfterOutline } : {}),
            }),
          );
    } catch (e) {
      this.runs.delete(job.id);
      if (job.status === "cancelled") return publicJob(job);
      job.status = "failed";
      job.error = `Could not plan the job: ${errorMessage(e)}`;
      job.endedAt = now();
      pushLog(job, job.error);
      this.changed(job, true, true);
      return publicJob(job);
    }
    if (job.status === "cancelled") {
      this.runs.delete(job.id);
      return publicJob(job);
    }
    if (this.closed) {
      // the runner closed while planning (shutdown or library switch); on disk the job is queued, so the next start marks it interrupted
      this.runs.delete(job.id);
      throw new HttpError(503, "the server is shutting down or switching libraries; try again");
    }
    run.planned = planned;
    job.steps = planned.map((p) => ({
      stage: p.stage,
      ...(p.chapter !== undefined ? { chapter: p.chapter } : {}),
      lane: p.lane,
      status: "pending",
      progress: 0,
    }));
    if (planned.length === 0) {
      this.runs.delete(job.id);
      job.status = "done";
      job.progress = 1;
      job.startedAt = job.endedAt = now();
      pushLog(job, "Nothing to do: everything is up to date.");
      this.changed(job, true, true);
      return publicJob(job);
    }
    this.changed(job, false, true);

    const previous = input.kind === "export" ? Promise.resolve() : this.videoTail.get(input.videoId) ?? Promise.resolve();
    run.settled = this.runLoop(job, run, previous).catch((e) => this.hooks.log(`jobs: run loop crashed: ${errorMessage(e)}`));
    if (input.kind !== "export") {
      const tail = run.settled;
      this.videoTail.set(input.videoId, tail);
      void tail.then(() => {
        if (this.videoTail.get(input.videoId) === tail) this.videoTail.delete(input.videoId);
      });
    }
    return publicJob(job);
  }

  private async runLoop(job: JobRecord, run: Run, previous: Promise<void>) {
    const { signal } = run.controller;
    await previous; // a cancelled job on the same video may still be unwinding its step
    try {
      for (let i = 0; i < job.steps.length; i++) {
        if (this.closed || signal.aborted || job.status === "cancelled") return;
        const step = job.steps[i]!;
        const planned = run.planned[i]!;
        let release: () => void;
        try {
          release = await this.lanes[step.lane].acquire(signal);
        } catch {
          return; // cancelled while waiting for a slot
        }
        try {
          if (job.status !== "queued" && job.status !== "running") return;
          if (job.status === "queued") {
            job.status = "running";
            job.startedAt = now();
          }
          step.status = "running";
          step.progress = 0;
          pushLog(job, `${stepLabel(step)}: started`);
          this.changed(job, false, true);
          this.hooks.onVideo(job.videoId);

          const live = () => job.status === "running" && step.status === "running" && !this.closed;
          const ctx: StepContext = {
            signal,
            progress: (p, detail) => {
              if (!live()) return;
              step.progress = clamp01(p);
              if (detail !== undefined) step.detail = detail;
              job.progress = jobProgress(job.steps);
              this.changed(job, false, false);
            },
            log: (line) => {
              if (!live()) return;
              pushLog(job, String(line));
              this.changed(job, false, false);
            },
          };
          try {
            if (planned.stage === "export") {
              const req = job.params?.exportRequest;
              if (!req) throw new Error("export job without a request");
              job.files = await this.hooks.library().exportVideos(req, ctx);
            } else {
              await this.hooks.library().runStep(job.videoId, planned, ctx);
            }
          } catch (e) {
            if (this.closed || job.status !== "running") return; // cancelled or shutting down: already recorded
            if (signal.aborted) return;
            step.status = "failed";
            job.status = "failed";
            job.error = errorMessage(e);
            job.endedAt = now();
            for (const s of job.steps) if (s.status === "pending") s.status = "skipped";
            pushLog(job, `${stepLabel(step)}: failed: ${job.error}`);
            this.changed(job, true, true);
            this.hooks.onVideo(job.videoId);
            this.hooks.onLibrary();
            return;
          }
          if (this.closed || job.status !== "running") return;
          step.status = "done";
          step.progress = 1;
          job.progress = jobProgress(job.steps);
          pushLog(job, `${stepLabel(step)}: done`);
          const last = i === job.steps.length - 1;
          if (last) {
            job.status = "done";
            job.progress = 1;
            job.endedAt = now();
          }
          this.changed(job, last, true);
          this.hooks.onVideo(job.videoId);
          this.hooks.onLibrary();
        } finally {
          release();
        }
      }
    } finally {
      this.runs.delete(job.id);
    }
  }

  /** Stops a job: aborts its running step (the library kills its processes), cancels the rest. */
  cancel(id: string): Job {
    const job = this.jobs.find((x) => x.id === id);
    if (!job) throw new HttpError(404, "unknown job");
    if (!isActive(job)) return publicJob(job);
    job.status = "cancelled";
    job.endedAt = now();
    for (const s of job.steps) if (s.status === "running" || s.status === "pending") s.status = "cancelled";
    pushLog(job, "Cancelled.");
    this.runs.get(id)?.controller.abort();
    this.changed(job, true, true);
    this.hooks.onVideo(job.videoId);
    this.hooks.onLibrary();
    return publicJob(job);
  }

  /**
   * Shutdown: writes the current state as it is (running jobs stay "running"
   * on disk, so the next start marks them interrupted), then aborts every
   * step so child processes die, and waits for the steps to unwind.
   */
  async close(waitMs = 5000) {
    if (this.closed) return;
    this.closed = true;
    await this.save();
    const settles = [...this.runs.values()].map((r) => {
      r.controller.abort();
      return r.settled;
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(settles), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    if (this.writing) await this.writing;
  }

  // ------------------------------------------------------------ internals

  private changed(job: JobRecord, final: boolean, persistNow: boolean) {
    if (this.closed) return;
    if (persistNow) void this.save();
    else this.saveSoon();
    this.hooks.onJob(publicJob(job), final);
  }

  private prune() {
    if (this.jobs.length <= MAX_JOBS) return;
    const keep: JobRecord[] = [];
    for (const j of this.jobs) if (keep.length < MAX_JOBS || isActive(j)) keep.push(j);
    this.jobs = keep;
  }
}

/** Enough shape to render and resume a job; anything less means the file is not ours or is damaged. */
function isJobShape(j: unknown): j is JobRecord {
  if (!j || typeof j !== "object") return false;
  const x = j as Record<string, unknown>;
  return (
    typeof x.id === "string" && typeof x.videoId === "string" && typeof x.kind === "string" && typeof x.status === "string" &&
    typeof x.createdAt === "string" && Array.isArray(x.log) &&
    Array.isArray(x.steps) && x.steps.every((s) => !!s && typeof s === "object" && typeof (s as JobStep).stage === "string" && typeof (s as JobStep).status === "string")
  );
}

function clamp01(p: number) {
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}

export function jobProgress(steps: JobStep[]): number {
  if (steps.length === 0) return 1;
  let sum = 0;
  for (const s of steps) sum += s.status === "done" ? 1 : s.status === "running" ? s.progress : 0;
  return Math.round((sum / steps.length) * 1000) / 1000;
}

function pushLog(job: Job, line: string) {
  for (const l of line.split(/\r?\n/)) {
    if (!l.trim()) continue;
    job.log.push(l.length > 1000 ? l.slice(0, 1000) + "..." : l);
  }
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
}
