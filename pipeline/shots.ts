/**
 * Perdix shots for Shorts (sources/perdix/README.md). A shot renders headless
 * through the shot tool built at the series' pinned Perdix commit: raw RGBA
 * frames at 2160x3840 piped through ffmpeg down to 1080x1920, into the
 * Short's shots/<scene>.mp4, beside it the key it was made from, so a shot
 * renders again only when its knobs, length or build change. Also: the start
 * searches (walk-search, stuck-search), and building the tool at a commit in
 * Emoton's own worktree of Perdix, never the live checkout.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedShort, ShotRequest } from "../src/core/short/resolve.ts";
import { Cancelled, run } from "./proc.ts";
import { ROOT, isFile, maybe } from "./project.ts";
import { makeProxy } from "./proxy.ts";

export const SHOTS = join(ROOT, "sources", "perdix");
const home = homedir();
/** Perdix's own checkout (only read: its git objects and its build's dependencies). */
export const PERDIX_REPO = process.env.EMOTON_PERDIX_REPO ?? join(home, "yt", "perdix");
/** Emoton's checkouts of Perdix, one per pinned commit: the assets a shot loads, and where a tool is built. */
export const PERDIX_CHECKOUTS = process.env.EMOTON_PERDIX_CHECKOUTS ?? join(home, "yt", "emoton-perdix");
const VULKAN_SDK = process.env.VULKAN_SDK ?? join(home, "VulkanSDK", "1.4.363.0", "macOS");

/** Where the built tools are (sources/perdix/bin; EMOTON_SHOT_TOOLS moves it, as the tests do, so they never render). */
export const toolsDir = () => process.env.EMOTON_SHOT_TOOLS ?? join(SHOTS, "bin");
export const toolPath = (build: string) => join(toolsDir(), `shot-${build}`);
export const checkoutPath = (build: string) => join(PERDIX_CHECKOUTS, build);
export const hasTool = (build: string) => isFile(toolPath(build));

export type KnobSpec = { default: number; unit?: string; min?: number; max?: number; step?: number; switch?: boolean; time?: boolean; about?: string };
export type ShotKinds = { version: 1; kinds: Record<string, { about: string; knobs: Record<string, KnobSpec> }>; searches: Record<string, { for: string[]; about: string }> };
let kinds: ShotKinds | null = null;
export const shotKinds = (): ShotKinds => (kinds ??= JSON.parse(readFileSync(join(SHOTS, "kinds.json"), "utf8")) as ShotKinds);

/** A shot's frames: its length at 60 fps and 8 more, so its scene never runs out (Code Typer's margin). */
export const shotFrames = (seconds: number) => Math.ceil(seconds * 60) + 8;

/** The knobs as the tool reads them: environment strings (a switch as 1 or 0). */
export function shotEnv(knobs: ShotRequest["knobs"]): Record<string, string> {
  return Object.fromEntries(Object.entries(knobs).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]));
}

/** Everything a shot is made from: the same key, the same frames. */
export const shotKey = (r: ShotRequest) => JSON.stringify({ kind: r.kind, build: r.build, frames: shotFrames(r.seconds), env: shotEnv(r.knobs), sweep: r.sweep ?? null });

export type ShotState = { scene: string; kind: string; build: string; state: "ready" | "stale" | "missing" | "no-tool" };

/** Each shot of the Short: rendered from its knobs as they are (ready), from older ones (stale), not yet (missing), or without a tool for its build. */
export function shotStates(dir: string, short: ResolvedShort): ShotState[] {
  return short.shots.map((r) => {
    const mp4 = join(dir, "shots", `${r.scene}.mp4`), key = join(dir, "shots", `${r.scene}.key`);
    const base = { scene: r.scene, kind: r.kind, build: r.build };
    if (isFile(mp4) && maybe(() => readFileSync(key, "utf8")) === shotKey(r)) return { ...base, state: "ready" as const };
    if (!hasTool(r.build)) return { ...base, state: "no-tool" as const };
    return { ...base, state: isFile(mp4) ? ("stale" as const) : ("missing" as const) };
  });
}

