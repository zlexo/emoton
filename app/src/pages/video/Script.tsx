import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api.ts";
import { useStore } from "../../lib/store.tsx";
import { useDraft } from "../../lib/drafts.ts";
import type { Chapter, Outline, VideoDetail } from "../../lib/types.ts";
import { citeLabel } from "../../lib/format.ts";

/** A textarea that grows with its text (WKWebView has no field-sizing). */
export function Grow(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...props} />;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Chapters the user did not touch follow the server; touched ones keep the user's text. */
function rebaseChapters(d: { base: (Chapter | null)[]; value: (Chapter | null)[] }, server: (Chapter | null)[]) {
  const n = Math.max(server.length, d.value.length);
  const base: (Chapter | null)[] = [];
  const value: (Chapter | null)[] = [];
  for (let i = 0; i < n; i++) {
    const touched = !same(d.value[i], d.base[i]);
    base.push(touched ? d.base[i] ?? null : server[i] ?? null);
    value.push(touched ? d.value[i] ?? null : server[i] ?? null);
  }
  return { base, value };
}

export function Script({ video, focusChapter, busy }: { video: VideoDetail; focusChapter: number; busy: boolean }) {
  const hasStoryboard = video.chapters.some(Boolean);
  const [mode, setMode] = useState<"outline" | "storyboard">(hasStoryboard ? "storyboard" : "outline");
  useEffect(() => setMode(hasStoryboard ? "storyboard" : "outline"), [hasStoryboard]);
  if (!video.outline) return <div className="empty"><h2>Nothing written yet</h2><div>The script appears once the outline is written.</div></div>;
  return (
    <>
      {hasStoryboard && (
        <div className="chips">
          <button className={`toggle-chip${mode === "storyboard" ? " on" : ""}`} onClick={() => setMode("storyboard")}>Narration</button>
          <button className={`toggle-chip${mode === "outline" ? " on" : ""}`} onClick={() => setMode("outline")}>Outline</button>
        </div>
      )}
      {mode === "outline" ? (
        <OutlineEditor video={video} warn={hasStoryboard} busy={busy} />
      ) : (
        <StoryboardEditor video={video} focusChapter={focusChapter} busy={busy} />
      )}
    </>
  );
}

function BusyNote({ busy }: { busy: boolean }) {
  return busy ? <span style={{ color: "var(--yellow)" }}>A job is running on this video. If it is rewriting the same part, saving now stops that step and keeps your edit.</span> : null;
}

