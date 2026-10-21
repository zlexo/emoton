import { useEffect, useState } from "react";
/**
 * Unsaved edits live here, not in component state, so switching tabs,
 * toggling Narration/Outline or leaving a video never loses them. Keyed by
 * video id + editor. Cleared on save or discard. Per window session.
 */
const drafts = new Map<string, unknown>();
const listeners = new Set<() => void>();

export const getDraft = <T,>(key: string): T | undefined => drafts.get(key) as T | undefined;
export function setDraft(key: string, value: unknown) {
  if (value === undefined) drafts.delete(key);
  else drafts.set(key, value);
  listeners.forEach((l) => l());
}
export const clearDraft = (key: string) => setDraft(key, undefined);
export const hasDrafts = (prefix: string) => [...drafts.keys()].some((k) => k.startsWith(prefix));
export function onDrafts(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}


type Draft<T> = { base: T; value: T };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T,>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

/**
 * An edit buffer over a server value. `base` is the server value the edit
 * started from; saves compare against it, never against the latest server
 * value, so work a job did meanwhile is not overwritten by accident.
 * When the server value moves: an untouched draft follows it; a touched one
 * is kept (or partly rebased by `rebase`) and reports `conflict`.
 */
export function useDraft<T>(key: string, server: T, rebase?: (d: Draft<T>, server: T) => Draft<T>) {
  const [, force] = useState(0);
  useEffect(() => onDrafts(() => force((n) => n + 1)), []);
  const serverJson = JSON.stringify(server);
  useEffect(() => {
    const cur = getDraft<Draft<T>>(key);
    if (!cur || same(cur.base, server)) return;
    if (same(cur.value, cur.base)) return clearDraft(key);
    if (rebase) {
      const r = rebase(cur, server);
      if (same(r.value, r.base) && same(r.base, server)) clearDraft(key);
      else setDraft(key, r);
    }
  }, [key, serverJson]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = getDraft<Draft<T>>(key);
  return {
    value: d ? d.value : server,
    base: d ? d.base : server,
    dirty: d ? !same(d.value, d.base) : false,
    conflict: d ? !same(d.base, server) : false,
    set(f: (v: T) => T) {
      const cur = getDraft<Draft<T>>(key) ?? { base: clone(server), value: clone(server) };
      const next = f(clone(cur.value));
      if (same(next, cur.base) && same(cur.base, server)) clearDraft(key);
      else setDraft(key, { base: cur.base, value: next });
    },
    discard: () => clearDraft(key),
  };
}

/** Re-renders when any draft changes; returns whether keys with this prefix exist. */
export function useHasDrafts(prefix: string): boolean {
  const [, force] = useState(0);
  useEffect(() => onDrafts(() => force((n) => n + 1)), []);
  return hasDrafts(prefix);
}
