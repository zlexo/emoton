// Ported unchanged from Code Typer (src/remotion/Editor.tsx there).
import { fileAt, stateAt, cursorOf, type Timeline, type FileTrack } from "../../../core/short/code/timeline.ts";
import { linesOf, type Tok } from "./java.ts";
import { wrapText, caretRow, type Wrap } from "../../../core/short/code/wrap.ts";
import { cameraTrack } from "../../../core/short/code/camera.ts";
import { IDE, MONO, W, FPS } from "./theme.ts";

const FONT = 31;
const LH = Math.round(FONT * 1.5);
const CW = FONT * 0.6; // JetBrains Mono advance width
const TAB_H = 92;
const GUTTER = 104;
const PAD = 22;
/** Columns that fit; the camera is locked horizontally, longer lines soft-wrap. */
const COLS = Math.floor((W - GUTTER - PAD) / CW);

const wrapCache = new Map<string, Wrap>();
function wrapOf(text: string): Wrap {
  let w = wrapCache.get(text);
  if (!w) { w = wrapText(text, COLS); wrapCache.set(text, w); }
  return w;
}

/** The tokens of one line that fall in columns [a, b). */
function sliceTokens(line: Tok[], a: number, b: number): Tok[] {
  const out: Tok[] = [];
  let pos = 0;
  for (const tk of line) {
    const s = Math.max(a, pos), e = Math.min(b, pos + tk.text.length);
    if (e > s) out.push({ text: tk.text.slice(s - pos, e - pos), kind: tk.kind });
    pos += tk.text.length;
    if (pos >= b) break;
  }
  return out;
}

const COLOR: Record<string, string> = {
  keyword: IDE.keyword, boolean: IDE.keyword, string: IDE.string, char: IDE.string,
  number: IDE.number, comment: IDE.comment, annotation: IDE.annotation, function: IDE.fn,
  "class-name": IDE.type, operator: IDE.text, punctuation: IDE.text, plain: IDE.text,
};

const camCache = new Map<string, number[]>();
function cameraFor(tr: FileTrack, viewH: number) {
  const key = `${tr.name}:${tr.start}:${viewH}`;
  let y = camCache.get(key);
  if (!y) { y = cameraTrack(tr, wrapOf(tr.text), LH, viewH, FPS).y; camCache.set(key, y); }
  return y;
}

