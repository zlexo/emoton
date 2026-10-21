import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLibrary } from "../library/index.ts";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { Short } from "../schema/short.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";
import { checkShort, resolveShort } from "../src/core/short/resolve.ts";
import { SERIES, episodeOf, nextEpisode, wordingProblems } from "../src/core/short/series.ts";
import { TEMPLATES, startShort } from "../src/core/short/templates.ts";
import { DEFAULTS } from "./fixtures/helpers.ts";
import { cleanup, makeTmp, startTestServer } from "./server-fake-library.ts";

const perdix = SERIES.perdix!;
const ep3 = () => fromDevlogJob(JSON.parse(readFileSync(new URL("fixtures/codetyper/perdix-ep3.job.json", import.meta.url), "utf8")), { build: "c0bece9", series: "perdix" });

test("every template starts a valid Short that resolves, on or off a series", () => {
  for (const t of TEMPLATES) {
    for (const series of [undefined, perdix]) {
      const d = Short.parse(startShort(t.id, { title: "Ep 4", series, episode: series ? 4 : undefined }));
      const voice = estimatedVoice(d);
      assert.deepEqual(checkShort(d, { voice }), [], `${t.id}${series ? " (perdix)" : ""}`);
      const r = resolveShort(d, { voice });
      assert.ok(r.scenes.at(-1)!.from + r.scenes.at(-1)!.seconds > 1, `${t.id} has length`);
    }
  }
  const speed = startShort("speedrun", { title: "x", series: perdix });
  assert.equal(speed.canvas.fps, 30, "a Speedrun runs at 30 fps, like the clip it imports");
  assert.ok(startShort("edit", { title: "x" }).exportPresets!.includes("nomusic"), "an edit always exports a No music copy");
  assert.equal(startShort("montage", { title: "x" }).voice, undefined, "a montage has no voice");
});

test("a series' episode starts on its settings, numbered on its end card", () => {
  const d = startShort("devlog", { title: "Ep 4", series: perdix, episode: 4 });
  assert.equal(d.series, "perdix");
  assert.deepEqual(d.voice, perdix.voice);
  assert.deepEqual(d.captions.style, perdix.captions);
  assert.deepEqual(d.music, perdix.music);
  assert.equal(d.canvas.fps, 60);
  assert.ok(d.scenes.every((s) => s.in === "cut" && s.push === 1.02));
  const end = d.text.find((t) => t.role === "end")!;
  assert.deepEqual(end, { role: "end", text: "PART 4", sub: "building Minecraft from scratch", from: { scene: "end", edge: "end", offset: -3 }, to: { scene: "end", edge: "end" } });
  assert.equal(episodeOf(d), 4);
  assert.equal(episodeOf(startShort("devlog", { title: "x" })), undefined, "no series, no number");
});

test("numbering counts on from the highest episode made; wording rules are checked per line", () => {
  assert.equal(nextEpisode(perdix, []), 4, "Perdix's episodes 1 to 3 were made before Emoton");
  assert.equal(nextEpisode(perdix, [1, 3, undefined, 2]), 4);
  assert.equal(nextEpisode({ ...perdix, before: 5 }, [2]), 6, "episodes made before Emoton count");
  const d = startShort("devlog", { title: "x", series: perdix, episode: 4 });
  d.scenes[0]!.say = ["Then I coded a face for him."];
  assert.deepEqual(wordingProblems(perdix, d), ['hook: "I coded" (the series says "I built")']);
});

test("a new Short from the library: the series' next episode, its brief kept; the overview lists the episodes and their build", async () => {
  const tmp = makeTmp();
  mkdirSync(tmp.libraryRoot, { recursive: true });
  const s = await startTestServer({ tmp, server: { createLibrary } });
  try {
    const L = createLibrary({ root: tmp.libraryRoot, defaults: DEFAULTS, trashDir: join(tmp.tmp, "trash") });
    const old = await L.createShort("", ep3());
    assert.ok(!("errors" in old));

    const r = await s.api("POST", "/api/shorts", { folder: "", template: "devlog", series: "perdix", brief: "Perdix gets a life: strolls, stares, auto-jumps." });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.summary.title, "perdix-ep4");
    assert.equal(r.body.summary.kind, "short");
    const doc = JSON.parse(readFileSync(join(r.body.dir, "short.json"), "utf8"));
    assert.equal(episodeOf(doc), 4);
    assert.equal(JSON.parse(readFileSync(join(r.body.dir, "project.json"), "utf8")).topic, "Perdix gets a life: strolls, stares, auto-jumps.");

    const o = await s.api("GET", "/api/series/perdix");
    assert.equal(o.status, 200);
    assert.deepEqual(o.body.episodes.map((e: { title: string; episode: number }) => [e.title, e.episode]), [["perdix-ep3", 3], ["perdix-ep4", 4]]);
    assert.equal(o.body.next, 5);
    assert.equal(o.body.build.pinned, "c0bece9", "the latest episode with shots sets the build");
    assert.ok(o.body.episodes[0].seconds > 50, "ep3's length from its resolved timeline");

    assert.equal((await s.api("POST", "/api/shorts", { folder: "", template: "vlog" })).status, 422);
    assert.equal((await s.api("POST", "/api/shorts", { folder: "", template: "devlog", series: "nope" })).status, 422);
    assert.equal((await s.api("GET", "/api/series/nope")).status, 404);
    const titled = await s.api("POST", "/api/shorts", { folder: "", template: "montage", title: "Milestones" });
    assert.equal(titled.body.summary.title, "Milestones");
    assert.deepEqual((await s.api("GET", "/api/series")).body.map((x: { id: string }) => x.id), ["perdix"]);
  } finally {
    await s.close();
    cleanup(tmp.tmp);
  }
});
