import { test } from "node:test";
import assert from "node:assert/strict";
import { Chapter, crossCheck } from "../schema/storyboard.ts";
import { mathRuns, pieces, slideSpans, slideTotal, slidesBefore } from "../src/core/slides.ts";
import { fixture } from "./fixtures/helpers.ts";

const eq = (lines: string[]) => ({ type: "equation" as const, lines });
const say = (s: string) => [s];

/** A slides chapter: slide 1 (3 beats, a diagram built over two beats and a point-only beat), a full beat, slide 2. */
const chapter = (): Chapter => Chapter.parse({
  title: "Conditional probability",
  beats: [
    { say: say("Knowing B happened rules things out."), slide: { title: "Knowing B shrinks the world", headline: "$P(A|B) = P(A\\cap B)/P(B)$" }, point: "B rules out the rest",
      visual: { type: "diagram", nodes: [{ id: "s", label: "S" }], edges: [], steps: [{ show: ["s"] }] } },
    { say: say("B becomes the new sample space."), point: "B is the new sample space",
      visual: { type: "diagram", continue: true, nodes: [{ id: "b", label: "B" }], edges: [{ id: "e", from: "s", to: "b" }], steps: [{ show: ["b", "e"] }] } },
    { say: say("So we divide by P of B."), point: "Divide by P(B)" },
    { say: say("Here is the whole derivation."), full: true, visual: eq(["a", "b"]) },
    { say: say("Now turn it around."), slide: { title: "Bayes" }, point: "Turn the condition around", visual: eq(["c"]) },
  ],
});

test("slides: spans run from one slide to the next; pieces split at slides, full beats and new visuals", () => {
  const ch = chapter();
  assert.deepEqual(slideSpans(ch).map((s) => [s.slide.title, s.first, s.last]), [["Knowing B shrinks the world", 0, 3], ["Bayes", 4, 4]]);
  assert.deepEqual(pieces(ch).map((p) => [p.kind, p.span, p.first, p.last, p.visuals]), [
    ["panel", 0, 0, 2, [0, 1]], // the diagram continues, and the point-only beat keeps it
    ["full", 0, 3, 3, [3]],
    ["panel", 1, 4, 4, [4]],
  ]);
});

test("slides: a beat without a visual after a full beat shows the last visual there was", () => {
  const ch = chapter();
  ch.beats.splice(4, 0, { say: say("Back to the slide."), point: "Back" });
  const p = pieces(ch);
  assert.deepEqual(p.map((x) => [x.kind, x.first, x.visuals]), [["panel", 0, [0, 1]], ["full", 3, [3]], ["panel", 4, [3]], ["panel", 5, [5]]]);
});

test("slides: numbers run across the whole video", () => {
  const ch = chapter();
  assert.equal(slidesBefore([ch, null, ch], 1), 0);
  assert.equal(slidesBefore([ch, null, ch], 3), 2);
  assert.equal(slideTotal([ch, null, ch]), 4);
});

