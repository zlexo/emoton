import { useMemo } from "react";
import type { DiagramScene } from "../../core/diagram.ts";
import { EDGE_FONT, NODE_FONT, drawEdge, layoutDiagram, nodeRect, nodeSize } from "../../core/diagramLayout.ts";
import { C, FONT, ramp, clamp01 } from "../theme.ts";

type Timeline = { scenes: DiagramScene[]; times: number[][] };

/**
 * Replays the resolved steps up to time t, remembering when each element
 * entered and when each label last changed, so entries and relabels animate.
 */
function replay({ scenes, times }: Timeline, t: number) {
  const enteredAt: Record<string, number> = {};
  const relabeledAt: Record<string, number> = {};
  const first = scenes[0]!;
  let visible = new Set(first.initial);
  let labels = { ...first.initialLabels };
  let prevLabels = { ...labels };
  let highlight = new Set<string>();
  let hlAt = 0;
  for (const id of visible) enteredAt[id] = -99;
  scenes.forEach((sc, si) => {
    sc.steps.forEach((st, k) => {
      const at = times[si]![k]!;
      if (at > t + 1e-6) return;
      for (const id of st.visible) if (!visible.has(id)) enteredAt[id] = at;
      for (const [id, l] of Object.entries(st.labels)) {
        if (labels[id] !== undefined && labels[id] !== l) {
          prevLabels[id] = labels[id]!;
          relabeledAt[id] = at;
        }
      }
      visible = new Set(st.visible);
      labels = { ...labels, ...st.labels };
      highlight = st.highlight;
      hlAt = at;
    });
  });
  return { visible, labels, prevLabels, highlight, hlAt, enteredAt, relabeledAt };
}

export const Diagram: React.FC<{ tl: Timeline; t: number }> = ({ tl, t }) => {
  const last = tl.scenes[tl.scenes.length - 1]!;
  const nodes = last.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const s = replay(tl, t);
  // Laid out once for the whole segment (src/core/diagramLayout.ts), so nothing moves as it builds.
  const L = useMemo(() => layoutDiagram(tl.scenes), [tl.scenes]);
  const box = (id: string) => {
    const n = byId.get(id)!;
    return nodeRect(L.pos[id]!, nodeSize(s.labels[id] ?? n.label, n.shape), n.shape);
  };

  return (
    <svg viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0 }}>
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g transform={`matrix(${L.scale} 0 0 ${L.scale} ${L.tx} ${L.ty})`}>
        {last.edges.map((e) => {
          const a = byId.get(e.from), b = byId.get(e.to), lay = L.edges[e.id];
          if (!a || !b || !lay || !s.visible.has(e.id) || !s.visible.has(e.from) || !s.visible.has(e.to)) return null;
          const d = drawEdge(lay.route, L.pos[a.id]!, box(a.id), L.pos[b.id]!, box(b.id));
          const draw = ramp(t, s.enteredAt[e.id] ?? -99, 0.6);
          const hl = s.highlight.has(e.id);
          const col = hl ? C.yellow : C.text;
          const { end: p, angle: ang } = d;
          const head = `M ${p.x} ${p.y} L ${p.x - 22 * Math.cos(ang - 0.4)} ${p.y - 22 * Math.sin(ang - 0.4)} L ${p.x - 22 * Math.cos(ang + 0.4)} ${p.y - 22 * Math.sin(ang + 0.4)} Z`;
          return (
            <g key={e.id} filter={hl ? "url(#glow)" : undefined}>
              <path d={d.d} fill="none" stroke={col} strokeWidth={4} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
              <path d={head} fill={col} opacity={clamp01((draw - 0.85) / 0.15)} />
              {e.label && lay.label && (
                <text x={lay.label.x} y={lay.label.y} fill={hl ? C.yellow : C.dim} fontFamily={FONT} fontSize={EDGE_FONT} textAnchor="middle" dominantBaseline="middle" opacity={ramp(t, (s.enteredAt[e.id] ?? -99) + 0.4)}>
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          if (!s.visible.has(n.id)) return null;
          const { x, y } = L.pos[n.id]!;
          const label = s.labels[n.id] ?? n.label;
          const { w, h } = nodeSize(label, n.shape);
          const enter = ramp(t, s.enteredAt[n.id] ?? -99, 0.5);
          const hl = s.highlight.has(n.id);
          const pulse = hl ? 1 + 0.06 * Math.sin(Math.PI * clamp01((t - s.hlAt) / 0.5)) : 1;
          const col = hl ? C.yellow : C.blue;
          const rx = n.shape === "pill" ? h / 2 : 10;
          const perim = 2 * (w + h);
          const rel = s.relabeledAt[n.id];
          const swap = rel === undefined ? 1 : ramp(t, rel, 0.4);
          return (
            <g key={n.id} transform={`translate(${x} ${y}) scale(${pulse})`} filter={hl ? "url(#glow)" : undefined}>
              {n.shape === "stack" &&
                [2, 1].map((k) => (
                  <rect key={k} x={-w / 2 + k * 12} y={-h / 2 - k * 12} width={w} height={h} rx={rx} fill={C.bg} stroke={col} strokeWidth={3} opacity={0.5 * enter} />
                ))}
              <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={rx} fill={hl ? "rgba(244,211,69,0.10)" : "rgba(88,196,221,0.08)"} fillOpacity={enter} stroke={col} strokeWidth={4} strokeDasharray={perim} strokeDashoffset={perim * (1 - enter)} />
              {rel !== undefined && swap < 1 && (
                <text y={2} fill={C.text} fontFamily={FONT} fontSize={NODE_FONT} textAnchor="middle" dominantBaseline="middle" opacity={1 - swap}>
                  {s.prevLabels[n.id]}
                </text>
              )}
              <text y={2} fill={C.text} fontFamily={FONT} fontSize={NODE_FONT} textAnchor="middle" dominantBaseline="middle" opacity={ramp(t, (s.enteredAt[n.id] ?? -99) + 0.25, 0.4) * swap}>
                {label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
};
