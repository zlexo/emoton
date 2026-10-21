/**
 * Exporting a Short. Each scene renders video-only (render/scenes/<key>.mp4)
 * keyed by everything that shows during it, so a note on one scene renders
 * one scene again; the scenes are joined without re-encoding. The sound is
 * mixed once with ffmpeg from the same layers the player plays (the voice's
 * pieces, the score or song, each sound at its time), then the picture and
 * the mix are mastered to -14 LUFS under -1 dBTP and checked (loudness.ts).
 * The presets write into the bundle's out/ folder, named for posting.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_PRESETS, type Short } from "../schema/short.ts";
import { estimatedVoice, voiceMatches } from "../src/core/short/estimate.ts";
import { resolveShort, type ResolvedShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { shortFrames, type ShortMedia } from "../src/remotion/shorts/props.ts";
import { master } from "./loudness.ts";
import { Cancelled, run, throwIfAborted } from "./proc.ts";
import { ROOT, isFile, maybe, paths, readJson, slugOf } from "./project.ts";
import { getBundle, linkInto } from "./render.ts";
import { loadShort, SHORT_VOICE, spokenScenes } from "./short.ts";
import { ensureCodeTyping, ensureScore, ensureSoundClips } from "./sound/render.ts";
import { sceneCode } from "./short-code.ts";
import type { ChapterTiming } from "../schema/storyboard.ts";

export type ShortPreset = (typeof EXPORT_PRESETS)[number];
export const PRESET_LABEL: Record<ShortPreset, string> = {
  tiktok: "TikTok and Shorts (1080x1920, mastered)", nomusic: "No music (for a platform sound)", phone: "Phone copy (720p, under 6 MB)",
  audio: "Audio only (m4a)", stills: "Stills (a strip of frames)",
};
/** What an export makes when the Short names nothing: the main file and a copy to send to a phone. */
export const DEFAULT_PRESETS: ShortPreset[] = ["tiktok", "phone"];
/** A phone copy stays under this many bytes. */
export const PHONE_LIMIT = 6 * 1024 * 1024;

const sha = (x: unknown) => createHash("sha1").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex").slice(0, 16);
const r3 = (x: number) => +x.toFixed(3);

/** Each scene's frames, back to back from 0 to the last frame, as the composition lays them. */
export function sceneFrames(s: ResolvedShort): { id: string; first: number; last: number }[] {
  const fps = s.canvas.fps, total = shortFrames(s);
  const starts = s.scenes.map((x) => Math.round(x.from * fps));
  return s.scenes.map((x, i) => ({ id: x.id, first: starts[i]!, last: (i + 1 < starts.length ? starts[i + 1]! : total) - 1 })).filter((r) => r.last >= r.first);
}

/** The composition's own code, so a change to how Shorts are drawn renders every scene again. */
let drawn: string | null = null;
const drawing = () => (drawn ??= sha(["ShortVideo.tsx", "props.ts"].map((f) => readFileSync(join(ROOT, "src", "remotion", "shorts", f), "utf8")).join("\n")));

/**
 * What a scene's picture is made of: the scene, its footage file, and every
 * caption, text clip and effect that shows during it (a punch-in settles for
 * 0.6 s after it lands). The same key means the same frames.
 */
export function sceneKey(s: ResolvedShort, i: number, footage: string | undefined, code = drawing(), typed?: unknown): string {
  const sc = s.scenes[i]!, a = sc.from, b = sc.from + sc.seconds;
  const range = sceneFrames(s)[i];
  const during = <T extends { from: number; to: number }>(xs: T[]) => xs.filter((x) => x.from < b && x.to > a);
  const st = footage && existsSync(footage) ? statSync(footage) : null;
  return sha({
    code, canvas: s.canvas, scene: sc, range, file: st ? [st.size, st.mtimeMs] : null,
    captions: during(s.captions), style: s.captionStyle, text: during(s.text.map((t) => ({ ...t }))),
    fx: s.fx.filter((f) => f.at >= a - 0.6 && f.at < b), typed: typed ?? null,
  });
}

export type MixLayer = { file: string; at: number; from?: number; to?: number; gainDb: number; duck?: { depthDb: number; spans: [number, number][] } };

