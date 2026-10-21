import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importCodeTyperJob } from "../pipeline/import.ts";
import type { ShortPreview } from "../shared/api.ts";
import { ctx, lib, temp, type Temp } from "./fixtures/helpers.ts";
import { quietTts } from "./fixtures/quiet-tts.ts";

// real ffmpeg (the import makes proxies): skipped where it is not installed (CI)
const noFfmpeg = spawnSync("ffmpeg", ["-version"]).status !== 0;
/** A tiny real MP4: a colour for half a second. */
const mp4 = (file: string, color: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=108x192:r=30:d=0.5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
const FX = new URL("fixtures/codetyper/", import.meta.url);
const fx = (n: string) => JSON.parse(readFileSync(new URL(n, FX), "utf8"));

/** A Code Typer checkout as the importer finds it: jobs/, public/gen/ with shots and the TTS cache, montage clips. */
function codeTyper(t: Temp) {
  const ct = join(t.base, "code-typer");
  mkdirSync(join(ct, "jobs"), { recursive: true });
  mkdirSync(join(ct, "public", "gen", "tts-cache"), { recursive: true });
  cpSync(new URL("perdix-ep3.job.json", FX), join(ct, "jobs", "perdix-ep3.json"));
  writeFileSync(join(ct, "jobs", "perdix-ep3.voice.json"), JSON.stringify({ version: 1, sentences: { "perdix.": { after: 250 } } }));
  for (const [i, shot] of ["world", "born", "walk"].entries()) mp4(join(ct, "public", "gen", `perdix-ep3-${shot}.mp4`), ["red", "green", "blue"][i]!);
  writeFileSync(join(ct, "public", "gen", "tts-cache", "0123456789abcdef.wav"), "cached");
  cpSync(new URL("perdix-milestones.job.json", FX), join(ct, "jobs", "perdix-milestones.json"));
  const clips = new Set((fx("perdix-milestones.job.json").segs as { clip: string }[]).map((s) => s.clip));
  for (const c of clips) mp4(join(ct, "jobs", c), "gray");
  return ct;
}

test("importing a Code Typer devlog: shots, pause edits and TTS cache cloned in, proxies made, then voiced", { skip: noFfmpeg }, async () => {
  const t = temp();
  try {
    const ct = codeTyper(t);
    const L = lib(t, { tts: quietTts });
    await L.createFolder("", "Perdix devlogs");
    const c = ctx();
    const d = await importCodeTyperJob(L, join(ct, "jobs", "perdix-ep3.json"), { folder: "Perdix devlogs", build: "c0bece9", series: "perdix", ctx: c });
    assert.equal(d.summary.kind, "short");
    assert.equal(d.dir, join(t.root, "Perdix devlogs", "perdix-ep3.emoton"));
    for (const shot of ["world", "born", "walk"]) {
      assert.deepEqual(readFileSync(join(d.dir, "shots", `${shot}.mp4`)), readFileSync(join(ct, "public", "gen", `perdix-ep3-${shot}.mp4`)));
      assert.ok(existsSync(join(d.dir, "proxies", "shots", `${shot}.mp4`)), `a proxy of ${shot}`);
    }
    assert.ok(!existsSync(join(d.dir, "shots", "pov.mp4")));
    assert.ok(c.logs.some((l) => /no render of shot pov/.test(l)), c.logs.join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(join(d.dir, "voice-edits.json"), "utf8")), { version: 1, chapters: { "1": { "perdix.": { after: 250 } } } });
    assert.equal(readFileSync(join(d.dir, "audio", "cache", "0123456789abcdef.wav"), "utf8"), "cached");
    assert.ok(c.logs.some((l) => /1 pause edit\(s\) applied/.test(l)), "voiced, with the job's pause edit");
    assert.deepEqual(await L.plan(d.summary.id, "voice"), []);
    await assert.rejects(importCodeTyperJob(L, join(ct, "jobs", "perdix-ep3.json"), { folder: "", ctx: c }), /needs --build/);
  } finally {
    t.done();
  }
});

test("importing a Code Typer montage: its clips into assets with proxies, no voice", { skip: noFfmpeg }, async () => {
  const t = temp();
  try {
    const ct = codeTyper(t);
    const L = lib(t, { tts: quietTts });
    const d = await importCodeTyperJob(L, join(ct, "jobs", "perdix-milestones.json"), { folder: "", ctx: ctx() });
    assert.ok(existsSync(join(d.dir, "assets", "walk.mp4")) && existsSync(join(d.dir, "proxies", "assets", "walk.mp4")));
    const p = (await L.previewShort(d.summary.id)) as ShortPreview;
    assert.equal(p.props.short.scenes.length, 10);
    assert.equal(Object.keys(p.props.media.footage).length, 10, "every segment finds its clip");
    assert.ok(Object.values(p.props.media.footage).every((u) => u.includes("/proxies/assets/")), "the player gets the proxies");
    assert.equal(p.voiced, false);
  } finally {
    t.done();
  }
});
