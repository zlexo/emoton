/**
 * A Short's sound, made on the server for the player and the export: the
 * score rendered from the resolved music plan (render/score-<hash>.wav, made
 * again only when the plan changes), and each built-in sound effect as a
 * short clip (render/sfx/<kind>-<take>.wav) the composition places at its
 * time, so moving a sound needs nothing rendered.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Marker } from "../../schema/short.ts";
import type { ResolvedMusic, ResolvedShort } from "../../src/core/short/resolve.ts";
import { writeWav } from "../wav.ts";
import { beat, STYLES, type Style } from "./beat.ts";
import { score } from "./score.ts";
import { builtIn, loadKeySlices, MASH_SECONDS, SR, typing } from "./synth.ts";
import type { Timeline } from "../../src/core/short/code/timeline.ts";

const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);
const db = (x: number) => 10 ** (x / 20);

/** A clip brought under the peak, the way Code Typer's effects track was. */
function underPeak(s: Float32Array, peak = 0.95): Float32Array {
  let m = 0;
  for (const v of s) m = Math.max(m, Math.abs(v));
  if (m > peak) for (let i = 0; i < s.length; i++) s[i]! *= peak / m;
  return s;
}

/** The score as samples, from the resolved music plan (synthesized music only). */
export function synthesizeScore(m: ResolvedMusic, total: number): Float32Array | null {
  if (!("synth" in m.source)) return null;
  const sy = m.source.synth;
  if (sy.style === "pad") {
    return score({ bpm: sy.bpm, total, lifts: sy.lifts, speech: m.speech, duck: db(m.duck.depthDb), hold: m.duck.hold, ...(sy.seed !== undefined ? { seed: sy.seed } : {}) });
  }
  const style = (STYLES as readonly string[]).includes(sy.style) ? (sy.style as Style) : "trap";
  return beat({ bpm: sy.bpm, total, hookEnd: sy.hookEnd, drop: sy.drop, cuts: sy.cuts, style, ...(sy.seed !== undefined ? { seed: sy.seed } : {}) });
}

/** The score file for this plan, bundle-relative, made when missing; older scores are removed. Null for a song or no music. */
export function ensureScore(dir: string, short: ResolvedShort): string | null {
  const m = short.music;
  if (!m || !("synth" in m.source)) return null;
  const plan = { source: m.source, speech: "pad" === m.source.synth.style ? m.speech : [], duck: m.duck, total: short.duration };
  const name = `score-${hash(plan)}.wav`;
  const folder = join(dir, "render");
  if (!existsSync(join(folder, name))) {
    const s = synthesizeScore(m, short.duration)!;
    mkdirSync(folder, { recursive: true });
    writeWav(join(folder, name), { sr: SR, audio: s });
    for (const f of readdirSync(folder)) if (/^score-[0-9a-f]+\.wav$/.test(f) && f !== name) rmSync(join(folder, f), { force: true });
  }
  return `render/${name}`;
}

/** What the key recordings are, so mash and keys clips are made again when the recordings change. */
function keySignature(keyDir: string | undefined): string {
  if (!keyDir || !existsSync(keyDir)) return "synth";
  const files = readdirSync(keyDir).filter((f) => /\.(wav|mp3|m4a|ogg|flac|aiff?)$/i.test(f)).sort();
  return files.length ? hash(files.map((f) => [f, statSync(join(keyDir, f)).mtimeMs])) : "synth";
}

/** The built-in sound clips the Short plays, made when missing: `${kind}:${take}` to a bundle-relative path. */
export function ensureSoundClips(dir: string, short: ResolvedShort, keyDir?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const folder = join(dir, "render", "sfx");
  const keySig = keySignature(keyDir);
  short.sfx.forEach((x) => {
    const take = x.take;
    if (take === undefined) return;
    const id = `${x.kind}:${take}`;
    if (out[id]) return;
    const usesKeys = x.kind === "mash" || x.kind === "keys";
    const name = `${x.kind}-${take}${usesKeys ? `-${keySig}` : ""}.wav`;
    if (!existsSync(join(folder, name))) {
      mkdirSync(folder, { recursive: true });
      writeWav(join(folder, name), { sr: SR, audio: underPeak(builtIn(x.kind as Marker, take, keyDir)) });
    }
    out[id] = `render/sfx/${name}`;
  });
  return out;
}

/**
 * The typing for each code scene, following its keystrokes (render/sfx/typing-<scene>-<hash>.wav), mapped to the
 * resolved sfx list: a keys sound at a code scene's start plays it. Code Typer's code chapters skipped the keys
 * pressed under the opening mash, so these do too.
 */
export function ensureCodeTyping(dir: string, short: ResolvedShort, code: Record<string, { tl: Timeline }>, keyDir?: string): Record<number, string> {
  const out: Record<number, string> = {};
  const folder = join(dir, "render", "sfx");
  for (const [id, c] of Object.entries(code)) {
    const sc = short.scenes.find((x) => x.id === id);
    if (!sc) continue;
    const i = short.sfx.findIndex((x) => x.kind === "keys" && Math.abs(x.at - sc.from) < 0.02);
    if (i < 0) continue;
    const keys = c.tl.keys.filter((k) => k.t >= MASH_SECONDS - 0.05);
    const name = `typing-${id}-${hash({ keys, d: c.tl.duration, k: keySignature(keyDir) })}.wav`;
    if (!existsSync(join(folder, name))) {
      mkdirSync(folder, { recursive: true });
      writeWav(join(folder, name), { sr: SR, audio: typing(keys, c.tl.duration, loadKeySlices(keyDir), 3) });
    }
    out[i] = `render/sfx/${name}`;
  }
  return out;
}

