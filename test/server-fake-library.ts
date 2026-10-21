/**
 * An in-memory Library for the server tests, with controllable steps:
 * a step can be held open with a gate, and the fake counts how many steps
 * run at once per lane (lane limits are proven by counting, never timing).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  AddSourcesRequest, Brief, CreateVideoRequest, ExportRequest, JobKind, Lane, LibraryTree, PauseEdits, Peaks, SeriesOverview, Settings, ShortDocument, ShortPreview, ShortTake, SoundLibrary, StartCandidate, VideoDetail,
  VideoState, ValidationError,
} from "../shared/api.ts";
import type { Library, LibraryOptions, PlannedStep, PlanOptions, StepContext, Upload } from "../shared/library.ts";
import { createServer, type EmotonServer, type ServerOptions } from "../server/app.ts";
import { defaultSettings } from "../server/settings.ts";

export type Gate = { promise: Promise<void>; open(): void; fail(e: Error): void };
export function gate(): Gate {
  let open!: () => void, fail!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => ((open = res), (fail = rej)));
  promise.catch(() => {});
  return { promise, open, fail };
}

type FakeVideo = { id: string; folder: string; slug: string; brief: Brief; chapters: number; created: string };

/** Shared across Library instances of one test (a restart builds a new instance over the same "disk"). */
export class FakeWorld {
  videos = new Map<string, FakeVideo>();
  folders = new Set<string>([""]);
  /** Per video: the plan returned for a job kind (default: one outline step then two voice steps). */
  plan: (id: string, kind: Exclude<JobKind, "export">, opts: PlanOptions) => PlannedStep[] = (_id, kind, opts) =>
    kind === "make" && opts.pauseAfterOutline
      ? [{ stage: "outline", lane: "write" }]
      : [{ stage: "outline", lane: "write" }, { stage: "voice", chapter: 1, lane: "media" }, { stage: "voice", chapter: 2, lane: "media" }];
  planCalls: { id: string; kind: string; opts: PlanOptions }[] = [];
  voiceEdits: { id: string; n: number; edits: unknown }[] = [];
  slidesPdfCalls: string[] = [];
  /** Held steps: when set, runStep waits for this gate (or the abort signal). */
  hold: ((id: string, step: PlannedStep) => Gate | undefined) | null = null;
  /** When set, detail() waits for it (holds a request mid-flight). */
  detailGate: Gate | null = null;
  /** Extra per-step behaviour (runs after the default progress and log calls). */
  onStep: ((id: string, step: PlannedStep, ctx: StepContext) => void | Promise<void>) | null = null;
  /** Makes a step fail with this message. */
  failOn: ((id: string, step: PlannedStep) => string | undefined) | null = null;
  running: Record<Lane, number> = { write: 0, media: 0 };
  maxRunning: Record<Lane, number> = { write: 0, media: 0 };
  started: { id: string; step: PlannedStep }[] = [];
  finished: { id: string; step: PlannedStep }[] = [];
  aborted: { id: string; step: PlannedStep }[] = [];
  createCalls: { req: CreateVideoRequest; uploads?: { name: string; tmpPath: string; content: string }[] }[] = [];
  addSourceCalls: { id: string; req: AddSourcesRequest; uploads?: { name: string; tmpPath: string; content: string }[] }[] = [];
  exportCalls: ExportRequest[] = [];
  /** Short saves and pause renames, only recorded. */
  shortSaves: { id: string; document: unknown; revision: string }[] = [];
  shortRenames: { id: string; renames: unknown }[] = [];
  libraryOptions: LibraryOptions[] = [];
  seq = 0;

  constructor(public root: string) {
    mkdirSync(root, { recursive: true });
  }

  addVideo(id: string, over: Partial<FakeVideo> = {}, brief: Partial<Brief> = {}) {
    const v: FakeVideo = {
      id,
      folder: "",
      slug: id,
      chapters: 2,
      created: new Date(0).toISOString(),
      ...over,
      brief: {
        title: `Video ${id}`,
        topic: "t",
        audience: "a",
        minutes: 2,
        rules: [],
        voice: { engine: "kokoro", voice: "af_heart", speed: 1 },
        pronounce: {},
        writerModel: "opus",
        captions: true,
        layout: "stage",
        ...brief,
      } as Brief,
    };
    this.videos.set(id, v);
    mkdirSync(this.bundleDir(v), { recursive: true });
    return v;
  }

  bundleDir(v: FakeVideo) {
    return join(this.root, v.folder, `${v.slug}.emoton`);
  }
}

