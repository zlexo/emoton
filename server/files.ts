/** File responses: Content-Type, HTTP Range (206) for media, the built UI with SPA fallback. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Parses a single `bytes=` range (RFC 9110). null = send the whole file (no
 * header, a malformed or reversed range, several ranges); "invalid" = a
 * well-formed range that cannot be satisfied (416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const n = Number(b);
    if (n === 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (b !== "" && Number(b) < start) return null; // reversed: ignore the header
  if (start >= size) return "invalid";
  return { start, end: b === "" ? size - 1 : Math.min(Number(b), size - 1) };
}

/** Sends a file, honouring Range. The caller has already decided the path is allowed. */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  abs: string,
  extraHeaders: Record<string, string> = {},
): Promise<boolean> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const size = st.size;
  const headers: Record<string, string | number> = {
    "Content-Type": contentType(abs),
    "Accept-Ranges": "bytes",
    "Last-Modified": st.mtime.toUTCString(),
    ...extraHeaders,
  };
  const range = parseRange(req.headers.range, size);
  if (range === "invalid") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
    res.end();
    return true;
  }
  const head = req.method === "HEAD";
  if (range) {
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": range.end - range.start + 1 });
    if (head) return void res.end(), true;
    pipeFile(abs, res, range.start, range.end);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (head || size === 0) return void res.end(), true;
    pipeFile(abs, res, 0, size - 1);
  }
  return true;
}

function pipeFile(abs: string, res: ServerResponse, start: number, end: number) {
  const s = createReadStream(abs, { start, end });
  s.on("error", () => res.destroy());
  res.on("close", () => s.destroy());
  s.pipe(res);
}

/** Resolves `rel` inside `root`; null if it would escape. */
export function safeJoin(root: string, rel: string): string | null {
  const base = resolve(root);
  const p = resolve(join(base, normalize("/" + rel)));
  return p === base || p.startsWith(base + sep) ? p : null;
}

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Emoton</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
code{background:#222;padding:2px 6px;border-radius:4px}</style></head>
<body><div><h1>Emoton</h1><p>UI not built: run <code>npm run ui:build</code></p><p>The server is running; the API is at <code>/api/health</code>.</p></div></body></html>
`;

/** The built UI. Unknown paths without a file extension get index.html (SPA routes). */
export async function sendUi(req: IncomingMessage, res: ServerResponse, uiDir: string, pathname: string) {
  const index = join(uiDir, "index.html");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const file = safeJoin(uiDir, decoded);
  if (file && file !== resolve(uiDir)) {
    const cache = decoded.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    if (await sendFile(req, res, file, { "Cache-Control": cache })) return;
  }
  if (extname(decoded) && extname(decoded) !== ".html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  if (await sendFile(req, res, index, { "Cache-Control": "no-cache" })) return;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : NOT_BUILT);
}
