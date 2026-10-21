import type { BulletsVisual } from "../../../schema/storyboard.ts";
import { C, FONT, ramp } from "../theme.ts";
import { stepAt } from "../../core/timing.ts";

/** One item per sentence; earlier items stay but step back. */
export const Bullets: React.FC<{ v: BulletsVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const cur = stepAt(at, t);
  return (
    <div style={{ position: "absolute", left: 260, right: 200, top: 190, fontFamily: FONT }}>
      {v.heading && <div style={{ fontSize: 64, color: C.blue, marginBottom: 56, opacity: ramp(t, (at[0] ?? 0) - 0.3) }}>{v.heading}</div>}
      {v.items.map((item, i) => {
        const a = ramp(t, at[i] ?? 0);
        const focus = i === cur ? 1 : 0.55;
        return (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 30, marginBottom: 38, opacity: a * focus, transform: `translateX(${(1 - a) * -24}px)` }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: i === cur ? C.yellow : C.blue, flex: "none", transform: "translateY(-8px)" }} />
            <div style={{ fontSize: 50, color: C.text, lineHeight: 1.3 }}>{item}</div>
          </div>
        );
      })}
    </div>
  );
};