function OutlineEditor({ video, warn, busy }: { video: VideoDetail; warn: boolean; busy: boolean }) {
  const { toast } = useStore();
  const d = useDraft<Outline>(`${video.summary.id}:outline`, video.outline!);
  const draft = d.value;
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const edit = (f: (o: Outline) => void) => d.set((o) => (f(o), o));

  const save = async (andContinue: boolean) => {
    setSaving(true);
    setErrors([]);
    try {
      await api.saveOutline(video.summary.id, draft);
      d.discard();
      if (andContinue) {
        await api.startJob({ videoId: video.summary.id, kind: "make", pauseAfterOutline: false });
        toast("Writing, voicing and rendering", "ok");
      } else toast("Outline saved", "ok");
    } catch (e) {
      setErrors(e instanceof ApiError && e.errors ? e.errors : [(e as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      {warn && <div className="notice review"><div className="txt"><b>Editing the outline rewrites chapters</b><span>A chapter whose outline changes is written again, which replaces any narration edits in it.</span></div></div>}
      {d.conflict && <div className="notice review"><div className="txt"><b>The outline changed since you started editing</b><span>Saving keeps your version. Discard to see the new one.</span></div></div>}
      <div className="field">
        <span className="label">Opening question</span>
        <Grow className="textarea" value={draft.hook} onChange={(e) => edit((o) => void (o.hook = e.target.value))} />
      </div>
      {draft.chapters.map((c, i) => (
        <section className="ed-chapter" key={i}>
          <header>
            <span className="num">{i + 1}</span>
            <input aria-label={`Chapter ${i + 1} title`} value={c.title} onChange={(e) => edit((o) => void (o.chapters[i]!.title = e.target.value))} />
            <button className="icon-btn" title="Move up" aria-label="Move chapter up" disabled={i === 0} onClick={() => edit((o) => void o.chapters.splice(i - 1, 0, o.chapters.splice(i, 1)[0]!))}>↑</button>
            <button className="icon-btn" title="Move down" aria-label="Move chapter down" disabled={i === draft.chapters.length - 1} onClick={() => edit((o) => void o.chapters.splice(i + 1, 0, o.chapters.splice(i, 1)[0]!))}>↓</button>
            <button className="icon-btn" title="Remove chapter" aria-label="Remove chapter" disabled={draft.chapters.length <= 2} onClick={() => edit((o) => void o.chapters.splice(i, 1))}>✕</button>
          </header>
          <div className="claims">
            <div className="field">
              <span className="label">Goal</span>
              <Grow className="textarea" value={c.goal} onChange={(e) => edit((o) => void (o.chapters[i]!.goal = e.target.value))} />
            </div>
            <span className="label">Claims, each backed by the pages it cites</span>
            {c.claims.map((cl, k) => (
              <div className="claim" key={k}>
                <Grow className="textarea" value={cl.text} onChange={(e) => edit((o) => void (o.chapters[i]!.claims[k]!.text = e.target.value))} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 6 }}>
                  {cl.cite.map((ct) => <span key={ct} className="cite">{citeLabel(ct, video.sources)}</span>)}
                </div>
                <button className="icon-btn" title="Remove claim" aria-label="Remove claim" disabled={c.claims.length <= 1} onClick={() => edit((o) => void o.chapters[i]!.claims.splice(k, 1))}>✕</button>
              </div>
            ))}
          </div>
        </section>
      ))}
      {errors.length > 0 && <div className="errors">{errors.join("\n")}</div>}
      {d.dirty && (
        <div className="savebar">
          <span className="txt">Outline changed <BusyNote busy={busy} /></span>
          <button className="btn ghost" onClick={d.discard}>Discard</button>
          <button className="btn" disabled={saving} onClick={() => void save(false)}>Save</button>
          <button className="btn primary" disabled={saving} onClick={() => void save(true)}>Save and continue</button>
        </div>
      )}
    </div>
  );
}

function StoryboardEditor({ video, focusChapter, busy }: { video: VideoDetail; focusChapter: number; busy: boolean }) {
  const { toast } = useStore();
  const d = useDraft<(Chapter | null)[]>(`${video.summary.id}:narration`, video.chapters, rebaseChapters);
  const draft = d.value;
  const base = d.base;
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const changedN = draft.map((c, i) => (c && !same(c, base[i]) ? i + 1 : 0)).filter(Boolean);
  const conflicted = changedN.filter((n) => !same(base[n - 1], video.chapters[n - 1]));
  const refs = useRef<Record<number, HTMLElement | null>>({});
  // Follow the chapter rail, but not on first open (that would scroll the tabs away).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    refs.current[focusChapter]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusChapter]);

  const setLine = (ci: number, bi: number, li: number, text: string) => d.set((x) => (void (x[ci]!.beats[bi]!.say[li] = text), x));
  const slides = video.brief.layout === "slides";
  /** Edits beat bi of chapter ci in the draft. */
  const setBeat = (ci: number, bi: number, f: (b: Chapter["beats"][number]) => void) => d.set((x) => (f(x[ci]!.beats[bi]!), x));
  const changedAt = (ci: number, bi: number, pick: (b: Chapter["beats"][number]) => unknown) => !same(pick(draft[ci]!.beats[bi]!), base[ci] ? pick(base[ci]!.beats[bi] ?? ({} as Chapter["beats"][number])) : undefined);
  const save = async (andUpdate: boolean) => {
    setSaving(true);
    setErrors([]);
    try {
      for (const n of changedN) await api.saveChapter(video.summary.id, n, draft[n - 1]);
      d.discard();
      if (andUpdate) {
        await api.startJob({ videoId: video.summary.id, kind: "make", pauseAfterOutline: false });
        toast(`Voicing and rendering ${changedN.length === 1 ? `chapter ${changedN[0]}` : `${changedN.length} chapters`}`, "ok");
      } else toast("Saved. The chapter shows as changed until you update the video.", "ok");
    } catch (e) {
      setErrors(e instanceof ApiError && e.errors ? e.errors : [(e as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      {conflicted.length > 0 && <div className="notice review"><div className="txt"><b>{conflicted.length === 1 ? `Chapter ${conflicted[0]}` : "Some chapters"} changed since you started editing</b><span>Saving keeps your version of the chapters you edited. Discard to see the new text.</span></div></div>}
      {draft.map((c, ci) =>
        c ? (
          <section className="ed-chapter" key={ci} ref={(el) => void (refs.current[ci + 1] = el)}>
            <header>
              <span className="num">{ci + 1}</span>
              <input aria-label={`Chapter ${ci + 1} title`} value={c.title} onChange={(e) => d.set((x) => (void (x[ci]!.title = e.target.value), x))} />
            </header>
            {c.beats.map((b, bi) => (
              <div key={bi}>
              {slides && b.slide && (
                <div className="ed-slide">
                  <span className="tag">Slide</span>
                  <div className="fields">
                    <input aria-label={`Chapter ${ci + 1}, slide title at beat ${bi + 1}`} className={`slide-title${changedAt(ci, bi, (x) => x.slide?.title) ? " changed" : ""}`} value={b.slide.title} placeholder="Slide title"
                      onChange={(e) => setBeat(ci, bi, (x) => void (x.slide = { ...x.slide!, title: e.target.value }))} />
                    <input aria-label={`Chapter ${ci + 1}, slide headline at beat ${bi + 1}`} className={`slide-headline${changedAt(ci, bi, (x) => x.slide?.headline) ? " changed" : ""}`} value={b.slide.headline ?? ""} placeholder="Headline: the slide's one rule, KaTeX between $...$ (optional)"
                      onChange={(e) => setBeat(ci, bi, (x) => void (x.slide = { ...x.slide!, ...(e.target.value ? { headline: e.target.value } : { headline: undefined }) }))} />
                  </div>
                  {bi > 0 && <button className="btn small ghost" title="Make this beat part of the slide before it" onClick={() => setBeat(ci, bi, (x) => void delete x.slide)}>Join previous slide</button>}
                </div>
              )}
              <div className="ed-beat">
                <div className="vt">
                  {b.visual?.type ?? "point"}
                  {b.visual?.type === "diagram" && b.visual.continue ? <><br />continues</> : null}
                  {b.aha && <><br /><span className="aha">aha</span></>}
                  {(b.cite ?? []).map((ct) => <div key={ct}><span className="cite" style={{ marginLeft: 0 }}>{citeLabel(ct, video.sources)}</span></div>)}
                </div>
                <div className="lines">
                  {b.say.map((line, li) => (
                    <Grow key={li} aria-label={`Chapter ${ci + 1}, beat ${bi + 1}, sentence ${li + 1}`} className={`line${line !== base[ci]?.beats[bi]?.say[li] ? " changed" : ""}`} value={line}
                      onChange={(e) => setLine(ci, bi, li, e.target.value.replace(/\n/g, " "))} />
                  ))}
                  {slides && (
                    <div className="ed-point">
                      <span className="tag">Point</span>
                      <input aria-label={`Chapter ${ci + 1}, beat ${bi + 1}, point`} className={changedAt(ci, bi, (x) => x.point) ? "changed" : ""} value={b.point ?? ""} placeholder="The beat's takeaway on the slide, at most 12 words"
                        onChange={(e) => setBeat(ci, bi, (x) => void (e.target.value ? (x.point = e.target.value) : delete x.point))} />
                      {b.visual && (
                        <button className={`toggle-chip${b.full ? " on" : ""}`} title="The visual takes the whole screen for this beat" onClick={() => setBeat(ci, bi, (x) => void (x.full ? delete x.full : (x.full = true)))}>Full screen</button>
                      )}
                      {!b.slide && bi > 0 && <button className="btn small ghost" title="Start a new slide at this beat" onClick={() => setBeat(ci, bi, (x) => void (x.slide = { title: "" }))}>New slide here</button>}
                    </div>
                  )}
                </div>
              </div>
              </div>
            ))}
          </section>
        ) : (
          <section className="ed-chapter" key={ci}><header><span className="num">{ci + 1}</span><span style={{ color: "var(--faint)" }}>{video.outline?.chapters[ci]?.title}: not written yet</span></header></section>
        ),
      )}
      {errors.length > 0 && <div className="errors">{errors.join("\n")}</div>}
      {changedN.length > 0 && (
        <div className="savebar">
          <span className="txt">{changedN.length === 1 ? `Chapter ${changedN[0]} edited` : `${changedN.length} chapters edited`} <BusyNote busy={busy} /></span>
          <button className="btn ghost" onClick={d.discard}>Discard</button>
          <button className="btn" disabled={saving} onClick={() => void save(false)}>Save</button>
          <button className="btn primary" disabled={saving} onClick={() => void save(true)}>Save, voice and render</button>
        </div>
      )}
    </div>
  );
}
