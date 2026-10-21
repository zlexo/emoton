import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const get = (port: number, path: string) =>
  new Promise<{ status: number; headers: Record<string, unknown> }>((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { Host: `localhost:${port}` } }, (m) => {
      m.resume();
      res({ status: m.statusCode ?? 0, headers: m.headers });
    });
    r.on("error", rej);
    r.end();
  });

test("with EMOTON_PARENT_PIPE the server exits when its stdin closes, and /media sandboxes active files", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "emoton-life-"));
  try {
    const lib = join(tmp, "lib");
    const bundle = join(lib, "x.emoton");
    mkdirSync(join(bundle, "sources"), { recursive: true });
    writeFileSync(join(bundle, "project.json"), JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111", title: "x", topic: "t", audience: "a", minutes: 2, sources: [], rules: [],
      voice: { engine: "say", voice: "default", speed: 1 }, pronounce: {}, writerModel: "opus", captions: true,
      created: new Date(0).toISOString(), updated: new Date(0).toISOString(), titleAuto: false,
    }));
    writeFileSync(join(bundle, "evil.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    writeFileSync(join(bundle, "notes.txt"), "hello");
    writeFileSync(join(tmp, "settings.json"), JSON.stringify({ libraryRoot: lib }));
    const port = 18000 + Math.floor(Math.random() * 1500);
    const child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
      env: { ...process.env, EMOTON_PORT: String(port), EMOTON_SETTINGS: join(tmp, "settings.json"), EMOTON_PARENT_PIPE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    for (let i = 0; i < 400 && !out.includes("Emoton server on"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(out.includes("Emoton server on"), out);

    const svg = await get(port, "/media/11111111-1111-4111-8111-111111111111/evil.svg");
    assert.equal(svg.status, 200);
    assert.equal(svg.headers["content-security-policy"], "sandbox");
    const txt = await get(port, "/media/11111111-1111-4111-8111-111111111111/notes.txt");
    assert.equal(txt.status, 200);
    assert.equal(txt.headers["content-security-policy"], undefined);

    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running"), 20000))]);
    if (code === "still running") child.kill("SIGKILL");
    assert.equal(code, 0);
    assert.ok(out.includes("parent app gone"), out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
