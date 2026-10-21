/**
 * Edit from a song: cuts land on the song's beats and its drop. A few bars
 * build up to the drop a bar per cut, then the cuts come twice as fast with a
 * punch on every bar; each cut shows a clip's liveliest stretch. A seed
 * re-rolls the order and the stretches. Pure, shared by the app and the server.
 */
import type { Fx, Scene, Short } from "../../../schema/short.ts";
import { SHORT_VERSION } from "../../../schema/short.ts";

export type SongInfo = { asset: string; bpm: number; firstBeat: number; dropAt: number; seconds: number };
/** A clip and where its liveliest stretch of a given length starts (avoiding starts already used). */
export type ClipInfo = { asset: string; seconds: number; lively(len: number, used: number[]): number };

export type EditOptions = { title: string; song: SongInfo; clips: ClipInfo[]; seed?: number; barsBefore?: number; barsAfter?: number };

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** A small seeded shuffle (mulberry32), so a re-roll is repeatable. */
function shuffled<T>(xs: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function editFromSong(o: EditOptions): Short {
  if (!o.clips.length) throw new Error("an edit needs at least one clip");
  const beat = 60 / o.song.bpm, bar = 4 * beat;
  // as many bars before the drop as the song has (up to barsBefore), and enough after
  const before = Math.max(1, Math.min(o.barsBefore ?? 4, Math.floor((o.song.dropAt - o.song.firstBeat) / bar + 1e-6)));
  const after = Math.max(1, Math.min(o.barsAfter ?? 8, Math.floor((o.song.seconds - o.song.dropAt) / bar + 1e-6)));
  const order = shuffled(o.clips, o.seed ?? 1);
  const used = new Map<string, number[]>();
  const scenes: Scene[] = [];
  const fx: Fx[] = [];
  const cut = (id: string, seconds: number, i: number, inn: Scene["in"]) => {
    const c = order[i % order.length]!;
    const taken = used.get(c.asset) ?? [];
    const from = c.seconds > seconds ? c.lively(seconds, taken) : 0;
    used.set(c.asset, [...taken, from]);
    scenes.push({ id, hold: r3(seconds), in: inn, push: 1.03, visual: { type: "clip", asset: c.asset, ...(from > 0 ? { from: r3(from) } : {}) } });
  };
  for (let b = 0; b < before; b++) cut(`b${b + 1}`, bar, b, b === 0 ? "cut" : "cut");
  // after the drop: a cut every two beats, a punch on every bar
  const halves = after * 2;
  for (let h = 0; h < halves; h++) {
    const id = h === 0 ? "drop" : `d${h + 1}`;
    cut(id, 2 * beat, before + h, h === 0 ? "drop" : "cut");
    if (h % 2 === 0) fx.push({ kind: "punch", at: { scene: id, edge: "start" }, amount: h === 0 ? 1.12 : 1.06, dur: r3(beat / 2) });
  }
  return {
    version: SHORT_VERSION,
    title: o.title,
    template: "edit",
    canvas: { w: 1080, h: 1920, fps: 60 },
    scenes,
    text: [],
    captions: { style: { maxWords: 3, highlight: false }, overrides: [] },
    fx,
    sfx: [],
    music: {
      source: { file: { asset: o.song.asset, dropAt: o.song.dropAt, align: { scene: "drop", edge: "start" }, bpm: o.song.bpm, firstBeat: o.song.firstBeat } },
      gainDb: -6,
      duck: { depthDb: 0 },
    },
    exportPresets: ["tiktok", "nomusic", "phone"],
  };
}
