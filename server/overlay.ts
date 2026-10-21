/**
 * Job-derived status on top of the Library's file-derived status:
 * an active job -> "making" (and running stages); the last job failed or
 * interrupted -> "failed" / "interrupted" (and its failed stage).
 */
import type { Job, JobBrief, JobStep, VideoDetail, VideoState, VideoSummary } from "../shared/api.ts";
import { stepLabel } from "./jobs.ts";

export type JobLookup = {
  activeFor(videoId: string): Job | undefined;
  lastFor(videoId: string): Job | undefined;
  outcomeFor(videoId: string): Job | undefined;
};

export function jobBrief(job: Job): JobBrief {
  const running = job.steps.find((s) => s.status === "running");
  const failed = job.steps.find((s) => s.status === "failed");
  const step = running ?? failed;
  const detail = step ? (step.detail ? `${stepLabel(step)}: ${step.detail}` : stepLabel(step)) : job.error;
  return { id: job.id, kind: job.kind, status: job.status, progress: job.progress, ...(detail ? { detail } : {}) };
}

export function overlaySummary(s: VideoSummary, jobs: JobLookup): VideoSummary {
  const active = jobs.activeFor(s.id);
  if (active) return { ...s, status: "making", job: jobBrief(active) };
  const last = jobs.lastFor(s.id);
  if (!last) return s;
  const out: VideoSummary = { ...s, job: jobBrief(last) };
  // failed / interrupted until a newer job succeeds (a cancelled one does not clear it)
  const outcome = jobs.outcomeFor(s.id);
  if (outcome?.status === "failed") out.status = "failed";
  else if (outcome?.status === "interrupted") out.status = "interrupted";
  return out;
}

function markStage(state: VideoState, step: JobStep, status: "running" | "failed") {
  switch (step.stage) {
    case "ingest":
    case "outline":
    case "join":
      state[step.stage] = status;
      return;
    case "storyboard":
    case "voice":
    case "render":
      for (const ch of state.chapters) {
        if (step.chapter === undefined || ch.n === step.chapter) ch[step.stage] = status;
      }
      return;
    default:
      return; // export has no stage status
  }
}

export function overlayState(state: VideoState, videoId: string, jobs: JobLookup): VideoState {
  const out = structuredClone(state);
  const active = jobs.activeFor(videoId);
  if (active) {
    for (const s of active.steps) if (s.status === "running") markStage(out, s, "running");
    return out;
  }
  const outcome = jobs.outcomeFor(videoId);
  if (outcome?.status === "failed") for (const s of outcome.steps) if (s.status === "failed") markStage(out, s, "failed");
  return out;
}

export function overlayDetail(d: VideoDetail, jobs: JobLookup): VideoDetail {
  const id = d.summary.id;
  return { ...d, summary: overlaySummary(d.summary, jobs), state: overlayState(d.state, id, jobs) };
}
