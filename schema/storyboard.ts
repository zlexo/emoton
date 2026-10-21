/**
 * The storyboard contract. The writer (an LLM) fills this, the renderer draws it.
 * The writer never writes animation code: every visual is one of these primitives,
 * and every primitive always renders.
 *
 * Timing rule shared by every primitive: a visual has an ordered list of reveal
 * items (bullets, equation lines, diagram steps, code steps, messages, series).
 * Item k appears when sentence k of the beat starts. Items beyond the last
 * sentence are spread across the last sentence.
 */
import { z } from "zod/v4";

const Id = z.string().min(1).max(32).describe("short id, letters digits - _");
const Short = (n: number) => z.string().min(1).max(n);

export const TitleVisual = z.object({
  type: z.literal("title"),
  title: Short(80),
  subtitle: Short(140).optional(),
});

export const BulletsVisual = z.object({
  type: z.literal("bullets"),
  heading: Short(80).optional(),
  items: z.array(Short(90)).min(1).max(5),
});

export const DiagramNode = z.object({
  id: Id,
  label: Short(40),
  col: z.number().int().min(0).max(4).optional().describe("grid column 0-4, left to right"),
  row: z.number().int().min(0).max(2).optional().describe("grid row 0-2, top to bottom"),
  shape: z.enum(["box", "pill", "stack"]).optional().describe("stack = a queue or buffer"),
});

export const DiagramEdge = z.object({
  id: Id,
  from: Id,
  to: Id,
  label: Short(32).optional(),
});

export const DiagramStep = z.object({
  show: z.array(Id).optional().describe("node or edge ids that appear at this step"),
  hide: z.array(Id).optional(),
  highlight: z.array(Id).optional().describe("ids glowing during this step only"),
  relabel: z
    .array(z.object({ id: Id, label: Short(40) }))
    .optional()
    .describe("change a node's label from this step on"),
});

export const DiagramVisual = z.object({
  type: z.literal("diagram"),
  continue: z
    .boolean()
    .optional()
    .describe("true = keep the previous beat's diagram on screen and build on it"),
  nodes: z.array(DiagramNode).max(10),
  edges: z.array(DiagramEdge).max(12),
  steps: z.array(DiagramStep).min(1).max(8),
});

export const SequenceVisual = z.object({
  type: z.literal("sequence"),
  lanes: z.array(Short(24)).min(2).max(4).describe("actors, left to right"),
  messages: z
    .array(z.object({ from: Short(24), to: Short(24), label: Short(40) }))
    .min(1)
    .max(9),
});

export const EquationVisual = z.object({
  type: z.literal("equation"),
  lines: z.array(Short(160)).min(1).max(4).describe("KaTeX LaTeX, one line each"),
  caption: Short(90).optional(),
});

export const CodeVisual = z.object({
  type: z.literal("code"),
  language: z.enum(["c", "javascript", "python", "haskell", "pseudo"]),
  code: z.string().min(1).max(900).describe("at most 14 lines"),
  steps: z
    .array(z.object({ lines: z.array(z.number().int().min(1)).min(1) }))
    .min(1)
    .max(8)
    .describe("1-based line numbers lit at each step, the rest dims"),
});

export const GraphVisual = z.object({
  type: z.literal("graph"),
  xLabel: Short(30),
  yLabel: Short(30),
  series: z
    .array(
      z.object({
        label: Short(30),
        kind: z
          .enum(["line", "bars", "steps"])
          .optional()
          .describe("line (default); bars = a PMF, a bar at each point; steps = a CDF, right-continuous, a closed dot at the top of each jump"),
        points: z.array(z.object({ x: z.number(), y: z.number() })).min(1).max(60),
      }),
    )
    .min(1)
    .max(3),
  highlight: z
    .array(z.object({ x: z.number(), label: Short(30).optional() }))
    .max(4)
    .optional()
    .describe("mark the bar or jump at x in yellow, after the series are drawn"),
});

/** A region of a Venn diagram: inside every set in `in`, outside every set in `out`. */
export const VennRegion = z.object({
  in: z.array(Id).max(3).describe("inside all of these sets ([] = outside every set when out lists them)"),
  out: z.array(Id).max(3).optional().describe("and outside all of these"),
});

export const VennVisual = z.object({
  type: z.literal("venn"),
  universe: Short(20).optional().describe("label of the box around the sets, default S"),
  apart: z.boolean().optional().describe("draw the sets as separate circles: mutually exclusive events (odd and even, A and its complement's pieces)"),
  sets: z.array(z.object({ id: Id, label: Short(20) })).min(2).max(3),
  elements: z
    .array(z.object({ label: Short(12), in: z.array(Id).max(3) }))
    .max(12)
    .optional()
    .describe("outcomes drawn in their region, e.g. die faces; in = the sets the outcome belongs to"),
  steps: z
    .array(z.object({ shade: z.array(VennRegion).max(8), caption: Short(60).optional() }))
    .min(1)
    .max(6)
    .describe("each step shades its regions; earlier steps fade back"),
});

