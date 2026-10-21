import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import type { ShortDocument } from "../shared/api.ts";
import { lib, readyBundle, temp } from "./fixtures/helpers.ts";

const ep3 = () => fromDevlogJob(JSON.parse(readFileSync(new URL("fixtures/codetyper/perdix-ep3.job.json", import.meta.url), "utf8")), { build: "c0bece9", series: "perdix" });
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("createShort makes a Short bundle the library lists as a Short", async () => {
  const t = temp();
  try {
    const L = lib(t);
    await L.createFolder("", "Perdix devlogs");
    const d = await L.createShort("Perdix devlogs", ep3());
    assert.ok(!("errors" in d));
    assert.equal(d.summary.kind, "short");
    assert.equal(d.summary.status, "draft");
    assert.equal(d.summary.title, "perdix-ep3");
    assert.equal(d.dir, join(t.root, "Perdix devlogs", "perdix-ep3.emoton"));
    assert.deepEqual(json(join(d.dir, "short.json")), ep3());
    const project = json(join(d.dir, "project.json"));
    assert.equal(project.kind, "short");
    assert.deepEqual(project.voice, { engine: "kokoro", voice: "am_puck", speed: 1.08 });

    await readyBundle(t);
    const tree = await L.tree();
    const kinds = Object.fromEntries(tree.videos.map((v) => [v.title, v.kind]));
    assert.equal(kinds["perdix-ep3"], "short");
    assert.ok(Object.values(kinds).includes("explainer"), "an explainer (no kind in its project.json) stays one");

    // exported, it is ready
    mkdirSync(join(d.dir, "out"), { recursive: true });
    writeFileSync(join(d.dir, "out", "perdix-ep3.mp4"), "mp4");
    assert.equal((await L.detail(d.summary.id)).summary.status, "ready");
  } finally {
    t.done();
  }
});

test("createShort refuses an invalid document and leaves nothing behind", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const bad = { ...ep3(), scenes: [] };
    const r = await L.createShort("", bad);
    assert.ok("errors" in r && r.errors.some((e) => e.startsWith("scenes:")), JSON.stringify(r));
    assert.deepEqual(readdirSync(t.root), []);
  } finally {
    t.done();
  }
});

test("saving a Short's document: valid, current revision only, title kept in step", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const d = await L.createShort("", ep3());
    assert.ok(!("errors" in d));
    const id = d.summary.id;
    const first = await L.shortDocument(id);
    assert.match(first.revision, /^[0-9a-f]{16}$/);

    const doc = structuredClone(first.document);
    doc.title = "Perdix is born";
    doc.scenes[0]!.push = 1.04;
    const saved = (await L.saveShortDocument(id, doc, first.revision)) as ShortDocument;
    assert.equal(saved.document.scenes[0]!.push, 1.04);
    assert.notEqual(saved.revision, first.revision);
    assert.equal((await L.detail(id)).summary.title, "Perdix is born");

    // an edit made from the old revision would overwrite this one: refused
    await assert.rejects(L.saveShortDocument(id, first.document, first.revision), { status: 409 });
    // an invalid document is refused with its errors, and the file is left as it was
    const r = await L.saveShortDocument(id, { ...doc, canvas: { w: 1080, h: 1920, fps: 59 } }, saved.revision);
    assert.ok("errors" in r && r.errors.some((e) => e.startsWith("canvas.fps")), JSON.stringify(r));
    assert.deepEqual((await L.shortDocument(id)).document, saved.document);

    // a copy is still a Short
    const copy = await L.duplicateVideo(id);
    assert.equal(copy.summary.kind, "short");
    assert.deepEqual((await L.shortDocument(copy.summary.id)).document.scenes, saved.document.scenes);
  } finally {
    t.done();
  }
});

test("explainer jobs other than the voice are refused on a Short, Short calls on an explainer", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const d = await L.createShort("", ep3());
    assert.ok(!("errors" in d));
    assert.deepEqual(await L.plan(d.summary.id, "make"), [{ stage: "voice", chapter: 1, lane: "media" }], "its one stage is its voice");
    await assert.rejects(L.plan(d.summary.id, "storyboard"), { status: 400, message: /made in its editor/ });
    assert.deepEqual(await L.plan(d.summary.id, "render"), [{ stage: "voice", chapter: 1, lane: "media" }, { stage: "render", lane: "media" }], "an export voices it first");
    const quiet = { signal: new AbortController().signal, progress() {}, log() {} };
    await assert.rejects(L.runStep(d.summary.id, { stage: "storyboard", chapter: 1, lane: "write" }, quiet), { status: 400 });

    const video = await readyBundle(t);
    const id = json(join(video, "project.json")).id as string;
    await assert.rejects(L.shortDocument(id), { status: 400, message: "this video is not a Short" });
    assert.ok(existsSync(join(video, "project.json")));
  } finally {
    t.done();
  }
});

test("takes: keep the document under a name, list newest first, restore one over the current revision", async () => {
  const t = temp();
  try {
    const L = lib(t);
    const d = await L.createShort("", ep3());
    assert.ok(!("errors" in d));
    const id = d.summary.id;
    const first = await L.saveShortTake(id, "take 1");
    assert.equal(first.name, "take 1");
    const cur = await L.shortDocument(id);
    const changed = structuredClone(cur.document);
    changed.scenes[0]!.push = 1.1;
    const saved = (await L.saveShortDocument(id, changed, cur.revision)) as ShortDocument;
    await new Promise((r) => setTimeout(r, 5));
    await L.saveShortTake(id, "take 2");
    assert.deepEqual((await L.shortTakes(id)).map((x) => x.name), ["take 2", "take 1"]);

    await assert.rejects(L.restoreShortTake(id, "take 1", cur.revision), { status: 409 }, "a restore over a stale revision is refused");
    const back = await L.restoreShortTake(id, "take 1", saved.revision);
    assert.equal(back.document.scenes[0]!.push, ep3().scenes[0]!.push);
    await assert.rejects(L.restoreShortTake(id, "nope", back.revision), { status: 404 });
    await assert.rejects(L.saveShortTake(id, "  "), { status: 400 });
  } finally {
    t.done();
  }
});
