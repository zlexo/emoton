import { existsSync, mkdirSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { badInput } from "./errors.ts";

export const defaultTrash = () => join(homedir(), ".Trash");
/** A path under the home folder written from it ("~/yt/perdix"), so a document travels between Macs. */
export const tildePath = (p: string) => (p === homedir() || p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);

/** rename, or (across volumes) an async copy + remove that never blocks the event loop. */
export async function moveAcross(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

/** `name`, else `name 2`, `name 3`... (before the extension for files). */
export function uniqueName(dir: string, name: string, isFile = false): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = isFile ? extname(name) : "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) {
    const n = `${stem} ${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
}

/** Moves a file or folder into the Trash under a unique name. Never deletes. */
export async function moveToTrash(path: string, trashDir: string): Promise<string> {
  mkdirSync(trashDir, { recursive: true });
  const base = basename(path);
  let name = base;
  if (existsSync(join(trashDir, name))) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    name = uniqueName(trashDir, `${base} ${stamp}`);
  }
  const to = join(trashDir, name);
  await moveAcross(path, to);
  return to;
}

/** "Sources in, video out!" -> "sources-in-video-out" */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "video";
}

/** First words of the topic, for a video without a title. */
export function autoTitle(topic: string): string {
  const words = topic.trim().split(/\s+/).slice(0, 7).join(" ");
  const t = words.replace(/[\s,.;:!?-]+$/, "");
  const out = t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, "") : t;
  return out ? out[0]!.toUpperCase() + out.slice(1) : "Untitled video";
}

/** A folder or video name the user typed: one path segment, visible, not a bundle name. */
export function checkFolderName(name: string): string {
  const n = name.trim();
  if (!n) throw badInput("a folder needs a name");
  if (n.includes("/") || n.includes("\0")) throw badInput("a folder name cannot contain /");
  if (n.startsWith(".")) throw badInput("a folder name cannot start with a dot");
  if (n.toLowerCase().endsWith(".emoton")) throw badInput("a folder name cannot end with .emoton");
  if (n.length > 120) throw badInput("that folder name is too long");
  return n;
}
