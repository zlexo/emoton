/** `npm run server`: the Emoton server on 127.0.0.1:8891 (EMOTON_PORT overrides). */
import { createLibrary } from "../library/index.ts";
import { createServer } from "./app.ts";
import { augmentPath } from "./doctor.ts";

process.env.PATH = augmentPath(process.env.PATH ?? "");

// Never silent: a stray rejection (e.g. from a request handler) is logged and the server keeps serving.
process.on("unhandledRejection", (reason) => {
  console.error(`unhandled rejection (still serving): ${(reason as Error)?.stack ?? String(reason)}`);
});

const app = await createServer({ createLibrary });

try {
  const port = await app.listen();
  console.log(`Emoton server on http://localhost:${port} (pid ${process.pid}, library ${app.settings().libraryRoot})`);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === "EADDRINUSE") console.error(`Port in use: another Emoton server (or something else) is listening. Set EMOTON_PORT to use another port.`);
  else console.error(`Could not start the server: ${err.message}`);
  await app.close();
  process.exit(1);
}

let stopping = false;
async function stop(why: string, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`${why}: stopping (running jobs are saved and resume as interrupted)`);
  const force = setTimeout(() => process.exit(code || 1), 10_000);
  force.unref();
  await app.close().catch((e) => console.error(`close failed: ${(e as Error).message}`));
  process.exit(code);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
// Spawned by the app with a pipe on stdin: when the app goes away (even killed), the pipe closes and we stop.
if (process.env.EMOTON_PARENT_PIPE === "1") {
  process.stdin.on("end", () => void stop("parent app gone"));
  process.stdin.on("close", () => void stop("parent app gone"));
  process.stdin.resume();
}
// A thrown exception leaves unknown state: log it, save jobs (they resume as interrupted), exit non-zero.
process.on("uncaughtException", (err) => {
  console.error(`uncaught exception: ${err.stack ?? err.message}`);
  void stop("uncaughtException", 1);
});
