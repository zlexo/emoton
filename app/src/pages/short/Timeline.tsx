import { useEffect, useMemo, useRef, useState } from "react";
import type { Anchor } from "../../../../schema/short.ts";
import { snap, type SnapTo } from "../../../../src/core/short/edit.ts";
import type { ResolvedShort } from "../../../../src/core/short/resolve.ts";
import type { Peaks } from "../../lib/types.ts";
import { beatLines, clock, rulerTicks, sameSelection, TRACK_LABEL, TRACKS, type Item, type Selection, type Track } from "./layout.ts";

const LABEL_W = 84;
const RULER_H = 24;
const HEIGHT: Record<Track, number> = { scenes: 40, text: 26, captions: 26, voice: 46, fx: 24, sfx: 24, music: 34 };
const TONE: Record<Track, string> = {
  scenes: "var(--blue)", text: "var(--yellow)", captions: "#9a9aa6", voice: "var(--blue)", fx: "var(--red)", sfx: "var(--green)", music: "#b48ce6",
};

/** A track's waveform, drawn into a canvas the width of the timeline. */
function Wave({ peaks, px, width, height, color }: { peaks: Peaks; px: number; width: number; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bytes = useMemo(() => Uint8Array.from(atob(peaks.peaks), (c) => c.charCodeAt(0)), [peaks]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(width * dpr);
    c.height = Math.ceil(height * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, height);
    g.fillStyle = color;
    const mid = height / 2, perPx = peaks.rate / px;
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let i = Math.floor(x * perPx), end = Math.max(i + 1, Math.floor((x + 1) * perPx)); i < end && i < bytes.length; i++) m = Math.max(m, bytes[i]!);
      const h = Math.max(0.5, (m / 255) * (height - 6));
      g.fillRect(x, mid - h / 2, 1, h);
    }
  }, [bytes, px, width, height, color, peaks.rate]);
  return <canvas ref={ref} style={{ position: "absolute", left: 0, top: 0, width, height, opacity: 0.55, pointerEvents: "none" }} />;
}

export type Edge = "body" | "start" | "end";
/** A pause in the voice: after word k of a line (or after the line), from where the word ends to where the next starts, and its edit in ms. */
export type Gap = { key: string; k: number | "after"; at: number; to: number; edit: number };
/** How near (in pixels) a drop must come to a word, beat or cut to snap to it. */
const SNAP_PX = 8;

