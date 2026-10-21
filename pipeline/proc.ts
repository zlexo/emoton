import { spawn } from "node:child_process";
import { basename } from "node:path";

/** Process groups we started and have not seen exit. Killed on process exit. */
const live = new Set<number>();
let hooked = false;

/** Signals the child's whole group; `leader` also tries the pid alone (only while the child is known to be alive). */
function killGroup(pid: number, sig: NodeJS.Signals, leader = true) {
  try {
    process.kill(-pid, sig); // the whole group: python and its `say`, claude and its helpers
  } catch {
    if (!leader) return;
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const pid of live) killGroup(pid, "SIGKILL");
  });
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "AbortError";
  }
}

export const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Cancelled();
};

export type ChildOptions = {
  signal?: AbortSignal;
  input?: string;
  cwd?: string;
  /** The child's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** Called for every complete stderr line. Without it, stderr is only kept for the error message. */
  onStderrLine?: (line: string) => void;
  /** Seconds between SIGTERM and SIGKILL on abort. */
  grace?: number;
  /** Stop the child (whole group) after this many ms and reject with a "took longer" error. */
  timeoutMs?: number;
};

export type ChildResult = { code: number | null; stdout: string; stderr: string };

/**
 * Runs a command in its own process group. Aborting the signal kills the whole
 * group (SIGTERM, then SIGKILL after `grace` seconds) and rejects with
 * Cancelled once the child has exited, so nothing outlives the step.
 */
export function runChild(cmd: string, args: string[], opts: ChildOptions = {}): Promise<ChildResult> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(new Cancelled());
  hookExit();
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", partial = "", aborted = false, timedOut = false, timer: NodeJS.Timeout | undefined;
    if (p.pid) live.add(p.pid);
    const stop = () => {
      if (!p.pid) return;
      killGroup(p.pid, "SIGTERM");
      timer = setTimeout(() => p.pid && killGroup(p.pid, "SIGKILL"), (opts.grace ?? 2) * 1000);
      timer.unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const deadline = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs)
      : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    // Decode as a stream: a multi-byte character split across two chunks stays whole.
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d: string) => (stdout += d));
    p.stderr.on("data", (s: string) => {
      stderr = (stderr + s).slice(-20000);
      if (!opts.onStderrLine) return;
      partial += s;
      const lines = partial.split("\n");
      partial = lines.pop()!;
      for (const l of lines) opts.onStderrLine(l);
    });
    p.stdin.on("error", () => {}); // a child that exits early closes its stdin
    p.on("error", (e) => {
      if (p.pid) live.delete(p.pid);
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      rej(e);
    });
    p.on("close", (code) => {
      if (p.pid) {
        live.delete(p.pid);
        // A child may leave grandchildren in its group; make sure none survive. The child
        // itself has exited, so never signal its bare pid here (it may belong to someone else by now).
        killGroup(p.pid, "SIGKILL", false);
      }
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      if (partial && opts.onStderrLine) opts.onStderrLine(partial);
      if (aborted) return rej(new Cancelled());
      if (timedOut) return rej(new Error(`${basename(cmd)} took longer than ${opts.timeoutMs! / 1000} s and was stopped`));
      res({ code, stdout, stderr });
    });
    p.stdin.end(opts.input ?? "");
  });
}

/** runChild that rejects on a non-zero exit, with the stderr tail in the message. */
export async function run(cmd: string, args: string[], opts: ChildOptions = {}): Promise<string> {
  let r: ChildResult;
  try {
    r = await runChild(cmd, args, opts);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${cmd} is not installed`);
    throw e;
  }
  if (r.code !== 0) throw new Error(`${cmd} exited ${r.code}: ${r.stderr.trim().split("\n").slice(-6).join("\n")}`);
  return r.stdout;
}

/** Number of process groups started here that are still running (for tests). */
export const liveChildren = () => live.size;
