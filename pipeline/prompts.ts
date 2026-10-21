import type { Chapter, Outline } from "../schema/storyboard.ts";
import type { Chunk, Project } from "./project.ts";

export const WORDS_PER_MINUTE = 150;
/** A slides video pauses longer (time to read and look), so fewer words fill a minute. */
export const SLIDES_WORDS_PER_MINUTE = 120;
const wpm = (p: Project) => (p.layout === "slides" ? SLIDES_WORDS_PER_MINUTE : WORDS_PER_MINUTE);

export const SYSTEM = `You are the writer for Emoton, a tool that turns source documents into narrated, animated explainer videos in the style of 3Blue1Brown. A calm narrator speaks while simple diagrams build up on screen. You reply only with JSON that matches the given schema.`;

const PEDAGOGY = `How these videos teach (hard rules):
- Concrete before general: show one specific case first, name the general rule after.
- One idea on screen at a time. Visuals build step by step; they never jump.
- Every chapter has one "aha": the moment the idea clicks. Set aha: true on that beat.
- Motivate before you define: say what problem a thing solves before naming it.
- Talk to one viewer ("you"), conversational and precise. No hype, no filler, no "in this video".
- Never read a bullet list aloud. Bullets are only for a recap.
- Ground every claim in the sources. If the sources do not support it, leave it out.
- On-screen text is labels, symbols and numbers only, placed on what they label. Never put a sentence on screen that the narrator also says.
- Highlight only the term or region being discussed right now, one at a time.
- Show probability as concrete counts first (out of 1000 students, 20 ...), then the formula. Read a conditional as A among B.
- Every chapter ends with a check: one beat asks a short exam-style question and says: Pause the video and try it. The next beat gives the answer and one sentence of why.
- Where learners hold a known misconception about the topic, ask the viewer to predict first, show what actually happens, then name the wrong belief and say why it fails.`;

const SOURCES = (chunks: Chunk[]) =>
  chunks.map((c) => `<chunk id="${c.id}">\n${c.text}\n</chunk>`).join("\n\n");

const BRIEF = (p: Project) => `Video: "${p.title}"
Topic: ${p.topic}
Viewer: ${p.audience}
Length: about ${p.minutes} minutes of narration (about ${p.minutes * wpm(p)} words in total).
${p.rules.length ? "Project rules (obey strictly):\n" + p.rules.map((r) => `- ${r}`).join("\n") : ""}`;

export function outlinePrompt(p: Project, chunks: Chunk[], opts: { previous?: Outline; note?: string } = {}): string {
  const revise = opts.previous
    ? `\nRevision request from the viewer: "${opts.note ?? "improve it"}"\nPrevious outline:\n${JSON.stringify(opts.previous)}\nRewrite the outline to address the request. Keep what worked.\n`
    : "";
  return `${BRIEF(p)}

${PEDAGOGY}

Task: write the OUTLINE for this video.
- hook: one concrete question or puzzle the viewer feels, which the video answers. At most 40 words.
- 3 to 5 chapters. Each builds on the one before. Order concrete to abstract.
- For each chapter: a title (at most 6 words), a goal (what the viewer can do or see afterwards), and 2 to 6 claims.
- Each claim is one sentence and cites the chunk ids that directly support it, like "notes:p6". Cite only ids that appear below.
- The last chapter ends by tying back to the hook.
${revise}
Sources:

${SOURCES(chunks)}`;
}

