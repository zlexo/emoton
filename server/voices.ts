/** Voices: the curated list (checked against the Kokoro voice file) and short samples via tts/speak.py. */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Voice, VoiceOption } from "../shared/api.ts";
import { levelVoice } from "../pipeline/loudness.ts";
import { VOICE_SR } from "../pipeline/voice.ts";

const REC = "Recommended";
export const CURATED: VoiceOption[] = [
  { engine: "kokoro", voice: "af_heart", label: "Heart", accent: "US", gender: "f", group: REC, timed: true },
  { engine: "kokoro", voice: "af_bella", label: "Bella", accent: "US", gender: "f", group: REC, timed: true },
  { engine: "kokoro", voice: "af_nicole", label: "Nicole", accent: "US", gender: "f", group: REC, timed: true },
  { engine: "kokoro", voice: "am_michael", label: "Michael", accent: "US", gender: "m", group: REC, timed: true },
  { engine: "kokoro", voice: "am_fenrir", label: "Fenrir", accent: "US", gender: "m", group: REC, timed: true },
  { engine: "kokoro", voice: "bf_emma", label: "Emma", accent: "UK", gender: "f", group: REC, timed: true },
  { engine: "kokoro", voice: "bm_george", label: "George", accent: "UK", gender: "m", group: REC, timed: true },
  { engine: "kokoro", voice: "bm_lewis", label: "Lewis", accent: "UK", gender: "m", group: REC, timed: true },
  { engine: "say", voice: "default", label: "macOS system voice", accent: "system", group: REC, timed: false },
];

/** Kokoro's English voices by id prefix (the others are other languages). */
const KOKORO_GROUPS = [
  { prefix: "af_", group: "Kokoro · US women", accent: "US", gender: "f" },
  { prefix: "am_", group: "Kokoro · US men", accent: "US", gender: "m" },
  { prefix: "bf_", group: "Kokoro · UK women", accent: "UK", gender: "f" },
  { prefix: "bm_", group: "Kokoro · UK men", accent: "UK", gender: "m" },
] as const;

/** macOS voices worth narrating with besides the Premium and Enhanced ones (the novelty voices are left out). */
export const MAC_NARRATORS = new Set(["Daniel", "Samantha", "Karen", "Moira", "Tessa", "Rishi", "Tara", "Aman"]);
const MAC_ACCENT: Record<string, string> = { en_US: "US", en_GB: "UK", en_AU: "AU", en_IE: "IE", en_IN: "IN", en_ZA: "ZA", en_NZ: "NZ", en_SC: "UK" };

export type SystemVoice = { name: string; locale: string };

/** The English voices `say -v ?` lists; none when `say` is missing (not a Mac). */
export function macVoices(): Promise<SystemVoice[]> {
  return new Promise((resolve) => {
    execFile("say", ["-v", "?"], { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const seen = new Set<string>();
      const out: SystemVoice[] = [];
      for (const line of String(stdout).split("\n")) {
        const m = /^(.+?)\s{2,}(en_[A-Z]{2})\s/.exec(line);
        if (!m || seen.has(m[1]!.trim())) continue;
        seen.add(m[1]!.trim());
        out.push({ name: m[1]!.trim(), locale: m[2]! });
      }
      resolve(out);
    });
  });
}

export const SAMPLE_TEXT = "This is how your videos will sound.";

const LIST_KEYS = "import sys, json, numpy as np; print(json.dumps(sorted(np.load(sys.argv[1]).keys())))";

