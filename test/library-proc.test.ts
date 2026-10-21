import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveChildren, runChild } from "../pipeline/proc.ts";
import type { Tts } from "../pipeline/voice.ts";
import { askClaude } from "../pipeline/write.ts";
import { ctx, lib, readyBundle, temp } from "./fixtures/helpers.ts";

/** pids of processes whose command line contains `marker` (pgrep exits 1 when there are none). */
function pids(marker: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", marker]).toString().trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Waits (by polling, no time budget asserted) until `marker` shows up in the process list. */
async function until(marker: string) {
  for (let i = 0; i < 200 && !pids(marker).length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(pids(marker).length > 0, `${marker} never started`);
}

test("abort kills a child and its grandchildren", async () => {
  const marker = "31.41592";
  const ac = new AbortController();
  // sh starts two background sleeps and waits: all must die. The sleeps do not hold
  // sh's pipes, so killing only sh would settle the promise and leave them running.
  const p = runChild("sh", ["-c", `sleep ${marker} >/dev/null 2>&1 & sleep ${marker}1 >/dev/null 2>&1 & wait`], { signal: ac.signal });
  const sleeps = `^sleep ${marker}`; // the sleeps, not the sh whose command line also has the marker
  try {
    await until(sleeps);
    assert.equal(pids(sleeps).length, 2, "the check can see both sleeps");
  } finally {
    ac.abort();
  }
  await assert.rejects(p, /cancelled/);
  assert.deepEqual(pids(marker), []);
  assert.equal(liveChildren(), 0);
});

test("aborting a voice step kills the TTS process, records no error and leaves no partial file", async () => {
  const t = temp();
  try {
    const marker = "27.18281";
    const tts: Tts = async (job, o) => {
      writeFileSync(job.out, "half a wav");
      return (await runChild("sleep", [marker], { signal: o.signal })).stdout;
    };
    const L = lib(t, { tts });
    const dir = await readyBundle(t);
    const id = (await L.tree()).videos[0]!.id;
    // A new voice makes chapter 2 stale, so the step really runs the TTS.
    await L.updateBrief(id, { voice: { engine: "kokoro", voice: "bf_emma", speed: 1 } });
    const ac = new AbortController();
    const run = L.runStep(id, { stage: "voice", chapter: 2, lane: "media" }, ctx(ac.signal));
    await until(marker);
    ac.abort();
    await assert.rejects(run, /cancelled/);
    assert.deepEqual(pids(marker), []);
    assert.ok(!existsSync(join(dir, "audio", "ch2.part.wav")));
    assert.equal((await L.state(id)).lastError, undefined, "a cancel is not an error");
    assert.equal((await L.state(id)).chapters[1]!.voice, "stale");
  } finally {
    t.done();
  }
});

test("aborting the writer kills the claude CLI", async () => {
  const t = temp();
  const path = process.env.PATH;
  try {
    const marker = "16.18033";
    const bin = join(t.base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec sleep ${marker}\n`);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    const ac = new AbortController();
    const p = askClaude("prompt", {}, "opus", ac.signal);
    await until(marker);
    ac.abort();
    await assert.rejects(p, /cancelled/);
    assert.deepEqual(pids(marker), []);
  } finally {
    process.env.PATH = path;
    t.done();
  }
});

test("opt-in (EMOTON_SLOW=1): really voices two sentences with speak.py", { skip: !process.env.EMOTON_SLOW }, async () => {
  const t = temp();
  try {
    const L = lib(t);
    const src = join(t.base, "notes.txt");
    writeFileSync(src, "notes");
    const d = await L.createVideo({ folder: "", brief: { topic: "slow test" }, sourcePaths: [src], mode: "draft" });
    // Minimal outline + chapter so the chapter can be stored and voiced.
    writeFileSync(join(d.dir, "chunks.json"), JSON.stringify([{ id: "notes:s1", source: "notes", text: "notes" }]));
    const outline = { title: "Slow", hook: "Does the voice work?", chapters: [1, 2].map((i) => ({ title: `C${i}`, goal: "g", claims: [{ text: "t", cite: ["notes:s1"] }] })) };
    assert.ok(!("errors" in (await L.saveOutline(d.summary.id, outline))));
    const chapter = { title: "C1", beats: [{ say: ["Hello there."], visual: { type: "title", title: "Hi" } }, { say: ["The voice works."], visual: { type: "title", title: "Yes" } }] };
    assert.ok(!("errors" in (await L.saveChapter(d.summary.id, 1, chapter))));
    const c = ctx();
    await L.runStep(d.summary.id, { stage: "voice", chapter: 1, lane: "media" }, c);
    const st = await L.state(d.summary.id);
    assert.equal(st.chapters[0]!.voice, "ok");
    assert.ok(c.progressCalls.some(([, x]) => x?.includes("sentence 2 of 2")));
  } finally {
    t.done();
  }
});

test("child output is decoded as a stream: multi-byte characters split across chunks stay whole", async () => {
  const s = "→".repeat(200000);
  const r = await runChild(process.execPath, ["-e", `const s = "\\u2192".repeat(200000); process.stdout.write(s); process.stderr.write(s);`]);
  assert.equal(r.stdout.length, s.length);
  assert.ok(!r.stdout.includes("�") && !r.stderr.includes("�"), "no replacement characters");
  assert.equal(r.stdout, s);
});

test("a child that runs past its timeout is stopped with a clear error", async () => {
  const marker = "19.28374";
  await assert.rejects(runChild("sleep", [marker], { timeoutMs: 300 }), { message: "sleep took longer than 0.3 s and was stopped" });
  assert.deepEqual(pids(`^sleep ${marker}`), []);
});

test("ingest gives up on a web page that never answers, with a clear error", async () => {
  const { createServer } = await import("node:http");
  const { ingest } = await import("../pipeline/ingest.ts");
  const { Project } = await import("../pipeline/project.ts");
  const server = createServer(() => {}); // accepts, never answers
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/page`;
  try {
    const p = Project.parse({ title: "t", topic: "t", audience: "a", minutes: 2, voice: { engine: "say", voice: "x", speed: 1 }, sources: [{ id: "web", title: "Web", path: url }] });
    await assert.rejects(ingest(p, "/nonexistent", { fetchTimeoutMs: 200 }), { message: `web: ${url} did not answer within 0.2 s` });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