/** The layers of a Short's sound, as files in time: the voice's pieces, the music, every sound. */
export function mixLayers(s: ResolvedShort, files: { voice?: string; music?: string; sounds: Record<string, string>; assets: Record<string, string>; sfx?: Record<number, string> }, o: { music: boolean }): MixLayer[] {
  const layers: MixLayer[] = [];
  if (files.voice) for (const p of s.voice) layers.push({ file: files.voice, at: p.at, from: p.from, to: p.to, gainDb: 0 });
  const m = s.music;
  if (o.music && m && files.music) {
    const song = "file" in m.source;
    const offset = song && "file" in m.source ? m.source.file.offset : 0;
    // a song sinks under the voice (through gaps shorter than hold); the score has it built in
    const spans: [number, number][] = [];
    if (song && m.duck.depthDb) for (const [a, b] of m.speech) {
      const last = spans[spans.length - 1];
      if (last && a - last[1] < (m.duck.hold ?? 0)) last[1] = Math.max(last[1], b);
      else spans.push([a, b]);
    }
    layers.push({ file: files.music, at: Math.max(0, -offset), from: Math.max(0, offset), gainDb: m.gainDb, ...(spans.length ? { duck: { depthDb: m.duck.depthDb, spans } } : {}) });
  }
  for (const [i, x] of s.sfx.entries()) {
    const file = files.sfx?.[i] ?? (x.asset ? files.assets[x.asset] : x.take !== undefined ? files.sounds[`${x.kind}:${x.take}`] : undefined);
    if (!file) continue;
    // a sound placed before 0 (a scratch before the first line) starts part-way in
    layers.push({ file, at: Math.max(0, x.at), ...(x.at < 0 ? { from: -x.at } : {}), gainDb: x.gainDb });
  }
  return layers;
}

