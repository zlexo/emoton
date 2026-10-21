import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLibrary } from "../library/index.ts";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { DEFAULTS } from "./fixtures/helpers.ts";
import { cleanup, makeTmp, startTestServer } from "./server-fake-library.ts";

const ep3 = () => fromDevlogJob(JSON.parse(readFileSync(new URL("fixtures/codetyper/perdix-ep3.job.json", import.meta.url), "utf8")), { build: "c0bece9" });

test("the Short routes: document with its revision, saves that refuse stale or invalid ones, the preview", async () => {
  const tmp = makeTmp();
  mkdirSync(tmp.libraryRoot, { recursive: true });
  const s = await startTestServer({ tmp, server: { createLibrary } });
  try {
    // made on disk by a library of its own: the server's finds it by scanning
    const d = await createLibrary({ root: tmp.libraryRoot, defaults: DEFAULTS, trashDir: join(tmp.tmp, "trash") }).createShort("", ep3());
    assert.ok(!("errors" in d));
    const id = d.summary.id;

    const lib = await s.api("GET", "/api/library");
    assert.equal(lib.body.videos.find((v: { id: string }) => v.id === id).kind, "short");

    const doc = await s.api("GET", `/api/shorts/${id}/document`);
    assert.equal(doc.status, 200);
    assert.match(doc.body.revision, /^[0-9a-f]{16}$/);

    const next = structuredClone(doc.body.document);
    next.scenes[0].push = 1.04;
    assert.equal((await s.api("PUT", `/api/shorts/${id}/document`, { document: next })).status, 400, "a save names its revision");
    const bad = await s.api("PUT", `/api/shorts/${id}/document`, { document: { ...next, scenes: [] }, revision: doc.body.revision });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.some((e: string) => e.startsWith("scenes:")));
    const ok = await s.api("PUT", `/api/shorts/${id}/document`, { document: next, revision: doc.body.revision });
    assert.equal(ok.status, 200);
    assert.notEqual(ok.body.revision, doc.body.revision);
    const stale = await s.api("PUT", `/api/shorts/${id}/document`, { document: next, revision: doc.body.revision });
    assert.equal(stale.status, 409);

    const p = await s.api("GET", `/api/shorts/${id}/preview`);
    assert.equal(p.status, 200);
    assert.equal(p.body.voiced, false);
    assert.equal(p.body.props.short.scenes.length, 6);
    assert.equal(p.body.props.short.scenes[0].push[1], 1.04);

    // a line a shot's cue is pinned to, rewritten: the preview says why it cannot play
    next.scenes[1].say[4] = "Perdix!";
    await s.api("PUT", `/api/shorts/${id}/document`, { document: next, revision: ok.body.revision });
    const refused = await s.api("GET", `/api/shorts/${id}/preview`);
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body.errors, ['scene born knob TAG_AT: no line "perdix." in the script']);
  } finally {
    await s.close();
    cleanup(tmp.tmp);
  }
});
