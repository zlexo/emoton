import katex from "katex";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill } from "remotion";
import type { Chapter, ChapterTiming, Visual } from "../../schema/storyboard.ts";
import type { DiagramScene } from "../core/diagram.ts";
import { layoutDiagram } from "../core/diagramLayout.ts";
import { citeLabel } from "../core/cite.ts";
import { mathRuns, pieces, slideSpans, timeline, type Piece } from "../core/slides.ts";
import { C, FONT, clamp01, ramp } from "./theme.ts";
import { VisualView } from "./visuals/View.tsx";
import { StageAreaContext, useFontsMeasured, type StageArea } from "./visuals/FitStage.tsx";

/**
 * The slides layout: a slide
 * stays on screen over its beats, its points build up on the left, the panel on
 * the right plays the beat's visual, and a `full` beat steps out to today's
 * stage. Visuals are not redrawn for the panel: the stage's content area is
 * scaled into it, so every primitive works there unchanged.
 */

const PAD = 90;
const CARD = "#16161A", CARD2 = "#1B1B21", LINE = "#26262D";
export const PANEL = { x: 910, y: 380, w: 920, h: 470 };
/** A slide without a headline moves its cards up into the headline's space. */
const NO_HEADLINE_LIFT = 165;
const PANEL_PAD = 28;
/** The most a visual is enlarged into the panel (a one-node diagram stays a sensible size). */
const MAX_PANEL_SCALE = 0.75;

type Box = { x: number; y: number; w: number; h: number };

/**
 * The part of the 1920 x 1080 stage a visual draws in: the panel shows that
 * box, scaled to fit, rather than the whole stage with its margins for the
 * citation chip and the captions. Diagrams use everything their segment draws
 * (boxes, arrows, labels, as laid out for all its scenes, so nothing moves as
 * it builds), sequences their lanes; equations and code sit in FitStage's
 * safe area; graphs in their plot area.
 */
export function stageBox(v: Visual, scenes: DiagramScene[] = []): Box {
  if (v.type === "diagram" && scenes.length && scenes[scenes.length - 1]!.nodes.length) {
    const b = layoutDiagram(scenes).bounds, m = 40;
    return { x: b.x0 - m, y: b.y0 - m, w: b.x1 - b.x0 + 2 * m, h: b.y1 - b.y0 + 2 * m };
  }
  if (v.type === "sequence") {
    const n = v.lanes.length, half = ((n - 1) / 2) * Math.min(520, 1500 / (n - 1 || 1));
    const units = v.messages.reduce((u, m) => u + (m.from === m.to ? 1.8 : 1), 0);
    return { x: 960 - half - 230, y: 150, w: 2 * half + 460, h: 190 + 95 + units * Math.min(78, 560 / units) + 40 - 150 };
  }
  if (v.type === "graph") return { x: 230, y: 120, w: 1480, h: 790 };
  if (v.type === "venn") return { x: 310, y: 150, w: 1300, h: 760 };
  return FIT_AREA;
}

/** Equations and code in a panel: FitStage fills this stage box (the panel's shape), growing short content. */
const FIT_AREA: StageArea = { x: 0, y: 0, w: 1600, h: Math.round((1600 * (PANEL.h - 2 * PANEL_PAD)) / (PANEL.w - 2 * PANEL_PAD)), grow: 1.4 };

/** How a stage box sits in the panel: the scale and the stage's offset. */
export function panelFit(b: Box, h = PANEL.h) {
  const scale = Math.min(MAX_PANEL_SCALE, (PANEL.w - 2 * PANEL_PAD) / b.w, (h - 2 * PANEL_PAD) / b.h);
  return { scale, left: (PANEL.w - b.w * scale) / 2 - b.x * scale, top: (h - b.h * scale) / 2 - b.y * scale };
}

/** Lays its content out at natural size and scales it down (never up) to fit w x h. */
const Fit: React.FC<{ w: number; h: number; children: React.ReactNode; align?: "left" | "center"; top?: boolean }> = ({ w, h, children, align = "left", top }) => {
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useFontsMeasured();
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const next = Math.min(1, w / Math.max(1, el.offsetWidth, el.scrollWidth), h / Math.max(1, el.offsetHeight, el.scrollHeight));
    if (Math.abs(next - scale) > 0.004) setScale(next);
  });
  return (
    <div style={{ width: w, height: h, display: "flex", alignItems: top ? "flex-start" : "center", justifyContent: align === "center" ? "center" : "flex-start" }}>
      <div ref={inner} style={{ flexShrink: 0, maxWidth: w / Math.max(scale, 0.01), transform: `scale(${scale})`, transformOrigin: `${align === "center" ? "center" : "left"} ${top ? "top" : "center"}` }}>
        {children}
      </div>
    </div>
  );
};

