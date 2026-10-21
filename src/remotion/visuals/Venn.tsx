import type { VennRegion, VennVisual } from "../../../schema/storyboard.ts";
import { C, FONT, ramp } from "../theme.ts";
import { stepAt } from "../../core/timing.ts";

/**
 * Sets in a box (the sample space), outcomes in their regions, and one step
 * per sentence shading a union of regions. Region shapes are clip paths of the
 * circles (inside) and masks (outside), so any combination of 2 or 3 sets draws.
 */

const BOX = { x: 330, y: 170, w: 1260, h: 660 };
const SET_COLOURS = [C.blue, "#B39DDB", C.gold];

type Circle = { cx: number; cy: number; r: number };

export function vennCircles(n: number, apart = false): Circle[] {
  if (apart)
    return n === 2
      ? [{ cx: 700, cy: 500, r: 220 }, { cx: 1220, cy: 500, r: 220 }]
      : [{ cx: 580, cy: 480, r: 175 }, { cx: 960, cy: 480, r: 175 }, { cx: 1340, cy: 480, r: 175 }];
  return n === 2
    ? [{ cx: 790, cy: 500, r: 255 }, { cx: 1130, cy: 500, r: 255 }]
    : [{ cx: 820, cy: 410, r: 200 }, { cx: 1100, cy: 410, r: 200 }, { cx: 960, cy: 620, r: 200 }];
}

/** Where outcomes of a region (the exact sets they belong to) are drawn, by set index membership. */
function anchor(n: number, member: boolean[], circles: Circle[], apart: boolean): { x: number; y: number } {
  if (apart) {
    const i = member.indexOf(true);
    return i >= 0 ? { x: circles[i]!.cx, y: circles[i]!.cy } : { x: 960, y: 790 };
  }
  const key = member.map((m) => (m ? 1 : 0)).join("");
  const two: Record<string, { x: number; y: number }> = { "10": { x: 650, y: 500 }, "01": { x: 1270, y: 500 }, "11": { x: 960, y: 500 }, "00": { x: 960, y: 790 } };
  const three: Record<string, { x: number; y: number }> = {
    "100": { x: 720, y: 360 }, "010": { x: 1200, y: 360 }, "001": { x: 960, y: 720 },
    "110": { x: 960, y: 300 }, "101": { x: 830, y: 560 }, "011": { x: 1090, y: 560 }, "111": { x: 960, y: 480 }, "000": { x: 450, y: 780 },
  };
  return (n === 2 ? two : three)[key] ?? { x: 960, y: 790 };
}

export const Venn: React.FC<{ v: VennVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const circles = vennCircles(v.sets.length, !!v.apart);
  // ids per set count: two Venns cross-fading share clip paths only when their circles are the same
  const uid = `venn${v.sets.length}${v.apart ? "a" : ""}`;
  const idx = (id: string) => v.sets.findIndex((s) => s.id === id);
  const cur = stepAt(at, t);
  const appear = ramp(t, (at[0] ?? 0) - 0.6, 0.6);
  // outcomes grouped by region, laid out in a small grid around its anchor
  const groups = new Map<string, string[]>();
  for (const e of v.elements ?? []) {
    const member = v.sets.map((s) => e.in.includes(s.id));
    const k = member.join();
    groups.set(k, [...(groups.get(k) ?? []), e.label]);
  }
  const regionShape = (r: VennRegion, key: string, fill: string, opacity: number) => {
    const ins = r.in.map(idx).filter((i) => i >= 0);
    const outs = (r.out ?? []).map(idx).filter((i) => i >= 0);
    const rect = <rect x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h} fill={fill} opacity={opacity} mask={outs.length ? `url(#${uid}-out-${outs.join("")})` : undefined} />;
    // nested clips: inside every `in` circle
    return ins.reduceRight<React.ReactNode>((child, i) => <g clipPath={`url(#${uid}-c${i})`}>{child}</g>, <g key={key}>{rect}</g>);
  };
  const outMasks = new Set<string>();
  v.steps.forEach((s) => s.shade.forEach((r) => {
    const outs = (r.out ?? []).map(idx).filter((i) => i >= 0);
    if (outs.length) outMasks.add(outs.join(""));
  }));
  return (
    <svg viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0 }}>
      <defs>
        {circles.map((c, i) => <clipPath key={i} id={`${uid}-c${i}`}><circle cx={c.cx} cy={c.cy} r={c.r} /></clipPath>)}
        {[...outMasks].map((m) => (
          <mask key={m} id={`${uid}-out-${m}`}>
            <rect x={0} y={0} width={1920} height={1080} fill="white" />
            {m.split("").map(Number).map((i) => <circle key={i} cx={circles[i]!.cx} cy={circles[i]!.cy} r={circles[i]!.r} fill="black" />)}
          </mask>
        ))}
      </defs>
      <g opacity={appear}>
        <rect x={BOX.x} y={BOX.y} width={BOX.w} height={BOX.h} rx={18} fill="none" stroke={C.dim} strokeWidth={3} />
        <text x={BOX.x + 28} y={BOX.y + 54} fill={C.dim} fontFamily={FONT} fontSize={40}>{v.universe ?? "S"}</text>
      </g>
      {v.steps.map((s, k) => {
        if (k > cur) return null;
        const a = ramp(t, at[k] ?? 0, 0.5);
        const opacity = (k === cur ? 0.38 : 0.14) * a;
        return <g key={k}>{s.shade.map((r, j) => <g key={j}>{regionShape(r, `${k}-${j}`, C.yellow, opacity)}</g>)}</g>;
      })}
      <g opacity={appear}>
        {circles.map((c, i) => (
          <g key={i}>
            <circle cx={c.cx} cy={c.cy} r={c.r} fill="none" stroke={SET_COLOURS[i]} strokeWidth={5} />
            {/* outside the circle, off its upper-left (A), upper-right (B) or lower-right (C) edge */}
            <text x={v.apart ? c.cx : c.cx + (i === 0 ? -c.r * 0.76 : c.r * 0.76)} y={v.apart ? c.cy - c.r - 24 : i === 2 ? c.cy + c.r * 0.92 : c.cy - c.r * 0.8} textAnchor={v.apart ? "middle" : i === 0 ? "end" : "start"} fill={SET_COLOURS[i]} fontFamily={FONT} fontSize={46}>
              {v.sets[i]!.label}
            </text>
          </g>
        ))}
        {[...groups.entries()].map(([k, labels]) => {
          const p = anchor(v.sets.length, k.split(",").map((x) => x === "true"), circles, !!v.apart);
          const cols = Math.min(3, labels.length);
          return labels.map((l, j) => (
            <text key={`${k}-${j}`} x={p.x + ((j % cols) - (cols - 1) / 2) * 70} y={p.y + Math.floor(j / cols) * 62 + 14} textAnchor="middle" fill={C.text} fontFamily={FONT} fontSize={42}>
              {l}
            </text>
          ));
        })}
      </g>
      {cur >= 0 && v.steps[cur]?.caption && (
        <text x={960} y={BOX.y + BOX.h + 62} textAnchor="middle" fill={C.yellow} fontFamily={FONT} fontSize={40} opacity={ramp(t, (at[cur] ?? 0) + 0.2)}>
          {v.steps[cur]!.caption}
        </text>
      )}
    </svg>
  );
};
