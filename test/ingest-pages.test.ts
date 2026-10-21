import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPages } from "../pipeline/ingest.ts";

test("OCR page markers become per-page chunks with the page number", () => {
  const text = "==== p-01.png\nContinuous random variables\nintro\n==== p-02.png\nshort\n==== p-12.png\nThe normal distribution N(mu, sigma^2) has density ...\n";
  const c = splitPages("ch4", text)!;
  assert.deepEqual(c.map((x) => x.id), ["ch4:p1", "ch4:p12"]);
  assert.match(c[1]!.text, /normal distribution/);
});

test("form feeds split pages too; plain text has no page structure", () => {
  assert.deepEqual(splitPages("a", "page one text here, long enough\fpage two text here, long enough\fpage three text, long enough")!.map((x) => x.id), ["a:p1", "a:p2", "a:p3"]);
  assert.equal(splitPages("b", "just a paragraph\n\nand another"), null);
});

test("the real chapter 4 OCR text yields page chunks", { skip: !process.env.HOME }, async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const p = `${process.env.HOME}/vault/Learning/statistical-methods/_source/chapter4_continuous_rv_handout.txt`;
  if (!existsSync(p)) return;
  const c = splitPages("ch4", readFileSync(p, "utf8"))!;
  assert.ok(c.length >= 15, `${c.length} pages`);
  assert.ok(c.every((x) => /^ch4:p\d+$/.test(x.id)));
});
