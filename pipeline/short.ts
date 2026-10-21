/**
 * A Short's voice and its preview. The voice stage speaks the spoken scenes'
 * lines (one voice part per spoken scene, one sentence per line) into chapter
 * 1's files: audio/ch1.spoken.wav and its timing, then audio/ch1.wav and
 * render/ch1.timing.json with the pause edits in voice-edits.json chapter
 * "1" applied. So the Voice tab's pause editor works on a Short unchanged.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Short } from "../schema/short.ts";
import type { ChapterTiming } from "../schema/storyboard.ts";
import { estimatedVoice, SHORT_GAPS, spokenScenes, voiceMatches } from "../src/core/short/estimate.ts";
import { checkShort, resolveShort, type Problem, type VoiceTiming } from "../src/core/short/resolve.ts";
import type { ShortMedia, ShortVideoProps } from "../src/remotion/shorts/props.ts";
import { isFile, loadProject, maybe, paths, readJson, writeJson, type Project } from "./project.ts";
import { footageFiles, needsProxy, playable } from "./proxy.ts";
import { DRAFT_FILE, type DraftNotes } from "./short-draft.ts";
import { ASK_FILE, type AskProposal } from "./short-ask.ts";
import { shotStates, type ShotState } from "./shots.ts";
import { ensureCodeTyping, ensureScore, ensureSoundClips } from "./sound/render.ts";
import { sceneCode } from "./short-code.ts";
import { speakPy, type Tts, type TtsJob } from "./voice.ts";
import { applyChapterEdits } from "./voice-edits.ts";

export { estimatedVoice, SHORT_GAPS, spokenScenes };

/** The chapter whose files hold a Short's voice. */
export const SHORT_VOICE = 1;
export const loadShort = (dir: string): Short => readJson(paths(dir).short, Short);

const voiceSettings = (doc: Short, p: Project) => {
  const v = doc.voice ?? p.voice;
  return { engine: v.engine, voice: v.voice, speed: v.speed, gaps: doc.voice?.gaps ?? SHORT_GAPS };
};

/** Everything the voice is made from: a change to any of it means voicing again. */
export function voiceKey(doc: Short, p: Project, pronounce: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify({ ...voiceSettings(doc, p), beats: spokenScenes(doc), pronounce })).digest("hex").slice(0, 16);
}

const keyFile = (dir: string) => join(dir, "render", "short-voice.json");

export function voiceStatus(dir: string, doc: Short, p: Project, pronounce: Record<string, string>): "missing" | "ok" | "stale" {
  const P = paths(dir);
  if (!isFile(P.timing(SHORT_VOICE)) || !existsSync(P.audio(SHORT_VOICE))) return "missing";
  return maybe(() => readJson<{ key: string }>(keyFile(dir)).key) === voiceKey(doc, p, pronounce) ? "ok" : "stale";
}

export type ShortVoiceOptions = {
  signal?: AbortSignal;
  pronounce: Record<string, string>;
  onProgress?: (done: number, total: number) => void;
  log?: (line: string) => void;
  tts?: Tts;
};

