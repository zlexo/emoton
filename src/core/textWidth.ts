import { KATEX_MAIN_EM } from "./fontWidths.ts";

/** A character KaTeX_Main lacks comes from a fallback font: count it as wide. */
const FALLBACK = 0.6, CJK = 1;

/** Width in px of text set in KaTeX_Main at this size. The font has no kerning, so the advances add up. */
export function textWidth(text: string, px: number): number {
  let em = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    em += KATEX_MAIN_EM[c] ?? (c >= 0x2e80 ? CJK : FALLBACK);
  }
  return em * px;
}
