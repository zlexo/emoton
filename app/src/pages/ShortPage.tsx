import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { ShortVideo } from "../../../src/remotion/shorts/ShortVideo.tsx";
import { shortFrames } from "../../../src/remotion/shorts/props.ts";
import type { Platform } from "../../../src/core/short/safe.ts";
import { addSound, lineAt, moveFx, moveSound, removeFx, removeSound, removeText, setScene, setText, snap, splitScene, wordAt, type SnapTo } from "../../../src/core/short/edit.ts";
import { estimatedVoice, voiceMatches } from "../../../src/core/short/estimate.ts";
import { checkShort, resolveShort } from "../../../src/core/short/resolve.ts";
import { applyPauseRules, rewriteLine } from "../../../src/core/short/voice.ts";
import { diffShort } from "../../../src/core/short/diff.ts";
import { EXPORT_PRESETS } from "../../../schema/short.ts";
import { api } from "../lib/api.ts";
import { go } from "../lib/route.ts";
import { useStore } from "../lib/store.tsx";
import { folderName } from "../lib/format.ts";
import { reveal } from "../lib/native.ts";
import type { ChapterVoice, PauseEdits, Peaks, ShortDocument, ShortPreview, ShortTake, VideoDetail } from "../lib/types.ts";
import { jobLine } from "../components/Activity.tsx";
import { useClickAway } from "../components/Listbox.tsx";
import { Inspector } from "./short/Inspector.tsx";
import { ScriptPanel } from "./short/ScriptPanel.tsx";
import { SafeZones } from "./short/SafeZones.tsx";
import { Timeline, type Edge, type Gap } from "./short/Timeline.tsx";
import { clock, selectionTime, timelineItems, type Item, type Selection } from "./short/layout.ts";
import { useShortEditor } from "./short/useShortEditor.ts";

const SAVE_LABEL = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", error: "Not saved" } as const;

/**
 * The Short editor: the script on the left, the Short playing live in the
 * middle (the Remotion Player, nothing rendered), the selection's settings
 * on the right, the timeline below. Edits apply at once in the page and are
 * saved a moment later; every view reads the one resolved Short.
 */
