import { Short } from "../../../schema/short.ts";
import { resolveShort } from "../../core/short/resolve.ts";
import type { ShortVideoProps } from "./props.ts";

/** Studio's default Short: cards on a montage's beat, no files needed. */
export const demoShort: ShortVideoProps = {
  short: resolveShort(Short.parse({
    version: 1, title: "Demo", template: "montage", canvas: { w: 1080, h: 1920, fps: 60 },
    scenes: [
      { id: "one", hold: 2, visual: { type: "card", title: "DAY 1", subtitle: "one cube" } },
      { id: "two", hold: 2, visual: { type: "card", title: "DAY 5", subtitle: "a chunk" } },
      { id: "three", hold: 3, visual: { type: "card", title: "TODAY", subtitle: "an endless world" }, in: "drop" },
    ],
    text: [
      { role: "hook", text: "Building my own Minecraft from scratch", from: { t: 0 }, to: { t: 2 } },
      { role: "end", text: "PART 1", sub: "building Minecraft from scratch", from: { scene: "three", edge: "end", offset: -1.5 }, to: { scene: "three", edge: "end" } },
    ],
    captions: { style: { maxWords: 3, highlight: false }, overrides: [] },
    fx: [{ kind: "punch", at: { scene: "three", edge: "start" } }],
    sfx: [], music: null,
  })),
  media: { footage: {} },
};
