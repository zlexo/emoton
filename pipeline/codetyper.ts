/**
 * Code Typer's jobs as Short documents, so every devlog episode and montage
 * made there opens in Emoton's editor. Pure: the job in, the Short out; the
 * caller copies the media into the bundle (`media` names the bundle path for
 * each of the job's files) and the job's pause edits (<job>.voice.json) into
 * voice-edits.json. The rules mirror Code Typer's cli/devlog.ts and
 * cli/montage.ts, and resolveShort on an imported episode reproduces the
 * props Code Typer resolved for it (test/short-codetyper.test.ts).
 */
import { SHORT_VERSION, type Anchor, type Fx, type KnobValue, type Scene, type Short, type Sound, type TextClip } from "../schema/short.ts";
import { parseLine } from "../src/core/short/resolve.ts";
import { keySentences } from "../src/core/words.ts";

type CtShot = { name: string; kind: string; env?: Record<string, string | number>; orbit?: number; sweep?: { at: string; len: number } };
type CtSource = string | { path: string; repo?: string; ref?: string; lines?: [number, number][] };
export type DevlogJob = {
  title: string;
  voice: { engine: "kokoro" | "say"; voice: string; speed?: number };
  gaps?: { leadIn: number; sentence: number; beat: number; aha: number; tail: number };
  chapters: { say?: string[]; big?: string; shot?: CtShot; continue?: boolean; lift?: 1 | 2 | 3; code?: string }[];
  end?: { big: string; small?: string; seconds: number };
  music?: { bpm?: number; volume?: number; duck?: number; hold?: number };
  codeflash?: Record<string, { files: CtSource[]; seconds?: number; seed?: number; caption?: string; lead?: number; after?: number }>;
};
export type MontageJob = {
  title: string;
  segs: { clip: string; from?: number; seconds: number; big?: string; small?: string; drop?: boolean; cont?: boolean; zoom?: [number, number] }[];
  hook?: { text: string; seconds: number };
  end?: { big: string; small?: string; seconds: number };
  music?: { file?: string; bpm?: number; volume?: number; seed?: number; style?: "trap" | "phonk" | "house" | "chiptune" };
};

const db = (x: number) => 20 * Math.log10(x);
const CANVAS = { w: 1080, h: 1920, fps: 60 as const };
const CAPTIONS = { style: { maxWords: 3, highlight: false }, overrides: [] };
/** Code Typer's score defaults (src/score.ts there). */
const SCORE_DUCK = 0.3, SCORE_HOLD = 1.0;
/** A devlog's push-in, as cli/devlog.ts sets it on every segment. */
const DEVLOG_PUSH = 1.02;
/** A code chapter's riser ends on the cut and lasts at most this long (src/audio.ts mixTrack). */
const RISER_MAX = 1.4;

