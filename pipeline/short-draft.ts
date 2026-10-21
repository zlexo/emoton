/**
 * Claude drafts a Short from its brief or script: scenes with their lines and
 * markers, a Perdix shot (kind, knobs, cues pinned to words), a code moment
 * from Perdix's recent commits, or a card, per scene. The draft becomes a
 * document on the Short's series settings and is checked like any saved one
 * (plus the series' wording rules); a rejected draft goes back with its
 * problems, three tries at most.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { Short, type KnobValue, type Scene, type Visual } from "../schema/short.ts";
import { writerSchema } from "../schema/storyboard.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";
import { checkShort, parseLine } from "../src/core/short/resolve.ts";
import { SERIES, wordingProblems, type Series } from "../src/core/short/series.ts";
import { endCard } from "../src/core/short/templates.ts";
import { keySentences } from "../src/core/words.ts";
import { askClaude, type Writer } from "./write.ts";

/** The draft's notes for the maker, beside short.json. */
export const DRAFT_FILE = "draft.json";
export type DraftNotes = { at: string; attempts: number; notes: string[] };

export const SHORT_SYSTEM = `You draft vertical Shorts (TikTok and YouTube Shorts, 9:16, about a minute) for Emoton, a video editor. A Short is a list of scenes; a voiced scene has spoken lines and one visual. You reply only with JSON that matches the given schema.`;

const Id = z.string().regex(/^[a-z0-9-]{1,24}$/);
export const DraftScene = z.strictObject({
  id: Id.describe("short, lowercase, unique: world, born, walk"),
  say: z.array(z.string().min(1).max(400)).max(12).optional().describe("the spoken lines, one sentence each, markers inline in brackets"),
  hold: z.number().min(0.5).max(30).optional().describe("seconds, only for a scene with no lines"),
  shot: z.strictObject({
    kind: z.string(),
    knobs: z.record(z.string(), z.number()).optional().describe("numbers only; a switch is 0 or 1"),
    cues: z.array(z.strictObject({ knob: z.string(), word: z.string(), edge: z.enum(["start", "end"]).optional() })).optional()
      .describe("a time knob pinned to a word of this scene's lines: the shot does that thing as the word is spoken"),
  }).optional(),
  code: z.strictObject({
    path: z.string(),
    ref: z.string().describe("the commit, from the list given"),
    lines: z.array(z.strictObject({ from: z.number().int().min(1), to: z.number().int().min(1) })).max(4).optional().describe("1-based inclusive line ranges"),
    caption: z.string().max(80).optional(),
  }).optional(),
  card: z.strictObject({ title: z.string().max(60), subtitle: z.string().max(120).optional() }).optional(),
  continue: z.boolean().optional().describe("the previous scene's footage keeps running under these lines"),
});
export const ShortDraft = z.strictObject({
  title: z.string().min(1).max(100),
  scenes: z.array(DraftScene).min(1).max(30),
  notes: z.array(z.string().max(300)).max(8).describe("what the maker should check: claims you could not verify, shots no kind can make yet"),
});
export type ShortDraft = z.infer<typeof ShortDraft>;

export type ShotKinds = Pick<import("./shots.ts").ShotKinds, "kinds">;

const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

/** Perdix's recent commits with the files each changed, for code moments. */
export function recentCommits(repo: string, n = 25): string {
  try {
    return execFileSync("git", ["-C", home(repo), "log", "origin/main", `-n${n}`, "--no-merges", "--format=%n%h %s", "--name-only"], { encoding: "utf8" })
      .split("\n").filter((l) => !/\.(md|json|png|txt)$/.test(l)).join("\n").trim().slice(0, 6000);
  } catch {
    return "";
  }
}

const TEMPLATE_SPINE: Record<Short["template"], string> = {
  devlog: "A devlog: a voiced story. Each scene is a beat of the story with 1 to 6 lines and the shot that shows it. Open on what the last episode left, build to the new thing, end on what comes next.",
  montage: "A montage on a beat: 5 to 10 scenes with no lines, each held 2 to 4 seconds, a card title on each (DAY 1, DAY 2 ...), the biggest moment after the middle. At most one line at the very end.",
  speedrun: "A speedrun: one long code scene (hold 10 to 20 s) typing the key file, then a short payoff scene with one or two lines.",
  edit: "An edit cut to a song: scenes with no lines, each held a whole number of beats.",
};

