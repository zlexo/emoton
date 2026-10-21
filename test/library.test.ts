import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SLUG, lib, readyBundle, temp } from "./fixtures/helpers.ts";

test("folders: create nested, rename, move, trash; bad names and self-moves are refused", async () => {
  const t = temp();
  try {
    const L = lib(t);
    assert.equal(await L.createFolder("", "Docs"), "Docs");
    assert.equal(await L.createFolder("Docs", "Guides"), "Docs/Guides");
    assert.equal(await L.createFolder("", "Talks"), "Talks");
    await assert.rejects(L.createFolder("", "Docs"), { status: 409, message: "Docs already exists" });
    for (const bad of ["", "a/b", ".hidden", "x.emoton"]) await assert.rejects(L.createFolder("", bad), { status: 400 });
    await assert.rejects(L.createFolder("../outside", "x"), { status: 400 });
    await assert.rejects(L.createFolder("Nope", "x"), { status: 404 });

    assert.equal(await L.updateFolder("Docs/Guides", { name: "M" }), "Docs/M");
    // A case-only rename works on a case-insensitive disk too.
    await L.createFolder("", "talks2");
    assert.equal(await L.updateFolder("talks2", { name: "Talks2" }), "Talks2");
    assert.ok(readdirSync(t.root).includes("Talks2") && !readdirSync(t.root).includes("talks2"));
    rmSync(join(t.root, "Talks2"), { recursive: true });
    assert.equal(await L.updateFolder("Docs/M", { parent: "Talks" }), "Talks/M");
    assert.ok(existsSync(join(t.root, "Talks", "M")));
    await assert.rejects(L.updateFolder("Talks", { parent: "Talks/M" }), { status: 409, message: "a folder cannot move into itself" });
    await assert.rejects(L.updateFolder("Talks/M", { parent: "", name: "Docs" }), { status: 409, message: "Docs already exists" });

    const tree = (await L.tree()).tree;
    assert.deepEqual(tree.folders.map((f) => f.path), ["Docs", "Talks"]);
    assert.deepEqual(tree.folders[1]!.folders.map((f) => f.path), ["Talks/M"]);

    await L.trashFolder("Talks");
    assert.ok(!existsSync(join(t.root, "Talks")));
    assert.deepEqual(readdirSync(t.trash), ["Talks"]);
    // A second folder with the same name gets a unique name in the Trash.
    await L.createFolder("", "Talks");
    await L.trashFolder("Talks");
    assert.equal(readdirSync(t.trash).length, 2);
    await assert.rejects(L.trashFolder(""), /root/);
  } finally {
    t.done();
  }
});

test("createVideo copies sources into the bundle, gives an id and an auto title, and ingests", async () => {
  const t = temp();
  try {
    const L = lib(t);
    await L.createFolder("", "Talks");
    const notes = join(t.base, "Week 3 notes.txt");
    writeFileSync(notes, "Lazy evaluation delays work until a value is needed.\n\nThunks hold the delayed work.");
    const up = join(t.base, "upload-tmp-123");
    writeFileSync(up, "Strictness analysis finds arguments that are always evaluated.");
    const d = await L.createVideo(
      { folder: "Talks", brief: { topic: "how lazy evaluation works in Haskell, with thunks", minutes: 4 }, sourcePaths: [notes], mode: "draft" },
      [{ name: "strict.txt", tmpPath: up }],
    );
    assert.match(d.summary.id, /^[0-9a-f-]{36}$/);
    assert.equal(d.summary.folder, "Talks");
    assert.equal(d.summary.title, "How lazy evaluation works in Haskell, with");
    assert.equal(basename(d.dir), `${d.summary.slug}.emoton`);
    assert.equal(d.brief.minutes, 4);
    assert.equal(d.brief.audience, "a student", "defaults fill what the request leaves out");
    assert.deepEqual(readdirSync(join(d.dir, "sources")).sort(), ["Week 3 notes.txt", "strict.txt"]);
    assert.deepEqual(d.sources.map((s) => [s.id, s.kind, s.ref, s.chunks]), [
      ["week", "text", "sources/Week 3 notes.txt", 1],
      ["strict", "text", "sources/strict.txt", 1],
    ]);
    const project = JSON.parse(readFileSync(join(d.dir, "project.json"), "utf8"));
    assert.equal(project.titleAuto, true);
    assert.equal(d.state.ingest, "ok");
    assert.equal(d.summary.status, "draft");
    // A second video with the same title gets its own bundle.
    const d2 = await L.createVideo({ folder: "Talks", brief: { topic: "how lazy evaluation works in Haskell, with thunks" }, mode: "draft" });
    assert.notEqual(d2.dir, d.dir);
    assert.equal((await L.tree()).tree.folders[0]!.videos, 2);
  } finally {
    t.done();
  }
});

