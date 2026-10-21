/**
 * A Code Typer job into the library as a Short bundle: the document
 * (pipeline/codetyper.ts), its media cloned in (APFS clones: no extra disk,
 * and Code Typer re-rendering a file never changes the bundle's), the job's
 * pause edits as the Short's, then proxies of the footage and the voice. Code Typer's TTS cache is
 * cloned in first: it is keyed by the spoken text, voice and speed, so the
 * voice reuses the very sentences Code Typer made.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { VideoDetail } from "../shared/api.ts";
import type { Library, StepContext } from "../shared/library.ts";
import { fromDevlogJob, fromMontageJob, type DevlogJob, type MontageJob } from "./codetyper.ts";
import { isFile, paths, readJson, writeJson } from "./project.ts";
import { SHORT_VOICE, spokenScenes } from "./short.ts";
import { shotKey } from "./shots.ts";
import { resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";

const clone = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
};

export type ImportOptions = {
  /** Library folder to put the Short in ("" = the root). */
  folder: string;
  /** A devlog's Perdix commit (its shots were rendered at it). */
  build?: string;
  series?: string;
  /** Make the proxies and voice it now (default true). */
  voice?: boolean;
  ctx: StepContext;
};

export async function importCodeTyperJob(lib: Library, jobPath: string, o: ImportOptions): Promise<VideoDetail> {
  const job = JSON.parse(readFileSync(jobPath, "utf8")) as DevlogJob | MontageJob;
  const jobDir = dirname(resolve(jobPath));
  const ct = resolve(jobDir, ".."); // jobs/ sits in Code Typer's root
  const gen = join(ct, "public", "gen");
  const montage = "segs" in job;
  const expand = (p: string) => resolve(jobDir, p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  let doc;
  if (montage) doc = fromMontageJob(job, { media: (p) => `assets/${basename(p)}`, series: o.series });
  else {
    if (!o.build) throw new Error("a devlog needs --build <commit>: the Perdix commit its shots were rendered at");
    doc = fromDevlogJob(job, { build: o.build, series: o.series });
  }
  const d = await lib.createShort(o.folder, doc);
  if ("errors" in d) throw new Error(`the imported document is not valid:\n${d.errors.join("\n")}`);
  const dir = d.dir, P = paths(dir);
  let pendingKeys: string[] = [];

  if (montage) {
    for (const s of job.segs) {
      const to = join(dir, "assets", basename(s.clip));
      if (!existsSync(to)) clone(expand(s.clip), to);
    }
    if (job.music?.file) clone(expand(job.music.file), join(dir, "assets", basename(job.music.file)));
  } else {
    // each shot as Code Typer copied it for its last render: public/gen/<job>-<shot>.mp4
    job.chapters.forEach((c, i) => {
      if (!c.shot) return;
      const from = join(gen, `${job.title}-${c.shot.name}.mp4`);
      const scene = doc.scenes[i]!;
      if (existsSync(from)) clone(from, join(dir, "shots", `${scene.id}.mp4`));
      else o.ctx.log(`no render of shot ${c.shot.name} at ${from}: it shows as a placeholder`);
    });
    const edits = jobPath.replace(/\.json$/, ".voice.json");
    if (existsSync(edits)) {
      const e = JSON.parse(readFileSync(edits, "utf8")) as { version: 1; sentences: Record<string, unknown> };
      writeJson(P.voiceEdits, { version: 1, chapters: { [String(SHORT_VOICE)]: e.sentences } });
    }
    // each copied shot was rendered from exactly these knobs: its key says so, so it is not rendered again
    // (the knobs pinned to lines are seconds from the voice Code Typer had; the voice made below matches it)
    const copied = doc.scenes.filter((sc) => existsSync(join(dir, "shots", `${sc.id}.mp4`))).map((sc) => sc.id);
    if (copied.length) pendingKeys = copied;
    const cache = join(gen, "tts-cache");
    if (existsSync(cache)) for (const f of readdirSync(cache)) if (!existsSync(join(P.ttsCache, f))) clone(join(cache, f), join(P.ttsCache, f));
  }

  // proxies for the editor's player, then the voice
  if (o.voice !== false) {
    // the voice first, so the shots' keys are worked out from the voice they were made for
    for (const step of await lib.plan(d.summary.id, "voice")) await lib.runStep(d.summary.id, step, o.ctx);
  }
  if (pendingKeys.length) {
    const voice = isFile(P.timing(SHORT_VOICE)) ? readJson<VoiceTiming>(P.timing(SHORT_VOICE)) : estimatedVoice(doc);
    for (const x of resolveShort(doc, { voice }).shots) if (pendingKeys.includes(x.scene)) writeFileSync(join(dir, "shots", `${x.scene}.key`), shotKey(x));
  }
  if (o.voice !== false) {
    for (const step of await lib.plan(d.summary.id, "make")) await lib.runStep(d.summary.id, step, o.ctx);
  }
  return lib.detail(d.summary.id);
}