/** The environment the tool runs in: its knobs, its assets checkout, and the Vulkan SDK's MoltenVK. */
function toolEnv(build: string, extra: Record<string, string>) {
  return {
    ...process.env, ...extra, PERDIX: checkoutPath(build), VULKAN_SDK,
    DYLD_LIBRARY_PATH: `${join(VULKAN_SDK, "lib")}${process.env.DYLD_LIBRARY_PATH ? `:${process.env.DYLD_LIBRARY_PATH}` : ""}`,
    VK_DRIVER_FILES: join(VULKAN_SDK, "share", "vulkan", "icd.d", "MoltenVK_icd.json"),
  };
}

/** The checkout of Perdix at `build`, made (a detached worktree of Perdix's own repo) when missing. */
export async function ensureCheckout(build: string, signal?: AbortSignal): Promise<string> {
  const p = checkoutPath(build);
  if (existsSync(join(p, "assets"))) return p;
  mkdirSync(PERDIX_CHECKOUTS, { recursive: true });
  await run("git", ["-C", PERDIX_REPO, "worktree", "add", "--detach", p, build], { signal });
  return p;
}

/** The tool piped into ffmpeg: `w`x`h` RGBA frames in, `vf` applied, an H.264 file out. */
function pipeShot(build: string, kind: string, w: number, h: number, frames: number, env: Record<string, string>, vf: string, out: string, o: { signal?: AbortSignal; onFrame?: (n: number) => void }): Promise<void> {
  return new Promise((resolveP, reject) => {
    const tool = spawn(toolPath(build), [kind, String(w), String(h), String(frames), "60"], { env: toolEnv(build, env), stdio: ["ignore", "pipe", "pipe"] });
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", "60", "-i", "pipe:0", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-pix_fmt", "yuv420p", out], { stdio: ["pipe", "ignore", "pipe"] });
    let log = "", fflog = "", bytes = 0;
    const frame = w * h * 4;
    tool.stderr.on("data", (d) => (log = (log + d).slice(-4000)));
    ff.stderr.on("data", (d) => (fflog = (fflog + d).slice(-2000)));
    tool.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      o.onFrame?.(Math.floor(bytes / frame));
    });
    tool.stdout.pipe(ff.stdin);
    const kill = () => (tool.kill("SIGKILL"), ff.kill("SIGKILL"));
    o.signal?.addEventListener("abort", kill, { once: true });
    let toolCode: number | null = null;
    tool.on("close", (c) => (toolCode = c));
    ff.on("close", (c) => {
      o.signal?.removeEventListener("abort", kill);
      if (o.signal?.aborted) return reject(new Cancelled());
      // a tool that fails must fail the render: ffmpeg would happily write an empty video from no frames
      if (toolCode !== 0) return reject(new Error(`shot ${kind} failed (${toolCode}): ${log.trim().split("\n").slice(-3).join(" | ")}`));
      if (c !== 0) return reject(new Error(`ffmpeg failed on shot ${kind}: ${fflog.trim()}`));
      resolveP();
    });
    tool.on("error", (e) => reject(e));
  });
}

const SKY = "abs(r(X,Y)-120)+abs(g(X,Y)-167)+abs(b(X,Y)-255)";

