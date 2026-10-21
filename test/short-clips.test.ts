import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLibrary } from "../library/index.ts";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { makeProxy } from "../pipeline/proxy.ts";
import { Short } from "../schema/short.ts";
import { addClipScene, addClipScenes, useClip } from "../src/core/short/edit.ts";
import { checkShort, resolveShort, type VoiceTiming } from "../src/core/short/resolve.ts";
import { DEFAULTS } from "./fixtures/helpers.ts";
import { cleanup, makeTmp, startTestServer } from "./server-fake-library.ts";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`fixtures/codetyper/${n}`, import.meta.url), "utf8"));
const voice = fx("perdix-ep3.timing.json") as VoiceTiming;
const ep3 = () => Short.parse(fromDevlogJob(fx("perdix-ep3.job.json"), { build: "c0bece9" }));

test("a clip comes in as a held scene after the chosen one, several keep their order, ids stay unique", () => {
  const d = ep3();
  const one = addClipScene(d, "assets/clips/My Run (2).mp4", 2.5, "born");
  const i = one.scenes.findIndex((s) => s.id === "born");
  assert.deepEqual(one.scenes[i + 1], { id: "My-Run-2", hold: 2.5, visual: { type: "clip", asset: "assets/clips/My Run (2).mp4" }, in: "cut" });
  assert.deepEqual(checkShort(one, { voice }), []);
  const r = resolveShort(one, { voice });
  assert.equal(r.scenes[i + 1]!.seconds, 2.5, "the hold is its length");
  assert.equal(addClipScene(d, "assets/clips/x.mp4").scenes.at(-1)!.visual!.type, "clip", "no scene chosen: at the end");

  const many = addClipScenes(d, ["assets/clips/a.mp4", "assets/clips/b.mp4", "assets/clips/a.mov"], 3, "world");
  assert.deepEqual(many.scenes.slice(1, 4).map((s) => [s.id, (s.visual as { asset: string }).asset]), [
    ["a", "assets/clips/a.mp4"],
    ["b", "assets/clips/b.mp4"],
    ["a-2", "assets/clips/a.mov"],
  ]);
  assert.equal(many.scenes[0]!.id, "world");
  assert.deepEqual(checkShort(many, { voice }), []);
});

test("a scene can show a clip instead of its own visual, dropping what it carried on", () => {
  const d = ep3();
  const carried = d.scenes.find((s) => s.continue) ?? d.scenes[2]!;
  const out = useClip(d, carried.id, "assets/clips/run.mp4");
  const s = out.scenes.find((x) => x.id === carried.id)!;
  assert.deepEqual(s.visual, { type: "clip", asset: "assets/clips/run.mp4" });
  assert.equal(s.continue, undefined);
  assert.deepEqual(out.scenes.filter((x) => x.id !== carried.id), d.scenes.filter((x) => x.id !== carried.id), "nothing else changes");
  assert.equal(useClip(d, "nope", "assets/clips/run.mp4"), d, "an unknown scene: the same document");
});

test("POST clips: videos copied into the Short under unique names, others refused; a clip in use is flagged for a proxy until it has one", async () => {
  const tmp = makeTmp();
  mkdirSync(tmp.libraryRoot, { recursive: true });
  const s = await startTestServer({ tmp, server: { createLibrary } });
  try {
    const d = await createLibrary({ root: tmp.libraryRoot, defaults: DEFAULTS, trashDir: join(tmp.tmp, "trash") }).createShort("", ep3());
    assert.ok(!("errors" in d));
    const id = d.summary.id;
    const clip = join(tmp.tmp, "run.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=0.4", "-pix_fmt", "yuv420p", clip]);

    const fd = new FormData();
    fd.append("request", "{}");
    fd.append("files", new Blob([readFileSync(clip)]), "run.mp4");
    fd.append("files", new Blob([readFileSync(clip)]), "run.mp4");
    const up = await s.api("POST", `/api/shorts/${id}/clips`, fd);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.deepEqual(up.body.assets, ["assets/clips/run.mp4", "assets/clips/run (2).mp4"]);
    assert.deepEqual(readdirSync(join(d.dir, "assets", "clips")).sort(), ["run (2).mp4", "run.mp4"]);

    const bad = new FormData();
    bad.append("request", "{}");
    bad.append("files", new Blob(["text"]), "notes.txt");
    assert.equal((await s.api("POST", `/api/shorts/${id}/clips`, bad)).status, 400);

    let p = await s.api("GET", `/api/shorts/${id}/preview`);
    assert.deepEqual(p.body.clips.sort(), ["assets/clips/run (2).mp4", "assets/clips/run.mp4"]);
    assert.deepEqual(p.body.proxies, [], "on disk but not in use: no proxy yet");

    const doc = await s.api("GET", `/api/shorts/${id}/document`);
    const next = addClipScene(doc.body.document, "assets/clips/run.mp4", 1, "born");
    assert.equal((await s.api("PUT", `/api/shorts/${id}/document`, { document: next, revision: doc.body.revision })).status, 200);
    p = await s.api("GET", `/api/shorts/${id}/preview`);
    assert.deepEqual(p.body.proxies, ["assets/clips/run.mp4"]);
    assert.match(p.body.props.media.footage.run, new RegExp(`^/media/${id}/assets/clips/run\\.mp4`), "the clip itself plays meanwhile");

    await makeProxy(d.dir, "assets/clips/run.mp4");
    p = await s.api("GET", `/api/shorts/${id}/preview`);
    assert.deepEqual(p.body.proxies, []);
    assert.match(p.body.props.media.footage.run, /\/proxies\/assets\/clips\/run\.mp4/);
  } finally {
    await s.close();
    cleanup(tmp.tmp);
  }
});
