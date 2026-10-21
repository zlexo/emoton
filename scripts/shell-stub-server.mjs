#!/usr/bin/env node
// A stand-in for the Emoton server, for testing the Tauri shell (src-tauri/)
// without server/main.ts. Speaks just enough of shared/api.ts:
//
//   GET  /api/health            Health (protocol from STUB_PROTOCOL, default 1)
//   GET  /api/jobs              Job[]: none, or one running + one queued job
//   POST /api/jobs/:id/cancel   marks the job cancelled, records the call
//   GET  /                      a page that reports what the shell gives it
//
// Test-only endpoints:
//   GET  /__stub/events         everything recorded so far (JSON)
//   POST /__stub/jobs?mode=     switch between "none" and "running"
//   POST /__stub/report         the page posts its findings here
//
// Env: STUB_PORT (8891), STUB_JOBS ("none" | "running"), STUB_PROTOCOL (1),
// STUB_DELAY_MS (wait before listening, to see the splash),
// STUB_NOT_READY_MS (answer health with 503, then exit after N ms: a server
// that holds the port and goes away), STUB_NAVTEST=1 (the page tries to
// leave the app), EMOTON_PARENT_PIPE=1 (exit when stdin closes, like the
// real server: the shell sets it),
// STUB_RECORD (JSON-lines file, default <tmpdir>/emoton-shell-stub.jsonl).
//
// Usage with the built app (the shell spawns it when nothing listens):
//   EMOTON_SERVER_CMD="node $PWD/scripts/shell-stub-server.mjs" STUB_JOBS=running \
//     src-tauri/target/release/bundle/macos/Emoton.app/Contents/MacOS/emoton

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.STUB_PORT ?? 8891);
const PROTOCOL = Number(process.env.STUB_PROTOCOL ?? 1);
const DELAY = Number(process.env.STUB_DELAY_MS ?? 0);
const NOT_READY_MS = Number(process.env.STUB_NOT_READY_MS ?? 0);
const NAVTEST = process.env.STUB_NAVTEST === "1";
const RECORD = process.env.STUB_RECORD ?? path.join(os.tmpdir(), "emoton-shell-stub.jsonl");

let mode = process.env.STUB_JOBS === "running" ? "running" : "none";
const events = [];
let jobs = makeJobs(mode);

function record(type, data = {}) {
  const e = { at: new Date().toISOString(), pid: process.pid, type, ...data };
  events.push(e);
  fs.appendFileSync(RECORD, JSON.stringify(e) + "\n");
  console.log(`stub: ${type} ${JSON.stringify(data)}`);
}

function makeJobs(m) {
  if (m !== "running") return [];
  const job = (id, status, progress) => ({
    id,
    videoId: "v-stub",
    videoTitle: "Stub video",
    kind: "make",
    status,
    steps: [],
    progress,
    createdAt: new Date().toISOString(),
    log: [],
  });
  return [job("job-running", "running", 0.4), job("job-queued", "queued", 0), job("job-done", "done", 1)];
}

function send(res, status, body, type = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith("/__stub/")) record("request", { method: req.method, path: url.pathname });

  if (req.method === "GET" && url.pathname === "/api/health") {
    if (NOT_READY_MS) return send(res, 503, { error: "starting" });
    return send(res, 200, { ok: true, protocol: PROTOCOL, version: "stub", gitHash: "stub", pid: process.pid, libraryRoot: os.tmpdir() });
  }
  if (req.method === "GET" && url.pathname === "/api/jobs") return send(res, 200, jobs);
  const cancel = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancel) {
    const job = jobs.find((j) => j.id === cancel[1]);
    record("cancel", { id: cancel[1], found: !!job });
    if (!job) return send(res, 404, { error: "no such job" });
    job.status = "cancelled";
    return send(res, 200, job);
  }
  if (req.method === "GET" && url.pathname === "/__stub/events") return send(res, 200, events);
  if (req.method === "POST" && url.pathname === "/__stub/jobs") {
    mode = url.searchParams.get("mode") === "running" ? "running" : "none";
    jobs = makeJobs(mode);
    record("jobs-mode", { mode });
    return send(res, 200, { mode });
  }
  if (req.method === "POST" && url.pathname === "/__stub/report") {
    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch {
      data = { unparsable: true };
    }
    record("report", data);
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return send(res, 200, PAGE.replace("__NAVTEST__", String(NAVTEST)), "text/html; charset=utf-8");
  }
  return send(res, 404, { error: "not found" });
});

if (process.env.EMOTON_PARENT_PIPE === "1") {
  process.stdin.on("end", () => {
    record("parent-pipe-eof");
    process.exit(0);
  });
  process.stdin.resume();
}

if (NOT_READY_MS) {
  setTimeout(() => {
    record("not-ready-exit");
    process.exit(0);
  }, NOT_READY_MS);
}

process.on("SIGTERM", () => {
  record("signal", { signal: "SIGTERM" });
  server.close();
  process.exit(0);
});

setTimeout(() => {
  server.listen(PORT, "127.0.0.1", () => record("listening", { port: PORT, protocol: PROTOCOL, jobs: mode }));
}, DELAY);

