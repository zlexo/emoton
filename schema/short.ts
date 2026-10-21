/**
 * The Short document (short.json): one per Short or TikTok. The editor changes
 * it, `resolveShort` (src/core/short/resolve.ts) turns it and the voice timing
 * into what the composition draws, and the export renders those same props.
 *
 * Anything that must stay in sync with the narration is anchored to a word,
 * by its sentence key (src/core/words.ts keySentences, the key pause edits
 * use) and the word's index, never to a second: re-voice a line, lengthen a
 * pause or rewrite a sentence and everything after it moves with it. Music
 * Shorts anchor to beats; anything else may sit at a fixed time.
 *
 * Markers in a script line ("[boom]") are sounds that are not spoken. Each
 * plays at its default place: a scratch 0.05 s before its line starts, every
 * other kind 0.02 s after its line ends (Code Typer's rule). Pinning one to a
 * word moves it out of the line into `sfx`.
 */
import { z } from "zod/v4";

export const SHORT_VERSION = 1;

/** What an export makes: the main file (always), a copy without music, a phone copy, the sound alone, a strip of stills. */
export const EXPORT_PRESETS = ["tiktok", "nomusic", "phone", "audio", "stills"] as const;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "letters, digits, - and _, at most 32");
const Seconds = z.number().finite();
const Positive = z.number().finite().positive();
const NonNegative = z.number().finite().min(0);
const Text = (n: number) => z.string().min(1).max(n);
/** A sentence key: the line's spoken text, lowercased, spacing tidied, "#2" on a repeat. */
const SentenceKey = Text(2000);
/** A file in the Short's bundle, relative to it ("assets/walk.mp4"). */
const BundlePath = z.string().min(1).max(400).refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "a path inside the bundle");
const Edge = z.enum(["start", "end"]);

/** Word `w` (0-based) of the sentence with key `s`. */
export const WordRef = z.strictObject({ s: SentenceKey, w: z.number().int().min(0).max(999) });

export const Anchor = z.union([
  /** A word's start (default) or end. */
  z.strictObject({ word: WordRef, edge: Edge.optional(), offset: Seconds.optional() }),
  /** A whole line's start or end. */
  z.strictObject({ sentence: SentenceKey, edge: Edge, offset: Seconds.optional() }),
  /** Beat n of the music's grid, counted from 0. */
  z.strictObject({ beat: NonNegative, offset: Seconds.optional() }),
  /** A scene's start or end on the timeline. */
  z.strictObject({ scene: Id, edge: Edge, offset: Seconds.optional() }),
  /** A fixed time. */
  z.strictObject({ t: NonNegative }),
]);

/** A shot knob: a number, a switch or a word, or a time pinned to the narration (seconds from the shot's start). */
export const KnobValue = z.union([z.number().finite(), z.boolean(), Text(200), Anchor]);

export const ShotVisual = z.strictObject({
  type: z.literal("shot"),
  source: z.literal("perdix"),
  kind: Text(40),
  /** Named like environment variables (the shot tool reads them so). */
  knobs: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, "UPPER_SNAKE"), KnobValue),
  /** The Perdix commit the shot is rendered at. */
  build: z.string().regex(/^[0-9a-f]{7,40}$/, "a commit"),
  /** A slow orbit, radians per second, chained from the previous orbiting shot's last angle. */
  orbit: z.number().finite().optional(),
  /** Two renders of the shot, wireframe then textured, joined by a mask sweeping up at `at` over `len` seconds. */
  sweep: z.strictObject({ at: Anchor, len: Positive }).optional(),
});

export const ClipVisual = z.strictObject({
  type: z.literal("clip"),
  asset: BundlePath,
  /** Seconds into the clip where the scene starts. */
  from: NonNegative.optional(),
  speed: z.number().finite().min(0.1).max(10).optional(),
});