const sceneIds = (names: (string | undefined)[]) => {
  const used = new Set<string>();
  return names.map((n, i) => {
    let id = (n ?? `s${i + 1}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 28) || `s${i + 1}`;
    while (used.has(id)) id = `${id.slice(0, 26)}-${i + 1}`;
    used.add(id);
    return id;
  });
};

const edgeOf = (scene: string, edge: "start" | "end", offset?: number): Anchor => ({ scene, edge, ...(offset ? { offset } : {}) });

/** A devlog job (cli/devlog.ts) as a Short. `build` is the Perdix commit its shots were rendered at. */
export function fromDevlogJob(job: DevlogJob, opts: { build: string; series?: string }): Short {
  const ch = job.chapters;
  const ids = sceneIds(ch.map((c, i) => (c.code ? `code-${c.code}` : c.shot?.name ?? (c.continue ? `${ch[i - 1]?.shot?.name ?? "s"}-more` : undefined))));
  // every spoken line's key, in the order spoken, as the voice stage keys them
  const spokenText = ch.flatMap((c) => (c.say ?? []).map((l) => parseLine(l).text));
  const keys = keySentences(spokenText);
  const keyOf: string[][] = [];
  let k = 0;
  for (const c of ch) keyOf.push((c.say ?? []).map(() => keys[k++]!));

  // a knob expression, "s[i]" or "e[i] + 1.6": a line of the run's first chapter, from the shot's start
  const knob = (i: number, v: string | number, what: string): KnobValue => {
    if (typeof v === "number") return v;
    const m = /^\s*([se])\[(\d+)\]\s*(?:([+-])\s*(\d+(?:\.\d+)?))?\s*$/.exec(v);
    if (!m) throw new Error(`chapter ${i + 1} ${what}: "${v}" is not s[i] or e[i] (plus or minus seconds)`);
    const key = keyOf[i]![Number(m[2])];
    if (key === undefined) throw new Error(`chapter ${i + 1} ${what}: ${v} names a line the chapter does not have`);
    const off = m[3] ? (m[3] === "-" ? -1 : 1) * Number(m[4]) : 0;
    return { sentence: key, edge: m[1] === "s" ? "start" : "end", ...(off ? { offset: off } : {}) };
  };

  const scenes: Scene[] = [];
  const text: TextClip[] = [];
  const fx: Fx[] = [];
  const sfx: Sound[] = [];
  ch.forEach((c, i) => {
    const id = ids[i]!;
    for (const line of c.say ?? []) if (/\[code:/.test(line)) throw new Error(`chapter ${i + 1}: inline [code:] flashes are not imported (no episode used them)`);
    if (c.code) {
      const f = job.codeflash?.[c.code];
      if (!f) throw new Error(`chapter ${i + 1}: no codeflash entry ${c.code}`);
      const hold = f.seconds ?? 5;
      scenes.push({
        id, hold, lead: f.lead ?? 0.3, after: f.after ?? 0.9, in: "flash", push: 1,
        visual: {
          type: "code",
          files: f.files.map((s) => (typeof s === "string" ? { path: s } : { path: s.path, ...(s.repo ? { repo: s.repo } : {}), ...(s.ref ? { ref: s.ref } : {}), ...(s.lines ? { lines: s.lines } : {}) })),
          ...(f.seed !== undefined ? { seed: f.seed } : {}),
          ...(f.caption ? { caption: f.caption } : {}),
        },
      });
      // the Short's sound: the mash as it slams in, every key it types, a riser into the cut, the impact on it
      sfx.push({ kind: "mash", at: edgeOf(id, "start") }, { kind: "keys", at: edgeOf(id, "start"), gainDb: db(0.7) },
        { kind: "riser", at: edgeOf(id, "end", -Math.min(RISER_MAX, hold)), gainDb: db(0.5 * 0.7) },
        { kind: "impact", at: edgeOf(id, "end"), gainDb: db(1.6 * 0.7) });
      return;
    }
    const payoff = !!ch[i - 1]?.code;
    const scene: Scene = {
      id, say: c.say,
      in: payoff ? "drop" : c.big ? "flash" : "cut",
      push: DEVLOG_PUSH,
    };
    if (c.shot) {
      const s = c.shot;
      scene.visual = {
        type: "shot", source: "perdix", kind: s.kind, build: opts.build,
        knobs: Object.fromEntries(Object.entries(s.env ?? {}).map(([n, v]) => [n, knob(i, v, n)])),
        ...(s.orbit !== undefined ? { orbit: s.orbit } : {}),
        ...(s.sweep ? { sweep: { at: knob(i, s.sweep.at, "sweep") as Anchor, len: s.sweep.len } } : {}),
      };
    } else if (c.continue) scene.continue = true;
    else throw new Error(`chapter ${i + 1}: no shot, no code and no continue`);
    scenes.push(scene);
    if (c.big) text.push({ role: "big", text: c.big, from: edgeOf(id, "start"), to: edgeOf(id, "end") });
    // the payoff after a code chapter punches in on its cut, as the Short does
    if (payoff) fx.push({ kind: "punch", at: edgeOf(id, "start") });
  });

  const lastId = ids[ids.length - 1]!;
  if (job.end) text.push({ role: "end", text: job.end.big, ...(job.end.small ? { sub: job.end.small } : {}), from: edgeOf(lastId, "end", -job.end.seconds), to: edgeOf(lastId, "end") });
  const lifts = ([1, 2, 3] as const).map((n) => ch.findIndex((c) => c.lift === n));
  const liftAnchors = lifts.some((i) => i >= 0) ? lifts.map((i) => (i >= 0 ? edgeOf(ids[i]!, "start") : edgeOf(lastId, "end"))) : undefined;

  return {
    version: SHORT_VERSION, title: job.title, template: "devlog", canvas: CANVAS,
    ...(opts.series ? { series: opts.series } : {}),
    voice: { engine: job.voice.engine, voice: job.voice.voice, speed: job.voice.speed ?? 1, ...(job.gaps ? { gaps: job.gaps } : {}) },
    scenes, text, captions: CAPTIONS, fx, sfx,
    music: {
      source: { synth: { style: "pad", bpm: job.music?.bpm ?? 84, ...(liftAnchors ? { lifts: liftAnchors } : {}) } },
      gainDb: db(job.music?.volume ?? 0.5),
      duck: { depthDb: db(job.music?.duck ?? SCORE_DUCK), hold: job.music?.hold ?? SCORE_HOLD },
    },
  };
}

/** A montage job (cli/montage.ts) as a Short. `media(path)` is where the bundle keeps each of the job's files. */
export function fromMontageJob(job: MontageJob, opts: { media: (jobPath: string) => string; series?: string }): Short {
  const ids = sceneIds(job.segs.map((s, i) => `${s.clip.split("/").pop()!.replace(/\.[^.]+$/, "")}-${i + 1}`));
  const scenes: Scene[] = job.segs.map((s, i) => ({
    id: ids[i]!, hold: s.seconds,
    visual: { type: "clip", asset: opts.media(s.clip), ...(s.from !== undefined ? { from: s.from } : {}) },
    in: s.drop ? "drop" : s.cont ? "cut" : "flash",
    ...(s.zoom ? { push: s.zoom[1] } : {}),
  }));
  const text: TextClip[] = [];
  if (job.hook) text.push({ role: "hook", text: job.hook.text, from: { t: 0 }, to: { t: job.hook.seconds } });
  job.segs.forEach((s, i) => {
    if (s.big) text.push({ role: "big", text: s.big, ...(s.small ? { sub: s.small } : {}), from: edgeOf(ids[i]!, "start"), to: edgeOf(ids[i]!, "end") });
  });
  const lastId = ids[ids.length - 1]!;
  if (job.end) text.push({ role: "end", text: job.end.big, ...(job.end.small ? { sub: job.end.small } : {}), from: edgeOf(lastId, "end", -job.end.seconds), to: edgeOf(lastId, "end") });
  const m = job.music;
  return {
    version: SHORT_VERSION, title: job.title, template: "montage", canvas: CANVAS,
    ...(opts.series ? { series: opts.series } : {}),
    scenes, text, captions: CAPTIONS, fx: [], sfx: [],
    music: {
      source: m?.file
        ? { file: { asset: opts.media(m.file) } }
        : { synth: { style: m?.style ?? "trap", bpm: m?.bpm ?? 120, ...(m?.seed !== undefined ? { seed: m.seed } : {}) } },
      gainDb: db(m?.volume ?? 1),
      duck: { depthDb: 0 },
    },
  };
}