test("ids resolve after a move in Finder and after moveVideo; trashVideo goes to the Trash", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const dir = await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    assert.equal(await L.resolve(id), dir);
    // Moved behind the library's back: the cache misses, a rescan finds it.
    mkdirSync(join(t.root, "Archive"));
    const moved = join(t.root, "Archive", basename(dir));
    renameSync(dir, moved);
    assert.equal(await L.resolve(id), moved);
    // Through the API, into a folder that already has a video with that slug.
    mkdirSync(join(t.root, "Docs", basename(dir)), { recursive: true });
    writeFileSync(join(t.root, "Docs", basename(dir), "project.json"), readFileSync(join(moved, "project.json")));
    const d = await L.moveVideo(id, "Docs");
    assert.equal(d.summary.folder, "Docs");
    assert.equal(d.summary.slug, `${SLUG}-2`);
    assert.ok(existsSync(join(d.dir, "out", `${SLUG}-2.mp4`)), "the joined video follows the new slug");
    assert.equal(d.summary.status, "ready", "a move does not make anything stale");
    // The copy placed by hand repeated the id; the scan gave the copy a new one.
    const ids = (await L.tree()).videos.map((v) => v.id);
    assert.equal(new Set(ids).size, 2);
    assert.equal(await L.resolve(id), d.dir);

    await L.trashVideo(id);
    assert.ok(!existsSync(d.dir));
    assert.ok(readdirSync(t.trash).includes(`${SLUG}-2.emoton`));
    await assert.rejects(L.resolve(id), { status: 404, message: "unknown video" });
    await assert.rejects(L.detail(id), { status: 404 });
  } finally {
    t.done();
  }
});

test("duplicateVideo copies the bundle with a new id and stays ready", async () => {
  const t = temp();
  try {
    const L = lib(t);
    await readyBundle(t);
    const src = (await L.tree()).videos[0]!;
    // A copy an earlier crash left half-done must not end up in the new copy.
    mkdirSync(join(t.root, "Imported", `.${SLUG}-copy.emoton.copying`, "junk"), { recursive: true });
    const d = await L.duplicateVideo(src.id);
    assert.ok(!existsSync(join(d.dir, "junk")));
    assert.ok(!existsSync(join(t.root, "Imported", `.${SLUG}-copy.emoton.copying`)));
    assert.notEqual(d.summary.id, src.id);
    assert.equal(d.summary.title, `${src.title} (copy)`);
    assert.equal(d.summary.status, "ready");
    assert.ok(existsSync(join(d.dir, "out", `${d.summary.slug}.mp4`)));
    assert.equal((await L.tree()).videos.length, 2);
  } finally {
    t.done();
  }
});

test("resolveMedia serves files inside the bundle only", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const dir = await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    assert.equal(await L.resolveMedia(id, "audio/ch1.wav"), join(dir, "audio", "ch1.wav"));
    // Existing files outside the bundle: by .. and by a symlink.
    writeFileSync(join(t.root, "secret.txt"), "not media");
    assert.equal(await L.resolveMedia(id, "../../secret.txt"), null);
    symlinkSync(join(t.root, "secret.txt"), join(dir, "audio", "link.wav"));
    assert.equal(await L.resolveMedia(id, "audio/link.wav"), null);
    assert.equal(await L.resolveMedia(id, "../../Trash"), null);
    assert.equal(await L.resolveMedia(id, "audio/../../x"), null);
    assert.equal(await L.resolveMedia(id, "/etc/passwd"), null);
    assert.equal(await L.resolveMedia(id, "audio/nope.wav"), null);
    assert.equal(await L.resolveMedia(id, "audio"), null, "directories are not media");
    assert.equal(await L.resolveMedia("no-such-id", "audio/ch1.wav"), null);
  } finally {
    t.done();
  }
});

