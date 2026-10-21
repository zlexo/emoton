import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CEILING_DBTP, TARGET_LUFS, VOICE_LUFS, levelVoice, master, measure } from "../pipeline/loudness.ts";
import { readWav, writeWav } from "../pipeline/wav.ts";

// real ffmpeg: skipped where it is not installed (CI)
const noFfmpeg = spawnSync("ffmpeg", ["-version"]).status !== 0;
const SR = 24000;

/** Forty seconds of "speech" (loudnorm needs a chapter's length to settle): tone bursts with gaps, quiet, one loud peak. */
const WORDS = 70;
function voice(): Float32Array {
  const a = new Float32Array(SR * 40);
  for (let w = 0; w < WORDS; w++) {
    const s = Math.round((0.3 + w * 0.55) * SR), e = s + Math.round(0.35 * SR);
    for (let i = s; i < e; i++) a[i] = Math.sin(i * 0.11) * Math.sin(i * 0.003) * (w % 7 === 4 ? 0.5 : 0.12);
  }
  return a;
}

test("a voice is levelled to the voice loudness, its length and timing unchanged", { skip: noFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "emoton-loud-"));
  try {
    const f = join(dir, "v.wav");
    const before = voice();
    writeWav(f, { sr: SR, audio: before });
    await levelVoice(f, SR);
    const after = readWav(f);
    assert.equal(after.sr, SR);
    assert.equal(after.audio.length, before.length);
    const m = await measure(["-i", f, "-af", "ebur128=peak=true"]);
    assert.ok(Math.abs(m.I - VOICE_LUFS) <= 1.5, `${m.I} LUFS`);
    // the bursts start where they did: silence before each stays silence
    for (let w = 0; w < WORDS; w++) {
      const s = Math.round((0.3 + w * 0.55) * SR);
      assert.ok(Math.abs(after.audio[s - 200]!) < 1e-3, `burst ${w} moved`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the master brings a video to the target loudness under the ceiling, picture and chapters copied", { skip: noFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "emoton-master-"));
  try {
    const wav = join(dir, "a.wav"), meta = join(dir, "m.txt"), mp4 = join(dir, "in.mp4"), out = join(dir, "out.mp4");
    writeWav(wav, { sr: SR, audio: voice() });
    require_ok(spawnSync("sh", ["-c", `printf ';FFMETADATA1\\n\\n[CHAPTER]\\nTIMEBASE=1/1000\\nSTART=0\\nEND=3000\\ntitle=One\\n\\n[CHAPTER]\\nTIMEBASE=1/1000\\nSTART=3000\\nEND=40000\\ntitle=Two\\n' > '${meta}'`]));
    require_ok(spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=40", "-i", wav, "-i", meta, "-map", "0:v", "-map", "1:a", "-map_chapters", "2", "-c:v", "libx264", "-c:a", "aac", "-shortest", mp4]));
    const r = await master(mp4, out);
    const m = await measure(["-i", out, "-af", "ebur128=peak=true"]);
    assert.ok(Math.abs(m.I - TARGET_LUFS) <= 0.5, `${m.I} LUFS`);
    assert.ok(m.peak <= CEILING_DBTP, `${m.peak} dBTP`);
    assert.equal(r.I, m.I);
    const probe = (f: string) => spawnSync("ffprobe", ["-v", "error", "-show_chapters", "-show_entries", "stream=codec_name,nb_frames", "-of", "json", f], { encoding: "utf8" }).stdout;
    const a = JSON.parse(probe(mp4)), b = JSON.parse(probe(out));
    assert.deepEqual(b.streams[0], a.streams[0], "the picture is copied");
    assert.deepEqual(b.chapters.map((c: any) => c.tags.title), ["One", "Two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function require_ok(r: ReturnType<typeof spawnSync>) {
  if (r.status !== 0) throw new Error(String(r.stderr));
}
