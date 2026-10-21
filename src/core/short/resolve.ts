/**
 * A Short document and its voice timing in, everything the composition draws
 * out, at absolute times. Pure: the editor's preview and the export both call
 * it, so what plays while editing is what renders. `checkShort` refuses with
 * a list, as the storyboard does: the structure and the voice first, then,
 * once those hold, every anchor, override and clip; `resolveShort` throws a
 * ShortError carrying that list.
 *
 * The timeline follows the voice, as Code Typer's devlog does (cli/devlog.ts
 * there): a spoken scene cuts in CUT_BEFORE_LINE before its first line and
 * runs to the next cut; a held scene (no narration) starts `lead` after the
 * line before it and opens a hole in the voice, so the next line starts
 * `after` its end. Held scenes with no voice before them run back to back
 * from 0, as a montage does.
 */
import { MARKERS, type Anchor, type Marker, type Music, type Short, type ShotVisual, type Sound, type TextClip, type Visual } from "../../../schema/short.ts";
import type { SentenceTiming } from "../../../schema/storyboard.ts";
import { keySentences, wordsOf } from "../words.ts";
import { captionBox, coveredBy } from "./safe.ts";

/** The voice as the voice stage made it, pause edits applied: one beat per spoken scene, one sentence per line. */
export type VoiceTiming = { duration: number; beats: { start: number; end: number; sentences: SentenceTiming[] }[] };
export type ShortInputs = { voice?: VoiceTiming };

export type Problem = { at: string; message: string };
export class ShortError extends Error {
  constructor(readonly problems: Problem[]) {
    super(problems.map((p) => `${p.at}: ${p.message}`).join("\n"));
    this.name = "ShortError";
  }
}

/** A spoken scene cuts in this long before its first line. */
export const CUT_BEFORE_LINE = 0.25;
/** A held scene's defaults: seconds after the line before it, and before the line after it. */
export const HOLD_LEAD = 0.3;
export const HOLD_AFTER = 0.9;
/** The hole a held scene opens in the voice starts this long after the line before it ends. */
const HOLE_PAD = 0.05;
const SCRATCH_BEFORE = 0.05;
const MARK_AFTER = 0.02;
export const DEFAULT_PUSH = 1.06;
/** The first orbiting shot's angle, radians. */
const ORBIT_START = 0.55;

const db = (x: number) => 20 * Math.log10(x);
/** Code Typer's levels: each kind's gain on its effects track, times the track's 0.7. */
export const SOUND_GAIN_DB: Record<Sound["kind"], number> = {
  boom: db(0.8 * 0.7), mash: db(0.7), scratch: db(0.42), ding: db(0.42), pop: db(0.42), keys: db(0.42),
  riser: db(0.42), impact: db(0.42), whoosh: db(0.42), file: 0,
};

export type ResolvedWord = { text: string; start: number; end: number };
export type ResolvedSentence = { key: string; scene: string; line: number; text: string; start: number; end: number; words: ResolvedWord[] };
export type ResolvedScene = {
  id: string;
  from: number;
  seconds: number;
  in: "cut" | "flash" | "drop";
  /** The push-in, as [from, to] scales. */
  push: [number, number];
  /** The scene whose visual plays here (itself, or the scene a `continue` carries on from), and seconds into its media. */
  footage: { scene: string; from: number };
  visual: Visual;
};
/** A stretch of the voice file played on the timeline: voice seconds [from, to) at timeline second `at`. */
export type VoicePiece = { at: number; from: number; to: number };
/** `first`: the index of the chunk's first word in its sentence, which overrides name. */
export type Caption = { sentence: string; first: number; text: string; from: number; to: number; words: { text: string; at: number; emphasis?: true }[] };
export type ResolvedText = { role: TextClip["role"]; text: string; sub?: string; from: number; to: number };
/** Where an effect comes from: the punch a boom brings (sfx index), or the document's fx list. */
export type ResolvedFx = { kind: string; at: number; dur?: number; amount?: number; source: { boom: number } | { fx: number } };
/**
 * Where a sound comes from: a marker in a script line (its sentence and place among the line's markers), or the
 * document's sfx list. `asset`: the file it plays (a file sound, or the kit's file for its kind); `take`: else which
 * take of the built-in sound, the kind's sounds taking them in turn so a run of booms does not repeat.
 */