const PRIMITIVES = `Visual primitives. Each beat has exactly one visual. A visual reveals items in order; item k appears when sentence k of the beat starts (extra items share the last sentence). So match the number of reveal items to the number of sentences.

- title {title, subtitle?}: reveal items = 1 or 2. Use for the opening beat of the video, or for a chapter's one-sentence takeaway (the takeaway line as the title).
- diagram {nodes, edges, steps, continue?}: boxes and arrows. Reveal items = steps.
  - nodes: {id, label (at most 3 words), col 0-4, row 0-2, shape?: "box" | "pill" | "stack"}. The grid is 5 columns by 3 rows; place nodes so the flow reads left to right. Use "stack" for a queue or buffer, "pill" for a mechanism like a scheduler.
  - edges: {id, from, to, label? (at most 3 words)}.
  - steps: {show?: ids, hide?: ids, highlight?: ids, relabel?: [{id, label}]}. show makes nodes and edges appear, highlight glows ids for that step only, relabel changes a node's text until another relabel changes it back. Keep diagrams to 6 nodes or fewer when you can; the grid gets crowded above that.
  - continue: true keeps the previous beat's diagram on screen and builds on it (its nodes stay where they are; list only NEW nodes and edges). Prefer building one diagram over several beats to starting a new one each beat.
- sequence {lanes, messages}: a time-ordered message chart between 2 to 4 actors (client, server, kernel...). Reveal items = messages. Good for protocols and request flows.
- equation {lines, caption?}: KaTeX LaTeX lines. Reveal items = lines. For a derivation, one operation per line, each line keeping the previous symbols in the same order so the eye can follow what changed, and a short goal in the caption (standardize, take the log). Give each quantity one color for the whole video with \\textcolor{#58C4DD}{...} (blue), \\textcolor{#F4D345}{...} (yellow), \\textcolor{#83C167}{...} (green), \\textcolor{#FC6255}{...} (red), \\textcolor{#F0AC5F}{...} (gold); say the color mapping once (the mean in blue). Use \\Phi for the standard normal cdf.
- code {language, code, steps}: at most 14 lines; steps light line numbers. Reveal items = steps.
- graph {xLabel, yLabel, series, highlight?}: points {x, y}. Reveal items = series. Each series has kind: "line" (default), "bars" (a PMF: one bar per point) or "steps" (a CDF: a right-continuous step function, one point per jump with the value after the jump, nondecreasing, within 0 to 1). highlight: [{x, label?}] marks a bar or a jump in yellow after the series are drawn ("3/8", "jump = 1/6"). Only for data the sources give or that is exact (no made-up measurements); compute PMF and CDF values exactly.
- venn {sets, universe?, elements?, steps}: 2 or 3 sets {id, label} in a box labelled universe (default S). elements: outcomes {label, in: set ids} drawn in their region (the faces of a die, cards). steps: {shade: regions, caption?}; a region is {in: set ids, out?: set ids}: inside every set in "in" and outside every set in "out" (A and B: {in: [a, b]}; A without B: {in: [a], out: [b]}; the complement of A: {in: [], out: [a]}). Each step shades the union of its regions; earlier steps fade back. Reveal items = steps. Use it for events, unions, intersections, complements, partitions and conditioning (shade B, then A and B). apart: true draws the sets as separate circles: always use it for mutually exclusive events (odd and even, a partition), so the picture never shows an overlap that is not there.
- bullets {heading?, items}: at most 5 short items. Reveal items = items. Recap only.`;

const NARRATION = `Narration rules:
- say is a list of sentences, 1 to 4 per beat. Each sentence at most 22 words, plain spoken English.
- Written to be heard: no parentheses, no markdown, no "e.g.", no slashes, no symbols read aloud. Identifiers like read_chunk are fine; say them as words.
- Numbers: digits are fine (1024, 5 seconds). Write units as words (sixteen mebibytes, not 16 MiB).
- Every beat's visual shows what its sentences say, at the moment they say it.
- No em dashes or en dashes anywhere (they show in the captions): use a comma, a colon or a new sentence.
- This is one video, not a series: never call it a series, and do not number chapters out loud.
- Math is said the way a lecturer says it: mu, sigma squared, X bar, Phi of 1.5, n equals 36. Never read LaTeX.
- cite: the chunk ids that back the beat, if any.`;

