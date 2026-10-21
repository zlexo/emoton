import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../pipeline/migrate.ts";
import { FPS, renderedDuration } from "../pipeline/render.ts";
import { readState } from "../pipeline/state.ts";
import { FIX, SLUG, ctx, fixture, lib, readyBundle, temp, v0Folder } from "./fixtures/helpers.ts";

const TITLE = "Sources in, video out";

test("export srt: one cue per sentence, times across the joined video", async () => {
  const t = temp();
  try {
    const L = lib(t);
    await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    const dest = join(t.base, "out");
    const files = await L.exportVideos({ videoIds: [id], formats: ["srt"], dest }, ctx());
    assert.deepEqual(files, [join(dest, `${TITLE}.srt`)]);
    const srt = readFileSync(files[0]!, "utf8");
    const cues = srt.trim().split(/\n\n/);
    assert.equal(cues.length, 79, "one cue per narrated sentence");
    assert.equal(cues[0], "1\n00:00:01,800 --> 00:00:06,125\nYou give a language model three PDFs and ask for an animated explainer.");
    // Chapter 1 (76.008 s of audio, 19 sentences) renders to 2281 frames = 76.033 s, so chapter 2 starts at 76.033 + 1.8 = 77.833.
    assert.equal(cues[19], "20\n00:01:17,833 --> 00:01:20,039\nHere is the writer, a language model.");
  } finally {
    t.done();
  }
});

test("export md: chapters with start times, narration, [README s1] citations", async () => {
  const t = temp();
  try {
    const L = lib(t);
    await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    const dest = join(t.base, "out");
    const [file] = await L.exportVideos({ videoIds: [id], formats: ["md"], dest }, ctx());
    const md = readFileSync(file!, "utf8");
    assert.ok(md.startsWith(`# ${TITLE}\n\n## 1. Five stages, one diagram (0:00)\n\nYou give a language model three PDFs and ask for an animated explainer. How could`), md.slice(0, 200));
    assert.ok(md.includes("## 2. Fill a storyboard, not code (1:16)"));
    assert.ok(md.includes("Rewrite one chapter, and the rest stay byte-identical. [README s1; README s2]"));
    assert.ok(md.includes("Zod still enforces every limit afterwards. [Storyboard schema s6; Storyboard schema s3]"));
    assert.ok(md.trimEnd().endsWith("- Storyboard schema (schema)"));
    // A second export does not overwrite the first.
    const [again] = await L.exportVideos({ videoIds: [id], formats: ["md"], dest }, ctx());
    assert.equal(again, join(dest, `${TITLE} 2.md`));
  } finally {
    t.done();
  }
});

test("export: mp4 copy, bundle zip without the audio cache; folder export makes a subfolder per ready video", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const dir = await readyBundle(t);
    const draft = await L.createVideo({ folder: "Imported", brief: { topic: "not made yet" }, mode: "draft" });
    const dest = join(t.base, "out");
    const c = ctx();
    const formats = ["mp4", "srt", ...(hasZip() ? (["bundle"] as const) : [])] as ("mp4" | "srt" | "bundle")[];
    const files = await L.exportVideos({ folder: "Imported", formats, dest }, c);
    assert.deepEqual(readdirSync(dest), [TITLE], "one subfolder, the draft video is skipped");
    assert.ok(c.logs.some((l) => l.startsWith("skipped:") && l.includes("Not made yet")));
    assert.equal(readFileSync(join(dest, TITLE, `${TITLE}.mp4`), "utf8"), "fake final");
    if (hasZip()) {
      const list = execFileSync("unzip", ["-l", join(dest, TITLE, `${TITLE}.emoton.zip`)]).toString();
      assert.ok(list.includes(`${SLUG}.emoton/audio/ch1.wav`));
      assert.ok(list.includes(`${SLUG}.emoton/sources/`));
      assert.ok(!list.includes("audio/cache"), "the voice cache stays out");
    }
    assert.equal(files.length, formats.length);
    // Asking for a video that is not ready fails before anything is written.
    rmSync(dest, { recursive: true });
    await assert.rejects(L.exportVideos({ videoIds: [(await L.tree()).videos.find((v) => v.id !== draft.summary.id)!.id, draft.summary.id], formats: ["mp4"], dest }, ctx()), /no finished video/);
    assert.ok(!existsSync(dest));
    void dir;
  } finally {
    t.done();
  }
});