export function draftPrompt(o: { title: string; template: Short["template"]; brief: string; series?: Series; kinds: ShotKinds; commits: string }): string {
  const s = o.series;
  const kinds = Object.entries(o.kinds.kinds).map(([k, v]) => {
    const knobs = Object.entries(v.knobs).map(([n, d]) => `${n}${d.time ? " (time: pin it with a cue)" : ""}${d.switch ? " (0/1)" : ""} default ${d.default}${d.unit ? ` ${d.unit}` : ""}${d.about ? ` (${d.about})` : ""}`).join("; ");
    return `- ${k}: ${v.about}\n  knobs: ${knobs}`;
  }).join("\n");
  const wps = 2.7 * (s?.voice.speed ?? 1);
  return `Short: "${o.title}"
${TEMPLATE_SPINE[o.template]}
${s ? `
Series: ${s.name}. Its rules (obey strictly):
${s.rules.map((r) => `- ${r}`).join("\n")}
- Wording: ${s.wording.map((w) => `say "${w.use}", never "${w.avoid}"`).join("; ")}.
- About ${s.boomsPerMinute} [boom] a minute, on punchlines only.
- Length ${s.target.minSeconds} to ${s.target.maxSeconds} s: the voice speaks about ${wps.toFixed(1)} words a second.
- The end card ("${s.endCard.text}") is added for you: do not write it.` : ""}

The brief, or the script to cut into scenes. If it is a script (lines, markers in brackets), keep every line word for word and in order; split it into scenes where the picture should change:
<brief>
${o.brief}
</brief>

Visuals: one per scene, or continue: true to keep the previous scene's footage running.
- shot: a Perdix shot. Use only these kinds and knobs; leave knobs at their defaults unless the story needs otherwise. A time knob is pinned to a word with a cue: {knob, word}, where word appears in that scene's lines (the word's start, or edge "end").
${kinds}
- A perdix-life shot is one of his lives, picked by SEED: give each perdix-life scene its own SEED (1 to 50); the maker tunes them by what each life does.
- code: a file at a commit from Perdix's recent commits below, typed out on screen (path, ref, optional line ranges).
- card: a title card, for anything no shot kind can show yet. Put that in notes.

Perdix's recent commits (hash, subject, files):
${o.commits || "(none available)"}

Markers you may use inline: [boom] punch-in and shake, [scratch] record scratch, [ding] small win, [mash] keyboard mash, [pop], [whoosh].`;
}

/** The scene's lines as the voice keys them, in the document's order (repeats numbered). */
const keyedLines = (scenes: Scene[]) => {
  const flat = scenes.flatMap((s) => (s.say ?? []).map((l) => ({ scene: s.id, text: parseLine(l).text })));
  const keys = keySentences(flat.map((x) => x.text));
  return flat.map((x, i) => ({ ...x, key: keys[i]! }));
};
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, "");

/**
 * The draft as a document: the start document's settings (series voice,
 * captions, music, end card), the drafted scenes with their visuals; cues
 * become word anchors, unknown kinds and knobs are left out with a note.
 */
export function fromDraft(draft: ShortDraft, start: Short, o: { build: string; kinds: ShotKinds; repo: string; series?: Series }): { doc: Short; notes: string[] } {
  const notes = [...draft.notes];
  const look = { in: o.series?.scene.in ?? "cut", push: o.series?.scene.push ?? 1.02 } as const;
  const scenes: Scene[] = draft.scenes.map((d) => {
    const sc: Scene = { id: d.id, ...look };
    if (d.say?.length) sc.say = d.say;
    else sc.hold = d.hold ?? 3;
    if (d.continue && !d.shot && !d.code && !d.card) return { ...sc, continue: true };
    let v: Visual | undefined;
    if (d.shot) {
      const kind = o.kinds.kinds[d.shot.kind];
      if (!kind) {
        notes.push(`${d.id}: no shot kind "${d.shot.kind}" yet; a card stands in`);
        v = { type: "card", title: d.card?.title ?? d.shot.kind };
      } else {
        const knobs: Record<string, KnobValue> = {};
        for (const [k, val] of Object.entries(d.shot.knobs ?? {})) {
          if (k in kind.knobs) knobs[k] = val;
          else notes.push(`${d.id}: ${d.shot.kind} has no knob ${k}`);
        }
        v = { type: "shot", source: "perdix", kind: d.shot.kind, build: o.build, knobs };
      }
    } else if (d.code) {
      const lines = d.code.lines?.map((r) => [r.from, Math.max(r.from, r.to)] as [number, number]);
      v = { type: "code", files: [{ path: d.code.path, repo: o.repo, ref: d.code.ref, ...(lines?.length ? { lines } : {}) }], ...(d.code.caption ? { caption: d.code.caption } : {}) };
    } else {
      v = { type: "card", title: d.card?.title ?? d.id, ...(d.card?.subtitle ? { subtitle: d.card.subtitle } : {}) };
    }
    return { ...sc, visual: v };
  });
  // cues become word anchors once every line is in place (keys count repeats across the whole script)
  const lines = keyedLines(scenes);
  draft.scenes.forEach((d, i) => {
    const v = scenes[i]!.visual;
    if (v?.type !== "shot") return;
    const kind = o.kinds.kinds[v.kind]!;
    for (const c of d.shot?.cues ?? []) {
      if (!kind.knobs[c.knob]?.time) {
        notes.push(`${d.id}: ${c.knob} is not a time knob of ${v.kind}`);
        continue;
      }
      const hit = lines.filter((l) => l.scene === d.id).map((l) => ({ l, w: l.text.split(/\s+/).findIndex((t) => bare(t) === bare(c.word)) })).find((x) => x.w >= 0);
      if (!hit) {
        notes.push(`${d.id}: the cue ${c.knob} names "${c.word}", which its lines do not say`);
        continue;
      }
      v.knobs[c.knob] = { word: { s: hit.l.key, w: hit.w }, ...(c.edge === "end" ? { edge: "end" as const } : {}) };
    }
  });
  const doc: Short = { ...start, title: start.title, scenes, text: start.text.filter((t) => t.role !== "end"), fx: [], sfx: [], captions: { ...start.captions, overrides: [] } };
  const end = start.text.find((t) => t.role === "end");
  if (end && o.series) {
    const n = Number(end.text.match(/(\d+)\s*$/)?.[1]);
    doc.text.push(n ? endCard(o.series, n, scenes.at(-1)!.id) : { ...end, from: { scene: scenes.at(-1)!.id, edge: "end", offset: -o.series.endCard.seconds }, to: { scene: scenes.at(-1)!.id, edge: "end" } });
  }
  return { doc, notes };
}