export function ShortPage({ video }: { video: VideoDetail }) {
  const { jobs, toast } = useStore();
  const s = video.summary;
  const [preview, setPreview] = useState<ShortPreview | null>(null);
  const [server, setServer] = useState<ShortDocument | null>(null);
  const [peaks, setPeaks] = useState<{ voice?: Peaks; music?: Peaks }>({});
  const [loadErrors, setLoadErrors] = useState<string[] | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [px, setPx] = useState(24);
  const [safe, setSafe] = useState<Platform | null>(null);
  const [loop, setLoop] = useState(false);
  const [snapTo, setSnapTo] = useState<SnapTo>({ words: true, beats: true, scenes: true });
  const [compare, setCompare] = useState<ShortTake | null>(null);
  const [voice, setVoice] = useState<ChapterVoice | null>(null);
  const [reloads, setReloads] = useState(0);
  const [wantVoice, setWantVoice] = useState(false);
  const player = useRef<PlayerRef>(null);
  const other = useRef<PlayerRef>(null);
  const job = useMemo(() => jobs.find((j) => j.videoId === s.id && (j.status === "running" || j.status === "queued")), [jobs, s.id]);
  const key = `${s.id}:${s.updated}:${job?.status ?? ""}:${video.state.lastError?.at ?? ""}:${reloads}`;

  useEffect(() => {
    let live = true;
    api.shortPreview(s.id)
      .then((p) => live && (setPreview(p), setLoadErrors(null)))
      .catch((e: Error & { errors?: string[] }) => live && setLoadErrors(e.errors ?? [e.message]));
    api.shortDocument(s.id).then((d) => live && setServer(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const ed = useShortEditor(s.id, preview, server, useCallback((m: string) => toast(m, "error"), [toast]));
  const view = ed.view && "short" in ed.view ? ed.view : null;
  const short = view?.short;
  const doc = ed.doc;
  const fps = short?.canvas.fps ?? 60;
  const items = useMemo(() => (short ? timelineItems(short) : []), [short]);

  // the voice's pause edits, once it is voiced
  useEffect(() => {
    let live = true;
    if (!preview?.voiced) setVoice(null);
    else api.voice(s.id).then((v) => live && setVoice(v.chapters[0] ?? null)).catch(() => live && setVoice(null));
    return () => {
      live = false;
    };
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // waveforms for the tracks that have a file: the voice once voiced, a song
  useEffect(() => {
    let live = true;
    const has = { voice: !!preview?.voiced, music: !!preview?.props.media.music };
    for (const t of ["voice", "music"] as const) {
      if (!has[t]) setPeaks((x) => ({ ...x, [t]: undefined }));
      else api.shortPeaks(s.id, t).then((p) => live && setPeaks((x) => ({ ...x, [t]: p }))).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  // the player tells us where it is; everything else follows the playhead (and a compared take plays along)
  useEffect(() => {
    const p = player.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => setNow(e.detail.frame / fps);
    const onSeeked = (e: { detail: { frame: number } }) => (setNow(e.detail.frame / fps), other.current?.seekTo(e.detail.frame));
    const onPlay = () => (setPlaying(true), other.current?.seekTo(p.getCurrentFrame()), other.current?.play());
    const onPause = () => (setPlaying(false), other.current?.pause());
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("seeked", onSeeked);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("seeked", onSeeked);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
    };
  }, [view !== null, fps, compare]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((t: number) => {
    player.current?.seekTo(Math.round(t * fps));
    setNow(t);
  }, [fps]);
  const select = (x: Selection | null) => {
    setSel(x);
    const t = short && x && selectionTime(short, x);
    if (t !== null && t !== undefined && !playing) seek(t);
  };

  // every pause in the voice, where it is on the timeline, and its edit
  const gaps = useMemo((): Gap[] => {
    if (!short || !view?.voiced || !voice) return [];
    const out: Gap[] = [];
    const editOf = (key: string, k: number | "after") => (k === "after" ? voice.edits.sentences[key]?.after : voice.edits.sentences[key]?.words?.[String(k)]) ?? 0;
    short.sentences.forEach((x, i) => {
      x.words.forEach((w, k) => k < x.words.length - 1 && out.push({ key: x.key, k, at: w.end, to: x.words[k + 1]!.start, edit: editOf(x.key, k) }));
      const next = short.sentences[i + 1];
      // the voice runs on across scenes: a line's pause lasts until the next line starts
      out.push({ key: x.key, k: "after", at: x.end, to: next ? next.start : short.duration, edit: editOf(x.key, "after") });
    });
    return out;
  }, [short, view?.voiced, voice]);

  /** Pause edits saved: the voice is remade on the server (about a second), then plays from just before the change. */
  const savePauses = async (edits: PauseEdits, from?: number) => {
    try {
      const c = await api.saveVoiceEdits(s.id, 1, edits);
      setVoice(c);
      setReloads((n) => n + 1);
      if (from !== undefined) setTimeout(() => (seek(Math.max(0, from - 1)), player.current?.play()), 400);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const onPause = (g: Gap, deltaMs: number) => {
    if (!voice) return;
    const e: PauseEdits = structuredClone(voice.edits);
    const sx = (e.sentences[g.key] ??= {});
    if (g.k === "after") sx.after = (sx.after ?? 0) + deltaMs || undefined;
    else {
      sx.words ??= {};
      const v = (sx.words[String(g.k)] ?? 0) + deltaMs;
      if (v) sx.words[String(g.k)] = v;
      else delete sx.words[String(g.k)];
    }
    void savePauses(e, g.at);
  };
  const applyRules = () => {
    if (!short || !doc || !voice) return toast("Voice it first: the rules set pauses in the voice", "error");
    const { edits, added } = applyPauseRules(doc, short, voice.edits);
    if (!added) return toast("The pause rules are already in", "ok");
    void savePauses(edits).then(() => toast(`${added} ${added === 1 ? "pause" : "pauses"} set by the rules`, "ok"));
  };
  /** A line written anew: what is pinned to it and its pause edits follow it, then it is voiced again. */
  const rewrite = (sceneId: string, line: number, raw: string) => {
    if (!doc) return;
    const { renames } = rewriteLine(doc, sceneId, line, raw);
    ed.apply((d) => rewriteLine(d, sceneId, line, raw).doc);
    if (renames.length) void api.renameShortPauses(s.id, renames).catch(() => {});
    setWantVoice(true);
  };
  const ask = preview?.ask;
  const askChanges = useMemo(() => (ask && doc ? diffShort(doc, ask.document) : []), [ask, doc]);
  const marked = useMemo(() => new Set(askChanges.filter((c) => c.kind !== "added").map((c) => `scene:${c.on}`)), [askChanges]);
  const lastDraft = useMemo(() => jobs.filter((j) => j.videoId === s.id && j.kind === "draft").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [jobs, s.id]);
  // Claude's notes on a draft stay until read (remembered per draft in this browser)
  const [seenDraft, setSeenDraft] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`emoton.draftSeen.${s.id}`);
    } catch {
      return null;
    }
  });
  const [allNotes, setAllNotes] = useState(false);
  const dismissDraft = (at: string) => {
    setSeenDraft(at);
    try {
      localStorage.setItem(`emoton.draftSeen.${s.id}`, at);
    } catch {
      /* a convenience only */
    }
  };

  // a shot whose knobs changed renders again on its own once the edit is saved (the old take plays until then); a new clip gets its proxy
  const askedShots = useRef("");
  useEffect(() => {
    const stale = [...(preview?.shots.filter((x) => x.state === "stale" || x.state === "missing").map((x) => x.scene) ?? []), ...(preview?.proxies ?? [])];
    const sig = `${stale.join(",")}:${s.updated}`;
    if (!stale.length || job || ed.save !== "saved" || askedShots.current === sig) return;
    askedShots.current = sig;
    void api.startJob({ videoId: s.id, kind: "make" }).catch(() => {});
  }, [preview, job, ed.save]); // eslint-disable-line react-hooks/exhaustive-deps

  // once the rewrite is saved, voice it (the TTS cache makes the unchanged lines instant)
  useEffect(() => {
    if (!wantVoice || ed.save !== "saved" || job) return;
    setWantVoice(false);
    void api.startJob({ videoId: s.id, kind: "voice" }).catch((e: Error) => toast(e.message, "error"));
  }, [wantVoice, ed.save, job]); // eslint-disable-line react-hooks/exhaustive-deps

  const edges = (it: Item): Edge[] => {
    const k = it.sel.kind;
    if (k === "sfx" || k === "fx") return ["body"];
    if (k === "text") return ["body", "start", "end"];
    if (it.sel.kind === "scene") {
      const id = it.sel.id;
      return doc?.scenes.find((x) => x.id === id)?.hold !== undefined ? ["end"] : [];
    }
    return [];
  };
  const onDrop = (it: Item, edge: Edge, to: { at: Parameters<typeof moveSound>[3]; t: number }) => {
    const x = it.sel;
    if (x.kind === "sfx") ed.apply((d, r) => moveSound(d, r, x.i, to.at));
    else if (x.kind === "fx") ed.apply((d, r) => moveFx(d, r, x.i, to.at));
    else if (x.kind === "text") {
      if (edge === "start") ed.apply((d) => setText(d, x.i, { from: to.at }));
      else if (edge === "end") ed.apply((d) => setText(d, x.i, { to: to.at }));
      else ed.apply((d, r) => setText(d, x.i, { from: to.at, to: snap(r, to.t + (it.end - it.start), snapTo, 8 / px).at }));
    } else if (x.kind === "scene" && edge === "end") ed.apply((d, r) => setScene(d, x.id, { hold: to.t - r.scenes.find((y) => y.id === x.id)!.from }));
  };

  // keys: Space plays, J/K/L shuttle, arrows step a frame, B adds a boom, S splits, Delete removes,
  // Cmd Z / Shift Cmd Z undo and redo, Cmd S saves now, Escape clears the selection (no F keys)
  const latest = useRef({ short, sel, now, ed });
  latest.current = { short, sel, now, ed };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const { short: r, sel: x, now: t, ed: E } = latest.current;
      const p = player.current;
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "z" && e.shiftKey) (e.preventDefault(), E.redo());
        else if (e.key === "z") (e.preventDefault(), E.undo());
        else if (e.key === "s") (e.preventDefault(), E.saveNow());
        return;
      }
      if (!p || !r) return;
      const frame = p.getCurrentFrame();
      if (e.key === " ") (e.preventDefault(), p.toggle());
      else if (e.key === "k") p.pause();
      else if (e.key === "l") p.play();
      else if (e.key === "j") (p.pause(), p.seekTo(Math.max(0, frame - fps)));
      else if (e.key === "ArrowLeft") (e.preventDefault(), p.seekTo(Math.max(0, frame - 1)));
      else if (e.key === "ArrowRight") (e.preventDefault(), p.seekTo(frame + 1));
      else if (e.key === "Escape") setSel(null);
      else if (e.key === "b") {
        const at = wordAt(r, t) ?? { t: +t.toFixed(3) };
        E.apply((d) => addSound(d, { kind: "boom", at }));
        setSel({ kind: "sfx", i: r.sfx.length });
      } else if (e.key === "s") {
        const at = lineAt(r, t);
        if (at && at.line > 0) E.apply((d) => splitScene(d, at.scene, at.line));
      } else if ((e.key === "Delete" || e.key === "Backspace") && x) {
        if (x.kind === "sfx") E.apply((d, rr) => removeSound(d, rr, x.i));
        else if (x.kind === "fx") E.apply((d, rr) => removeFx(d, rr, x.i));
        else if (x.kind === "text") E.apply((d) => removeText(d, x.i));
        else return;
        setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fps]);

  // a take beside the current edit: its document resolved the same way, on the same media
  const compared = useMemo(() => {
    if (!compare || !preview) return null;
    const voiced = preview.voiced && voiceMatches(compare.document, preview.timing);
    const voice = voiced ? preview.timing : estimatedVoice(compare.document);
    if (checkShort(compare.document, { voice }).length) return null;
    return { short: resolveShort(compare.document, { voice }), media: { ...preview.props.media, voice: undefined } };
  }, [compare, preview]);

  // a take opened for comparison starts where the edit is
  useEffect(() => {
    if (!compared) return;
    const f = requestAnimationFrame(() => other.current?.seekTo(player.current?.getCurrentFrame() ?? 0));
    return () => cancelAnimationFrame(f);
  }, [compared]);

  const make = () => void api.startJob({ videoId: s.id, kind: "make" }).then(() => toast("Voicing the narration", "ok")).catch((e: Error) => toast(e.message, "error"));
  const scene = sel?.kind === "scene" ? short?.scenes.find((x) => x.id === sel.id) : undefined;
  const loopRange = loop && scene ? { inFrame: Math.round(scene.from * fps), outFrame: Math.max(Math.round(scene.from * fps) + 1, Math.round((scene.from + scene.seconds) * fps) - 1) } : {};
  const target = doc?.target?.minSeconds;
  const narrated = !!short?.sentences.length;
  const errors = loadErrors ?? (ed.view && "problems" in ed.view ? ed.view.problems : null);

  // Claude's proposal and draft notes sit on top of the script (long; the player keeps its room)
  const claude = (
    <>
      {job?.kind !== "ask" && ask && (
        <div className="notice sx-note sx-ask">
          <div className="txt">
            <b>Claude: {ask.summary}</b>
            <span>You asked: “{ask.request}”{ask.base !== ed.revision() ? " · made before your latest edits: keeping it replaces them" : ""}</span>
            <ul>{askChanges.slice(0, 12).map((c, i) => <li key={i} className={`sx-ch ${c.kind}`}>{c.label}</li>)}{askChanges.length > 12 && <li className="sx-dim">and {askChanges.length - 12} more</li>}</ul>
            <div className="chips">
              <button className="btn small primary" onClick={() => {
                const d = ask.document;
                ed.apply(() => d);
                setCompare(null);
                void api.dropShortProposal(s.id).catch(() => {});
                toast("Kept Claude's change (Cmd Z takes it back)", "ok");
              }}>Keep</button>
              <button className="btn small" onClick={() => setCompare(compare?.name === "Claude" ? null : { name: "Claude", saved: ask.at, document: ask.document })}>{compare?.name === "Claude" ? "Stop comparing" : "Play side by side"}</button>
              <button className="btn small ghost" onClick={() => (setCompare(null), void api.dropShortProposal(s.id).catch((e: Error) => toast(e.message, "error")))}>Drop</button>
            </div>
          </div>
        </div>
      )}
      {job?.kind !== "draft" && preview?.draft && preview.draft.notes.length > 0 && seenDraft !== preview.draft.at && (
        <div className="notice review sx-note">
          <div className="txt">
            <b>{doc?.template === "edit" ? "What the cut heard" : "Claude's notes on the draft"}</b>
            <ul>{(allNotes ? preview.draft.notes : preview.draft.notes.slice(0, 2)).map((n, i) => <li key={i}>{n}</li>)}</ul>
            {preview.draft.notes.length > 2 && <button className="btn small ghost" onClick={() => setAllNotes(!allNotes)}>{allNotes ? "Fewer" : `All ${preview.draft.notes.length} notes`}</button>}
          </div>
          <button className="btn small" onClick={() => dismissDraft(preview.draft!.at)}>Got it</button>
        </div>
      )}
    </>
  );

  return (
    <div className="sx">
      <div className="sx-top">
        <button className="btn ghost small" onClick={() => go({ name: "library", folder: s.folder })}>← {folderName(s.folder)}</button>
        <h1 className="serif">{s.title}</h1>
        <span className="chip">Short{doc ? ` · ${doc.template}` : ""}</span>
        {short && (
          <span className={`sx-length${target && short.duration < target ? " short" : ""}`} title={target ? `target ${target} s or more` : undefined}>
            {clock(short.duration)}{target ? ` / ${target} s+` : ""}
          </span>
        )}
        <button className="btn small ghost" disabled={!ed.canUndo} onClick={ed.undo} title="Undo (Cmd Z)">Undo</button>
        <button className="btn small ghost" disabled={!ed.canRedo} onClick={ed.redo} title="Redo (Shift Cmd Z)">Redo</button>
        <span className={`sx-save ${ed.save}`} title={ed.saveError ?? undefined}>{SAVE_LABEL[ed.save]}</span>
        <span className="spacer" />
        {doc?.template === "edit" && <button className="btn small" disabled={!!job} title="cut the clips to the song again, in a new order" onClick={() => void api.startJob({ videoId: s.id, kind: "draft", note: "reroll" }).catch((e: Error) => toast(e.message, "error"))}>Re-roll</button>}
        <AskBox busy={!!job} onAsk={(note) => void api.startJob({ videoId: s.id, kind: "ask", note }).catch((e: Error) => toast(e.message, "error"))} />
        <Takes id={s.id} revision={ed.revision} compare={compare} setCompare={setCompare} onRestored={(d) => (ed.adopt(d.document, d.revision), setCompare(null), toast("Take restored", "ok"))} onError={(m) => toast(m, "error")} />
        {doc && preview && (
          <ExportMenu presets={doc.exportPresets ?? ["tiktok", "phone"]} setPresets={(p) => ed.apply((d) => ({ ...d, exportPresets: p }))} busy={!!job} exports={preview.exports}
            onExport={() => (ed.saveNow(), void api.startJob({ videoId: s.id, kind: "render" }).then(() => toast("Exporting: only changed scenes render", "ok")).catch((e: Error) => toast(e.message, "error")))}
            onReveal={() => void reveal(`${video.dir}/out`).then((ok) => ok || toast(`${video.dir}/out`))} />
        )}
        {job ? <span className="chip making">{jobLine(job)} · {Math.round(job.progress * 100)}%</span>
          : view && narrated && !view.voiced ? <button className="btn small primary" onClick={make}>Voice it</button>
          : view ? <span className="chip ready">Live · nothing rendered</span> : null}
        <button className="btn small ghost" onClick={() => void reveal(video.dir).then((ok) => ok || toast(video.dir))}>Show in Finder</button>
      </div>

      {doc && short && view ? <ScriptPanel id={s.id} short={short} doc={doc} media={view.media} sel={sel} now={now} onSelect={select} onRewrite={rewrite} edit={ed.apply} onError={(m) => toast(m, "error")} clips={preview?.clips ?? []} top={claude} /> : <div className="sx-left" />}

      <div className="sx-centre">
        {video.state.lastError && !job && <div className="errors">The last run failed: {video.state.lastError.message}</div>}
        {!job && lastDraft?.status === "failed" && (
          <div className="notice failed sx-note">
            <div className="txt"><b>The draft failed</b><span>{lastDraft.error}</span></div>
            <button className="btn small" onClick={() => void api.startJob({ videoId: s.id, kind: "draft" }).catch((e: Error) => toast(e.message, "error"))}>Try again</button>
          </div>
        )}
        {job?.kind === "ask" && (
          <div className="notice sx-note"><div className="txt"><b>Claude is working on: “{job.note}”</b><span>{jobLine(job)}. Its change shows here to keep or drop; nothing changes until you keep it.</span></div></div>
        )}
        {job?.kind === "draft" && (
          <div className="notice sx-note"><div className="txt"><b>{doc?.template === "edit" ? "Cutting the clips to the song" : "Claude is drafting this Short from its brief"}</b><span>{jobLine(job)}. The draft replaces what is here when it lands.</span></div></div>
        )}
        {ed.saveError && <div className="errors">Not saved: {ed.saveError}</div>}
        {errors && <div className="errors">{errors.map((e) => <div key={e}>{e}</div>)}<div className="sx-dim">Undo (Cmd Z) takes the last edit back.</div></div>}
        {view && short && (
          <>
            <div className="sx-players">
              <div className="sx-frame" style={{ aspectRatio: `${short.canvas.w} / ${short.canvas.h}` }}>
                <Player
                  ref={player}
                  component={ShortVideo as unknown as React.FC<Record<string, unknown>>}
                  inputProps={{ short, media: view.media } as unknown as Record<string, unknown>}
                  durationInFrames={shortFrames(short)}
                  compositionWidth={short.canvas.w}
                  compositionHeight={short.canvas.h}
                  fps={short.canvas.fps}
                  loop={loop}
                  {...loopRange}
                  clickToPlay
                  acknowledgeRemotionLicense
                  style={{ width: "100%", height: "100%" }}
                />
                {safe && <SafeZones platform={safe} canvas={short.canvas} />}
                {compare && <span className="sx-ab">Now</span>}
              </div>
              {compare && compared && (
                <div className="sx-frame" style={{ aspectRatio: `${compared.short.canvas.w} / ${compared.short.canvas.h}` }}>
                  <Player
                    ref={other}
                    component={ShortVideo as unknown as React.FC<Record<string, unknown>>}
                    inputProps={compared as unknown as Record<string, unknown>}
                    durationInFrames={shortFrames(compared.short)}
                    compositionWidth={compared.short.canvas.w}
                    compositionHeight={compared.short.canvas.h}
                    fps={compared.short.canvas.fps}
                    acknowledgeRemotionLicense
                    style={{ width: "100%", height: "100%" }}
                  />
                  <span className="sx-ab">{compare.name}</span>
                </div>
              )}
            </div>
            <div className="sx-transport">
              <button className="btn small" onClick={() => player.current?.toggle()}>{playing ? "Pause" : "Play"}</button>
              <span className="sx-dim">{clock(now)} / {clock(short.duration)}</span>
              <span className="spacer" />
              <button className={`toggle-chip${safe === "tiktok" ? " on" : ""}`} onClick={() => setSafe(safe === "tiktok" ? null : "tiktok")}>Safe zones: TikTok</button>
              <button className={`toggle-chip${safe === "shorts" ? " on" : ""}`} onClick={() => setSafe(safe === "shorts" ? null : "shorts")}>Shorts</button>
              <button className={`toggle-chip${loop ? " on" : ""}`} disabled={!scene} title={scene ? undefined : "select a scene to loop it"} onClick={() => setLoop(!loop)}>Loop scene</button>
            </div>
            {!view.voiced && narrated && <div className="sx-dim" style={{ textAlign: "center" }}>Silent, on estimated timing, until it is voiced.</div>}
          </>
        )}
      </div>

      <div className="sx-right">{short && doc && view ? <Inspector id={s.id} shots={preview?.shots ?? []} busy={!!job} short={short} doc={doc} media={view.media} sel={sel} now={now} edit={ed.apply} onSelect={select} gaps={gaps} onPause={onPause} onRewrite={rewrite} onRules={applyRules} voiced={view.voiced} onError={(m) => toast(m, "error")} /> : null}</div>

      {short ? (
        <Timeline short={short} items={items} peaks={peaks} now={now} px={px} setPx={setPx} selection={sel} onSelect={select} onSeek={seek} playing={playing}
          snapTo={snapTo} setSnapTo={setSnapTo} edges={edges} onDrop={onDrop} gaps={gaps} onPause={onPause} marked={marked} />
      ) : <div className="sx-tl" />}
    </div>
  );
}

const PRESET_LABEL: Record<(typeof EXPORT_PRESETS)[number], string> = {
  tiktok: "TikTok and Shorts", nomusic: "No music", phone: "Phone copy", audio: "Audio only", stills: "Stills",
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Export: which presets (the main file always), start it, and what the last export wrote. */
function ExportMenu({ presets, setPresets, busy, exports, onExport, onReveal }: {
  presets: (typeof EXPORT_PRESETS)[number][]; setPresets(p: (typeof EXPORT_PRESETS)[number][]): void; busy: boolean;
  exports: ShortPreview["exports"]; onExport(): void; onReveal(): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useClickAway(box, () => setOpen(false), open);
  const on = (p: (typeof EXPORT_PRESETS)[number]) => p === "tiktok" || presets.includes(p);
  return (
    <div className="sx-takes" ref={box}>
      <button className="btn small primary" onClick={() => setOpen(!open)}>Export</button>
      {open && (
        <div className="sx-pop">
          <div className="chips">
            {EXPORT_PRESETS.map((p) => (
              <button key={p} className={`toggle-chip${on(p) ? " on" : ""}`} disabled={p === "tiktok"} title={p === "tiktok" ? "always made: 1080x1920, mastered to -14 LUFS" : undefined}
                onClick={() => setPresets(on(p) ? presets.filter((x) => x !== p) : [...presets, p])}>{PRESET_LABEL[p]}</button>
            ))}
          </div>
          <button className="btn primary" disabled={busy} onClick={() => (onExport(), setOpen(false))}>{busy ? "Working…" : "Export now"}</button>
          <p className="sx-dim">Only the scenes that changed since the last export are rendered again.</p>
          {exports.length > 0 && (
            <>
              <div className="sx-pop-row"><b style={{ flex: 1 }}>Last export</b><button className="btn small ghost" onClick={onReveal}>Show in Finder</button></div>
              {exports.map((x) => (
                <div key={x.name} className="sx-pop-row">
                  <a href={x.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</a>
                  <span className="sx-dim">{mb(x.size)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const ASK_IDEAS = ["make the intro punchier", "a boom on the reveal", "tighten the pauses", "shorter: under 50 s"];

/** Ask Claude for a change; it comes back as a proposal to keep or drop. */
function AskBox({ busy, onAsk }: { busy: boolean; onAsk(note: string): void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useClickAway(box, () => setOpen(false), open);
  const send = () => {
    if (!text.trim()) return;
    onAsk(text.trim());
    setText("");
    setOpen(false);
  };
  return (
    <div className="sx-takes" ref={box}>
      <button className="btn small" disabled={busy} title={busy ? "a job is running on this Short" : "ask Claude for a change"} onClick={() => setOpen(!open)}>Ask</button>
      {open && (
        <div className="sx-pop">
          <textarea className="textarea" autoFocus rows={3} placeholder="What should change?" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), send())} />
          <div className="chips">{ASK_IDEAS.map((x) => <button key={x} className="toggle-chip" onClick={() => setText(x)}>{x}</button>)}</div>
          <div className="sx-pop-row"><span className="sx-dim" style={{ flex: 1 }}>The change comes back to keep or drop.</span><button className="btn small primary" disabled={!text.trim()} onClick={send}>Ask Claude</button></div>
        </div>
      )}
    </div>
  );
}

/** Named takes: keep the current edit under a name, compare one side by side, restore one. */
function Takes({ id, revision, compare, setCompare, onRestored, onError }: {
  id: string; revision(): string | null; compare: ShortTake | null; setCompare(t: ShortTake | null): void;
  onRestored(d: ShortDocument): void; onError(m: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [takes, setTakes] = useState<ShortTake[]>([]);
  const [name, setName] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useClickAway(box, () => setOpen(false), open);
  const load = () => void api.shortTakes(id).then(setTakes).catch((e: Error) => onError(e.message));
  useEffect(() => {
    if (open) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const keep = () => {
    const n = name.trim() || `take ${takes.length + 1}`;
    void api.saveShortTake(id, n).then(() => (setName(""), load())).catch((e: Error) => onError(e.message));
  };
  return (
    <div className="sx-takes" ref={box}>
      <button className={`btn small${compare ? " primary" : ""}`} onClick={() => setOpen(!open)}>{compare ? `A/B: ${compare.name}` : "Takes"}</button>
      {open && (
        <div className="sx-pop">
          <div className="sx-pop-row">
            <input className="input" placeholder={`take ${takes.length + 1}`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && keep()} />
            <button className="btn small" onClick={keep}>Keep this edit</button>
          </div>
          {compare && <button className="btn small ghost" onClick={() => setCompare(null)}>Stop comparing</button>}
          {takes.length === 0 && <div className="sx-dim">No takes yet. A take keeps the edit as it is now (the last save).</div>}
          {takes.map((t) => (
            <div key={t.name} className="sx-pop-row">
              <span style={{ flex: 1 }}>{t.name} <span className="sx-dim">{new Date(t.saved).toLocaleTimeString()}</span></span>
              <button className="btn small ghost" onClick={() => (setCompare(t), setOpen(false))}>Compare</button>
              <button className="btn small ghost" onClick={() => {
                const rev = revision();
                if (!rev) return;
                void api.restoreShortTake(id, t.name, rev).then((d) => (onRestored(d), setOpen(false))).catch((e: Error) => onError(e.message));
              }}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