function uploadsWithContent(uploads?: Upload[]) {
  return uploads?.map((u) => ({ ...u, content: readFileSync(u.tmpPath, "utf8") }));
}

export class FakeLibrary implements Library {
  constructor(public world: FakeWorld, public readonly root: string) {}

  private v(id: string): FakeVideo {
    const v = this.world.videos.get(id);
    if (!v) throw new Error("unknown video");
    return v;
  }

  async state(id: string): Promise<VideoState> {
    const v = this.v(id);
    return {
      ingest: "ok",
      outline: "ok",
      join: "missing",
      chapters: Array.from({ length: v.chapters }, (_, i) => ({ n: i + 1, title: `Ch ${i + 1}`, storyboard: "ok", voice: "missing", render: "missing" })),
    };
  }

  async detail(id: string): Promise<VideoDetail> {
    if (this.world.detailGate) await this.world.detailGate.promise;
    const v = this.v(id);
    return {
      summary: {
        id: v.id, slug: v.slug, kind: "explainer", title: v.brief.title, folder: v.folder, status: "partial", minutes: v.brief.minutes,
        chapters: v.chapters, created: v.created, updated: v.created,
      },
      dir: this.world.bundleDir(v),
      brief: v.brief,
      sources: [],
      chapters: Array.from({ length: v.chapters }, () => null),
      state: await this.state(id),
    };
  }

  async tree(): Promise<LibraryTree> {
    const videos = await Promise.all([...this.world.videos.keys()].map(async (id) => (await this.detail(id)).summary));
    const node = (path: string): LibraryTree["tree"] => {
      const kids = [...this.world.folders].filter((f) => f !== path && f.startsWith(path ? path + "/" : "") && !f.slice(path ? path.length + 1 : 0).includes("/") && f !== "");
      const folders = kids.map(node);
      const direct = videos.filter((x) => x.folder === path).length;
      return { path, name: path.split("/").pop() || "Library", folders, videos: direct, total: direct + folders.reduce((a, f) => a + f.total, 0) };
    };
    return { root: this.root, tree: node(""), videos };
  }

  async createFolder(parent: string, name: string) {
    if (!this.world.folders.has(parent)) throw new Error("unknown folder");
    const p = parent ? `${parent}/${name}` : name;
    if (this.world.folders.has(p)) throw new Error("folder already exists");
    this.world.folders.add(p);
    return p;
  }

  async updateFolder(path: string, change: { name?: string; parent?: string }) {
    if (!this.world.folders.has(path)) throw new Error("unknown folder");
    const parent = change.parent ?? path.split("/").slice(0, -1).join("/");
    const name = change.name ?? path.split("/").pop()!;
    const np = parent ? `${parent}/${name}` : name;
    this.world.folders.delete(path);
    this.world.folders.add(np);
    for (const v of this.world.videos.values()) if (v.folder === path) v.folder = np;
    return np;
  }

  async trashFolder(path: string) {
    if (!this.world.folders.has(path)) throw new Error("unknown folder");
    this.world.folders.delete(path);
  }

  async createVideo(req: CreateVideoRequest, uploads?: Upload[]) {
    this.world.createCalls.push({ req, ...(uploads ? { uploads: uploadsWithContent(uploads) } : {}) });
    const id = `new${++this.world.seq}`;
    this.world.addVideo(id, { folder: req.folder }, { ...req.brief, title: req.brief.title ?? req.brief.topic });
    return this.detail(id);
  }

  async resolve(id: string) {
    return this.world.bundleDir(this.v(id));
  }

  async updateBrief(id: string, patch: Partial<Brief>) {
    const v = this.v(id);
    v.brief = { ...v.brief, ...patch };
    return this.detail(id);
  }

  async saveOutline(id: string, outline: unknown): Promise<VideoDetail | ValidationError> {
    this.v(id);
    if (!outline || typeof outline !== "object" || !("chapters" in outline)) return { errors: ["chapters: required"] };
    return this.detail(id);
  }

  async saveChapter(id: string, n: number, chapter: unknown): Promise<VideoDetail | ValidationError> {
    const v = this.v(id);
    if (n > v.chapters) throw new Error(`unknown chapter ${n}`);
    if (!chapter || typeof chapter !== "object" || !("beats" in chapter)) return { errors: ["beats: required"] };
    return this.detail(id);
  }

  async addSources(id: string, req: AddSourcesRequest, uploads?: Upload[]) {
    this.v(id);
    this.world.addSourceCalls.push({ id, req, ...(uploads ? { uploads: uploadsWithContent(uploads) } : {}) });
    return this.detail(id);
  }