/** What stops a drafted document: the schema, the cross-checks against an estimated voice, the series' wording. */
export function draftProblems(doc: Short, series?: Series): string[] {
  const parsed = Short.safeParse(doc);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  return [...checkShort(doc, { voice: estimatedVoice(doc) }).map((p) => `${p.at}: ${p.message}`), ...(series ? wordingProblems(series, doc) : [])];
}

/** True when the repo has the file at the ref (a drafted code scene must name a real one). */
export function gitHasFile(repo: string, ref: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", home(repo), "cat-file", "-e", `${ref}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The drafted code scenes whose file is not in the repo at its ref. */
export const missingCode = (doc: Short, has: typeof gitHasFile) =>
  doc.scenes.flatMap((s) => (s.visual?.type === "code" ? s.visual.files.filter((f) => f.repo && f.ref && !has(f.repo, f.ref, f.path)).map((f) => `${s.id}: ${f.path} is not in Perdix at ${f.ref}: pick a file the commit list shows`) : []));

export type DraftOptions = {
  writer?: Writer;
  model: string;
  brief: string;
  build: string;
  kinds: ShotKinds;
  repo: string;
  commits?: string;
  signal?: AbortSignal;
  log?: (line: string) => void;
  onAttempt?: (n: number) => void;
  /** How a code scene's file is checked (git by default; tests pass their own). */
  hasFile?: typeof gitHasFile;
};

/** Drafts the Short over its start document; a rejected draft goes back with its problems (three tries). */
export async function draftShort(start: Short, o: DraftOptions): Promise<{ doc: Short; notes: string[]; attempts: number }> {
  const series = start.series ? SERIES[start.series] : undefined;
  const writer = o.writer ?? askClaude;
  const prompt = draftPrompt({ title: start.title, template: start.template, brief: o.brief, series, kinds: o.kinds, commits: o.commits ?? recentCommits(o.repo) });
  const schema = writerSchema(ShortDraft);
  let p = prompt, last: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    o.onAttempt?.(attempt);
    const data = await writer(p, schema, o.model, o.signal, SHORT_SYSTEM);
    const parsed = ShortDraft.safeParse(data);
    let problems: string[];
    let out: { doc: Short; notes: string[] } | undefined;
    if (!parsed.success) problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    else {
      out = fromDraft(parsed.data, start, { build: o.build, kinds: o.kinds, repo: o.repo, series });
      problems = [...draftProblems(out.doc, series), ...missingCode(out.doc, o.hasFile ?? gitHasFile)];
    }
    if (!problems.length && out) return { ...out, attempts: attempt };
    last = problems;
    o.log?.(`draft: attempt ${attempt} rejected: ${problems.slice(0, 8).join("; ")}`);
    p = `${prompt}\n\nYour previous answer was rejected. Fix these problems and answer again:\n${problems.map((e) => `- ${e}`).join("\n")}\nPrevious answer:\n${JSON.stringify(data)}`;
  }
  throw new Error(`the draft was still invalid after 3 attempts:\n${last.slice(0, 12).join("\n")}`);
}