export const Visual = z.discriminatedUnion("type", [
  TitleVisual,
  BulletsVisual,
  DiagramVisual,
  SequenceVisual,
  EquationVisual,
  CodeVisual,
  GraphVisual,
  VennVisual,
]);

/** A slide: stays on screen over its beats (slides layout). Its headline may hold KaTeX between $...$. */
export const Slide = z.object({
  title: Short(70).describe("the slide's question or claim"),
  headline: Short(160).optional().describe("the slide's one rule, KaTeX between $...$"),
});

export const Beat = z.object({
  say: z
    .array(Short(240))
    .min(1)
    .max(6)
    .describe("narration, one sentence per entry; sentence k reveals item k"),
  slide: Slide.optional().describe("slides layout: this beat starts a new slide"),
  point: Short(90).optional().describe("slides layout: the bullet this beat adds to its slide"),
  full: z.boolean().optional().describe("slides layout: the visual takes the whole screen for this beat"),
  visual: Visual.optional().describe("absent (slides layout only): the panel keeps the previous visual"),
  cite: z.array(z.string()).max(4).optional().describe("chunk ids backing this beat"),
  aha: z.boolean().optional().describe("the key insight: hold a pause after it"),
});

export const Chapter = z.object({
  title: Short(60),
  beats: z.array(Beat).min(2).max(16),
});

export const OutlineChapter = z.object({
  title: Short(60),
  goal: Short(200).describe("what the viewer can do or see after this chapter"),
  claims: z
    .array(z.object({ text: Short(240), cite: z.array(z.string()).min(1).max(4) }))
    .min(1)
    .max(8),
});

export const Outline = z.object({
  title: Short(80),
  hook: Short(240).describe("the concrete question or puzzle the video opens with"),
  chapters: z.array(OutlineChapter).min(2).max(6),
});

export type TitleVisual = z.infer<typeof TitleVisual>;
export type BulletsVisual = z.infer<typeof BulletsVisual>;
export type DiagramVisual = z.infer<typeof DiagramVisual>;
export type DiagramNode = z.infer<typeof DiagramNode>;
export type DiagramEdge = z.infer<typeof DiagramEdge>;
export type SequenceVisual = z.infer<typeof SequenceVisual>;
export type EquationVisual = z.infer<typeof EquationVisual>;
export type CodeVisual = z.infer<typeof CodeVisual>;
export type GraphVisual = z.infer<typeof GraphVisual>;
export type VennVisual = z.infer<typeof VennVisual>;
export type VennRegion = z.infer<typeof VennRegion>;
export type Visual = z.infer<typeof Visual>;
export type Beat = z.infer<typeof Beat>;
export type Slide = z.infer<typeof Slide>;
export type Chapter = z.infer<typeof Chapter>;
export type Outline = z.infer<typeof Outline>;

/** Timings produced by the voice stage, consumed by the renderer. Seconds. */
export type WordTiming = { text: string; start: number; end: number };
/**
 * `words`: the voice step's own word times (Kokoro's duration frames), absent
 * for a voice that has none (macOS `say`) and in timings made before them.
 * `estimated`: the words were split by letters, not timed by the voice.
 */
export type SentenceTiming = { start: number; end: number; text: string; words?: WordTiming[]; estimated?: boolean };
export type BeatTiming = { start: number; end: number; sentences: SentenceTiming[] };
export type ChapterTiming = {
  leadIn: number;
  duration: number;
  audio: string;
  beats: BeatTiming[];
};

/** How a video is drawn: slides to follow with an animation panel, or today's full stage. */
export type Layout = "slides" | "stage";

/** The most bullets a slide holds, and the most beats it spans. */
export const SLIDE_POINTS = 5;
export const SLIDE_BEATS = 6;
const POINT_WORDS = 12;

/** Slide rules the schema cannot express (slides layout only). */
function slideCheck(ch: Chapter): string[] {
  const errs: string[] = [];
  if (ch.beats[0] && !ch.beats[0].slide) errs.push("beat 1: the first beat of a chapter starts a slide (give it slide)");
  let start = 0;
  const close = (end: number) => {
    const beats = ch.beats.slice(start, end);
    const points = beats.filter((b) => b.point).length;
    const where = `slide at beat ${start + 1}`;
    if (beats.length > SLIDE_BEATS) errs.push(`${where}: ${beats.length} beats, at most ${SLIDE_BEATS}`);
    if (points > SLIDE_POINTS) errs.push(`${where}: ${points} points, at most ${SLIDE_POINTS}`);
    if (points === 0) errs.push(`${where}: a slide needs at least one point`);
  };
  ch.beats.forEach((b, i) => {
    const where = `beat ${i + 1}`;
    if (i > 0 && b.slide) {
      close(i);
      start = i;
    }
    if (b.point && b.point.trim().split(/\s+/).length > POINT_WORDS) errs.push(`${where}: the point has more than ${POINT_WORDS} words`);
    if (!b.visual && !b.point) errs.push(`${where}: a beat without a visual must add a point`);
    if (!b.visual && b.full) errs.push(`${where}: full screen needs a visual`);
    if (b.visual && !b.full && (b.visual.type === "title" || b.visual.type === "bullets"))
      errs.push(`${where}: a ${b.visual.type} visual cannot sit in a slide's panel (the slide has its own title and points); make it full or drop it`);
  });
  if (ch.beats.length) close(ch.beats.length);
  return errs;
}