  async removeSource(id: string, sourceId: string) {
    this.v(id);
    if (sourceId !== "m1") throw new Error("unknown source");
    return this.detail(id);
  }

  async moveVideo(id: string, folder: string) {
    const v = this.v(id);
    if (!this.world.folders.has(folder)) throw new Error("unknown folder");
    v.folder = folder;
    return this.detail(id);
  }

  async duplicateVideo(id: string) {
    const v = this.v(id);
    const nid = `${id}-copy${++this.world.seq}`;
    this.world.addVideo(nid, { folder: v.folder, slug: nid }, v.brief);
    return this.detail(nid);
  }

  async trashVideo(id: string) {
    this.v(id);
    this.world.videos.delete(id);
  }

  async previewProps(id: string, n: number) {
    const v = this.v(id);
    if (n > v.chapters) throw new Error(`unknown chapter ${n}`);
    return { chapter: n, timing: { audio: "" } };
  }

  async voice(id: string) {
    this.v(id);
    return { voice: { engine: "kokoro" as const, voice: "af_heart", speed: 1 }, chapters: [] };
  }

  async slidesPdf(id: string) {
    const v = this.v(id);
    const file = join(this.world.bundleDir(v), "slides.pdf");
    writeFileSync(file, "%PDF-1.7 fake");
    this.world.slidesPdfCalls.push(id);
    return file;
  }

  async saveVoiceEdits(id: string, n: number, edits: unknown) {
    const v = this.v(id);
    if (n > v.chapters) throw new Error(`unknown chapter ${n}`);
    if (!edits || typeof edits !== "object" || !("sentences" in edits)) return { errors: ["sentences: required"] };
    this.world.voiceEdits.push({ id, n, edits });
    const timing = { leadIn: 0, duration: 1, audio: "", beats: [] };
    return { n, title: `Chapter ${n}`, spoken: timing, timing, keys: [], edits: edits as PauseEdits, dropped: [] };
  }

  async createShort(): Promise<VideoDetail> {
    throw new Error("Shorts are not in the fake library");
  }
  async shortDocument(): Promise<ShortDocument> {
    throw new Error("Shorts are not in the fake library");
  }
  async saveShortDocument(id: string, document: unknown, revision: string): Promise<ShortDocument> {
    this.world.shortSaves.push({ id, document, revision });
    return { document: document as ShortDocument["document"], revision: `r${this.world.shortSaves.length}` };
  }
  async previewShort(): Promise<ShortPreview> {
    throw new Error("Shorts are not in the fake library");
  }
  async shortPeaks(): Promise<Peaks> {
    throw new Error("Shorts are not in the fake library");
  }
  async newShort(): Promise<VideoDetail> {
    throw new Error("Shorts are not in the fake library");
  }
  async dropShortProposal(): Promise<void> {
    throw new Error("Shorts are not in the fake library");
  }
  async seriesOverview(): Promise<SeriesOverview> {
    throw new Error("Shorts are not in the fake library");
  }
  async addShortMusic(): Promise<{ asset: string }> {
    throw new Error("Shorts are not in the fake library");
  }
  async addShortClips(): Promise<{ assets: string[] }> {
    throw new Error("Shorts are not in the fake library");
  }
  async searchShotStarts(): Promise<StartCandidate[]> {
    throw new Error("Shorts are not in the fake library");
  }
  async sounds(): Promise<SoundLibrary> {
    throw new Error("Shorts are not in the fake library");
  }
  async soundFile(): Promise<string | null> {
    return null;
  }
  async importSound(): Promise<{ asset: string }> {
    throw new Error("Shorts are not in the fake library");
  }
  async renameShortPauses(id: string, renames: unknown): Promise<void> {
    this.world.shortRenames.push({ id, renames });
  }
  async shortTakes(): Promise<ShortTake[]> {
    throw new Error("Shorts are not in the fake library");
  }
  async saveShortTake(): Promise<ShortTake> {
    throw new Error("Shorts are not in the fake library");
  }
  async restoreShortTake(): Promise<ShortDocument> {
    throw new Error("Shorts are not in the fake library");
  }

  async plan(id: string, kind: Exclude<JobKind, "export">, opts: PlanOptions = {}) {
    this.v(id);
    this.world.planCalls.push({ id, kind, opts });
    return this.world.plan(id, kind, opts);
  }