/** Renders one shot into shots/<scene>.mp4 (written through a .part file, so the old take plays until the new one is whole), its key beside it, then its proxy. */
export async function renderShot(dir: string, r: ShotRequest, o: { signal?: AbortSignal; progress?: (p: number) => void } = {}) {
  if (!hasTool(r.build)) throw new Error(`no shot tool built at Perdix ${r.build} (emoton shots build ${r.build})`);
  await ensureCheckout(r.build, o.signal);
  const folder = join(dir, "shots");
  mkdirSync(folder, { recursive: true });
  const frames = shotFrames(r.seconds);
  const env = shotEnv(r.knobs);
  const out = join(folder, `${r.scene}.mp4`), part = join(folder, `${r.scene}.part.mp4`);
  try {
    if (!r.sweep) {
      await pipeShot(r.build, r.kind, 2160, 3840, frames, env, "scale=1080:1920:flags=area", part, { signal: o.signal, onFrame: (n) => o.progress?.(n / frames) });
    } else {
      // two renders of one orbit, wireframe and textured, joined by a mask sweeping up at `at` for `len` seconds
      const wire = join(folder, `${r.scene}.wire.part.mp4`), fill = join(folder, `${r.scene}.fill.part.mp4`);
      try {
        await pipeShot(r.build, r.kind, 540, 960, frames, { ...env, LINES: "1", WHITE: "1", WIREFRAME: "1" },
          `format=rgb24,geq=r='if(lt(${SKY},40),r(X,Y),255)':g='if(lt(${SKY},40),g(X,Y),255)':b='if(lt(${SKY},40),b(X,Y),255)',scale=1080:1920:flags=neighbor`, wire, { signal: o.signal, onFrame: (n) => o.progress?.((n / frames) * 0.4) });
        await pipeShot(r.build, r.kind, 2160, 3840, frames, env, "scale=1080:1920:flags=area", fill, { signal: o.signal, onFrame: (n) => o.progress?.(0.4 + (n / frames) * 0.5) });
        const p = `clip((T-${r.sweep.at})/${r.sweep.len},0,1)`, edge = `lt(abs(Y-H*(1-${p})),3)*between(T,${r.sweep.at},${r.sweep.at}+${r.sweep.len})`;
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wire, "-i", fill, "-filter_complex",
          `[0]format=gbrp[w];[1]format=gbrp[f];color=c=black:s=1080x1920:r=60:d=${(r.seconds + 0.2).toFixed(3)},format=gbrp,geq=r='if(gte(Y,H*(1-${p})),255,0)':g='if(gte(Y,H*(1-${p})),255,0)':b='if(gte(Y,H*(1-${p})),255,0)'[m];[w][f][m]maskedmerge,geq=r='if(${edge},255,r(X,Y))':g='if(${edge},255,g(X,Y))':b='if(${edge},255,b(X,Y))',format=yuv420p`,
          "-c:v", "libx264", "-preset", "slow", "-crf", "14", part], { signal: o.signal });
      } finally {
        rmSync(wire, { force: true });
        rmSync(fill, { force: true });
      }
    }
    renameSync(part, out);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  writeFileSync(join(folder, `${r.scene}.key`), shotKey(r));
  await makeProxy(dir, `shots/${r.scene}.mp4`, o.signal);
  o.progress?.(1);
}

export type StartCandidate = { x: number; z: number; yaw: number; note: string } | { seed: number; note: string };

/** The tool's start search for a kind (walk: walk-search; perdix-stuck: stuck-search), with the scene's knobs as its area. */
export async function searchStarts(build: string, kind: string, knobs: Record<string, number | boolean | string>, signal?: AbortSignal): Promise<StartCandidate[]> {
  const search = Object.entries(shotKinds().searches).find(([, s]) => s.for.includes(kind))?.[0];
  if (!search) throw new Error(`no start search for ${kind} shots`);
  if (!hasTool(build)) throw new Error(`no shot tool built at Perdix ${build}`);
  await ensureCheckout(build, signal);
  const out = await new Promise<string>((resolveP, reject) => {
    const p = spawn(toolPath(build), [search, "1", "1", "1"], { env: toolEnv(build, shotEnv(knobs)), stdio: ["ignore", "pipe", "pipe"] });
    let text = "", err = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    signal?.addEventListener("abort", () => p.kill("SIGKILL"), { once: true });
    p.on("close", (c) => (c === 0 ? resolveP(text) : reject(new Error(`${search} failed: ${err.trim().split("\n").slice(-2).join(" | ")}`))));
  });
  return parseStarts(out);
}