export type ResolvedSound = { kind: Sound["kind"]; at: number; gainDb: number; asset?: string; take?: number; source: { marker: { sentence: string; n: number } } | { sfx: number } };

/** How many takes of each built-in sound there are. */
export const SOUND_TAKES = 3;
export type ShotRequest = {
  /** The scene that owns the shot; `continue` scenes after it play on in the same render. */
  scene: string;
  kind: string;
  build: string;
  seconds: number;
  knobs: Record<string, number | boolean | string>;
  sweep?: { at: number; len: number };
};
export type ResolvedMusic = {
  gainDb: number;
  duck: Music["duck"];
  /** Spoken intervals, for ducking. */
  speech: [number, number][];
  source:
    | { synth: { style: string; bpm: number; seed?: number; lifts: [number, number, number]; drop: number; cuts: number[]; hookEnd: number } }
    | { file: { asset: string; offset: number } };
  /** Beat 0 on the timeline and the tempo, when the music has a grid. */
  grid?: { first: number; bpm: number };
};
export type ResolvedShort = {
  canvas: Short["canvas"];
  duration: number;
  scenes: ResolvedScene[];
  sentences: ResolvedSentence[];
  voice: VoicePiece[];
  captions: Caption[];
  captionStyle: Short["captions"]["style"];
  text: ResolvedText[];
  fx: ResolvedFx[];
  sfx: ResolvedSound[];
  music: ResolvedMusic | null;
  shots: ShotRequest[];
  warnings: string[];
};

/** A script line's spoken text and its markers; `unknown` holds bracketed words that are not markers. */
export function parseLine(line: string): { text: string; marks: Marker[]; unknown: string[] } {
  const marks: Marker[] = [];
  const unknown: string[] = [];
  const text = line.replace(/\s*\[([^\]\n]{0,40})\]/g, (_, name: string) => {
    const n = name.trim();
    if ((MARKERS as readonly string[]).includes(n)) marks.push(n as Marker);
    else unknown.push(n);
    return "";
  }).trim();
  return { text, marks, unknown };
}

const r3 = (x: number) => +x.toFixed(3);
const tidy = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const describe = (a: Anchor) => JSON.stringify(a);

type Line = { scene: number; line: number; text: string; marks: Marker[]; key: string };
type Placed = { sentence: Line; start: number; end: number; words: ResolvedWord[] };

