import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryPattern, readSafetyList, scan } from "../pipeline/safety.ts";
import { temp } from "./fixtures/helpers.ts";

test("safety list entries: plain text matches anywhere in any case, /regex/ is a regex", () => {
  assert.ok(entryPattern("Planted-Handle").test("by planted-handle, 2026"));
  assert.ok(!entryPattern("a.b").test("axb"), "plain text is literal");
  assert.ok(entryPattern("/\\bCS101\\b/").test("the CS101 notes"));
  assert.ok(!entryPattern("/\\bCS101\\b/").test("CS1010"));
  const g = entryPattern("/x/g");
  assert.ok(g.test("x") && g.test("x"), "no lastIndex carried from one line to the next");
});

test("the safety list: none without a file, a broken one throws instead of passing as empty", () => {
  const t = temp();
  try {
    assert.equal(readSafetyList(join(t.base, "missing.json")), null);
    const f = join(t.base, "list.json");
    writeFileSync(f, JSON.stringify({ identity: ["someone"] }));
    assert.deepEqual(readSafetyList(f), { identity: ["someone"], markers: [] });
    writeFileSync(f, JSON.stringify({ identity: "someone" }));
    assert.throws(() => readSafetyList(f), /"identity" must be a list of non-empty strings/);
    writeFileSync(f, JSON.stringify({ identity: [], markers: ["/(unclosed/"] }));
    assert.throws(() => readSafetyList(f), /Invalid regular expression/);
    writeFileSync(f, "{ not json");
    assert.throws(() => readSafetyList(f), SyntaxError);
  } finally {
    t.done();
  }
});

test("scan: the list's names on top of the generic rules", () => {
  const list = { identity: ["planted-handle"], markers: [] };
  assert.deepEqual(scan("A.java", 'int x = 1;\nString by = "Planted-Handle";\n', list).map((h) => [h.line, h.rule]), [[2, "private name"]]);
  assert.deepEqual(scan("A.java", 'String by = "Planted-Handle";\n', null), [], "no list, no names");
  assert.deepEqual(scan("A.java", 'String p = "/home/someone";\n', null).map((h) => h.rule), ["home path"]);
});
