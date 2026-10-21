import { Highlight, type PrismTheme } from "prism-react-renderer";
import type { CodeVisual } from "../../../schema/storyboard.ts";
import { C, MONO, ramp } from "../theme.ts";
import { stepAt } from "../../core/timing.ts";
import { FitStage } from "./FitStage.tsx";

const theme: PrismTheme = {
  plain: { color: C.text, backgroundColor: "transparent" },
  styles: [
    { types: ["comment"], style: { color: C.dim, fontStyle: "italic" } },
    { types: ["keyword", "builtin"], style: { color: C.blue } },
    { types: ["string", "char"], style: { color: C.green } },
    { types: ["number", "boolean", "constant"], style: { color: C.gold } },
    { types: ["function"], style: { color: C.teal } },
    { types: ["operator", "punctuation"], style: { color: "#B8B8C0" } },
  ],
};
const lang = (l: CodeVisual["language"]) => (l === "pseudo" ? "clike" : l === "c" ? "c" : l);

/** Code appears whole; each sentence lights its lines and dims the rest. */
export const Code: React.FC<{ v: CodeVisual; t: number; at: number[] }> = ({ v, t, at }) => {
  const cur = stepAt(at, t);
  const lit = new Set(cur >= 0 ? v.steps[cur]!.lines : []);
  const appear = ramp(t, (at[0] ?? 0) - 0.4, 0.5);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: appear }}>
      <FitStage>
      <Highlight code={v.code.replace(/\s+$/, "")} language={lang(v.language)} theme={theme}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre style={{ fontFamily: MONO, fontSize: 40, lineHeight: 1.45, margin: 0 }}>
            {tokens.map((line, i) => {
              const on = lit.size === 0 || lit.has(i + 1);
              const { key: _k, ...lp } = getLineProps({ line }) as { key?: unknown; style?: React.CSSProperties };
              return (
                <div key={i} {...lp} style={{ ...lp.style, display: "flex", opacity: on ? 1 : 0.28, transition: "none" }}>
                  <span style={{ width: 8, marginRight: 28, background: lit.has(i + 1) ? C.yellow : "transparent" }} />
                  <span style={{ color: C.faint, width: 56, textAlign: "right", marginRight: 30 }}>{i + 1}</span>
                  <span>
                    {line.map((token, j) => {
                      const { key: _tk, ...tp } = getTokenProps({ token }) as { key?: unknown };
                      return <span key={j} {...tp} />;
                    })}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
      </FitStage>
    </div>
  );
};
