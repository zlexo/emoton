/**
 * The privacy scan: refuse to put anything private on screen. Every code scene
 * passes it before it renders (from Code Typer's src/safety.ts). The generic
 * rules are here. Names and handles that must never show are not: they live in
 * safety.local.json at the repo root (git-ignored, shaped like
 * safety.example.json), so the source does not carry them either. The public
 * export (scripts/export-public.ts) reads the same file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./project.ts";

export type Hit = { file: string; line: number; rule: string; text: string };

const RULES: [string, RegExp][] = [
  ["email address", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["home path", /\/Users\/|\/home\/[a-z]|C:\\Users\\/],
  ["GitHub token", /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}/],
  ["API key", /\b(sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{12,}|xox[abps]-[A-Za-z0-9-]{10,})/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["password literal", /(password|passwd|secret|token)\s*[=:]\s*"[^"]{4,}"/i],
];

/** The local list. Each entry is plain text (found anywhere, in any case) or "/regex/flags". */
export type SafetyList = { identity: string[]; markers: string[] };

/** EMOTON_SAFETY_FILE, else safety.local.json in the repo root. */
export const safetyFile = () => process.env.EMOTON_SAFETY_FILE ?? join(ROOT, "safety.local.json");

/** The list, or null when there is no file. A file that is not a valid list throws: a broken list must not pass as an empty one. */
export function readSafetyList(file = safetyFile()): SafetyList | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const entries = (k: keyof SafetyList): string[] => {
    const v = raw[k] ?? [];
    if (!Array.isArray(v) || !v.every((e) => typeof e === "string" && e !== "")) throw new Error(`${file}: "${k}" must be a list of non-empty strings`);
    for (const e of v) entryPattern(e); // a bad regex fails here, not halfway through a scan
    return v;
  };
  return { identity: entries("identity"), markers: entries("markers") };
}

/** "/\bASP\b/" is that regex (g and y dropped: test() must not keep state); anything else is the literal text, any case. */
export function entryPattern(entry: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(entry);
  return m ? new RegExp(m[1]!, m[2]!.replace(/[gy]/g, "")) : new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** Every line that breaks a rule. The local list's names count when it exists (read on every call, so an edit applies at once). */
export function scan(file: string, text: string, list = readSafetyList()): Hit[] {
  const rules: [string, RegExp][] = [...(list?.identity ?? []).map((e): [string, RegExp] => ["private name", entryPattern(e)]), ...RULES];
  const hits: Hit[] = [];
  text.split("\n").forEach((l, i) => {
    for (const [rule, re] of rules) if (re.test(l)) hits.push({ file, line: i + 1, rule, text: l.trim().slice(0, 120) });
  });
  return hits;
}
