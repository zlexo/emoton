import katex from "katex";
import type { EquationVisual } from "../../../schema/storyboard.ts";
import { C, FONT, ramp } from "../theme.ts";
import { stepAt } from "../../core/timing.ts";
import { FitStage } from "./FitStage.tsx";

const render = (tex: string) => {
  try {
    return katex.renderToString(tex, { displayMode: true, throwOnError: true });
  } catch {
    // Bad LaTeX renders as plain text instead of killing the video.
    return katex.renderToString(`\\text{${tex.replace(/[\\{}$&#^_%~]/g, " ")}}`, { displayMode: true, throwOnError: false });
  }
};

export const Equation: React.FC<{ v: EquationVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const cur = stepAt(at, t);
  return (
    <FitStage>
      {/* KaTeX's display margins (1em) waste the stage; the gap spaces the lines. */}
      <style>{".emo-eq .katex-display{margin:0}"}</style>
      {v.lines.map((line, i) => {
        const a = ramp(t, at[i] ?? 0);
        return (
          <div
            key={i}
            className="emo-eq"
            style={{ fontSize: 58, color: i === cur ? C.text : C.dim, opacity: a * (i === cur ? 1 : 0.55), transform: `translateY(${(1 - a) * 16}px)` }}
            dangerouslySetInnerHTML={{ __html: render(line) }}
          />
        );
      })}
      {v.caption && <div style={{ fontFamily: FONT, fontSize: 38, color: C.blue, marginTop: 18, opacity: ramp(t, (at[at.length - 1] ?? 0) + 0.3) }}>{v.caption}</div>}
    </FitStage>
  );
};
