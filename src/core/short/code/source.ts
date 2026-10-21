// Ported unchanged from Code Typer (src/source.ts there). The privacy scan is pipeline/safety.ts.
/** Turn a real .java (or C++) file into what reads well on a phone. Pure, no fs. */
export function cleanJava(text: string, keepImports = false, keepComments = false): string {
  let src = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  if (!keepComments) {
    // Block comments that start a line (javadoc, headers), then full-line // comments.
    // Trailing // comments stay: cutting them safely needs a string-aware lexer.
    src = src.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*\n/gm, "");
    src = src.replace(/^[ \t]*\/\/.*\n/gm, "");
  }
  let lines = src.split("\n");
  if (!keepImports) {
    lines = lines.filter((l) => !/^\s*(package|import)\s[\w.*\s]+;\s*$/.test(l) && !/^\s*#\s*(include|pragma\s+once)\b/.test(l));
    // Leading license/blank block left behind once imports are gone.
    while (lines.length && (lines[0]!.trim() === "" || /^\s*(\/\*|\*|\/\/)/.test(lines[0]!))) {
      if (/^\s*\/\*\*/.test(lines[0]!)) break; // keep a class javadoc
      lines.shift();
    }
  }
  // 4-space indent → 2: Java nests deep and the phone is 46 columns wide.
  lines = lines.map((l) => {
    const m = /^( +)/.exec(l);
    return m ? " ".repeat(Math.floor(m[1]!.length / 2)) + l.slice(m[1]!.length) : l;
  });
  // Collapse runs of blank lines.
  const out: string[] = [];
  for (const l of lines) {
    const blank = l.trim() === "";
    if (blank && out.length && out[out.length - 1]!.trim() === "") continue;
    out.push(blank ? "" : l.replace(/\s+$/, ""));
  }
  return out.join("\n").trim() + "\n";
}
