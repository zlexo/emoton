import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLibrary } from "../library/index.ts";
import { fromDevlogJob } from "../pipeline/codetyper.ts";
import { AskAnswer, askPrompt, askShort } from "../pipeline/short-ask.ts";
import { shotKinds } from "../pipeline/shots.ts";
import type { Writer } from "../pipeline/write.ts";
import type { ShortPreview } from "../shared/api.ts";
import { Short } from "../schema/short.ts";
import { writerSchema } from "../schema/storyboard.ts";
import { diffShort } from "../src/core/short/diff.ts";
import { estimatedVoice } from "../src/core/short/estimate.ts";
import { DEFAULTS, lib, readyBundle, temp } from "./fixtures/helpers.ts";
import { cleanup, makeTmp, startTestServer } from "./server-fake-library.ts";

const ep3 = () => Short.parse(fromDevlogJob(JSON.parse(readFileSync(new URL("fixtures/codetyper/perdix-ep3.job.json", import.meta.url), "utf8")), { build: "c0bece9", series: "perdix" }));
const quiet = { signal: new AbortController().signal, progress() {}, log() {} };
const kinds = shotKinds();

/** ep3 with a punchier opening: its first line rewritten, a boom added on it, the music lifted. */
function punchier(d = ep3()): Short {
  const n = structuredClone(d);
  n.scenes[0]!.say![0] = "Last time, this world got textures. Today it gets a resident. [boom]";
  n.music!.gainDb = -15;
  return n;
}

test("the diff names what changed: lines, visuals, timing, scenes added, removed and moved, the tracks", () => {
  const a = ep3();
  assert.deepEqual(diffShort(a, structuredClone(a)), [], "the same document: no changes");
  const b = punchier(a);
  b.scenes = [b.scenes[1]!, b.scenes[0]!, ...b.scenes.slice(2, 5)];
  b.scenes[2]!.push = 1.1;
  const pov = b.scenes.find((s) => s.id === "pov")!;
  pov.visual = { type: "card", title: "His view" };
  b.scenes.push({ id: "bonus", say: ["One more thing."], visual: { type: "card", title: "Bonus" } });
  b.sfx = [{ kind: "ding", at: { t: 2 } }];
  const changes = diffShort(a, b).map((c) => `${c.kind} ${c.label}`);
  for (const want of [
    "removed scene horizon (shot stream)",
    "added scene bonus: card \"Bonus\", 1 line",
    "moved scene born moved to place 1",
    'changed world: line 1: "Last time, this world got its textures. Today, it gets someone to live in it." → "Last time, this world got textures. Today it gets a resident."',
    "changed walk: push 1.02 → 1.1",
    'changed pov: shot walk → card "His view"',
    "added ding at 2 s",
    "changed music changed",
  ]) assert.ok(changes.includes(want), `missing: ${want}\n${changes.join("\n")}`);
  assert.equal(changes.filter((c) => c.startsWith("moved")).length, 1, "a swap is one scene moving, not two");
  const marks = structuredClone(a);
  marks.scenes[1]!.say![0] = "He spawned magenta. Like everything I make, at first. [ding]";
  assert.deepEqual(diffShort(a, marks).map((c) => c.label), ["born: sounds in line 1: ding"], "a marker swapped is a sound change, not a rewrite");
});

