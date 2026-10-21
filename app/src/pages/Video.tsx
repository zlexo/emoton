import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { go, type Route, type Tab } from "../lib/route.ts";
import { useStore, useVideo } from "../lib/store.tsx";
import { STATUS, citeLabel, folderName, mmss } from "../lib/format.ts";
import { reveal } from "../lib/native.ts";
import { useHasDrafts } from "../lib/drafts.ts";
import type { ChapterTiming, JobRequest, VideoDetail } from "../lib/types.ts";
import type { Sheets } from "../App.tsx";
import { jobLine } from "../components/Activity.tsx";
import { FolderPicker } from "../components/FolderPicker.tsx";
import { MenuButton } from "../components/Listbox.tsx";
import { IDots } from "../components/Icons.tsx";
import { Watch } from "./video/Watch.tsx";
import { Script } from "./video/Script.tsx";
import { Preview } from "./video/Preview.tsx";
import { Voice } from "./video/Voice.tsx";
import { Sources } from "./video/Sources.tsx";
import { BriefTab } from "./video/Brief.tsx";
import { ShortPage } from "./ShortPage.tsx";

export type Playhead = { chapter: number; beat: number; seek?: { chapter: number; at: number } };

/** Timing per chapter (from the preview props), for beat-level seeking. */
export function useTimings(v: VideoDetail | null): Record<number, ChapterTiming> {
  const [t, setT] = useState<Record<number, ChapterTiming>>({});
  const key = v ? `${v.summary.id}:${v.state.chapters.map((c) => `${c.storyboard}${c.voice}${c.duration ?? ""}`).join(",")}:${v.chapters.map((c) => (c ? 1 : 0)).join("")}` : "";
  useEffect(() => {
    if (!v) return;
    let live = true;
    const ns = v.chapters.map((c, i) => (c ? i + 1 : 0)).filter(Boolean);
    Promise.all(ns.map((n) => api.preview(v.summary.id, n).then((p) => [n, p.timing] as const).catch(() => null))).then((rows) => {
      if (live) setT(Object.fromEntries(rows.filter(Boolean) as [number, ChapterTiming][]));
    });
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return t;
}

export function VideoPage({ route, sheets }: { route: Extract<Route, { name: "video" }>; sheets: Sheets }) {
  const { video, error, reload } = useVideo(route.id);
  const { jobs, toast, refreshLibrary } = useStore();
  const [head, setHead] = useState<Playhead>({ chapter: route.chapter ?? 1, beat: -1 });
  const [moving, setMoving] = useState(false);
  const timings = useTimings(video);
  const dirty = useHasDrafts(`${route.id}:`);
  const outlineDirty = useHasDrafts(`${route.id}:outline`);
  const narrationDirty = useHasDrafts(`${route.id}:narration`);
  const scriptDirty = outlineDirty || narrationDirty;
  const briefDirty = useHasDrafts(`${route.id}:brief`);
  const tab = route.tab;
  const setTab = (t: Tab) => go({ name: "video", id: route.id, tab: t });

  const job = useMemo(() => jobs.find((j) => j.videoId === route.id && (j.status === "running" || j.status === "queued")), [jobs, route.id]);
  const lastJob = useMemo(() => jobs.find((j) => j.videoId === route.id && j.kind !== "export"), [jobs, route.id]);

  if (error) return <main className="main"><div className="empty"><h2>This video could not be opened</h2><div>{error}</div><button className="btn" onClick={() => go({ name: "library", folder: null })}>Back to the library</button></div></main>;
  if (!video) return <main className="main" />;
  if (video.summary.kind === "short") return <ShortPage video={video} />;

  const s = video.summary;
  const run = async (req: Omit<JobRequest, "videoId">, msg: string): Promise<boolean> => {
    try {
      await api.startJob({ videoId: s.id, ...req });
      toast(msg, "ok");
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  };
  const changed = video.state.chapters.filter((c) => c.storyboard === "ok" && (c.voice !== "ok" || c.render !== "ok"));
  const staleOutline = video.state.outline === "stale";

  return (
    <div className="vwrap">
      <div className="vleft">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 34 }}>
          <button className="btn ghost small" onClick={() => go({ name: "library", folder: s.folder })}>← {folderName(s.folder)}</button>
          <h1 className="serif" style={{ fontWeight: 400, fontSize: 24, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</h1>
          <span className={`chip ${job ? "making" : STATUS[s.status].cls}`}>{job ? "Making" : STATUS[s.status].label}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => sheets.exportVideos({ ids: [s.id] })}>Export</button>
          <MenuButton align="right" items={[
            { label: "Move to…", run: () => setMoving(true) },
            { label: "Duplicate", run: () => void api.duplicateVideo(s.id).then((d) => (refreshLibrary(), go({ name: "video", id: d.summary.id, tab: "brief" }))).catch((e: Error) => toast(e.message, "error")) },
            { label: "Show in Finder", run: () => void reveal(video.dir).then((ok) => ok || toast(video.dir)) },
            "sep",
            { label: "Move to Trash", danger: true, run: () => void api.trashVideo(s.id).then(() => (refreshLibrary(), go({ name: "library", folder: s.folder }), toast(`Moved "${s.title}" to the Trash`))).catch((e: Error) => toast(e.message, "error")) },
          ]}><IDots size={16} /></MenuButton>
        </div>

        {job ? (
          <div className="notice">
            <div className="txt"><b>{jobLine(job)}</b><span>{Math.round(job.progress * 100)}% · it keeps going in the background while you work</span></div>
            <div className="prog" style={{ width: 160, marginTop: 0 }}><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
            <button className="btn" onClick={() => void api.cancelJob(job.id).catch((e: Error) => toast(e.message, "error"))}>Cancel</button>
          </div>
        ) : s.status === "failed" || s.status === "interrupted" ? (
          <div className={`notice ${s.status === "failed" ? "failed" : "review"}`}>
            <div className="txt">
              <b>{s.status === "failed" ? "The last run failed" : "Interrupted when Emoton quit"}</b>
              <span style={{ userSelect: "text" }}>{video.state.lastError?.message ?? lastJob?.error ?? "Resume picks up where it stopped."}</span>
            </div>
            {s.status === "failed" && video.state.lastError && ["outline", "storyboard"].includes(video.state.lastError.stage) && (
              <RetryWithNote onRetry={(note) => run(
                video.state.lastError!.stage === "outline" ? { kind: "outline", note } : { kind: "storyboard", chapter: video.state.lastError!.chapter, note },
                "Retrying with your note",
              )} />
            )}
            {lastJob && <button className="btn primary" onClick={() => void api.resumeJob(lastJob.id).then(() => toast("Resuming", "ok")).catch((e: Error) => toast(e.message, "error"))}>{s.status === "failed" ? "Retry" : "Resume"}</button>}
          </div>
        ) : s.status === "draft" ? (
          <div className="notice">
            <div className="txt"><b>No outline yet</b><span>Write the outline to review it, or make the whole video in one go.</span></div>
            <button className="btn" onClick={() => void run({ kind: "make", pauseAfterOutline: true }, "Writing the outline")}>Write outline</button>
            <button className="btn primary" onClick={() => void run({ kind: "make", pauseAfterOutline: false }, "Making your video")}>Make it</button>
          </div>
        ) : s.status === "outline-review" ? (
          <div className="notice review">
            <div className="txt"><b>The outline is ready for you</b><span>Check the chapters and claims in Script, edit anything, then continue. Fixing an outline is cheap; fixing a render is not.</span></div>
            {tab !== "script" && <button className="btn" onClick={() => setTab("script")}>Review outline</button>}
            <button className="btn primary" disabled={dirty} onClick={() => void run({ kind: "make", pauseAfterOutline: false }, "Writing, voicing and rendering")}>Continue</button>
          </div>
        ) : staleOutline || changed.length > 0 ? (
          <div className="notice review">
            <div className="txt">
              <b>{staleOutline ? "The brief changed" : `${changed.length === 1 ? `Chapter ${changed[0]!.n} changed` : `${changed.length} chapters changed`}`}</b>
              <span>{staleOutline ? "The outline no longer matches the brief. Update to rewrite it; unchanged work is reused." : "Only the changed chapters are voiced and rendered again."}</span>
            </div>
            <button className="btn primary" disabled={dirty} onClick={() => void run({ kind: "make", pauseAfterOutline: false }, "Updating the video")}>Update video</button>
          </div>
        ) : null}

        <div className="tabs">
          {(["watch", "script", "voice", "preview", "sources", "brief"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
              {((t === "script" && (scriptDirty || s.status === "outline-review")) || (t === "brief" && briefDirty)) && <span className="dotmark" />}
            </button>
          ))}
        </div>

        {tab === "watch" && <Watch video={video} head={head} setHead={setHead} timings={timings} onRedo={(n, note) => run({ kind: "redo", chapter: n, note }, `Redoing chapter ${n}`)} />}
        {tab === "script" && <Script video={video} focusChapter={head.chapter} busy={!!job} />}
        {tab === "voice" && <Voice video={video} chapter={head.chapter} setChapter={(n) => setHead({ chapter: n, beat: -1 })} busy={!!job} />}
        {tab === "preview" && <Preview video={video} chapter={head.chapter} setChapter={(n) => setHead({ chapter: n, beat: -1 })} />}
        {tab === "sources" && <Sources video={video} onChanged={reload} />}
        {tab === "brief" && <BriefTab video={video} onSaved={reload} />}
      </div>

      <aside className="vright">
        <div className="scroll">
          <h6>Chapters{video.markers ? ` · ${mmss(video.markers[video.markers.length - 1]!.end)}` : ""}</h6>
          {video.outline ? video.outline.chapters.map((c, i) => {
            const n = i + 1;
            const st = video.state.chapters[i];
            const ch = video.chapters[i];
            const on = head.chapter === n;
            const pending = st && st.storyboard === "ok" && (st.voice !== "ok" || st.render !== "ok");
            const timing = timings[n];
            return (
              <div key={n}>
                <button className={`chap${on ? " on" : ""}`} onClick={() => setHead({ chapter: n, beat: -1, seek: { chapter: n, at: 0 } })}>
                  <div className="num">{n}</div>
                  <div>
                    <div className="ti">{ch?.title ?? c.title}</div>
                    <div className="me">
                      {st?.duration ? mmss(st.duration) : "not voiced"}{ch ? ` · ${ch.beats.length} beats` : " · not written"}
                      {pending && <> · <b>changed, not rendered</b></>}
                      {st?.storyboard === "running" || st?.voice === "running" || st?.render === "running" ? <> · <span style={{ color: "var(--blue)" }}>working</span></> : null}
                    </div>
                  </div>
                </button>
                {on && ch && (
                  <div className="beats">
                    {ch.beats.map((b, k) => (
                      <button key={k} className={`beat${head.beat === k ? " on" : ""}`}
                        onClick={() => setHead({ chapter: n, beat: k, seek: timing ? { chapter: n, at: timing.beats[k]?.start ?? 0 } : undefined })}>
                        <span className="vt">{b.visual?.type ?? "point"}{b.aha ? " · aha" : ""}</span>
                        <span>
                          {b.say.join(" ")}
                          {(b.cite ?? []).map((c) => <span key={c} className="cite">{citeLabel(c, video.sources)}</span>)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          }) : <div style={{ color: "var(--faint)", padding: "0 18px" }}>Chapters appear when the outline is written.</div>}
        </div>
      </aside>
      {moving && <FolderPicker title="Move video to…" onClose={() => setMoving(false)} onPick={(p) => void api.moveVideo(s.id, p).then(() => (setMoving(false), refreshLibrary(), reload(), toast(`Moved to ${p || "Library"}`, "ok"))).catch((e: Error) => toast(e.message, "error"))} />}
    </div>
  );
}

function RetryWithNote({ onRetry }: { onRetry(note: string): Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Retry with a note</button>;
  return (
    <div className="ask" style={{ flex: "0 1 420px", padding: "4px 4px 4px 10px" }}>
      <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should the writer do differently?"
        onKeyDown={(e) => e.key === "Enter" && note.trim() && void onRetry(note.trim()).then((ok) => ok && (setOpen(false), setNote("")))} />
      <button className="btn primary small" disabled={!note.trim()} onClick={() => void onRetry(note.trim()).then((ok) => ok && (setOpen(false), setNote("")))}>Retry</button>
    </div>
  );
}
