/**
 * A code scene: the files typed out under the scene's clock at 30 fps, as Code Typer's CodeFlash drew them
 * (src/remotion/CodeFlash.tsx there): the editor full frame, or under the caption's white bar.
 */
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import type { Timeline } from "../../../core/short/code/timeline.ts";
import { Editor } from "./Editor.tsx";
import { BAR_H, FPS, H, IDE, W } from "./theme.ts";

export const MemeBar: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: BAR_H, background: "#fff", display: "grid", placeItems: "center", padding: "0 56px" }}>
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", fontWeight: 800, color: "#000", fontSize: text.length > 60 ? 54 : text.length > 34 ? 62 : 72, lineHeight: 1.18, textAlign: "center" }}>{text}</div>
  </div>
);

export const CodeScene: React.FC<{ tl: Timeline; caption?: string; timer?: number }> = ({ tl, caption, timer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const top = caption ? BAR_H : 0;
  // the code moves at Code Typer's 30 fps, whatever the Short's rate: a keystroke can reveal lines at once,
  // so a finer clock would show them a frame early
  const t = Math.floor((frame / fps) * FPS + 1e-9) / FPS;
  return (
    <AbsoluteFill style={{ background: IDE.bg, width: W, height: H }}>
      <div style={{ position: "absolute", left: 0, right: 0, top, height: H - top, overflow: "hidden" }}>
        <Editor tl={tl} t={t} height={H - top} series={timer !== undefined ? "speedrun" : "flash"} timerTarget={timer} />
      </div>
      {caption ? <MemeBar text={caption} /> : null}
    </AbsoluteFill>
  );
};
