import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import http from "node:http";
import { PROTOCOL } from "../shared/api.ts";
import { defaultSettings } from "../server/settings.ts";
import { cleanup, makeTmp, startTestServer, waitFor } from "./server-fake-library.ts";

test("health reports protocol, version and the library root", async () => {
  const s = await startTestServer();
  try {
    const r = await s.api("GET", "/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.protocol, PROTOCOL);
    assert.equal(r.body.pid, process.pid);
    assert.equal(r.body.libraryRoot, join(s.tmp, "library"));
    assert.equal(typeof r.body.gitHash, "string");
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("unknown api path is a JSON 404, wrong method a 405", async () => {
  const s = await startTestServer();
  try {
    const a = await s.api("GET", "/api/nope");
    assert.equal(a.status, 404);
    assert.match(a.body.error, /no such endpoint/);
    const b = await s.api("DELETE", "/api/health");
    assert.equal(b.status, 405);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("settings: defaults, round trip, validation, file written atomically at the given path", async () => {
  const s = await startTestServer();
  try {
    const g = await s.api("GET", "/api/settings");
    assert.equal(g.status, 200);
    const d = defaultSettings();
    assert.deepEqual(g.body.defaults, d.defaults);
    assert.equal(g.body.pauseAfterOutlineOverMinutes, 3);
    assert.equal(g.body.stylePresets[0].name, "Concepts only");
    assert.equal(g.body.stylePresets[0].rules.length, 2);

    const next = { ...g.body, pauseAfterOutlineOverMinutes: null, renderQuality: "720p", pronounce: { EAGAIN: "E again" } };
    const p = await s.api("PUT", "/api/settings", next);
    assert.equal(p.status, 200);
    assert.equal(p.body.renderQuality, "720p");
    const onDisk = JSON.parse(readFileSync(s.settingsPath, "utf8"));
    assert.equal(onDisk.pauseAfterOutlineOverMinutes, null);
    assert.deepEqual(onDisk.pronounce, { EAGAIN: "E again" });
    assert.deepEqual((await s.api("GET", "/api/settings")).body, p.body);
    // the Library is rebuilt with the new global pronounce list
    assert.deepEqual(s.world.libraryOptions.at(-1)!.globalPronounce, { EAGAIN: "E again" });

    const bad = await s.api("PUT", "/api/settings", { ...g.body, renderQuality: "4k", defaults: { ...g.body.defaults, minutes: 99 } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.some((e: string) => e.startsWith("renderQuality")));
    assert.ok(bad.body.errors.some((e: string) => e.startsWith("defaults.minutes")));
    const rel = await s.api("PUT", "/api/settings", { ...g.body, libraryRoot: "relative/path" });
    assert.equal(rel.status, 422);
    assert.equal(readdirSync(s.tmp).filter((f) => f.endsWith(".tmp")).length, 0);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("settings: changing libraryRoot swaps the library and its jobs file", async () => {
  const s = await startTestServer();
  try {
    const g = await s.api("GET", "/api/settings");
    const newRoot = join(s.tmp, "other-lib");
    const p = await s.api("PUT", "/api/settings", { ...g.body, libraryRoot: newRoot });
    assert.equal(p.status, 200);
    assert.equal(s.world.libraryOptions.at(-1)!.root, newRoot);
    assert.equal((await s.api("GET", "/api/health")).body.libraryRoot, newRoot);
    assert.equal(s.app.runner.file, join(newRoot, ".emoton", "jobs.json"));
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("folders: create, rename, delete, and 422 on a missing name", async () => {
  const s = await startTestServer();
  try {
    const c = await s.api("POST", "/api/folders", { parent: "", name: "Docs" });
    assert.equal(c.status, 201);
    assert.deepEqual(c.body, { path: "Docs" });
    const dup = await s.api("POST", "/api/folders", { parent: "", name: "Docs" });
    assert.equal(dup.status, 409);
    const bad = await s.api("POST", "/api/folders", { parent: "" });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.errors, ["name: required"]);
    const r = await s.api("PATCH", "/api/folders", { path: "Docs", name: "Talks" });
    assert.deepEqual(r.body, { path: "Talks" });
    const tree = await s.api("GET", "/api/library");
    assert.deepEqual(tree.body.tree.folders.map((f: any) => f.path), ["Talks"]);
    const del = await s.api("DELETE", "/api/folders?path=Talks");
    assert.equal(del.status, 200);
    assert.equal((await s.api("DELETE", "/api/folders?path=Talks")).status, 404);
    assert.equal((await s.api("DELETE", "/api/folders")).status, 422);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("videos: detail, brief, outline and chapter saves (422 passthrough), move, duplicate, preview, delete", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  s.world.folders.add("Docs");
  try {
    const d = await s.api("GET", "/api/videos/v1");
    assert.equal(d.status, 200);
    assert.equal(d.body.summary.id, "v1");
    assert.equal((await s.api("GET", "/api/videos/nope")).status, 404);

    const b = await s.api("PATCH", "/api/videos/v1/brief", { minutes: 7 });
    assert.equal(b.body.brief.minutes, 7);

    const o = await s.api("PUT", "/api/videos/v1/outline", { title: "x" });
    assert.equal(o.status, 422);
    assert.deepEqual(o.body, { errors: ["chapters: required"] });
    assert.equal((await s.api("PUT", "/api/videos/v1/outline", { chapters: [] })).status, 200);

    assert.equal((await s.api("PUT", "/api/videos/v1/chapters/1", { beats: [] })).status, 200);
    assert.equal((await s.api("PUT", "/api/videos/v1/chapters/1", {})).status, 422);
    assert.equal((await s.api("PUT", "/api/videos/v1/chapters/0", { beats: [] })).status, 400);
    assert.equal((await s.api("PUT", "/api/videos/v1/chapters/9", { beats: [] })).status, 404);

    const voice = await s.api("GET", "/api/videos/v1/voice");
    assert.equal(voice.status, 200);
    assert.deepEqual(voice.body.chapters, []);
    const edits = { version: 1, sentences: { "one two.": { after: 200 } } };
    const ve = await s.api("PUT", "/api/videos/v1/voice/1", edits);
    assert.equal(ve.status, 200);
    assert.deepEqual(ve.body.edits, edits);
    assert.deepEqual(s.world.voiceEdits, [{ id: "v1", n: 1, edits }]);
    assert.equal((await s.api("PUT", "/api/videos/v1/voice/1", {})).status, 422);
    assert.equal((await s.api("PUT", "/api/videos/v1/voice/0", edits)).status, 400);

    const pdf = await fetch(`${s.url}/api/videos/v1/slides.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-disposition") ?? "", /attachment; filename\*=UTF-8''Video%20v1%20\(slides\)\.pdf/);
    assert.equal(await pdf.text(), "%PDF-1.7 fake");
    assert.deepEqual(s.world.slidesPdfCalls, ["v1"]);

    const m = await s.api("POST", "/api/videos/v1/move", { folder: "Docs" });
    assert.equal(m.body.summary.folder, "Docs");
    assert.equal((await s.api("POST", "/api/videos/v1/move", {})).status, 422);

    const dup = await s.api("POST", "/api/videos/v1/duplicate");
    assert.equal(dup.status, 201);
    assert.notEqual(dup.body.summary.id, "v1");

    const pv = await s.api("GET", "/api/videos/v1/preview/2");
    assert.deepEqual(pv.body, { chapter: 2, timing: { audio: "" } });

    const rs = await s.api("DELETE", "/api/videos/v1/sources/m1");
    assert.equal(rs.status, 200);
    assert.equal((await s.api("DELETE", "/api/videos/v1/sources/zz")).status, 404);

    assert.equal((await s.api("DELETE", "/api/videos/v1")).status, 200);
    assert.equal((await s.api("GET", "/api/videos/v1")).status, 404);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("POST /api/videos: JSON draft creates without a job; bad body is 422", async () => {
  const s = await startTestServer();
  try {
    const bad = await s.api("POST", "/api/videos", { folder: "", brief: {}, mode: "later" });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.includes("brief.topic: required"));
    assert.ok(bad.body.errors.some((e: string) => e.startsWith("mode")));
    const rel = await s.api("POST", "/api/videos", { folder: "", brief: { topic: "x" }, mode: "draft", sourcePaths: ["rel.pdf"] });
    assert.equal(rel.status, 422);

    const r = await s.api("POST", "/api/videos", { folder: "", brief: { topic: "event loops" }, sourcePaths: ["/abs/a.pdf"], mode: "draft" });
    assert.equal(r.status, 201);
    assert.equal(r.body.summary.status, "partial");
    assert.equal(s.world.createCalls.length, 1);
    assert.equal(s.world.createCalls[0]!.uploads, undefined);
    assert.deepEqual(s.world.createCalls[0]!.req.sourcePaths, ["/abs/a.pdf"]);
    assert.deepEqual((await s.api("GET", "/api/jobs")).body, []);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("POST /api/videos multipart: uploads reach the library as Upload[] and temp files are deleted", async () => {
  const s = await startTestServer();
  try {
    const fd = new FormData();
    fd.append("request", JSON.stringify({ folder: "", brief: { topic: "sockets" }, mode: "draft" }));
    fd.append("files", new Blob(["hello pdf"]), "Design spec.pdf");
    fd.append("files", new Blob(["notes"]), "notes.txt");
    fd.append("files", new Blob(["again"]), "notes.txt");
    const r = await s.api("POST", "/api/videos", fd);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const call = s.world.createCalls[0]!;
    assert.deepEqual(call.uploads!.map((u) => [u.name, u.content]), [
      ["Design spec.pdf", "hello pdf"],
      ["notes.txt", "notes"],
      ["notes (2).txt", "again"],
    ]);
    for (const u of call.uploads!) assert.equal(existsSync(u.tmpPath), false, `${u.tmpPath} was not deleted`);
    assert.deepEqual(readdirSync(join(s.tmp, "uploads")), []);

    const noReq = new FormData();
    noReq.append("files", new Blob(["x"]), "a.txt");
    const bad = await s.api("POST", "/api/videos", noReq);
    assert.equal(bad.status, 400);
    assert.deepEqual(readdirSync(join(s.tmp, "uploads")), []);

    const add = new FormData();
    add.append("request", JSON.stringify({}));
    add.append("files", new Blob(["more"]), "more.txt");
    const a = await s.api("POST", `/api/videos/${r.body.summary.id}/sources`, add);
    assert.equal(a.status, 200);
    assert.deepEqual(s.world.addSourceCalls[0]!.uploads!.map((u) => u.content), ["more"]);
    const empty = await s.api("POST", `/api/videos/${r.body.summary.id}/sources`, {});
    assert.equal(empty.status, 422);
    assert.deepEqual(readdirSync(join(s.tmp, "uploads")), []);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("media: whole file, Range 206 with exact bytes, 416, and no path escape", async () => {
  const s = await startTestServer();
  const v = s.world.addVideo("v1");
  const dir = s.world.bundleDir(v);
  mkdirSync(join(dir, "out"), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  writeFileSync(join(dir, "out", "v1.mp4"), bytes);
  writeFileSync(join(s.tmp, "library", "secret.txt"), "secret");
  try {
    const whole = await fetch(`${s.url}/media/v1/out/v1.mp4`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "video/mp4");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);

    const part = await fetch(`${s.url}/media/v1/out/v1.mp4`, { headers: { Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100-199/1000");
    assert.equal(part.headers.get("content-length"), "100");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

    const tail = await fetch(`${s.url}/media/v1/out/v1.mp4`, { headers: { Range: "bytes=-10" } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(990));

    const open = await fetch(`${s.url}/media/v1/out/v1.mp4`, { headers: { Range: "bytes=995-" } });
    assert.equal(open.headers.get("content-range"), "bytes 995-999/1000");
    await open.arrayBuffer();

    // malformed or reversed ranges are ignored (RFC 9110): the whole file, 200
    for (const range of ["bytes=abc", "bytes=5-2", "bytes=", "items=0-1", "bytes=0-1,5-9"]) {
      const r = await fetch(`${s.url}/media/v1/out/v1.mp4`, { headers: { Range: range } });
      assert.equal(r.status, 200, range);
      assert.equal((await r.arrayBuffer()).byteLength, 1000, range);
    }
    const bad = await fetch(`${s.url}/media/v1/out/v1.mp4`, { headers: { Range: "bytes=5000-6000" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */1000");
    await bad.arrayBuffer();

    for (const p of ["/media/v1/..%2F..%2Fsecret.txt", "/media/v1/../secret.txt", "/media/v1/%2e%2e/%2e%2e/secret.txt", "/media/v1/out/missing.mp4", "/media/nope/out/v1.mp4", "/media/v1"]) {
      const r = await fetch(s.url + p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(await r.text(), /secret/);
    }
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("static UI: files, SPA fallback, 404 for a missing asset, and the not-built page", async () => {
  const s = await startTestServer();
  try {
    const nb = await fetch(`${s.url}/`);
    assert.equal(nb.status, 200);
    assert.match(await nb.text(), /UI not built: run <code>npm run ui:build<\/code>/);

    mkdirSync(join(s.tmp, "ui", "assets"), { recursive: true });
    writeFileSync(join(s.tmp, "ui", "index.html"), "<html>app</html>");
    writeFileSync(join(s.tmp, "ui", "assets", "a.js"), "console.log(1)");
    const idx = await fetch(`${s.url}/`);
    assert.equal(await idx.text(), "<html>app</html>");
    const route = await fetch(`${s.url}/videos/abc`);
    assert.equal(route.status, 200);
    assert.equal(await route.text(), "<html>app</html>");
    const js = await fetch(`${s.url}/assets/a.js`);
    assert.match(js.headers.get("content-type")!, /javascript/);
    await js.text();
    const miss = await fetch(`${s.url}/assets/missing.js`);
    assert.equal(miss.status, 404);
    await miss.text();
    const esc = await fetch(`${s.url}/..%2Fsettings.json`);
    assert.doesNotMatch(await esc.text(), /libraryRoot/);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("fs/list: lists inside home, refuses outside home", async () => {
  const s = await startTestServer();
  mkdirSync(join(s.tmp, "Exports"), { recursive: true });
  writeFileSync(join(s.tmp, ".hidden"), "");
  try {
    const r = await s.api("GET", "/api/fs/list");
    assert.equal(r.status, 200);
    const names = r.body.entries.map((e: any) => e.name);
    assert.ok(names.includes("Exports"));
    assert.ok(!names.includes(".hidden"));
    assert.equal(r.body.entries.find((e: any) => e.name === "Exports").dir, true);
    assert.equal(r.body.entries.find((e: any) => e.name === "settings.json").dir, false);
    const sub = await s.api("GET", `/api/fs/list?dir=${encodeURIComponent(join(s.tmp, "Exports"))}`);
    assert.deepEqual(sub.body.entries, []);
    assert.equal((await s.api("GET", "/api/fs/list?dir=/etc")).status, 403);
    assert.equal((await s.api("GET", `/api/fs/list?dir=${encodeURIComponent(join(s.tmp, ".."))}`)).status, 403);
    assert.equal((await s.api("GET", `/api/fs/list?dir=${encodeURIComponent(join(s.tmp, "nope"))}`)).status, 404);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("cross-site requests are refused", async () => {
  const s = await startTestServer();
  try {
    const r = await s.api("POST", "/api/folders", { parent: "", name: "X" }, { Origin: "https://evil.example" });
    assert.equal(r.status, 403);
    const ok = await s.api("POST", "/api/folders", { parent: "", name: "X" }, { Origin: "http://localhost:5173" });
    assert.equal(ok.status, 201);
    const tauri = await s.api("POST", "/api/folders", { parent: "", name: "Y" }, { Origin: "tauri://localhost" });
    assert.equal(tauri.status, 201);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("library tree carries overlayed summaries", async () => {
  const s = await startTestServer();
  s.world.addVideo("v1");
  try {
    const t = await s.api("GET", "/api/library");
    assert.equal(t.status, 200);
    assert.equal(t.body.videos.length, 1);
    assert.equal(t.body.videos[0].status, "partial");
    await waitFor(() => true);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("upload write error answers 5xx, cleans up, and the server keeps serving", async () => {
  const s = await startTestServer({
    server: {
      uploads: {
        openFile: () =>
          new Writable({
            write(_c, _e, cb) {
              cb(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
            },
          }),
      },
    },
  });
  try {
    const fd = new FormData();
    fd.append("request", JSON.stringify({ folder: "", brief: { topic: "x" }, mode: "draft" }));
    fd.append("files", new Blob(["data"]), "a.pdf");
    const r = await s.api("POST", "/api/videos", fd);
    assert.equal(r.status, 507);
    assert.match(r.body.error, /disk space/);
    assert.equal(s.world.createCalls.length, 0);
    assert.deepEqual(readdirSync(join(s.tmp, "uploads")), []);
    assert.equal((await s.api("GET", "/api/health")).status, 200);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("upload: non-ASCII file names arrive intact; size and count limits answer 413", async () => {
  const s = await startTestServer({ server: { uploads: { fileSize: 10, files: 2 } } });
  try {
    const req = JSON.stringify({ folder: "", brief: { topic: "x" }, mode: "draft" });
    const fd = new FormData();
    fd.append("request", req);
    fd.append("files", new Blob(["small"]), "Curs Ștefan Übung.pdf");
    const r = await s.api("POST", "/api/videos", fd);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(s.world.createCalls[0]!.uploads![0]!.name, "Curs Ștefan Übung.pdf");

    const big = new FormData();
    big.append("request", req);
    big.append("files", new Blob(["x".repeat(100)]), "big.pdf");
    const b = await s.api("POST", "/api/videos", big);
    assert.equal(b.status, 413);
    assert.match(b.body.error, /big\.pdf is larger than/);

    const many = new FormData();
    many.append("request", req);
    for (const n of ["a", "b", "c"]) many.append("files", new Blob([n]), `${n}.txt`);
    const m = await s.api("POST", "/api/videos", many);
    assert.equal(m.status, 413);
    assert.match(m.body.error, /too many files/);
    assert.equal(s.world.createCalls.length, 1);
    assert.deepEqual(readdirSync(join(s.tmp, "uploads")), []);
    assert.equal((await s.api("GET", "/api/health")).status, 200);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("settings file: invalid fields fall back one by one (libraryRoot kept), the original is kept aside", async () => {
  const t = makeTmp();
  const keptRoot = join(t.tmp, "my-library");
  writeFileSync(t.settingsPath, JSON.stringify({ libraryRoot: keptRoot, renderQuality: "4k", defaults: { minutes: 99, audience: "Me", voice: { voice: "bf_emma" } } }));
  let s = await startTestServer({ tmp: t });
  try {
    const g = (await s.api("GET", "/api/settings")).body;
    assert.equal(g.libraryRoot, keptRoot);
    assert.equal(g.renderQuality, "1080p");
    assert.equal(g.defaults.minutes, 5);
    assert.equal(g.defaults.audience, "Me");
    assert.deepEqual(g.defaults.voice, { engine: "kokoro", voice: "bf_emma", speed: 1 });
    const asides = readdirSync(t.tmp).filter((f) => f.startsWith("settings.json.corrupt-"));
    assert.equal(asides.length, 1);
    assert.equal(JSON.parse(readFileSync(join(t.tmp, asides[0]!), "utf8")).renderQuality, "4k");
    await s.close();

    cleanup(join(t.tmp, asides[0]!));
    writeFileSync(t.settingsPath, "{ not json");
    s = await startTestServer({ tmp: t });
    assert.equal((await s.api("GET", "/api/settings")).body.renderQuality, "1080p");
    const moved = readdirSync(t.tmp).filter((f) => f.startsWith("settings.json.corrupt-"));
    assert.equal(moved.length, 1);
    assert.equal(readFileSync(join(t.tmp, moved[0]!), "utf8"), "{ not json");
  } finally {
    await s.close();
    cleanup(t.tmp);
  }
});

test("Host check: a request for a foreign host name is refused", async () => {
  const s = await startTestServer();
  try {
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(s.url);
        const req = http.request({ host: u.hostname, port: u.port, path: "/api/health", headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal(await status("evil.example:8891"), 403);
    assert.equal(await status(`localhost:${new URL(s.url).port}`), 200);
    assert.equal(await status("127.0.0.1"), 200);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});

test("a library error's numeric status wins over the message heuristics; 422 carries errors", async () => {
  const s = await startTestServer();
  try {
    const orig = s.world.folders;
    s.world.folders = new Proxy(orig, {
      get(target, prop) {
        if (prop === "has") return (p: string) => {
          if (p === "teapot") throw Object.assign(new Error("unknown name for a folder"), { status: 422 });
          if (p === "locked") throw Object.assign(new Error("invalid lock"), { status: 409 });
          return target.has(p);
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const a = await s.api("POST", "/api/folders", { parent: "teapot", name: "x" });
    assert.equal(a.status, 422);
    assert.deepEqual(a.body.errors, ["unknown name for a folder"]);
    const b = await s.api("POST", "/api/folders", { parent: "locked", name: "x" });
    assert.equal(b.status, 409);
  } finally {
    await s.close();
    cleanup(s.tmp);
  }
});
