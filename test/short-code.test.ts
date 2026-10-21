import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCode, sceneCode } from "../pipeline/short-code.ts";
import { Short } from "../schema/short.ts";
import { resolveShort } from "../src/core/short/resolve.ts";
import { temp } from "./fixtures/helpers.ts";

const doc = (path: string, extra: object = {}) => Short.parse({
  version: 1, title: "t", template: "speedrun", canvas: { w: 1080, h: 1920, fps: 60 },
  scenes: [{ id: "code", hold: 4, visual: { type: "code", files: [{ path, ...extra }], caption: "Typing fast" } }],
  text: [], captions: { style: { maxWords: 3, highlight: false }, overrides: [] }, fx: [], sfx: [], music: null,
});

test("a code scene's files: ranges joined by a blank line, cleaned, typed out over the scene's length", () => {
  const t = temp();
  try {
    const f = join(t.base, "Mod.java");
    writeFileSync(f, ["package a.b;", "import x.Y;", "", "public class Mod {", "    void a() {}", "    void b() {}", "    void c() {}", "}", ""].join("\n"));
    assert.equal(readCode({ path: f, lines: [[4, 5], [8, 8]] }, t.base).text, "public class Mod {\n  void a() {}\n\n}\n");
    const d = doc(f);
    const code = sceneCode(t.base, d, resolveShort(d));
    assert.equal(code.code!.tl.duration, 4);
    assert.equal(code.code!.caption, "Typing fast");
    assert.deepEqual(code.code!.tl.files.map((x) => x.name), ["Mod.java"]);
    assert.ok(code.code!.tl.keys.length > 5);
  } finally {
    t.done();
  }
});

test("the privacy scan refuses code that would show a home path or a key", () => {
  const t = temp();
  try {
    mkdirSync(join(t.base, "src"));
    const f = join(t.base, "src", "Leak.java");
    writeFileSync(f, 'class Leak { String p = "/Users/someone/secret"; }\n');
    const d = doc("src/Leak.java");
    assert.throws(() => sceneCode(t.base, d, resolveShort(d)), /privacy scan refused Leak\.java:1 \(home path\)/);
  } finally {
    t.done();
  }
});

/** Runs fn with EMOTON_SAFETY_FILE set to file, then puts it back. */
function withSafetyFile(file: string, fn: () => void) {
  const was = process.env.EMOTON_SAFETY_FILE;
  process.env.EMOTON_SAFETY_FILE = file;
  try {
    fn();
  } finally {
    if (was === undefined) delete process.env.EMOTON_SAFETY_FILE;
    else process.env.EMOTON_SAFETY_FILE = was;
  }
}

const CREDIT = 'class Credit { String by = "Planted-Handle-7"; }\n';

test("the privacy scan refuses a name from the local safety list", () => {
  const t = temp();
  try {
    mkdirSync(join(t.base, "src"));
    writeFileSync(join(t.base, "src", "Credit.java"), CREDIT);
    const list = join(t.base, "safety.json");
    writeFileSync(list, JSON.stringify({ identity: ["planted-handle-7"], markers: [] }));
    const d = doc("src/Credit.java");
    withSafetyFile(list, () => assert.throws(() => sceneCode(t.base, d, resolveShort(d)), /privacy scan refused Credit\.java:1 \(private name\)/));
  } finally {
    t.done();
  }
});

test("without the local list the same code passes: the name is in the list, not in the source", () => {
  const t = temp();
  try {
    mkdirSync(join(t.base, "src"));
    writeFileSync(join(t.base, "src", "Credit.java"), CREDIT);
    const d = doc("src/Credit.java");
    withSafetyFile(join(t.base, "no-list.json"), () => assert.deepEqual(sceneCode(t.base, d, resolveShort(d)).code!.tl.files.map((f) => f.name), ["Credit.java"]));
  } finally {
    t.done();
  }
});
