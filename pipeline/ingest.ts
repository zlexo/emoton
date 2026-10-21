import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, throwIfAborted } from "./proc.ts";
import { isUrl, sourceFile, type Chunk, type Project } from "./project.ts";

export type SourceSummary = { pages?: number; chunks: number; noText?: boolean };
export type IngestResult = { chunks: Chunk[]; sources: Record<string, SourceSummary> };

export const isYouTube = (u: string) => /(^|\.)youtube\.com|youtu\.be/i.test(u);

export type IngestOptions = {
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Default 30 s per web page, 120 s per YouTube transcript. */
  fetchTimeoutMs?: number;
  ytTimeoutMs?: number;
};

/**
 * PDFs split per page (id "notes:p6", the page a PDF viewer shows); text files and
 * web pages per ~2500 chars ("web:s3"); YouTube via yt-dlp subtitles.
 */
export async function ingest(project: Project, dir: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const { signal } = opts;
  const chunks: Chunk[] = [];
  const sources: Record<string, SourceSummary> = {};
  for (const src of project.sources) {
    throwIfAborted(signal);
    const before = chunks.length;
    let pages: number | undefined;
    if (isUrl(src.path)) {
      if (isYouTube(src.path)) chunks.push(...split(src.id, await youtubeText(src.path, signal, opts.ytTimeoutMs ?? 120_000)));
      else chunks.push(...split(src.id, htmlToText(await fetchText(src.id, src.path, signal, opts.fetchTimeoutMs ?? 30_000))));
    } else {
      const p = sourceFile(dir, src);
      if (!existsSync(p)) throw new Error(`${src.id}: no file at ${p}`);
      if (p.toLowerCase().endsWith(".pdf")) {
        const text = await run("pdftotext", ["-layout", p, "-"], { signal });
        const all = text.split("\f");
        if (all.length > 1 && !all[all.length - 1]!.trim()) all.pop();
        pages = all.length;
        all.forEach((page, i) => {
          const clean = tidy(page);
          if (clean.length > 40) chunks.push({ id: `${src.id}:p${i + 1}`, source: src.id, text: clean });
        });
      } else {
        const text = readFileSync(p, "utf8");
        chunks.push(...(splitPages(src.id, text) ?? split(src.id, text)));
      }
    }
    const n = chunks.length - before;
    sources[src.id] = { ...(pages !== undefined ? { pages } : {}), chunks: n, ...(n === 0 ? { noText: true } : {}) };
    opts.log?.(`ingest ${src.id}: ${n} chunks${n === 0 ? " (no text found)" : ""}`);
  }
  return { chunks, sources };
}

async function fetchText(id: string, url: string, signal: AbortSignal | undefined, ms: number): Promise<string> {
  const timeout = AbortSignal.timeout(ms);
  try {
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`${id}: ${url} answered ${res.status}`);
    return await res.text();
  } catch (e) {
    throwIfAborted(signal);
    if (timeout.aborted) throw new Error(`${id}: ${url} did not answer within ${ms / 1000} s`);
    throw e;
  }
}

async function youtubeText(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "emoton-yt-"));
  try {
    await run("yt-dlp", ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en", "--sub-format", "vtt", "-o", join(tmp, "v"), url], { signal, timeoutMs });
    const vtt = readdirSync(tmp).find((f) => f.endsWith(".vtt"));
    if (!vtt) throw new Error(`no English subtitles for ${url}`);
    return vttToText(readFileSync(join(tmp, vtt), "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Subtitle text without timestamps, tags or the rolling duplicates auto captions repeat. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.split("\n")) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line || line === "WEBVTT" || line.includes("-->") || /^(Kind|Language):/.test(line) || /^\d+$/.test(line)) continue;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out.join("\n").replace(/(.{400,}?[.?!])\s/g, "$1\n\n");
}

const tidy = (s: string) =>
  s.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").replace(/^ /gm, "").trim();

/**
 * Text exported from slides often keeps page breaks: form feeds, or OCR
 * markers like "==== p-12.png". Chunk those per page (id "ch4:p12") so a video
 * can cite the page. Null when the text has no page structure.
 */
export function splitPages(source: string, text: string): Chunk[] | null {
  const marker = /^==== p-0*(\d+)\.(?:png|jpe?g)\s*$/gm;
  const marks = [...text.matchAll(marker)];
  if (marks.length >= 2) {
    return marks
      .map((m, i) => ({ n: Number(m[1]), body: text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length) }))
      .map(({ n, body }) => ({ id: `${source}:p${n}`, source, text: tidy(body) }))
      .filter((c) => c.text.length > 20);
  }
  if ((text.match(/\f/g) ?? []).length >= 2) {
    return text.split("\f").map((body, i) => ({ id: `${source}:p${i + 1}`, source, text: tidy(body) })).filter((c) => c.text.length > 20);
  }
  return null;
}

function split(source: string, text: string): Chunk[] {
  const out: Chunk[] = [];
  let buf = "";
  for (const para of tidy(text).split(/\n\n/)) {
    if (buf.length + para.length > 2500 && buf) {
      out.push({ id: `${source}:s${out.length + 1}`, source, text: buf.trim() });
      buf = "";
    }
    buf += para + "\n\n";
  }
  if (buf.trim()) out.push({ id: `${source}:s${out.length + 1}`, source, text: buf.trim() });
  return out;
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h\d|li|pre|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
