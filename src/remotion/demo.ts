import type { Chapter } from "../../schema/storyboard.ts";
import { estimateTiming } from "../core/estimate.ts";
import type { ChapterProps } from "./ChapterVideo.tsx";

/** One beat of every primitive: the studio's default and the render smoke test. */
const chapter: Chapter = {
  title: "Every primitive once",
  beats: [
    { say: ["This is Emoton.", "It turns sources into explainers."], visual: { type: "title", title: "Sources in, video out", subtitle: "one beat of every primitive" } },
    {
      say: ["A storyboard is the goal.", "Sources feed the writer's claims.", "A validator lets through only what checks out."],
      cite: ["readme:s1"],
      visual: {
        type: "diagram",
        nodes: [{ id: "pdf", label: "notes.pdf", col: 0, row: 0 }, { id: "web", label: "web page", col: 0, row: 2 }, { id: "val", label: "validator", col: 2, row: 1, shape: "pill" }, { id: "sb", label: "storyboard", col: 4, row: 1 }],
        edges: [{ id: "e1", from: "pdf", to: "val", label: "claims" }, { id: "e2", from: "web", to: "val" }, { id: "e3", from: "val", to: "sb", label: "valid" }],
        steps: [{ show: ["sb"] }, { show: ["pdf", "web", "e1", "e2"] }, { show: ["val", "e3"], highlight: ["val"] }],
      },
    },
    {
      say: ["So nothing reaches the screen unchecked.", "Every claim points back to a page."],
      aha: true,
      visual: { type: "diagram", continue: true, nodes: [], edges: [], steps: [{ relabel: [{ id: "sb", label: "always renders" }], highlight: ["sb"] }, { highlight: ["e1", "e3"] }] },
    },
    { say: ["The writer sends a storyboard.", "The validator answers with errors."], visual: { type: "sequence", lanes: ["writer", "validator"], messages: [{ from: "writer", to: "validator", label: "storyboard.json" }, { from: "validator", to: "writer", label: "3 errors" }] } },
    { say: ["Item k appears when sentence k starts."], visual: { type: "equation", lines: ["t(\\text{item}_k) = t_{\\text{start}}(\\text{sentence}_k)"], caption: "the timing rule" } },
    { say: ["The pipeline is short.", "Ingest, write, voice, render."], visual: { type: "code", language: "pseudo", code: "for each video:\n  chunks = ingest(sources)\n  story = write(chunks)\n  render(voice(story))", steps: [{ lines: [2] }, { lines: [3, 4] }] } },
    { say: ["A chapter grows with its words, at about 150 a minute."], visual: { type: "graph", xLabel: "words", yLabel: "seconds", series: [{ label: "narration", points: [{ x: 40, y: 16 }, { x: 80, y: 32 }, { x: 160, y: 64 }, { x: 240, y: 96 }] }] } },
    { say: ["Sources in.", "A storyboard that always renders.", "Video out."], visual: { type: "bullets", heading: "Recap", items: ["sources in, every claim cited", "a storyboard that always renders", "a video in step with the voice"] } },
  ],
};

export const demoProps: ChapterProps = {
  videoTitle: "Emoton demo",
  index: 1,
  count: 1,
  chapter,
  timing: estimateTiming(chapter),
  sources: { readme: "README" },
  captions: true,
};
