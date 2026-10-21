/**
 * What TikTok's and YouTube Shorts' own buttons and text cover on a 9:16
 * video, in pixels of a 1080x1920 canvas (scaled for any other). Measured
 * from the apps' players: the top bar, the right-hand action column, and the
 * caption and music band at the bottom. Approximate by nature; the editor
 * draws them over the preview and warns when captions or text sit inside.
 */
export type Rect = { x: number; y: number; w: number; h: number; label: string };
export type Platform = "tiktok" | "shorts";

const BASE = { w: 1080, h: 1920 };
const ZONES: Record<Platform, Rect[]> = {
  tiktok: [
    { x: 0, y: 0, w: 1080, h: 160, label: "top bar" },
    { x: 940, y: 700, w: 140, h: 820, label: "buttons" },
    { x: 0, y: 1520, w: 1080, h: 400, label: "caption band" },
  ],
  shorts: [
    { x: 0, y: 0, w: 1080, h: 140, label: "top bar" },
    { x: 950, y: 860, w: 130, h: 800, label: "buttons" },
    { x: 0, y: 1580, w: 1080, h: 340, label: "title band" },
  ],
};

export function safeZones(p: Platform, canvas: { w: number; h: number }): Rect[] {
  const sx = canvas.w / BASE.w, sy = canvas.h / BASE.h;
  return ZONES[p].map((r) => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy, label: r.label }));
}

const overlaps = (a: Omit<Rect, "label">, b: Omit<Rect, "label">) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The zones (by platform and label) a box overlaps. */
export function coveredBy(box: Omit<Rect, "label">, canvas: { w: number; h: number }): string[] {
  return (Object.keys(ZONES) as Platform[]).flatMap((p) => safeZones(p, canvas).filter((r) => overlaps(box, r)).map((r) => `${p === "tiktok" ? "TikTok" : "Shorts"} ${r.label}`));
}

/**
 * The box two lines of subtitles take (src/remotion/shorts/ShortVideo.tsx):
 * 84 px Inter 800 at 1.1 line height, centred. A chunk of up to three words
 * is at most about 800 px wide, so the box is the canvas's middle 800 px.
 */
export const captionBox = (top: number, canvas: { w: number }) => ({ x: (canvas.w - 800) / 2, y: top, w: 800, h: Math.round(84 * 1.1 * 2) });
