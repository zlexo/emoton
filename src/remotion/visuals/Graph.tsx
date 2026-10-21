import type { GraphVisual } from "../../../schema/storyboard.ts";
import { C, FONT, SERIES, ramp } from "../theme.ts";

/** Round-number ticks: steps of 1, 2 or 5 times a power of ten, about five of them. */
export function ticks(lo: number, hi: number, target = 5): number[] {
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10]
    .map((m) => m * mag)
    .reduce((best, s) => (Math.abs((hi - lo) / s - target) < Math.abs((hi - lo) / best - target) ? s : best));
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const nice = (lo: number, hi: number) => {
  if (lo === hi) return { lo: lo - 1, hi: hi + 1 };
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
};

/**
 * Axes first, then one series per sentence, each drawn left to right: a line,
 * bars (a PMF) growing from zero, or a right-continuous step function (a CDF)
 * with a closed dot at the top of each jump and an open one at its bottom.
 * Highlights mark a bar or a jump in yellow once the series are drawn.
 */
export const Graph: React.FC<{ v: GraphVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const pts = v.series.flatMap((s) => s.points);
  const hasBars = v.series.some((s) => s.kind === "bars"), hasSteps = v.series.some((s) => s.kind === "steps");
  // bars need room for half a bar at each end; steps run on past the last jump
  const xs = pts.map((p) => p.x);
  const xspan = Math.max(...xs) - Math.min(...xs) || 1;
  const xr = nice(Math.min(...xs) - (hasBars || hasSteps ? xspan * 0.12 : 0), Math.max(...xs) + (hasBars ? xspan * 0.12 : hasSteps ? xspan * 0.25 : 0));
  const yr0 = nice(Math.min(0, ...pts.map((p) => p.y)), Math.max(hasSteps ? 1 : -Infinity, ...pts.map((p) => p.y)));
  // bars and steps stand on the x axis: no padding below zero
  const yr = (hasBars || hasSteps) && Math.min(...pts.map((p) => p.y)) >= 0 ? { lo: 0, hi: yr0.hi } : yr0;
  const L = 330, R = 1620, T = 190, B = 800;
  const sx = (x: number) => L + ((x - xr.lo) / (xr.hi - xr.lo)) * (R - L);
  const sy = (y: number) => B - ((y - yr.lo) / (yr.hi - yr.lo)) * (B - T);
  const axes = ramp(t, (at[0] ?? 0) - 0.6, 0.6);
  const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(+n.toPrecision(3)));
  return (
    <svg viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0 }}>
      <g opacity={axes} fontFamily={FONT} fill={C.dim} fontSize={28}>
        <line x1={L} y1={B} x2={R} y2={B} stroke={C.text} strokeWidth={3} />
        <line x1={L} y1={B} x2={L} y2={T} stroke={C.text} strokeWidth={3} />
        {ticks(xr.lo, xr.hi).map((x, i) => <text key={`x${i}`} x={sx(x)} y={B + 42} textAnchor="middle">{fmt(x)}</text>)}
        {ticks(yr.lo, yr.hi).map((y, i) => <text key={`y${i}`} x={L - 20} y={sy(y) + 9} textAnchor="end">{fmt(y)}</text>)}
        <text x={(L + R) / 2} y={B + 96} textAnchor="middle" fill={C.text} fontSize={36}>{v.xLabel}</text>
        <text x={L - 130} y={(T + B) / 2} textAnchor="middle" fill={C.text} fontSize={36} transform={`rotate(-90 ${L - 130} ${(T + B) / 2})`}>{v.yLabel}</text>
      </g>
      {v.series.map((s, i) => {
        const d = ramp(t, at[i] ?? 0, 1.2);
        const sorted = [...s.points].sort((a, b) => a.x - b.x);
        const col0 = SERIES[i % SERIES.length]!;
        const label = <text x={R - 10} y={T + 10 + i * 48} fill={col0} fontFamily={FONT} fontSize={34} textAnchor="end" opacity={ramp(t, (at[i] ?? 0) + 0.8)}>{s.label}</text>;
        const lit = (x: number) => (v.highlight ?? []).some((h) => Math.abs(h.x - x) < 1e-9) ? ramp(t, (at[v.series.length - 1] ?? 0) + 1.0, 0.5) : 0;
        if (s.kind === "bars") {
          const gap = sorted.length > 1 ? Math.min(...sorted.slice(1).map((p, k) => sx(p.x) - sx(sorted[k]!.x))) : (R - L) / 6;
          const w = Math.min(120, gap * 0.62);
          return (
            <g key={i}>
              {sorted.map((p, k) => {
                // bars rise left to right as the series draws
                const g = ramp(d, k / Math.max(1, sorted.length) * 0.7, 0.3);
                const h = (sy(0) - sy(p.y)) * g;
                const hl = lit(p.x);
                return <rect key={k} x={sx(p.x) - w / 2} y={sy(0) - h} width={w} height={h} fill={hl > 0 ? C.yellow : col0} fillOpacity={0.8} stroke={hl > 0 ? C.yellow : col0} strokeWidth={2} />;
              })}
              {label}
            </g>
          );
        }
        if (s.kind === "steps") {
          // F is 0 left of the first jump, then y_k on [x_k, x_k+1); the last step runs to the right edge
          const shown = (x: number) => (sx(x) - L) / (R - L) <= d;
          let prev = 0;
          const parts = sorted.map((p, k) => {
            const x1 = k + 1 < sorted.length ? sorted[k + 1]!.x : xr.hi;
            const from = prev;
            prev = p.y;
            if (!shown(p.x)) return null;
            const hl = lit(p.x);
            const xEnd = Math.min(sx(x1), L + d * (R - L));
            return (
              <g key={k}>
                <line x1={sx(p.x)} y1={sy(p.y)} x2={xEnd} y2={sy(p.y)} stroke={col0} strokeWidth={6} />
                {hl > 0 && <line x1={sx(p.x)} y1={sy(from)} x2={sx(p.x)} y2={sy(p.y)} stroke={C.yellow} strokeWidth={5} opacity={hl} />}
                <circle cx={sx(p.x)} cy={sy(from)} r={10} fill={C.bg} stroke={col0} strokeWidth={4} />
                <circle cx={sx(p.x)} cy={sy(p.y)} r={11} fill={col0} />
              </g>
            );
          });
          const firstX = sorted[0]!.x;
          return (
            <g key={i}>
              <line x1={L} y1={sy(0)} x2={Math.min(sx(firstX), L + d * (R - L))} y2={sy(0)} stroke={col0} strokeWidth={6} />
              {parts}
              {label}
            </g>
          );
        }
        const path = sorted.map((p, k) => `${k ? "L" : "M"} ${sx(p.x)} ${sy(p.y)}`).join(" ");
        let len = 0;
        for (let k = 1; k < sorted.length; k++) len += Math.hypot(sx(sorted[k]!.x) - sx(sorted[k - 1]!.x), sy(sorted[k]!.y) - sy(sorted[k - 1]!.y));
        const col = SERIES[i % SERIES.length]!;
        return (
          <g key={i}>
            <path d={path} fill="none" stroke={col} strokeWidth={5} strokeDasharray={len} strokeDashoffset={len * (1 - d)} strokeLinejoin="round" />
            <text x={R - 10} y={T + 10 + i * 48} fill={col} fontFamily={FONT} fontSize={34} textAnchor="end" opacity={ramp(t, (at[i] ?? 0) + 0.8)}>{s.label}</text>
          </g>
        );
      })}
      {(v.highlight ?? []).map((h, k) => {
        if (!h.label) return null;
        const o = ramp(t, (at[v.series.length - 1] ?? 0) + 1.0, 0.5);
        const ys = v.series.flatMap((s) => s.points.filter((p) => Math.abs(p.x - h.x) < 1e-9).map((p) => p.y));
        const y = ys.length ? Math.max(...ys) : yr.lo;
        return <text key={`h${k}`} x={sx(h.x) + 22} y={sy(y) - 22} fill={C.yellow} fontFamily={FONT} fontSize={36} opacity={o}>{h.label}</text>;
      })}
    </svg>
  );
};