test("slides: the cross-check holds a slides chapter to the slide rules, a stage chapter to a visual per beat", () => {
  const ch = chapter();
  assert.deepEqual(crossCheck(ch, "slides"), []);
  assert.deepEqual(crossCheck(ch, "stage"), ["beat 3: every beat needs a visual"]);

  const noSlide = chapter();
  delete noSlide.beats[0]!.slide;
  assert.ok(crossCheck(noSlide, "slides").some((e) => /first beat of a chapter starts a slide/.test(e)));

  const bullets = chapter();
  bullets.beats[4]!.visual = { type: "bullets", items: ["x"] };
  assert.ok(crossCheck(bullets, "slides").some((e) => /bullets visual cannot sit in a slide's panel/.test(e)));
  bullets.beats[4]!.full = true;
  assert.ok(!crossCheck(bullets, "slides").some((e) => /panel/.test(e)), "full screen is fine");

  const bare = chapter();
  delete bare.beats[2]!.point;
  assert.ok(crossCheck(bare, "slides").some((e) => /beat 3: a beat without a visual must add a point/.test(e)));

  const crowded = chapter();
  for (let k = 0; k < 5; k++) crowded.beats.splice(1, 0, { say: say("More."), point: `point ${k}`, visual: eq(["x"]) });
  assert.ok(crossCheck(crowded, "slides").some((e) => /beats, at most 6/.test(e)));
  assert.ok(crossCheck(crowded, "slides").some((e) => /points, at most 5/.test(e)));

  const wordy = chapter();
  wordy.beats[0]!.point = "one two three four five six seven eight nine ten eleven twelve thirteen";
  assert.ok(crossCheck(wordy, "slides").some((e) => /more than 12 words/.test(e)));
});

test("slides: the existing stage storyboard still passes the stage cross-check", () => {
  for (const c of fixture("storyboard.json").chapters) assert.deepEqual(crossCheck(Chapter.parse(c), "stage"), []);
});

test("slides: headline text splits into plain and KaTeX runs", () => {
  assert.deepEqual(mathRuns("if $P(B) > 0$ then"), [{ tex: false, text: "if " }, { tex: true, text: "P(B) > 0" }, { tex: false, text: " then" }]);
  assert.deepEqual(mathRuns("costs \\$5"), [{ tex: false, text: "costs $5" }]);
});

test("venn and graph kinds: the cross-check names unknown sets and impossible CDFs", () => {
  const ch = (visual: unknown) => Chapter.parse({ title: "t", beats: [{ say: ["one"], visual }, { say: ["two"], visual: { type: "title", title: "x" } }] });
  const venn = { type: "venn", sets: [{ id: "a", label: "A" }, { id: "b", label: "B" }], elements: [{ label: "1", in: ["a"] }], steps: [{ shade: [{ in: ["a"], out: ["b"] }] }] };
  assert.deepEqual(crossCheck(ch(venn), "stage"), []);
  assert.ok(crossCheck(ch({ ...venn, steps: [{ shade: [{ in: ["c"] }] }] }), "stage").some((e) => /step 1 names unknown set c/.test(e)));
  assert.ok(crossCheck(ch({ ...venn, elements: [{ label: "1", in: ["z"] }] }), "stage").some((e) => /element 1 names unknown set z/.test(e)));
  const graph = (kind: string, ys: number[]) => ({ type: "graph", xLabel: "x", yLabel: "y", series: [{ label: "s", kind, points: ys.map((y, x) => ({ x, y })) }] });
  assert.deepEqual(crossCheck(ch(graph("steps", [0.2, 0.5, 1])), "stage"), []);
  assert.ok(crossCheck(ch(graph("steps", [0.5, 0.2, 1])), "stage").some((e) => /nondecreasing/.test(e)));
  assert.ok(crossCheck(ch(graph("steps", [0.5, 1.2])), "stage").some((e) => /within 0 to 1/.test(e)));
  assert.ok(crossCheck(ch(graph("bars", [0.5, -0.1])), "stage").some((e) => /bars cannot be negative/.test(e)));
  assert.deepEqual(crossCheck(ch(graph("bars", [1])), "stage"), [], "a single bar is fine");
  assert.ok(crossCheck(ch(graph("line", [1])), "stage").some((e) => /a line needs at least 2 points/.test(e)));
});

test("the storyboard prompt teaches slides only to a slides video", async () => {
  const { chapterPrompt } = await import("../pipeline/prompts.ts");
  const { Project } = await import("../pipeline/project.ts");
  const outline = fixture("outline.json");
  const base = Project.parse({ ...fixture<Record<string, unknown>>("project.json"), sources: [] });
  const slides = chapterPrompt({ ...base, layout: "slides" }, outline, outline.chapters.length - 1, []);
  const stage = chapterPrompt(base, outline, outline.chapters.length - 1, []);
  assert.match(slides, /Layout: SLIDES/);
  assert.match(slides, /a slide titled "Recap"/);
  assert.match(slides, /Takeaway slide/);
  assert.match(slides, /first sentence states the beat's point/);
  assert.doesNotMatch(stage, /Layout: SLIDES/);
  assert.match(stage, /recap beat \(bullets/);
  // both learn the new visuals
  for (const p of [slides, stage]) assert.match(p, /venn \{sets/);
});

test("switching a video to slides makes its storyboards stale; switching back makes them ok again", async () => {
  const { lib, readyBundle, temp } = await import("./fixtures/helpers.ts");
  const t = temp();
  try {
    const L = lib(t);
    await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    const sb = async () => (await L.state(id)).chapters.map((c) => c.storyboard);
    assert.deepEqual(await sb(), ["ok", "ok", "ok", "ok"]);
    await L.updateBrief(id, { layout: "slides" });
    assert.equal((await L.detail(id)).brief.layout, "slides");
    assert.deepEqual(await sb(), ["stale", "stale", "stale", "stale"]);
    await L.updateBrief(id, { layout: "stage" });
    assert.deepEqual(await sb(), ["ok", "ok", "ok", "ok"]);
  } finally {
    t.done();
  }
});

test("slides PDF: one page per slide at the end of its last panel piece, and one per full beat, in order", async () => {
  const { pageTimes } = await import("../pipeline/slides-pdf.ts");
  const { estimateTiming } = await import("../src/core/estimate.ts");
  const ch = chapter();
  const timing = estimateTiming(ch);
  const pages = pageTimes(ch, timing);
  assert.deepEqual(pages.map((p) => p.kind), ["slide", "full", "slide"]);
  const b = timing.beats.map((x) => x.start);
  // slide 1's page: inside beat 3 (its last panel beat), before the full beat starts
  assert.ok(pages[0]!.t > b[2]! && pages[0]!.t < b[3]! - 0.25, String(pages[0]!.t));
  assert.ok(pages[1]!.t > b[3]! && pages[1]!.t < b[4]! - 0.25, String(pages[1]!.t));
  assert.ok(pages[2]!.t > b[4]! && pages[2]!.t < timing.duration, String(pages[2]!.t));
});

test("slides: a point-only beat after a full-screen title keeps an empty panel, not the title", () => {
  const ch = Chapter.parse({ title: "t", beats: [
    { say: ["Welcome."], slide: { title: "Intro" }, point: "Hook", full: true, visual: { type: "title", title: "The video" } },
    { say: ["First."], point: "First point" },
  ] });
  assert.deepEqual(pieces(ch).map((p) => [p.kind, p.visuals]), [["full", [0]], ["panel", []]]);
});

test("venn apart: sets drawn separately share no element and no intersection", () => {
  const ch = (visual: unknown) => Chapter.parse({ title: "t", beats: [{ say: ["one"], visual }, { say: ["two"], visual: { type: "title", title: "x" } }] });
  const base = { type: "venn", apart: true, sets: [{ id: "o", label: "odd" }, { id: "e", label: "even" }], elements: [{ label: "1", in: ["o"] }, { label: "2", in: ["e"] }], steps: [{ shade: [{ in: ["o"] }, { in: ["e"] }] }] };
  assert.deepEqual(crossCheck(ch(base), "stage"), []);
  assert.ok(crossCheck(ch({ ...base, elements: [{ label: "2", in: ["o", "e"] }] }), "stage").some((e) => /apart sets share nothing/.test(e)));
  assert.ok(crossCheck(ch({ ...base, steps: [{ shade: [{ in: ["o", "e"] }] }] }), "stage").some((e) => /intersection of apart sets is empty/.test(e)));
});

test("point first: a beat's visual starts on its second sentence; the panel keeps the previous visual until then", async () => {
  const { timeline, visualTiming } = await import("../src/core/slides.ts");
  const { estimateTiming } = await import("../src/core/estimate.ts");
  const ch = Chapter.parse({ title: "t", beats: [
    { say: ["One.", "Two."], slide: { title: "S1" }, point: "p1", visual: eq(["a"]) },
    { say: ["Point here.", "Now the panel."], point: "p2", visual: eq(["b"]) },
    { say: ["Next slide."], slide: { title: "S2" }, point: "p3", visual: eq(["c"]) },
  ] });
  const timing = estimateTiming(ch, 2.6, "slides");
  const b1 = timing.beats[1]!;
  assert.equal(visualTiming(ch.beats[1]!, b1).start, b1.sentences[1]!.start);
  assert.equal(visualTiming(ch.beats[2]!, timing.beats[2]!).start, timing.beats[2]!.start, "one sentence: no delay");
  const tl = timeline(ch, timing);
  // piece 1 (beat 2's visual) starts with its second sentence; piece 0 runs until then
  assert.ok(Math.abs(tl.pieces[1]!.start - (b1.sentences[1]!.start - 0.25)) < 1e-9);
  assert.equal(tl.pieces[0]!.end, tl.pieces[1]!.start);
  // the next slide starts at its first beat, and the piece before it ends there
  assert.ok(Math.abs(tl.spans[1]!.start - (timing.beats[2]!.start - 0.25)) < 1e-9);
  assert.equal(tl.pieces[1]!.end, tl.spans[1]!.start);
});

test("slides pace: longer pauses, a slide pause before a new slide, the stage pace unchanged", async () => {
  const { GAPS, SLIDE_GAPS, beatPauses, estimateTiming } = await import("../src/core/estimate.ts");
  const ch = chapter();
  ch.beats[1]!.aha = true;
  assert.deepEqual(beatPauses(ch, "slides"), [SLIDE_GAPS.beat, SLIDE_GAPS.aha, SLIDE_GAPS.beat, SLIDE_GAPS.slide, SLIDE_GAPS.beat]);
  assert.deepEqual(beatPauses(ch, "stage"), [GAPS.beat, GAPS.aha, GAPS.beat, GAPS.beat, GAPS.beat]);
  const slow = estimateTiming(ch, 2.6, "slides"), stage = estimateTiming(ch, 2.6);
  assert.ok(slow.duration > stage.duration + 5, `${slow.duration} vs ${stage.duration}`);
  assert.deepEqual(estimateTiming(ch), stage, "the default is the stage pace");
});
