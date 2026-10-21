/**
 * A video's pause edits and the chapter voice they make. The voice stage
 * writes the voice as spoken (audio/chN.spoken.wav, render/chN.spoken.timing.json);
 * applying the edits writes audio/chN.wav and render/chN.timing.json, the two
 * files render, preview, export and captions have always read. Edits are kept
 * in <video>/voice-edits.json per chapter, keyed by sentence text, so they
 * survive a re-voice and a redo of another chapter.
 */
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import type { ChapterTiming } from "../schema/storyboard.ts";
import { applyPauses, noEdits, sentenceKeys, withWords, type PauseEdits } from "./pauses.ts";
import { isFile, maybe, paths, readJson, writeJson } from "./project.ts";
import { readWav, writeWav } from "./wav.ts";

export type VideoEdits = { version: 1; chapters: Record<string, PauseEdits["sentences"]> };

/** The longest pause change one edit may ask for, in ms either way. */
export const MAX_EDIT_MS = 10_000;

export function loadVideoEdits(dir: string): VideoEdits {
  const file = paths(dir).voiceEdits;
  if (!isFile(file)) return { version: 1, chapters: {} };
  const e = readJson<VideoEdits>(file);
  if (e?.version !== 1 || typeof e.chapters !== "object" || e.chapters === null) throw new Error(`${file}: not a version 1 pause edit file`);
  return e;
}

export function chapterEdits(dir: string, n: number): PauseEdits {
  const all = loadVideoEdits(dir).chapters;
  return Object.hasOwn(all, String(n)) ? { version: 1, sentences: all[String(n)]! } : noEdits();
}

/** True when `x` is one chapter's edits: `{version: 1, sentences: {key: {words?: {k: ms}, after?: ms}}}`, every ms finite and within MAX_EDIT_MS. */
export function isPauseEdits(x: unknown): x is PauseEdits {
  if (typeof x !== "object" || x === null) return false;
  const e = x as PauseEdits;
  if (e.version !== 1 || typeof e.sentences !== "object" || e.sentences === null || Array.isArray(e.sentences)) return false;
  const ms = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_EDIT_MS;
  return Object.entries(e.sentences).every(([k, s]) =>
    k.length > 0 && k.length <= 2000 && typeof s === "object" && s !== null &&
    (s.after === undefined || ms(s.after)) &&
    (s.words === undefined || (typeof s.words === "object" && s.words !== null && Object.entries(s.words).every(([w, v]) => /^\d{1,4}$/.test(w) && ms(v)))));
}

/** Drops zero changes and empty sentences, so a pause put back to its natural length leaves no trace. */
export function tidy(e: PauseEdits): PauseEdits["sentences"] {
  // built with fromEntries, so a key like "__proto__" stays an ordinary key
  return Object.fromEntries(Object.entries(e.sentences).flatMap(([k, s]) => {
    const words = Object.fromEntries(Object.entries(s.words ?? {}).filter(([, v]) => v !== 0));
    const t = { ...(Object.keys(words).length ? { words } : {}), ...(s.after ? { after: s.after } : {}) };
    return Object.keys(t).length ? [[k, t]] : [];
  }));
}

/**
 * Before pause edits existed the voice stage wrote only chN.wav and its timing,
 * so for such a chapter those are the voice as spoken: copied once, they become
 * the spoken files the edits apply to. False when the chapter is not voiced.
 */
function ensureSpoken(dir: string, n: number): boolean {
  const P = paths(dir);
  if (isFile(P.spokenAudio(n)) && isFile(P.spokenTiming(n))) return true;
  if (!isFile(P.audio(n)) || !isFile(P.timing(n))) return false;
  copyFileSync(P.audio(n), P.spokenAudio(n));
  writeJson(P.spokenTiming(n), { ...readJson<ChapterTiming>(P.timing(n)), audio: P.spokenAudioRel(n) });
  return true;
}

export type AppliedEdits = { applied: number; dropped: string[] };

/**
 * Chapter n's voice with `edits` applied, made in a staging file next to
 * audio/chN.wav; `commit` moves it into place by a rename (a render hard-links
 * chN.wav, so the file is never rewritten in place) and writes the timing.
 * When no edit applies (none, or only edits for sentences no longer there)
 * the spoken voice and its timing are used exactly as spoken, so the render
 * does not go stale over nothing.
 */
