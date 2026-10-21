import { Composition } from "remotion";
import { ChapterVideo, type ChapterProps } from "./ChapterVideo.tsx";
import { demoProps } from "./demo.ts";
import { ShortVideo } from "./shorts/ShortVideo.tsx";
import { demoShort } from "./shorts/demo.ts";
import { shortFrames, type ShortVideoProps } from "./shorts/props.ts";

export const FPS = 30;

export const Root: React.FC = () => (
  <>
  <Composition
    id="Chapter"
    component={ChapterVideo as unknown as React.FC<Record<string, unknown>>}
    width={1920}
    height={1080}
    fps={FPS}
    durationInFrames={FPS * 10}
    defaultProps={demoProps as unknown as Record<string, unknown>}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.ceil((props as unknown as ChapterProps).timing.duration * FPS),
    })}
  />
  <Composition
    id="Short"
    component={ShortVideo as unknown as React.FC<Record<string, unknown>>}
    width={1080}
    height={1920}
    fps={60}
    durationInFrames={60}
    defaultProps={demoShort as unknown as Record<string, unknown>}
    calculateMetadata={({ props }) => {
      const s = (props as unknown as ShortVideoProps).short;
      return { durationInFrames: shortFrames(s), fps: s.canvas.fps, width: s.canvas.w, height: s.canvas.h };
    }}
  />
  </>
);
