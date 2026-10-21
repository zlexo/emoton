import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { Chapter, crossCheck } from "../schema/storyboard.ts";
import { z } from "zod/v4";

test("crossCheck catches a dangling edge and an unknown step id", () => {
  const ch = Chapter.parse({
    title: "t",
    beats: [
      {
        say: ["x."],
        visual: {
          type: "diagram",
          nodes: [{ id: "a", label: "A" }],
          edges: [{ id: "e", from: "a", to: "ghost" }],
          steps: [{ show: ["nope"] }],
        },
      },
      { say: ["y."], visual: { type: "title", title: "T" } },
    ],
  });
  const errs = crossCheck(ch);
  assert.ok(errs.some((e) => e.includes("ghost")));
  assert.ok(errs.some((e) => e.includes("nope")));
});

test("the schema exports as JSON Schema for the writer", () => {
  const js = z.toJSONSchema(Chapter) as { type: string };
  assert.equal(js.type, "object");
});

test("every committed storyboard passes schema and cross-checks", () => {
  const dirs = readdirSync("test/fixtures").filter((d) => existsSync(`test/fixtures/${d}/storyboard.json`));
  assert.ok(dirs.length > 0, "no fixture storyboards found");
  for (const slug of dirs) {
    const p = `test/fixtures/${slug}/storyboard.json`;
    const sb = JSON.parse(readFileSync(p, "utf8")) as { chapters: unknown[] };
    sb.chapters.forEach((c, i) => {
      const ch = Chapter.parse(c);
      assert.deepEqual(crossCheck(ch), [], `${slug} chapter ${i + 1}`);
    });
  }
});

import { writerSchema } from "../schema/storyboard.ts";
test("writer schema has no size limits and no oneOf", () => {
  const s = JSON.stringify(writerSchema(Chapter));
  for (const k of ["maxLength", "minItems", "maxItems", "oneOf", "prefixItems"]) assert.ok(!s.includes(`"${k}"`), k);
  assert.ok(s.includes('"anyOf"') || s.includes('"type":"object"'));
});
