import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";
import { pickDirectory } from "../lib/native.ts";
import { useDraft } from "../lib/drafts.ts";
import type { Settings, VoiceOption } from "../lib/types.ts";
import { Listbox } from "../components/Listbox.tsx";
import { PronounceEditor } from "./video/Brief.tsx";
import { Grow } from "./video/Script.tsx";

export function SettingsPage() {
  const { settings } = useStore();
  if (!settings) return <main className="main" />;
  return <SettingsForm settings={settings} />;
}

function SettingsForm({ settings }: { settings: Settings }) {
  const { setSettings, toast, refreshLibrary } = useStore();
  const draft = useDraft<Settings>("settings", settings);
  const s = draft.value;
  const setS = (next: Settings) => draft.set(() => next);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => void api.voices().then(setVoices).catch(() => {}), []);
  const dirty = draft.dirty;
  const d = s.defaults;
  const setD = (patch: Partial<Settings["defaults"]>) => setS({ ...s, defaults: { ...d, ...patch } });

  const save = async () => {
    setSaving(true);
    try {
      const clean: Settings = {
        ...s,
        pronounce: Object.fromEntries(Object.entries(s.pronounce).filter(([k]) => k.trim())),
        stylePresets: s.stylePresets.filter((p) => p.name.trim()).map((p) => ({ ...p, rules: p.rules.map((r) => r.trim()).filter(Boolean) })),
      };
      const next = await api.saveSettings(clean);
      draft.discard();
      setSettings(next);
      if (next.libraryRoot !== settings.libraryRoot) await refreshLibrary();
      toast("Settings saved", "ok");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };
  const chooseRoot = async () => {
    const r = await pickDirectory("Library location", s.libraryRoot);
    if (r) setS({ ...s, libraryRoot: r });
    if (r === undefined) toast("Type the path in the field (folder picking works in the app).");
  };

  return (
    <main className="main">
      <div className="head"><h1>Settings</h1></div>
      <div className="page-body">
        <section className="section">
          <header>Library</header>
          <div className="rows">
            <div>
              <span className="k">Location</span>
              <span className="v"><input className="input" value={s.libraryRoot} onChange={(e) => setS({ ...s, libraryRoot: e.target.value })} /><button className="btn" onClick={() => void chooseRoot()}>Choose</button></span>
            </div>
          </div>
        </section>
        <section className="section">
          <header>New videos</header>
          <div className="rows">
            <div>
              <span className="k">Voice</span>
              <span className="v"><div style={{ flex: 1 }}><Listbox value={`${d.voice.engine}:${d.voice.voice}`} options={voices.map((v) => ({ value: `${v.engine}:${v.voice}`, label: v.label, sub: v.group }))}
                onChange={(v) => {
                  const [engine, voice] = v.split(":");
                  setD({ voice: { ...d.voice, engine: engine as "kokoro" | "say", voice: voice! } });
                }} /></div></span>
            </div>
            <div>
              <span className="k">Speaking speed</span>
              <span className="v slider"><input type="range" min={0.8} max={1.3} step={0.05} value={d.voice.speed} onChange={(e) => setD({ voice: { ...d.voice, speed: Number(e.target.value) } })} /><b>{d.voice.speed.toFixed(2)}×</b></span>
            </div>
            <div>
              <span className="k">Length</span>
              <span className="v slider"><input type="range" min={2} max={15} value={d.minutes} onChange={(e) => setD({ minutes: Number(e.target.value) })} /><b>{d.minutes} min</b></span>
            </div>
            <div><span className="k">Audience</span><span className="v"><input className="input" value={d.audience} onChange={(e) => setD({ audience: e.target.value })} /></span></div>
            <div>
              <span className="k">Writer</span>
              <span className="v"><div style={{ flex: 1 }}><Listbox value={d.writerModel} onChange={(v) => setD({ writerModel: v })} options={[{ value: "opus", label: "Opus", sub: "best scripts" }, { value: "sonnet", label: "Sonnet", sub: "faster" }]} /></div></span>
            </div>
            <div><span className="k">Captions</span><span className="v"><label className="check"><input type="checkbox" checked={d.captions} onChange={(e) => setD({ captions: e.target.checked })} />Burn captions into the video</label></span></div>
          </div>
        </section>
        <section className="section">
          <header>Making</header>
          <div className="rows">
            <div>
              <span className="k">Pause for outline review</span>
              <span className="v"><div style={{ flex: 1 }}><Listbox value={s.pauseAfterOutlineOverMinutes ?? -1} onChange={(v) => setS({ ...s, pauseAfterOutlineOverMinutes: v < 0 ? null : v })}
                options={[{ value: 0, label: "Always" }, { value: 3, label: "Longer than 3 minutes" }, { value: 6, label: "Longer than 6 minutes" }, { value: -1, label: "Never" }]} /></div></span>
            </div>
            <div>
              <span className="k">Render quality</span>
              <span className="v"><div style={{ flex: 1 }}><Listbox<Settings["renderQuality"]> value={s.renderQuality} onChange={(v) => setS({ ...s, renderQuality: v })}
                options={[{ value: "1080p", label: "1080p", sub: "sharp, slower" }, { value: "720p", label: "720p", sub: "draft, about twice as fast" }]} /></div></span>
            </div>
          </div>
        </section>
        <section className="section">
          <header>Pronunciation (every video)</header>
          <div style={{ padding: 16 }}><PronounceEditor value={s.pronounce} onChange={(v) => setS({ ...s, pronounce: v })} /></div>
        </section>
        <section className="section">
          <header>Style presets</header>
          <div className="rows">
            {s.stylePresets.map((p, i) => (
              <div key={i} style={{ alignItems: "flex-start" }}>
                <span className="k"><input className="input" value={p.name} onChange={(e) => setS({ ...s, stylePresets: s.stylePresets.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></span>
                <span className="v" style={{ alignItems: "flex-start" }}>
                  <Grow className="textarea" value={p.rules.join("\n")} onChange={(e) => setS({ ...s, stylePresets: s.stylePresets.map((x, j) => (j === i ? { ...x, rules: e.target.value.split("\n") } : x)) })} />
                  <button className="icon-btn" onClick={() => setS({ ...s, stylePresets: s.stylePresets.filter((_, j) => j !== i) })}>✕</button>
                </span>
              </div>
            ))}
            <div><button className="btn small" onClick={() => setS({ ...s, stylePresets: [...s.stylePresets, { name: "New preset", rules: [] }] })}>Add preset</button></div>
          </div>
        </section>
        {dirty && (
          <div className="savebar">
            <span className="txt">Unsaved settings</span>
            <button className="btn ghost" onClick={draft.discard}>Discard</button>
            <button className="btn primary" disabled={saving} onClick={() => void save()}>Save</button>
          </div>
        )}
      </div>
    </main>
  );
}
