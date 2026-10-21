import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportPublic } from "../scripts/export-public.ts";
import { temp } from "./fixtures/helpers.ts";

// The planted strings are put together at run time, so this file never holds them and exporting the repo does not trip on it.
const HANDLE = ["planted", "handle", "7"].join("-");
const TOKEN = ["gh", "p_", "Z".repeat(30)].join("");
const HOME = ["", "Users", "plantedperson", "notes.txt"].join("/");

/** A git repo under base with these files committed (exec: paths committed as executable). */
function repo(base: string, files: Record<string, string | Buffer>, exec: string[] = []): string {
  const r = join(base, "repo");
  mkdirSync(r, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  g("init", "-q", "-b", "main");
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(dirname(join(r, p)), { recursive: true });
    writeFileSync(join(r, p), data);
  }
  g("add", "-A");
  for (const p of exec) g("update-index", "--chmod=+x", p);
  g("commit", "-q", "-m", "files");
  return r;
}

function list(base: string, l: object = { identity: [HANDLE.toUpperCase()], markers: ["/\\bCS101\\b/"] }): string {
  const f = join(base, "list.json");
  writeFileSync(f, JSON.stringify(l));
  return f;
}

test("export: the committed tree minus the denylist, file modes kept, nothing untracked", () => {
  const t = temp();
  try {
    const r = repo(t.base, {
      "README.md": "# hello\n", "src/a.ts": "export const a = 1;\n", "run.sh": "#!/bin/sh\necho hi\n",
      "deck.json": "{}\n", "design/app-mockup/shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), "docs/APP.md": "# contract\n",
    }, ["run.sh"]);
    writeFileSync(join(r, "README.md"), "# edited, not committed\n");
    writeFileSync(join(r, "notes.txt"), "untracked\n");
    const out = join(t.base, "out");
    const res = exportPublic({ repo: r, target: out, list: list(t.base) });
    assert.equal(res.code, 0, res.message);
    assert.deepEqual(res.files.sort(), ["README.md", "run.sh", "src/a.ts"]);
    assert.deepEqual(readdirSync(out).sort(), ["README.md", "run.sh", "src"]);
    assert.equal(readFileSync(join(out, "README.md"), "utf8"), "# hello\n", "the commit, not the working tree");
    assert.ok(statSync(join(out, "run.sh")).mode & 0o100, "the exec bit survives");
  } finally {
    t.done();
  }
});

test("export refuses a planted name, marker, home path and token, in text, paths and binaries, and writes nothing", () => {
  const t = temp();
  try {
    const r = repo(t.base, {
      "README.md": "# fine\n",
      "src/credits.ts": `export const by = "${HANDLE}";\n`,
      "docs/notes.md": "Taken from the CS101 slides.\n",
      "notes/CS101-week1.md": "harmless text, telling path\n",
      "src/paths.ts": `const p = "${HOME}";\n`,
      "src/key.ts": `const k = "${TOKEN}";\n`,
      "assets/logo.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(`tEXtAuthor\0${HANDLE}`, "latin1")]),
    });
    const out = join(t.base, "out");
    const res = exportPublic({ repo: r, target: out, list: list(t.base) });
    assert.equal(res.code, 1, res.message);
    assert.deepEqual(res.hits.map((h) => `${h.file}:${h.line} ${h.rule}`).sort(), [
      "assets/logo.png:0 private name",
      "docs/notes.md:1 marker",
      "notes/CS101-week1.md:0 marker in the path",
      "src/credits.ts:1 private name",
      "src/key.ts:1 GitHub token",
      "src/paths.ts:1 home path",
    ]);
    assert.ok(!existsSync(out), "a refused export writes nothing");
  } finally {
    t.done();
  }
});

test("export will not run without a list, with an empty one, or into a folder that is not empty", () => {
  const t = temp();
  try {
    const r = repo(t.base, { "README.md": "# fine\n" });
    const out = join(t.base, "out");
    assert.equal(exportPublic({ repo: r, target: out, list: join(t.base, "missing.json") }).code, 2);
    assert.equal(exportPublic({ repo: r, target: out, list: list(t.base, { identity: [], markers: [] }) }).code, 2);
    mkdirSync(out);
    writeFileSync(join(out, "old.txt"), "x");
    assert.equal(exportPublic({ repo: r, target: out, list: list(t.base) }).code, 2);
  } finally {
    t.done();
  }
});

test("the export command exits 1 on a planted name and 0 once it is gone", () => {
  const t = temp();
  try {
    const r = repo(t.base, { "src/credits.ts": `export const by = "${HANDLE}";\n` });
    const run = (out: string) => spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "export-public.ts"), out, "--repo", r, "--list", list(t.base)], { encoding: "utf8" });
    const refused = run(join(t.base, "out1"));
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /src\/credits\.ts:1 {2}private name/);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "rm", "-q", "src/credits.ts"]);
    writeFileSync(join(r, "README.md"), "# fine\n");
    execFileSync("git", ["-C", r, "add", "README.md"]);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "clean"]);
    const ok = run(join(t.base, "out2"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /exported 1 files/);
  } finally {
    t.done();
  }
});
