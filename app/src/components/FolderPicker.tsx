import { useEffect, useState } from "react";
import { useStore } from "../lib/store.tsx";
import type { FolderNode } from "../lib/types.ts";
import { IFolder } from "./Icons.tsx";

/** Choose a library folder (for Move to…). */
export function FolderPicker({ title, onPick, onClose, exclude }: { title: string; onPick(path: string): void; onClose(): void; exclude?: string }) {
  const { tree } = useStore();
  const [sel, setSel] = useState<string>("");
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const rows: { node: FolderNode; depth: number }[] = [];
  const walk = (n: FolderNode, d: number) => {
    for (const f of n.folders) {
      if (exclude && (f.path === exclude || f.path.startsWith(exclude + "/"))) continue;
      rows.push({ node: f, depth: d });
      walk(f, d + 1);
    }
  };
  if (tree) walk(tree.tree, 0);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={{ width: 460 }} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2></header>
        <div className="content" style={{ gap: 2, maxHeight: 420 }}>
          <button className={`item${sel === "" ? " on" : ""}`} onClick={() => setSel("")} onDoubleClick={() => onPick("")}>
            <IFolder /> Library (top level)
          </button>
          {rows.map(({ node, depth }) => (
            <button key={node.path} className={`item${sel === node.path ? " on" : ""}`} style={{ paddingLeft: 24 + depth * 16 }} onClick={() => setSel(node.path)} onDoubleClick={() => onPick(node.path)}>
              <IFolder /> {node.name}
            </button>
          ))}
        </div>
        <footer>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onPick(sel)}>Move here</button>
        </footer>
      </div>
    </div>
  );
}
