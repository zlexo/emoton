import { useEffect, useState } from "react";
import type { Anchor, KnobValue, Short, ShotVisual } from "../../../../schema/short.ts";
import { setKnob, wordAt } from "../../../../src/core/short/edit.ts";
import type { ResolvedShort } from "../../../../src/core/short/resolve.ts";
import { api } from "../../lib/api.ts";
import type { PerdixTools, ShotState, StartCandidate } from "../../lib/types.ts";
import type { Edit } from "./useShortEditor.ts";

type Kinds = Awaited<ReturnType<typeof api.perdixKinds>>;
let kindsOnce: Promise<Kinds> | null = null;
const loadKinds = () => (kindsOnce ??= api.perdixKinds());

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="sx-row"><span>{k}</span><div>{children}</div></div>
);

/** Where a kind's start knobs are: a free walk's own, or Perdix's. */
const startKnobs = (kind: string) => (kind === "walk" ? ["WALK_X", "WALK_Z", "WALK_YAW"] : ["PERDIX_X", "PERDIX_Z", "PERDIX_YAW"]);

function NumField({ value, onCommit }: { value: number; onCommit(v: number): void }) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  return <input className="input sx-knob-num" inputMode="decimal" value={t} onChange={(e) => setT(e.target.value)} onBlur={() => Number.isFinite(Number(t)) && Number(t) !== value && onCommit(Number(t))} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />;
}

/**
 * A Perdix shot's settings: its render (ready, rendering, or no tool for its
 * build), every knob its kind has (from sources/perdix/kinds.json: set ones
 * editable, the rest a click away), cues pinned to the playhead's word, Find a
 * start for walking shots, and the build it renders at.
 */
