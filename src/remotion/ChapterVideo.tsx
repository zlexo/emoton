import "katex/dist/katex.min.css";
import { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, Audio, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Chapter, ChapterTiming, Visual } from "../../schema/storyboard.ts";
import { resolveDiagrams, type DiagramScene } from "../core/diagram.ts";
import { revealTimes } from "../core/timing.ts";
import { citeLabel } from "../core/cite.ts";
import { spokenWord, wordsOf } from "../core/words.ts";
import { visualTiming } from "../core/slides.ts";
import { C, FONT, ramp, clamp01 } from "./theme.ts";
import { VisualView } from "./visuals/View.tsx";
import { CaptionBand, SlidesChapter } from "./Slides.tsx";
import type { Layout } from "../../schema/storyboard.ts";

export { VisualView };

export type ChapterProps = {
  videoTitle: string;
  index: number;
  count: number;
  chapter: Chapter;
  timing: ChapterTiming;
  /** chunk-id prefix -> readable source name, e.g. { notes: "Notes" } */
  sources: Record<string, string>;
  captions: boolean;
  /** "slides" draws the slides layout; absent or "stage" today's full stage. */
  layout?: Layout;
  /** Slides layout: the number of this chapter's first slide in the whole video, and the video's slide count. */
  slideBase?: number;
  slideTotal?: number;
};

export function itemCount(v: Visual | undefined): number {
  if (!v) return 0;
  switch (v.type) {
    case "title": return v.subtitle ? 2 : 1;
    case "bullets": return v.items.length;
    case "equation": return v.lines.length;
    case "code": return v.steps.length;
    case "sequence": return v.messages.length;
    case "graph": return v.series.length;
    case "diagram": return v.steps.length;
    case "venn": return v.steps.length;
  }
}

/** The caption: the sentence as written, the word being spoken in yellow. */
function captionWords(s: ChapterTiming["beats"][number]["sentences"][number], t: number): React.ReactNode {
  const words = wordsOf(s);
  const k = spokenWord(words, t);
  return words.map((w, i) => (
    <span key={i} style={i === k ? { color: C.yellow } : undefined}>
      {i > 0 ? " " : ""}
      {w.text}
    </span>
  ));
}

type Segment = { beats: number[]; start: number; end: number; scenes?: DiagramScene[] };

export const ChapterVideo: React.FC<ChapterProps> = ({ videoTitle, index, count, chapter, timing, sources, captions, layout, slideBase, slideTotal }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const [fontHandle] = useState(() => delayRender("KaTeX fonts"));
  useEffect(() => {
    Promise.all(["KaTeX_Main", "KaTeX_Typewriter", "KaTeX_Math"].map((f) => document.fonts.load(`40px ${f}`)))
      .then(() => continueRender(fontHandle))
      .catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  const { segments, at, scenes } = useMemo(() => {
    const scenes = resolveDiagrams(chapter);
    // slides: a point-first beat's visual reveals from its second sentence on
    const at = chapter.beats.map((b, i) => revealTimes(itemCount(b.visual), layout === "slides" ? visualTiming(b, timing.beats[i]!) : timing.beats[i]!));
    const segs: Segment[] = [];
    chapter.beats.forEach((b, i) => {
      const cont = b.visual?.type === "diagram" && b.visual.continue && segs.length > 0;
      if (cont) {
        const s = segs[segs.length - 1]!;
        s.beats.push(i);
        s.scenes!.push(scenes[i]!);
      } else {
        segs.push({ beats: [i], start: timing.beats[i]!.start - 0.25, end: 0, scenes: scenes[i] ? [scenes[i]!] : undefined });
      }
    });
    segs.forEach((s, k) => (s.end = segs[k + 1]?.start ?? timing.duration));
    return { segments: segs, at, scenes };
  }, [chapter, timing, layout]);

  const beatNow = timing.beats.findIndex((b, i) => t >= b.start - 0.25 && t < (timing.beats[i + 1]?.start ?? Infinity) - 0.25);
  const sentence = timing.beats.flatMap((b) => b.sentences).find((s) => t >= s.start - 0.05 && t < s.end + 0.2);
  const cites = beatNow >= 0 ? chapter.beats[beatNow]!.cite ?? [] : [];

  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      {timing.audio && <Audio src={/^(https?:)?\//.test(timing.audio) ? timing.audio : staticFile(timing.audio)} />}

      {/* Chapter card during the silent lead-in */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: ramp(t, 0.1, 0.5) * (1 - ramp(t, timing.leadIn - 0.45, 0.4)) }}>
        <div style={{ fontSize: 36, color: C.dim, letterSpacing: 6, textTransform: "uppercase" }}>
          {videoTitle} · {index} / {count}
        </div>
        <div style={{ fontSize: 88, color: C.text, marginTop: 24 }}>{chapter.title}</div>
      </AbsoluteFill>

      {layout === "slides" && (
        <SlidesChapter videoTitle={videoTitle} index={index} chapter={chapter} timing={timing} sources={sources} slideBase={slideBase ?? 1} slideTotal={slideTotal ?? 1} t={t} at={at} scenes={scenes} />
      )}
      {layout === "slides" && captions && <CaptionBand opacity={sentence ? ramp(t, sentence.start - 0.05, 0.2) : 0}>{sentence && captionWords(sentence, t)}</CaptionBand>}

      {layout !== "slides" && segments.map((seg, k) => {
        if (t < seg.start || t > seg.end) return null;
        const fadeOut = k === segments.length - 1 ? 1 - ramp(t, seg.end - 0.6, 0.6) : 1 - clamp01((t - (seg.end - 0.3)) / 0.3);
        const opacity = ramp(t, seg.start, 0.35) * fadeOut;
        const first = seg.beats[0]!;
        const v = chapter.beats[first]!.visual;
        if (!v) return null;
        return (
          <AbsoluteFill key={k} style={{ opacity }}>
            <VisualView v={v} t={t} at={at[first]!} diagram={seg.scenes && { scenes: seg.scenes, times: seg.beats.map((i) => at[i]!) }} />
          </AbsoluteFill>
        );
      })}

      {layout !== "slides" && captions && sentence && (
        <div style={{ position: "absolute", left: 160, right: 160, bottom: 56, textAlign: "center", fontSize: 38, lineHeight: 1.35, color: "#D8D8DC", opacity: ramp(t, sentence.start - 0.05, 0.2), textShadow: "0 2px 8px #000" }}>
          {captionWords(sentence, t)}
        </div>
      )}
      {layout !== "slides" && cites.length > 0 && (
        <div style={{ position: "absolute", right: 48, top: 36, fontSize: 26, color: C.dim, opacity: 0.8 }}>
          {cites.map((c) => citeLabel(c, sources)).join(" · ")}
        </div>
      )}
    </AbsoluteFill>
  );
};
