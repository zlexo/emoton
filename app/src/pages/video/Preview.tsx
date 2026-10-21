import { useEffect, useState } from "react";
import { Player } from "@remotion/player";
import { ChapterVideo, type ChapterProps } from "../../../../src/remotion/ChapterVideo.tsx";
import { api } from "../../lib/api.ts";
import type { VideoDetail } from "../../lib/types.ts";
import { Listbox } from "../../components/Listbox.tsx";

const FPS = 30;

export function Preview({ video, chapter, setChapter }: { video: VideoDetail; chapter: number; setChapter(n: number): void }) {
  const written = video.chapters.map((c, i) => (c ? i + 1 : 0)).filter(Boolean);
  const n = written.includes(chapter) ? chapter : written[0];
  const [props, setProps] = useState<ChapterProps | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const st = n ? video.state.chapters[n - 1] : undefined;
  const key = `${video.summary.id}:${n}:${st?.storyboard}:${st?.voice}:${st?.duration ?? ""}:${JSON.stringify(video.chapters[(n ?? 1) - 1] ?? null)}`;

  useEffect(() => {
    if (!n) return;
    let live = true;
    setProps(null);
    api.preview(video.summary.id, n).then((p) => live && (setProps(p), setErr(null))).catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!n) return <div className="empty"><h2>No chapter written yet</h2><div>Preview plays any chapter as soon as its storyboard exists, before voice or render.</div></div>;
  const voiced = !!props?.timing.audio;
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ width: 280 }}>
          <Listbox value={n} onChange={setChapter} options={written.map((k) => ({ value: k, label: `Chapter ${k}`, sub: video.chapters[k - 1]!.title }))} />
        </div>
        <span style={{ color: "var(--dim)" }}>
          {props ? (voiced ? "With the recorded voice" : "Silent, on estimated timing: voice it to hear it") : "Loading"}
        </span>
      </div>
      {err && <div className="errors">{err}</div>}
      {props && (
        <div className="preview-frame">
          <Player
            component={ChapterVideo as unknown as React.FC<Record<string, unknown>>}
            inputProps={props as unknown as Record<string, unknown>}
            durationInFrames={Math.max(1, Math.ceil(props.timing.duration * FPS))}
            compositionWidth={1920}
            compositionHeight={1080}
            fps={FPS}
            controls
            clickToPlay
            acknowledgeRemotionLicense
            style={{ width: "100%", aspectRatio: "16 / 9" }}
          />
        </div>
      )}
    </>
  );
}