/** Voices the Short's narration, then applies its pause edits. */
export async function voiceShort(dir: string, o: ShortVoiceOptions): Promise<ChapterTiming> {
  const P = paths(dir);
  const doc = loadShort(dir);
  const p = loadProject(dir);
  const beats = spokenScenes(doc);
  if (!beats.length) throw new Error("this Short has no narration to voice");
  const v = voiceSettings(doc, p);
  const part = P.audio(SHORT_VOICE).replace(/\.wav$/, ".part.wav");
  const job: TtsJob = {
    engine: v.engine, voice: v.voice, speed: v.speed, gaps: v.gaps, cacheDir: P.ttsCache, out: part, pronounce: o.pronounce,
    beats: beats.map((say) => ({ say, aha: false })),
  };
  mkdirSync(dirname(part), { recursive: true });
  let out: string;
  try {
    out = await (o.tts ?? speakPy)(job, {
      signal: o.signal,
      onStderrLine: (line) => {
        const m = /^progress (\d+) (\d+)$/.exec(line.trim());
        if (m) o.onProgress?.(Number(m[1]), Number(m[2]));
        else if (line.trim()) o.log?.(line);
      },
    });
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const r = JSON.parse(out) as ChapterTiming & { stats?: { synthesised: number; cached: number } };
  renameSync(part, P.spokenAudio(SHORT_VOICE));
  writeJson(P.spokenTiming(SHORT_VOICE), { leadIn: r.leadIn, duration: r.duration, audio: P.spokenAudioRel(SHORT_VOICE), beats: r.beats } satisfies ChapterTiming);
  const e = applyChapterEdits(dir, SHORT_VOICE);
  writeJson(keyFile(dir), { key: voiceKey(doc, p, o.pronounce) });
  const timing = readJson<ChapterTiming>(P.timing(SHORT_VOICE));
  o.log?.(`voice: ${r.duration.toFixed(1)} s${r.stats ? `, ${r.stats.synthesised} sentences synthesised, ${r.stats.cached} cached` : ""}`);
  if (e.applied) o.log?.(`voice: ${e.applied} pause edit(s) applied, ${timing.duration.toFixed(1)} s`);
  if (e.dropped.length) o.log?.(`voice: ${e.dropped.length} pause edit(s) for lines no longer in the script`);
  return timing;
}

/** The props to play and the voice timing they were resolved against (so the editor can re-resolve edits itself), or what stops the document from resolving. */
export type ShortPreview = { props: ShortVideoProps; voiced: boolean; timing: VoiceTiming; exports: { name: string; url: string; size: number; at: string }[]; shots: ShotState[]; clips: string[]; proxies: string[]; draft?: DraftNotes; ask?: AskProposal } | { problems: Problem[] };

/**
 * The Short composition's props for this bundle: resolved against its voice
 * when the voice still matches the script, else against a silent estimate.
 * `url` turns a bundle-relative path into what the player loads; footage
 * plays from its proxy when that is fresh, and files not on disk yet (a shot
 * still rendering) are left out and drawn as placeholders.
 */
export function shortPreview(dir: string, url: (rel: string) => string, o: { soundsRoot?: string } = {}): ShortPreview {
  const P = paths(dir);
  const doc = loadShort(dir);
  const voiced = isFile(P.timing(SHORT_VOICE)) && existsSync(P.audio(SHORT_VOICE))
    ? maybe(() => readJson<ChapterTiming>(P.timing(SHORT_VOICE)))
    : undefined;
  const usable = !!voiced && voiceMatches(doc, voiced);
  const voice: VoiceTiming = usable ? voiced! : estimatedVoice(doc);
  const problems = checkShort(doc, { voice });
  if (problems.length) return { problems };
  const short = resolveShort(doc, { voice });
  const have = (rel: string) => isFile(join(dir, rel));
  const media: ShortMedia = { footage: {}, files: {} };
  for (const s of doc.scenes) {
    const v = s.visual;
    const rel = v?.type === "shot" ? `shots/${s.id}.mp4` : v?.type === "clip" ? v.asset : undefined;
    // the editor plays the light proxy when it is fresh
    if (rel && have(rel)) media.footage[s.id] = url(playable(dir, rel));
    if (v?.type === "card" && v.background && have(v.background)) media.files![v.background] = url(v.background);
  }
  for (const x of doc.sfx) if (x.asset && have(x.asset)) media.files![x.asset] = url(x.asset);
  for (const a of Object.values(doc.soundKit ?? {})) if (a && have(a)) media.files![a] = url(a);
  if (usable) media.voice = url(P.audioRel(SHORT_VOICE));
  const m = doc.music;
  if (m && "file" in m.source && have(m.source.file.asset)) media.music = url(m.source.file.asset);
  // the score made from the document, and the built-in sounds' clips (each made once, then cached)
  const score = ensureScore(dir, short);
  if (score) media.music = url(score);
  const keyDir = o.soundsRoot ? join(o.soundsRoot, "keys") : undefined;
  const clips = ensureSoundClips(dir, short, keyDir);
  media.sounds = Object.fromEntries(Object.entries(clips).map(([k, rel]) => [k, url(rel)]));
  // code scenes: their typing timelines, and their keyboard sound following the keystrokes
  let code: ReturnType<typeof sceneCode>;
  try {
    code = sceneCode(dir, doc, short);
  } catch (e) {
    return { problems: [{ at: "code", message: (e as Error).message }] };
  }
  if (Object.keys(code).length) {
    media.code = code;
    media.sfx = Object.fromEntries(Object.entries(ensureCodeTyping(dir, short, code, keyDir)).map(([i, rel]) => [i, url(rel)]));
  }
  // what the last export wrote, newest first
  const outDir = join(dir, "out");
  const exports = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => /\.(mp4|m4a|jpg)$/.test(f) && !f.includes(".part.")).map((f) => {
      const st = statSync(join(outDir, f));
      return { name: f, url: url(`out/${f}`), size: st.size, at: st.mtime.toISOString() };
    }).sort((a, b) => b.at.localeCompare(a.at))
    : [];
  const clipDir = join(dir, "assets", "clips");
  const clipFiles = existsSync(clipDir) ? readdirSync(clipDir).filter((f) => /\.(mp4|mov|m4v|webm)$/i.test(f) && !f.includes(".part.")).map((f) => `assets/clips/${f}`) : [];
  return { props: { short, media }, voiced: usable, timing: voice, exports, shots: shotStates(dir, short), clips: clipFiles, proxies: footageFiles(doc).filter((f) => needsProxy(dir, f)),
    ...(isFile(join(dir, DRAFT_FILE)) ? { draft: maybe(() => readJson<DraftNotes>(join(dir, DRAFT_FILE))) } : {}),
    ...(isFile(join(dir, ASK_FILE)) ? { ask: maybe(() => readJson<AskProposal>(join(dir, ASK_FILE))) } : {}) };
}
