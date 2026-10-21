import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { go, type Route } from "../lib/route.ts";
import { useStore } from "../lib/store.tsx";
import type { FolderNode } from "../lib/types.ts";
import type { Sheets } from "../App.tsx";
import { IChevron, IClock, IDots, IFolder, IGear, IGrid } from "./Icons.tsx";
import { MenuButton } from "./Listbox.tsx";
import { parentOf } from "../lib/format.ts";

export const DRAG_VIDEO = "application/x-emoton-video";
export const DRAG_FOLDER = "application/x-emoton-folder";

/** Drop handler shared by sidebar rows and folder tiles: moves videos or folders into `target`. */
export function useFolderDrop(target: string) {
  const { refreshLibrary, toast } = useStore();
  const [over, setOver] = useState(false);
  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_VIDEO) || e.dataTransfer.types.includes(DRAG_FOLDER);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: async (e: React.DragEvent) => {
        setOver(false);
        const ids = e.dataTransfer.getData(DRAG_VIDEO);
        const folder = e.dataTransfer.getData(DRAG_FOLDER);
        e.preventDefault();
        try {
          if (ids) {
            const list = ids.split(",");
            for (const id of list) await api.moveVideo(id, target);
            toast(`Moved ${list.length === 1 ? "1 video" : `${list.length} videos`} to ${target || "Library"}`, "ok");
          } else if (folder && folder !== target && !target.startsWith(folder + "/") && parentOf(folder) !== target) {
            await api.updateFolder(folder, { parent: target });
            toast(`Moved folder into ${target || "Library"}`, "ok");
          }
          await refreshLibrary();
        } catch (err) {
          toast((err as Error).message, "error");
        }
      },
    },
  };
}

export function Sidebar({ route, sheets, renaming, setRenaming }: { route: Route; sheets: Sheets; renaming: string | null; setRenaming(p: string | null): void }) {
  const { tree, doctor } = useStore();
  const worst = doctor?.some((c) => c.level === "error") ? "error" : doctor?.some((c) => c.level === "warn") ? "warn" : "ok";
  const issues = doctor?.filter((c) => c.level !== "ok").length ?? 0;
  const root = useFolderDrop("");
  const sel = route.name === "library" ? route : null;

  return (
    <nav className="side">
      <button className={`item${sel && sel.folder === null && !sel.recent ? " on" : ""}${root.over ? " drop" : ""}`} {...root.props} onClick={() => go({ name: "library", folder: null })}>
        <IGrid /> All videos <span className="n">{tree?.videos.length ?? ""}</span>
      </button>
      <button className={`item${sel?.recent ? " on" : ""}`} onClick={() => go({ name: "library", folder: null, recent: true })}>
        <IClock /> Recent
      </button>
      <h6>
        Folders
        <button title="New folder" onClick={() => sheets.newFolder("")}>+</button>
      </h6>
      {tree?.tree.folders.map((f) => (
        <FolderRow key={f.path} node={f} depth={0} route={route} sheets={sheets} renaming={renaming} setRenaming={setRenaming} />
      ))}
      {tree && tree.tree.folders.length === 0 && <div style={{ color: "var(--faint)", padding: "4px 10px 0", fontSize: 12 }}>No folders yet</div>}
      <div className="foot">
        <button className={`item${route.name === "doctor" ? " on" : ""}`} onClick={() => go({ name: "doctor" })}>
          <span className={`dot ${worst}`} style={{ marginLeft: 4, marginRight: 4 }} />
          {doctor === null ? "Doctor" : issues === 0 ? "Doctor: all clear" : `Doctor: ${issues} to check`}
        </button>
        <button className={`item${route.name === "settings" ? " on" : ""}`} onClick={() => go({ name: "settings" })}>
          <IGear /> Settings
        </button>
      </div>
    </nav>
  );
}

function FolderRow({ node, depth, route, sheets, renaming, setRenaming }: { node: FolderNode; depth: number; route: Route; sheets: Sheets; renaming: string | null; setRenaming(p: string | null): void }) {
  const { refreshLibrary, toast } = useStore();
  const current = route.name === "library" ? route.folder : null;
  const [open, setOpen] = useState(() => !!current && (current === node.path || current.startsWith(node.path + "/")));
  useEffect(() => {
    if (current && current.startsWith(node.path + "/")) setOpen(true);
  }, [current, node.path]);
  const drop = useFolderDrop(node.path);
  const [name, setName] = useState(node.name);
  const editing = renaming === node.path;
  useEffect(() => setName(node.name), [node.name, editing]);

  const commit = async () => {
    setRenaming(null);
    if (!name.trim() || name === node.name) return;
    try {
      const { path } = await api.updateFolder(node.path, { name: name.trim() });
      await refreshLibrary();
      if (current === node.path) go({ name: "library", folder: path });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const trash = async () => {
    try {
      await api.trashFolder(node.path);
      await refreshLibrary();
      if (current === node.path || current?.startsWith(node.path + "/")) go({ name: "library", folder: null });
      toast(`Moved "${node.name}" to the Trash`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <>
      <div
        className={`item${current === node.path ? " on" : ""}${drop.over ? " drop" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        {...drop.props}
        draggable={!editing}
        onDragStart={(e) => e.dataTransfer.setData(DRAG_FOLDER, node.path)}
        onClick={() => !editing && go({ name: "library", folder: node.path })}
        onDoubleClick={() => setRenaming(node.path)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (editing || e.target !== e.currentTarget) return;
          if (e.key === "Enter") go({ name: "library", folder: node.path });
          if (e.key === "ArrowRight") setOpen(true);
          if (e.key === "ArrowLeft") setOpen(false);
          if (e.key === "F2") setRenaming(node.path);
        }}
      >
        <button type="button" className="twisty" tabIndex={-1} aria-label={open ? "Collapse" : "Expand"} onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}>
          {node.folders.length > 0 && <IChevron open={open} />}
        </button>
        <IFolder />
        {editing ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void commit()}
            onKeyDown={(e) => (e.key === "Enter" ? void commit() : e.key === "Escape" && setRenaming(null))} onClick={(e) => e.stopPropagation()} />
        ) : (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
        )}
        {!editing && <span className="n">{node.total || ""}</span>}
        {!editing && current === node.path && (
          <MenuButton align="right" items={[
            { label: "New video here", run: () => sheets.newVideo({ folder: node.path }) },
            { label: "New Short here", run: () => go({ name: "new-short", folder: node.path }) },
            { label: "New subfolder", run: () => sheets.newFolder(node.path) },
            { label: "Rename", run: () => setRenaming(node.path) },
            { label: "Export folder…", run: () => sheets.exportVideos({ folder: node.path }) },
            "sep",
            { label: "Move to Trash", danger: true, run: () => void trash() },
          ]}><IDots size={14} /></MenuButton>
        )}
      </div>
      {open && node.folders.map((f) => <FolderRow key={f.path} node={f} depth={depth + 1} route={route} sheets={sheets} renaming={renaming} setRenaming={setRenaming} />)}
    </>
  );
}
