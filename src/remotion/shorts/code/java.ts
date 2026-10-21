// Ported unchanged from Code Typer (src/remotion/java.ts there).
import { Prism } from "prism-react-renderer";

/** prism-react-renderer ships no Java grammar; this is enough for highlighting on a phone. */
if (!Prism.languages.java) {
  Prism.languages.java = Prism.languages.extend("clike", {
    keyword: /\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|record|return|sealed|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|var|void|volatile|while|yield)\b/,
    boolean: /\b(?:true|false|null)\b/,
    number: /\b0x[\da-f_]+\b|(?:\b\d[\d_]*\.?[\d_]*|\B\.\d[\d_]*)(?:e[+-]?\d+)?[dfl]?/i,
    "class-name": /\b[A-Z][A-Za-z0-9_]*\b/,
    function: /\b[a-z_]\w*(?=\s*\()/,
  });
  Prism.languages.insertBefore("java", "keyword", { annotation: { pattern: /@\w+/, alias: "punctuation" } });
}

export type Tok = { text: string; kind: string };

function flatten(tokens: (string | Prism.Token)[], kind: string, out: Tok[]) {
  for (const t of tokens) {
    if (typeof t === "string") out.push({ text: t, kind });
    else if (typeof t.content === "string") out.push({ text: t.content, kind: t.type === "annotation" ? "annotation" : t.type });
    else flatten(Array.isArray(t.content) ? t.content : [t.content], t.type, out);
  }
}

const cache = new Map<string, Tok[][]>();

/** C and C++ files by their extension get Prism's C++ grammar, everything else the Java one above. */
const grammarFor = (name: string) => (/\.(c|cc|cpp|cxx|h|hh|hpp)$/i.test(name) ? Prism.languages.cpp! : Prism.languages.java!);

/** Tokens per line, cached per file text (computed once per browser tab, reused every frame). */
export function linesOf(text: string, name = ""): Tok[][] {
  const key = `${grammarFor(name) === Prism.languages.cpp ? "cpp" : "java"}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const flat: Tok[] = [];
  flatten(Prism.tokenize(text, grammarFor(name)), "plain", flat);
  const lines: Tok[][] = [[]];
  for (const tk of flat) {
    const parts = tk.text.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1]!.push({ text: p, kind: tk.kind });
    });
  }
  cache.set(key, lines);
  return lines;
}