export const CodeFile = z.strictObject({
  path: Text(400),
  /** A repository and a ref: the code as it was at that commit. */
  repo: Text(400).optional(),
  ref: Text(80).optional(),
  /** 1-based inclusive line ranges, joined by a blank line. */
  lines: z.array(z.tuple([z.number().int().min(1), z.number().int().min(1)])).min(1).max(20).optional(),
});

export const CodeVisual = z.strictObject({
  type: z.literal("code"),
  files: z.array(CodeFile).min(1).max(20),
  /** Typing pace the editor keeps when the files change, in characters per second; the scene's `hold` is the length. */
  pace: Positive.optional(),
  seed: z.number().int().optional(),
  caption: Text(140).optional(),
  lang: Text(20).optional(),
  /** Speedrun: what the timer races up to ("2:14:07"). */
  timer: Text(20).optional(),
});

export const CardVisual = z.strictObject({
  type: z.literal("card"),
  title: Text(120),
  subtitle: Text(200).optional(),
  background: BundlePath.optional(),
});

export const Visual = z.discriminatedUnion("type", [ShotVisual, ClipVisual, CodeVisual, CardVisual]);

export const Scene = z.strictObject({
  id: Id,
  /** The narration, one line each (a line is one sentence of the voice); markers inline. */
  say: z.array(Text(2000)).min(1).max(40).optional(),
  /** A scene with no narration lasts this long (a montage segment, a code chapter). */
  hold: Positive.optional(),
  /** A held scene inside narration: seconds after the line before it, and before the line after it. */
  lead: NonNegative.optional(),
  after: NonNegative.optional(),
  /** Absent when `continue`: the previous scene's footage keeps running. */
  visual: Visual.optional(),
  continue: z.boolean().optional(),
  /** How the scene comes in: a plain cut, a flash, or the bigger flash of the drop. Default flash. */
  in: z.enum(["cut", "flash", "drop"]).optional(),
  /** The slow push-in's final scale over the scene; 1 holds still. Default 1.06. */
  push: z.number().finite().min(1).max(1.5).optional(),
});

export const TextClip = z.strictObject({
  role: z.enum(["hook", "big", "small", "meme", "end", "label"]),
  text: Text(140),
  /** The smaller line under it (a chapter caption's subtitle, the end card's series line). */
  sub: Text(140).optional(),
  from: Anchor,
  to: Anchor,
});

export const ChunkOverride = z.strictObject({
  word: WordRef,
  /** break: a chunk starts at this word; join: no break before it; hide: its chunk is not shown; emphasize: this word in yellow. */
  op: z.enum(["break", "join", "hide", "emphasize"]),
});

export const Captions = z.strictObject({
  style: z.strictObject({
    /** Words a chunk holds at most; a chunk also ends after punctuation. */
    maxWords: z.number().int().min(1).max(8),
    /** The spoken word lights up. */
    highlight: z.boolean(),
    /** The chunk's top edge, in canvas pixels. */
    top: z.number().int().min(0).max(4000).optional(),
  }),
  overrides: z.array(ChunkOverride).max(500),
});

export const FX_KINDS = ["punch", "shake", "flash", "push", "sweep", "freeze"] as const;
export const Fx = z.strictObject({
  kind: z.enum(FX_KINDS),
  at: Anchor,
  dur: Positive.optional(),
  amount: z.number().finite().optional(),
});

/** Sound kinds that may stand in a script line as a marker. */
export const MARKERS = ["boom", "scratch", "ding", "mash", "pop", "keys", "riser", "impact", "whoosh"] as const;
export type Marker = (typeof MARKERS)[number];

export const Sound = z.strictObject({
  kind: z.enum([...MARKERS, "file"]),
  at: Anchor,
  gainDb: z.number().finite().min(-60).max(12).optional(),
  /** kind "file": the sound file. */
  asset: BundlePath.optional(),
  /** A boom punches the frame in; false keeps it still. */
  punch: z.boolean().optional(),
});