function fmtTimer(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = sec.toFixed(2).padStart(5, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function parseTimer(v?: string): number | undefined {
  if (!v) return undefined;
  const p = v.split(":").map(Number);
  if (p.some((n) => !Number.isFinite(n))) return undefined;
  return p.reduce((a, n) => a * 60 + n, 0);
}

export const Editor: React.FC<{
  tl: Timeline; t: number; height: number; series: string; timerTarget?: number;
}> = ({ tl, t, height, series, timerTarget }) => {
  const fi = fileAt(tl, t);
  const tr = tl.files[fi]!;
  const { len, typo } = stateAt(tr, t);
  const cur = cursorOf(tr, len);
  const viewH = height - TAB_H;
  const cam = cameraFor(tr, viewH);
  const camF = Math.min(cam.length - 1, Math.max(0, Math.floor((t - tr.start) * FPS)));
  const sy = cam[camF]!;
  const lines = linesOf(tr.text, tr.name);
  const wrap = wrapOf(tr.text);
  const caret = caretRow(wrap, cur.line, cur.col);

  // New file: punch in from 94% so each tab switch reads as a beat.
  const since = t - tr.start;
  const punch = fi > 0 && since < 0.2 ? 0.94 + 0.06 * Math.sin((since / 0.2) * (Math.PI / 2)) : 1;

  const first = Math.max(0, Math.floor(sy / LH) - 1);
  const last = Math.min(wrap.rows.length - 1, first + Math.ceil(viewH / LH) + 2);
  const done = len >= tr.text.length && t >= tr.steps.at(-1)!.t;
  const caretOn = !done || Math.floor(t * 2.2) % 2 === 0;

  // Tabs: every file opened so far, scrolled so the active one is the rightmost visible.
  const tabs = tl.files.slice(0, fi + 1);
  const tabW = (n: string) => 76 + n.length * 17;
  let acc = 0, firstTab = tabs.length - 1;
  for (let i = tabs.length - 1; i >= 0; i--) {
    acc += tabW(tabs[i]!.name);
    if (acc > W - 20) break;
    firstTab = i;
  }

  // Overengineered HUD: lines written so far across all files.
  const linesSoFar = tl.files.slice(0, fi).reduce((a, f) => a + f.lineStarts.length, 0) + cur.line + 1;

  return (
    <div style={{ position: "absolute", inset: 0, background: IDE.bg, overflow: "hidden", fontFamily: MONO }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: TAB_H, background: IDE.chrome, borderBottom: `2px solid ${IDE.border}`, display: "flex", alignItems: "flex-end", overflow: "hidden" }}>
        {tabs.slice(firstTab).map((f, i) => {
          const active = firstTab + i === fi;
          return (
            <div key={f.name + i} style={{ flex: "none", width: tabW(f.name), height: TAB_H - 14, display: "flex", alignItems: "center", gap: 12, padding: "0 18px", background: active ? IDE.tabActive : "transparent", borderBottom: `4px solid ${active ? IDE.tabUnderline : "transparent"}`, color: active ? IDE.text : IDE.comment, fontSize: 28, fontFamily: "Inter, system-ui, sans-serif", whiteSpace: "nowrap" }}>
              <span style={{ flex: "none", width: 30, height: 30, borderRadius: 15, background: "#3D8FD6", color: "#fff", fontSize: 18, fontWeight: 700, display: "grid", placeItems: "center", fontFamily: MONO }}>C</span>
              {f.name}
            </div>
          );
        })}
      </div>

      <div style={{ position: "absolute", left: 0, right: 0, top: TAB_H, bottom: 0, overflow: "hidden", transform: `scale(${punch})`, transformOrigin: "50% 30%" }}>
        {Array.from({ length: last - first + 1 }, (_, k) => {
          const ri = first + k;
          const row = wrap.rows[ri]!;
          const ln = row.line;
          const y = ri * LH - sy;
          const shown = len - tr.lineStarts[ln]!; // chars of this line typed so far
          const onCaret = ri === caret.row;
          if (shown < 0 && !(onCaret && typo)) return null; // line not reached yet
          if (row.a > 0 && shown <= row.a && !onCaret) return null; // wrapped row not reached yet
          const curLine = ln === cur.line;
          return (
            <div key={ri} style={{ position: "absolute", top: y, left: 0, right: 0, height: LH, background: curLine ? IDE.cursorLine : "transparent" }}>
              {row.a === 0 ? (
                <div style={{ position: "absolute", left: 0, width: GUTTER - 28, textAlign: "right", color: curLine ? IDE.text : IDE.gutter, fontSize: FONT * 0.8, lineHeight: `${LH}px` }}>{ln + 1}</div>
              ) : null}
              <div style={{ position: "absolute", left: GUTTER + row.indent * CW, fontSize: FONT, lineHeight: `${LH}px`, whiteSpace: "pre", color: IDE.text }}>
                {sliceTokens(lines[ln] ?? [], row.a, Math.min(row.b, Math.max(row.a, shown))).map((tk, j) => (
                  <span key={j} style={{ color: COLOR[tk.kind] ?? IDE.text, fontStyle: tk.kind === "comment" ? "italic" : undefined }}>{tk.text}</span>
                ))}
                {typo && onCaret ? <span style={{ color: IDE.text }}>{typo}</span> : null}
              </div>
              {onCaret && caretOn ? (
                <div style={{ position: "absolute", left: GUTTER + (caret.x + (typo ? 1 : 0)) * CW, top: 6, width: 3, height: LH - 12, background: IDE.caret }} />
              ) : null}
            </div>
          );
        })}
      </div>

      {series === "speedrun" ? (
        <div style={{ position: "absolute", right: 26, bottom: 40, padding: "14px 26px", background: "rgba(0,0,0,0.78)", borderRadius: 14, border: `2px solid ${IDE.hud}`, color: IDE.hud, fontSize: 62, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {fmtTimer(Math.min(1, t / tl.duration) * (timerTarget ?? tl.duration))}
        </div>
      ) : null}
      {series === "overengineered" ? (
        <div style={{ position: "absolute", left: 26, right: 26, bottom: 40, padding: "18px 26px", background: "rgba(0,0,0,0.8)", borderRadius: 14, color: "#fff", fontSize: 46, fontWeight: 700, display: "flex", justifyContent: "space-between", fontVariantNumeric: "tabular-nums" }}>
          <span>{fi + 1} files</span>
          <span>{linesSoFar.toLocaleString("en-US")} lines</span>
        </div>
      ) : null}
    </div>
  );
};
