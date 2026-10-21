/**
 * The Short composition: what resolveShort laid out, drawn. Ported from Code
 * Typer's Montage (src/remotion/Montage.tsx there) so an imported episode
 * renders as it did: clips pushed in slowly, flashed on the way in, chapter
 * captions popping, a few words of subtitle at a time, a punch-in on every
 * boom, the end card over the last seconds. Text, captions and effects are
 * drawn live; footage is the only thing rendered ahead.
 */
import { AbsoluteFill, Audio, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import "@fontsource/inter/800.css";
import "@fontsource/inter/900.css";
import type { Caption, ResolvedScene, ResolvedShort, ResolvedText } from "../../core/short/resolve.ts";
import type { ShortMedia, ShortVideoProps } from "./props.ts";
import { CodeScene } from "./code/CodeScene.tsx";

const FONT = "Inter, system-ui, sans-serif";
const YELLOW = "#F4D345";
// White words with a black edge and a soft shadow, readable on sky and on terrain alike.
const outlined = (px: number): React.CSSProperties => ({
  color: "#fff",
  WebkitTextStroke: `${px}px #000`,
  paintOrder: "stroke fill",
  textShadow: "0 8px 22px rgba(0,0,0,0.45)",
});
/** A URL as it is (the preview's /media/...), else a name in the renderer's public folder. */
const src = (s: string) => (/^(https?:)?\//.test(s) ? s : staticFile(s));
const gain = (db: number) => 10 ** (db / 20);

/** One scene's picture: its footage pushed in slowly, flashed on its first frames unless it comes in on a plain cut. */
const Scene: React.FC<{ scene: ResolvedScene; frames: number; media: ShortMedia }> = ({ scene, frames, media }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const push = interpolate(f, [0, frames], scene.push);
  const flash = scene.in === "cut" ? 0 : interpolate(f, [0, scene.in === "drop" ? 16 : 8], [scene.in === "drop" ? 0.95 : 0.5, 0], { extrapolateRight: "clamp" });
  const v = scene.visual;
  const file = media.footage[scene.footage.scene];
  let picture: React.ReactNode;
  if ((v.type === "shot" || v.type === "clip") && file) {
    picture = <OffthreadVideo src={src(file)} trimBefore={Math.round(scene.footage.from * fps)} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />;
  } else if (v.type === "code" && media.code?.[scene.id]) {
    const c = media.code[scene.id]!;
    picture = <CodeScene tl={c.tl} caption={c.caption} timer={c.timer} />;
  } else if (v.type === "card") {
    const bg = v.background ? media.files?.[v.background] : undefined;
    picture = (
      <AbsoluteFill style={{ background: "#0E0E10", justifyContent: "center", alignItems: "center", textAlign: "center", padding: 80 }}>
        {bg ? <img src={src(bg)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 120, lineHeight: 1.02, ...outlined(10) }}>{v.title}</div>
        {v.subtitle ? <div style={{ marginTop: 28, fontFamily: FONT, fontWeight: 800, fontSize: 60, lineHeight: 1.15, ...outlined(7) }}>{v.subtitle}</div> : null}
      </AbsoluteFill>
    );
  } else {
    // footage not rendered yet, or typed code (drawn by its own scene kind): a placeholder that says which
    const what = v.type === "code" ? v.files.map((x) => x.path.split("/").pop()).join(", ") : v.type === "shot" ? `${v.kind} (rendering)` : v.type === "clip" ? v.asset : "";
    picture = (
      <AbsoluteFill style={{ background: "#1E1F22", justifyContent: "center", alignItems: "center", padding: 80 }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 54, color: "#8A8A90", textAlign: "center" }}>{what}</div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${push})` }}>{picture}</AbsoluteFill>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    </AbsoluteFill>
  );
};

/** A chapter caption ("DAY 5") and the line under it, in the top third, clear of the platforms' title and buttons. */
const Big: React.FC<{ text: ResolvedText; pops: boolean; until?: number }> = ({ text, pops, until }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = pops ? spring({ frame: f - 2, fps, config: { damping: 10, stiffness: 190, mass: 0.6 } }) : 1;
  const under = interpolate(f, [10, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const gone = until === undefined ? 1 : interpolate(f, [until - 10, until], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const small = text.role === "small";
  return (
    <div style={{ position: "absolute", top: 300, left: 40, right: 40, textAlign: "center", opacity: gone }}>
      {small ? null : <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 168, lineHeight: 1, letterSpacing: -3, transform: `scale(${0.55 + 0.45 * pop})`, ...outlined(12) }}>{text.text}</div>}
      {small || text.sub ? <div style={{ marginTop: small ? 0 : 22, fontFamily: FONT, fontWeight: 800, fontSize: 70, lineHeight: 1.1, opacity: under, ...outlined(8) }}>{small ? text.text : text.sub}</div> : null}
    </div>
  );
};

const Hook: React.FC<{ text: string }> = ({ text }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: f, fps, config: { damping: 12, stiffness: 170 } });
  return (
    <div style={{ position: "absolute", top: 260, left: 60, right: 60, textAlign: "center", fontFamily: FONT, fontWeight: 900, fontSize: 96, lineHeight: 1.04, transform: `scale(${0.8 + 0.2 * pop})`, ...outlined(10) }}>
      {text}
    </div>
  );
};

const End: React.FC<{ big: string; small?: string }> = ({ big, small }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const shade = interpolate(f, [0, 12], [0, 0.42], { extrapolateRight: "clamp" });
  const pop = spring({ frame: f - 3, fps, config: { damping: 12, stiffness: 160 } });
  return (
    <AbsoluteFill style={{ background: `rgba(0,0,0,${shade})`, justifyContent: "center", alignItems: "center", textAlign: "center", padding: 60 }}>
      <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 118, lineHeight: 1, transform: `scale(${0.7 + 0.3 * pop})`, ...outlined(10) }}>{big}</div>
      {small ? <div style={{ marginTop: 28, fontFamily: FONT, fontWeight: 800, fontSize: 56, lineHeight: 1.15, opacity: pop, ...outlined(7) }}>{small}</div> : null}
    </AbsoluteFill>
  );
};

/** One subtitle chunk: popped in, held, gone; an emphasized word in yellow, and with highlight on, the word being spoken. */
const Sub: React.FC<{ caption: Caption; top: number; highlight: boolean; startFrame: number }> = ({ caption, top, highlight, startFrame }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: f, fps, config: { damping: 14, stiffness: 260, mass: 0.5 } });
  const plain = !highlight && !caption.words.some((w) => w.emphasis);
  // the chunk's text has its last word's trailing punctuation taken off; show the words that way
  const shown = caption.text.split(" ");
  const t = (startFrame + f) / fps;
  let spoken = -1;
  if (highlight) caption.words.forEach((w, k) => (w.at <= t ? (spoken = k) : null));
  return (
    <div style={{ position: "absolute", top, left: 70, right: 70, textAlign: "center", fontFamily: FONT, fontWeight: 800, fontSize: 84, lineHeight: 1.1, transform: `scale(${0.85 + 0.15 * pop})`, ...outlined(9) }}>
      {plain
        ? caption.text
        : shown.map((word, k) => (
            <span key={k} style={caption.words[k]?.emphasis || k === spoken ? { color: YELLOW } : undefined}>
              {k ? " " : ""}
              {word}
            </span>
          ))}
    </div>
  );
};

/** The frame's punch-ins (a 9% jump settling over a third of a second) and shakes. */
function punchAndShake(s: ResolvedShort, frame: number, fps: number) {
  const t = frame / fps;
  let punch = 0, shake = 0, flash = 0;
  for (const e of s.fx) {
    const d = t - e.at;
    if (d < 0) continue;
    if (e.kind === "punch") {
      if (d < 0.6) punch = Math.max(punch, (e.amount ?? 0.09) * Math.exp(-d * 9));
      if (d < 0.2) shake = Math.max(shake, 1 - d / 0.2);
    } else if (e.kind === "shake") {
      const dur = e.dur ?? 0.2;
      if (d < dur) shake = Math.max(shake, (e.amount ?? 1) * (1 - d / dur));
    } else if (e.kind === "flash") {
      const dur = e.dur ?? 8 / 60;
      if (d < dur) flash = Math.max(flash, (e.amount ?? 0.5) * (1 - d / dur));
    }
  }
  return { punch, dx: shake * 16 * Math.sin(frame * 2.1), dy: shake * 12 * Math.cos(frame * 2.9), flash };
}

export const ShortVideo: React.FC<ShortVideoProps> = ({ short: s, media }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const fr = (sec: number) => Math.round(sec * fps);
  const { punch, dx, dy, flash } = punchAndShake(s, frame, fps);
  const end = s.text.find((t) => t.role === "end");
  const top = s.captionStyle.top ?? 1300;
  // a chapter caption pops in with its scene's flash; on a plain cut it is simply there
  const sceneAt = (t: number) => s.scenes.find((x) => fr(x.from) === fr(t));
  const music = s.music;
  // a song sinks under the voice, and stays down through gaps shorter than `hold` (the score has it built in)
  const ducked: [number, number][] = [];
  for (const [a, b] of music?.speech ?? []) {
    const last = ducked[ducked.length - 1];
    if (last && a - last[1] < (music!.duck.hold ?? 0)) last[1] = Math.max(last[1], b);
    else ducked.push([a, b]);
  }
  const duck = (f: number) => (music?.duck.depthDb && ducked.some(([a, b]) => f / fps >= a && f / fps < b) ? gain(music.duck.depthDb) : 1);
  let musicTrack: React.ReactNode = null;
  if (music && media.music) {
    const file = "file" in music.source ? music.source.file : null;
    const offset = file?.offset ?? 0;
    const lead = offset < 0 ? fr(-offset) : 0;
    musicTrack = (
      <Sequence from={lead} layout="none">
        <Audio src={src(media.music)} trimBefore={offset > 0 ? fr(offset) : 0} volume={(f) => gain(music.gainDb) * (file ? duck(f + lead) : 1)} />
      </Sequence>
    );
  }
  return (
    <AbsoluteFill style={{ background: "#000", transform: `translate(${dx}px, ${dy}px) scale(${1 + punch})` }}>
      {s.scenes.map((scene) => (
        <Sequence key={scene.id} from={fr(scene.from)} durationInFrames={Math.max(1, fr(scene.seconds))} layout="none">
          <Scene scene={scene} frames={fr(scene.seconds)} media={media} />
        </Sequence>
      ))}
      {s.text.map((t, i) => {
        const from = fr(t.from);
        if (t.role === "hook") return (
          <Sequence key={`t${i}`} from={from} durationInFrames={Math.max(1, fr(t.to) - from)} layout="none"><Hook text={t.text} /></Sequence>
        );
        if (t.role === "end") return (
          <Sequence key={`t${i}`} from={from} layout="none"><End big={t.text} small={t.sub} /></Sequence>
        );
        if (t.role === "big" || t.role === "small") {
          const until = end && end.from < t.to ? fr(end.from - t.from) : undefined;
          return (
            <Sequence key={`t${i}`} from={from} durationInFrames={Math.max(1, fr(t.to) - from)} layout="none">
              <Big text={t} pops={sceneAt(t.from)?.in !== "cut"} until={until} />
            </Sequence>
          );
        }
        return null;
      })}
      {s.captions.map((c, i) => {
        const from = fr(c.from);
        return (
          <Sequence key={`c${i}`} from={from} durationInFrames={Math.max(1, fr(c.to) - from)} layout="none">
            <Sub caption={c} top={top} highlight={s.captionStyle.highlight} startFrame={from} />
          </Sequence>
        );
      })}
      {flash > 0 ? <AbsoluteFill style={{ background: "#fff", opacity: flash }} /> : null}
      {media.voice
        ? s.voice.map((p, i) => (
            <Sequence key={`v${i}`} from={fr(p.at)} durationInFrames={Math.max(1, fr(p.to) - fr(p.from))} layout="none">
              <Audio src={src(media.voice!)} trimBefore={fr(p.from)} trimAfter={fr(p.to)} />
            </Sequence>
          ))
        : null}
      {musicTrack}
      {s.sfx.map((x, i) => {
        // a file (a file sound, or the kit's file for its kind), else the built-in sound's take
        const file = media.sfx?.[i] ?? (x.asset ? media.files?.[x.asset] : x.take !== undefined ? media.sounds?.[`${x.kind}:${x.take}`] : undefined);
        return file ? (
          <Sequence key={`s${i}`} from={fr(x.at)} layout="none">
            <Audio src={src(file)} volume={gain(x.gainDb)} />
          </Sequence>
        ) : null;
      })}
    </AbsoluteFill>
  );
};