test("addSources and removeSource re-read the sources; a removed file goes to the Trash", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const a = join(t.base, "a.txt");
    writeFileSync(a, "Alpha source text that is long enough to be one chunk of text.");
    const d0 = await L.createVideo({ folder: "", brief: { topic: "alpha" }, sourcePaths: [a], mode: "draft" });
    const id = d0.summary.id;
    const b = join(t.base, "b.txt");
    writeFileSync(b, "Beta source text.");
    const d1 = await L.addSources(id, { sourcePaths: [b] });
    assert.deepEqual(d1.sources.map((s) => s.id), ["a", "b"]);
    assert.equal(d1.state.ingest, "ok");
    const d2 = await L.removeSource(id, "a");
    assert.deepEqual(d2.sources.map((s) => s.id), ["b"]);
    assert.ok(!existsSync(join(d2.dir, "sources", "a.txt")));
    assert.ok(readdirSync(t.trash).includes("a.txt"));
    assert.equal(d2.state.ingest, "ok");
    await assert.rejects(L.removeSource(id, "a"), { status: 404 });
    await assert.rejects(L.addSources(id, { urls: ["ftp://x"] }), { status: 400 });
  } finally {
    t.done();
  }
});

test("a source path in project.json cannot reach outside the bundle's sources folder", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const a = join(t.base, "a.txt");
    writeFileSync(a, "Alpha source text.");
    const d = await L.createVideo({ folder: "", brief: { topic: "alpha" }, sourcePaths: [a], mode: "draft" });
    const victim = join(t.root, "victim.txt");
    writeFileSync(victim, "keep me");
    const pj = join(d.dir, "project.json");
    const raw = JSON.parse(readFileSync(pj, "utf8"));
    raw.sources.push({ id: "evil", title: "Evil", path: "sources/../../victim.txt" }, { id: "abs", title: "Abs", path: victim });
    writeFileSync(pj, JSON.stringify(raw));
    // Ingest refuses it (recorded as the last error), state still computes.
    const d2 = await L.addSources(d.summary.id, {});
    assert.match(d2.state.lastError?.message ?? "", /evil: sources\/\.\.\/\.\.\/victim\.txt is not inside the video's sources folder/);
    await L.removeSource(d.summary.id, "evil");
    await L.removeSource(d.summary.id, "abs");
    assert.equal(readFileSync(victim, "utf8"), "keep me", "nothing outside the bundle is trashed");
    assert.ok(!existsSync(t.trash) || !readdirSync(t.trash).includes("victim.txt"));
    assert.deepEqual((await L.detail(d.summary.id)).sources.map((s) => s.id), ["a"]);
  } finally {
    t.done();
  }
});

test("a Finder duplicate never takes the original's id, even on a fresh start", async () => {
  const t = temp();
  try {
    const dir = await readyBundle(t);
    const id = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).id;
    // Finder names the copy "<name> copy"; it sorts before the original and has the same project.json.
    const copy = join(t.root, "Imported", `${SLUG} copy.emoton`);
    cpSync(dir, copy, { recursive: true });
    const L = lib(t); // a fresh process: nothing cached
    assert.equal(await L.resolve(id), dir);
    const copyId = JSON.parse(readFileSync(join(copy, "project.json"), "utf8")).id;
    assert.notEqual(copyId, id, "the copy got its own id, written to its project.json");
    assert.equal(await lib(t).resolve(copyId), copy, "and keeps it on the next start");
    assert.equal(await lib(t).resolve(id), dir);
  } finally {
    t.done();
  }
});
