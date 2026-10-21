import { useEffect, useMemo, useState } from "react";
import { TEMPLATES, type Template } from "../../../src/core/short/templates.ts";
import { Listbox } from "../components/Listbox.tsx";
import { api } from "../lib/api.ts";
import { folderName } from "../lib/format.ts";
import { go } from "../lib/route.ts";
import { useStore } from "../lib/store.tsx";
import type { LibrarySound, Series, SeriesOverview } from "../lib/types.ts";

type Kinds = Awaited<ReturnType<typeof api.perdixKinds>>;

const LAST_SERIES = "emoton.newShort.series";
const remembered = () => {
  try {
    return localStorage.getItem(LAST_SERIES) ?? "";
  } catch {
    return "";
  }
};
const remember = (v: string) => {
  try {
    localStorage.setItem(LAST_SERIES, v);
  } catch {
    /* a convenience only */
  }
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const PRESET_NAMES: Record<string, string> = { tiktok: "TikTok and Shorts", nomusic: "No music", phone: "phone copy", audio: "audio only", stills: "stills" };

/** A 9:16 sketch of what each template looks like. */
function Thumb({ t }: { t: Template }) {
  return (
    <div className={`ns-thumb ns-thumb-${t}`} aria-hidden>
      {t === "devlog" && <><span className="ns-cap">no face</span><span className="ns-end">PART 4</span></>}
      {t === "montage" && <span className="ns-day">DAY 7</span>}
      {t === "speedrun" && <><span className="ns-code" /><span className="ns-code short" /><span className="ns-code" /><span className="ns-timer">0:42.17</span></>}
      {t === "edit" && <><span className="ns-day">TODAY</span><span className="ns-beats">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ height: `${30 + ((i * 37) % 60)}%` }} />)}</span></>}
    </div>
  );
}

