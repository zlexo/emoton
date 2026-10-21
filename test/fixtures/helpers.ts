/** Test helpers: temp library roots and a "ready" bundle made from the fixture video, without any real media work. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, type CreateLibraryOptions } from "../../library/index.ts";
import { migrate } from "../../pipeline/migrate.ts";
import type { Brief } from "../../shared/api.ts";

/** A real video: Emoton's outline, storyboard and voice timings for a video made from its own README and storyboard schema. */
export const SLUG = "sources-in-video-out";
export const FIX = join(import.meta.dirname, SLUG);
// tests never find a Perdix shot tool, so nothing they do renders a shot
process.env.EMOTON_SHOT_TOOLS = join(tmpdir(), "emoton-tests-no-shot-tools");
export const fixture = <T = any>(f: string): T => JSON.parse(readFileSync(join(FIX, f), "utf8"));

export const DEFAULTS: Omit<Brief, "title" | "topic" | "layout"> = {
  audience: "a student", minutes: 3, rules: [], voice: { engine: "kokoro", voice: "af_heart", speed: 1 },
  pronounce: {}, writerModel: "opus", captions: true,
};

export type Temp = { base: string; root: string; trash: string; done(): void };

export function temp(): Temp {
  const base = mkdtempSync(join(tmpdir(), "emoton-test-"));
  const root = join(base, "Library"), trash = join(base, "Trash");
  mkdirSync(root);
  return { base, root, trash, done: () => rmSync(base, { recursive: true, force: true }) };
}

export const lib = (t: Temp, extra: Partial<CreateLibraryOptions> = {}) =>
  createLibrary({ root: t.root, trashDir: t.trash, defaults: DEFAULTS, ...extra });

/** Every chunk id the fixture outline and storyboard cite, as a synthetic chunks.json. */
export function fixtureChunks() {
  const ids = new Set<string>();
  for (const c of fixture("outline.json").chapters) for (const cl of c.claims) for (const id of cl.cite) ids.add(id);
  for (const c of fixture("storyboard.json").chapters) for (const b of c.beats) for (const id of b.cite ?? []) ids.add(id);
  return [...ids].map((id) => ({ id, source: id.split(":")[0], text: `stub text for ${id}` }));
}

/**
 * A v0-layout folder (videos/<slug>, the layout before the library): the
 * fixture JSON, the real voice timings, tiny stand-in media files, and short
 * text files in place of the sources.
 */
export function v0Folder(base: string): string {
  const from = join(base, "v0", SLUG);
  mkdirSync(join(from, "audio", "cache"), { recursive: true });
  mkdirSync(join(from, "render"), { recursive: true });
  mkdirSync(join(from, "out"), { recursive: true });
  const project = fixture("project.json");
  const srcDir = join(base, "notes");
  mkdirSync(srcDir, { recursive: true });
  for (const s of project.sources) {
    const file = join(srcDir, `${s.id}-notes.txt`);
    writeFileSync(file, `Notes for ${s.title}.\n\nSources go in, a narrated video comes out, and every claim cites a chunk.\n`);
    s.path = file;
  }
  writeFileSync(join(from, "project.json"), JSON.stringify(project, null, 2));
  for (const f of ["outline.json", "storyboard.json"]) copyFileSync(join(FIX, f), join(from, f));
  writeFileSync(join(from, "chunks.json"), JSON.stringify(fixtureChunks()));
  for (let n = 1; n <= fixture("storyboard.json").chapters.length; n++) {
    copyFileSync(join(FIX, "render", `ch${n}.timing.json`), join(from, "render", `ch${n}.timing.json`));
    writeFileSync(join(from, "audio", `ch${n}.wav`), `fake wav ${n}`);
    writeFileSync(join(from, "render", `ch${n}.mp4`), `fake mp4 ${n}`);
  }
  writeFileSync(join(from, "audio", "cache", "abc.wav"), "cached sentence");
  writeFileSync(join(from, "out", `${SLUG}.mp4`), "fake final");
  return from;
}

/** The fixture video migrated into the temp library: every stage ok, status ready. Returns its dir. */
export async function readyBundle(t: Temp): Promise<string> {
  return migrate(t.root, { from: v0Folder(t.base), keep: true, trashDir: t.trash });
}

export const ctx = (signal = new AbortController().signal) => {
  const logs: string[] = [], progress: [number, string?][] = [];
  return { signal, log: (l: string) => logs.push(l), progress: (p: number, d?: string) => progress.push([p, d]), logs, progressCalls: progress };
};
