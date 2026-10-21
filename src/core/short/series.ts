/**
 * A series: what every episode shares, so a new one starts on-style (voice,
 * captions, the numbered end card, the score, how often a boom lands, the
 * pause rules, wording rules), and its episode count. Built in for now;
 * Perdix is the first. Pure, shared by the app and the server.
 */
import type { Captions, Music, Short, ShortVoice } from "../../../schema/short.ts";

export type Series = {
  id: string;
  name: string;
  /** Episode bundles are named `<slug>-ep<n>`. */
  slug: string;
  template: Short["template"];
  fps: Short["canvas"]["fps"];
  voice: ShortVoice;
  captions: Captions["style"];
  music: NonNullable<Short["music"]>;
  /** "{n}" is the episode number. */
  endCard: { text: string; sub?: string; seconds: number };
  /** The drafter's pace for the loudest marker. */
  boomsPerMinute: number;
  /** The scenes come in like this and push in this far. */
  scene: { in: "cut" | "flash"; push: number };
  /** The series' pause rules apply to new lines (commas, colons, booms, punchlines). */
  pauseRules: boolean;
  /** Words the script never uses, and what it says instead. */
  wording: { avoid: string; use: string }[];
  /** What the drafter keeps to: length, truthfulness, how an episode ends. */
  rules: string[];
  target: { minSeconds: number; maxSeconds: number };
  exportPresets: NonNullable<Short["exportPresets"]>;
  /** Episodes made before Emoton: numbering counts on from here. */
  before: number;
  /** What the shots look like (shown with the defaults). */
  look: string;
};

export const SERIES: Record<string, Series> = {
  perdix: {
    id: "perdix",
    name: "Perdix devlogs",
    slug: "perdix",
    template: "devlog",
    fps: 60,
    voice: { engine: "kokoro", voice: "am_puck", speed: 1.08, gaps: { leadIn: 0.3, sentence: 0.22, beat: 0.45, aha: 0.7, tail: 3.2 } },
    captions: { maxWords: 3, highlight: false },
    music: { source: { synth: { style: "pad", bpm: 84 } }, gainDb: -17.7, duck: { depthDb: -9.1, hold: 1 } },
    endCard: { text: "PART {n}", sub: "building Minecraft from scratch", seconds: 3 },
    boomsPerMinute: 5,
    scene: { in: "cut", push: 1.02 },
    pauseRules: true,
    wording: [
      { avoid: "I coded", use: "I built" },
      { avoid: "I programmed", use: "I taught" },
    ],
    rules: [
      "About 60 seconds; the same file goes on Shorts and TikTok.",
      "Every claim is true of Perdix the day the episode goes out.",
      "Markers in brackets are sound effects, never spoken: [boom] punch-in and shake on a punchline, [scratch] a record scratch on a turn, [ding] a small win, [mash] keyboard mashing.",
      "Dry, self-aware humour; short lines; one idea per line.",
      "It opens on what the last episode left, and ends asking what Perdix should learn next, then Follow.",
    ],
    target: { minSeconds: 45, maxSeconds: 75 },
    exportPresets: ["tiktok", "phone"],
    // episodes 1 to 3 were made in Code Typer, before Emoton
    before: 3,
    look: "Minecraft textures",
  },
};

/** The number on the episode's end card ("PART 3" → 3). */
export function episodeOf(doc: Short): number | undefined {
  const end = doc.text.find((t) => t.role === "end");
  const m = end?.text.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : undefined;
}

/** The next episode's number: after the highest one already made. */
export const nextEpisode = (s: Series, made: (number | undefined)[]) => Math.max(s.before, ...made.map((n) => n ?? 0)) + 1;

/** A line's wording rules broken ("I coded" where the series says "I built"), as messages. */
export function wordingProblems(s: Series, doc: Short): string[] {
  const out: string[] = [];
  for (const sc of doc.scenes) {
    for (const line of sc.say ?? []) {
      for (const w of s.wording) {
        if (line.toLowerCase().includes(w.avoid.toLowerCase())) out.push(`${sc.id}: "${w.avoid}" (the series says "${w.use}")`);
      }
    }
  }
  return out;
}
