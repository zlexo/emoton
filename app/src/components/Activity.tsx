import { useState } from "react";
import { api } from "../lib/api.ts";
import { go } from "../lib/route.ts";
import { useStore } from "../lib/store.tsx";
import { STAGE_LABEL, ago } from "../lib/format.ts";
import { reveal } from "../lib/native.ts";
import type { Job } from "../lib/types.ts";
import { IX } from "./Icons.tsx";

export function jobLine(j: Job): string {
  const cur = j.steps.find((s) => s.status === "running") ?? j.steps.find((s) => s.status === "failed");
  if (j.status === "queued") return "Waiting for a free slot";
  if (j.status === "done") return j.kind === "export" ? `Exported ${j.files?.length ?? 0} files` : "Done";
  if (j.status === "cancelled") return "Cancelled";
  if (j.status === "interrupted") return "Interrupted when Emoton quit";
  if (!cur) return j.status;
  const chapters = new Set(j.steps.filter((s) => s.stage === cur.stage && s.chapter).map((s) => s.chapter)).size;
  const label = (STAGE_LABEL[cur.stage] ?? cur.stage) + (!cur.chapter && ["storyboard", "voice", "render"].includes(cur.stage) ? "s" : "");
  const which = cur.chapter ? ` ${cur.chapter}${chapters > 1 ? ` of ${chapters}` : ""}` : "";
  return cur.detail ?? `${label}${which}${cur.status === "running" && cur.progress > 0 ? `, ${Math.round(cur.progress * 100)}%` : ""}`;
}

export function Activity({ onClose }: { onClose(): void }) {
  const { jobs } = useStore();
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const recent = jobs.filter((j) => !(j.status === "running" || j.status === "queued")).slice(0, 12);
  return (
    <div className="activity">
      <h5>
        Activity <span>{active.length ? `${active.length} running` : "idle"}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><IX /></button>
      </h5>
      <div className="list">
        {jobs.length === 0 && <div className="job" style={{ color: "var(--dim)" }}>Nothing has run yet.</div>}
        {[...active, ...recent].map((j) => <JobRow key={j.id} j={j} />)}
      </div>
    </div>
  );
}

function JobRow({ j }: { j: Job }) {
  const { toast } = useStore();
  const [log, setLog] = useState(false);
  const live = j.status === "running" || j.status === "queued";
  const act = (p: Promise<unknown>) => void p.catch((e: Error) => toast(e.message, "error"));
  return (
    <div className="job">
      <div className="t">
        {j.kind === "export" ? <b>{j.videoTitle || "Export"}</b> : <button className="job-title" onClick={() => go({ name: "video", id: j.videoId, tab: "watch" })}><b>{j.videoTitle}</b></button>}
        <em>{live ? `${Math.round(j.progress * 100)}%` : ago(j.endedAt ?? j.createdAt)}</em>
      </div>
      <div className="stages">
        {j.steps.map((s, i) => (
          <i key={i} className={s.status} title={`${STAGE_LABEL[s.stage] ?? s.stage}${s.chapter ? ` ${s.chapter}` : ""}: ${s.status}`}
            style={s.status === "running" ? { background: `linear-gradient(90deg, var(--blue) ${Math.round(s.progress * 100)}%, var(--line2) ${Math.round(s.progress * 100)}%)` } : undefined} />
        ))}
      </div>
      <div className="s">
        <span>{jobLine(j)}</span>
        <span className="acts">
          {live && <button onClick={() => act(api.cancelJob(j.id))}>Cancel</button>}
          {(j.status === "interrupted" || j.status === "failed") && j.kind !== "export" && <button onClick={() => act(api.resumeJob(j.id))}>Resume</button>}
          {j.status === "done" && j.files?.[0] && <button onClick={() => void reveal(j.files![0]!).then((ok) => ok || toast(j.files![0]!))}>Show in Finder</button>}
          {j.log.length > 0 && <button onClick={() => setLog((l) => !l)}>{log ? "Hide log" : "Log"}</button>}
        </span>
      </div>
      {j.error && <div className="err">{j.error}</div>}
      {log && <pre>{j.log.slice(-60).join("\n")}</pre>}
    </div>
  );
}
