/** Doctor: checks the machine can make videos. Checks run in parallel with short timeouts. */
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, constants, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DoctorCheck, DoctorCheckId } from "../shared/api.ts";

export const VOICE_MODEL_FILES = [
  { name: "kokoro-v1.0.int8.onnx", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx" },
  { name: "voices-v1.0.bin", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" },
];

const GB = 1024 ** 3;

export type DoctorEnv = {
  repoRoot: string;
  libraryRoot: string;
  /** PATH to resolve binaries with (the server's own, captured at start). */
  path: string;
  modelFiles?: { name: string; url: string }[];
  /** Overrides for the free-disk thresholds (bytes). */
  diskWarn?: number;
  diskError?: number;
  /** Voice model download: wait this long for an answer, and abort after this long without data. */
  downloadTimeoutMs?: number;
  downloadStallMs?: number;
};

type Run = { ok: boolean; stdout: string; stderr: string; error?: string };

function run(file: string, args: string[], env: DoctorEnv, timeout = 5000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, killSignal: "SIGKILL", env: { ...process.env, PATH: env.path }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), ...(err ? { error: err.message } : {}) });
    });
  });
}

/**
 * PATH with the usual tool folders appended when missing: a GUI launch may
 * not pass the login shell's PATH, and claude and uv live in ~/.local/bin.
 */
export function augmentPath(path: string, home = homedir()): string {
  const parts = path.split(delimiter).filter(Boolean);
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin")]) if (!parts.includes(d)) parts.push(d);
  return parts.join(delimiter);
}

