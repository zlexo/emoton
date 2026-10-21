import { useEffect, useState } from "react";
import { FX_KINDS, MARKERS, SYNTH_STYLES, type Anchor, type Short } from "../../../../schema/short.ts";
import {
  addText, lineAt, moveScene, moveSound, removeFx, removeScene, removeSound, removeText, setCaptionStyle, setFx, setKnob, setMusic, setScene, setSound, setText, splitScene, toggleCaption, wordAt,
} from "../../../../src/core/short/edit.ts";
import type { ResolvedShort } from "../../../../src/core/short/resolve.ts";
import type { ShortMedia } from "../../../../src/remotion/shorts/props.ts";
import { clock, type Selection } from "./layout.ts";
import type { Edit } from "./useShortEditor.ts";
import type { Gap } from "./Timeline.tsx";
import { ShotPanel } from "./ShotPanel.tsx";
import type { ShotState } from "../../lib/types.ts";

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="sx-row"><span>{k}</span><div>{children}</div></div>
);
const s3 = (t: number) => `${t.toFixed(2)} s`;
const db = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)} dB`;

/** An anchor in words: the word, line, beat, scene edge or time it is pinned to. */
export function describeAnchor(a: Anchor, s: ResolvedShort): string {
  const off = "offset" in a && a.offset ? ` ${a.offset > 0 ? "+" : "−"}${Math.abs(a.offset)} s` : "";
  if ("word" in a) {
    const w = s.sentences.find((x) => x.key === a.word.s)?.words[a.word.w];
    return `“${w?.text ?? "?"}” ${a.edge === "end" ? "end" : "start"}${off}`;
  }
  if ("sentence" in a) return `line “${s.sentences.find((x) => x.key === a.sentence)?.text.slice(0, 32) ?? a.sentence}” ${a.edge}${off}`;
  if ("beat" in a) return `beat ${a.beat}${off}`;
  if ("scene" in a) return `${a.scene} ${a.edge}${off}`;
  return s3(a.t);
}

/** A row of choices, one lit: the styled stand-in for a select. */
function Choice<T extends string>({ value, options, onPick }: { value: T | undefined; options: readonly T[]; onPick(v: T): void }) {
  return (
    <div className="chips">
      {options.map((o) => <button key={o} className={`toggle-chip${o === value ? " on" : ""}`} onClick={() => onPick(o)}>{o}</button>)}
    </div>
  );
}

/** A number field that commits on Enter or when it loses focus. */
function Num({ value, step = 0.1, min, max, onCommit, suffix }: { value: number | undefined; step?: number; min?: number; max?: number; onCommit(v: number | undefined): void; suffix?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    if (text.trim() === "") return onCommit(undefined);
    const v = Number(text);
    if (!Number.isFinite(v)) return setText(value === undefined ? "" : String(value));
    onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
  };
  return (
    <span className="sx-num">
      <input className="input" inputMode="decimal" value={text} step={step} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
      {suffix && <span className="sx-dim">{suffix}</span>}
    </span>
  );
}

/** A text field that commits on Enter or blur. */
function Txt({ value, onCommit, placeholder }: { value: string; onCommit(v: string): void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className="input" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />;
}

export function Inspector({ id, shots, busy, short, doc, media, sel, now, edit, onSelect, gaps, onPause, onRewrite, onRules, voiced, onError }: {
  id: string; shots: ShotState[]; busy: boolean;
  short: ResolvedShort; doc: Short; media: ShortMedia; sel: Selection | null; now: number; edit(e: Edit): void; onSelect(s: Selection | null): void;
  gaps: Gap[]; onPause(g: Gap, deltaMs: number): void; onRewrite(scene: string, line: number, raw: string): void; onRules(): void; voiced: boolean;
  onError(m: string): void;
}) {
  const here = wordAt(short, now);
  const pinHere = (fn: (a: Anchor) => Edit) => () => edit(fn(here ?? { t: +now.toFixed(3) }));

  if (!sel) {
    const t = doc.target;
    const st = doc.captions.style;
    return (
      <div className="sx-insp">
        <h3>{doc.title}</h3>
        <Row k="Template">{doc.template}{doc.series ? ` · ${doc.series}` : ""}</Row>
        <Row k="Canvas">{doc.canvas.w} × {doc.canvas.h}, {doc.canvas.fps} fps</Row>
        <Row k="Length">{s3(short.duration)}</Row>
        <Row k="Target"><Num value={t?.minSeconds} step={1} min={1} suffix="s or more" onCommit={(v) => edit((d) => ({ ...d, target: v ? { ...d.target, minSeconds: v } : undefined }))} /></Row>
        {doc.voice && <Row k="Voice">{doc.voice.engine}, {doc.voice.voice} × {doc.voice.speed}</Row>}
        <h4>Captions</h4>
        <Row k="Words a chunk"><Choice value={String(st.maxWords) as "1"} options={["1", "2", "3", "4", "5"] as const} onPick={(v) => edit((d) => setCaptionStyle(d, { maxWords: Number(v) }))} /></Row>
        <Row k="Spoken word"><button className={`toggle-chip${st.highlight ? " on" : ""}`} onClick={() => edit((d) => setCaptionStyle(d, { highlight: !st.highlight }))}>{st.highlight ? "lit yellow" : "not lit"}</button></Row>
        <Row k="Top edge"><Num value={st.top ?? 1300} step={10} min={0} max={doc.canvas.h} suffix="px" onCommit={(v) => edit((d) => setCaptionStyle(d, { top: v }))} /></Row>
        {short.warnings.length > 0 && <div className="sx-warn">{short.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
        <h4>Voice</h4>
        <div className="chips">
          <button className="btn small" disabled={!voiced} title={voiced ? undefined : "voice it first"} onClick={onRules}>Apply the pause rules</button>
        </div>
        <p className="sx-dim" style={{ marginTop: 6 }}>Commas +175 ms, colons +225 (+350 before a short reveal), +250 after a boom line, +400 before a scene's short last line; pauses already edited stay.</p>
        <h4>Add at the playhead</h4>
        <div className="chips">
          <button className="btn small" onClick={() => edit((d) => addText(d, { role: "label", text: "Label", from: here ?? { t: +now.toFixed(3) }, to: { t: +(now + 2).toFixed(3) } }))}>Label</button>
          <button className="btn small" onClick={() => edit((d) => addText(d, { role: "big", text: "DAY 1", from: here ?? { t: +now.toFixed(3) }, to: { t: +(now + 2).toFixed(3) } }))}>Chapter caption</button>
          <button className="btn small" onClick={() => edit((d) => addText(d, { role: "hook", text: "The hook", from: { t: 0 }, to: { t: 2 } }))}>Hook</button>
        </div>
        <p className="sx-dim" style={{ marginTop: 14 }}>Select anything on the timeline or in the script to change it. B adds a boom at the playhead's word, S splits the scene at its line.</p>
      </div>
    );
  }

  switch (sel.kind) {
    case "scene": {
      const sc = short.scenes.find((x) => x.id === sel.id);
      const src = doc.scenes.find((x) => x.id === sel.id);
      if (!sc || !src) return null;
      const shot = short.shots.find((x) => x.scene === sel.id);
      const v = src.visual;
      const at = lineAt(short, now);
      const canSplit = !!src.say && at?.scene === src.id && at.line > 0;
      return (
        <div className="sx-insp">
          <h3>Scene · {sc.id}</h3>
          <Row k="Time">{clock(sc.from)} for {s3(sc.seconds)}</Row>
          <Row k="Comes in"><Choice value={sc.in} options={["cut", "flash", "drop"] as const} onPick={(x) => edit((d) => setScene(d, sc.id, { in: x }))} /></Row>
          <Row k="Push-in"><Num value={sc.push[1]} step={0.01} min={1} max={1.5} suffix="×" onCommit={(x) => edit((d) => setScene(d, sc.id, { push: x ?? 1.06 }))} /></Row>
          {src.hold !== undefined && <Row k="Held"><Num value={src.hold} step={0.1} min={0.1} suffix="s" onCommit={(x) => x && edit((d) => setScene(d, sc.id, { hold: x }))} /></Row>}
          {src.continue ? <Row k="Footage">continues {sc.footage.scene} from {s3(sc.footage.from)}</Row> : null}
          {v?.type === "shot" && (
            <ShotPanel id={id} scene={sc.id} v={v} short={short} state={shots.find((x) => x.scene === sc.id)} now={now} busy={busy} edit={edit} onError={onError} describe={(a) => describeAnchor(a, short)} />
          )}
          {v?.type === "clip" && <Row k="Clip">{v.asset}{v.from ? ` from ${s3(v.from)}` : ""}{v.speed ? ` × ${v.speed}` : ""}</Row>}
          {v?.type === "code" && <Row k="Code">{v.files.map((f) => `${f.path}${f.ref ? ` @ ${f.ref}` : ""}`).join(", ")}</Row>}
          {v?.type === "card" && <><Row k="Title"><Txt value={v.title} onCommit={(x) => edit((d) => ({ ...d, scenes: d.scenes.map((y) => (y.id === sc.id && y.visual?.type === "card" ? { ...y, visual: { ...y.visual, title: x || "Title" } } : y)) }))} /></Row></>}
          <h4>Scene</h4>
          <div className="chips">
            <button className="btn small" onClick={() => edit((d) => moveScene(d, sc.id, -1))}>Earlier</button>
            <button className="btn small" onClick={() => edit((d) => moveScene(d, sc.id, 1))}>Later</button>
            <button className="btn small" disabled={!canSplit} title={canSplit ? undefined : "put the playhead on a later line of this scene"} onClick={() => at && edit((d) => splitScene(d, sc.id, at.line))}>Split at playhead</button>
            <ConfirmButton label="Remove scene" onConfirm={() => (edit((d) => removeScene(d, sc.id)), onSelect(null))} />
          </div>
        </div>
      );
    }
    case "text": {
      const t = short.text[sel.i], src = doc.text[sel.i];
      if (!t || !src) return null;
      return (
        <div className="sx-insp">
          <h3>Text · {t.role}</h3>
          <Row k="Kind"><Choice value={src.role} options={["hook", "big", "small", "meme", "end", "label"] as const} onPick={(x) => edit((d) => setText(d, sel.i, { role: x }))} /></Row>
          <Row k="Text"><Txt value={src.text} onCommit={(x) => x.trim() && edit((d) => setText(d, sel.i, { text: x.trim() }))} /></Row>
          <Row k="Under it"><Txt value={src.sub ?? ""} placeholder="(none)" onCommit={(x) => edit((d) => setText(d, sel.i, { sub: x.trim() || undefined }))} /></Row>
          <Row k="From"><div className="sx-knob"><span>{describeAnchor(src.from, short)} <span className="sx-dim">{clock(t.from)}</span></span><button className="btn small ghost" onClick={pinHere((a) => (d) => setText(d, sel.i, { from: a }))}>Pin to playhead</button></div></Row>
          <Row k="To"><div className="sx-knob"><span>{describeAnchor(src.to, short)} <span className="sx-dim">{clock(t.to)}</span></span><button className="btn small ghost" onClick={pinHere((a) => (d) => setText(d, sel.i, { to: a }))}>Pin to playhead</button></div></Row>
          <div className="chips" style={{ marginTop: 12 }}><ConfirmButton label="Remove" onConfirm={() => (edit((d) => removeText(d, sel.i)), onSelect(null))} /></div>
        </div>
      );
    }
    case "caption": {
      const c = short.captions[sel.i];
      if (!c) return null;
      const has = (w: number, op: string) => doc.captions.overrides.some((o) => o.word.s === c.sentence && o.word.w === w && o.op === op);
      return (
        <div className="sx-insp">
          <h3>Caption chunk</h3>
          <Row k="Text">{c.text}</Row>
          <Row k="Time">{clock(c.from)} to {clock(c.to)}</Row>
          <div className="chips" style={{ margin: "10px 0" }}>
            <button className={`toggle-chip${has(c.first, "hide") ? " on" : ""}`} onClick={() => edit((d) => toggleCaption(d, c.sentence, c.first, "hide"))}>Hide this chunk</button>
            <button className={`toggle-chip${has(c.first, "join") ? " on" : ""}`} onClick={() => edit((d) => toggleCaption(d, c.sentence, c.first, "join"))}>Join to the one before</button>
          </div>
          <h4>Words</h4>
          {c.words.map((w, k) => {
            const wi = c.first + k;
            return (
              <Row key={k} k={clock(w.at)}>
                <div className="sx-knob">
                  <span>{w.text}</span>
                  <span className="chips">
                    <button className={`toggle-chip${has(wi, "emphasize") ? " on" : ""}`} onClick={() => edit((d) => toggleCaption(d, c.sentence, wi, "emphasize"))}>yellow</button>
                    {k > 0 && <button className={`toggle-chip${has(wi, "break") ? " on" : ""}`} onClick={() => edit((d) => toggleCaption(d, c.sentence, wi, "break"))}>new chunk here</button>}
                  </span>
                </div>
              </Row>
            );
          })}
        </div>
      );
    }
    case "sentence": {
      const x = short.sentences.find((s) => s.key === sel.key);
      if (!x) return null;
      const raw = doc.scenes.find((s) => s.id === x.scene)?.say?.[x.line] ?? x.text;
      const mine = gaps.filter((g) => g.key === x.key);
      return (
        <div className="sx-insp">
          <h3>Line</h3>
          <Row k="Says"><Txt value={raw} onCommit={(t) => t.trim() && t.trim() !== raw && onRewrite(x.scene, x.line, t.trim())} /></Row>
          <Row k="Scene">{x.scene}, line {x.line + 1}</Row>
          <Row k="Time">{clock(x.start)} to {clock(x.end)} ({s3(x.end - x.start)})</Row>
          <p className="sx-dim" style={{ margin: "8px 0" }}>Rewriting a line voices it again (about a second); its pauses and anything pinned to it follow.</p>
          <h4>Pauses</h4>
          {!voiced && <p className="sx-dim">Voice it to set pauses by ear.</p>}
          {mine.map((g) => {
            const word = g.k === "after" ? "end of the line" : `after “${x.words[g.k]?.text}”`;
            return (
              <Row key={String(g.k)} k={`${Math.round((g.to - g.at) * 1000)} ms`}>
                <div className="sx-knob">
                  <span>{word}{g.edit ? <span className="sx-pause"> {g.edit > 0 ? "+" : ""}{g.edit}</span> : null}</span>
                  <span className="chips">
                    {[-100, -20, 20, 100].map((d) => <button key={d} className="btn small ghost" onClick={() => onPause(g, d)}>{d > 0 ? `+${d}` : d}</button>)}
                    {g.edit !== 0 && <button className="btn small ghost" onClick={() => onPause(g, -g.edit)}>reset</button>}
                  </span>
                </div>
              </Row>
            );
          })}
        </div>
      );
    }
    case "fx": {
      const f = short.fx[sel.i];
      if (!f) return null;
      const src = "fx" in f.source ? doc.fx[f.source.fx] : undefined;
      return (
        <div className="sx-insp">
          <h3>Effect · {f.kind}</h3>
          <Row k="At">{src ? describeAnchor(src.at, short) : "with its boom"} <span className="sx-dim">{clock(f.at)}</span></Row>
          {src ? (
            <>
              <Row k="Kind"><Choice value={src.kind} options={FX_KINDS} onPick={(k) => edit((d, r) => setFx(d, r, sel.i, { kind: k }))} /></Row>
              <Row k="Length"><Num value={src.dur} step={0.05} min={0.02} suffix="s" onCommit={(v) => edit((d, r) => setFx(d, r, sel.i, { dur: v }))} /></Row>
              <Row k="Amount"><Num value={src.amount} step={0.01} onCommit={(v) => edit((d, r) => setFx(d, r, sel.i, { amount: v }))} /></Row>
            </>
          ) : <p className="sx-dim">A boom's punch-in. Drag it to move its boom; remove it to keep the boom still.</p>}
          <div className="chips" style={{ marginTop: 12 }}><ConfirmButton label="Remove" onConfirm={() => (edit((d, r) => removeFx(d, r, sel.i)), onSelect(null))} /></div>
        </div>
      );
    }
    case "sfx": {
      const x = short.sfx[sel.i];
      if (!x) return null;
      const m = "marker" in x.source ? x.source.marker : null;
      const pinned = "sfx" in x.source ? doc.sfx[x.source.sfx] : undefined;
      const line = m ? short.sentences.find((s) => s.key === m.sentence)?.text : undefined;
      return (
        <div className="sx-insp">
          <h3>Sound · {x.kind}</h3>
          <Row k="At">{pinned ? describeAnchor(pinned.at, short) : `[${x.kind}] in “${line?.slice(0, 40)}”`} <span className="sx-dim">{clock(x.at)}</span></Row>
          <Row k="Kind"><Choice value={x.kind === "file" ? undefined : x.kind} options={MARKERS} onPick={(k) => edit((d, r) => setSound(d, r, sel.i, { kind: k }))} /></Row>
          <Row k="Gain"><Num value={+x.gainDb.toFixed(1)} step={0.5} min={-60} max={12} suffix="dB" onCommit={(v) => v !== undefined && edit((d, r) => setSound(d, r, sel.i, { gainDb: v }))} /></Row>
          {x.kind === "boom" && <Row k="Punch-in"><button className={`toggle-chip${pinned?.punch !== false ? " on" : ""}`} onClick={() => edit((d, r) => setSound(d, r, sel.i, { punch: pinned?.punch === false }))}>{pinned?.punch !== false ? "on" : "off"}</button></Row>}
          {x.asset && <Row k="File">{x.asset}</Row>}
          <div className="chips" style={{ marginTop: 12 }}>
            <button className="btn small" onClick={pinHere((a) => (d, r) => moveSound(d, r, sel.i, a))}>Pin to playhead</button>
            <ConfirmButton label="Remove" onConfirm={() => (edit((d, r) => removeSound(d, r, sel.i)), onSelect(null))} />
          </div>
          {m && <p className="sx-dim" style={{ marginTop: 10 }}>A marker in the script; dragging or changing it pins it to the timeline.</p>}
        </div>
      );
    }
    case "music": {
      const m = short.music, src = doc.music;
      if (!m || !src) return null;
      return (
        <div className="sx-insp">
          <h3>Music</h3>
          {"synth" in src.source ? (
            <>
              <Row k="Score"><Choice value={src.source.synth.style} options={SYNTH_STYLES} onPick={(style) => edit((d) => setMusic(d, d.music && "synth" in d.music.source ? { ...d.music, source: { synth: { ...d.music.source.synth, style } } } : d.music))} /></Row>
              <Row k="Tempo"><Num value={src.source.synth.bpm} step={1} min={40} max={220} suffix="BPM" onCommit={(bpm) => bpm && edit((d) => setMusic(d, d.music && "synth" in d.music.source ? { ...d.music, source: { synth: { ...d.music.source.synth, bpm } } } : d.music))} /></Row>
              {"synth" in m.source && <><Row k="Lifts">{m.source.synth.lifts.map(clock).join(", ")}</Row><Row k="Drop">{clock(m.source.synth.drop)}</Row></>}
            </>
          ) : "file" in src.source && "file" in m.source ? (
            <>
              <Row k="Song">{src.source.file.asset.split("/").pop()}</Row>
              <Row k="Drop at"><Num value={src.source.file.dropAt} step={0.1} min={0} suffix="s into the song" onCommit={(v) => edit((d) => setMusic(d, d.music && "file" in d.music.source ? { ...d.music, source: { file: { ...d.music.source.file, dropAt: v, ...(v === undefined ? { align: undefined } : {}) } } } : d.music))} /></Row>
              <Row k="Lands on">
                <div className="sx-knob">
                  <span>{src.source.file.align ? describeAnchor(src.source.file.align, short) : "the start"}</span>
                  <button className="btn small ghost" disabled={src.source.file.dropAt === undefined} title={src.source.file.dropAt === undefined ? "say where the song's drop is first" : undefined} onClick={pinHere((a) => (d) => setMusic(d, d.music && "file" in d.music.source ? { ...d.music, source: { file: { ...d.music.source.file, align: a } } } : d.music))}>Pin to playhead</button>
                </div>
              </Row>
              <Row k="Starts at">{s3(m.source.file.offset)} into the song</Row>
              <Row k="Tempo"><Num value={src.source.file.bpm} step={1} min={40} max={220} suffix="BPM (for snapping to beats)" onCommit={(bpm) => edit((d) => setMusic(d, d.music && "file" in d.music.source ? { ...d.music, source: { file: { ...d.music.source.file, bpm } } } : d.music))} /></Row>
              <div className="chips" style={{ marginTop: 8 }}><button className="btn small" onClick={() => edit((d) => setMusic(d, { source: { synth: { style: "pad", bpm: 84 } }, gainDb: -17.7, duck: { depthDb: -9.1, hold: 1 } }))}>Back to the score</button></div>
            </>
          ) : null}
          <Row k="Gain"><Num value={+m.gainDb.toFixed(1)} step={0.5} min={-60} max={12} suffix="dB" onCommit={(v) => v !== undefined && edit((d) => setMusic(d, d.music ? { ...d.music, gainDb: v } : null))} /></Row>
          <Row k="Under voice"><Num value={+m.duck.depthDb.toFixed(1)} step={0.5} min={-60} max={0} suffix="dB" onCommit={(v) => v !== undefined && edit((d) => setMusic(d, d.music ? { ...d.music, duck: { ...d.music.duck, depthDb: v } } : null))} /></Row>
          {!media.music && "synth" in m.source && <p className="sx-dim">The score plays once it is rendered from the document.</p>}
        </div>
      );
    }
  }
}

/** A button that asks once more before it acts (the app's webview has no confirm dialog). */
function ConfirmButton({ label, onConfirm }: { label: string; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return <button className={`btn small${armed ? " danger" : ""}`} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}>{armed ? "Click again to remove" : label}</button>;
}