function Defaults({ series, overview, template }: { series: Series | null; overview: SeriesOverview | null; template: Template }) {
  const rows: [string, React.ReactNode, React.ReactNode?][] = [];
  if (series) {
    const v = series.voice, m = series.music.source;
    rows.push(["Voice", `${v.engine === "kokoro" ? "Kokoro" : "macOS say"}, ${v.voice}, speed ${v.speed}`, v.gaps ? `pauses: sentence ${v.gaps.sentence} s, beat ${v.gaps.beat} s, tail ${v.gaps.tail} s` : undefined]);
    rows.push(["Captions", `up to ${series.captions.maxWords} words${series.captions.highlight ? ", the spoken word lit" : ""}`, "each chunk timed to the voice"]);
    rows.push(["Sounds", <span className="chips">{["boom", "ding", "scratch", "mash"].map((k) => <span key={k} className={`sx-mark m-${k}`}>{k}</span>)}</span>, `about ${series.boomsPerMinute} booms a minute; a boom punches in and shakes`]);
    rows.push(["Music", "synth" in m ? `Score, ${m.synth.style}, ${m.synth.bpm} BPM` : "a song", `ducks ${Math.abs(series.music.duck.depthDb).toFixed(0)} dB under the voice`]);
    rows.push(["End card", `${series.endCard.text.replace("{n}", String(overview?.next ?? "n"))}${series.endCard.sub ? ` · ${series.endCard.sub}` : ""}`, `last ${series.endCard.seconds} s`]);
    rows.push(["Wording", series.wording.map((w) => `"${w.use}", never "${w.avoid}"`).join("; ")]);
    rows.push(["Look", series.look]);
    if (template === "devlog") {
      const b = overview?.build;
      rows.push(["Perdix build", b?.pinned ? `${b.pinned}, as the last episode` : "Perdix's main", b?.pinned && b.behind ? <span className="ns-warn">main is {b.behind} commits ahead: rebuild at main in the shot panel for anything newer</span> : undefined]);
    }
    rows.push(["Canvas", `1080 × 1920, ${template === "speedrun" ? 30 : series.fps} fps`, `target ${series.target.minSeconds} to ${series.target.maxSeconds} s`]);
  } else {
    rows.push(["Canvas", `1080 × 1920, ${template === "speedrun" ? 30 : 60} fps`]);
    if (template === "devlog") rows.push(["Voice", "Kokoro, am_puck, speed 1.08"]);
    rows.push(["Music", template === "devlog" ? "Score, pad, 84 BPM" : template === "montage" ? "Beat, house, 124 BPM" : template === "speedrun" ? "Beat, phonk, 140 BPM" : "the song you pick"]);
  }
  const presets = template === "edit" ? ["tiktok", "nomusic", "phone"] : (series?.exportPresets ?? ["tiktok", "phone"]);
  rows.push(["Export", presets.map((p) => PRESET_NAMES[p] ?? p).join(", ")]);
  return (
    <div className="ns-defaults">
      {rows.map(([k, v, sub]) => (
        <div key={k} className="ns-def">
          <span>{k}</span>
          <div>{v}{sub ? <div className="ns-sub">{sub}</div> : null}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * New Short: pick how it starts (template), a series for its shared
 * settings, a title and a brief or script; it opens in the editor on the
 * template's starting document.
 */
export function NewShortPage({ folder }: { folder: string }) {
  const { toast, refreshLibrary } = useStore();
  const [template, setTemplate] = useState<Template>("devlog");
  const [all, setAll] = useState<Series[]>([]);
  const [seriesId, setSeriesId] = useState(remembered);
  const [overview, setOverview] = useState<SeriesOverview | null>(null);
  const [kinds, setKinds] = useState<Kinds | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [songs, setSongs] = useState<LibrarySound[]>([]);
  const [song, setSong] = useState<string>("");
  const [songFile, setSongFile] = useState<File | null>(null);
  const [clips, setClips] = useState<File[]>([]);
  useEffect(() => void api.sounds().then((l) => setSongs(l.sounds.filter((x) => x.category === "songs"))).catch(() => {}), []);
  const isEdit = template === "edit";
  const ready = isEdit ? (!!song || !!songFile) && clips.length > 0 : !!brief.trim();

  useEffect(() => void api.series().then(setAll).catch(() => {}), []);
  useEffect(() => void api.perdixKinds().then(setKinds).catch(() => {}), []);
  const series = all.find((s) => s.id === seriesId) ?? null;
  useEffect(() => {
    setOverview(null);
    if (!series) return;
    setTemplate(series.template);
    void api.seriesOverview(series.id).then(setOverview).catch(() => {});
  }, [series?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const seriesOptions = useMemo(() => [{ value: "", label: "No series" }, ...all.map((s) => ({ value: s.id, label: s.name }))], [all]);
  const placeholder = series && overview ? `${series.slug}-ep${overview.next}` : "New Short";

  const create = async (draft: boolean) => {
    setBusy(true);
    try {
      const d = await api.newShort({ folder, template, ...(series ? { series: series.id } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(brief.trim() ? { brief: brief.trim() } : {}) });
      if (isEdit) {
        if (songFile) await api.addShortMusic(d.summary.id, songFile);
        else if (song) await api.importSound(d.summary.id, song);
        if (clips.length) await api.addShortClips(d.summary.id, clips);
      }
      if (draft) await api.startJob({ videoId: d.summary.id, kind: "draft" });
      void refreshLibrary();
      go({ name: "video", id: d.summary.id, tab: "watch" });
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  return (
    <main className="ns">
      <div className="ns-head">
        <span className="ns-crumb">{folder ? folderName(folder) : "Library"} ›</span>
        <h1>New Short</h1>
        <div className="ns-series"><Listbox value={seriesId} options={seriesOptions} prefix="Series" onChange={(v) => (setSeriesId(v), remember(v))} /></div>
        <span className="spacer" />
        <button className="btn" onClick={() => history.back()}>Cancel</button>
      </div>

      <div className="ns-cols">
        <section>
          <h2><span>1</span>Start from</h2>
          {TEMPLATES.map((t) => (
            <button key={t.id} className={`ns-tpl${template === t.id ? " on" : ""}`} onClick={() => setTemplate(t.id)}>
              <Thumb t={t.id} />
              <div>
                <h3>{t.name}</h3>
                <p>{t.about}</p>
                <span className="chips">
                  {series?.template === t.id && <span className="toggle-chip on">series default</span>}
                  {t.tags.map((x) => <span key={x} className="toggle-chip">{x}</span>)}
                </span>
              </div>
            </button>
          ))}
        </section>

        <section>
          <h2><span>2</span>{isEdit ? "Song and clips" : "Brief"}<small>{isEdit ? "the cuts land on its beats and drop" : "Claude drafts the edit from it"}</small></h2>
          <input className="input ns-title" placeholder={placeholder} value={title} onChange={(e) => setTitle(e.target.value)} />
          {isEdit ? (
            <>
              <label className="ns-label">Song</label>
              <Listbox value={songFile ? "" : song} options={[{ value: "", label: songFile ? songFile.name : songs.length ? "Pick a song from the sound library" : "No songs in the sound library yet" }, ...songs.map((x) => ({ value: x.path, label: x.name }))]}
                onChange={(v) => (setSong(v), setSongFile(null))} />
              <label className="btn small" style={{ alignSelf: "flex-start" }}>
                Or upload a song…
                <input type="file" accept="audio/*" hidden onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) (setSongFile(f), setSong(""));
                }} />
              </label>
              <label className="ns-label">Clips</label>
              <label className="btn small" style={{ alignSelf: "flex-start" }}>
                Add clips…
                <input type="file" accept="video/mp4,video/quicktime,video/webm,.m4v" multiple hidden onChange={(e) => {
                  const fs = [...(e.target.files ?? [])];
                  e.target.value = "";
                  setClips((c) => [...c, ...fs.filter((f) => !c.some((x) => x.name === f.name && x.size === f.size))]);
                }} />
              </label>
              <div className="ns-kinds">
                {clips.length === 0 && <div className="ns-kind"><span>No clips yet: each cut shows a clip's liveliest stretch.</span></div>}
                {clips.map((f) => (
                  <div key={`${f.name}-${f.size}`} className="ns-kind"><span>{f.name}</span><button className="btn small ghost" onClick={() => setClips((c) => c.filter((x) => x !== f))}>Remove</button></div>
                ))}
              </div>
            </>
          ) : <label className="ns-label">Script or brief</label>}
          {!isEdit && <textarea className="textarea ns-brief" value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder={"Paste the script (markers in brackets: [boom], [scratch], [ding]) or say what the episode shows:\n\nPerdix gets a life: strolls to spots nearby, looks around, stares at the camera, auto-jumps, and a god view."} />}
          {template === "devlog" && kinds && (
            <>
              <label className="ns-label">Shots Perdix can make</label>
              <div className="ns-kinds">
                {Object.entries(kinds.kinds).map(([k, s]) => (
                  <div key={k} className="ns-kind"><span>{s.about}</span><code>{k}</code></div>
                ))}
              </div>
            </>
          )}
        </section>

        <section>
          <h2><span>3</span>{series ? "Series defaults" : "Defaults"}{series && overview?.episodes.length ? <small>as episode {overview.episodes.at(-1)!.episode ?? overview.episodes.length} used them</small> : null}</h2>
          <Defaults series={series} overview={overview} template={template} />
          <div className="ns-go">
            <button className="btn primary big" disabled={busy || !ready} title={ready ? undefined : isEdit ? "pick a song and add clips first" : "write a brief or paste a script first"} onClick={() => void create(true)}>
              {busy ? "Starting…" : isEdit ? "Cut it to the song" : series && overview ? `Draft episode ${overview.next}` : "Draft it with Claude"}
            </button>
            <button className="btn big" disabled={busy} onClick={() => void create(false)}>Start from an empty timeline</button>
            <p className="ns-sub">The editor opens at once; a draft lands in it in a minute or two. Nothing renders until Export.</p>
          </div>
        </section>
      </div>

      {series && overview && overview.episodes.length > 0 && (
        <div className="ns-episodes">
          <h4>{series.name} so far</h4>
          <div className="ns-ep-row">
            {overview.episodes.map((e) => (
              <button key={e.id} className="ns-ep" onClick={() => go({ name: "video", id: e.id, tab: "watch" })}>
                <b>{e.episode ? `Ep ${e.episode} · ` : ""}{e.title}</b>
                <span>{e.seconds ? clock(e.seconds) : "no timing yet"} · {e.status}</span>
              </button>
            ))}
            <div className="ns-ep next">+ Ep {overview.next}{title.trim() ? ` · ${title.trim()}` : ""}</div>
          </div>
        </div>
      )}
    </main>
  );
}
