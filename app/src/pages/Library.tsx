import { useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { go, type Route } from "../lib/route.ts";
import { useStore } from "../lib/store.tsx";
import { folderName } from "../lib/format.ts";
import { reveal } from "../lib/native.ts";
import type { FolderNode, VideoSummary } from "../lib/types.ts";
import type { Sheets } from "../App.tsx";
import { VideoCard } from "../components/VideoCard.tsx";
import { FolderPicker } from "../components/FolderPicker.tsx";
import { Listbox } from "../components/Listbox.tsx";
import { useFolderDrop } from "../components/Sidebar.tsx";
import { IFolder } from "../components/Icons.tsx";

type Sort = "updated" | "created" | "title" | "length";

export function LibraryPage({ route, query, sheets }: { route: Extract<Route, { name: "library" }>; query: string; sheets: Sheets }) {
  const { tree, toast, refreshLibrary } = useStore();
  const [sort, setSort] = useState<Sort>("updated");
  const [selected, setSelected] = useState<string[]>([]);
  const [moving, setMoving] = useState<string[] | null>(null);
  const folder = route.folder;

  const node = useMemo(() => {
    if (!tree || folder === null) return null;
    const find = (n: FolderNode): FolderNode | null => (n.path === folder ? n : n.folders.map(find).find(Boolean) ?? null);
    return find(tree.tree);
  }, [tree, folder]);

  const videos = useMemo(() => {
    if (!tree) return [];
    let list = tree.videos;
    if (route.recent) list = [...list].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 24);
    else if (folder !== null) list = list.filter((v) => v.folder === folder);
    const q = query.trim().toLowerCase();
    if (q) {
      // Search reaches into subfolders.
      const base = folder === null || route.recent ? tree.videos : tree.videos.filter((v) => v.folder === folder || v.folder.startsWith(folder + "/"));
      list = base.filter((v) => `${v.title} ${v.folder}`.toLowerCase().includes(q));
    }
    if (route.recent) return list;
    const by: Record<Sort, (a: VideoSummary, b: VideoSummary) => number> = {
      updated: (a, b) => b.updated.localeCompare(a.updated),
      created: (a, b) => b.created.localeCompare(a.created),
      title: (a, b) => a.title.localeCompare(b.title),
      length: (a, b) => (b.duration ?? b.minutes * 60) - (a.duration ?? a.minutes * 60),
    };
    return [...list].sort(by[sort]);
  }, [tree, folder, route.recent, query, sort]);

  const title = route.recent ? "Recent" : folder === null ? "All videos" : folderName(folder);
  const subfolders = node?.folders ?? [];

  const click = (v: VideoSummary, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) return setSelected((s) => (s.includes(v.id) ? s.filter((x) => x !== v.id) : [...s, v.id]));
    if (e.shiftKey && selected.length) {
      const ids = videos.map((x) => x.id);
      const a = ids.indexOf(selected[selected.length - 1]!), b = ids.indexOf(v.id);
      return setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
    go({ name: "video", id: v.id, tab: "watch" });
  };

  const trash = async (ids: string[]) => {
    try {
      for (const id of ids) await api.trashVideo(id);
      setSelected([]);
      await refreshLibrary();
      toast(`Moved ${ids.length === 1 ? "1 video" : `${ids.length} videos`} to the Trash`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const move = async (ids: string[], to: string) => {
    setMoving(null);
    try {
      for (const id of ids) await api.moveVideo(id, to);
      setSelected([]);
      await refreshLibrary();
      toast(`Moved to ${to || "Library"}`, "ok");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <main className="main" onClick={(e) => e.target === e.currentTarget && setSelected([])}>
      <div className="head">
        <div>
          <div className="crumb">
            {folder ? ["Library", ...folder.split("/")].map((p, i, arr) => (
              <span key={i}>
                {i < arr.length - 1 ? <a href={i === 0 ? "#/" : `#/f/${folder.split("/").slice(0, i).map(encodeURIComponent).join("/")}`} style={{ color: "var(--faint)" }}>{p}</a> : p}
                {i < arr.length - 1 ? " / " : ""}
              </span>
            )) : "Library"}
          </div>
          <h1>{title}</h1>
        </div>
        <span className="meta">{videos.length} {videos.length === 1 ? "video" : "videos"}{subfolders.length ? ` · ${subfolders.length} ${subfolders.length === 1 ? "folder" : "folders"}` : ""}</span>
        <span className="spacer" />
        {selected.length > 1 ? (
          <>
            <span className="meta">{selected.length} selected</span>
            <button className="btn" onClick={() => setMoving(selected)}>Move to…</button>
            <button className="btn" onClick={() => sheets.exportVideos({ ids: selected })}>Export…</button>
            <button className="btn danger" onClick={() => void trash(selected)}>Move to Trash</button>
            <button className="btn ghost" onClick={() => setSelected([])}>Clear</button>
          </>
        ) : (
          <>
            {!route.recent && (
              <Listbox<Sort> prefix="Sort" value={sort} onChange={setSort} width={220} align="right" options={[
                { value: "updated", label: "Recently changed" }, { value: "created", label: "Newest" },
                { value: "title", label: "Title" }, { value: "length", label: "Length" },
              ]} />
            )}
            {folder && <button className="btn" onClick={() => sheets.exportVideos({ folder })}>Export folder</button>}
          </>
        )}
      </div>

      {subfolders.length > 0 && !query && (
        <div style={{ padding: "0 28px 16px", display: "flex", gap: 10, flexWrap: "wrap" }}>
          {subfolders.map((f) => <FolderTile key={f.path} node={f} />)}
        </div>
      )}

      {tree && videos.length === 0 && !query && (folder !== null || route.recent || tree.videos.length === 0) ? (
        <div className="empty">
          <h2>{tree.videos.length === 0 ? "Make your first video" : "Nothing here yet"}</h2>
          <div>Describe a topic, drop in a PDF or a link, and Emoton writes, voices and animates it.</div>
          <button className="btn primary big" onClick={() => sheets.newVideo({ folder: folder ?? "" })}>New video{folder ? ` in ${folderName(folder)}` : ""}</button>
        </div>
      ) : (
        <div className="grid">
          {videos.map((v) => (
            <VideoCard key={v.id} v={v} selected={selected.includes(v.id)}
              dragIds={() => (selected.includes(v.id) ? selected : [v.id])}
              onClick={(e) => click(v, e)}
              menu={[
                { label: "Open", run: () => go({ name: "video", id: v.id, tab: "watch" }) },
                { label: "Move to…", run: () => setMoving([v.id]) },
                { label: "Duplicate", run: () => void api.duplicateVideo(v.id).then(() => refreshLibrary()).catch((e: Error) => toast(e.message, "error")) },
                { label: "Export…", run: () => sheets.exportVideos({ ids: [v.id] }) },
                { label: "Show in Finder", run: () => void api.video(v.id).then((d) => reveal(d.dir).then((ok) => ok || toast(d.dir))) },
                "sep",
                { label: "Move to Trash", danger: true, run: () => void trash([v.id]) },
              ]} />
          ))}
          {query && videos.length === 0 && <div style={{ color: "var(--dim)", padding: 8 }}>No videos match "{query}".</div>}
          {!query && !route.recent && (
            <button className="newcard" onClick={() => sheets.newVideo({ folder: folder ?? "" })}>
              <span className="plus">+</span>New video{folder ? ` in ${folderName(folder)}` : ""}
            </button>
          )}
          {!query && !route.recent && (
            <button className="newcard" onClick={() => go({ name: "new-short", folder: folder ?? "" })}>
              <span className="plus">+</span>New Short{folder ? ` in ${folderName(folder)}` : ""}
            </button>
          )}
        </div>
      )}
      {moving && <FolderPicker title={moving.length === 1 ? "Move video to…" : `Move ${moving.length} videos to…`} onClose={() => setMoving(null)} onPick={(p) => void move(moving, p)} />}
    </main>
  );
}

function FolderTile({ node }: { node: FolderNode }) {
  const drop = useFolderDrop(node.path);
  return (
    <button className={`item${drop.over ? " drop" : ""}`} {...drop.props} onClick={() => go({ name: "library", folder: node.path })}
      style={{ width: "auto", border: "1px solid var(--line)", background: "var(--panel)", padding: "0 12px", height: 36, color: "var(--text)" }}>
      <IFolder /> {node.name} <span className="n" style={{ marginLeft: 10 }}>{node.total}</span>
    </button>
  );
}