test("Ask's prompt names the request, the words of every line and the anchors; its answer schema is the CLI's kind", () => {
  const d = ep3();
  const p = askPrompt(d, estimatedVoice(d), "make the intro punchier", kinds);
  for (const want of ['The request: "make the intro punchier"', 'key "perdix.": 0:Perdix.', '{"word": {"s": <line key>, "w": <word index>}', "perdix-walk:", 'say "I built", never "I coded"']) assert.ok(p.includes(want), want);
  const s = JSON.stringify(writerSchema(AskAnswer));
  assert.ok(!s.includes("prefixItems") && !/"type":\[/.test(s));
});

test("a proposal goes back until it is valid JSON, a valid document, follows the series and changes something", async () => {
  const d = ep3();
  const bad = punchier(d);
  bad.scenes[0]!.say![0] = "Last time, I coded this world its textures. [boom]";
  const broken = structuredClone(punchier(d)) as unknown as { scenes: { id: string }[] };
  broken.scenes[1]!.id = "has space";
  const answers: unknown[] = [
    { summary: "x", document: "{not json" },
    { summary: "x", document: JSON.stringify(d) },
    { summary: "x", document: JSON.stringify(broken) },
    { summary: "x", document: JSON.stringify(bad) },
  ];
  const prompts: string[] = [];
  const writer: Writer = async (p, _s, _m, _sig, system) => (prompts.push(p), assert.match(system ?? "", /rewriting their JSON document/), answers.shift());
  await assert.rejects(askShort(d, "punchier", { writer, model: "opus", kinds }), /still invalid after 3 attempts/);
  assert.match(prompts[1]!, /document: not JSON/);
  assert.match(prompts[2]!, /came back unchanged/);

  const tries: unknown[] = [{ summary: "x", document: JSON.stringify(bad) }, { summary: "Tighter first line, a boom on it, the score up 2.7 dB.", document: JSON.stringify(punchier(d)) }];
  const out = await askShort(d, "punchier", { writer: async () => tries.shift(), model: "opus", kinds });
  assert.equal(out.attempts, 2, "the wording slip went back");
  assert.equal(out.summary, "Tighter first line, a boom on it, the score up 2.7 dB.");
  assert.equal(out.document.music!.gainDb, -15);
});

test("an ask job: a Short with a request leaves a proposal beside it; dropping it removes it; the route checks the request", async () => {
  const t = temp();
  try {
    const want = punchier();
    const L = lib(t, { writer: async () => ({ summary: "A punchier opening.", document: JSON.stringify(want) }) });
    const d = await L.createShort("", ep3());
    assert.ok(!("errors" in d));
    const id = d.summary.id;
    await assert.rejects(L.plan(id, "ask"), { status: 400, message: /the request/ });
    const steps = await L.plan(id, "ask", { note: "  make the intro punchier " });
    assert.deepEqual(steps, [{ stage: "ask", lane: "write", note: "make the intro punchier" }]);
    const before = await L.shortDocument(id);
    await L.runStep(id, steps[0]!, quiet);
    assert.deepEqual((await L.shortDocument(id)).document, before.document, "nothing changes until the maker keeps it");
    const p = (await L.previewShort(id)) as ShortPreview;
    assert.equal(p.ask?.summary, "A punchier opening.");
    assert.equal(p.ask?.request, "make the intro punchier");
    assert.equal(p.ask?.base, before.revision);
    assert.deepEqual(p.ask?.document, want);
    await L.dropShortProposal(id);
    assert.equal(existsSync(join(d.dir, "ask.json")), false);
    assert.equal(((await L.previewShort(id)) as ShortPreview).ask, undefined);

    const video = await readyBundle(t);
    await assert.rejects(L.plan(JSON.parse(readFileSync(join(video, "project.json"), "utf8")).id, "ask", { note: "x" }), { status: 400, message: /only a Short has Ask/ });
  } finally {
    t.done();
  }

  const tmp = makeTmp();
  const s = await startTestServer({ tmp, server: { createLibrary } });
  try {
    const d = await createLibrary({ root: tmp.libraryRoot, defaults: DEFAULTS, trashDir: join(tmp.tmp, "trash") }).createShort("", ep3());
    assert.ok(!("errors" in d));
    const r = await s.api("POST", "/api/jobs", { videoId: d.summary.id, kind: "ask" });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.includes("note: ask needs the request"));
    assert.equal((await s.api("DELETE", `/api/shorts/${d.summary.id}/ask`)).status, 200, "dropping when nothing is pending is fine");
  } finally {
    await s.close();
    cleanup(tmp.tmp);
  }
});
