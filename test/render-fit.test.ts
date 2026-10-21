import { test } from "node:test";
import assert from "node:assert/strict";
import { fitScale, SAFE } from "../src/remotion/visuals/FitStage.tsx";
import { citeLabel, shortSource } from "../src/core/cite.ts";

test("content that fits keeps its size; taller or wider content scales down to the safe area", () => {
  const availH = 1080 - SAFE.top - SAFE.bottom;
  const availW = 1920 - 2 * SAFE.side;
  assert.equal(fitScale(800, 400), 1);
  assert.equal(fitScale(800, availH * 2), 0.5);
  assert.equal(fitScale(availW * 4, 100), 0.25);
  assert.ok(SAFE.top >= 110, "clears the citation chip");
  assert.ok(SAFE.bottom >= 200, "clears the captions");
});

test("citation names: URLs become hosts, file names lose underscores", () => {
  assert.equal(shortSource("https://www.probabilitycourse.com/chapter8/8_4_5_likelihood_ratio_tests.php"), "probabilitycourse.com");
  assert.equal(shortSource("week4_reading_notes"), "week4 reading notes");
  assert.equal(shortSource("Design notes"), "Design notes");
  assert.equal(shortSource("probabilitycourse.com/chapter8/8_4_5_likelihood_ratio_tests.php"), "probabilitycourse.com");
});

test("cite labels read as pages or parts", () => {
  assert.equal(citeLabel("notes:p6", { notes: "Notes" }), "Notes p.6");
  assert.equal(citeLabel("book:s2", { book: "https://example.org/x.php" }), "example.org part 2");
});
