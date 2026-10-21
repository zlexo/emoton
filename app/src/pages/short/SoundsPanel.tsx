import { useEffect, useMemo, useRef, useState } from "react";
import { MARKERS, type Marker, type Short } from "../../../../schema/short.ts";
import { addSound, setMusic, wordAt } from "../../../../src/core/short/edit.ts";
import type { ResolvedShort } from "../../../../src/core/short/resolve.ts";
import { api } from "../../lib/api.ts";
import { reveal } from "../../lib/native.ts";
import type { SoundLibrary } from "../../lib/types.ts";
import type { Edit } from "./useShortEditor.ts";

const isMarker = (c: string): c is Marker => (MARKERS as readonly string[]).includes(c);

/**
 * The sound effects library (a folder of downloaded sounds) in the editor:
 * listen to any sound, make one the sound every [boom] (or other marker)
 * plays, place one at the playhead, or use a song as the soundtrack. A sound
 * used is copied into the Short first.
 */
export function SoundsPanel({ id, doc, short, now, edit, onError }: {
  id: string; doc: Short; short: ResolvedShort; now: number; edit(e: Edit): void; onError(m: string): void;
}) {
  const [lib, setLib] = useState<SoundLibrary | null>(null);
  const [q, setQ] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const load = () => void api.sounds().then(setLib).catch((e: Error) => onError(e.message));
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const m = new Map<string, SoundLibrary["sounds"]>();
    for (const s of lib?.sounds ?? []) {
      if (q && !`${s.category} ${s.name}`.toLowerCase().includes(q.toLowerCase())) continue;
      const k = s.category || "other";
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.entries()];
  }, [lib, q]);

  const listen = (path: string) => {
    const a = audio.current;
    if (!a) return;
    if (playing === path) return (a.pause(), setPlaying(null));
    a.src = `/api/sounds/file?path=${encodeURIComponent(path)}`;
    void a.play();
    setPlaying(path);
  };
  const use = async (path: string, then: (asset: string) => Edit) => {
    try {
      const { asset } = await api.importSound(id, path);
      edit(then(asset));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const kit = doc.soundKit ?? {};
  const kitEntries = Object.entries(kit).filter(([, v]) => v) as [Marker, string][];

  return (
    <div className="sx-sounds">
      <audio ref={audio} onEnded={() => setPlaying(null)} />
      <div className="sx-sounds-head">
        <span className="sx-dim" title={lib?.root}>{lib ? lib.root.replace(/^\/Users\/[^/]+/, "~") : "…"}</span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={load}>Refresh</button>
        {lib && <button className="btn small ghost" onClick={() => void reveal(lib.root).then((ok) => ok || onError(`The sound library is ${lib.root}`))}>Open folder</button>}
      </div>
      {kitEntries.length > 0 && (
        <div className="sx-kit">
          <h4>This Short's kit</h4>
          {kitEntries.map(([k, v]) => (
            <div key={k} className="sx-sound">
              <span className={`sx-mark m-${k}`}>{k}</span>
              <span className="sx-sound-name">{v.split("/").pop()}</span>
              <button className="btn small ghost" title="play the built-in sound again" onClick={() => edit((d) => ({ ...d, soundKit: Object.fromEntries(Object.entries(d.soundKit ?? {}).filter(([kk]) => kk !== k)) }))}>Built-in</button>
            </div>
          ))}
        </div>
      )}
      <input className="input" placeholder="Search sounds" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: "8px 0" }} />
      {lib && lib.sounds.length === 0 && (
        <p className="sx-dim">The library is empty. Drop downloaded sounds into its folders (boom, whoosh, songs…), then Refresh.</p>
      )}
      {groups.map(([cat, list]) => (
        <div key={cat} className="sx-sound-group">
          <h4>{cat}</h4>
          {list.map((s) => (
            <div key={s.path} className="sx-sound">
              <button className={`btn small ghost sx-play${playing === s.path ? " on" : ""}`} onClick={() => listen(s.path)}>{playing === s.path ? "■" : "▶"}</button>
              <span className="sx-sound-name" title={s.path}>{s.name}</span>
              {cat === "songs" ? (
                <button className="btn small ghost" onClick={() => void use(s.path, (asset) => (d) => setMusic(d, { source: { file: { asset } }, gainDb: -14, duck: { depthDb: -10, hold: 0.4 } }))}>Use as music</button>
              ) : (
                <>
                  {isMarker(cat) && kit[cat] !== `assets/sounds/${cat}-${s.path.split("/").pop()}` && (
                    <button className="btn small ghost" title={`every [${cat}] in this Short plays it`} onClick={() => void use(s.path, (asset) => (d) => ({ ...d, soundKit: { ...d.soundKit, [cat]: asset } }))}>Every {cat}</button>
                  )}
                  <button className="btn small ghost" title="place it once, at the playhead's word" onClick={() => void use(s.path, (asset) => (d) => addSound(d, { kind: "file", asset, at: wordAt(short, now) ?? { t: +now.toFixed(3) } }))}>At playhead</button>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
