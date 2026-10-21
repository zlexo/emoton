import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api.ts";
import { useStore } from "../../lib/store.tsx";
import type { ChapterTiming, ChapterVoice, PauseEdits, VideoDetail, VideoVoice, Voice as VoiceId, VoiceOption } from "../../lib/types.ts";
import { Listbox, useClickAway } from "../../components/Listbox.tsx";

/**
 * The Voice tab: a chapter's voice as a transcript, every word with its time,
 * every pause adjustable by ear. A change is saved at once and the chapter's
 * voice remade on the server (about a second); Preview then plays it with the
 * visuals following, and the chapter's render goes stale until it is rendered
 * again. Ported from Code Typer's voice editor.
 */

type Sentence = ChapterTiming["beats"][number]["sentences"][number];
type Word = NonNullable<Sentence["words"]>[number];
/** Where a pause is: after word k of sentence si (flat index), or after the sentence. */
type Gap = { si: number; k: number | "after" };
type Flat = { beat: number; key: string; spoken: Sentence; now: Sentence };

const STEPS = [-100, -20, 20, 100];
const ms = (s: number) => Math.round(s * 1000);
const clock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

function flatten(c: ChapterVoice): Flat[] {
  const out: Flat[] = [];
  c.timing.beats.forEach((b, bi) => b.sentences.forEach((s, i) => out.push({ beat: bi, key: c.keys[bi]![i]!, spoken: c.spoken.beats[bi]!.sentences[i]!, now: s })));
  return out;
}

/** The pause after word k (or after the sentence, up to the next one or the end), in seconds. */
function pauseAfter(s: Sentence, k: number | "after", next: Sentence | undefined, duration: number): number {
  const w = s.words ?? [];
  if (k === "after") return (next ? next.start : duration) - s.end;
  return w[k + 1]!.start - w[k]!.end;
}

const editOf = (e: PauseEdits, key: string, k: number | "after") => (k === "after" ? e.sentences[key]?.after : e.sentences[key]?.words?.[String(k)]) ?? 0;

/** `e` with the pause at (key, k) changed by `d` ms, or put back when `d` is null. */
function withChange(e: PauseEdits, key: string, k: number | "after", d: number | null): PauseEdits {
  const next: PauseEdits = structuredClone(e);
  const s = (next.sentences[key] ??= {});
  const v = d === null ? 0 : editOf(e, key, k) + d;
  if (k === "after") {
    if (v) s.after = v;
    else delete s.after;
  } else {
    s.words ??= {};
    if (v) s.words[String(k)] = v;
    else delete s.words[String(k)];
    if (!Object.keys(s.words).length) delete s.words;
  }
  if (!s.words && !s.after) delete next.sentences[key];
  return next;
}

export function Voice({ video, chapter, setChapter, busy }: { video: VideoDetail; chapter: number; setChapter(n: number): void; busy: boolean }) {
  const { toast } = useStore();
  const id = video.summary.id;
  const [data, setData] = useState<VideoVoice | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const stateKey = `${id}:${video.state.chapters.map((c) => `${c.voice}${c.duration ?? ""}`).join(",")}`;

  useEffect(() => {
    let live = true;
    api.voice(id).then((v) => live && (setData(v), setErr(null))).catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [stateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="errors">{err}</div>;
  if (!data) return null;
  const voiced = data.chapters.map((c) => c.n);
  const waiting = video.state.chapters.filter((c) => !voiced.includes(c.n) && c.storyboard !== "missing");
  if (!voiced.length)
    return <div className="empty"><h2>Nothing voiced yet</h2><div>The voice appears here once a chapter is voiced. Then every word has its time and every pause can be made longer or shorter by ear.</div></div>;
  const n = voiced.includes(chapter) ? chapter : voiced[0]!;
  const c = data.chapters.find((x) => x.n === n)!;
  const replace = (next: ChapterVoice) => setData((d) => d && { ...d, chapters: d.chapters.map((x) => (x.n === next.n ? next : x)) });

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ width: 280 }}>
          <Listbox value={n} onChange={setChapter} options={data.chapters.map((x) => ({ value: x.n, label: `Chapter ${x.n}`, sub: x.title }))} />
        </div>
        <span style={{ color: "var(--dim)" }}>
          {data.voice.engine === "say" ? "macOS voice" : "Kokoro"} · {data.voice.voice} · ×{data.voice.speed.toFixed(2)}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => setPicking(true)}>Voice</button>
      </div>
      {picking && <VoiceDrawer video={video} current={data.voice} sample={c.spoken.beats[0]?.sentences[0]?.text ?? video.summary.title} busy={busy} onClose={() => setPicking(false)} />}
      {waiting.length > 0 && (
        <div className="notice"><div className="txt"><b>{waiting.length === 1 ? `Chapter ${waiting[0]!.n} is not voiced yet` : `${waiting.length} chapters are not voiced yet`}</b><span>Their pauses can be edited once the video is updated and they are voiced again.</span></div></div>
      )}
      <ChapterEditor key={`${id}:${n}`} id={id} c={c} busy={busy} onSaved={replace} onError={(m) => toast(m, "error")} />
    </>
  );
}

