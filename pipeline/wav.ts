/**
 * Mono WAV in and out, no resampling: the voice step writes 16-bit PCM at
 * 24 kHz (tts/speak.py), and pause edits must give back the same format so the
 * renderer and the player see nothing new. Reads 16-bit PCM and 32-bit float;
 * more than one channel is mixed down.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export type Wav = { sr: number; audio: Float32Array };

export function readWav(file: string): Wav {
  const b = readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: not a WAV file`);
  let fmt: { format: number; channels: number; sr: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      let format = b.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID
      if (format === 0xfffe && size >= 26) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error(`${file}: data before fmt`);
      const end = Math.min(b.length, body + size);
      const { format, channels, sr, bits } = fmt;
      const frame = (bits / 8) * channels;
      const n = Math.floor((end - body) / frame);
      const audio = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const o = body + i * frame + c * (bits / 8);
          if (format === 1 && bits === 16) sum += b.readInt16LE(o) / 32768;
          else if (format === 3 && bits === 32) sum += b.readFloatLE(o);
          else throw new Error(`${file}: ${bits}-bit format ${format} is not read here`);
        }
        audio[i] = sum / channels;
      }
      return { sr, audio };
    }
    at = body + size + (size & 1);
  }
  throw new Error(`${file}: no audio data`);
}

/** 16-bit PCM mono, written through a temp file and a rename. */
export function writeWav(file: string, { sr, audio }: Wav) {
  const data = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    // the inverse of readWav's /32768, so a file read and written back is unchanged
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio[i]! * 32768))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(sr, 24);
  head.writeUInt32LE(sr * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, Buffer.concat([head, data]));
  renameSync(tmp, file);
}
