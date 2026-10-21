import { useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { useStore } from "../../lib/store.tsx";
import { inApp, openPath, pickSourceFiles } from "../../lib/native.ts";
import type { VideoDetail } from "../../lib/types.ts";
import { IDoc, ILink, IX } from "../../components/Icons.tsx";

export function Sources({ video, onChanged }: { video: VideoDetail; onChanged(): void }) {
  const { toast } = useStore();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // page id -> beats citing it
  const citedBy = useMemo(() => {
    const m: Record<string, string[]> = {};
    video.chapters.forEach((c, ci) => c?.beats.forEach((b, bi) => (b.cite ?? []).forEach((id) => (m[id] ??= []).push(`ch ${ci + 1} beat ${bi + 1}`))));
    video.outline?.chapters.forEach((c, ci) => c.claims.forEach((cl) => cl.cite.forEach((id) => (m[id] ??= []).includes(`ch ${ci + 1} outline`) || m[id]!.push(`ch ${ci + 1} outline`))));
    return m;
  }, [video]);

  const open = async (ref: string, page?: number) => {
    if (/^https?:/.test(ref)) return void window.open(ref, "_blank");
    const abs = `${video.dir}/${ref}`;
    if (await openPath(abs)) return;
    window.open(`/media/${video.summary.id}/${ref.split("/").map(encodeURIComponent).join("/")}${page ? `#page=${page}` : ""}`, "_blank");
  };
  const act = async (p: Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await p;
      onChanged();
      toast(msg, "ok");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const paths = await pickSourceFiles();
    if (paths === null) return fileRef.current?.click();
    if (paths.length) await act(api.addSources(video.summary.id, { sourcePaths: paths }), "Source added. Update the video to use it.");
  };

  return (
    <div className="src-list">
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" disabled={busy} onClick={() => void add()}><IDoc size={14} />Add files</button>
        <label className="search" style={{ flex: "0 1 380px" }}>
          <ILink size={13} />
          <input placeholder="Add a link or YouTube URL" value={url} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && /^https?:\/\//.test(url.trim()) && void act(api.addSources(video.summary.id, { urls: [url.trim()] }), "Link added").then(() => setUrl(""))} />
        </label>
        {!inApp() && <input type="file" multiple hidden ref={fileRef} accept=".pdf,.md,.txt,.markdown"
          onChange={(e) => e.target.files && void act(api.addSources(video.summary.id, {}, [...e.target.files]), "Source added")} />}
      </div>
      {video.sources.length === 0 && <div style={{ color: "var(--dim)" }}>No sources. The writer used general knowledge, so nothing in this video is cited.</div>}
      {video.sources.map((s) => {
        const pages = s.kind === "pdf" && s.pages ? Array.from({ length: s.pages }, (_, i) => i + 1) : [];
        const citedCount = Object.keys(citedBy).filter((id) => id.startsWith(`${s.id}:`)).length;
        return (
          <div className="src" key={s.id}>
            <div className="top">
              {s.kind === "url" || s.kind === "youtube" ? <ILink /> : <IDoc />}
              <button className="job-title" onClick={() => void open(s.ref)}><b>{s.title}</b></button>
              <span>{s.kind === "pdf" ? `${s.pages ?? "?"} pages` : s.kind} · {citedCount} cited {citedCount === 1 ? "part" : "parts"}</span>
              {s.noText && <span className="chip failed">no text found</span>}
              <span className="spacer" />
              <button className="icon-btn" title="Remove source" onClick={() => void act(api.removeSource(video.summary.id, s.id), `Removed ${s.title}`)}><IX /></button>
            </div>
            {pages.length > 0 && (
              <div className="pages">
                {pages.map((p) => {
                  const id = `${s.id}:p${p}`;
                  const by = citedBy[id];
                  return by ? (
                    <button key={p} className="page cited" title={by.join(", ")} onClick={() => void open(s.ref, p)}>p.{p}</button>
                  ) : (
                    <span key={p} className="page">p.{p}</span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