// The page the shell loads. It reports whether it runs inside the app, which
// native APIs the remote-origin capability lets through, and every menu event
// and Finder drop it receives. Probes pass deliberately invalid arguments so
// that nothing opens: a granted command fails on its arguments, a denied one
// fails with "not allowed" before its arguments are read.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Emoton stub</title>
<style>
  body { margin: 0; background: #0E0E10; color: #ECECEE; font: 14px/1.5 -apple-system, sans-serif; }
  .bar { height: 48px; padding-left: 84px; display: flex; align-items: center; color: #8A8A93; border-bottom: 1px solid #232328; }
  main { padding: 20px 24px; }
  code { font: 12px ui-monospace, Menlo, monospace; }
  li { margin: 2px 0; }
  .ok { color: #58C4DD; } .no { color: #FC6255; }
</style></head>
<body>
<div class="bar" data-tauri-drag-region>Emoton stub server (title bar drag region)</div>
<main>
  <p id="where"></p>
  <h3>Native API probes</h3><ul id="probes"></ul>
  <h3>Menu events and drops</h3><ul id="events"><li>none yet: try the menu, or drop a file here</li></ul>
</main>
<script>
const MENU_EVENT = "emoton://menu";
const report = (data) => fetch("/__stub/report", { method: "POST", body: JSON.stringify(data) }).catch(() => {});
const T = window.__TAURI__;
const where = document.getElementById("where");
where.innerHTML = T
  ? '<span class="ok">window.__TAURI__ exists</span>: ' + Object.keys(T).sort().concat(["dialog", "opener", "notification"].filter((k) => T[k])).join(", ")
  : '<span class="no">window.__TAURI__ is undefined</span> (plain browser)';
let seen = 0;
function addEvent(text) {
  const ul = document.getElementById("events");
  if (!seen++) ul.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = text;
  ul.appendChild(li);
}
async function probe(cmd, args) {
  try { const r = await T.core.invoke(cmd, args); return { cmd, result: "ok", value: r ?? null }; }
  catch (e) { const msg = String(e); return { cmd, result: /not allowed/i.test(msg) ? "denied" : "granted", error: msg.slice(0, 200) }; }
}
(async () => {
  // Plugin APIs are defined non-enumerable, so Object.keys does not list them.
  const plugins = T ? { dialog: !!T.dialog, opener: !!T.opener, notification: !!T.notification } : {};
  const out = { href: location.href, tauri: !!T, plugins, keys: T ? Object.keys(T).sort() : [] };
  if (T) {
    out.probes = [
      await probe("plugin:dialog|open", { options: 42 }),
      await probe("plugin:dialog|save", { options: 42 }),
      await probe("plugin:opener|reveal_item_in_dir", { paths: 42 }),
      await probe("plugin:opener|open_path", { path: 42 }),
      await probe("plugin:notification|is_permission_granted", {}),
      await probe("plugin:window|start_dragging", { label: 42 }),
      // open_path's scope: a program is refused before anything opens; a
      // source file inside a bundle passes the scope (and then fails, as it
      // does not exist).
      Object.assign(await probe("plugin:opener|open_path", { path: "/tmp/emoton-e2e-nope/Evil.app" }), { cmd: "open_path(.app)" }),
      Object.assign(await probe("plugin:opener|open_path", { path: "/tmp/emoton-e2e-nope/v.emoton/sources/a.pdf" }), { cmd: "open_path(source pdf)" }),
      // Negative controls: not in the capability, must come back denied.
      await probe("plugin:dialog|message", { message: 42 }),
      await probe("plugin:app|version", {}),
      await probe("plugin:window|close", { label: 42 }),
      await probe("plugin:opener|open_url", { url: 42 }),
      await probe("retry", {}),
    ];
    try {
      await T.event.listen(MENU_EVENT, (e) => { addEvent("menu: " + e.payload); report({ menu: e.payload }); });
      out.menuListen = "ok";
    } catch (e) { out.menuListen = String(e); }
    try {
      await T.webview.getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop") { addEvent("drop: " + e.payload.paths.join(", ")); report({ drop: e.payload.paths }); }
      });
      out.dragDropListen = "ok";
    } catch (e) { out.dragDropListen = String(e); }
    const ul = document.getElementById("probes");
    for (const p of out.probes) {
      const li = document.createElement("li");
      li.innerHTML = '<code>' + p.cmd + '</code>: <span class="' + (p.result === "denied" ? "no" : "ok") + '">' + p.result + '</span>';
      ul.appendChild(li);
    }
  }
  report({ page: out });
  if (__NAVTEST__) {
    // The shell must cancel these and keep this page.
    window.open("https://example.com/emoton-new-window-test", "_blank");
    location.href = "https://example.com/emoton-nav-test";
    await new Promise((r) => setTimeout(r, 800));
    location.href = "file:///etc/hosts"; // WebKit itself refuses this one
    await new Promise((r) => setTimeout(r, 500));
    location.href = "emoton-e2e://blocked"; // reaches the shell's guard
    await new Promise((r) => setTimeout(r, 800));
    report({ navGuard: location.href });
  }
})();
</script>
</body></html>`;