export class Voices {
  private keys: Set<string> | null = null;
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private repoRoot: string,
    private cacheDir: string,
    private log: (m: string) => void = () => {},
    private system: () => Promise<SystemVoice[]> = macVoices,
    private level: (wav: string) => Promise<void> = (wav) => levelVoice(wav, VOICE_SR),
  ) {}

  private get python() {
    return join(this.repoRoot, "tts", ".venv", "bin", "python");
  }

  /** Voice ids inside tts/models/voices-v1.0.bin (an npz). Cached after the first success; null when it cannot be read. */
  private async kokoroKeys(): Promise<Set<string> | null> {
    if (this.keys) return this.keys;
    const bin = join(this.repoRoot, "tts", "models", "voices-v1.0.bin");
    const out = await new Promise<string | null>((resolve) => {
      execFile(this.python, ["-c", LIST_KEYS, bin], { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    });
    if (out === null) return null;
    try {
      this.keys = new Set(JSON.parse(out) as string[]);
      return this.keys;
    } catch {
      return null;
    }
  }

  /**
   * Every voice on this machine, by group: the curated ones first, then every
   * English Kokoro voice in the voice file, then the macOS Premium and
   * Enhanced voices and the standard narrators. Kokoro voices are listed only
   * when the voice file has them; when it cannot be read (model or venv
   * missing, see Doctor) only the system voices are offered.
   */
  async list(): Promise<VoiceOption[]> {
    const keys = await this.kokoroKeys();
    if (!keys) this.log("voices: could not read the Kokoro voice file; offering the system voices only");
    const out = CURATED.filter((v) => v.engine === "say" || (keys?.has(v.voice) ?? false));
    const listed = new Set(out.map((v) => `${v.engine}:${v.voice}`));
    for (const g of KOKORO_GROUPS)
      for (const k of [...(keys ?? [])].filter((k) => k.startsWith(g.prefix)).sort())
        if (!listed.has(`kokoro:${k}`)) {
          const name = k.slice(g.prefix.length);
          out.push({ engine: "kokoro", voice: k, label: name[0]!.toUpperCase() + name.slice(1), accent: g.accent, gender: g.gender, group: g.group, timed: true });
        }
    const mac = await this.system();
    const premium = mac.filter((v) => /\((Premium|Enhanced)\)/.test(v.name));
    const standard = mac.filter((v) => MAC_NARRATORS.has(v.name));
    for (const [group, list] of [["macOS · Premium", premium], ["macOS · standard", standard]] as const)
      for (const v of list) out.push({ engine: "say", voice: v.name, label: v.name, accent: MAC_ACCENT[v.locale] ?? v.locale.slice(3), group, timed: false });
    return out;
  }

  /** A WAV of one short sentence, cached by hash of everything that changes the sound. Returns its path. */
  async sample(voice: Voice, text: string, pronounce: Record<string, string>): Promise<string> {
    const key = createHash("sha1").update(JSON.stringify([voice.engine, voice.voice, voice.speed, text, pronounce])).digest("hex").slice(0, 16);
    const out = join(this.cacheDir, `${key}.wav`);
    try {
      if ((await stat(out)).size > 0) return out;
    } catch {
      /* make it */
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.synth(voice, text, pronounce, out).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async synth(voice: Voice, text: string, pronounce: Record<string, string>, out: string): Promise<string> {
    await mkdir(this.cacheDir, { recursive: true });
    const tmpOut = `${out}.${process.pid}.tmp.wav`;
    const job = {
      engine: voice.engine,
      voice: voice.voice,
      speed: voice.speed,
      gaps: { leadIn: 0.1, sentence: 0, beat: 0, aha: 0, tail: 0.2 },
      cacheDir: join(this.cacheDir, "sentences"),
      out: tmpOut,
      pronounce,
      beats: [{ say: [text], aha: false }],
    };
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.python, [join(this.repoRoot, "tts", "speak.py")], { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
      proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`voice sample: ${e.message} (run \`cd tts && uv sync\`)`));
      });
      proc.on("close", (code, sig) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`voice sample failed (${sig ?? `exit ${code}`}): ${err.trim().split("\n").pop() ?? ""}`));
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end(JSON.stringify(job));
    });
    // levelled like a chapter's voice, so a preview sounds as loud as the video will
    await this.level(tmpOut);
    try {
      await rename(tmpOut, out);
    } catch (e) {
      await rm(tmpOut, { force: true });
      throw new Error(`voice sample: no audio was written (${(e as Error).message})`);
    }
    return out;
  }
}
