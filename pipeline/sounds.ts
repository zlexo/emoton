/**
 * The sound effects library: a folder of downloaded sounds (Settings
 * soundsRoot, ~/Emoton Sounds by default). Subfolders are categories; one
 * named after a marker kind (boom/, whoosh/...) offers its files for that
 * kind, keys/ feeds the built-in keyboard sounds, songs/ holds music. Emoton
 * only reads it: a sound used in a Short is copied into the Short's bundle.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, sep } from "node:path";
import { MARKERS } from "../schema/short.ts";

export const SOUND_FILE = /\.(wav|mp3|m4a|aiff?|flac|ogg)$/i;
/** The folders a new library starts with: one per marker kind, keys/ and songs/. */
export const SOUND_FOLDERS = [...MARKERS.filter((k) => k !== "keys" && k !== "mash"), "keys", "songs"] as const;

export type LibrarySound = { path: string; name: string; category: string; size: number };

const README = `Emoton's sound effects library.

Drop downloaded sounds here (wav, mp3, m4a, aiff, flac, ogg). Each folder is a category:
- boom, ding, scratch, pop, riser, impact, whoosh: offered for that marker kind; in the editor's
  Sounds tab, "Use for every [kind]" makes every [boom] (or other marker) in a Short play the file.
- keys: recordings of typing; the built-in keyboard sounds (mash, keys) are made from them.
- songs: music, used as a Short's soundtrack.
Any other folder is a category of its own; any sound can also be placed once, at the playhead.

A sound used in a Short is copied into that Short, so deleting or moving it here never breaks one.
`;

/** Makes the library folder with its starting folders and README the first time; never touches an existing one. */
export function ensureSoundsRoot(root: string) {
  if (existsSync(root)) return;
  mkdirSync(root, { recursive: true });
  for (const f of SOUND_FOLDERS) mkdirSync(join(root, f), { recursive: true });
  writeFileSync(join(root, "README.txt"), README);
}

/** Every sound in the library, by category (the first folder; "" for the root), then name. */
export function listSounds(root: string): LibrarySound[] {
  const out: LibrarySound[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(abs, depth + 1);
      else if (e.isFile() && SOUND_FILE.test(e.name)) {
        const rel = relative(root, abs).split(sep).join("/");
        out.push({ path: rel, name: e.name.replace(SOUND_FILE, ""), category: rel.includes("/") ? rel.split("/")[0]! : "", size: statSync(abs).size });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/** The absolute file for a library-relative path, or null if it is outside the library or not a sound. */
export function soundFile(root: string, rel: string): string | null {
  const clean = normalize(rel.replace(/^\/+/, ""));
  if (!clean || isAbsolute(clean) || clean.split(sep).includes("..") || !SOUND_FILE.test(clean)) return null;
  const abs = join(root, clean);
  try {
    const real = realpathSync(abs), realRoot = realpathSync(root);
    return real.startsWith(realRoot + sep) && statSync(real).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** Where a library sound goes in a Short's bundle: assets/sounds/<category>-<name>, or songs under assets/music/. */
export function bundleNameFor(rel: string): string {
  const parts = rel.split("/");
  const name = basename(rel).replace(/[^\w.\- ]+/g, "_");
  return parts[0] === "songs" ? `assets/music/${name}` : `assets/sounds/${parts.length > 1 ? `${parts[0]}-` : ""}${name}`;
}