export function Timeline({ short, items, peaks, now, px, setPx, selection, onSelect, onSeek, playing, snapTo, setSnapTo, edges, onDrop, gaps, onPause, marked }: {
  short: ResolvedShort; items: Item[]; peaks: { voice?: Peaks; music?: Peaks }; now: number; px: number; setPx(px: number): void;
  /** Items a pending Ask proposal changes, outlined. */
  marked?: Set<string>;
  selection: Selection | null; onSelect(s: Selection): void; onSeek(t: number): void; playing: boolean;
  snapTo: SnapTo; setSnapTo(s: SnapTo): void;
  /** Which parts of an item can be dragged: the whole of it, its start, its end. */
  edges(it: Item): Edge[];
  onDrop(it: Item, edge: Edge, to: { at: Anchor; t: number }): void;
  /** The voice's pauses, when it is voiced; dragging one changes it by the ms dragged. */
  gaps: Gap[];
  onPause(g: Gap, deltaMs: number): void;
}) {
  const [pull, setPull] = useState<{ g: Gap; x0: number; dx: number } | null>(null);
  const pullRef = useRef(pull);
  pullRef.current = pull;
  const pullMs = (p: { dx: number }) => Math.round((p.dx / px) * 200) * 5;
  useEffect(() => {
    if (!pull) return;
    const move = (e: PointerEvent) => setPull((p) => (p ? { ...p, dx: e.clientX - p.x0 } : p));
    const up = () => {
      const p = pullRef.current;
      setPull(null);
      if (p && Math.abs(p.dx) > 2 && pullMs(p) !== 0) onPause(p.g, pullMs(p));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [pull !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drag, setDrag] = useState<{ it: Item; edge: Edge; x0: number; dx: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  // where a drag lands: the item's start (or end) moved by the pointer, snapped
  const landing = (d: { it: Item; edge: Edge; dx: number }) => snap(short, (d.edge === "end" ? d.it.end : d.it.start) + d.dx / px, snapTo, SNAP_PX / px);
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, dx: e.clientX - d.x0 } : d));
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (d && Math.abs(d.dx) > 3) onDrop(d.it, d.edge, landing(d));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const scroller = useRef<HTMLDivElement>(null);
  const width = Math.ceil(short.duration * px) + 40;
  const { ticks } = rulerTicks(short.duration, px);
  const beats = useMemo(() => beatLines(short), [short]);
  const byTrack = useMemo(() => Object.fromEntries(TRACKS.map((t) => [t, items.filter((i) => i.track === t)])) as Record<Track, Item[]>, [items]);
  let y = RULER_H;
  const tops = Object.fromEntries(TRACKS.map((t) => { const top = y; y += HEIGHT[t]; return [t, top]; })) as Record<Track, number>;
  const total = y;

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing) return;
    const x = now * px;
    if (x < el.scrollLeft + 20 || x > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.25);
  }, [now, px, playing]);

  const seekAt = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onSeek(Math.max(0, Math.min(short.duration, (e.clientX - r.left) / px)));
  };
  const fit = () => {
    const w = scroller.current?.clientWidth ?? 800;
    setPx(Math.max(8, (w - 40) / Math.max(1, short.duration)));
  };

  return (
    <div className="sx-tl">
      <div className="sx-tl-head">
        <b>Timeline</b>
        <span className="sx-dim">{clock(now)} / {clock(short.duration)}</span>
        {short.music?.grid && <span className="chip draft">Beats {Math.round(short.music.grid.bpm)} BPM</span>}
        <span className="sx-dim" style={{ marginLeft: 10 }}>Snap to</span>
        {(["words", "beats", "scenes"] as const).map((k) => (
          <button key={k} className={`toggle-chip${snapTo[k] ? " on" : ""}`} onClick={() => setSnapTo({ ...snapTo, [k]: !snapTo[k] })}>{k}</button>
        ))}
        {drag && Math.abs(drag.dx) > 3 && <span className="chip making">{clock(landing(drag).t)}{"t" in landing(drag).at ? "" : " · snapped"}</span>}
        {pull && Math.abs(pull.dx) > 2 && <span className="chip making">pause {pullMs(pull) >= 0 ? "+" : ""}{pullMs(pull)} ms</span>}
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => setPx(Math.max(8, px / 1.5))} title="Zoom out">−</button>
        <button className="btn small ghost" onClick={fit}>Fit</button>
        <button className="btn small ghost" onClick={() => setPx(Math.min(600, px * 1.5))} title="Zoom in">+</button>
      </div>
      <div className="sx-tl-body">
        <div className="sx-tl-labels" style={{ height: total }}>
          {TRACKS.map((t) => <div key={t} style={{ top: tops[t], height: HEIGHT[t] }}>{TRACK_LABEL[t]}</div>)}
        </div>
        <div className="sx-tl-scroll" ref={scroller}>
          <div className="sx-tl-area" style={{ width, height: total }}>
            <div className="sx-tl-ruler" style={{ height: RULER_H }} onMouseDown={seekAt}>
              {ticks.map((t) => <span key={t} style={{ left: t * px }}>{clock(t).replace(/\.0$/, "")}</span>)}
            </div>
            {beats.map((b) => <div key={b} className="sx-beat" style={{ left: b * px, top: RULER_H, height: total - RULER_H }} />)}
            {TRACKS.map((t) => (
              <div key={t} className="sx-track" style={{ top: tops[t], height: HEIGHT[t] }} onMouseDown={seekAt}>
                {t === "voice" && peaks.voice && <Wave peaks={peaks.voice} px={px} width={width} height={HEIGHT.voice} color="#58c4dd" />}
                {t === "voice" && gaps.map((g) => {
                  const live = pull?.g === g ? pullMs(pull) : 0;
                  const w = Math.max(4, (g.to - g.at) * px + (live / 1000) * px);
                  const total = g.edit + live;
                  return (
                    <div key={`${g.key}:${g.k}`} className={`sx-gap${total ? " edited" : ""}`} style={{ left: g.at * px, width: w }}
                      title={`pause ${Math.round((g.to - g.at) * 1000)} ms${g.edit ? ` (${g.edit > 0 ? "+" : ""}${g.edit} edited)` : ""}: drag to change`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onPointerDown={(e) => (e.stopPropagation(), setPull({ g, x0: e.clientX, dx: 0 }))}>
                      {total ? <span>{total > 0 ? "+" : ""}{total}</span> : null}
                    </div>
                  );
                })}
                {t === "music" && peaks.music && <Wave peaks={peaks.music} px={px} width={width} height={HEIGHT.music} color="#b48ce6" />}
                {byTrack[t].map((it) => {
                  const on = sameSelection(selection, it.sel);
                  let left = it.start * px, w = Math.max(it.point ? 10 : 3, (it.end - it.start) * px);
                  if (drag?.it.key === it.key && Math.abs(drag.dx) > 3) {
                    const d = (landing(drag).t - (drag.edge === "end" ? it.end : it.start)) * px;
                    if (drag.edge === "body") left += d;
                    else if (drag.edge === "start") (left += d, w -= d);
                    else w += d;
                  }
                  const can = edges(it);
                  return (
                    <button
                      key={it.key}
                      className={`sx-item${it.point ? " point" : ""}${on ? " on" : ""}${can.length ? " drag" : ""}${marked?.has(it.key) ? " diff" : ""}`}
                      style={{ left, width: Math.max(3, w), ["--tone" as string]: TONE[t] }}
                      title={`${it.label} · ${clock(it.start)}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onSelect(it.sel);
                        if (!can.length) return;
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const x = e.clientX - r.left;
                        const edge: Edge | null = r.width > 18 && x < 6 && can.includes("start") ? "start" : r.width > 18 && x > r.width - 6 && can.includes("end") ? "end" : can.includes("body") ? "body" : null;
                        if (edge) setDrag({ it, edge, x0: e.clientX, dx: 0 });
                      }}
                    >
                      {w > 34 ? it.label : ""}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="sx-playhead" style={{ left: now * px, height: total }} />
          </div>
        </div>
      </div>
    </div>
  );
}
