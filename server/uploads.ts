/** Multipart bodies (browser drops): a "request" JSON field plus "files" parts, saved to a temp dir. */
import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Writable } from "node:stream";
import type { Upload } from "../shared/library.ts";
import { errorMessage, HttpError } from "./http.ts";

export type Multipart = { request: unknown; uploads: Upload[]; dir: string; cleanup(): Promise<void> };

export type UploadOptions = {
  tmpRoot?: string;
  /** Bytes per file. Default 1 GB. */
  fileSize?: number;
  /** Files per request. Default 200. */
  files?: number;
  /** Test seam: opens the file a part is written to. */
  openFile?: (path: string) => Writable;
};

const GB = 1024 ** 3;
const MAX_NAME_BYTES = 200;

export function isMultipart(req: IncomingMessage) {
  return /^multipart\/form-data/i.test(req.headers["content-type"] ?? "");
}

/** Trims to at most `max` UTF-8 bytes (file systems limit bytes, not characters), keeping the extension. */
function trimBytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && Buffer.byteLength(name.slice(dot)) <= 20 ? name.slice(dot) : "";
  let stem = ext ? name.slice(0, dot) : name;
  const room = max - Buffer.byteLength(ext);
  while (Buffer.byteLength(stem) > room) stem = [...stem].slice(0, -1).join("");
  return stem + ext;
}

/** A file name safe to create in our temp dir (keeps the user's name where possible). */
export function safeName(name: string, taken: Set<string>): string {
  let n = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f/:]/g, "_").trim();
  if (!n || n === "." || n === "..") n = "file";
  n = trimBytes(n, MAX_NAME_BYTES);
  let out = n, i = 2;
  const dot = n.lastIndexOf(".");
  while (taken.has(out.toLowerCase())) out = dot > 0 ? `${n.slice(0, dot)} (${i++})${n.slice(dot)}` : `${n} (${i++})`;
  taken.add(out.toLowerCase());
  return out;
}

function writeError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new HttpError(507, `not enough disk space to save the upload (${errorMessage(e)})`);
  return new HttpError(500, `could not save the upload: ${errorMessage(e)}`);
}

export async function parseMultipart(req: IncomingMessage, o: UploadOptions = {}): Promise<Multipart> {
  const dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "emoton-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fileSize = o.fileSize ?? GB;
  const maxFiles = o.files ?? 200;
  const outs: Writable[] = [];
  try {
    const result = await new Promise<{ request: unknown; uploads: Upload[] }>((resolve, reject) => {
      let settled = false;
      // Every failure goes through here, at once: never a rejection that waits to be awaited.
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        for (const out of outs) out.destroy();
        req.unpipe(bb);
        req.resume(); // drain the rest of the body so the connection can answer
        reject(e);
      };
      let bb: busboy.Busboy;
      try {
        bb = busboy({
          headers: req.headers,
          defParamCharset: "utf8", // browsers send UTF-8 file names; busboy's default (latin1) garbles them
          limits: { fieldSize: 5 * 1024 * 1024, fileSize, files: maxFiles },
        });
      } catch (e) {
        return reject(new HttpError(400, `bad multipart body: ${errorMessage(e)}`));
      }
      const uploads: Upload[] = [];
      const writes: Promise<void>[] = [];
      const taken = new Set<string>();
      let requestField: string | undefined;
      bb.on("field", (name, value, info) => {
        if (info.valueTruncated) return fail(new HttpError(413, `the "${name}" field is too large`));
        if (name === "request") requestField = value;
      });
      bb.on("file", (name, stream, info) => {
        if (settled || name !== "files") {
          stream.resume();
          return;
        }
        const fname = safeName(info.filename || "file", taken);
        const tmpPath = join(dir, fname);
        uploads.push({ name: fname, tmpPath });
        const out = o.openFile ? o.openFile(tmpPath) : createWriteStream(tmpPath);
        outs.push(out);
        const done = new Promise<void>((res, rej) => {
          stream.on("limit", () => rej(new HttpError(413, `${fname} is larger than ${Math.round(fileSize / 1024 ** 2)} MB`)));
          stream.on("error", rej);
          out.on("error", rej);
          out.on("finish", () => res());
          stream.pipe(out);
        });
        done.catch((e) => {
          stream.resume();
          fail(writeError(e));
        });
        writes.push(done);
      });
      bb.on("filesLimit", () => fail(new HttpError(413, `too many files in one upload (at most ${maxFiles})`)));
      bb.on("fieldsLimit", () => fail(new HttpError(413, "too many fields in the upload")));
      bb.on("error", (e) => fail(new HttpError(400, `bad multipart body: ${errorMessage(e)}`)));
      bb.on("close", () => {
        Promise.all(writes).then(
          () => {
            if (settled) return;
            if (requestField === undefined) return fail(new HttpError(400, 'multipart body needs a "request" field with the JSON'));
            let request: unknown;
            try {
              request = JSON.parse(requestField);
            } catch {
              return fail(new HttpError(400, 'the "request" field is not valid JSON'));
            }
            settled = true;
            resolve({ request, uploads });
          },
          () => {}, // each write already reported through fail()
        );
      });
      req.on("aborted", () => fail(new HttpError(400, "upload aborted")));
      req.pipe(bb);
    });
    return { ...result, dir, cleanup };
  } catch (e) {
    // let destroyed file handles close before the directory goes (bounded: a stream that never closes must not hang the request)
    await Promise.race([
      Promise.all(outs.map((out) => new Promise<void>((r) => (out.closed ? r() : out.once("close", () => r()))))),
      new Promise<void>((r) => setTimeout(r, 2000).unref()),
    ]);
    await cleanup();
    throw e;
  }
}