const hasZip = () => {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("migrate: into <root>/Imported with copied sources, kept media, recorded hashes, old folder to the Trash", async () => {
  const t = temp();
  try {
    const from = v0Folder(t.base);
    const logs: string[] = [];
    const dir = await migrate(t.root, { from, trashDir: t.trash, log: (l) => logs.push(l) });
    assert.equal(dir, join(t.root, "Imported", `${SLUG}.emoton`));
    const p = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    assert.match(p.id, /^[0-9a-f-]{36}$/);
    assert.equal(p.titleAuto, false);
    assert.deepEqual(p.sources.map((s: { path: string }) => s.path), ["sources/readme-notes.txt", "sources/schema-notes.txt"]);
    assert.deepEqual(readdirSync(join(dir, "sources")).sort(), ["readme-notes.txt", "schema-notes.txt"]);
    assert.equal(readFileSync(join(dir, "out", `${SLUG}.mp4`), "utf8"), "fake final");
    assert.ok(existsSync(join(dir, "audio", "cache", "abc.wav")), "the voice cache comes along");
    assert.ok(readState(dir).sources?.readme, "per-source summary");
    assert.ok(!existsSync(from), "the old folder is gone");
    assert.deepEqual(readdirSync(t.trash), [SLUG]);
    assert.ok(!existsSync(join(t.root, ".emoton", "migrating")));
    const L = lib(t);
    const [v] = (await L.tree()).videos;
    assert.equal(v!.status, "ready");
    assert.equal(v!.folder, "Imported");
    assert.equal(v!.duration, 315.267, "sum of the four rendered chapter lengths (whole frames)");
    await assert.rejects(migrate(t.root, { from: v0Folder(t.base), keep: true }), /already exists/);
  } finally {
    t.done();
  }
});

test("migrate: takes the JSON from the fixtures when the old folder only has media", async () => {
  const t = temp();
  try {
    const from = v0Folder(t.base);
    // The merge that removes videos/ from the repo leaves only the git-ignored media behind.
    for (const f of ["outline.json", "storyboard.json"]) rmSync(join(from, f));
    const dir = await migrate(t.root, { from, fixtures: FIX, keep: true, trashDir: t.trash });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "outline.json"), "utf8")), fixture("outline.json"));
    assert.ok(existsSync(from), "keep leaves the old folder alone");
    assert.equal((await lib(t).tree()).videos[0]!.status, "ready");
  } finally {
    t.done();
  }
});

test("export of an unfinished video: video formats and srt refuse (409), md comes without times", async () => {
  const t = temp();
  try {
    const L = lib(t);
    await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    const ch = fixture("storyboard.json").chapters[1];
    ch.beats[0].say[0] = "A different first sentence.";
    await L.saveChapter(id, 2, ch);
    const dest = join(t.base, "out");
    for (const f of ["mp4", "mp4-720", "m4a", "srt"] as const)
      await assert.rejects(L.exportVideos({ videoIds: [id], formats: [f], dest }, ctx()), { status: 409, message: `"${TITLE}" has changes that are not in its video yet: make it first` });
    const [md] = await L.exportVideos({ videoIds: [id], formats: ["md"], dest }, ctx());
    const text = readFileSync(md!, "utf8");
    assert.ok(text.includes("## 1. Five stages, one diagram\n"), "no start times");
    assert.ok(text.includes("A different first sentence."), "the current script");
    // Folder export skips it with a message instead.
    const c = ctx();
    await assert.rejects(L.exportVideos({ folder: "", formats: ["mp4"], dest }, c), { status: 409 });
    assert.ok(c.logs.some((l) => l.includes("has changes that are not in its video yet")));
  } finally {
    t.done();
  }
});

test("the frame rate used for chapter lengths matches the composition", () => {
  const root = readFileSync(join(import.meta.dirname, "..", "src", "remotion", "Root.tsx"), "utf8");
  assert.equal(Number(/export const FPS = (\d+)/.exec(root)?.[1]), FPS);
  assert.equal(renderedDuration(78.575), 78.6);
  assert.equal(renderedDuration(2), 2, "a whole number of frames stays as it is");
});

test("migrate: two sources with the same file name both survive", async () => {
  const t = temp();
  try {
    const from = v0Folder(t.base);
    const pj = join(from, "project.json");
    const p = JSON.parse(readFileSync(pj, "utf8"));
    const other = join(t.base, "elsewhere");
    mkdirSync(other);
    const same = join(other, "readme-notes.txt"); // same name as the readme source, different folder and text
    writeFileSync(same, "Other notes.");
    p.sources[1].path = same;
    writeFileSync(pj, JSON.stringify(p));
    const dir = await migrate(t.root, { from, keep: true, trashDir: t.trash });
    const paths = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).sources.map((s: { path: string }) => s.path);
    assert.deepEqual(paths, ["sources/readme-notes.txt", "sources/readme-notes 2.txt"]);
    assert.equal(readFileSync(join(dir, "sources", "readme-notes 2.txt"), "utf8"), "Other notes.");
  } finally {
    t.done();
  }
});
