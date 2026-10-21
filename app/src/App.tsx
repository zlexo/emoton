import { useCallback, useEffect, useState } from "react";
import { TITLEBAR } from "../../shared/native.ts";
import { StoreProvider, useStore } from "./lib/store.tsx";
import { go, useRoute } from "./lib/route.ts";
import { inApp, onFileDrop, onMenu } from "./lib/native.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Activity } from "./components/Activity.tsx";
import { NewVideo } from "./components/NewVideo.tsx";
import { ExportSheet } from "./components/ExportSheet.tsx";
import { LibraryPage } from "./pages/Library.tsx";
import { VideoPage } from "./pages/Video.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { DoctorPage } from "./pages/Doctor.tsx";
import { NewShortPage } from "./pages/NewShort.tsx";
import { IPlus, ISearch } from "./components/Icons.tsx";
import { folderName } from "./lib/format.ts";
import { api } from "./lib/api.ts";

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

export type Sheets = {
  newVideo(opts?: { folder?: string; paths?: string[] }): void;
  exportVideos(opts: { ids?: string[]; folder?: string }): void;
  newFolder(parent: string): void;
};

function Shell() {
  const route = useRoute();
  const { jobs, connected, toasts, dismiss, toast, refreshLibrary, doctor, refreshDoctor } = useStore();
  const login = doctor?.find((c) => c.id === "claude-login" && c.level === "error");
  const [query, setQuery] = useState("");
  const [activity, setActivity] = useState(false);
  const [newVideo, setNewVideo] = useState<{ folder?: string; paths?: string[] } | null>(null);
  const [exporting, setExporting] = useState<{ ids?: string[]; folder?: string } | null>(null);
  const [fileHover, setFileHover] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  const currentFolder = route.name === "library" ? route.folder ?? "" : "";

  const newFolder = useCallback(async (parent: string) => {
    try {
      const { path } = await api.createFolder(parent, "New folder");
      await refreshLibrary();
      go({ name: "library", folder: path });
      setRenaming(path);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [refreshLibrary, toast]);

  const sheets: Sheets = {
    newVideo: (o) => setNewVideo(o ?? { folder: currentFolder }),
    exportVideos: (o) => setExporting(o),
    newFolder: (p) => void newFolder(p),
  };

  useEffect(() => onMenu((a) => {
    if (a === "new-video") setNewVideo({ folder: currentFolder });
    if (a === "new-folder") void newFolder(currentFolder);
    if (a === "find") document.getElementById("search")?.focus();
    if (a === "view-library") go({ name: "library", folder: null });
    if (a === "view-activity") setActivity((x) => !x);
    if (a === "settings") go({ name: "settings" });
    if (a === "doctor") go({ name: "doctor" });
    if (a === "export") {
      if (route.name === "video") setExporting({ ids: [route.id] });
      else if (route.name === "library" && route.folder) setExporting({ folder: route.folder });
      else toast("Open a video or a folder to export it.");
    }
  }), [currentFolder, newFolder, route, toast]);

  // Browser shortcuts (the app menu sends the same actions natively).
  useEffect(() => {
    if (inApp()) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const search = document.getElementById("search");
      if ((e.key === "k" || e.key === "f") && search) (e.preventDefault(), search.focus());
      if (e.key === "n" && !e.shiftKey) (e.preventDefault(), setNewVideo({ folder: currentFolder }));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [currentFolder]);

  // In a browser, a file dropped outside a drop zone would replace the page.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files") && !(e.target as HTMLElement).closest?.(".drop")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  // Files dropped from Finder anywhere (outside the New Video sheet) start a new video.
  useEffect(() => onFileDrop((paths) => {
    if (!newVideo && paths.length) setNewVideo({ folder: currentFolder, paths });
  }, (over) => setFileHover(over && !newVideo)), [currentFolder, newVideo]);

  const inset = inApp() ? TITLEBAR.leftInset : 16;
  return (
    <div className="shell">
      <div className="bar" data-tauri-drag-region style={{ ["--bar-inset" as string]: `${inset}px` }}>
        <button className="brand" onClick={() => go({ name: "library", folder: null })} data-tauri-drag-region>
          emot<b>o</b>n
        </button>
        {route.name === "library" && (
          <label className="search">
            <ISearch size={14} />
            <input id="search" placeholder={`Search ${route.folder ? folderName(route.folder) : "all videos"}`} value={query} onChange={(e) => setQuery(e.target.value)} />
            <kbd>⌘F</kbd>
          </label>
        )}
        <div className="spacer" data-tauri-drag-region />
        {!connected && <span className="offline"><span className="dot warn" />Reconnecting to the server</span>}
        <button className="btn ghost" onClick={() => setActivity((a) => !a)}>
          Activity {running > 0 && <span className="badge">{running}</span>}
        </button>
        {route.name !== "video" && route.name !== "new-short" && (
          <button className="btn" onClick={() => go({ name: "new-short", folder: currentFolder })}>
            <IPlus size={13} /> New Short
          </button>
        )}
        {route.name !== "video" && route.name !== "new-short" && (
          <button className="btn primary" onClick={() => setNewVideo({ folder: currentFolder })}>
            <IPlus size={13} /> New video
          </button>
        )}
      </div>
      {login && (
        <div className="notice review" style={{ borderRadius: 0, borderWidth: "0 0 1px 0" }}>
          <div className="txt">
            <b>The writer needs you to log in once</b>
            <span>Run this in a terminal, then press Recheck: <code style={{ userSelect: "text" }}>{login.fix ?? "claude auth login"}</code></span>
          </div>
          <button className="btn" onClick={() => void refreshDoctor()}>Recheck</button>
        </div>
      )}
      <div className="body">
        {route.name !== "video" && route.name !== "new-short" && <Sidebar route={route} sheets={sheets} renaming={renaming} setRenaming={setRenaming} />}
        {route.name === "library" && <LibraryPage key={`${route.folder}:${route.recent ? "r" : ""}`} route={route} query={query} sheets={sheets} />}
        {route.name === "video" && <VideoPage route={route} sheets={sheets} />}
        {route.name === "new-short" && <NewShortPage key={route.folder} folder={route.folder} />}
        {route.name === "settings" && <SettingsPage />}
        {route.name === "doctor" && <DoctorPage />}
        {activity && <Activity onClose={() => setActivity(false)} />}
      </div>
      {newVideo && <NewVideo initial={newVideo} onClose={() => setNewVideo(null)} />}
      {exporting && <ExportSheet target={exporting} onClose={() => setExporting(null)} />}
      {fileHover && <div className="filedrop">Drop to make a new video</div>}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span>{t.text}</span>
            {t.action && <button onClick={() => (t.action!.run(), dismiss(t.id))}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
