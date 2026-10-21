import { safeZones, type Platform } from "../../../../src/core/short/safe.ts";

/** What the platform's own buttons and text cover, hatched over the preview. */
export function SafeZones({ platform, canvas }: { platform: Platform; canvas: { w: number; h: number } }) {
  return (
    <svg className="sx-safe" viewBox={`0 0 ${canvas.w} ${canvas.h}`} preserveAspectRatio="none">
      <defs>
        <pattern id="hatch" width="48" height="48" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="48" height="48" fill="rgba(252, 98, 85, 0.18)" />
          <line x1="0" y1="0" x2="0" y2="48" stroke="rgba(252, 98, 85, 0.6)" strokeWidth="12" />
        </pattern>
      </defs>
      {safeZones(platform, canvas).map((r) => (
        <g key={r.label}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#hatch)" stroke="rgba(252, 98, 85, 0.9)" strokeWidth="8" strokeDasharray="28 18" />
          <text x={r.x + 20} y={r.y + 60} fill="#fff" fontSize="46" fontFamily="Inter, sans-serif" fontWeight="700" style={{ paintOrder: "stroke" }} stroke="#000" strokeWidth="10">{r.label}</text>
        </g>
      ))}
    </svg>
  );
}