/** Everything both the check and the resolver need; null when the document cannot be laid out. */
function layout(doc: Short, inputs: ShortInputs, problems: Problem[]) {
  const push = (at: string, message: string) => problems.push({ at, message });
  const scenes = doc.scenes;

  // ---- structure
  const ids = new Map<string, number>();
  scenes.forEach((s, i) => {
    const at = `scene ${s.id}`;
    if (ids.has(s.id)) push(at, `the id is used twice (scenes ${ids.get(s.id)! + 1} and ${i + 1})`);
    else ids.set(s.id, i);
    if (!!s.say === (s.hold !== undefined)) push(at, "a scene either speaks (say) or holds (hold), not both or neither");
    if (s.continue && s.visual) push(at, "a continuing scene plays the previous footage: it has no visual of its own");
    if (!s.continue && !s.visual) push(at, "needs a visual (or continue, to keep the previous footage)");
    if (s.continue && !scenes.slice(0, i).some((p) => p.visual)) push(at, "continue needs a scene with a visual before it");
    if ((s.lead !== undefined || s.after !== undefined) && s.hold === undefined) push(at, "lead and after belong to held scenes");
  });

  // ---- the script
  const lines: Line[][] = scenes.map((s, i) => (s.say ?? []).map((raw, k) => {
    const p = parseLine(raw);
    for (const u of p.unknown) push(`scene ${s.id} line ${k + 1}`, `[${u}] is not a marker (markers: ${MARKERS.join(", ")})`);
    if (!p.text) push(`scene ${s.id} line ${k + 1}`, "has nothing to say once its markers are taken out");
    return { scene: i, line: k, text: p.text, marks: p.marks, key: "" };
  }));
  const flat = lines.flat();
  keySentences(flat.map((l) => l.text)).forEach((k, i) => (flat[i]!.key = k));

  // ---- the voice
  const spoken = scenes.map((s, i) => i).filter((i) => scenes[i]!.say);
  const voice = inputs.voice;
  if (spoken.length && !voice) push("voice", "the Short has narration but no voice timing (voice it first)");
  if (voice) {
    if (voice.beats.length !== spoken.length) push("voice", `the voice has ${voice.beats.length} parts for ${spoken.length} spoken scenes (voice it again)`);
    else spoken.forEach((si, b) => {
      const sents = voice.beats[b]!.sentences;
      const ls = lines[si]!;
      if (sents.length !== ls.length) return push(`scene ${scenes[si]!.id}`, `the voice has ${sents.length} lines for the script's ${ls.length} (voice it again)`);
      ls.forEach((l, k) => {
        if (tidy(sents[k]!.text) !== tidy(l.text)) push(`scene ${scenes[si]!.id} line ${k + 1}`, `the voice says "${sents[k]!.text}" (voice it again)`);
      });
    });
  }
  if (problems.length) return null;

  // ---- the timeline: cuts, the voice's holes, sentences in place
  const cut: number[] = [];
  const end: number[] = [];
  const holes: { at: number; seconds: number }[] = [];
  const placed: Placed[] = [];
  const beatEnd: number[] = []; // shifted end of each scene's voice part (spoken scenes)
  let shift = 0;
  let lastVoiceEnd: number | null = null; // in the voice's own time
  let pending: { end: number; after: number } | null = null;
  let b = 0;
  scenes.forEach((s, i) => {
    const prev = scenes[i - 1];
    if (s.say) {
      const beat = voice!.beats[b++]!;
      if (pending) {
        const open = Math.max(0, pending.end + pending.after - (beat.start + shift));
        holes.push({ at: lastVoiceEnd === null ? 0 : lastVoiceEnd + HOLE_PAD, seconds: open });
        shift += open;
        pending = null;
      }
      beat.sentences.forEach((x, k) => {
        placed.push({
          sentence: lines[i]![k]!,
          start: x.start + shift,
          end: x.end + shift,
          words: wordsOf(x).map((w) => ({ text: w.text, start: w.start + shift, end: w.end + shift })),
        });
      });
      cut[i] = i === 0 ? 0 : prev!.hold !== undefined ? end[i - 1]! : beat.start + shift - CUT_BEFORE_LINE;
      if (i > 0) end[i - 1] = cut[i]!;
      beatEnd[i] = beat.end + shift;
      lastVoiceEnd = beat.end;
    } else {
      const start = i === 0 ? 0 : prev!.hold !== undefined ? end[i - 1]! : beatEnd[i - 1]! + (s.lead ?? HOLD_LEAD);
      cut[i] = start;
      if (i > 0) end[i - 1] = start;
      end[i] = start + s.hold!;
      pending = { end: end[i]!, after: s.after ?? HOLD_AFTER };
    }
  });
  const last = scenes.length - 1;
  if (scenes[last]!.say) end[last] = voice!.duration + shift;
  const duration = end[last]!;
  scenes.forEach((s, i) => {
    if (!(end[i]! > cut[i]!)) push(`scene ${s.id}`, `has no length (${cut[i]!.toFixed(3)} to ${end[i]!.toFixed(3)} s)`);
  });

  const pieces: VoicePiece[] = [];
  if (voice) {
    let from = 0, sh = 0;
    for (const h of holes) {
      if (h.at > from) pieces.push({ at: from + sh, from, to: h.at });
      sh += h.seconds;
      from = Math.max(from, h.at);
    }
    if (voice.duration > from) pieces.push({ at: from + sh, from, to: voice.duration });
  }

  return { lines, placed, cut, end, duration, pieces };
}

/** Every problem with the document against this voice timing; empty when it resolves. */
export function checkShort(doc: Short, inputs: ShortInputs = {}): Problem[] {
  const problems: Problem[] = [];
  build(doc, inputs, problems);
  return problems;
}