  async runStep(id: string, step: PlannedStep, ctx: StepContext) {
    const w = this.world;
    w.running[step.lane]++;
    w.maxRunning[step.lane] = Math.max(w.maxRunning[step.lane], w.running[step.lane]);
    w.started.push({ id, step });
    try {
      ctx.progress(0.5, "halfway");
      ctx.log(`fake ${step.stage}${step.chapter ?? ""}`);
      await w.onStep?.(id, step, ctx);
      const g = w.hold?.(id, step);
      if (g) {
        await new Promise<void>((res, rej) => {
          const onAbort = () => {
            w.aborted.push({ id, step });
            rej(new Error("aborted"));
          };
          if (ctx.signal.aborted) return onAbort();
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          g.promise.then(res, rej).finally(() => ctx.signal.removeEventListener("abort", onAbort));
        });
      }
      const msg = w.failOn?.(id, step);
      if (msg) throw new Error(msg);
      w.finished.push({ id, step });
    } finally {
      w.running[step.lane]--;
    }
  }

  async exportVideos(req: ExportRequest, ctx: StepContext) {
    this.world.exportCalls.push(req);
    ctx.progress(1);
    return req.formats.map((f) => join(req.dest, `out.${f}`));
  }

  async resolveMedia(id: string, rel: string) {
    const dir = this.world.bundleDir(this.v(id));
    const p = resolve(dir, rel);
    if (!p.startsWith(dir + sep)) return null;
    return existsSync(p) ? p : null;
  }
}

// ---------------------------------------------------------------- test server

export type TestServer = {
  app: EmotonServer;
  url: string;
  world: FakeWorld;
  tmp: string;
  settingsPath: string;
  api<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Headers }>;
  close(): Promise<void>;
};

/** A temp dir with a settings file pointing the library at a temp root. */
export function makeTmp(): { tmp: string; settingsPath: string; libraryRoot: string } {
  const tmp = mkdtempSync(join(tmpdir(), "emoton-srv-test-"));
  const libraryRoot = join(tmp, "library");
  const settingsPath = join(tmp, "settings.json");
  const s: Settings = { ...defaultSettings(), libraryRoot };
  writeFileSync(settingsPath, JSON.stringify(s));
  return { tmp, settingsPath, libraryRoot };
}

export async function startTestServer(
  o: { world?: FakeWorld; tmp?: ReturnType<typeof makeTmp>; server?: Partial<ServerOptions> } = {},
): Promise<TestServer> {
  const t = o.tmp ?? makeTmp();
  const world = o.world ?? new FakeWorld(t.libraryRoot);
  const app = await createServer({
    createLibrary: (opts) => {
      world.libraryOptions.push(opts);
      return new FakeLibrary(world, opts.root);
    },
    settingsPath: t.settingsPath,
    port: 0,
    repoRoot: join(t.tmp, "repo"),
    uiDir: join(t.tmp, "ui"),
    tmpDir: join(t.tmp, "uploads"),
    homeDir: t.tmp,
    voiceCacheDir: join(t.tmp, "voice-cache"),
    // the machine's own macOS voices would make voice lists differ per machine
    systemVoices: async () => [],
    // the fake speak.py writes no real WAV
    levelVoice: async () => {},
    log: () => {},
    ...o.server,
  });
  mkdirSync(join(t.tmp, "uploads"), { recursive: true });
  const port = await app.listen();
  const url = `http://127.0.0.1:${port}`;
  return {
    app,
    url,
    world,
    tmp: t.tmp,
    settingsPath: t.settingsPath,
    async api(method, path, body, headers = {}) {
      // bounded, so a request the server never answers fails the test instead of hanging it
      const init: RequestInit = { method, headers: { ...headers }, signal: AbortSignal.timeout(20_000) };
      if (body !== undefined) {
        init.body = typeof body === "string" || body instanceof FormData ? (body as BodyInit) : JSON.stringify(body);
        if (!(body instanceof FormData) && typeof body !== "string") (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
      const res = await fetch(url + path, init);
      const ct = res.headers.get("content-type") ?? "";
      const out = ct.includes("json") ? await res.json() : await res.text();
      return { status: res.status, body: out, headers: res.headers };
    },
    async close() {
      await app.close();
    },
  };
}

export function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/** Polls until fn returns a truthy value (bounded by a count, not asserted on time). */
export async function waitFor<T>(fn: () => T | Promise<T>, what = "condition", tries = 3000): Promise<NonNullable<T>> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Reads SSE frames from /api/events into an array until closed. */
export async function openEvents(url: string) {
  const ac = new AbortController();
  const res = await fetch(url + "/api/events", { signal: ac.signal });
  const events: any[] = [];
  const raw: string[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          raw.push(frame);
          const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    res,
    events,
    raw,
    async close() {
      ac.abort();
      await done;
    },
  };
}
