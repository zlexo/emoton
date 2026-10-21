/**
 * Ask: a request typed in the editor ("make the intro punchier", "a boom on
 * physics", "drop on the reveal") becomes a whole proposed document from
 * Claude, kept beside the Short until the maker keeps or drops it. The
 * proposal is checked like a saved document (and the series' wording rules);
 * a rejected one goes back with its problems, three tries at most.
 */
import { z } from "zod/v4";
import { FX_KINDS, MARKERS, Short } from "../schema/short.ts";
import { writerSchema } from "../schema/storyboard.ts";
import { estimatedVoice, voiceMatches } from "../src/core/short/estimate.ts";
import { checkShort, parseLine, resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { SERIES, wordingProblems } from "../src/core/short/series.ts";
import { keySentences } from "../src/core/words.ts";
import { gitHasFile, missingCode, type ShotKinds } from "./short-draft.ts";
import { askClaude, type Writer } from "./write.ts";

/** The pending proposal, beside short.json. */
export const ASK_FILE = "ask.json";
export type AskProposal = { at: string; request: string; summary: string; base: string; document: Short };

export const ASK_SYSTEM = `You edit vertical Shorts (TikTok and YouTube Shorts) in Emoton, a video editor, by rewriting their JSON document. You change only what the request asks for and keep everything else exactly as it is. You reply only with JSON that matches the given schema.`;

/** The answer's shape: the document travels as JSON text, so the CLI's schema check never sees its unions. */
export const AskAnswer = z.strictObject({
  summary: z.string().min(1).max(400).describe("one or two sentences: what you changed"),
  document: z.string().min(2).describe("the whole revised document, as JSON text"),
});

/** Every spoken line with its key and numbered words, so anchors can name a word. */
function linesGuide(doc: Short, voice: VoiceTiming): string {
  const r = resolveShort(doc, { voice });
  const flat = doc.scenes.flatMap((s) => (s.say ?? []).map((l) => ({ scene: s.id, text: parseLine(l).text })));
  const keys = keySentences(flat.map((x) => x.text));
  const scenes = r.scenes.map((s) => `- ${s.id}: ${s.from.toFixed(2)} to ${(s.from + s.seconds).toFixed(2)} s`).join("\n");
  const lines = flat.map((x, i) => `- [${x.scene}] key "${keys[i]}": ${x.text.split(/\s+/).map((w, k) => `${k}:${w}`).join(" ")}`).join("\n");
  return `Scenes on the timeline:\n${scenes}\n\nSpoken lines (key, then each word's index):\n${lines}`;
}

export function askPrompt(doc: Short, voice: VoiceTiming, request: string, kinds: ShotKinds): string {
  const s = doc.series ? SERIES[doc.series] : undefined;
  const shotKinds = Object.entries(kinds.kinds).map(([k, v]) => `- ${k}: ${v.about}; knobs ${Object.entries(v.knobs).map(([n, d]) => `${n}${d.time ? " (time)" : ""}`).join(", ")}`).join("\n");
  return `The request: "${request}"

The document now:
${JSON.stringify(doc)}

${linesGuide(doc, voice)}

How the document works:
- scenes play in order; a scene with "say" is voiced (one sentence per line, markers inline in brackets: ${MARKERS.map((m) => `[${m}]`).join(" ")}; a marker is a sound at that point and a [boom] punches the picture in); a scene with "hold" lasts that many seconds; "continue": true keeps the previous footage running.
- Anchors place things in time: {"word": {"s": <line key>, "w": <word index>}, "edge"?: "start"|"end"}, {"sentence": <line key>, "edge": "start"|"end"}, {"scene": <id>, "edge": "start"|"end"}, {"beat": n}, {"t": seconds}; any can add "offset" in seconds.
- sfx are sounds at anchors (kind ${MARKERS.join(", ")} or "file"); fx are effects (${FX_KINDS.join(", ")}) at anchors; text are on-screen texts (hook, big, small, meme, end, label) from one anchor to another.
- A line's key is its spoken text in lower case (markers removed); when you rewrite a line, every anchor on its old key must move to the new key.
- Perdix shot kinds and their knobs (a time knob can hold an anchor):
${shotKinds}
${s ? `\nThe series' rules (keep them):\n${s.rules.map((r) => `- ${r}`).join("\n")}\n- Wording: ${s.wording.map((w) => `say "${w.use}", never "${w.avoid}"`).join("; ")}.` : ""}

Change only what the request asks for. Return the whole document.`;
}

/** What stops a proposal: the schema, the cross-checks, the series' wording, code files that are not there. */
export function proposalProblems(doc: unknown, voice: VoiceTiming | undefined, has: typeof gitHasFile): { doc?: Short; problems: string[] } {
  const parsed = Short.safeParse(doc);
  if (!parsed.success) return { problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`) };
  const d = parsed.data;
  const v = voice && voiceMatches(d, voice) ? voice : estimatedVoice(d);
  const series = d.series ? SERIES[d.series] : undefined;
  return { doc: d, problems: [...checkShort(d, { voice: v }).map((p) => `${p.at}: ${p.message}`), ...(series ? wordingProblems(series, d) : []), ...missingCode(d, has)] };
}

export type AskOptions = {
  writer?: Writer;
  model: string;
  kinds: ShotKinds;
  /** The voice as it is (it keeps anchors exact while the lines match). */
  voice?: VoiceTiming;
  signal?: AbortSignal;
  log?: (line: string) => void;
  onAttempt?: (n: number) => void;
  hasFile?: typeof gitHasFile;
};

export async function askShort(doc: Short, request: string, o: AskOptions): Promise<{ summary: string; document: Short; attempts: number }> {
  const voice = o.voice && voiceMatches(doc, o.voice) ? o.voice : estimatedVoice(doc);
  const prompt = askPrompt(doc, voice, request, o.kinds);
  const schema = writerSchema(AskAnswer);
  const writer = o.writer ?? askClaude;
  let p = prompt, last: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    o.onAttempt?.(attempt);
    const data = await writer(p, schema, o.model, o.signal, ASK_SYSTEM);
    const ans = AskAnswer.safeParse(data);
    let problems: string[] = [];
    if (!ans.success) problems = ans.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    else {
      let json: unknown;
      try {
        json = JSON.parse(ans.data.document);
      } catch (e) {
        problems = [`document: not JSON (${(e as Error).message})`];
      }
      if (!problems.length) {
        const r = proposalProblems(json, o.voice, o.hasFile ?? gitHasFile);
        problems = r.doc && JSON.stringify(r.doc) === JSON.stringify(doc) ? ["the document came back unchanged: make the change the request asks for"] : r.problems;
        if (!problems.length && r.doc) return { summary: ans.data.summary, document: r.doc, attempts: attempt };
      }
    }
    last = problems;
    o.log?.(`ask: attempt ${attempt} rejected: ${last.slice(0, 8).join("; ")}`);
    p = `${prompt}\n\nYour previous answer was rejected. Fix these problems and answer again:\n${last.map((e) => `- ${e}`).join("\n")}`;
  }
  throw new Error(`Claude's change was still invalid after 3 attempts:\n${last.slice(0, 12).join("\n")}`);
}