/** Checks the schema cannot express: references between ids, and the layout's rules. */
export function crossCheck(ch: Chapter, layout: Layout = "stage"): string[] {
  const errs: string[] = layout === "slides" ? slideCheck(ch) : [];
  const known = new Set<string>();
  ch.beats.forEach((b, i) => {
    const where = `beat ${i + 1}`;
    const v = b.visual;
    if (!v) {
      // slides: the panel keeps the previous visual, so a diagram can go on building after it
      if (layout === "stage") errs.push(`${where}: every beat needs a visual`);
      return;
    }
    if (v.type === "diagram") {
      if (!v.continue) known.clear();
      else if (i === 0 || lastVisual(ch, i)?.type !== "diagram")
        errs.push(`${where}: continue=true but the previous beat is not a diagram`);
      for (const n of v.nodes) known.add(n.id);
      for (const e of v.edges) {
        for (const end of [e.from, e.to])
          if (!known.has(end)) errs.push(`${where}: edge ${e.id} points at unknown node ${end}`);
        known.add(e.id);
      }
      v.steps.forEach((s, k) => {
        for (const id of [...(s.show ?? []), ...(s.hide ?? []), ...(s.highlight ?? []), ...(s.relabel ?? []).map((r) => r.id)])
          if (!known.has(id)) errs.push(`${where} step ${k + 1}: unknown id ${id}`);
      });
    } else known.clear();
    if (v.type === "sequence") {
      v.messages.forEach((m, k) => {
        for (const l of [m.from, m.to])
          if (!v.lanes.includes(l)) errs.push(`${where} message ${k + 1}: unknown lane ${l}`);
      });
    }
    if (v.type === "venn") {
      const ids = new Set(v.sets.map((x) => x.id));
      if (ids.size !== v.sets.length) errs.push(`${where}: venn set ids must differ`);
      const known = (id: string, what: string) => ids.has(id) || void errs.push(`${where}: ${what} names unknown set ${id}`);
      (v.elements ?? []).forEach((e, k) => e.in.forEach((id) => known(id, `element ${k + 1}`)));
      if (v.apart) {
        (v.elements ?? []).forEach((e, k) => e.in.length > 1 && errs.push(`${where}: element ${k + 1} is in ${e.in.length} sets, but apart sets share nothing`));
        v.steps.forEach((st, k) => st.shade.forEach((r) => r.in.length > 1 && errs.push(`${where} step ${k + 1}: an intersection of apart sets is empty`)));
      }
      v.steps.forEach((st, k) => st.shade.forEach((r) => [...r.in, ...(r.out ?? [])].forEach((id) => known(id, `step ${k + 1}`))));
    }
    if (v.type === "graph") {
      v.series.forEach((sr, k) => {
        const ys = [...sr.points].sort((a, b) => a.x - b.x).map((p) => p.y);
        if (sr.kind === "steps" && (ys.some((y, i) => i > 0 && y < ys[i - 1]!) || ys.some((y) => y < 0 || y > 1)))
          errs.push(`${where} series ${k + 1}: a CDF (steps) must be nondecreasing and within 0 to 1`);
        if (sr.kind === "bars" && ys.some((y) => y < 0)) errs.push(`${where} series ${k + 1}: bars cannot be negative`);
        if ((sr.kind ?? "line") === "line" && sr.points.length < 2) errs.push(`${where} series ${k + 1}: a line needs at least 2 points`);
      });
    }
    if (v.type === "code") {
      const n = v.code.split("\n").length;
      if (n > 14) errs.push(`${where}: code has ${n} lines, max 14`);
      v.steps.forEach((s, k) => {
        for (const l of s.lines) if (l > n) errs.push(`${where} step ${k + 1}: line ${l} > ${n}`);
      });
    }
  });
  return errs;
}

/** The visual on screen before beat i: the nearest earlier beat that has one. */
export function lastVisual(ch: Chapter, i: number): Visual | undefined {
  for (let k = i - 1; k >= 0; k--) if (ch.beats[k]!.visual) return ch.beats[k]!.visual;
  return undefined;
}

/**
 * The JSON Schema handed to the writer. Structured-output backends support a
 * subset of JSON Schema, so size limits are stripped here and oneOf becomes
 * anyOf; zod still enforces every limit afterwards and failures go back to the
 * writer with the error list.
 */
export function writerSchema(schema: z.ZodType): object {
  const drop = new Set(["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "$schema"]);
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) {
        if (drop.has(k)) continue;
        out[k === "oneOf" ? "anyOf" : k] = walk(v);
      }
      return out;
    }
    return x;
  };
  return walk(z.toJSONSchema(schema)) as object;
}
