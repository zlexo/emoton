import type { VideoSummary } from "../lib/types.ts";
import { STATUS, ago, mmss } from "../lib/format.ts";
import { IDots } from "./Icons.tsx";
import { MenuButton, type MenuItem } from "./Listbox.tsx";
import { DRAG_VIDEO } from "./Sidebar.tsx";

export function VideoCard({ v, selected, dragIds, onClick, menu }: {
  v: VideoSummary; selected: boolean; dragIds: () => string[]; onClick(e: React.MouseEvent): void; menu: MenuItem[];
}) {
  const st = STATUS[v.status];
  const running = v.job && (v.job.status === "running" || v.job.status === "queued");
  const label = running ? v.job!.detail ?? (v.job!.status === "queued" ? "Queued" : "Working") : st.label;
  return (
    <div
      className={`card${selected ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_VIDEO, dragIds().join(","));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick(e as unknown as React.MouseEvent)}
    >
      <div className="thumb">
        {v.thumb ? <img src={`${v.thumb}?v=${encodeURIComponent(v.updated)}`} alt="" draggable={false} /> : <span className="ph">{v.status === "draft" ? "draft" : v.status === "outline-review" ? "outline ready" : "no video yet"}</span>}
        {v.kind !== "short" && (v.duration || v.minutes) && <span className="dur">{v.duration ? mmss(v.duration) : `~${v.minutes} min`}</span>}
      </div>
      <MenuButton className="menu-btn" align="right" items={menu}><IDots size={14} /></MenuButton>
      <div className="cbody">
        <div className="ctitle">{v.title}</div>
        <div className="csub">{v.kind === "short" ? "Short" : v.chapters ? `${v.chapters} chapters` : "No outline yet"}{v.folder ? ` · ${v.folder}` : ""}</div>
        <div className="crow">
          <span className={`chip ${running ? "making" : st.cls}`}>{label}</span>
          <span className="cdate">{running ? `${Math.round((v.job!.progress ?? 0) * 100)}%` : ago(v.updated)}</span>
        </div>
        {running && <div className="prog"><i style={{ width: `${Math.round((v.job!.progress ?? 0) * 100)}%` }} /></div>}
      </div>
    </div>
  );
}
