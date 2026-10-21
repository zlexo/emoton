/**
 * Copies the public part of this repo into an empty folder: every file tracked
 * at a commit, minus DENY. It refuses, writes nothing and lists every hit when
 * any file (path or content) holds a name or marker from safety.local.json, a
 * home path, or something shaped like a secret. The list is required: without
 * it the export cannot know what to refuse.
 *
 *   npm run export:public -- <empty target dir> [--ref HEAD] [--list <safety list>] [--repo <dir>]
 *
 * Exit 0: exported. 1: refused, hits listed. 2: cannot run (no list, target not empty, bad ref).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryPattern, readSafetyList, type Hit } from "../pipeline/safety.ts";

/** Tracked but never published: the Deck manifest for one machine, early mockups (screenshots of a private library), the internal build contract. */
export const DENY = ["deck.json", "design/", "docs/APP.md"];

/** File names that hold secrets whatever they contain. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx))$/i;

/** A real user's home folder; the placeholder names tests use are fine. */
const HOME = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)(?!(?:x|someone|you|me|runner|user|example)[\\/])[A-Za-z0-9._-]+[\\/]/;

const SECRETS: [string, RegExp][] = [
  ["GitHub token", /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["API key", /\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abps]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["password literal", /(password|passwd|secret|token|api_?key)\s*[=:]\s*["'][^"'\s]{8,}["']/i],
];

export type ExportOptions = { repo: string; target: string; ref?: string; list?: string };
export type ExportResult = { code: 0 | 1 | 2; message: string; hits: Hit[]; files: string[] };

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 28 });
const denied = (path: string) => DENY.some((d) => (d.endsWith("/") ? path.startsWith(d) : path === d));

export function exportPublic(o: ExportOptions): ExportResult {
  const ref = o.ref ?? "HEAD";
  const fail = (message: string): ExportResult => ({ code: 2, message, hits: [], files: [] });
  const listFile = o.list ?? join(o.repo, "safety.local.json");
  let list;
  try {
    list = readSafetyList(listFile);
  } catch (e) {
    return fail(`cannot read the safety list: ${(e as Error).message}`);
  }
  if (!list) return fail(`no safety list at ${listFile}: copy safety.example.json to safety.local.json and fill it in`);
  if (!list.identity.length || !list.markers.length) return fail(`${listFile} needs at least one identity entry and one marker: an empty list refuses nothing`);
  if (existsSync(o.target) && readdirSync(o.target).length) return fail(`${o.target} is not empty`);
  let commit: string;
  try {
    commit = git(o.repo, ["rev-parse", "--verify", `${ref}^{commit}`]).toString().trim();
  } catch {
    return fail(`not a commit: ${ref}`);
  }

  const named: [string, RegExp][] = [
    ...list.identity.map((e): [string, RegExp] => ["private name", entryPattern(e)]),
    ...list.markers.map((e): [string, RegExp] => ["marker", entryPattern(e)]),
  ];
  // Binary files: only plain-text names and home paths. A short regex marker would match compressed bytes by chance.
  const binaryRules: [string, RegExp][] = [...list.identity.filter((e) => !e.startsWith("/")).map((e): [string, RegExp] => ["private name", entryPattern(e)]), ["home path", HOME]];
  const textRules: [string, RegExp][] = [...named, ["home path", HOME], ...SECRETS];

  const hits: Hit[] = [];
  const files: { path: string; mode: string; data: Buffer }[] = [];
  const entries = git(o.repo, ["ls-tree", "-r", "-z", "--full-tree", commit]).toString().split("\0").filter(Boolean);
  for (const e of entries) {
    const [meta, path] = [e.slice(0, e.indexOf("\t")), e.slice(e.indexOf("\t") + 1)];
    const [mode, type, sha] = meta.split(" ") as [string, string, string];
    if (denied(path)) continue;
    const hit = (line: number, rule: string, text: string) => hits.push({ file: path, line, rule, text: text.trim().slice(0, 120) });
    if (type !== "blob" || mode === "120000") {
      hit(0, "not a plain file", `${type} ${mode}`);
      continue;
    }
    if (SECRET_FILE.test(path)) hit(0, "secret file", path);
    for (const [rule, re] of named) if (re.test(path)) hit(0, `${rule} in the path`, path);
    const data = git(o.repo, ["cat-file", "blob", sha]);
    if (data.subarray(0, 8000).includes(0)) {
      const raw = data.toString("latin1");
      for (const [rule, re] of binaryRules) if (re.test(raw)) hit(0, rule, "(binary file)");
    } else {
      data.toString("utf8").split("\n").forEach((l, i) => {
        for (const [rule, re] of textRules) if (re.test(l)) hit(i + 1, rule, l);
      });
    }
    files.push({ path, mode, data });
  }
  if (hits.length) {
    const n = new Set(hits.map((h) => h.file)).size;
    return { code: 1, message: `refused: ${hits.length} hit(s) in ${n} file(s), nothing written`, hits, files: [] };
  }
  for (const f of files) {
    const out = join(o.target, f.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.data);
    if (f.mode === "100755") chmodSync(out, 0o755);
  }
  const skipped = entries.length - files.length;
  return { code: 0, message: `exported ${files.length} files from ${ref} (${commit.slice(0, 7)}) to ${o.target}; ${skipped} denied`, hits: [], files: files.map((f) => f.path) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const target = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
  if (!target) {
    console.error("usage: npm run export:public -- <empty target dir> [--ref HEAD] [--list <safety list>] [--repo <dir>]");
    process.exit(2);
  }
  const repo = resolve(flag("repo") ?? join(import.meta.dirname, ".."));
  const list = flag("list");
  const r = exportPublic({ repo, target: resolve(target), ref: flag("ref"), list: list && resolve(list) });
  for (const h of r.hits) console.error(`  ${h.file}${h.line ? `:${h.line}` : ""}  ${h.rule}  ${h.text}`);
  (r.code ? console.error : console.log)(r.message);
  process.exit(r.code);
}
