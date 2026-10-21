import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { continueRender, delayRender } from "remotion";

/**
 * The safe area between the citation chip (top) and the captions (bottom).
 * Content is laid out at its natural size, measured, and scaled down (never
 * up) to fit, so a long derivation can never run into the chip or captions.
 */
export const SAFE = { top: 120, bottom: 215, side: 100 };
const AVAIL_W = 1920 - 2 * SAFE.side;
const AVAIL_H = 1080 - SAFE.top - SAFE.bottom;

export function fitScale(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.min(1, AVAIL_W / w, AVAIL_H / h);
}

/**
 * Measures again once the fonts are in: the first measure can run before
 * KaTeX's fonts load, and a still (one frame) gets no second render to fix it.
 * The frame is held until then.
 */
export function useFontsMeasured(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const handle = delayRender("fonts before measuring");
    let live = true;
    document.fonts.ready.then(() => {
      if (live) setTick(1);
      continueRender(handle);
    }, () => continueRender(handle));
    return () => {
      live = false;
    };
  }, []);
  return tick;
}

/**
 * Inside a slide's panel (slides layout) the content fills a given box of the
 * stage instead of the safe area, and may grow up to `grow` times its natural
 * size, so a short equation is not lost in the panel.
 */
export type StageArea = { x: number; y: number; w: number; h: number; grow: number };
export const StageAreaContext = createContext<StageArea | null>(null);

export const FitStage: React.FC<{ children: React.ReactNode; gap?: number }> = ({ children, gap = 18 }) => {
  const inner = useRef<HTMLDivElement>(null);
  const area = useContext(StageAreaContext);
  const [scale, setScale] = useState(1);
  useFontsMeasured();
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    // scroll sizes: a KaTeX line wider than its box overflows it, and must count
    const w = Math.max(el.offsetWidth, el.scrollWidth), h = Math.max(el.offsetHeight, el.scrollHeight);
    const next = area ? (w > 0 && h > 0 ? Math.min(area.grow, area.w / w, area.h / h) : 1) : fitScale(w, h);
    if (Math.abs(next - scale) > 0.004) setScale(next);
  });
  const box = area ? { top: area.y, left: area.x, width: area.w, height: area.h } : { top: SAFE.top, bottom: SAFE.bottom, left: SAFE.side, right: SAFE.side };
  return (
    <div style={{ position: "absolute", ...box, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div ref={inner} style={{ flexShrink: 0, width: "max-content", transform: `scale(${scale})`, transformOrigin: "center center", display: "flex", flexDirection: "column", alignItems: "center", gap }}>
        {children}
      </div>
    </div>
  );
};
