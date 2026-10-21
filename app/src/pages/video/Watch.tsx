import { useEffect, useMemo, useRef, useState } from "react";
import type { ChapterTiming, VideoDetail } from "../../lib/types.ts";
import type { Playhead } from "../Video.tsx";
import { mmss } from "../../lib/format.ts";
import { Listbox } from "../../components/Listbox.tsx";
import { IChat, IPause, IPlay } from "../../components/Icons.tsx";
import { api } from "../../lib/api.ts";
import { useStore } from "../../lib/store.tsx";

const SPEEDS = [1, 1.25, 1.5, 2];

export function Watch({ video, head, setHead, timings, onRedo }: {
  video: VideoDetail; head: Playhead; setHead(h: Playhead): void; timings: Record<number, ChapterTiming>; onRedo(n: number, note: string): Promise<boolean>;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState(head.chapter);
  const [asking, setAsking] = useState(false);
  const markers = video.markers ?? [];
  const total = markers.length ? markers[markers.length - 1]!.end : 0;
  const chapterAt = (x: number) => Math.max(1, markers.findIndex((m) => x >= m.start && x < m.end) + 1 || markers.length);

  // Follow the playhead: chapter and beat under the current time.
  useEffect(() => {
    if (!markers.length) return;
    const n = chapterAt(t);
    const local = t - (markers[n - 1]?.start ?? 0);
    const beats = timings[n]?.beats ?? [];
    let beat = -1;
    beats.forEach((b, k) => local >= b.start - 0.25 && (beat = k));
    if (n !== head.chapter || beat !== head.beat) setHead({ chapter: n, beat });
    if (!note && !asking) setScope(n);
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seek requests from the chapter rail.
  useEffect(() => {
    const v = ref.current;
    if (!v || !head.seek || !markers.length) return;
    v.currentTime = (markers[head.seek.chapter - 1]?.start ?? 0) + head.seek.at;
    setT(v.currentTime);
  }, [head.seek]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Only when nothing else wants the key: no field, button or menu focused, no sheet open.
      const el = e.target as HTMLElement;
      const free = el === document.body || !!el.closest?.(".player");
      if (!free || document.querySelector(".scrim") || !ref.current) return;
      if (e.key === " ") (e.preventDefault(), ref.current.paused ? void ref.current.play() : ref.current.pause());
      if (e.key === "ArrowRight") ref.current.currentTime += 5;
      if (e.key === "ArrowLeft") ref.current.currentTime -= 5;
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * total;
    if (ref.current) ref.current.currentTime = x;
    setT(x);
  };
  const chapterOptions = useMemo(
    () => (video.outline?.chapters ?? []).map((c, i) => ({ value: i + 1, label: `Chapter ${i + 1}`, sub: c.title })),
    [video.outline],
  );
  const send = async () => {
    if (!note.trim()) return;
    if (await onRedo(scope, note.trim())) setNote("");
  };

  return (
    <>
      {video.video ? (
        <div className={`player${playing ? "" : " paused"}`}>
          <video ref={ref} src={`${video.video}?v=${(video.markers ?? []).map((m) => m.end.toFixed(3)).join("-")}`} preload="metadata" onClick={() => (ref.current!.paused ? void ref.current!.play() : ref.current!.pause())}
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          <div className="pbar">
            <div className="track" onClick={seekTo}>
              {markers.map((m, i) => (
                <div key={i} className="seg" style={{ flex: m.end - m.start }} title={m.title}>
                  <i style={{ width: `${Math.max(0, Math.min(1, (t - m.start) / (m.end - m.start))) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="pctl">
              <button onClick={() => (ref.current!.paused ? void ref.current!.play() : ref.current!.pause())} aria-label={playing ? "Pause" : "Play"}>{playing ? <IPause /> : <IPlay />}</button>
              <span>{mmss(t)} / {mmss(total)}</span>
              <span className="ch">{head.chapter} · {markers[head.chapter - 1]?.title}</span>
              <span className="spacer" />
              <button onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)} title="Speed">{speed}×</button>
              {video.brief.layout === "slides" && <SlidesPdfButton video={video} />}
              <button onClick={() => void ref.current?.requestFullscreen()} title="Full screen">⤢</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="player" style={{ aspectRatio: "16 / 9", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, color: "var(--faint)" }}>
          <span className="serif" style={{ fontSize: 22, color: "var(--dim)" }}>No video yet</span>
          <span>{video.chapters.some(Boolean) ? "The Preview tab plays any written chapter right away." : "It appears here once it is rendered."}</span>
        </div>
      )}
      {video.outline && (
        <div className="ask">
          <IChat size={16} />
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()}
            onFocus={() => (setAsking(true), ref.current?.pause())} onBlur={() => setAsking(false)}
            placeholder={`Ask for a change: "slower here, show it step by step"`} />
          <div style={{ width: 150 }}><Listbox value={scope} options={chapterOptions} onChange={setScope} align="right" /></div>
          <button className="btn primary" disabled={!note.trim() || !video.chapters[scope - 1]} onClick={() => void send()}>Redo chapter</button>
        </div>
      )}
    </>
  );
}

/** Downloads the video's Slides PDF; the first time it is made (one still per slide, about a minute). */
function SlidesPdfButton({ video }: { video: VideoDetail }) {
  const { toast } = useStore();
  const [making, setMaking] = useState(false);
  const go = async () => {
    setMaking(true);
    try {
      const blob = await api.slidesPdf(video.summary.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${video.summary.title} (slides).pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setMaking(false);
    }
  };
  return <button onClick={() => void go()} disabled={making} title="Download the slides as a PDF">{making ? "Making slides…" : "Slides PDF"}</button>;
}