function ChapterEditor({ id, c, busy, onSaved, onError }: { id: string; c: ChapterVoice; busy: boolean; onSaved(c: ChapterVoice): void; onError(m: string): void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState<Gap | null>(null);
  const [saving, setSaving] = useState(false);
  const flat = useMemo(() => flatten(c), [c]);
  const words = useMemo(() => flat.flatMap((f) => f.now.words ?? []), [flat]);
  // the edits that apply: those for sentences still in the chapter
  const total = Object.entries(c.edits.sentences).filter(([k]) => !c.dropped.includes(k)).reduce((t, [, e]) => t + Object.keys(e.words ?? {}).length + (e.after ? 1 : 0), 0);

  // the playhead, smooth while playing (timeupdate fires only about 4 times a second)
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      setNow(audio.current?.currentTime ?? 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const playFrom = useCallback((t: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.max(0, t);
    setNow(a.currentTime);
    void a.play();
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== " " || (e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      const a = audio.current;
      if (a) void (a.paused ? a.play() : a.pause());
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const save = async (edits: PauseEdits, hold?: { word: number; offset: number }) => {
    if (saving) return;
    setSaving(true);
    const a = audio.current;
    const wasPlaying = !!a && !a.paused;
    a?.pause();
    try {
      const next = await api.saveVoiceEdits(id, c.n, edits);
      onSaved(next);
      // the new voice: keep the playhead on the same word as the timeline moves
      if (a) {
        a.addEventListener("loadedmetadata", () => {
          const w = hold && flatten(next).flatMap((f) => f.now.words ?? [])[hold.word];
          a.currentTime = w ? Math.max(0, w.start + hold.offset) : a.currentTime;
          setNow(a.currentTime);
          if (wasPlaying || hold) void a.play();
        }, { once: true });
      }
    } catch (e) {
      onError(e instanceof ApiError && e.errors ? e.errors.join("\n") : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Changes a pause and plays the new voice from a second before it, so the change is heard at once. */
  const change = (g: Gap, d: number | null) => {
    const f = flat[g.si]!;
    const w = f.now.words ?? [];
    const at = g.k === "after" ? w.length - 1 : g.k;
    const word = words.indexOf(w[at]!);
    // from about a second before the pause: the word it follows, or one before
    const from = Math.max(0, word - 1);
    void save(withChange(c.edits, f.key, g.k, d), { word: from, offset: -0.15 });
  };

  const discardDropped = () => {
    const next: PauseEdits = { version: 1, sentences: Object.fromEntries(Object.entries(c.edits.sentences).filter(([k]) => !c.dropped.includes(k))) };
    void save(next);
  };

  let wi = -1;
  const current = words.findIndex((w) => w.start <= now && now < w.end);
  return (
    <div className="vx">
      <audio
        ref={audio}
        src={c.timing.audio}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => (setPlaying(false), setNow(audio.current?.currentTime ?? 0))}
        onEnded={() => setPlaying(false)}
        onSeeked={() => setNow(audio.current?.currentTime ?? 0)}
        onTimeUpdate={() => setNow(audio.current?.currentTime ?? 0)}
      />
      <div className="vx-bar">
        <button className="vx-play" title="Play or pause (space)" aria-label={playing ? "Pause" : "Play"} onClick={() => { const a = audio.current; if (a) void (a.paused ? a.play() : a.pause()); }}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="vx-clock">{clock(now)} / {clock(c.timing.duration)}</span>
        <span className="vx-status">
          {saving ? "Remaking the voice" : <><b>{total}</b> pause edit{total === 1 ? "" : "s"}{total ? `, ${c.timing.duration >= c.spoken.duration ? "+" : "−"}${Math.abs(c.timing.duration - c.spoken.duration).toFixed(2)} s` : ""}</>}
        </span>
      </div>
      <div className="vx-track" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); playFrom(((e.clientX - r.left) / r.width) * c.timing.duration); }}>
        {flat.map((f, i) => <i key={i} style={{ left: `${(f.now.start / c.timing.duration) * 100}%`, width: `${((f.now.end - f.now.start) / c.timing.duration) * 100}%` }} />)}
        <b style={{ left: `${(now / c.timing.duration) * 100}%` }} />
      </div>
      <p className="vx-help">Click a word to hear it from there. Click a pause to make it longer or shorter: the voice is remade at once and Preview plays it with the visuals. Pauses are in milliseconds.</p>
      {busy && <div className="notice review"><div className="txt"><b>A job is running on this video</b><span>Pauses can be changed again once it finishes.</span></div></div>}
      {c.dropped.length > 0 && (
        <div className="notice review">
          <div className="txt"><b>{c.dropped.length === 1 ? "An edit is for a sentence no longer in this chapter" : `${c.dropped.length} edits are for sentences no longer in this chapter`}</b><span>{c.dropped.map((d) => `“${d}”`).join(", ")}</span></div>
          <button className="btn" disabled={busy || saving} onClick={discardDropped}>Discard</button>
        </div>
      )}
      <div className="vx-doc">
        {flat.map((f, si) => {
          const ws = f.now.words ?? [];
          const spokenWords = f.spoken.words ?? [];
          const next = flat[si + 1];
          return (
            <div key={si}>
              {(si === 0 || flat[si - 1]!.beat !== f.beat) && <h6 className="vx-beat">Beat {f.beat + 1}</h6>}
              <div className={`vx-sentence${f.now.estimated ? " estimated" : ""}`} title={f.now.estimated ? "This voice gives no word times: they are estimated by letters, and a pause added here goes to the nearest real gap" : undefined}>
                {ws.map((w: Word, k) => {
                  wi++;
                  const last = k === ws.length - 1;
                  const gk: number | "after" = last ? "after" : k;
                  const nowMs = ms(pauseAfter(f.now, gk, next?.now, c.timing.duration));
                  const natural = ms(pauseAfter({ ...f.spoken, words: spokenWords }, gk, next?.spoken, c.spoken.duration));
                  const delta = editOf(c.edits, f.key, gk);
                  const isOpen = open?.si === si && open.k === gk;
                  return (
                    <span className="vx-pair" key={k}>
                      <button className={`vx-w${wi === current ? " now" : ""}`} onClick={() => playFrom(w.start - 0.05)}>
                        <span className="t">{w.start.toFixed(2)}</span>
                        <span>{w.text}</span>
                      </button>
                      <span className="vx-gapwrap">
                        <button
                          className={`vx-gap${last ? " sent" : ""}${delta > 0 ? " more" : delta < 0 ? " less" : ""}${isOpen ? " open" : ""}`}
                          title={`${last ? "Pause after the sentence" : `Pause after “${w.text}”`}: ${nowMs} ms now, ${natural} ms as spoken`}
                          onClick={(e) => (e.stopPropagation(), setOpen(isOpen ? null : { si, k: gk }))}
                        >
                          {nowMs}{delta ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}
                        </button>
                        {isOpen && (
                          <GapPop
                            label={last ? "after the sentence" : `after “${w.text}”`}
                            disabled={busy || saving}
                            canShorten={!f.now.estimated}
                            onStep={(d) => change({ si, k: gk }, d)}
                            onReset={() => change({ si, k: gk }, null)}
                            onHear={() => playFrom((last ? f.now.end : w.end) - 1.2)}
                            onClose={() => setOpen(null)}
                          />
                        )}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GapPop({ label, disabled, canShorten, onStep, onReset, onHear, onClose }: {
  label: string; disabled: boolean; canShorten: boolean; onStep(d: number): void; onReset(): void; onHear(): void; onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, onClose, true);
  return (
    <div className="vx-pop" ref={ref} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <span className="what">{label}</span>
      {STEPS.map((d) => (
        <button key={d} disabled={disabled || (d < 0 && !canShorten)} title={d < 0 && !canShorten ? "This voice gives no word times, so a pause here can only be made longer" : undefined} onClick={() => onStep(d)}>
          {d > 0 ? "+" : "−"}{Math.abs(d)}
        </button>
      ))}
      <button disabled={disabled} onClick={onReset}>Reset</button>
      <button title="Hear this pause" aria-label="Hear this pause" onClick={onHear}>▶</button>
    </div>
  );
}

/**
 * Every voice on this machine by group, each with a preview of the video's
 * first sentence. Use saves the voice to the video and voices every chapter
 * again (cached sentences are reused); pause edits carry over by sentence
 * text. Renders wait for Update video, so the new voice can be heard first.
 */
function VoiceDrawer({ video, current, sample, busy, onClose }: { video: VideoDetail; current: VoiceId; sample: string; busy: boolean; onClose(): void }) {
  const { toast } = useStore();
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [speed, setSpeed] = useState(current.speed);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const text = sample.length > 300 ? `${sample.slice(0, 297)}...` : sample;

  useEffect(() => {
    void api.voices().then(setVoices).catch((e: Error) => toast(e.message, "error"));
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      player.current?.pause();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const id = (v: VoiceOption) => `${v.engine}:${v.voice}`;
  const preview = async (v: VoiceOption) => {
    player.current?.pause();
    if (playing === id(v)) return setPlaying(null);
    setLoading(id(v));
    try {
      const blob = await api.voiceSample({ engine: v.engine, voice: v.voice, speed }, text);
      const a = new Audio(URL.createObjectURL(blob));
      player.current = a;
      a.onended = () => setPlaying(null);
      setPlaying(id(v));
      await a.play();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoading(null);
    }
  };
  const use = async (v: VoiceOption) => {
    try {
      await api.updateBrief(video.summary.id, { voice: { engine: v.engine, voice: v.voice, speed } });
      await api.startJob({ videoId: video.summary.id, kind: "voice" });
      toast(`Voicing every chapter as ${v.label}. Pause edits carry over; render with Update video once it sounds right.`, "ok");
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const groups = voices ? [...new Set(voices.map((v) => v.group))] : [];
  const step = (d: number) => setSpeed((s) => Math.round(Math.min(2, Math.max(0.5, s + d)) * 100) / 100);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="vx-drawer" aria-label="Voice">
        <header>
          <h2>Voice</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <div className="vx-drawer-body">
          <p className="vx-sample">Previews read: “{text}”</p>
          <div className="vx-speed">
            Speed
            <button className="icon-btn" aria-label="Slower" onClick={() => step(-0.05)}>−</button>
            <b>×{speed.toFixed(2)}</b>
            <button className="icon-btn" aria-label="Faster" onClick={() => step(0.05)}>+</button>
          </div>
          {busy && <p className="vx-note">A job is running on this video: a new voice can be chosen once it finishes.</p>}
          {!voices && <p className="vx-note">Loading voices</p>}
          {groups.map((g) => {
            const list = voices!.filter((v) => v.group === g);
            return (
              <section key={g}>
                <h6>{g}</h6>
                {!list[0]!.timed && <p className="vx-note">No word times: words are estimated and pauses can only be made longer.</p>}
                {list.map((v) => {
                  const on = v.engine === current.engine && v.voice === current.voice;
                  return (
                    <div key={id(v)} className={`vx-vrow${on ? " on" : ""}`}>
                      <span className="name">{v.label}</span>
                      <span className="sub">{[v.accent, v.gender === "f" ? "female" : v.gender === "m" ? "male" : ""].filter(Boolean).join(", ")}</span>
                      <button className="btn small" disabled={loading !== null && loading !== id(v)} onClick={() => void preview(v)}>
                        {loading === id(v) ? "…" : playing === id(v) ? "Stop" : "▶"}
                      </button>
                      <button className="btn small primary" disabled={busy || (on && speed === current.speed)} onClick={() => void use(v)}>{on ? "Use speed" : "Use"}</button>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </aside>
    </>
  );
}
