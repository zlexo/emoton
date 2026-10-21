import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Short } from "../../../../schema/short.ts";
import { estimatedVoice, voiceMatches } from "../../../../src/core/short/estimate.ts";
import { checkShort, resolveShort, type ResolvedShort } from "../../../../src/core/short/resolve.ts";
import type { ShortMedia } from "../../../../src/remotion/shorts/props.ts";
import { api, ApiError } from "../../lib/api.ts";
import type { ShortPreview } from "../../lib/types.ts";

/** How long after the last edit the document is saved. */
const SAVE_AFTER_MS = 700;

export type SaveState = "saved" | "unsaved" | "saving" | "error";
/** What plays, or why the document does not resolve. */
export type EditorView = { short: ResolvedShort; media: ShortMedia; voiced: boolean } | { problems: string[] };
export type Edit = (doc: Short, r: ResolvedShort) => Short;

/**
 * The document being edited, kept here rather than on the server between
 * saves: every edit re-resolves at once in the page (no round trip), goes on
 * an undo history of whole documents, and is saved a moment after the last
 * one against the revision it was made from.
 */
export function useShortEditor(id: string, preview: ShortPreview | null, server: { document: Short; revision: string } | null, onConflict: (m: string) => void) {
  const [doc, setDoc] = useState<Short | null>(null);
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const revision = useRef<string | null>(null);
  const history = useRef<Short[]>([]);
  const future = useRef<Short[]>([]);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bump] = useState(0);

  // the server's document, taken only while nothing here is waiting to be saved
  useEffect(() => {
    if (!server || dirty.current) return;
    revision.current = server.revision;
    setDoc(server.document);
  }, [server]);

  const flush = useCallback(async (d: Short) => {
    if (!revision.current) return;
    setSave("saving");
    try {
      const out = await api.saveShortDocument(id, d, revision.current);
      revision.current = out.revision;
      dirty.current = false;
      setSave("saved");
      setSaveError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        dirty.current = false;
        onConflict("This Short was changed somewhere else; the editor reloaded it.");
        const fresh = await api.shortDocument(id);
        revision.current = fresh.revision;
        setDoc(fresh.document);
        setSave("saved");
        return;
      }
      setSave("error");
      setSaveError(e instanceof ApiError && e.errors ? e.errors.join("\n") : (e as Error).message);
    }
  }, [id, onConflict]);

  const schedule = useCallback((d: Short) => {
    dirty.current = true;
    setSave("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(d), SAVE_AFTER_MS);
  }, [flush]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // what plays: the document resolved against the voice while it still matches the script, else a silent estimate
  const view = useMemo((): EditorView | null => {
    if (!doc || !preview) return null;
    const voiced = preview.voiced && voiceMatches(doc, preview.timing);
    const voice = voiced ? preview.timing : estimatedVoice(doc);
    const problems = checkShort(doc, { voice });
    if (problems.length) return { problems: problems.map((p) => `${p.at}: ${p.message}`) };
    const media: ShortMedia = voiced ? preview.props.media : { ...preview.props.media, voice: undefined };
    return { short: resolveShort(doc, { voice }), media, voiced };
  }, [doc, preview]);

  const apply = useCallback((edit: Edit) => {
    if (!doc || !view || !("short" in view)) return;
    const next = edit(doc, view.short);
    if (next === doc) return;
    history.current.push(doc);
    if (history.current.length > 200) history.current.shift();
    future.current = [];
    setDoc(next);
    schedule(next);
  }, [doc, view, schedule]);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev || !doc) return;
    future.current.push(doc);
    setDoc(prev);
    schedule(prev);
    bump((n) => n + 1);
  }, [doc, schedule]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !doc) return;
    history.current.push(doc);
    setDoc(next);
    schedule(next);
    bump((n) => n + 1);
  }, [doc, schedule]);

  const saveNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (doc && dirty.current) void flush(doc);
  }, [doc, flush]);

  /** A document from elsewhere (a restored take) made current, with its revision. */
  const adopt = useCallback((d: Short, rev: string) => {
    if (doc) history.current.push(doc);
    future.current = [];
    revision.current = rev;
    dirty.current = false;
    setDoc(d);
    setSave("saved");
  }, [doc]);

  return {
    doc, view, apply, undo, redo, saveNow, adopt, save, saveError,
    canUndo: history.current.length > 0, canRedo: future.current.length > 0,
    revision: () => revision.current,
  };
}
