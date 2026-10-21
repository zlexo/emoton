/** Small HTTP helpers: JSON bodies, typed errors, a tiny router. No framework. */
import type { IncomingMessage, ServerResponse } from "node:http";

/** An error with an HTTP status. Thrown anywhere in a handler, answered as `{ error }`. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 422 with the ValidationError shape `{ errors }`. */
export class ValidationFailed extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

const MAX_JSON = 5 * 1024 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_JSON): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses a JSON body. An empty body is `{}`. */
export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  if (buf.length === 0) return {} as T;
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Maps an error to an HTTP status. A numeric `status` (lane A's LibraryError,
 * duck-typed) wins; otherwise the Node error code, then message heuristics.
 */
export function statusForError(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof ValidationFailed) return 422;
  const err = e as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  for (const s of [err?.status, err?.statusCode]) if (typeof s === "number" && s >= 400 && s < 600) return s;
  if (err?.code === "ENOENT") return 404;
  if (err?.code === "EEXIST" || err?.code === "ENOTEMPTY") return 409;
  const msg = typeof err?.message === "string" ? err.message : "";
  if (/\b(unknown|not found|no such|does not exist|missing)\b/i.test(msg)) return 404;
  if (/\b(already exists|exists|conflict|in use)\b/i.test(msg)) return 409;
  if (/\b(invalid|must|cannot|can't|not allowed|outside|empty|too long)\b/i.test(msg)) return 400;
  return 500;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export type Params = Record<string, string>;
export type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, url: URL) => Promise<void> | void;

type Route = { method: string; parts: string[]; handler: Handler };

/** Exact-segment router with `:name` params. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler) {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }

  /** Returns the handler and params, "method" when the path exists with another method, or null. */
  match(method: string, pathname: string): { handler: Handler; params: Params } | "method" | null {
    const segs = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i]!, s = segs[i]!;
        if (p.startsWith(":")) {
          try {
            params[p.slice(1)] = decodeURIComponent(s);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method || (method === "HEAD" && r.method === "GET")) return { handler: r.handler, params };
    }
    return pathMatched ? "method" : null;
  }
}
