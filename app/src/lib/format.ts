import type { VideoStatus } from "./types.ts";

export const mmss = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export function ago(isoDate: string): string {
  const d = new Date(isoDate);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if (s < 6 * 86400) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export const STATUS: Record<VideoStatus, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "draft" },
  "outline-review": { label: "Outline ready, review", cls: "review" },
  partial: { label: "Needs work", cls: "partial" },
  ready: { label: "Ready", cls: "ready" },
  making: { label: "Making", cls: "making" },
  failed: { label: "Failed", cls: "failed" },
  interrupted: { label: "Interrupted", cls: "interrupted" },
};

export const STAGE_LABEL: Record<string, string> = {
  ingest: "Reading sources", outline: "Writing outline", storyboard: "Writing chapter", voice: "Voicing chapter",
  render: "Rendering chapter", join: "Joining video", export: "Exporting", draft: "Drafting", ask: "Asking Claude", shots: "Rendering shots", proxies: "Making proxies",
};

export const folderName = (path: string) => (path ? path.split("/").pop()! : "Library");
export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** "notes:p6" -> "Notes p.6" using the video's source titles. */
export function citeLabel(id: string, sources: { id: string; title: string }[]): string {
  const [src, part] = id.split(":");
  const title = sources.find((s) => s.id === src)?.title ?? src ?? id;
  return part ? `${title} ${part.replace(/^p/, "p.")}` : title;
}