/** Text with KaTeX between $...$. */
export const Tex: React.FC<{ s: string }> = ({ s }) => (
  <>
    {mathRuns(s).map((r, i) =>
      r.tex ? <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(r.text, { throwOnError: false }) }} /> : <span key={i}>{r.text}</span>,
    )}
  </>
);

type Props = {
  videoTitle: string;
  index: number;
  chapter: Chapter;
  timing: ChapterTiming;
  sources: Record<string, string>;
  /** Number of the chapter's first slide in the whole video, and the video's slide count. */
  slideBase: number;
  slideTotal: number;
  t: number;
  at: number[][];
  scenes: (DiagramScene | null)[];
};

export const SlidesChapter: React.FC<Props> = ({ videoTitle, index, chapter, timing, sources, slideBase, slideTotal, t, at, scenes }) => {
  const { spans, ps, times, spanWin } = useMemo(() => {
    const tl = timeline(chapter, timing);
    return { spans: slideSpans(chapter), ps: pieces(chapter), times: tl.pieces, spanWin: tl.spans };
  }, [chapter, timing]);
  const lastPiece = ps.length - 1;
  const pieceOpacity = (k: number) => {
    const { start, end } = times[k]!;
    const out = k === lastPiece ? 1 - ramp(t, end - 0.6, 0.6) : 1 - clamp01((t - (end - 0.3)) / 0.3);
    return ramp(t, start, 0.35) * out;
  };
  const view = (p: Piece) => {
    const v0 = p.visuals[0] !== undefined ? chapter.beats[p.visuals[0]]!.visual : undefined;
    if (!v0) return null;
    const diagram = v0.type === "diagram" ? { scenes: p.visuals.map((i) => scenes[i]!).filter(Boolean), times: p.visuals.map((i) => at[i]!) } : undefined;
    return <VisualView v={v0} t={t} at={at[p.visuals[0]!]!} diagram={diagram && diagram.scenes.length ? diagram : undefined} />;
  };
  const beatNow = timing.beats.findIndex((b, i) => t >= b.start - 0.25 && t < (timing.beats[i + 1]?.start ?? Infinity) - 0.25);
  const progress = clamp01(t / Math.max(0.001, timing.duration));

  return (
    <>
      {/* chapter progress */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 6, background: LINE, opacity: ramp(t, timing.leadIn - 0.4, 0.4) }}>
        <div style={{ width: `${progress * 100}%`, height: "100%", background: C.blue }} />
      </div>

      {spans.map((sp, s) => {
        const mine = ps.map((p, k) => ({ p, k })).filter(({ p }) => p.span === s);
        if (!mine.length) return null;
        const sStart = spanWin[s]!.start, sEnd = spanWin[s]!.end;
        const isLast = s === spans.length - 1;
        const fade = ramp(t, sStart - 0.1, 0.35) * (isLast ? 1 - ramp(t, sEnd - 0.6, 0.6) : 1 - clamp01((t - (sEnd - 0.3)) / 0.3));
        if (fade <= 0.001) return null;
        const fullness = clamp01(mine.filter(({ p }) => p.kind === "full").reduce((a, { k }) => a + pieceOpacity(k), 0));
        const chrome = fade * (1 - fullness);
        const points = chapter.beats.map((b, i) => ({ b, i })).filter(({ b, i }) => b.point && i >= sp.first && i <= sp.last);
        const shown = points.filter(({ i }) => t >= timing.beats[i]!.start - 0.15);
        const current = shown[shown.length - 1]?.i;
        const cite = beatNow >= sp.first && beatNow <= sp.last ? chapter.beats[beatNow]!.cite ?? [] : [];
        // without a headline the cards take its space: they start higher and run taller
        const lift = sp.slide.headline ? 0 : NO_HEADLINE_LIFT;
        return (
          <AbsoluteFill key={s}>
            {chrome > 0.001 && (
              <AbsoluteFill style={{ opacity: chrome }}>
                <div style={{ position: "absolute", left: PAD, right: PAD, top: 34, display: "flex", justifyContent: "space-between", gap: 40, fontSize: 26, letterSpacing: 4, textTransform: "uppercase", color: C.blue }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{videoTitle} · {index} {chapter.title}</span>
                  <span style={{ color: C.dim, whiteSpace: "nowrap" }}>Slide {slideBase + s} / {slideTotal}</span>
                </div>
                <div style={{ position: "absolute", left: PAD, top: 92 }}>
                  <Fit w={1920 - 2 * PAD} h={100}>
                    <div style={{ fontSize: 76, lineHeight: 1.1, color: C.text, whiteSpace: "nowrap" }}><Tex s={sp.slide.title} /></div>
                  </Fit>
                </div>
                {sp.slide.headline && (
                  <div style={{ position: "absolute", left: PAD, right: PAD, top: 200, height: 150, background: CARD2, border: `1px solid ${LINE}`, borderRadius: 16, padding: "0 40px", display: "flex", alignItems: "center" }}>
                    <Fit w={1920 - 2 * PAD - 80} h={134}>
                      <div style={{ fontSize: 48, color: C.yellow, whiteSpace: "nowrap" }}><Tex s={sp.slide.headline} /></div>
                    </Fit>
                  </div>
                )}
                <div style={{ position: "absolute", left: PAD, top: 380 - lift, width: 790, height: 470 + lift, background: CARD, border: `1px solid ${LINE}`, borderRadius: 16, padding: "34px 40px" }}>
                  <div style={{ fontSize: 24, letterSpacing: 4, color: C.blue, textTransform: "uppercase", marginBottom: 26 }}>The idea</div>
                  <Fit w={710} h={360 + lift} top>
                    <div style={{ width: 710 }}>
                      {points.map(({ b, i }) => {
                        const a = ramp(t, timing.beats[i]!.start - 0.15, 0.35);
                        const now = i === current;
                        return (
                          <div key={i} style={{ display: "flex", gap: 24, alignItems: "baseline", fontSize: 40, lineHeight: 1.32, marginBottom: 28, opacity: a * (now ? 1 : 0.5), transform: `translateX(${(1 - a) * -20}px)` }}>
                            <div style={{ width: 13, height: 13, borderRadius: 7, background: now ? C.yellow : C.blue, flex: "none", transform: "translateY(-6px)" }} />
                            <div style={{ color: C.text }}><Tex s={b.point!} /></div>
                          </div>
                        );
                      })}
                    </div>
                  </Fit>
                </div>
                <div style={{ position: "absolute", left: PANEL.x, top: PANEL.y - lift, width: PANEL.w, height: PANEL.h + lift, background: CARD, border: `1px solid ${LINE}`, borderRadius: 16, overflow: "hidden" }}>
                  {mine.filter(({ p }) => p.kind === "panel").map(({ p, k }) => {
                    const o = pieceOpacity(k);
                    if (o <= 0.001) return null;
                    const src = p.visuals[0] !== undefined ? chapter.beats[p.visuals[0]]!.visual : undefined;
                    if (!src) return null;
                    const fit = panelFit(stageBox(src, p.visuals.flatMap((i) => (scenes[i] ? [scenes[i]] : []))), PANEL.h + lift);
                    return (
                      <div key={k} style={{ position: "absolute", width: 1920, height: 1080, opacity: o, transformOrigin: "0 0", transform: `scale(${fit.scale})`, left: fit.left, top: fit.top }}>
                        <StageAreaContext.Provider value={FIT_AREA}>{view(p)}</StageAreaContext.Provider>
                      </div>
                    );
                  })}
                </div>
                {cite.length > 0 && (
                  <div style={{ position: "absolute", left: PAD, top: 866, fontSize: 24, color: C.dim, border: `1px solid ${LINE}`, borderRadius: 8, padding: "2px 12px" }}>
                    {cite.map((c) => citeLabel(c, sources)).join(" · ")}
                  </div>
                )}
              </AbsoluteFill>
            )}
            {mine.filter(({ p }) => p.kind === "full").map(({ p, k }) => {
              const o = pieceOpacity(k);
              if (o <= 0.001) return null;
              const fc = chapter.beats[p.first]!.cite ?? [];
              return (
                <AbsoluteFill key={k} style={{ opacity: o, transform: `scale(${0.96 + 0.04 * ramp(t, times[k]!.start, 0.35)})` }}>
                  {view(p)}
                  {fc.length > 0 && <div style={{ position: "absolute", right: 48, top: 36, fontSize: 26, color: C.dim, opacity: 0.8 * fullness }}>{fc.map((c) => citeLabel(c, sources)).join(" · ")}</div>}
                </AbsoluteFill>
              );
            })}
          </AbsoluteFill>
        );
      })}
    </>
  );
};

/** The captions band under the slide (slides layout). */
export const CaptionBand: React.FC<{ children: React.ReactNode; opacity: number }> = ({ children, opacity }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top: 920, height: 160, background: "#09090B", borderTop: `1px solid ${LINE}`, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 200px", fontFamily: FONT }}>
    <div style={{ fontSize: 40, lineHeight: 1.3, color: "#D8D8DC", opacity }}>{children}</div>
  </div>
);
