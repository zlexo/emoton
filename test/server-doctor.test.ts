import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { DoctorCheck } from "../shared/api.ts";
import { cleanup, makeTmp, openEvents, startTestServer, waitFor } from "./server-fake-library.ts";

function script(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A bin dir with fake tools; `claude auth status` answers with `loggedIn`. */
function fakeBin(dir: string, tools: string[], loggedIn: boolean) {
  for (const t of tools) script(join(dir, t), `#!/bin/sh\necho "${t} version 9.9"\n`);
  script(join(dir, "claude"), `#!/bin/sh\necho '{"loggedIn": ${loggedIn}, "authMethod": "claude.ai"}'\n`);
  return dir;
}

/**
 * A fake tts/.venv/bin/python (a node script): lists voice keys for `-c`,
 * and for speak.py writes the job it received as the "wav" and counts runs.
 */
function fakePython(repo: string, keys = ["af_heart", "am_michael", "bf_emma", "zz_other"]) {
  const py = join(repo, "tts", ".venv", "bin", "python");
  script(
    py,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "-c") {
  if (args[1].includes("np.load")) console.log(${JSON.stringify(JSON.stringify(keys))});
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const job = JSON.parse(input);
  fs.appendFileSync(path.join(${JSON.stringify(repo)}, "speak-runs.log"), "x");
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  fs.writeFileSync(job.out, JSON.stringify(job));
  console.log(JSON.stringify({ leadIn: 0, duration: 1, beats: [], stats: { synthesised: 1, cached: 0 } }));
});
`,
  );
}

const byId = (checks: DoctorCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

test("doctor: every check, with fixes for what is missing", async () => {
  const t = makeTmp();
  const bin = fakeBin(join(t.tmp, "bin"), ["ffmpeg", "pdftotext"], false);
  const s = await startTestServer({ tmp: t, server: { doctor: { path: bin } } });
  try {
    const r = await s.api("GET", "/api/doctor");
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.map((c: DoctorCheck) => c.id),
      ["node", "ffmpeg", "pdftotext", "yt-dlp", "claude-login", "python-tts", "voice-model", "render-browser", "disk", "library"],
    );
    const c = byId(r.body);
    assert.equal(c.node!.level, "ok");
    assert.equal(c.ffmpeg!.level, "ok");
    assert.match(c.ffmpeg!.detail, /ffmpeg version 9.9/);
    assert.equal(c["yt-dlp"]!.level, "warn");
    assert.equal(c["yt-dlp"]!.fix, "brew install yt-dlp");
    assert.equal(c["claude-login"]!.level, "error");
    assert.equal(c["claude-login"]!.fix, "claude auth login");
    assert.equal(c["python-tts"]!.level, "error");
    assert.match(c["python-tts"]!.fix!, /uv sync/);
    assert.equal(c["voice-model"]!.level, "error");
    assert.equal(c["voice-model"]!.action, "download-voice-model");
    assert.match(c["voice-model"]!.fix!, /curl -LO https:\/\/github.com\/thewh1teagle\/kokoro-onnx/);
    assert.equal(c["render-browser"]!.level, "warn");
    assert.equal(c.library!.level, "ok");
    for (const x of r.body as DoctorCheck[]) if (x.level !== "ok") assert.ok(x.fix, `${x.id} has a fix`);
  } finally {
    await s.close();
    cleanup(t.tmp);
  }
});

test("doctor: logged in, python and model present, all tools found", async () => {
  const t = makeTmp();
  const bin = fakeBin(join(t.tmp, "bin"), ["ffmpeg", "pdftotext", "yt-dlp"], true);
  const repo = join(t.tmp, "repo");
  fakePython(repo);
  mkdirSync(join(repo, "tts", "models"), { recursive: true });
  writeFileSync(join(repo, "tts", "models", "kokoro-v1.0.int8.onnx"), "m");
  writeFileSync(join(repo, "tts", "models", "voices-v1.0.bin"), "v");
  mkdirSync(join(repo, "node_modules", ".remotion", "chrome-headless-shell"), { recursive: true });
  // the fake python is a node script, so node must be on the doctor's PATH (after the fakes)
  const s = await startTestServer({ tmp: t, server: { doctor: { path: `${bin}:${dirname(process.execPath)}` } } });
  try {
    const c = byId((await s.api("GET", "/api/doctor")).body);
    for (const id of ["ffmpeg", "pdftotext", "yt-dlp", "claude-login", "python-tts", "voice-model", "render-browser", "library"]) {
      assert.equal(c[id]!.level, "ok", `${id}: ${c[id]!.detail}`);
    }
    assert.equal(c["claude-login"]!.detail, "Logged in (claude.ai)");
  } finally {
    await s.close();
    cleanup(t.tmp);
  }
});

test("doctor: disk thresholds warn and error", async () => {
  const t = makeTmp();
  let s = await startTestServer({ tmp: t, server: { doctor: { path: "", diskWarn: Number.MAX_SAFE_INTEGER, diskError: 0 } } });
  try {
    assert.equal(byId((await s.api("GET", "/api/doctor")).body).disk!.level, "warn");
    await s.close();
    s = await startTestServer({ tmp: t, server: { doctor: { path: "", diskWarn: Number.MAX_SAFE_INTEGER, diskError: Number.MAX_SAFE_INTEGER } } });
    const d = byId((await s.api("GET", "/api/doctor")).body).disk!;
    assert.equal(d.level, "error");
    assert.ok(d.fix);
  } finally {
    await s.close();
    cleanup(t.tmp);
  }
});

test("doctor fix: create-library makes the folder; unknown action is 422", async () => {
  const s = await startTestServer({ server: { doctor: { path: "" } } });
  try {
    const set = (await s.api("GET", "/api/settings")).body;
    const missing = join(s.tmp, "not-yet", "Emoton");
    await s.api("PUT", "/api/settings", { ...set, libraryRoot: missing });
    const lib = byId((await s.api("GET", "/api/doctor")).body).library!;
    assert.equal(lib.level, "error");
    assert.equal(lib.action, "create-library");
    const r = await s.api("POST", "/api/doctor/fix", { action: "create-library" });
    assert.equal(r.status, 202);
    assert.equal(byId(r.body).library!.level, "ok");
    assert.ok(existsSync(missing));
    assert.equal((await s.api("POST", "/api/doctor/fix", { action: "format-disk" })).status, 422);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("doctor fix: download-voice-model fetches the files, then says hello; a failed download is reported", async () => {
  const files: Record<string, string> = { "/a.onnx": "model-bytes", "/v.bin": "voice-bytes" };
  const host = http.createServer((req, res) => {
    const body = files[req.url ?? ""];
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  const modelFiles = [
    { name: "kokoro-v1.0.int8.onnx", url: `${base}/a.onnx` },
    { name: "voices-v1.0.bin", url: `${base}/v.bin` },
  ];
  const s = await startTestServer({ server: { doctor: { path: "", modelFiles } } });
  const ev = await openEvents(s.url);
  try {
    await waitFor(() => ev.events.length === 1, "hello");
    const r = await s.api("POST", "/api/doctor/fix", { action: "download-voice-model" });
    assert.equal(r.status, 202);
    await waitFor(() => ev.events.filter((e) => e.type === "hello").length === 2, "hello after the download");
    const dir = join(s.tmp, "repo", "tts", "models");
    assert.equal(readFileSync(join(dir, "kokoro-v1.0.int8.onnx"), "utf8"), "model-bytes");
    assert.equal(readFileSync(join(dir, "voices-v1.0.bin"), "utf8"), "voice-bytes");
    assert.equal(byId((await s.api("GET", "/api/doctor")).body)["voice-model"]!.level, "ok");

    // a broken link: reported in the check, no partial file left
    await s.close();
    cleanup(join(s.tmp, "repo"));
    const s2 = await startTestServer({ server: { doctor: { path: "", modelFiles: [{ name: "voices-v1.0.bin", url: `${base}/gone` }] } } });
    try {
      await s2.api("POST", "/api/doctor/fix", { action: "download-voice-model" });
      const vm = await waitFor(async () => {
        const c = byId((await s2.api("GET", "/api/doctor")).body)["voice-model"]!;
        return c.detail.includes("last download failed") ? c : null;
      }, "failed download to show");
      assert.match(vm.detail, /HTTP 404/);
      assert.equal(existsSync(join(s2.tmp, "repo", "tts", "models", "voices-v1.0.bin.download")), false);
    } finally {
      await s2.close();
      cleanup(s2.tmp);
    }
  } finally {
    await ev.close();
    await s.close();
    host.close();
    cleanup(s.tmp);
  }
});

test("voices: curated list checked against the voice file; the system voice is always there", async () => {
  const s = await startTestServer();
  try {
    const none = await s.api("GET", "/api/voices");
    assert.deepEqual(none.body.map((v: any) => v.voice), ["default"], "without the model only the system voice");
    fakePython(join(s.tmp, "repo"));
    const r = await s.api("GET", "/api/voices");
    assert.deepEqual(r.body.map((v: any) => `${v.engine}:${v.voice}`), ["kokoro:af_heart", "kokoro:am_michael", "kokoro:bf_emma", "say:default"]);
    assert.deepEqual(r.body[2], { engine: "kokoro", voice: "bf_emma", label: "Emma", accent: "UK", gender: "f", group: "Recommended", timed: true });
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("voices: every English Kokoro voice by group, then the macOS Premium voices and narrators, untimed", async () => {
  const system = async () => [
    { name: "Zoe (Premium)", locale: "en_US" }, { name: "Daniel", locale: "en_GB" }, { name: "Bubbles", locale: "en_US" }, { name: "Moira", locale: "en_IE" },
  ];
  const s = await startTestServer({ server: { systemVoices: system } });
  try {
    fakePython(join(s.tmp, "repo"), ["af_heart", "af_sky", "am_puck", "bm_daniel", "zz_other", "jf_alpha"]);
    const r = await s.api("GET", "/api/voices");
    assert.deepEqual(r.body.map((v: any) => `${v.group}|${v.engine}:${v.voice}|${v.label}|${v.accent}|${v.timed}`), [
      "Recommended|kokoro:af_heart|Heart|US|true",
      "Recommended|say:default|macOS system voice|system|false",
      "Kokoro · US women|kokoro:af_sky|Sky|US|true",
      "Kokoro · US men|kokoro:am_puck|Puck|US|true",
      "Kokoro · UK men|kokoro:bm_daniel|Daniel|UK|true",
      "macOS · Premium|say:Zoe (Premium)|Zoe (Premium)|US|false",
      "macOS · standard|say:Daniel|Daniel|UK|false",
      "macOS · standard|say:Moira|Moira|IE|false",
    ]);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("voice sample: runs speak.py once per distinct request, returns the wav, validates input", async () => {
  const s = await startTestServer();
  const repo = join(s.tmp, "repo");
  fakePython(repo);
  const runs = () => (existsSync(join(repo, "speak-runs.log")) ? readFileSync(join(repo, "speak-runs.log"), "utf8").length : 0);
  try {
    const set = (await s.api("GET", "/api/settings")).body;
    await s.api("PUT", "/api/settings", { ...set, pronounce: { EAGAIN: "E again" } });
    const voice = { engine: "kokoro", voice: "am_michael", speed: 1.1 };
    const a = await fetch(`${s.url}/api/voices/sample`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice }) });
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("content-type"), "audio/wav");
    const job = JSON.parse(await a.text());
    assert.equal(job.engine, "kokoro");
    assert.equal(job.voice, "am_michael");
    assert.equal(job.speed, 1.1);
    assert.deepEqual(job.beats, [{ say: ["This is how your videos will sound."], aha: false }]);
    assert.deepEqual(job.pronounce, { EAGAIN: "E again" });
    assert.equal(runs(), 1);
    const again = await fetch(`${s.url}/api/voices/sample`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice }) });
    await again.arrayBuffer();
    assert.equal(runs(), 1, "the second identical sample comes from the cache");
    const other = await s.api("POST", "/api/voices/sample", { voice, text: "Another line." });
    assert.equal(other.status, 200);
    assert.equal(runs(), 2);
    const bad = await s.api("POST", "/api/voices/sample", { voice: { engine: "espeak", voice: "x", speed: 9 } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.length >= 2);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("augmentPath appends the usual tool folders once, keeping the given order first", async () => {
  const { augmentPath } = await import("../server/doctor.ts");
  assert.equal(augmentPath("/usr/bin:/opt/homebrew/bin", "/Users/x"), "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin");
  assert.equal(augmentPath("", "/h"), "/opt/homebrew/bin:/usr/local/bin:/h/.local/bin");
  const once = augmentPath("/a", "/h");
  assert.equal(augmentPath(once, "/h"), once);
});

test("doctor fix: a stalled download fails with a clear message, leaves no partial file, and can be retried", async () => {
  let stall = true;
  const host = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    if (stall) res.write("first bytes, then nothing"); // never ends
    else res.end("x".repeat(1000));
  });
  await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(host.address() as AddressInfo).port}/v.bin`;
  const s = await startTestServer({
    server: { doctor: { path: "", modelFiles: [{ name: "voices-v1.0.bin", url }], downloadStallMs: 100, downloadTimeoutMs: 5000 } },
  });
  try {
    await s.api("POST", "/api/doctor/fix", { action: "download-voice-model" });
    const vm = await waitFor(async () => {
      const c = byId((await s.api("GET", "/api/doctor")).body)["voice-model"]!;
      return c.detail.includes("last download failed") ? c : null;
    }, "the stall to be reported");
    assert.match(vm.detail, /stalled/);
    assert.equal(vm.level, "error");
    assert.equal(vm.action, "download-voice-model", "the fix is offered again");
    assert.equal(existsSync(join(s.tmp, "repo", "tts", "models", "voices-v1.0.bin.download")), false);
    stall = false;
    host.closeAllConnections();
    await s.api("POST", "/api/doctor/fix", { action: "download-voice-model" });
    await waitFor(async () => byId((await s.api("GET", "/api/doctor")).body)["voice-model"]!.level === "ok", "retry to succeed");
  } finally {
    await s.close();
    host.closeAllConnections();
    host.close();
    cleanup(s.tmp);
  }
});