function prepare(dir: string, n: number, edits: PauseEdits): AppliedEdits & { commit(): void; abandon(): void } {
  const P = paths(dir);
  if (!ensureSpoken(dir, n)) throw new Error(`chapter ${n} has no voice yet: voice it first`);
  const spoken = readJson<ChapterTiming>(P.spokenTiming(n));
  // ".part." so an export, which leaves out unfinished files, never ships one left by a crash
  const stage = P.audio(n).replace(/\.wav$/, `.${process.pid}.edit.part.wav`);
  const abandon = () => rmSync(stage, { force: true });
  const place = (timing: ChapterTiming) => {
    renameSync(stage, P.audio(n));
    writeJson(P.timing(n), { ...timing, audio: P.audioRel(n) });
  };
  if (Object.keys(edits.sentences).length) {
    const { sr, audio } = readWav(P.spokenAudio(n));
    const r = applyPauses(audio, sr, spoken, edits);
    if (r.applied > 0) {
      writeWav(stage, { sr, audio: r.audio });
      return { applied: r.applied, dropped: r.dropped, commit: () => place(r.timing), abandon };
    }
    copyFileSync(P.spokenAudio(n), stage);
    return { applied: 0, dropped: r.dropped, commit: () => place(spoken), abandon };
  }
  copyFileSync(P.spokenAudio(n), stage);
  return { applied: 0, dropped: [], commit: () => place(spoken), abandon };
}

/**
 * Writes chapter n's voice with its saved edits applied (audio/chN.wav and its
 * timing) from the spoken files. Call while holding withLock(dir), or from the
 * voice stage.
 */
export function applyChapterEdits(dir: string, n: number): AppliedEdits {
  const p = prepare(dir, n, chapterEdits(dir, n));
  try {
    p.commit();
  } catch (e) {
    p.abandon();
    throw e;
  }
  return { applied: p.applied, dropped: p.dropped };
}

/**
 * Saves chapter n's edits and remakes its voice. The new voice is made before
 * the edits are saved, so a voice that cannot be made leaves both as they
 * were. Call while holding withLock(dir).
 */
export function saveChapterEdits(dir: string, n: number, edits: PauseEdits): AppliedEdits {
  const sentences = tidy(edits);
  const all = loadVideoEdits(dir);
  const p = prepare(dir, n, { version: 1, sentences });
  try {
    if (Object.keys(sentences).length) all.chapters[String(n)] = sentences;
    else delete all.chapters[String(n)];
    writeJson(paths(dir).voiceEdits, all);
    p.commit();
  } catch (e) {
    p.abandon();
    throw e;
  }
  return { applied: p.applied, dropped: p.dropped };
}

/**
 * Forgets chapter n's edits (its chapter is gone from the outline). Best
 * effort: an edits file that cannot be read is left alone rather than
 * stopping the outline save it is part of. Call while holding withLock(dir).
 */
export function dropChapterEdits(dir: string, n: number) {
  const all = maybe(() => loadVideoEdits(dir));
  if (!all) return;
  if (!(String(n) in all.chapters)) return;
  delete all.chapters[String(n)];
  writeJson(paths(dir).voiceEdits, all);
}

export type ChapterVoice = {
  n: number;
  /** The voice as spoken, every sentence with words (estimated where the voice gave none). */
  spoken: ChapterTiming;
  /** The same with this chapter's edits applied: what plays. */
  timing: ChapterTiming;
  /** Each sentence's edit key, by beat. */
  keys: string[][];
  edits: PauseEdits;
  /** Keys of edits whose sentence is no longer in the chapter. */
  dropped: string[];
};

/** Chapter n's voice for the editor, or null when it is not voiced. Reads only. */
export function chapterVoice(dir: string, n: number): ChapterVoice | null {
  const P = paths(dir);
  const edited = isFile(P.timing(n)) ? maybe(() => readJson<ChapterTiming>(P.timing(n))) : undefined;
  if (!edited || !existsSync(P.audio(n))) return null;
  // a chapter voiced before pause edits: what plays is what was spoken
  const spoken = (isFile(P.spokenTiming(n)) && maybe(() => readJson<ChapterTiming>(P.spokenTiming(n)))) || edited;
  const edits = chapterEdits(dir, n);
  const keys = sentenceKeys(spoken);
  const known = new Set(keys.flat());
  return { n, spoken: withWords(spoken), timing: withWords(edited), keys, edits, dropped: Object.keys(edits.sentences).filter((k) => !known.has(k)) };
}
