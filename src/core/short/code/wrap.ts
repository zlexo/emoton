// Ported unchanged from Code Typer (src/wrap.ts there).
/**
 * Soft wrap: the camera never moves sideways, so a line wider than the screen
 * continues on the next row (indented 2 past its own indent, like IntelliJ's soft-wrap).
 * Pure, so the caret/row math is testable without rendering.
 */
export type Row = { line: number; a: number; b: number; indent: number };
export type Wrap = { rows: Row[]; firstRow: number[] };

export function wrapText(text: string, cols: number): Wrap {
  const rows: Row[] = [];
  const firstRow: number[] = [];
  text.split("\n").forEach((l, line) => {
    firstRow.push(rows.length);
    const lead = /^ */.exec(l)![0].length;
    const cont = Math.min(lead + 2, Math.floor(cols / 2));
    let a = 0;
    for (;;) {
      const indent = a === 0 ? 0 : cont;
      const width = cols - indent;
      if (l.length - a <= width) { rows.push({ line, a, b: l.length, indent }); break; }
      const b = breakAt(l, a === 0 ? lead : a, a + width) ?? a + width;
      rows.push({ line, a, b, indent });
      a = b;
    }
  });
  return { rows, firstRow };
}

/**
 * Last break point p in (from, max]: after a space, "(" or ",", or before a ".".
 * `from` skips the indent, so a row is never just whitespace. Undefined = hard break.
 */
function breakAt(l: string, from: number, max: number): number | undefined {
  for (let p = Math.min(max, l.length - 1); p > from; p--) {
    const prev = l[p - 1]!;
    if (prev === " " || prev === "(" || prev === "," || l[p] === ".") return p;
  }
  return undefined;
}

/** Visual row and x column of a caret at (line, col). */
export function caretRow(w: Wrap, line: number, col: number): { row: number; x: number } {
  const end = line + 1 < w.firstRow.length ? w.firstRow[line + 1]! : w.rows.length;
  let r = w.firstRow[line]!;
  while (r + 1 < end && w.rows[r + 1]!.a <= col) r++;
  const row = w.rows[r]!;
  return { row: r, x: row.indent + col - row.a };
}
