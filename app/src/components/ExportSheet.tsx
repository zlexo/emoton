import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";
import { pickDirectory } from "../lib/native.ts";
import type { ExportFormat } from "../lib/types.ts";
import { IFolder, IX } from "./Icons.tsx";

const FORMATS: { id: ExportFormat; label: string; sub: string }[] = [
  { id: "mp4", label: "Video, 1080p", sub: "MP4 with chapter markers" },
  { id: "mp4-720", label: "Video, 720p", sub: "smaller file, same chapters" },
  { id: "m4a", label: "Audio only", sub: "M4A, podcast style, with chapters" },
  { id: "srt", label: "Captions", sub: "SRT, one line per sentence" },
  { id: "md", label: "Transcript", sub: "Markdown with source citations" },
  { id: "bundle", label: "Whole video bundle", sub: "zip of the .emoton folder" },
  { id: "slides-pdf", label: "Slides PDF", sub: "one page per slide, slides videos only" },
];

const LAST_DEST = "emoton-export-dest";
const LAST_FORMATS = "emoton-export-formats";
const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

export function ExportSheet({ target, onClose }: { target: { ids?: string[]; folder?: string }; onClose(): void }) {
  const { tree, toast } = useStore();
  const home = tree?.root.split("/").slice(0, 3).join("/") ?? "";
  const [formats, setFormats] = useState<ExportFormat[]>(() => load(LAST_FORMATS, ["mp4"] as ExportFormat[]));
  const [dest, setDest] = useState<string>(() => load(LAST_DEST, ""));
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (dest) return;
    // The server knows the real home folder.
    void api.listDir().then((r) => setDest((d) => d || `${r.dir}/Movies`)).catch(() => home && setDest(`${home}/Movies`));
  }, [dest, home]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const names = target.ids?.map((id) => tree?.videos.find((v) => v.id === id)?.title ?? id) ?? [];
  const what = target.folder !== undefined ? `the folder "${target.folder || "Library"}"` : names.length === 1 ? `"${names[0]}"` : `${names.length} videos`;
  const notReady = (target.ids ?? tree?.videos.filter((v) => target.folder !== undefined && (v.folder === target.folder || v.folder.startsWith(target.folder + "/"))).map((v) => v.id) ?? [])
    .filter((id) => tree?.videos.find((v) => v.id === id)?.status !== "ready").length;

  const choose = async () => {
    const r = await pickDirectory("Export to", dest);
    if (r === undefined) setBrowsing(true);
    else if (r) setDest(r);
  };
  const go = async () => {
    setBusy(true);
    save(LAST_DEST, dest);
    save(LAST_FORMATS, formats);
    try {
      await api.exportVideos({ ...(target.ids ? { videoIds: target.ids } : { folder: target.folder }), formats, dest });
      toast(`Exporting ${what}. It shows in Activity.`, "ok");
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ width: 560 }} role="dialog" aria-modal="true" aria-label="Export">
        <header>
          <h2>Export {what}</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IX /></button>
        </header>
        <div className="content">
          <div className="field">
            <span className="label">Formats</span>
            {FORMATS.map((f) => (
              <label key={f.id} className="check" style={{ padding: "3px 0" }}>
                <input type="checkbox" checked={formats.includes(f.id)} onChange={() => setFormats((x) => (x.includes(f.id) ? x.filter((y) => y !== f.id) : [...x, f.id]))} />
                <span style={{ color: "var(--text)" }}>{f.label}</span>
                <span style={{ color: "var(--faint)" }}>{f.sub}</span>
              </label>
            ))}
          </div>
          <div className="field">
            <span className="label">Save to</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" value={dest} onChange={(e) => setDest(e.target.value)} />
              <button className="btn" onClick={() => void choose()}><IFolder size={14} />Choose</button>
            </div>
            {target.folder !== undefined && <span style={{ color: "var(--faint)", fontSize: 12 }}>Each video gets its own subfolder.</span>}
          </div>
          {notReady > 0 && <div className="notice review"><div className="txt"><b>{notReady} not finished</b><span>Video, audio and captions need a finished video. {target.folder !== undefined ? "Folder export skips unfinished videos for those formats; the transcript and bundle still export." : "Choose the transcript or the bundle to export it now."}</span></div></div>}
          {browsing && <DirBrowser start={dest || home} onPick={(p) => (setDest(p), setBrowsing(false))} onClose={() => setBrowsing(false)} />}
        </div>
        <footer>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void go()} disabled={busy || !formats.length || !dest}>Export</button>
        </footer>
      </div>
    </div>
  );
}

/** Browser-only directory picker over /api/fs/list. */
function DirBrowser({ start, onPick, onClose }: { start: string; onPick(p: string): void; onClose(): void }) {
  const [dir, setDir] = useState(start);
  const [entries, setEntries] = useState<{ name: string; dir: boolean }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.listDir(dir).then((r) => (setEntries(r.entries.filter((e) => e.dir && !e.name.startsWith("."))), setErr(null))).catch((e: Error) => setErr(e.message));
  }, [dir]);
  const up = dir.split("/").slice(0, -1).join("/") || "/";
  return (
    <div className="section">
      <header style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn small" onClick={() => setDir(up)}>Up</button>
        <span style={{ fontWeight: 400, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis" }}>{dir}</span>
        <span className="spacer" />
        <button className="btn small primary" onClick={() => onPick(dir)}>Use this folder</button>
        <button className="btn small ghost" onClick={onClose}>Close</button>
      </header>
      <div style={{ maxHeight: 200, overflowY: "auto", padding: 4 }}>
        {err && <div className="errors" style={{ padding: 8 }}>{err}</div>}
        {entries.map((e) => (
          <button key={e.name} className="item" onClick={() => setDir(`${dir}/${e.name}`)}><IFolder />{e.name}</button>
        ))}
      </div>
    </div>
  );
}
