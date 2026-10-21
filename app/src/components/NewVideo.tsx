import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { go } from "../lib/route.ts";
import { useStore } from "../lib/store.tsx";
import { inApp, onFileDrop, pickSourceFiles } from "../lib/native.ts";
import type { CreateMode, FolderNode, Voice, VoiceOption } from "../lib/types.ts";
import { Listbox } from "./Listbox.tsx";
import { IDoc, ILink, ISpeaker, IX } from "./Icons.tsx";

type Src = { key: string; label: string; path?: string; file?: File; url?: string };

export function flatFolders(root: FolderNode | undefined): { value: string; label: string }[] {
  const out = [{ value: "", label: "Library (top level)" }];
  const walk = (n: FolderNode, d: number) => n.folders.forEach((f) => (out.push({ value: f.path, label: `${"   ".repeat(d)}${f.name}` }), walk(f, d + 1)));
  if (root) walk(root, 0);
  return out;
}

const base = (p: string) => p.split("/").pop() ?? p;
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());

export function NewVideo({ initial, onClose }: { initial: { folder?: string; paths?: string[] }; onClose(): void }) {
  const { tree, settings, toast, refreshLibrary } = useStore();
  const d = settings?.defaults;
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState(initial.folder ?? "");
  const [minutes, setMinutes] = useState(d?.minutes ?? 5);
  const touched = useRef({ minutes: false, audience: false, voice: false });
  const [audience, setAudience] = useState(d?.audience ?? "");
  const [voice, setVoice] = useState<Voice>(d?.voice ?? { engine: "kokoro", voice: "af_heart", speed: 1 });
  const [presets, setPresets] = useState<string[]>([]);
  const [rules, setRules] = useState("");
  const [sources, setSources] = useState<Src[]>(() => (initial.paths ?? []).map((p) => ({ key: p, label: base(p), path: p })));
  const [url, setUrl] = useState("");
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<CreateMode | null>(null);
  const [more, setMore] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sampling, setSampling] = useState(false);

  useEffect(() => void api.voices().then(setVoices).catch(() => {}), []);
  useEffect(() => {
    if (!d) return;
    if (!touched.current.minutes) setMinutes(d.minutes);
    if (!touched.current.audience) setAudience(d.audience);
    setVoice((v) => (touched.current.voice ? v : d.voice));
  }, [d]);
  const sampleRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  useEffect(() => () => {
    sampleRef.current?.audio.pause();
    if (sampleRef.current) URL.revokeObjectURL(sampleRef.current.url);
  }, []);
  useEffect(() => onFileDrop((paths) => addPaths(paths), setOver), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && !hasWork() && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose, topic, sources]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasWork = () => topic.trim().length > 0 || sources.length > 0;
  const addPaths = (paths: string[]) =>
    setSources((s) => [...s, ...paths.filter((p) => !s.some((x) => x.path === p)).map((p) => ({ key: p, label: base(p), path: p }))]);
  const addFiles = (files: FileList | File[]) =>
    setSources((s) => [...s, ...[...files].map((f) => ({ key: `${f.name}-${f.size}`, label: f.name, file: f }))]);
  const addUrl = (u: string) => {
    if (!isUrl(u)) return false;
    setSources((s) => (s.some((x) => x.url === u.trim()) ? s : [...s, { key: u.trim(), label: u.trim().replace(/^https?:\/\/(www\.)?/, ""), url: u.trim() }]));
    setUrl("");
    return true;
  };
  const pick = async () => {
    const paths = await pickSourceFiles();
    if (paths === null) fileInput.current?.click();
    else addPaths(paths);
  };

  const folderOptions = useMemo(() => flatFolders(tree?.tree), [tree]);
  const voiceOptions = voices.map((v) => ({ value: `${v.engine}:${v.voice}`, label: v.label, sub: v.group }));
  const allRules = [...(settings?.stylePresets.filter((p) => presets.includes(p.name)).flatMap((p) => p.rules) ?? []), ...rules.split("\n").map((r) => r.trim()).filter(Boolean)];

  const sample = async () => {
    setSampling(true);
    try {
      const blob = await api.voiceSample(voice, "One thread can serve many clients, as long as it never waits on any one of them.");
      if (sampleRef.current) (sampleRef.current.audio.pause(), URL.revokeObjectURL(sampleRef.current.url));
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      sampleRef.current = { audio: a, url };
      a.onended = () => setSampling(false);
      await a.play();
    } catch (e) {
      toast((e as Error).message, "error");
      setSampling(false);
    }
  };

  const create = async (mode: CreateMode) => {
    if (topic.trim().length < 8) return toast("Say what you want explained first.", "error");
    setBusy(mode);
    try {
      const pending = url.trim();
      const urls = [...sources.filter((s) => s.url).map((s) => s.url!), ...(isUrl(pending) ? [pending.trim()] : [])];
      const detail = await api.createVideo(
        {
          folder,
          mode,
          brief: {
            topic: topic.trim(), ...(title.trim() ? { title: title.trim() } : {}), minutes, audience: audience.trim() || undefined,
            voice, rules: allRules,
          } as never,
          sourcePaths: sources.filter((s) => s.path).map((s) => s.path!),
          urls,
        },
        sources.filter((s) => s.file).map((s) => s.file!),
      );
      await refreshLibrary();
      onClose();
      go({ name: "video", id: detail.summary.id, tab: "watch" });
      toast(mode === "draft" ? "Saved as a draft" : mode === "outline-first" ? "Writing the outline" : "Making your video", "ok");
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(null);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && !hasWork() && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New video">
        <header>
          <h2>New video</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IX /></button>
        </header>
        <div className="content">
          <textarea className="textarea topic" autoFocus placeholder="What do you want explained?" value={topic} onChange={(e) => setTopic(e.target.value)} />

          <div
            className={`drop${over ? " over" : ""}`}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) (e.preventDefault(), setOver(true));
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (!inApp() && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
              const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
              if (text) addUrl(text.split("\n")[0]!);
            }}
          >
            <div className="hint">
              <IDoc /> Drop PDFs or notes here, or
              <button className="btn small" onClick={() => void pick()}>Choose files</button>
              <span style={{ flex: 1 }} />
              <label className="search" style={{ flex: "0 1 300px", height: 28 }}>
                <ILink size={13} />
                <input placeholder="Paste a link or YouTube URL" value={url} onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (addUrl(url) || toast("That is not a link", "error"))}
                  onPaste={(e) => {
                    const t = e.clipboardData.getData("text");
                    if (addUrl(t)) e.preventDefault();
                  }} />
              </label>
            </div>
            {sources.length > 0 && (
              <div className="files">
                {sources.map((s) => (
                  <span key={s.key} className="file" title={s.path ?? s.url ?? s.label}>
                    {s.url ? <ILink size={12} /> : <IDoc size={12} />}
                    <span>{s.label}</span>
                    <button onClick={() => setSources((x) => x.filter((y) => y.key !== s.key))} aria-label="Remove"><IX size={10} /></button>
                  </span>
                ))}
              </div>
            )}
            {sources.length === 0 && <div style={{ color: "var(--faint)", fontSize: 12 }}>No sources: the writer will use what it knows. Sources make every claim traceable.</div>}
            <input ref={fileInput} type="file" multiple accept=".pdf,.md,.txt,.markdown" hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </div>

          <div className="row">
            <div className="field">
              <label>Length</label>
              <div className="slider">
                <input type="range" min={2} max={15} value={minutes} onChange={(e) => ((touched.current.minutes = true), setMinutes(Number(e.target.value)))} />
                <b>{minutes} min</b>
              </div>
            </div>
            <div className="field">
              <label>Voice</label>
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <Listbox value={`${voice.engine}:${voice.voice}`} options={voiceOptions.length ? voiceOptions : [{ value: `${voice.engine}:${voice.voice}`, label: voice.voice }]}
                    onChange={(v) => {
                      const [engine, name] = v.split(":");
                      touched.current.voice = true;
                      setVoice({ engine: engine as Voice["engine"], voice: name!, speed: voice.speed });
                    }} />
                </div>
                <button className="btn" onClick={() => void sample()} disabled={sampling} title="Play a sample"><ISpeaker size={14} />{sampling ? "Playing" : "Hear it"}</button>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="field">
              <label>Who is it for</label>
              <input className="input" value={audience} onChange={(e) => ((touched.current.audience = true), setAudience(e.target.value))} placeholder="A second-year CS student who knows C" />
            </div>
            <div className="field">
              <label>Folder</label>
              <Listbox value={folder} options={folderOptions} onChange={setFolder} />
            </div>
          </div>

          <div className="field">
            <label>Style</label>
            <div className="chips">
              {settings?.stylePresets.map((p) => (
                <button key={p.name} className={`toggle-chip${presets.includes(p.name) ? " on" : ""}`} title={p.rules.join("\n")}
                  onClick={() => setPresets((x) => (x.includes(p.name) ? x.filter((n) => n !== p.name) : [...x, p.name]))}>
                  {p.name}
                </button>
              ))}
              <button className="toggle-chip" onClick={() => setMore((m) => !m)}>{more ? "Fewer options" : "More options"}</button>
            </div>
          </div>
          {more && (
            <div className="row">
              <div className="field">
                <label>Title (optional, the outline names it otherwise)</label>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="field">
                <label>Extra rules, one per line</label>
                <textarea className="textarea" value={rules} onChange={(e) => setRules(e.target.value)} placeholder="Contrast with the thread-pool design" />
              </div>
            </div>
          )}
        </div>
        <footer>
          <button className="btn ghost" onClick={() => void create("draft")} disabled={!!busy}>Save as draft</button>
          <span className="spacer" />
          <button className="btn" onClick={() => void create("outline-first")} disabled={!!busy}>{busy === "outline-first" ? "Starting…" : "Outline first"}</button>
          <button className="btn primary" onClick={() => void create("make")} disabled={!!busy}>{busy === "make" ? "Starting…" : "Make it"}</button>
        </footer>
      </div>
    </div>
  );
}