export const SYNTH_STYLES = ["pad", "trap", "phonk", "house", "chiptune"] as const;
export const Music = z.strictObject({
  source: z.union([
    z.strictObject({
      synth: z.strictObject({
        style: z.enum(SYNTH_STYLES),
        bpm: z.number().finite().min(40).max(220),
        seed: z.number().int().optional(),
        /** pad: where it adds a layer (piano and bass, strings and drums, the climax). */
        lifts: z.array(Anchor).max(3).optional(),
        /** The beat styles: where the drop lands. Default the first scene that comes in on a drop, else the end. */
        drop: Anchor.optional(),
      }),
    }),
    z.strictObject({
      file: z.strictObject({
        asset: BundlePath,
        /** Seconds into the song where its drop is, and where on the timeline it lands. */
        dropAt: NonNegative.optional(),
        align: Anchor.optional(),
        /** The song's beat grid, when known: tempo and the first beat, in song seconds. */
        bpm: z.number().finite().min(40).max(220).optional(),
        firstBeat: NonNegative.optional(),
      }),
    }),
  ]),
  gainDb: z.number().finite().min(-60).max(12),
  duck: z.strictObject({
    /** How far the music sinks under the voice. */
    depthDb: z.number().finite().min(-60).max(0),
    /** Gaps in the voice shorter than this many seconds stay ducked. */
    hold: NonNegative.optional(),
    attack: NonNegative.optional(),
    release: NonNegative.optional(),
  }),
});

export const ShortVoice = z.strictObject({
  engine: z.enum(["kokoro", "say"]),
  voice: Text(60),
  speed: z.number().finite().min(0.5).max(2),
  gaps: z.strictObject({ leadIn: NonNegative, sentence: NonNegative, beat: NonNegative, aha: NonNegative, tail: NonNegative }).optional(),
});

export const Short = z.strictObject({
  version: z.literal(SHORT_VERSION),
  title: Text(120),
  /** Where it started; one schema for all. */
  template: z.enum(["devlog", "montage", "speedrun", "edit"]),
  canvas: z.strictObject({
    w: z.number().int().min(100).max(4000),
    h: z.number().int().min(100).max(4000),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  }),
  series: Text(60).optional(),
  voice: ShortVoice.optional(),
  /** In order; one main visual each. */
  scenes: z.array(Scene).min(1).max(200),
  text: z.array(TextClip).max(200),
  captions: Captions,
  fx: z.array(Fx).max(500),
  sfx: z.array(Sound).max(500),
  music: Music.nullable(),
  /** The sound file each marker kind plays (copied into the bundle from the sound library); a kind not here plays the built-in sound. */
  soundKit: z.partialRecord(z.enum(MARKERS), BundlePath).optional(),
  /** The presets an export makes (default the main file and a phone copy). */
  exportPresets: z.array(z.enum(EXPORT_PRESETS)).max(EXPORT_PRESETS.length).optional(),
  target: z.strictObject({ minSeconds: Positive.optional(), maxSeconds: Positive.optional() }).optional(),
});

export type WordRef = z.infer<typeof WordRef>;
export type Anchor = z.infer<typeof Anchor>;
export type KnobValue = z.infer<typeof KnobValue>;
export type ShotVisual = z.infer<typeof ShotVisual>;
export type ClipVisual = z.infer<typeof ClipVisual>;
export type CodeVisual = z.infer<typeof CodeVisual>;
export type CardVisual = z.infer<typeof CardVisual>;
export type Visual = z.infer<typeof Visual>;
export type Scene = z.infer<typeof Scene>;
export type TextClip = z.infer<typeof TextClip>;
export type ChunkOverride = z.infer<typeof ChunkOverride>;
export type Captions = z.infer<typeof Captions>;
export type Fx = z.infer<typeof Fx>;
export type Sound = z.infer<typeof Sound>;
export type Music = z.infer<typeof Music>;
export type ShortVoice = z.infer<typeof ShortVoice>;
export type Short = z.infer<typeof Short>;
