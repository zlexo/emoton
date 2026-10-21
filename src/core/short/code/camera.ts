// Ported unchanged from Code Typer (src/camera.ts there).
/**
 * Vertical camera per frame for one file (precomputed: Remotion renders frames out of
 * order, so nothing may accumulate across renders).
 *
 * The caret is held at CARET_AT of the view, leaving the bottom third blank so new code
 * is seen arriving. Plain easing lags at full speed (a 200-line class moves the caret
 * ~2.7 rows a frame, and easing trailed by ~6 rows, pushing the typing off the bottom),
 * so easing only smooths the start and the camera is never allowed below the target.
 */
import { stateAt, cursorOf, type FileTrack } from "./timeline.ts";
import { caretRow, type Wrap } from "./wrap.ts";

export const CARET_AT = 2 / 3;
const EASE = 0.3;
const SLACK = 0.03; // caret may drift this far (fraction of view) below target before the camera is forced along

export function cameraTrack(tr: FileTrack, wrap: Wrap, lh: number, viewH: number, fps: number): { y: number[]; caretY: number[] } {
  const frames = Math.ceil((tr.end - tr.start) * fps) + 2;
  const y: number[] = [];
  const caretY: number[] = [];
  let cam = 0;
  for (let f = 0; f < frames; f++) {
    const { len } = stateAt(tr, tr.start + f / fps);
    const c = cursorOf(tr, len);
    const rowY = (caretRow(wrap, c.line, c.col).row + 0.5) * lh;
    const target = Math.max(0, rowY - viewH * CARET_AT);
    cam += (target - cam) * EASE;
    cam = Math.max(cam, rowY - viewH * (CARET_AT + SLACK)); // never lag behind the caret
    y.push(cam);
    caretY.push(rowY - cam);
  }
  return { y, caretY };
}
