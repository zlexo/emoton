import type { SequenceVisual } from "../../../schema/storyboard.ts";
import { C, FONT, ramp } from "../theme.ts";
import { stepAt } from "../../core/timing.ts";

/** Lanes across the top, one message arrow per sentence, time flowing down. */
export const Sequence: React.FC<{ v: SequenceVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const n = v.lanes.length;
  const laneX = (i: number) => 960 + (i - (n - 1) / 2) * Math.min(520, 1500 / (n - 1 || 1));
  const x = (name: string) => laneX(Math.max(0, v.lanes.indexOf(name)));
  // A message to self draws a loop, so it takes more vertical room than an arrow.
  const self = v.messages.map((m) => m.from === m.to);
  const units = self.reduce((u, s) => u + (s ? 1.8 : 1), 0);
  const top = 190, gap = Math.min(78, 560 / units);
  const ys = self.map((_, k) => top + 95 + self.slice(0, k).reduce((u, s) => u + (s ? 1.8 : 1), 0) * gap);
  const cur = stepAt(at, t);
  const appear = ramp(t, (at[0] ?? 0) - 0.5);
  return (
    <svg viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0 }}>
      {v.lanes.map((l, i) => (
        <g key={l} opacity={appear}>
          <rect x={laneX(i) - 150} y={top - 50} width={300} height={82} rx={10} fill="rgba(88,196,221,0.08)" stroke={C.blue} strokeWidth={3} />
          <text x={laneX(i)} y={top - 8} fill={C.text} fontFamily={FONT} fontSize={36} textAnchor="middle" dominantBaseline="middle">{l}</text>
          <line x1={laneX(i)} y1={top + 32} x2={laneX(i)} y2={880} stroke={C.faint} strokeWidth={3} strokeDasharray="10 10" />
        </g>
      ))}
      {v.messages.map((m, k) => {
        const a = at[k] ?? 0;
        if (t < a) return null;
        const y = ys[k]!;
        const x1 = x(m.from), x2 = x(m.to);
        const d = ramp(t, a, 0.5);
        const col = k === cur ? C.yellow : C.text;
        const op = k === cur ? 1 : 0.6;
        if (x1 === x2) {
          return (
            <g key={k} opacity={op}>
              <path d={`M ${x1} ${y - gap * 0.2} h 70 v ${gap * 0.7} h -60`} fill="none" stroke={col} strokeWidth={3.5} opacity={d} />
              <text x={x1 + 90} y={y + gap * 0.15} fill={col} fontFamily={FONT} fontSize={32} dominantBaseline="middle" opacity={ramp(t, a + 0.3)}>{m.label}</text>
            </g>
          );
        }
        const dir = Math.sign(x2 - x1);
        const xe = x1 + (x2 - x1) * d;
        return (
          <g key={k} opacity={op}>
            <line x1={x1} y1={y} x2={xe} y2={y} stroke={col} strokeWidth={3.5} />
            {d > 0.9 && <path d={`M ${x2} ${y} l ${-20 * dir} -11 l 0 22 Z`} fill={col} />}
            <text x={(x1 + x2) / 2} y={y - 22} fill={col} fontFamily={FONT} fontSize={32} textAnchor="middle" opacity={ramp(t, a + 0.25)}>{m.label}</text>
          </g>
        );
      })}
    </svg>
  );
};
