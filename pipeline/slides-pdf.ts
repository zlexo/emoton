/**
 * The Slides PDF: one page per
 * slide in its finished state, and one per full-screen beat, in video order.
 * Pages are stills of the real renderer at the end of each slide, so a page is
 * what the video shows there (without captions). Cached as out/<slug>-slides.pdf
 * with the hash of everything that draws it.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Chapter, ChapterTiming } from "../schema/storyboard.ts";
import { pieces, slideSpans, timeline } from "../src/core/slides.ts";
import { throwIfAborted } from "./proc.ts";
import { isFile, loadProject, loadStoryboard, maybe, paths, readJson, writeJson } from "./project.ts";
import { chapterProps, getBundle } from "./render.ts";
import { ownStatuses, rendererVersion, sha, snapshot } from "./state.ts";

/** When to take each page of a chapter, in seconds: the end of each slide's last panel piece, and of each full piece. */
export function pageTimes(ch: Chapter, timing: ChapterTiming): { t: number; kind: "slide" | "full" }[] {
  const ps = pieces(ch);
  const win = timeline(ch, timing).pieces;
  // late in the piece (everything revealed) but before its fade out
  const at = (k: number) => Math.max(win[k]!.start + 0.4, win[k]!.end - (k === ps.length - 1 ? 0.9 : 0.45));
  const out: { t: number; kind: "slide" | "full"; k: number }[] = [];
  slideSpans(ch).forEach((_, s) => {
    const mine = ps.map((p, k) => ({ p, k })).filter(({ p }) => p.span === s);
    const panels = mine.filter(({ p }) => p.kind === "panel");
    if (panels.length) out.push({ t: at(panels[panels.length - 1]!.k), kind: "slide", k: panels[panels.length - 1]!.k });
    for (const { k } of mine.filter(({ p }) => p.kind === "full")) out.push({ t: at(k), kind: "full", k });
  });
  return out.sort((a, b) => a.k - b.k).map(({ t, kind }) => ({ t, kind }));
}

type Page = { n: number; t: number };

function plan(dir: string, globalPronounce: Record<string, string>) {
  const s = snapshot(dir, globalPronounce);
  if (s.project.layout !== "slides") throw new Error("only a slides video has a Slides PDF (Brief: Layout)");
  const sb = loadStoryboard(dir);
  const statuses = ownStatuses(s).chapters;
  const chapters = sb.chapters.map((c, i) => {
    if (!c) throw new Error(`chapter ${i + 1} is not written yet`);
    // the voiced timing when it is up to date, else estimated: the slides are the same, only the moments differ
    const props = chapterProps(dir, s.project, sb, i + 1, statuses[i]?.voice === "ok");
    return { ...props, captions: false, timing: { ...props.timing, audio: "" } };
  });
  const pages: Page[] = chapters.flatMap((p, i) => pageTimes(p.chapter, p.timing).map(({ t }) => ({ n: i + 1, t })));
  const hash = sha({ chapters, pages, renderer: rendererVersion(), v: 1 });
  return { chapters, pages, hash };
}

/** Paths of the cached PDF and its stamp. */
const files = (dir: string) => {
  const P = paths(dir);
  return { pdf: join(P.dir, "out", `${P.slug}-slides.pdf`), stamp: join(P.dir, "out", `${P.slug}-slides.json`) };
};

/** True when the cached Slides PDF matches the video as it is now. */
export function slidesPdfFresh(dir: string, globalPronounce: Record<string, string> = {}): boolean {
  const f = files(dir);
  if (!isFile(f.pdf)) return false;
  const stamp = maybe(() => readJson<{ hash: string }>(f.stamp));
  const p = maybe(() => plan(dir, globalPronounce));
  return !!p && stamp?.hash === p.hash;
}

/** Makes (or reuses) the video's Slides PDF. Returns its path. */
export async function slidesPdf(dir: string, o: { signal?: AbortSignal; log?: (l: string) => void; progress?: (p: number) => void; globalPronounce?: Record<string, string> } = {}): Promise<string> {
  const f = files(dir);
  const { chapters, pages, hash } = plan(dir, o.globalPronounce ?? {});
  if (isFile(f.pdf) && maybe(() => readJson<{ hash: string }>(f.stamp))?.hash === hash) return f.pdf;
  const { openBrowser, renderStill, selectComposition } = await import("@remotion/renderer");
  const { PDFDocument } = await import("pdf-lib");
  const { serveUrl } = await getBundle(o.log);
  const tmp = mkdtempSync(join(tmpdir(), "emoton-slides-"));
  const browser = await openBrowser("chrome");
  try {
    const doc = await PDFDocument.create();
    doc.setTitle(loadProject(dir).title);
    let done = 0;
    for (const [i, props] of chapters.entries()) {
      const inputProps = props as unknown as Record<string, unknown>;
      const composition = await selectComposition({ serveUrl, id: "Chapter", inputProps, puppeteerInstance: browser });
      for (const pg of pages.filter((x) => x.n === i + 1)) {
        throwIfAborted(o.signal);
        const out = join(tmp, `p${done}.jpg`);
        const frame = Math.min(composition.durationInFrames - 1, Math.round(pg.t * composition.fps));
        await renderStill({ serveUrl, composition, inputProps, frame, output: out, imageFormat: "jpeg", jpegQuality: 90, puppeteerInstance: browser, overwrite: true });
        const img = await doc.embedJpg(readFileSync(out));
        // 16:9 at 960 x 540 points; the image keeps its 1920 x 1080 pixels
        doc.addPage([960, 540]).drawImage(img, { x: 0, y: 0, width: 960, height: 540 });
        o.progress?.(++done / pages.length);
      }
    }
    const part = `${f.pdf}.part.pdf`;
    // a video that was never joined has no out/ folder yet
    mkdirSync(dirname(f.pdf), { recursive: true });
    writeFileSync(part, await doc.save());
    renameSync(part, f.pdf);
    writeJson(f.stamp, { hash, pages: pages.length });
    o.log?.(`slides pdf: ${pages.length} pages`);
    return f.pdf;
  } finally {
    await browser.close({ silent: true }).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
