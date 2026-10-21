/**
 * The voice side of editing a Short: rewriting a line so that everything
 * pinned to it (and its pause edits) follows it to its new words, and the
 * series' pause rules. Pure, shared by the editor and the server.
 */
import type { Anchor, Short } from "../../../schema/short.ts";
import { keySentences } from "../words.ts";
import { parseLine, type ResolvedShort } from "./resolve.ts";

export type PauseEdits = { version: 1; sentences: Record<string, { words?: Record<string, number>; after?: number }> };
/** A sentence key that changed; `words`: the new line's word count, edits on words past it are dropped. */
export type Rename = { from: string; to: string; words?: number };

const keysOf = (doc: Short) => keySentences(doc.scenes.flatMap((s) => (s.say ?? []).map((l) => parseLine(l).text)));

/**
 * Line `line` of scene `id` written anew (markers inline, as the script shows
 * them). Every key that changed, the line's own and any repeat numbering
 * ("#2") that moved with it, is renamed in the document's anchors and
 * caption overrides; word indices past the new line's end land on its last
 * word. The renames come back for the pause edits.
 */
export function rewriteLine(doc: Short, id: string, line: number, raw: string): { doc: Short; renames: Rename[] } {
  const si = doc.scenes.findIndex((s) => s.id === id);
  const say = doc.scenes[si]?.say;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!say || line < 0 || line >= say.length || !text || say[line] === text) return { doc, renames: [] };
  const before = keysOf(doc);
  const d: Short = structuredClone(doc);
  d.scenes[si]!.say![line] = text;
  const after = keysOf(d);
  // the rewritten line's place among all spoken lines
  let pos = 0;
  for (let k = 0; k < si; k++) pos += d.scenes[k]!.say?.length ?? 0;
  pos += line;
  const words = parseLine(text).text.split(/\s+/).filter(Boolean).length;
  const renames: Rename[] = [];
  before.forEach((from, i) => {
    const to = after[i]!;
    if (from !== to) renames.push({ from, to, ...(i === pos ? { words } : {}) });
  });
  if (!renames.length) return { doc: d, renames };
  const map = new Map(renames.map((r) => [r.from, r]));
  const fix = (a: Anchor): Anchor => {
    if ("word" in a) {
      const r = map.get(a.word.s);
      return r ? { ...a, word: { s: r.to, w: r.words !== undefined ? Math.min(a.word.w, r.words - 1) : a.word.w } } : a;
    }
    if ("sentence" in a) {
      const r = map.get(a.sentence);
      return r ? { ...a, sentence: r.to } : a;
    }
    return a;
  };
  for (const t of d.text) (t.from = fix(t.from), t.to = fix(t.to));
  for (const f of d.fx) f.at = fix(f.at);
  for (const s of d.sfx) s.at = fix(s.at);
  for (const s of d.scenes) {
    if (s.visual?.type !== "shot") continue;
    for (const [k, v] of Object.entries(s.visual.knobs)) if (typeof v === "object") s.visual.knobs[k] = fix(v);
    if (s.visual.sweep) s.visual.sweep.at = fix(s.visual.sweep.at);
  }
  const m = d.music;
  if (m && "synth" in m.source) {
    if (m.source.synth.lifts) m.source.synth.lifts = m.source.synth.lifts.map(fix);
    if (m.source.synth.drop) m.source.synth.drop = fix(m.source.synth.drop);
  } else if (m && "file" in m.source && m.source.file.align) m.source.file.align = fix(m.source.file.align);
  d.captions.overrides = d.captions.overrides.flatMap((o) => {
    const r = map.get(o.word.s);
    if (!r) return [o];
    if (r.words !== undefined && o.word.w >= r.words) return [];
    return [{ ...o, word: { s: r.to, w: o.word.w } }];
  });
  return { doc: d, renames };
}

/** The pause edits with the renamed keys moved, edits past a rewritten line's last word dropped (the pause after its last word becomes its `after`). */
export function renameEdits(e: PauseEdits, renames: Rename[]): PauseEdits {
  if (!renames.length) return e;
  const map = new Map(renames.map((r) => [r.from, r]));
  const out: PauseEdits = { version: 1, sentences: {} };
  for (const [key, s] of Object.entries(e.sentences)) {
    const r = map.get(key);
    if (!r) {
      if (!Object.hasOwn(out.sentences, key)) out.sentences[key] = s;
      continue;
    }
    const words = Object.fromEntries(Object.entries(s.words ?? {}).filter(([w]) => r.words === undefined || Number(w) < r.words - 1));
    const t = { ...(Object.keys(words).length ? { words } : {}), ...(s.after ? { after: s.after } : {}) };
    if (Object.keys(t).length) out.sentences[r.to] = t;
  }
  return out;
}

/**
 * A series' pause rules, in milliseconds added: after a comma, after a colon
 * (longer when only a few words follow it: a reveal), after a line that
 * ends on a boom, and before a short last line of a scene (the punchline).
 * Where two rules meet the longer pause wins; a pause already edited is
 * never touched.
 */
export type PauseRules = { comma: number; colon: number; colonReveal: number; afterBoom: number; beforePunchline: number; punchlineWords: number };
export const PAUSE_RULES: PauseRules = { comma: 175, colon: 225, colonReveal: 350, afterBoom: 250, beforePunchline: 400, punchlineWords: 4 };

/** The edits the rules ask for, added where the edits have nothing for that pause yet; returns the new edits and how many were added. */
export function applyPauseRules(doc: Short, r: ResolvedShort, e: PauseEdits, rules: PauseRules = PAUSE_RULES): { edits: PauseEdits; added: number } {
  const out: PauseEdits = structuredClone(e);
  const mine = new Set<string>(); // pauses these rules set: when two rules meet, the longer pause wins
  const put = (key: string, k: number | "after", ms: number) => {
    const s = (out.sentences[key] ??= {});
    const id = `${key}\u0000${k}`;
    const cur = k === "after" ? s.after : s.words?.[String(k)];
    if (cur !== undefined && !mine.has(id)) return; // a pause already edited stays as it is
    const v = Math.max(cur ?? 0, ms);
    if (k === "after") s.after = v;
    else (s.words ??= {})[String(k)] = v;
    mine.add(id);
  };
  for (const x of r.sentences) {
    x.words.forEach((w, k) => {
      if (k === x.words.length - 1) return;
      if (/,$/.test(w.text)) put(x.key, k, rules.comma);
      else if (/:$/.test(w.text)) put(x.key, k, x.words.length - 1 - k <= 3 ? rules.colonReveal : rules.colon);
    });
    const raw = doc.scenes.find((s) => s.id === x.scene)?.say?.[x.line] ?? "";
    if (/\[boom\]\s*$/.test(raw)) put(x.key, "after", rules.afterBoom);
  }
  // before a scene's short last line
  for (const s of doc.scenes) {
    const lines = r.sentences.filter((x) => x.scene === s.id);
    const last = lines[lines.length - 1], prev = lines[lines.length - 2];
    if (last && prev && last.words.length <= rules.punchlineWords) put(prev.key, "after", rules.beforePunchline);
  }
  for (const [k, v] of Object.entries(out.sentences)) if (!v.words && v.after === undefined) delete out.sentences[k];
  return { edits: out, added: mine.size };
}
