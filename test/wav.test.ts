import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWav, writeWav } from "../pipeline/wav.ts";

test("a WAV written and read back keeps its rate and samples to 16-bit precision", () => {
  const dir = mkdtempSync(join(tmpdir(), "emoton-wav-"));
  try {
    const audio = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 10) * 0.8);
    writeWav(join(dir, "a.wav"), { sr: 24000, audio });
    const r = readWav(join(dir, "a.wav"));
    assert.equal(r.sr, 24000);
    assert.equal(r.audio.length, audio.length);
    for (let i = 0; i < audio.length; i++) assert.ok(Math.abs(r.audio[i]! - audio[i]!) < 1 / 16000, `sample ${i}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("16-bit samples read and written back are the same samples", () => {
  const dir = mkdtempSync(join(tmpdir(), "emoton-wav-"));
  try {
    const audio = Float32Array.from([-32768, -1, 0, 1, 12345, 32767], (v) => v / 32768);
    writeWav(join(dir, "a.wav"), { sr: 24000, audio });
    writeWav(join(dir, "b.wav"), readWav(join(dir, "a.wav")));
    assert.deepEqual(readFileSync(join(dir, "b.wav")), readFileSync(join(dir, "a.wav")));
    assert.deepEqual(Array.from(readWav(join(dir, "b.wav")).audio, (v) => v * 32768), [-32768, -1, 0, 1, 12345, 32767]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("32-bit float stereo is mixed down, chunks before data are skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "emoton-wav-"));
  try {
    const frames = [[0.5, -0.5], [0.25, 0.75]];
    const data = Buffer.alloc(frames.length * 8);
    frames.forEach(([l, r], i) => (data.writeFloatLE(l!, i * 8), data.writeFloatLE(r!, i * 8 + 4)));
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "ascii"); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(3, 8); fmt.writeUInt16LE(2, 10);
    fmt.writeUInt32LE(24000, 12); fmt.writeUInt32LE(24000 * 8, 16); fmt.writeUInt16LE(8, 20); fmt.writeUInt16LE(32, 22);
    const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc"), Buffer.from([0])]);
    const dataHead = Buffer.alloc(8); dataHead.write("data", 0, "ascii"); dataHead.writeUInt32LE(data.length, 4);
    const body = Buffer.concat([Buffer.from("WAVE"), fmt, list, dataHead, data]);
    const riff = Buffer.alloc(8); riff.write("RIFF", 0, "ascii"); riff.writeUInt32LE(body.length, 4);
    writeFileSync(join(dir, "f.wav"), Buffer.concat([riff, body]));
    const r = readWav(join(dir, "f.wav"));
    assert.deepEqual(Array.from(r.audio), [0, 0.5]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