/** ffmpeg arguments that mix the layers into one 48 kHz stereo WAV exactly `total` seconds long. */
export function mixArgs(layers: MixLayer[], total: number, out: string): string[] {
  const inputs = [...new Set(layers.map((l) => l.file))];
  const uses = new Map<string, number>();
  for (const l of layers) uses.set(l.file, (uses.get(l.file) ?? 0) + 1);
  const parts: string[] = [];
  // each input split as many times as it is used
  inputs.forEach((f, i) => {
    const n = uses.get(f)!;
    parts.push(n > 1 ? `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=${n}${Array.from({ length: n }, (_, k) => `[i${i}_${k}]`).join("")}` : `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[i${i}_0]`);
  });
  const next = new Map<string, number>();
  const labels = layers.map((l, k) => {
    const i = inputs.indexOf(l.file), u = next.get(l.file) ?? 0;
    next.set(l.file, u + 1);
    const chain: string[] = [];
    if (l.from !== undefined || l.to !== undefined) chain.push(`atrim=${l.from !== undefined ? `start=${r3(l.from)}` : ""}${l.from !== undefined && l.to !== undefined ? ":" : ""}${l.to !== undefined ? `end=${r3(l.to)}` : ""}`, "asetpts=PTS-STARTPTS");
    if (l.gainDb) chain.push(`volume=${l.gainDb.toFixed(2)}dB`);
    if (l.duck) {
      const when = l.duck.spans.map(([a, b]) => `between(t,${r3(a - l.at)},${r3(b - l.at)})`).join("+");
      chain.push(`volume='if(${when},${(10 ** (l.duck.depthDb / 20)).toFixed(4)},1)':eval=frame`);
    }
    if (l.at > 0) chain.push(`adelay=${Math.round(l.at * 1000)}:all=1`);
    parts.push(`[i${i}_${u}]${chain.length ? chain.join(",") : "anull"}[l${k}]`);
    return `[l${k}]`;
  });
  parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,apad,atrim=end=${r3(total)}[mix]`);
  return ["-hide_banner", "-loglevel", "error", "-y", ...inputs.flatMap((f) => ["-i", f]), "-filter_complex", parts.join(";"), "-map", "[mix]", "-ar", "48000", "-ac", "2", out];
}

/** The video bitrate (kbit/s) that keeps a phone copy of `seconds` under the limit with 128 kbit/s sound. */
export const phoneBitrate = (seconds: number, limit = PHONE_LIMIT) => Math.max(300, Math.min(2500, Math.floor((limit * 8 * 0.9) / seconds / 1000 - 128)));

export type ExportOptions = { presets?: ShortPreset[]; soundsRoot?: string; signal?: AbortSignal; log?: (l: string) => void; progress?: (p: number, detail?: string) => void };

/** Exports the Short with its presets; the files written, absolute. */
export async function exportShort(dir: string, o: ExportOptions = {}): Promise<string[]> {
  const P = paths(dir);
  const doc: Short = loadShort(dir);
  const presets = o.presets?.length ? o.presets : doc.exportPresets?.length ? doc.exportPresets : DEFAULT_PRESETS;
  const log = (l: string) => o.log?.(l);
  // the voice must match the script: an export never ships an estimate
  const voiced = isFile(P.timing(SHORT_VOICE)) ? maybe(() => readJson<ChapterTiming>(P.timing(SHORT_VOICE))) : undefined;
  const narrated = spokenScenes(doc).length > 0;
  if (narrated && !(voiced && voiceMatches(doc, voiced))) throw new Error("the voice no longer matches the script: voice it before exporting");
  const voice: VoiceTiming = narrated ? voiced! : estimatedVoice(doc);
  const s = resolveShort(doc, { voice });
  const fps = s.canvas.fps;

  // ---- the picture, scene by scene
  const footage: Record<string, string> = {};
  for (const sc of doc.scenes) {
    const v = sc.visual;
    const rel = v?.type === "shot" ? `shots/${sc.id}.mp4` : v?.type === "clip" ? v.asset : undefined;
    if (rel && isFile(join(dir, rel))) footage[sc.id] = join(dir, rel);
  }
  const code = sceneCode(dir, doc, s);
  const ranges = sceneFrames(s);
  const keys = s.scenes.map((sc, i) => sceneKey(s, i, footage[sc.footage.scene], undefined, code[sc.id] ? sha(code[sc.id]!) : undefined));
  const sceneDir = join(dir, "render", "scenes");
  mkdirSync(sceneDir, { recursive: true });
  const todo = ranges.map((r, i) => ({ ...r, key: keys[i]! })).filter((r) => !isFile(join(sceneDir, `${r.key}.mp4`)));
  log(`export: ${ranges.length - todo.length} of ${ranges.length} scenes unchanged, ${todo.length} to render`);
  if (todo.length) {
    const { openBrowser, renderMedia, selectComposition, makeCancelSignal } = await import("@remotion/renderer");
    const { serveUrl, publicDir } = await getBundle(o.log);
    const linked: string[] = [];
    // the scenes render muted: only what is seen is linked in
    const media: ShortMedia = { footage: {}, files: {}, ...(Object.keys(code).length ? { code } : {}) };
    for (const [id, f] of Object.entries(footage)) linked.push((media.footage[id] = linkInto(publicDir, f)));
    for (const sc of doc.scenes) if (sc.visual?.type === "card" && sc.visual.background && isFile(join(dir, sc.visual.background))) linked.push((media.files![sc.visual.background] = linkInto(publicDir, join(dir, sc.visual.background))));
    const inputProps = { short: s, media } as unknown as Record<string, unknown>;
    const { cancelSignal, cancel } = makeCancelSignal();
    const onAbort = () => cancel();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const browser = await openBrowser("chrome");
    try {
      const composition = await selectComposition({ serveUrl, id: "Short", inputProps, puppeteerInstance: browser });
      for (const [n, r] of todo.entries()) {
        throwIfAborted(o.signal);
        const part = join(sceneDir, `${r.key}.part.mp4`);
        await renderMedia({
          composition, serveUrl, inputProps, codec: "h264", crf: 16, jpegQuality: 95, frameRange: [r.first, r.last], muted: true, outputLocation: part,
          puppeteerInstance: browser, cancelSignal, concurrency: 2, overwrite: true,
          onProgress: ({ progress }) => o.progress?.(((n + progress) / todo.length) * 0.8, `rendering scene ${r.id} (${n + 1} of ${todo.length})`),
        });
        renameSync(part, join(sceneDir, `${r.key}.mp4`));
      }
    } catch (e) {
      if (o.signal?.aborted) throw new Cancelled();
      throw e;
    } finally {
      o.signal?.removeEventListener("abort", onAbort);
      for (const f of linked) rmSync(join(publicDir, f), { force: true });
      await browser.close({ silent: true }).catch(() => {});
    }
  }
  o.progress?.(0.8, "joining the scenes");
  const list = join(dir, "render", "scenes.txt");
  writeFileSync(list, ranges.map((_, i) => `file '${join(sceneDir, `${keys[i]}.mp4`).replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const picture = join(dir, "render", "short.video.mp4");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", picture], { signal: o.signal });

  // ---- the sound, and the masters
  const scoreRel = ensureScore(dir, s);
  const keyDir = o.soundsRoot ? join(o.soundsRoot, "keys") : undefined;
  const clips = ensureSoundClips(dir, s, keyDir);
  const typed = ensureCodeTyping(dir, s, code, keyDir);
  const m = s.music;
  const files = {
    voice: narrated ? P.audio(SHORT_VOICE) : undefined,
    music: scoreRel ? join(dir, scoreRel) : m && "file" in m.source && isFile(join(dir, m.source.file.asset)) ? join(dir, m.source.file.asset) : undefined,
    sounds: Object.fromEntries(Object.entries(clips).map(([k, rel]) => [k, join(dir, rel)])),
    assets: Object.fromEntries(s.sfx.filter((x) => x.asset && isFile(join(dir, x.asset))).map((x) => [x.asset!, join(dir, x.asset!)])),
    sfx: Object.fromEntries(Object.entries(typed).map(([i, rel]) => [i, join(dir, rel)])),
  };
  const total = shortFrames(s) / fps;
  const slug = slugOf(dir);
  mkdirSync(join(dir, "out"), { recursive: true });
  const written: string[] = [];
  const masterWith = async (music: boolean, out: string) => {
    const mix = join(dir, "render", music ? "short.mix.wav" : "short.nomusic.wav");
    const layers = mixLayers(s, files, { music });
    if (!layers.length) throw new Error("nothing to hear: no voice, music or sound");
    await run("ffmpeg", mixArgs(layers, total, mix), { signal: o.signal });
    const muxed = join(dir, "render", "short.muxed.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", picture, "-i", mix, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", muxed], { signal: o.signal });
    const part = out.replace(/\.mp4$/, ".part.mp4");
    await master(muxed, part, { signal: o.signal, log: o.log });
    renameSync(part, out);
    rmSync(muxed, { force: true });
    written.push(out);
  };
  o.progress?.(0.85, "mixing and mastering");
  await masterWith(true, P.final);
  if (presets.includes("nomusic") && m) await masterWith(false, join(dir, "out", `${slug} (no music).mp4`));
  if (presets.includes("phone")) {
    o.progress?.(0.92, "the phone copy");
    const out = join(dir, "out", `${slug} (phone).mp4`);
    let kbps = phoneBitrate(total);
    for (let pass = 0; pass < 3; pass++) {
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", P.final, "-vf", "scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "medium", "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.3)}k`, "-bufsize", `${kbps * 2}k`, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out], { signal: o.signal });
      if (statSync(out).size <= PHONE_LIMIT) break;
      kbps = Math.floor(kbps * 0.8);
    }
    written.push(out);
  }
  if (presets.includes("audio")) {
    const out = join(dir, "out", `${slug}.m4a`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", P.final, "-vn", "-c:a", "copy", out], { signal: o.signal });
    written.push(out);
  }
  if (presets.includes("stills")) {
    // the middle of each scene, side by side
    const out = join(dir, "out", `${slug} (stills).jpg`);
    const at = s.scenes.map((x) => Math.round((x.from + x.seconds / 2) * fps));
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", P.final, "-vf", `select='${at.map((f) => `eq(n\\,${f})`).join("+")}',scale=270:-2,tile=${at.length}x1`, "-frames:v", "1", "-fps_mode", "passthrough", out], { signal: o.signal });
    written.push(out);
  }
  // thumbnails for the library: a frame from the first scene's middle
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(r3(s.scenes[0]!.seconds / 2)), "-i", P.final, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "3", P.thumb], { signal: o.signal }).catch(() => {});
  pruneScenes(dir, keys);
  o.progress?.(1);
  log(`export: ${written.map((f) => f.split("/").pop()).join(", ")}`);
  return written;
}

/** Scenes rendered for keys no longer in use, removed (they are only a cache). */
export function pruneScenes(dir: string, keep: string[]) {
  const sceneDir = join(dir, "render", "scenes");
  if (!existsSync(sceneDir)) return;
  const live = new Set(keep.map((k) => `${k}.mp4`));
  for (const f of readdirSafe(sceneDir)) if (f.endsWith(".mp4") && !live.has(f)) rmSync(join(sceneDir, f), { force: true });
}
const readdirSafe = (d: string) => maybe(() => readdirSync(d)) ?? [];
