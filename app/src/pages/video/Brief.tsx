import { useEffect, useRef, useState } from "react";
import { useDraft } from "../../lib/drafts.ts";
import { api } from "../../lib/api.ts";
import { useStore } from "../../lib/store.tsx";
import type { Brief, VideoDetail, VoiceOption } from "../../lib/types.ts";
import { Listbox } from "../../components/Listbox.tsx";
import { Grow } from "./Script.tsx";

export function PronounceEditor({ value, onChange }: { value: Record<string, string>; onChange(v: Record<string, string>): void }) {
  // Rows are local so an empty or duplicate word stays visible while it is typed.
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));
  const lastOut = useRef(JSON.stringify(value));
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming !== lastOut.current) setRows(Object.entries(value));
  }, [value]);
  const commit = (next: [string, string][]) => {
    setRows(next);
    const obj = Object.fromEntries(next.filter(([k]) => k.trim()));
    lastOut.current = JSON.stringify(obj);
    onChange(obj);
  };
  return (
    <div className="kv">
      <span className="label">Written</span><span className="label">Said as</span><span />
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <input className="input" aria-label="Word as written" value={k} onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value, v] : r)))} />
          <input className="input" aria-label="Said as" value={v} onChange={(e) => commit(rows.map((r, j) => (j === i ? [k, e.target.value] : r)))} />
          <button className="icon-btn" aria-label="Remove word" onClick={() => commit(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn small" style={{ gridColumn: "1 / 2", justifySelf: "start" }} onClick={() => setRows([...rows, ["", ""]])}>Add word</button>
    </div>
  );
}

export function BriefTab({ video, onSaved }: { video: VideoDetail; onSaved(): void }) {
  const { toast } = useStore();
  const d = useDraft<Brief>(`${video.summary.id}:brief`, video.brief);
  const b = d.value;
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => void api.voices().then(setVoices).catch(() => {}), []);
  const dirty = d.dirty;
  const put = <K extends keyof Brief>(k: K, v: Brief[K]) => d.set((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const clean = { ...b, rules: b.rules.map((r) => r.trim()).filter(Boolean), pronounce: Object.fromEntries(Object.entries(b.pronounce).filter(([k]) => k.trim())) };
      await api.updateBrief(video.summary.id, clean);
      d.discard();
      onSaved();
      toast("Brief saved. Update the video to apply it.", "ok");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor" style={{ maxWidth: 820 }}>
      <div className="field"><label>Title</label><input className="input" value={b.title} onChange={(e) => put("title", e.target.value)} /></div>
      <div className="field"><label>What it explains</label><Grow className="textarea" value={b.topic} onChange={(e) => put("topic", e.target.value)} /></div>
      <div className="field"><label>Who it is for</label><input className="input" value={b.audience} onChange={(e) => put("audience", e.target.value)} /></div>
      <div className="row">
        <div className="field">
          <label>Length</label>
          <div className="slider"><input type="range" min={2} max={15} value={b.minutes} onChange={(e) => put("minutes", Number(e.target.value))} /><b>{b.minutes} min</b></div>
        </div>
        <div className="field">
          <label>Writer</label>
          <Listbox value={b.writerModel} onChange={(v) => put("writerModel", v)} options={[
            { value: "opus", label: "Opus", sub: "best scripts" }, { value: "sonnet", label: "Sonnet", sub: "faster" },
          ]} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Voice</label>
          <Listbox value={`${b.voice.engine}:${b.voice.voice}`} options={voices.map((v) => ({ value: `${v.engine}:${v.voice}`, label: v.label, sub: v.group }))}
            onChange={(v) => {
              const [engine, voice] = v.split(":");
              put("voice", { ...b.voice, engine: engine as Brief["voice"]["engine"], voice: voice! });
            }} />
        </div>
        <div className="field">
          <label>Speaking speed</label>
          <div className="slider"><input type="range" min={0.8} max={1.3} step={0.05} value={b.voice.speed} onChange={(e) => put("voice", { ...b.voice, speed: Number(e.target.value) })} /><b>{b.voice.speed.toFixed(2)}×</b></div>
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>Layout</label>
          <Listbox value={b.layout} onChange={(v) => put("layout", v)} options={[
            { value: "slides" as const, label: "Slides", sub: "slides to follow, animations in a panel" },
            { value: "stage" as const, label: "Stage", sub: "full-screen animations" },
          ]} />
        </div>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <label className="check"><input type="checkbox" checked={b.captions} onChange={(e) => put("captions", e.target.checked)} />Captions in the video</label>
        </div>
      </div>
      <div className="field">
        <label>Rules for the writer, one per line</label>
        <Grow className="textarea" value={b.rules.join("\n")} onChange={(e) => put("rules", e.target.value.split("\n"))} />
      </div>
      <div className="field">
        <label>Pronunciation (this video, on top of the global list in Settings)</label>
        <PronounceEditor value={b.pronounce} onChange={(v) => put("pronounce", v)} />
      </div>
      {dirty && (
        <div className="savebar">
          <span className="txt">Changing the topic, audience, length, rules or writer rewrites the outline; the layout rewrites the storyboard; voice and pronunciation only re-voice.</span>
          <button className="btn ghost" onClick={d.discard}>Discard</button>
          <button className="btn primary" disabled={saving} onClick={() => void save()}>Save</button>
        </div>
      )}
    </div>
  );
}