const SLIDES = `Layout: SLIDES. The video is a deck of slides the viewer follows, with an animation panel on each slide. This replaces "Bullets are only for a recap" and "each beat has exactly one visual" above.
- Group the beats into slides of 2 to 4 beats (at most 6). The first beat of the chapter starts a slide; a beat starts a new slide by giving slide: {title, headline?}.
- One idea per slide. The title is a question or a claim, at most 8 words ("Why a single point has probability zero"). The headline is the slide's one rule or formula, KaTeX between $...$ (like "$P(A \\mid B) = \\dfrac{P(A \\cap B)}{P(B)}$"); leave headline out when the slide has no single rule.
- Each beat gives a point: the beat's takeaway in at most 12 words, in your own words, never a copy of a narrated sentence. At most 5 points per slide. Math in points goes between $...$. The points of a slide read as its summary.
- The panel on the right plays the beat's visual. Leave visual out when the panel should keep showing the previous visual (a beat that only adds a point).
- full: true makes the visual take the whole screen for that beat (the slide steps aside and comes back after): use it for diagrams with more than 5 nodes, derivations of more than 3 lines, and graphs with labels to read. Never give a title or bullets visual without full: true (the chapter is rejected); prefer none at all, the slide's title and points do that job.
- Every slide still teaches with something moving: a venn being shaded, an equation building, a graph drawing, a diagram growing.
- Teach like a patient lecturer at the board, not a trailer. Take the time an idea needs: say what you are about to do, do it, then say what it showed and why it is true. Prefer two plain sentences to one dense one. 2 to 5 sentences per beat.
- Order inside a beat: the first sentence states the beat's point (it appears on the left as you say it, so the viewer reads it while hearing it). The panel's visual starts with the second sentence: from there, one sentence per reveal item. So a beat with a point and a visual has one more sentence than its visual has reveal items. A beat with only one sentence shows its point and visual together.
- Signpost every move: the first sentence of each new slide says where we are and where we go next ("We can now describe any event. Next: how likely it is."), even though the slide title also shows it.
- End every chapter with a Takeaway slide (the last chapter's Recap slide is its takeaway instead): slide {title: "Takeaway", headline: the chapter's one rule or formula}, one beat with a point (the rule in plain words) and 2 sentences: the rule restated slowly, then how the next chapter builds on it (the last chapter: how it answers the opening question). No visual on that beat (the panel keeps the last one), and never a title visual.`;

export function chapterPrompt(
  p: Project,
  outline: Outline,
  index: number,
  chunks: Chunk[],
  opts: { previous?: Chapter; note?: string; prevChapterEnd?: string } = {},
): string {
  const ch = outline.chapters[index]!;
  const n = outline.chapters.length;
  const budget = Math.round((p.minutes * wpm(p)) / n);
  const cited = new Set(ch.claims.flatMap((c) => c.cite));
  const pages = chunks.filter((c) => cited.has(c.id));
  const outlineText = outline.chapters
    .map((c, i) => `${i + 1}. ${c.title}: ${c.goal}${i === index ? "   <-- THIS CHAPTER" : ""}`)
    .join("\n");
  const slides = p.layout === "slides";
  const position =
    index === 0
      ? slides
        ? `This is the FIRST chapter. Open with a slide titled "${outline.title}" whose first beat poses the hook: ${outline.hook}`
        : `This is the FIRST chapter. Open with a title beat for the video ("${outline.title}"), then pose the hook: ${outline.hook}`
      : index === n - 1
        ? slides
          ? `This is the LAST chapter. Answer the hook (${outline.hook}), then end with a slide titled "Recap": one beat per recap item, each beat's point is the item. That recap is this chapter's closing takeaway.`
          : `This is the LAST chapter. Answer the hook (${outline.hook}), then end with a recap beat (bullets, one sentence per item). That recap is this chapter's closing takeaway.`
        : `This is a middle chapter. Do not repeat the video title.`;
  const revise = opts.previous
    ? `\nRevision request from the viewer: "${opts.note ?? "improve it"}"\nPrevious version of this chapter:\n${JSON.stringify(opts.previous)}\nRewrite the chapter to address the request. Keep what worked.\n`
    : "";
  return `${BRIEF(p)}

${PEDAGOGY}

Whole video outline:
${outlineText}

${position}
${opts.prevChapterEnd ? `The previous chapter ended with: "${opts.prevChapterEnd}"` : ""}

Task: write the STORYBOARD for chapter ${index + 1}, "${ch.title}".
Goal: ${ch.goal}
Claims to cover, each backed by its cited chunks:
${ch.claims.map((c) => `- ${c.text} [${c.cite.join(", ")}]`).join("\n")}

Length: about ${budget} words of narration (within 20 percent) across 5 to 12 beats. Cover fewer claims well rather than all claims thinly. ${slides ? "End the chapter with the Takeaway slide described below." : "The last beat of the chapter is a one-sentence takeaway."}

${PRIMITIVES}
${slides ? `\n${SLIDES}\n` : ""}
${NARRATION}
${revise}
Cited sources:

${SOURCES(pages)}`;
}