/** The document resolved; throws a ShortError listing every problem when it cannot be. */
export function resolveShort(doc: Short, inputs: ShortInputs = {}): ResolvedShort {
  const problems: Problem[] = [];
  const out = build(doc, inputs, problems);
  if (problems.length || !out) throw new ShortError(problems);
  return out;
}

function build(doc: Short, inputs: ShortInputs, problems: Problem[]): ResolvedShort | null {
  const L = layout(doc, inputs, problems);
  if (!L) return null;
  const push = (at: string, message: string) => problems.push({ at, message });
  const scenes = doc.scenes;
  const sceneAt = new Map(scenes.map((s, i) => [s.id, i]));
  const byKey = new Map(L.placed.map((p) => [p.sentence.key, p]));

  // ---- the beat grid: the score's tempo from 0, or a song's grid moved to where the song starts
  const music = doc.music;
  let songOffset = 0;
  let grid: ((n: number) => number) | null = null;
  const time = (a: Anchor, at: string): number => {
    let t: number;
    if ("word" in a) {
      const p = byKey.get(a.word.s);
      if (!p) return push(at, `no line "${a.word.s}" in the script (${describe(a)})`), NaN;
      const w = p.words[a.word.w];
      if (!w) return push(at, `"${a.word.s}" has ${p.words.length} words, no word ${a.word.w}`), NaN;
      t = a.edge === "end" ? w.end : w.start;
    } else if ("sentence" in a) {
      const p = byKey.get(a.sentence);
      if (!p) return push(at, `no line "${a.sentence}" in the script`), NaN;
      t = a.edge === "end" ? p.end : p.start;
    } else if ("beat" in a) {
      if (!grid) return push(at, "a beat anchor needs a beat grid (the score's bpm, or the song's bpm)"), NaN;
      t = grid(a.beat);
    } else if ("scene" in a) {
      const i = sceneAt.get(a.scene);
      if (i === undefined) return push(at, `no scene ${a.scene}`), NaN;
      t = a.edge === "end" ? L.end[i]! : L.cut[i]!;
    } else return a.t;
    return t + (a.offset ?? 0);
  };
  if (music && "synth" in music.source) {
    const bpm = music.source.synth.bpm;
    grid = (n) => (n * 60) / bpm;
  } else if (music && "file" in music.source) {
    const f = music.source.file;
    if (f.align && "beat" in f.align) push("music", "the song's drop cannot be aligned to a beat of its own grid");
    else if (f.align && f.dropAt !== undefined) songOffset = f.dropAt - time(f.align, "music align");
    else if (f.align || f.dropAt !== undefined) push("music", "dropAt and align go together");
    if (f.bpm !== undefined) {
      const bpm = f.bpm, first = f.firstBeat ?? 0;
      grid = (n) => first + (n * 60) / bpm - songOffset;
    }
  }

  // ---- scenes and their footage
  let owner = -1;
  const rs: ResolvedScene[] = [];
  let from = 0;
  scenes.forEach((s, i) => {
    if (s.visual) owner = i;
    const o = scenes[owner]!;
    const offset = L.cut[i]! - L.cut[owner]!;
    const v = o.visual!;
    const media = v.type === "clip" ? (v.from ?? 0) + offset * (v.speed ?? 1) : offset;
    const seconds = r3(L.end[i]! - L.cut[i]!);
    rs.push({ id: s.id, from: r3(from), seconds, in: s.in ?? "flash", push: [1, s.push ?? DEFAULT_PUSH], footage: { scene: o.id, from: r3(media) }, visual: v });
    from += seconds;
  });

  // ---- shots: one render per run (the owning scene and the continues after it)
  const shots: ShotRequest[] = [];
  let orbit = ORBIT_START;
  scenes.forEach((s, i) => {
    if (s.visual?.type !== "shot") return;
    let lastI = i;
    while (scenes[lastI + 1]?.continue) lastI++;
    const runFrom = L.cut[i]!, dur = L.end[lastI]! - runFrom;
    const v: ShotVisual = s.visual;
    const knobs: ShotRequest["knobs"] = {};
    for (const [k, val] of Object.entries(v.knobs)) {
      knobs[k] = typeof val === "object" ? r3(time(val, `scene ${s.id} knob ${k}`) - runFrom) : val;
    }
    if (v.orbit !== undefined) {
      knobs.START = +orbit.toFixed(4);
      knobs.SPIN = v.orbit;
      orbit += v.orbit * dur;
    }
    const sweep = v.sweep && { at: r3(time(v.sweep.at, `scene ${s.id} sweep`) - runFrom), len: v.sweep.len };
    shots.push({ scene: s.id, kind: v.kind, build: v.build, seconds: r3(dur), knobs, ...(sweep ? { sweep } : {}) });
  });

  // ---- captions: a few words at a time, never across a line, each shown until the next starts
  const ops = new Map<string, Set<string>>();
  for (const [n, o] of doc.captions.overrides.entries()) {
    const p = byKey.get(o.word.s);
    if (!p) push(`caption override ${n + 1}`, `no line "${o.word.s}" in the script`);
    else if (!p.words[o.word.w]) push(`caption override ${n + 1}`, `"${o.word.s}" has no word ${o.word.w}`);
    const id = `${o.word.s}\u0000${o.word.w}`;
    if (!ops.has(id)) ops.set(id, new Set());
    ops.get(id)!.add(o.op);
  }
  const has = (key: string, w: number, op: string) => ops.get(`${key}\u0000${w}`)?.has(op) ?? false;
  const captions: Caption[] = [];
  for (const p of L.placed) {
    const key = p.sentence.key;
    const chunks: number[][] = [];
    let cur: number[] = [];
    p.words.forEach((w, k) => {
      if (cur.length && has(key, k, "break")) { chunks.push(cur); cur = []; }
      cur.push(k);
      const full = cur.length >= doc.captions.style.maxWords || /[.,!?;:]$/.test(w.text);
      if (full && !has(key, k + 1, "join")) { chunks.push(cur); cur = []; }
    });
    if (cur.length) chunks.push(cur);
    chunks.forEach((c, n) => {
      if (c.some((k) => has(key, k, "hide"))) return;
      const to = n + 1 < chunks.length ? p.words[chunks[n + 1]![0]!]!.start : p.end;
      captions.push({
        sentence: key,
        first: c[0]!,
        text: c.map((k) => p.words[k]!.text).join(" ").replace(/[.,;:]$/, ""),
        from: r3(p.words[c[0]!]!.start),
        to: r3(to),
        words: c.map((k) => ({ text: p.words[k]!.text, at: r3(p.words[k]!.start), ...(has(key, k, "emphasize") ? { emphasis: true as const } : {}) })),
      });
    });
  }

  // ---- sounds: the script's markers in order, then the pinned ones; a boom punches the frame in
  const sfx: ResolvedSound[] = [];
  const fx: ResolvedFx[] = [];
  for (const p of L.placed) {
    p.sentence.marks.forEach((kind, n) => {
      const at = kind === "scratch" ? p.start - SCRATCH_BEFORE : p.end + MARK_AFTER;
      sfx.push({ kind, at: r3(at), gainDb: SOUND_GAIN_DB[kind], source: { marker: { sentence: p.sentence.key, n } } });
      if (kind === "boom") fx.push({ kind: "punch", at: r3(at), source: { boom: sfx.length - 1 } });
    });
  }
  doc.sfx.forEach((s, n) => {
    const at = time(s.at, `sound ${n + 1}`);
    if (s.kind === "file" && !s.asset) push(`sound ${n + 1}`, "a file sound needs its asset");
    if (s.kind !== "file" && s.asset) push(`sound ${n + 1}`, "only a file sound has an asset");
    sfx.push({ kind: s.kind, at: r3(at), gainDb: s.gainDb ?? SOUND_GAIN_DB[s.kind], ...(s.asset ? { asset: s.asset } : {}), source: { sfx: n } });
    if (s.kind === "boom" && s.punch !== false) fx.push({ kind: "punch", at: r3(at), source: { boom: sfx.length - 1 } });
  });
  doc.fx.forEach((f, n) => fx.push({ kind: f.kind, at: r3(time(f.at, `effect ${n + 1}`)), ...(f.dur !== undefined ? { dur: f.dur } : {}), ...(f.amount !== undefined ? { amount: f.amount } : {}), source: { fx: n } }));
  fx.sort((a, b) => a.at - b.at);
  // the kit's file for a kind, else the built-in sound's next take
  const turns = new Map<string, number>();
  for (const x of sfx) {
    if (x.kind === "file") continue;
    const kit = doc.soundKit?.[x.kind];
    if (kit) x.asset = kit;
    else {
      const n = turns.get(x.kind) ?? 0;
      turns.set(x.kind, n + 1);
      x.take = n % SOUND_TAKES;
    }
  }

  // ---- text
  const text: ResolvedText[] = doc.text.map((c, n) => {
    const a = time(c.from, `text ${n + 1} from`), z = time(c.to, `text ${n + 1} to`);
    if (z <= a) push(`text ${n + 1}`, `"${c.text}" ends before it starts (${a.toFixed(3)} to ${z.toFixed(3)} s)`);
    return { role: c.role, text: c.text, ...(c.sub ? { sub: c.sub } : {}), from: r3(a), to: r3(z) };
  });

  // ---- music
  const speech = L.placed.map((p) => [r3(p.start), r3(p.end)] as [number, number]);
  let rm: ResolvedMusic | null = null;
  if (music && "synth" in music.source) {
    const sy = music.source.synth;
    const lifts = (sy.lifts ?? []).map((a, n) => r3(time(a, `music lift ${n + 1}`)));
    while (lifts.length < 3) lifts.push(r3(L.duration));
    const dropScene = scenes.findIndex((s) => s.in === "drop");
    const drop = sy.drop ? time(sy.drop, "music drop") : dropScene >= 0 ? L.cut[dropScene]! : L.duration;
    const hook = text.find((t) => t.role === "hook");
    rm = {
      gainDb: music.gainDb, duck: music.duck, speech,
      source: { synth: { style: sy.style, bpm: sy.bpm, ...(sy.seed !== undefined ? { seed: sy.seed } : {}), lifts: lifts as [number, number, number], drop: r3(drop), cuts: rs.filter((s) => s.in !== "cut").map((s) => s.from), hookEnd: hook?.to ?? 0 } },
      grid: { first: 0, bpm: sy.bpm },
    };
  } else if (music && "file" in music.source) {
    const f = music.source.file;
    rm = {
      gainDb: music.gainDb, duck: music.duck, speech, source: { file: { asset: f.asset, offset: r3(songOffset) } },
      ...(f.bpm !== undefined ? { grid: { first: r3((f.firstBeat ?? 0) - songOffset), bpm: f.bpm } } : {}),
    };
  }

  // ---- length against the target: a warning, not a refusal
  const warnings: string[] = [];
  const t = doc.target;
  if (t?.minSeconds !== undefined && L.duration < t.minSeconds) warnings.push(`${L.duration.toFixed(1)} s is under the target of ${t.minSeconds} s`);
  if (t?.maxSeconds !== undefined && L.duration > t.maxSeconds) warnings.push(`${L.duration.toFixed(1)} s is over the target of ${t.maxSeconds} s`);
  // subtitles the platforms' own buttons and text would cover
  if (captions.length) {
    const covered = coveredBy(captionBox(doc.captions.style.top ?? 1300, doc.canvas), doc.canvas);
    if (covered.length) warnings.push(`captions sit under ${covered.join(", ")}: move them (style top)`);
  }

  return {
    canvas: doc.canvas,
    duration: r3(L.duration),
    scenes: rs,
    sentences: L.placed.map((p) => ({
      key: p.sentence.key, scene: scenes[p.sentence.scene]!.id, line: p.sentence.line, text: p.sentence.text,
      start: r3(p.start), end: r3(p.end), words: p.words.map((w) => ({ text: w.text, start: r3(w.start), end: r3(w.end) })),
    })),
    voice: L.pieces.map((v) => ({ at: r3(v.at), from: r3(v.from), to: r3(v.to) })),
    captions, captionStyle: doc.captions.style, text, fx, sfx, music: rm, shots, warnings,
  };
}

