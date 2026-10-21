/**
 * The four ways a Short starts (Devlog, Montage, Speedrun, Edit from a song)
 * and the starting document each gives: a valid Short that plays at once,
 * on its series' settings when it has one. Claude's draft or the editor
 * takes it from there. Pure, shared by the app and the server.
 */
import type { Scene, Short, TextClip } from "../../../schema/short.ts";
import { SHORT_VERSION } from "../../../schema/short.ts";
import type { Series } from "./series.ts";

export type Template = Short["template"];

export const TEMPLATES: { id: Template; name: string; about: string; tags: string[] }[] = [
  { id: "devlog", name: "Devlog", about: "A voiced story over Perdix shots. You write the script; shots, captions and sounds follow the words.", tags: ["voice", "Perdix shots"] },
  { id: "montage", name: "Montage", about: "Fast cuts with big day cards on a beat. No voice, or one line at the end.", tags: ["beat", "big text"] },
  { id: "speedrun", name: "Speedrun", about: "Code types itself under a running clock, from a repo and a list of files, then the payoff.", tags: ["code", "timer"] },
  { id: "edit", name: "Edit from a song", about: "Cuts land on a song's beats and drop. Always exports a No music copy too, for Content ID.", tags: ["song file", "No music copy"] },
];

export type StartOptions = { title: string; series?: Series; episode?: number };

const DEFAULT_VOICE: NonNullable<Short["voice"]> = { engine: "kokoro", voice: "am_puck", speed: 1.08 };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The series' numbered end card over the last scene's final seconds. */
export function endCard(series: Series, episode: number, lastScene: string): TextClip {
  return {
    role: "end",
    text: series.endCard.text.replace("{n}", String(episode)),
    ...(series.endCard.sub ? { sub: series.endCard.sub } : {}),
    from: { scene: lastScene, edge: "end", offset: -series.endCard.seconds },
    to: { scene: lastScene, edge: "end" },
  };
}

/** A template's starting document: something to look at and hear while the real content is written. */
export function startShort(template: Template, o: StartOptions): Short {
  const s = o.series;
  const look = { in: s?.scene.in ?? "cut", push: s?.scene.push ?? 1.02 } as const;
  const base: Short = {
    version: SHORT_VERSION,
    title: o.title,
    template,
    canvas: { w: 1080, h: 1920, fps: template === "speedrun" ? 30 : (s?.fps ?? 60) },
    ...(s ? { series: s.id } : {}),
    scenes: [],
    text: [],
    captions: { style: s?.captions ?? { maxWords: 3, highlight: false }, overrides: [] },
    fx: [],
    sfx: [],
    music: null,
    exportPresets: template === "edit" ? ["tiktok", "nomusic", "phone"] : (s?.exportPresets ?? ["tiktok", "phone"]),
    ...(s ? { target: { minSeconds: s.target.minSeconds, maxSeconds: s.target.maxSeconds } } : {}),
  };
  let scenes: Scene[];
  if (template === "devlog") {
    base.voice = s?.voice ?? DEFAULT_VOICE;
    base.music = s?.music ?? { source: { synth: { style: "pad", bpm: 84 } }, gainDb: -18, duck: { depthDb: -9, hold: 1 } };
    scenes = [
      { id: "hook", say: ["Open on what the last episode left. [boom]"], ...look, visual: { type: "card", title: o.title } },
      { id: "end", say: ["What should it learn next? Follow. [scratch]"], ...look, visual: { type: "card", title: "Next time" } },
    ];
  } else if (template === "montage") {
    const bpm = 124, beat = 60 / bpm;
    base.music = { source: { synth: { style: "house", bpm } }, gainDb: -14, duck: { depthDb: 0 } };
    scenes = Array.from({ length: 6 }, (_, i): Scene => ({
      id: `day${i + 1}`, hold: r3(beat * 4), in: i === 3 ? "drop" : i === 0 ? "cut" : "flash", push: 1.04,
      visual: { type: "card", title: `DAY ${i + 1}`, subtitle: "what changed" },
    }));
  } else if (template === "speedrun") {
    base.music = { source: { synth: { style: "phonk", bpm: 140 } }, gainDb: -14, duck: { depthDb: -8 } };
    scenes = [
      { id: "code", hold: 12, in: "cut", push: 1, visual: { type: "card", title: "The code types here", subtitle: "Choose a repo and files in the scene's inspector" } },
      { id: "payoff", hold: 4, in: "drop", push: 1.06, visual: { type: "card", title: "The payoff", subtitle: "A clip of it working" } },
    ];
  } else {
    scenes = [{ id: "song", hold: 6, in: "cut", push: 1.04, visual: { type: "card", title: "Pick a song", subtitle: "and a folder of clips" } }];
  }
  base.scenes = scenes;
  if (s && o.episode) base.text.push(endCard(s, o.episode, scenes.at(-1)!.id));
  return base;
}
