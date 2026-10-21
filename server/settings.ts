/** Settings file: defaults, load (merged over defaults), validated atomic save. */
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import { defaultSoundsRoot } from "../pipeline/sounds-root.ts";
import type { Settings } from "../shared/api.ts";

export function defaultSettingsPath(): string {
  return process.env.EMOTON_SETTINGS || join(homedir(), "Library", "Application Support", "me.zlex.emoton", "settings.json");
}

export function defaultSettings(): Settings {
  return {
    libraryRoot: join(homedir(), "Emoton"),
    soundsRoot: defaultSoundsRoot(),
    defaults: {
      voice: { engine: "kokoro", voice: "af_heart", speed: 1.0 },
      minutes: 5,
      writerModel: "opus",
      audience: "A curious university student",
      captions: true,
    },
    pauseAfterOutlineOverMinutes: 3,
    renderQuality: "1080p",
    pronounce: {},
    stylePresets: [
      {
        name: "Concepts only",
        rules: [
          "Explain the ideas; never show a full worked solution. Short pseudocode of general ideas is allowed.",
          "Do not invent numbers, benchmarks or API details that are not in the sources.",
        ],
      },
    ],
  };
}

const VoiceSchema = z.object({
  engine: z.enum(["kokoro", "say"]),
  voice: z.string().min(1).max(100),
  speed: z.number().min(0.5).max(2),
});

export const SettingsSchema = z.object({
  libraryRoot: z.string().min(1),
  /** Optional on a save, so a client from before the sound library keeps working: the default fills it. */
  soundsRoot: z.string().min(1).optional(),
  defaults: z.object({
    voice: VoiceSchema,
    minutes: z.number().min(1).max(30),
    writerModel: z.string().min(1).max(100),
    audience: z.string().max(500),
    captions: z.boolean(),
  }),
  pauseAfterOutlineOverMinutes: z.number().min(0).max(30).nullable(),
  renderQuality: z.enum(["1080p", "720p"]),
  pronounce: z.record(z.string(), z.string()),
  stylePresets: z.array(z.object({ name: z.string().min(1).max(100), rules: z.array(z.string()) })),
});

export { VoiceSchema };

/** "~/x" to an absolute path; relative paths are refused by validation. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function zodErrors(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.join(".") : "(body)"}: ${i.message}`);
}

/** Validates a full Settings body. Returns the normalized settings or the error list. */
export function validateSettings(body: unknown): { ok: true; settings: Settings } | { ok: false; errors: string[] } {
  const r = SettingsSchema.safeParse(body);
  if (!r.success) return { ok: false, errors: zodErrors(r.error) };
  const s = { ...r.data, soundsRoot: r.data.soundsRoot ?? defaultSettings().soundsRoot } as Settings;
  const root = expandHome(s.libraryRoot.trim());
  if (!isAbsolute(root)) return { ok: false, errors: ["libraryRoot: must be an absolute path (or start with ~/)"] };
  const sounds = expandHome(s.soundsRoot.trim());
  if (!isAbsolute(sounds)) return { ok: false, errors: ["soundsRoot: must be an absolute path (or start with ~/)"] };
  return { ok: true, settings: { ...s, libraryRoot: resolve(root), soundsRoot: resolve(sounds) } };
}

/**
 * Loads settings field by field: every valid field is kept (above all
 * libraryRoot), a missing one takes its default, an invalid one takes its
 * default and is reported. A file that is not JSON is moved aside as
 * `.corrupt-<time>`; a file with invalid fields is copied aside the same way,
 * because the next save rewrites it.
 */
export async function loadSettings(path: string, log: (m: string) => void = () => {}): Promise<Settings> {
  const d = defaultSettings();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`settings: could not read ${path}, using defaults (${(e as Error).message})`);
    return d;
  }
  const aside = `${path}.corrupt-${Date.now()}`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    await rename(path, aside).catch(() => {});
    log(`settings: ${path} is not a settings file, moved to ${aside}; using defaults`);
    return d;
  }
  const f = raw as Record<string, unknown>;
  const out = structuredClone(d) as Settings;
  const reset: string[] = [];

  if (f.libraryRoot !== undefined) {
    const root = typeof f.libraryRoot === "string" ? expandHome(f.libraryRoot.trim()) : "";
    if (root && isAbsolute(root)) out.libraryRoot = resolve(root);
    else reset.push("libraryRoot");
  }
  if (f.soundsRoot !== undefined) {
    const root = typeof f.soundsRoot === "string" ? expandHome(f.soundsRoot.trim()) : "";
    if (root && isAbsolute(root)) out.soundsRoot = resolve(root);
    else reset.push("soundsRoot");
  }
  const shape = SettingsSchema.shape;
  for (const key of ["pauseAfterOutlineOverMinutes", "renderQuality", "pronounce", "stylePresets"] as const) {
    if (f[key] === undefined) continue;
    const r = shape[key].safeParse(f[key]);
    if (r.success) (out as Record<string, unknown>)[key] = r.data;
    else reset.push(key);
  }
  if (f.defaults !== undefined) {
    if (!f.defaults || typeof f.defaults !== "object") reset.push("defaults");
    else {
      const fd = f.defaults as Record<string, unknown>;
      const dshape = shape.defaults.shape;
      for (const key of ["minutes", "writerModel", "audience", "captions"] as const) {
        if (fd[key] === undefined) continue;
        const r = dshape[key].safeParse(fd[key]);
        if (r.success) (out.defaults as Record<string, unknown>)[key] = r.data;
        else reset.push(`defaults.${key}`);
      }
      if (fd.voice !== undefined) {
        const r = dshape.voice.safeParse(fd.voice && typeof fd.voice === "object" ? { ...d.defaults.voice, ...(fd.voice as object) } : fd.voice);
        if (r.success) out.defaults.voice = r.data;
        else reset.push("defaults.voice");
      }
    }
  }
  if (reset.length) {
    await copyFile(path, aside).catch(() => {});
    log(`settings: invalid ${reset.join(", ")} in ${path} reset to defaults (the original is kept as ${aside})`);
  }
  return out;
}

let tmpSeq = 0;

/** Atomic write: temp file in the same directory, then rename. */
export async function writeJsonAtomic(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}
