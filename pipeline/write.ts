import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { Chapter, Outline, crossCheck, writerSchema, type Layout } from "../schema/storyboard.ts";
import { runChild } from "./proc.ts";
import { SYSTEM, chapterPrompt, outlinePrompt } from "./prompts.ts";
import { loadChunks, loadOutline, loadProject, loadStoryboard, paths, writeJson } from "./project.ts";

/** Anything that turns a prompt and a JSON Schema into JSON: the claude CLI, or a fake in tests. `system` replaces the explainer writer's system prompt. */
export type Writer = (prompt: string, schema: object, model: string, signal?: AbortSignal, system?: string) => Promise<unknown>;

/**
 * One isolated `claude -p` call: no tools, no MCP servers, no skills, a fresh
 * empty working directory, our own system prompt, structured JSON out.
 * Aborting kills the CLI's whole process group.
 */
export const askClaude: Writer = async (prompt, schema, model, signal, system = SYSTEM) => {
  const cwd = mkdtempSync(join(tmpdir(), "emoton-writer-"));
  const args = [
    "-p", "--model", model, "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    "--system-prompt", system,
  ];
  let out: string;
  try {
    const r = await runChild("claude", args, { cwd, signal, input: prompt }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("the claude CLI is not installed");
      throw e;
    });
    // eslint-disable-next-line no-control-regex
    if (r.code !== 0 && !r.stdout) throw new Error(`claude exited ${r.code}: ${r.stderr.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
    out = r.stdout;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const r = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown };
  if (r.is_error) {
    const hint = /log ?in/i.test(r.result ?? "") ? " (run `claude auth login` once in a terminal)" : "";
    throw new Error(`claude: ${r.result}${hint}`);
  }
  if (r.structured_output !== undefined) return r.structured_output;
  return JSON.parse((r.result ?? "").replace(/^```(json)?|```$/g, ""));
};

const zodErrors = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export function checkChapter(data: unknown, layout: Layout = "stage"): { ok: Chapter } | { errors: string[] } {
  const parsed = Chapter.safeParse(data);
  if (!parsed.success) return { errors: zodErrors(parsed.error) };
  const errs = crossCheck(parsed.data, layout);
  return errs.length ? { errors: errs } : { ok: parsed.data };
}

export function checkOutline(data: unknown, chunkIds: Set<string>): { ok: Outline } | { errors: string[] } {
  const parsed = Outline.safeParse(data);
  if (!parsed.success) return { errors: zodErrors(parsed.error) };
  // Grounding: a claim that cites nothing real is not allowed in.
  const bad = parsed.data.chapters.flatMap((c) => c.claims.flatMap((cl) => cl.cite.filter((id) => !chunkIds.has(id))));
  return bad.length ? { errors: bad.map((id) => `cites unknown chunk ${id}`) } : { ok: parsed.data };
}

export type WriteOptions = {
  signal?: AbortSignal;
  writer?: Writer;
  note?: string;
  log?: (line: string) => void;
  /** Coarse: called with the attempt number (1..3). */
  onAttempt?: (attempt: number) => void;
};

async function withRetries<T>(label: string, prompt: string, schema: z.ZodType, model: string, check: (d: unknown) => { ok: T } | { errors: string[] }, o: WriteOptions): Promise<T> {
  const writer = o.writer ?? askClaude;
  let p = prompt;
  let last: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    o.onAttempt?.(attempt);
    const data = await writer(p, writerSchema(schema), model, o.signal);
    const r = check(data);
    if ("ok" in r) return r.ok;
    last = r.errors;
    o.log?.(`${label}: attempt ${attempt} rejected: ${r.errors.slice(0, 8).join("; ")}`);
    p = `${prompt}\n\nYour previous answer was rejected by the validator. Fix these problems and answer again:\n${r.errors.map((e) => `- ${e}`).join("\n")}\nPrevious answer:\n${JSON.stringify(data)}`;
  }
  throw new Error(`${label}: still invalid after 3 attempts:\n${last.slice(0, 12).join("\n")}`);
}

/** Writes a new outline (or rewrites it with a note). Returns it; the caller stores it. */
export async function writeOutline(dir: string, o: WriteOptions = {}): Promise<Outline> {
  const p = loadProject(dir), chunks = loadChunks(dir);
  if (!chunks.length) throw new Error("the sources gave no text: add a source with text first");
  const ids = new Set(chunks.map((c) => c.id));
  const previous = o.note && existsSync(paths(dir).outline) ? loadOutline(dir) : undefined;
  return withRetries("outline", outlinePrompt(p, chunks, { previous, note: o.note }), Outline, p.writerModel, (d) => checkOutline(d, ids), o);
}

const lastSentence = (c: Chapter | null | undefined) => c?.beats[c.beats.length - 1]?.say.join(" ");

/** Writes (or with a note rewrites) chapter n (1-based). Returns it; the caller stores it. */
export async function writeChapter(dir: string, n: number, o: WriteOptions = {}): Promise<Chapter> {
  const p = loadProject(dir), chunks = loadChunks(dir), outline = loadOutline(dir);
  if (!outline.chapters[n - 1]) throw new Error(`the outline has no chapter ${n}`);
  const sb = existsSync(paths(dir).storyboard) ? loadStoryboard(dir) : undefined;
  const prompt = chapterPrompt(p, outline, n - 1, chunks, {
    previous: o.note ? sb?.chapters[n - 1] ?? undefined : undefined,
    note: o.note,
    prevChapterEnd: lastSentence(sb?.chapters[n - 2]),
  });
  return withRetries(`chapter ${n}`, prompt, Chapter, p.writerModel, (d) => checkChapter(d, p.layout ?? "stage"), o);
}

/** For writing without the CLI: dump the exact prompt + schema a writer would get. */
export function dumpPrompt(dir: string, what: "outline" | number, note?: string): string {
  const p = loadProject(dir), chunks = loadChunks(dir);
  const out = paths(dir).prompts;
  mkdirSync(out, { recursive: true });
  let prompt: string, schema: z.ZodType, name: string;
  if (what === "outline") {
    const previous = note && existsSync(paths(dir).outline) ? loadOutline(dir) : undefined;
    [prompt, schema, name] = [outlinePrompt(p, chunks, { previous, note }), Outline, "outline"];
  } else {
    const outline = loadOutline(dir);
    const sb = existsSync(paths(dir).storyboard) ? loadStoryboard(dir) : undefined;
    prompt = chapterPrompt(p, outline, what - 1, chunks, {
      previous: note ? sb?.chapters[what - 1] ?? undefined : undefined,
      note,
      prevChapterEnd: lastSentence(sb?.chapters[what - 2]),
    });
    [schema, name] = [Chapter, `chapter-${what}`];
  }
  const file = join(out, `${name}.md`);
  writeJson(join(out, `${name}.schema.json`), writerSchema(schema));
  writeFileSync(file, `# System\n\n${SYSTEM}\n\n# Prompt\n\n${prompt}\n`);
  return file;
}