/** Finds an executable on PATH, like `which`. */
export async function findBin(name: string, path: string): Promise<string | null> {
  for (const d of path.split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    try {
      await access(p, constants.X_OK);
      if ((await stat(p)).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The nearest existing ancestor (for free-disk of a library root that does not exist yet). */
async function nearestExisting(p: string): Promise<string> {
  let cur = p;
  while (!(await exists(cur))) {
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return cur;
}

type CheckFn = (env: DoctorEnv) => Promise<Omit<DoctorCheck, "id" | "label">>;

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function binCheck(bin: string, args: string[], missing: Omit<DoctorCheck, "id" | "label">): CheckFn {
  return async (env) => {
    const p = await findBin(bin, env.path);
    if (!p) return missing;
    const r = await run(p, args, env);
    const version = firstLine(r.stdout) || firstLine(r.stderr);
    return { level: "ok", detail: version ? `${version} (${p})` : p };
  };
}

const CHECKS: { id: DoctorCheckId; label: string; fn: CheckFn }[] = [
  {
    id: "node",
    label: "Node.js",
    fn: async () => {
      const major = Number(process.versions.node.split(".")[0]);
      return major >= 22
        ? { level: "ok", detail: `Node ${process.version}` }
        : { level: "error", detail: `Node ${process.version} is too old (need 22 or newer)`, fix: "brew install node" };
    },
  },
  {
    id: "ffmpeg",
    label: "ffmpeg (joins and exports video)",
    fn: binCheck("ffmpeg", ["-version"], { level: "error", detail: "ffmpeg is not installed", fix: "brew install ffmpeg" }),
  },
  {
    id: "pdftotext",
    label: "pdftotext (reads PDF sources)",
    fn: binCheck("pdftotext", ["-v"], { level: "error", detail: "pdftotext is not installed", fix: "brew install poppler" }),
  },
  {
    id: "yt-dlp",
    label: "yt-dlp (YouTube sources)",
    fn: binCheck("yt-dlp", ["--version"], {
      level: "warn",
      detail: "yt-dlp is not installed; YouTube links cannot be used as sources",
      fix: "brew install yt-dlp",
    }),
  },
  {
    id: "claude-login",
    label: "Claude login (the writer)",
    fn: async (env) => {
      const p = await findBin("claude", env.path);
      if (!p) return { level: "error", detail: "The claude CLI is not installed", fix: "npm install -g @anthropic-ai/claude-code" };
      const r = await run(p, ["auth", "status"], env, 8000);
      let loggedIn = false, method = "";
      try {
        const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
        loggedIn = j.loggedIn === true;
        method = j.authMethod ?? "";
      } catch {
        return { level: "error", detail: `Could not read the login status (${firstLine(r.stderr) || r.error || "no output"})`, fix: "claude auth login" };
      }
      return loggedIn
        ? { level: "ok", detail: method ? `Logged in (${method})` : "Logged in" }
        : { level: "error", detail: "The writer needs you to log in once", fix: "claude auth login" };
    },
  },
  {
    id: "python-tts",
    label: "Voice engine (Python, Kokoro)",
    fn: async (env) => {
      const py = join(env.repoRoot, "tts", ".venv", "bin", "python");
      const fix = `cd ${shellQuote(join(env.repoRoot, "tts"))} && uv sync`;
      if (!(await exists(py))) return { level: "error", detail: "The voice engine is not installed", fix };
      const r = await run(py, ["-c", "import kokoro_onnx"], env, 15000);
      return r.ok
        ? { level: "ok", detail: "kokoro_onnx imports" }
        : { level: "error", detail: `The voice engine does not load (${firstLine(r.stderr) || r.error})`, fix };
    },
  },
  {
    id: "voice-model",
    label: "Voice model files (about 120 MB)",
    fn: async (env) => {
      const dir = join(env.repoRoot, "tts", "models");
      const files = env.modelFiles ?? VOICE_MODEL_FILES;
      const missing: string[] = [];
      for (const f of files) {
        try {
          if ((await stat(join(dir, f.name))).size === 0) missing.push(f.name);
        } catch {
          missing.push(f.name);
        }
      }
      if (missing.length === 0) return { level: "ok", detail: `Found in ${dir}` };
      return {
        level: "error",
        detail: `Missing ${missing.join(", ")} in ${dir}`,
        fix: `cd ${shellQuote(dir)} && ` + files.map((f) => `curl -LO ${f.url}`).join(" && "),
        action: "download-voice-model",
      };
    },
  },
  {
    id: "render-browser",
    label: "Render browser (Remotion)",
    fn: async (env) => {
      const p = join(env.repoRoot, "node_modules", ".remotion", "chrome-headless-shell");
      return (await exists(p))
        ? { level: "ok", detail: "Installed" }
        : { level: "warn", detail: "Not downloaded yet; the first render downloads it (about 100 MB)", fix: `cd ${shellQuote(env.repoRoot)} && npx remotion browser ensure` };
    },
  },
  {
    id: "disk",
    label: "Free disk space",
    fn: async (env) => {
      const at = await nearestExisting(env.libraryRoot);
      const s = await statfs(at);
      const free = Number(s.bavail) * Number(s.bsize);
      const gb = (free / GB).toFixed(1);
      if (free < (env.diskError ?? 1 * GB)) return { level: "error", detail: `${gb} GB free; rendering needs at least 1 GB`, fix: "Free up disk space" };
      if (free < (env.diskWarn ?? 3 * GB)) return { level: "warn", detail: `${gb} GB free; renders may run out of space`, fix: "Free up disk space" };
      return { level: "ok", detail: `${gb} GB free` };
    },
  },
  {
    id: "library",
    label: "Library folder",
    fn: async (env) => {
      const root = env.libraryRoot;
      let st;
      try {
        st = await stat(root);
      } catch {
        return { level: "error", detail: `${root} does not exist`, fix: `mkdir -p ${shellQuote(root)}`, action: "create-library" };
      }
      if (!st.isDirectory()) return { level: "error", detail: `${root} is not a folder`, fix: "Choose another library location in Settings" };
      try {
        await access(root, constants.W_OK);
      } catch {
        return { level: "error", detail: `${root} is not writable`, fix: `chmod u+w ${shellQuote(root)}` };
      }
      return { level: "ok", detail: root };
    },
  },
];

export async function runDoctor(env: DoctorEnv): Promise<DoctorCheck[]> {
  return Promise.all(
    CHECKS.map(async ({ id, label, fn }) => {
      try {
        return { id, label, ...(await fn(env)) };
      } catch (e) {
        return { id, label, level: "error" as const, detail: `Check failed: ${(e as Error).message}` };
      }
    }),
  );
}

export function shellQuote(s: string) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Downloads the voice model files into tts/models (temp file, then rename).
 * Bounded twice: no response within `downloadTimeoutMs`, or no bytes for
 * `downloadStallMs`, aborts it, so it can never stay "Downloading" forever.
 */
export async function downloadVoiceModel(env: DoctorEnv, log: (m: string) => void = () => {}) {
  const dir = join(env.repoRoot, "tts", "models");
  await mkdir(dir, { recursive: true });
  const answerMs = env.downloadTimeoutMs ?? 30_000;
  const stallMs = env.downloadStallMs ?? 60_000;
  for (const f of env.modelFiles ?? VOICE_MODEL_FILES) {
    const dest = join(dir, f.name);
    try {
      if ((await stat(dest)).size > 0) continue;
    } catch {
      /* download it */
    }
    const tmp = `${dest}.download`;
    log(`doctor: downloading ${f.url}`);
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(new Error(`no answer from the server within ${Math.round(answerMs / 1000)} s`)), answerMs);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error(`the download stalled (no data for ${Math.round(stallMs / 1000)} s)`)), stallMs);
    };
    try {
      const res = await fetch(f.url, { redirect: "follow", signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`download of ${f.name} failed: HTTP ${res.status}`);
      arm();
      const watchdog = new Transform({
        transform(chunk, _enc, cb) {
          arm();
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), watchdog, createWriteStream(tmp), { signal: ac.signal });
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : e;
    } finally {
      clearTimeout(timer);
    }
  }
}
