/** Manim's palette (manimlib constants) on a near-black stage. */
export const C = {
  bg: "#0E0E10",
  text: "#ECECEC",
  dim: "#8A8A90",
  faint: "#3A3A42",
  blue: "#58C4DD", // BLUE_C
  yellow: "#F4D345", // YELLOW_D
  gold: "#F0AC5F", // GOLD_C
  green: "#83C167", // GREEN_C
  red: "#FC6255", // RED_C
  teal: "#5CD0B3", // TEAL_C
};
export const SERIES = [C.blue, C.gold, C.green];
export const FONT = "KaTeX_Main, 'Latin Modern Roman', Georgia, serif";
export const MONO = "KaTeX_Typewriter, Menlo, monospace";
export const W = 1920;
export const H = 1080;
/** Content lives above the caption band. */
export const STAGE = { top: 120, bottom: 880 };

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Smooth 0..1 ramp starting at `at`, lasting `dur` seconds. */
export const ramp = (t: number, at: number, dur = 0.45) => {
  const x = clamp01((t - at) / dur);
  return x * x * (3 - 2 * x);
};
