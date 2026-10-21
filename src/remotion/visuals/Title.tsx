import type { TitleVisual } from "../../../schema/storyboard.ts";
import { C, FONT, ramp } from "../theme.ts";

/** The title's words, each with the index of its first character in the whole title. */
function words(title: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let at = 0;
  for (const part of title.split(" ")) {
    if (part) out.push({ text: part, at });
    at += [...part].length + 1;
  }
  return out;
}

/** Manim-style Write: characters arrive left to right, then the subtitle. */
export const Title: React.FC<{ v: TitleVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const t0 = at[0] ?? 0;
  const chars = [...v.title];
  const per = Math.min(0.045, 0.9 / Math.max(1, chars.length));
  const lineIn = ramp(t, t0 + chars.length * per, 0.6);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
      <div style={{ fontSize: 92, color: C.text, textAlign: "center", maxWidth: 1600, lineHeight: 1.15 }}>
        {/* letters arrive one by one, but a line only breaks between words */}
        {words(v.title).map((w, k) => (
          <span key={k}>
            {k > 0 && " "}
            <span style={{ display: "inline-block", whiteSpace: "nowrap" }}>
              {[...w.text].map((ch, j) => {
                const a = ramp(t, t0 + (w.at + j) * per, 0.35);
                return (
                  <span key={j} style={{ opacity: a, display: "inline-block", transform: `translateY(${(1 - a) * 14}px)`, whiteSpace: "pre" }}>
                    {ch}
                  </span>
                );
              })}
            </span>
          </span>
        ))}
      </div>
      <div style={{ height: 3, background: C.blue, width: 520 * lineIn, marginTop: 34 }} />
      {v.subtitle && (
        <div style={{ fontSize: 44, color: C.dim, marginTop: 30, opacity: ramp(t, at[1] ?? t0 + 1, 0.6), maxWidth: 1400, textAlign: "center" }}>
          {v.subtitle}
        </div>
      )}
    </div>
  );
};