export function ShotPanel({ id, scene, v, short, state, now, busy, edit, onError, describe }: {
  id: string; scene: string; v: ShotVisual; short: ResolvedShort; state: ShotState | undefined; now: number; busy: boolean;
  edit(e: Edit): void; onError(m: string): void; describe(a: Anchor): string;
}) {
  const [kinds, setKinds] = useState<Kinds | null>(null);
  const [tools, setTools] = useState<PerdixTools | null>(null);
  const [found, setFound] = useState<StartCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => void loadKinds().then(setKinds).catch(() => {}), []);
  useEffect(() => void api.perdixTools().then(setTools).catch(() => {}), [busy]);
  const spec = kinds?.kinds[v.kind];
  const resolved = short.shots.find((x) => x.scene === scene);
  const set = (k: string, val: KnobValue | undefined) => edit((d) => setKnob(d, scene, k, val));
  const here = (): Anchor => wordAt(short, now) ?? { t: +now.toFixed(3) };
  const search = Object.entries(kinds?.searches ?? {}).find(([, s]) => s.for.includes(v.kind));
  const unset = Object.entries(spec?.knobs ?? {}).filter(([k]) => !(k in v.knobs));
  const building = tools?.building[tools.main ?? ""];
  const renderText = !state ? "" : state.state === "ready" ? `ready, ${resolved?.seconds.toFixed(2)} s` : state.state === "no-tool" ? `no shot tool built at Perdix ${v.build}` : busy ? "rendering in the background; the old take plays until then" : "renders in the background";

  const find = async () => {
    setSearching(true);
    setFound(null);
    try {
      setFound(await api.searchShotStarts(id, scene));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <Row k="Shot">{v.kind}{spec ? <span className="sx-dim"> · {spec.about}</span> : null}</Row>
      <Row k="Render"><span className={state?.state === "ready" ? "" : "sx-pause"}>{renderText}</span></Row>
      <h4>Knobs</h4>
      {Object.entries(v.knobs).map(([k, val]) => {
        const s = spec?.knobs[k];
        return (
          <Row key={k} k={k}>
            <div className="sx-knob">
              {typeof val === "object" ? (
                <span>{describe(val)} <span className="sx-dim">= {resolved?.knobs[k]} s</span></span>
              ) : typeof val === "boolean" || s?.switch ? (
                <button className={`toggle-chip${val === true || val === 1 ? " on" : ""}`} onClick={() => set(k, val === true || val === 1 ? 0 : 1)}>{val === true || val === 1 ? "on" : "off"}</button>
              ) : typeof val === "number" ? (
                <span><NumField value={val} onCommit={(x) => set(k, x)} />{s?.unit ? <span className="sx-dim"> {s.unit}</span> : null}</span>
              ) : <span>{String(val)}</span>}
              <span className="chips">
                {(s?.time || typeof val === "object") && <button className="btn small ghost" title="pin to the word at the playhead" onClick={() => set(k, here())}>Pin to playhead</button>}
                {typeof val === "object" && resolved && <button className="btn small ghost" title="a fixed time instead" onClick={() => set(k, Number(resolved.knobs[k]))}>Unpin</button>}
                <button className="btn small ghost" title={s ? `back to the default (${s.default})` : "remove"} onClick={() => set(k, undefined)}>×</button>
              </span>
            </div>
          </Row>
        );
      })}
      {unset.length > 0 && (
        <details className="sx-more">
          <summary>{unset.length} more knobs</summary>
          <div className="chips">
            {unset.map(([k, s]) => <button key={k} className="btn small ghost" title={`${s.about ?? ""} default ${s.default}${s.unit ? ` ${s.unit}` : ""}`} onClick={() => set(k, s.switch ? s.default : s.default)}>{k}</button>)}
          </div>
        </details>
      )}
      {search && (
        <>
          <h4>Start</h4>
          <div className="chips"><button className="btn small" disabled={searching} onClick={() => void find()}>{searching ? "Searching…" : "Find a start"}</button></div>
          <p className="sx-dim">{search[1].about} ({v.kind === "perdix-life" ? "over this shot, from where he starts" : "in this shot's area"}).</p>
          {found && found.length === 0 && <p className="sx-dim">Nothing found in this area: widen CX0 to CZ1.</p>}
          {found?.map((c, i) => (
            <div key={i} className="sx-pop-row">
              {"seed" in c
                ? <span style={{ flex: 1 }}>seed {c.seed} <span className="sx-dim">{c.note}</span></span>
                : <span style={{ flex: 1 }}>x {c.x}, z {c.z}, {c.yaw.toFixed(2)} rad <span className="sx-dim">{c.note}</span></span>}
              <button className="btn small ghost" onClick={() => {
                if ("seed" in c) return edit((d) => setKnob(d, scene, "SEED", c.seed));
                const [kx, kz, ky] = startKnobs(v.kind);
                edit((d) => setKnob(setKnob(setKnob(d, scene, kx!, c.x), scene, kz!, c.z), scene, ky!, c.yaw));
              }}>Use</button>
            </div>
          ))}
        </>
      )}
      <h4>Perdix build</h4>
      <Row k="Build">
        <div className="sx-knob">
          <span>{v.build}{tools?.behind[v.build] ? <span className="sx-dim"> · main is {tools.behind[v.build]} commits ahead</span> : null}</span>
          {tools?.main && tools.main !== v.build && (
            tools.built.includes(tools.main)
              ? <button className="btn small ghost" onClick={() => edit((d: Short) => ({ ...d, scenes: d.scenes.map((x) => (x.visual?.type === "shot" ? { ...x, visual: { ...x.visual, build: tools.main! } } : x)) }))}>Use {tools.main} for every shot</button>
              : <button className="btn small ghost" disabled={building?.state === "building"} onClick={() => void api.buildPerdixTool("main").then(setTools).catch((e: Error) => onError(e.message))}>{building?.state === "building" ? "Building…" : "Rebuild at main"}</button>
          )}
        </div>
      </Row>
      {building && <p className={building.state === "failed" ? "sx-warn" : "sx-dim"}>{building.state === "failed" ? `The build failed: ${building.log}` : building.log || "Building Perdix and the shot tool (a few minutes)…"}</p>}
    </>
  );
}