/** A search's lines: starts ("WALK_X= WALK_Z= WALK_YAW= note") or lives ("SEED= what it does"). */
export function parseStarts(text: string): StartCandidate[] {
  return text.split("\n").flatMap((l): StartCandidate[] => {
    const m = /WALK_X=(-?[\d.]+) WALK_Z=(-?[\d.]+) WALK_YAW=(-?[\d.]+)\s*(.*)$/.exec(l.trim());
    if (m) return [{ x: Number(m[1]), z: Number(m[2]), yaw: Number(m[3]), note: m[4]!.trim() }];
    const s = /^SEED=(\d+)\s+(.*)$/.exec(l.trim());
    return s ? [{ seed: Number(s[1]), note: s[2]!.replace(/\s+\|/g, ",").replace(/\s+/g, " ").trim() }] : [];
  });
}

/** Builds the shot tool at a Perdix commit: the worktree, Perdix's libraries (dependencies from Perdix's own build), then build.sh. Long: minutes. */
export async function buildShotTool(commit: string, o: { signal?: AbortSignal; log?: (l: string) => void } = {}): Promise<string> {
  const p = await ensureCheckout(commit, o.signal);
  const deps = join(PERDIX_REPO, "build", "mac-release", "_deps");
  if (!existsSync(deps)) throw new Error(`Perdix's dependencies are not built (${deps}): build Perdix once in ${PERDIX_REPO}`);
  const sources = readdirSync(deps).filter((d) => d.endsWith("-src")).map((d) => `-DFETCHCONTENT_SOURCE_DIR_${d.slice(0, -4).toUpperCase().replace(/-/g, "_")}=${join(deps, d)}`);
  const build = join(p, "build", "shots");
  o.log?.(`shots: configuring Perdix ${commit}`);
  await run("cmake", ["--preset", "mac-release", "-B", build, "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", ...sources], { signal: o.signal, cwd: p });
  o.log?.(`shots: building Perdix ${commit} (a few minutes)`);
  await run("cmake", ["--build", build, "--target", "perdix", "-j", "3"], { signal: o.signal, cwd: p });
  await run("zsh", [join(SHOTS, "build.sh"), toolPath(commit)], { signal: o.signal, env: { ...process.env, PERDIX: p, PERDIX_BUILD: build, PERDIX_DEPS: deps } });
  o.log?.(`shots: built ${toolPath(commit)}`);
  return toolPath(commit);
}

// ---------------------------------------------------------------- the tools

const builds = new Map<string, { state: "building" | "failed"; log: string }>();
const git = (args: string[]) => maybe(() => execFileSync("git", ["-C", PERDIX_REPO, ...args], { encoding: "utf8" }).trim());

/** The commit a name stands for in Perdix's repo ("main": its main), short. */
export const perdixCommit = (name: string) => git(["rev-parse", "--short", name === "main" ? "origin/main" : name]) ?? null;

/** How many commits Perdix's main is ahead of a commit (undefined when either is unknown). */
export function behindMain(commit: string): number | undefined {
  const main = perdixCommit("main");
  const n = main ? git(["rev-list", "--count", `${commit}..${main}`]) : null;
  return n ? Number(n) : undefined;
}

/** The tools built, the builds running or failed, Perdix's main, and how far each built commit is behind it. */
export function perdixTools() {
  const bin = toolsDir();
  const built = existsSync(bin) ? readdirSync(bin).filter((f) => f.startsWith("shot-")).map((f) => f.slice(5)) : [];
  const main = perdixCommit("main");
  const behind = Object.fromEntries(built.map((c) => [c, behindMain(c) ?? 0]));
  return { built, building: Object.fromEntries(builds), main, behind };
}

/** Starts building the tool at a commit in the background; `done` is called when it ends either way. */
export function startToolBuild(commit: string, done: () => void) {
  if (builds.get(commit)?.state === "building") return;
  builds.set(commit, { state: "building", log: "" });
  const log = (l: string) => builds.set(commit, { state: "building", log: l });
  buildShotTool(commit, { log })
    .then(() => builds.delete(commit))
    .catch((e: Error) => builds.set(commit, { state: "failed", log: e.message.slice(-1500) }))
    .finally(done);
}

/** A tool built elsewhere taken as the tool for `commit`. */
export function adoptTool(binary: string, commit: string) {
  mkdirSync(toolsDir(), { recursive: true });
  copyFileSync(binary, toolPath(commit));
  chmodSync(toolPath(commit), 0o755);
}

