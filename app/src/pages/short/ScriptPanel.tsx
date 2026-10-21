import { useState } from "react";
import { MARKERS, type Short } from "../../../../schema/short.ts";
import type { ResolvedShort } from "../../../../src/core/short/resolve.ts";
import type { ShortMedia } from "../../../../src/remotion/shorts/props.ts";
import { clock, sameSelection, type Selection } from "./layout.ts";
import { SoundsPanel } from "./SoundsPanel.tsx";
import { addClipScene, addClipScenes, useClip } from "../../../../src/core/short/edit.ts";
import { api } from "../../lib/api.ts";
import type { Edit } from "./useShortEditor.ts";

/** A script line as text runs and marker chips, in the order written. */
export function lineParts(raw: string): { text?: string; marker?: string }[] {
  const out: { text?: string; marker?: string }[] = [];
  let last = 0;
  for (const m of raw.matchAll(/\[([^\]\n]{0,40})\]/g)) {
    const before = raw.slice(last, m.index).trim();
    if (before) out.push({ text: before });
    const name = m[1]!.trim();
    out.push((MARKERS as readonly string[]).includes(name) ? { marker: name } : { text: m[0] });
    last = m.index! + m[0].length;
  }
  const rest = raw.slice(last).trim();
  if (rest) out.push({ text: rest });
  return out;
}

/** A line being written anew: a text field in place, Enter keeps it, Escape leaves it as it was. */
function LineEditor({ raw, onDone }: { raw: string; onDone(text: string | null): void }) {
  const [text, setText] = useState(raw);
  return (
    <textarea
      className="textarea sx-line-edit"
      autoFocus
      value={text}
      rows={2}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), onDone(text));
        else if (e.key === "Escape") (e.preventDefault(), onDone(null));
      }}
    />
  );
}

export function ScriptPanel({ id, short, doc, media, sel, now, onSelect, onRewrite, edit, onError, clips, top }: {
  id: string; short: ResolvedShort; doc: Short; media: ShortMedia; sel: Selection | null; now: number; onSelect(s: Selection): void; clips: string[];
  /** Claude's proposal and notes, shown above the tabs. */
  top?: React.ReactNode;
  /** A line written anew (markers inline): it is voiced again, and what is pinned to it follows. */
  onRewrite(scene: string, line: number, raw: string): void;
  edit(e: Edit): void; onError(m: string): void;
}) {
  const [tab, setTab] = useState<"script" | "scenes" | "sounds" | "assets">("script");
  const [editing, setEditing] = useState<{ scene: string; line: number } | null>(null);
  const speaking = short.sentences.find((x) => x.start <= now && now < x.end)?.key;
  const files = [...new Set(Object.values(media.footage))];
  return (
    <div className="sx-left">
      {top ? <div className="sx-left-top">{top}</div> : null}
      <div className="tabs" style={{ padding: "0 12px" }}>
        {(["script", "scenes", "sounds", "assets"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
      </div>
      <div className="sx-left-scroll">
        {tab === "script" && doc.scenes.map((sc) => {
          const r = short.scenes.find((x) => x.id === sc.id)!;
          const lines = short.sentences.filter((x) => x.scene === sc.id);
          const on = sameSelection(sel, { kind: "scene", id: sc.id });
          return (
            <div key={sc.id} className={`sx-scene${on ? " on" : ""}`}>
              <button className="sx-scene-head" onClick={() => onSelect({ kind: "scene", id: sc.id })}>
                <b>{sc.id}</b>
                <span className="sx-dim">{sc.visual?.type === "shot" ? sc.visual.kind : sc.visual?.type ?? "continues"} · {r.seconds.toFixed(2)} s</span>
              </button>
              {sc.hold !== undefined && <div className="sx-line sx-dim">held {sc.hold} s, no narration</div>}
              {(sc.say ?? []).map((raw, k) => {
                const x = lines[k];
                const lineOn = x && sameSelection(sel, { kind: "sentence", key: x.key });
                if (editing?.scene === sc.id && editing.line === k) {
                  return <LineEditor key={k} raw={raw} onDone={(text) => (setEditing(null), text !== null && text.trim() && text.trim() !== raw && onRewrite(sc.id, k, text.trim()))} />;
                }
                return (
                  <button key={k} title="double-click to rewrite" className={`sx-line${lineOn ? " on" : ""}${x && x.key === speaking ? " now" : ""}`}
                    onClick={() => x && onSelect({ kind: "sentence", key: x.key })} onDoubleClick={() => setEditing({ scene: sc.id, line: k })}>
                    {lineParts(raw).map((p, i) => (p.marker ? <span key={i} className={`sx-mark m-${p.marker}`}>{p.marker}</span> : <span key={i}>{p.text} </span>))}
                  </button>
                );
              })}
            </div>
          );
        })}
        {tab === "scenes" && short.scenes.map((sc, i) => (
          <button key={sc.id} className={`chap${sameSelection(sel, { kind: "scene", id: sc.id }) ? " on" : ""}`} onClick={() => onSelect({ kind: "scene", id: sc.id })}>
            <div className="num">{i + 1}</div>
            <div>
              <div className="ti">{sc.id}</div>
              <div className="me">{clock(sc.from)} · {sc.seconds.toFixed(1)} s · {sc.visual.type === "shot" ? sc.visual.kind : sc.visual.type}{media.footage[sc.footage.scene] ? "" : " · not rendered"}</div>
            </div>
          </button>
        ))}
        {tab === "sounds" && <SoundsPanel id={id} doc={doc} short={short} now={now} edit={edit} onError={onError} />}
        {tab === "assets" && (
          <div className="sx-assets">
            <h4 className="sx-assets-h">Clips</h4>
            <label className="btn small" style={{ alignSelf: "flex-start" }}>
              Add clips…
              <input type="file" accept="video/mp4,video/quicktime,video/webm,.m4v" multiple hidden onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (!files.length) return;
                void api.addShortClips(id, files)
                  .then(({ assets }) => edit((d) => addClipScenes(d, assets, 3, sel?.kind === "scene" ? sel.id : undefined)))
                  .catch((err: Error) => onError(err.message));
              }} />
            </label>
            <p className="sx-dim">Each clip comes in as a new 3 s scene after the selected one (or at the end); its proxy is made for smooth scrubbing.</p>
            {clips.map((c) => (
              <div key={c} className="sx-clip">
                <span className="sx-sound-name" title={c}>{c.split("/").pop()}</span>
                <span className="chips"><button className="btn small ghost" onClick={() => edit((d) => addClipScene(d, c, 3, sel?.kind === "scene" ? sel.id : undefined))}>New scene</button>
                <button className="btn small ghost" disabled={sel?.kind !== "scene"} title={sel?.kind === "scene" ? undefined : "select a scene first"} onClick={() => sel?.kind === "scene" && edit((d) => useClip(d, sel.id, c))}>Use for scene</button></span>
              </div>
            ))}
            <h4 className="sx-assets-h">Footage in use</h4>
            {files.length === 0 && <div className="sx-dim">No footage on disk yet.</div>}
            {files.map((f) => <div key={f} className="sx-asset">{decodeURIComponent(f.split("?")[0]!.split("/").slice(3).join("/"))}</div>)}
            {media.music && <div className="sx-asset">{decodeURIComponent(media.music.split("?")[0]!.split("/").slice(3).join("/"))}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
