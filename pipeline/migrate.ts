/**
 * Moves a video from the v0 repo layout (`videos/<slug>`, before the library)
 * into a library as `<root>/<folder>/<slug>.emoton`: copies its source files
 * into `sources/`, keeps audio, render and out, and records state hashes so it
 * shows ready without re-rendering.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultTrash, moveToTrash, uniqueName } from "../library/files.ts";
import { ingest } from "./ingest.ts";
import { Project, Storyboard, expand, isFile, isUrl, paths, readJson, writeJson } from "./project.ts";
import type { ChapterTiming } from "../schema/storyboard.ts";
import { markersFrom, thumbnail } from "./render.ts";
import { adoptOutputs, type StageDeps } from "./stages.ts";
import { mutateState, snapshot, videoState, videoStatus, withLock } from "./state.ts";

export type MigrateOptions = {
  /** The v0 video folder; its name is the slug. */
  from: string;
  /** Where project/outline/storyboard.json come from when `from` lacks them. */
  fixtures?: string;
  /** Library folder to put it in. Default "Imported". */
  folder?: string;
  /** Leave the old folder where it is (default: move it to the Trash once the copy is complete). */
  keep?: boolean;
  trashDir?: string;
  log?: (l: string) => void;
  deps?: StageDeps;
};

export async function migrate(root: string, o: MigrateOptions): Promise<string> {
  const log = o.log ?? (() => {});
  const { from } = o;
  const slug = basename(from);
  const target = join(root, o.folder ?? "Imported", `${slug}.emoton`);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  const dirs = o.fixtures ? [from, o.fixtures] : [from];
  const pick = (f: string) => {
    for (const d of dirs) if (isFile(join(d, f))) return join(d, f);
    throw new Error(`no ${f} in ${dirs.join(" or ")}`);
  };
  const project = Project.parse(readJson(pick("project.json")));

  // Build under <root>/.emoton (the scanner skips dot folders), then rename into place.
  const stageRoot = join(root, ".emoton", "migrating");
  const dir = join(stageRoot, `${slug}.emoton`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "sources"), { recursive: true });
  try {
    for (const src of project.sources) {
      if (isUrl(src.path)) continue;
      const file = expand(src.path);
      if (!isFile(file)) throw new Error(`source ${src.id}: no file at ${file}`);
      const name = uniqueName(join(dir, "sources"), basename(file), true); // two sources may share a file name
      copyFileSync(file, join(dir, "sources", name));
      src.path = `sources/${name}`;
      log(`source ${src.id}: copied ${name}`);
    }
    const now = new Date().toISOString();
    writeJson(join(dir, "project.json"), { id: randomUUID(), created: now, updated: now, titleAuto: false, ...project });
    for (const f of ["outline.json", "storyboard.json"]) copyFileSync(pick(f), join(dir, f));
    for (const f of ["chunks.json", "audio", "render", "out"]) {
      if (!existsSync(join(from, f))) continue;
      cpSync(join(from, f), join(dir, f), { recursive: true, preserveTimestamps: true });
      log(`kept ${f}`);
    }
    // The v0 chapter props files point at the old layout; they are rewritten on the next preview.
    const P = paths(dir);
    if (!isFile(P.chunks)) {
      log("no chunks.json: reading the sources");
      writeJson(P.chunks, (await ingest(project, dir, { log })).chunks);
    }
    await adoptOutputs(dir, o.deps);
    // Per-source page counts for the Sources tab (best effort: needs pdftotext).
    try {
      const r = await ingest(project, dir);
      await withLock(dir, () => mutateState(dir, (s) => (s.sources = r.sources)));
    } catch (e) {
      log(`source summary skipped: ${(e as Error).message}`);
    }
    if (isFile(P.final) && isFile(P.storyboard)) {
      const sb = readJson(P.storyboard, Storyboard);
      const chapters = sb.chapters.filter((c) => !!c);
      const timings = chapters.map((_, i) => (isFile(P.timing(i + 1)) ? readJson<ChapterTiming>(P.timing(i + 1)) : null));
      if (timings.every((t) => t)) {
        writeJson(P.markers, markersFrom(chapters as NonNullable<(typeof chapters)[number]>[], timings as ChapterTiming[]));
        if (!isFile(P.thumb) && isFile(P.chapterMp4(1)))
          await thumbnail(dir, timings[0]!).catch((e) => log(`thumb skipped: ${(e as Error).message}`));
      }
    }
    mkdirSync(join(target, ".."), { recursive: true });
    renameSync(dir, target);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  const st = videoState(snapshot(target, o.deps?.globalPronounce));
  log(`migrated to ${target}: ${videoStatus(st)} (ingest ${st.ingest}, outline ${st.outline}, join ${st.join}; chapters ${st.chapters.map((c) => `${c.storyboard}/${c.voice}/${c.render}`).join(", ")})`);
  if (!o.keep && existsSync(from)) log(`moved the old folder to the Trash: ${await moveToTrash(from, o.trashDir ?? defaultTrash())}`);
  return target;
}
