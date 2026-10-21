/**
 * In-memory stand-in for the server, for designing the UI without it.
 * On with ?mock=1 (remembered for the tab). Never used in the app build
 * unless that flag is set.
 */
import type {
  Brief, ChapterTiming, DoctorCheck, FolderNode, Job, LibraryTree, ServerEvent, Settings,
  VideoDetail, VideoSummary, VoiceOption,
} from "./types.ts";
import type { Chapter, Outline } from "../../../schema/storyboard.ts";
import storyboard from "./mock-data/storyboard.json";
import outline from "./mock-data/outline.json";
import timings from "./mock-data/timings.json";
import { estimateTiming } from "../../../src/core/estimate.ts";

export function useMock(): boolean {
  try {
    if (new URLSearchParams(location.search).has("mock")) sessionStorage.setItem("emoton-mock", "1");
    return sessionStorage.getItem("emoton-mock") === "1";
  } catch {
    return false;
  }
}

const now = Date.now();
const iso = (minsAgo: number) => new Date(now - minsAgo * 60000).toISOString();
const brief = (title: string, topic: string, minutes = 5): Brief => ({
  title, topic, minutes, audience: "A curious developer", rules: [], captions: true, layout: "slides",
  voice: { engine: "kokoro", voice: "af_heart", speed: 1 }, pronounce: { JSON: "jay-son" }, writerModel: "opus",
});

type MockVideo = { summary: VideoSummary; brief: Brief; outline?: Outline; chapters: (Chapter | null)[] };
const chapters = (storyboard as { chapters: Chapter[] }).chapters;

const videos: MockVideo[] = [
  {
    summary: { id: "v1", slug: "sources-in-video-out", kind: "explainer", title: "Sources in, video out", folder: "Docs", status: "ready", minutes: 5, duration: 315.3, chapters: 4, created: iso(300), updated: iso(20) },
    brief: brief("Sources in, video out", "How Emoton turns sources into a narrated, animated explainer video."),
    outline: outline as Outline,
    chapters,
  },
  {
    summary: { id: "v2", slug: "hash-tables", kind: "explainer", title: "How a hash table grows", folder: "Docs/Data structures", status: "making", minutes: 6, chapters: 5, created: iso(90), updated: iso(2), job: { id: "j1", kind: "make", status: "running", progress: 0.62, detail: "Rendering chapter 2 of 5, 43%" } },
    brief: brief("How a hash table grows", "Load factor, resizing and why inserts stay cheap on average", 6),
    chapters: [],
  },
  {
    summary: { id: "v3", slug: "tcp-handshake", kind: "explainer", title: "The TCP three-way handshake", folder: "Networks", status: "outline-review", minutes: 4, chapters: 4, created: iso(40), updated: iso(12) },
    brief: brief("The TCP three-way handshake", "SYN, SYN-ACK, ACK, and what each one proves", 4),
    outline: outline as Outline,
    chapters: [],
  },
  {
    summary: { id: "v4", slug: "float-drift", kind: "explainer", title: "Why floating point drifts", folder: "Math", status: "failed", minutes: 3, chapters: 3, created: iso(2000), updated: iso(1500) },
    brief: brief("Why floating point drifts", "Why 0.1 + 0.2 is not 0.3, and when that matters", 3),
    chapters: [],
  },
  {
    summary: { id: "v5", slug: "lambda", kind: "explainer", title: "Why the Y combinator loops", folder: "Math", status: "draft", minutes: 5, chapters: 0, created: iso(4000), updated: iso(4000) },
    brief: brief("Why the Y combinator loops", "Fixed-point combinators in the untyped lambda calculus"),
    chapters: [],
  },
];
const folders = ["Docs", "Docs/Data structures", "Docs/Drafts", "Math", "Networks"];

function tree(): LibraryTree {
  const build = (path: string, name: string): FolderNode => {
    const kids = folders.filter((f) => f.startsWith(path ? path + "/" : "") && f.slice(path ? path.length + 1 : 0).split("/").length === 1 && f !== path);
    const direct = videos.filter((v) => v.summary.folder === path).length;
    const total = videos.filter((v) => v.summary.folder === path || v.summary.folder.startsWith(path ? path + "/" : "")).length;
    return { path, name, videos: direct, total: path ? total : videos.length, folders: kids.map((k) => build(k, k.split("/").pop()!)) };
  };
  return { root: "/Users/you/Emoton", tree: build("", "Library"), videos: videos.map((v) => v.summary) };
}

function detail(v: MockVideo): VideoDetail {
  const ready = v.summary.status === "ready";
  const n = v.outline?.chapters.length ?? 0;
  return {
    summary: v.summary,
    dir: `/Users/you/Emoton/${v.summary.folder}/${v.summary.slug}.emoton`,
    brief: v.brief,
    sources: [
      { id: "readme", title: "README", kind: "text", ref: "sources/README.md", chunks: 3 },
      { id: "schema", title: "Storyboard schema", kind: "text", ref: "sources/storyboard.ts", chunks: 6 },
    ],
    outline: v.outline,
    chapters: v.chapters,
    state: {
      ingest: "ok", outline: v.outline ? "ok" : "missing", join: ready ? "ok" : "missing",
      chapters: Array.from({ length: n }, (_, i) => ({
        n: i + 1, title: v.outline!.chapters[i]!.title,
        storyboard: v.chapters[i] ? "ok" : "missing", voice: ready ? (i === 3 ? "stale" : "ok") : "missing", render: ready ? (i === 3 ? "stale" : "ok") : "missing",
        duration: ready ? (timings as Record<string, ChapterTiming>)[String(i + 1)]!.duration : undefined,
      })),
    },
    video: ready ? "/mock-video.mp4" : undefined,
    markers: ready ? [0, 1, 2, 3].reduce<{ title: string; start: number; end: number }[]>((acc, i) => {
      const d = (timings as Record<string, ChapterTiming>)[String(i + 1)]!.duration;
      const start = acc.length ? acc[acc.length - 1]!.end : 0;
      acc.push({ title: chapters[i]!.title, start, end: start + d });
      return acc;
    }, []) : undefined,
  };
}

const jobs: Job[] = [
  {
    id: "j1", videoId: "v2", videoTitle: "How a hash table grows", kind: "make", status: "running", progress: 0.62, createdAt: iso(30), startedAt: iso(30), log: ["render ch1: done", "render ch2: 43%"],
    steps: [
      { stage: "ingest", lane: "write", status: "done", progress: 1 }, { stage: "outline", lane: "write", status: "done", progress: 1 },
      { stage: "storyboard", chapter: 1, lane: "write", status: "done", progress: 1 }, { stage: "voice", chapter: 1, lane: "media", status: "done", progress: 1 },
      { stage: "render", chapter: 2, lane: "media", status: "running", progress: 0.43, detail: "Rendering chapter 2 of 5, 43%" }, { stage: "join", lane: "media", status: "pending", progress: 0 },
    ],
  },
  {
    id: "j0", videoId: "v4", videoTitle: "Why floating point drifts", kind: "make", status: "failed", progress: 0.4, createdAt: iso(1600), endedAt: iso(1500), error: "voice: speak.py exited 1", log: [],
    steps: [{ stage: "voice", chapter: 2, lane: "media", status: "failed", progress: 0.2 }],
  },
];

let settings: Settings = {
  libraryRoot: "/Users/you/Emoton",
  soundsRoot: "/Users/you/Emoton Sounds",
  defaults: { voice: { engine: "kokoro", voice: "af_heart", speed: 1 }, minutes: 5, writerModel: "opus", audience: "A curious university student", captions: true },
  pauseAfterOutlineOverMinutes: 3, renderQuality: "1080p", pronounce: { JSON: "jay-son", LLM: "L L M" },
  stylePresets: [{ name: "Concepts only", rules: ["Explain the idea; never show a full worked solution."] }],
};

const doctor: DoctorCheck[] = [
  { id: "node", label: "Node.js", level: "ok", detail: "v24.14.1" },
  { id: "ffmpeg", label: "ffmpeg", level: "ok", detail: "/opt/homebrew/bin/ffmpeg" },
  { id: "pdftotext", label: "pdftotext", level: "ok", detail: "/opt/homebrew/bin/pdftotext" },
  { id: "yt-dlp", label: "yt-dlp (YouTube sources)", level: "warn", detail: "not installed", fix: "brew install yt-dlp" },
  { id: "claude-login", label: "Writer login", level: "ok", detail: "logged in with claude.ai" },
  { id: "python-tts", label: "Voice engine", level: "ok", detail: "kokoro-onnx in tts/.venv" },
  { id: "voice-model", label: "Voice model", level: "ok", detail: "kokoro-v1.0.int8.onnx, voices-v1.0.bin" },
  { id: "render-browser", label: "Render browser", level: "ok", detail: "chrome-headless-shell present" },
  { id: "disk", label: "Free disk", level: "warn", detail: "9.8 GB free on the library disk", fix: "Free up space; renders need about 1 GB" },
  { id: "library", label: "Library", level: "ok", detail: "/Users/you/Emoton" },
];

const voices: VoiceOption[] = [
  { engine: "kokoro", voice: "af_heart", label: "Heart", accent: "US", gender: "f", group: "Recommended", timed: true },
  { engine: "kokoro", voice: "af_bella", label: "Bella", accent: "US", gender: "f", group: "Recommended", timed: true },
  { engine: "kokoro", voice: "am_michael", label: "Michael", accent: "US", gender: "m", group: "Recommended", timed: true },
  { engine: "kokoro", voice: "bf_emma", label: "Emma", accent: "UK", gender: "f", group: "Recommended", timed: true },
  { engine: "kokoro", voice: "bm_george", label: "George", accent: "UK", gender: "m", group: "Recommended", timed: true },
  { engine: "say", voice: "default", label: "macOS voice", accent: "system", group: "Recommended", timed: false },
];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const find = (id: string) => videos.find((v) => v.summary.id === id);

export async function mockFetch(method: string, path: string, body?: unknown): Promise<Response> {
  await new Promise((r) => setTimeout(r, 60));
  const p = path.split("?")[0]!;
  let m: RegExpMatchArray | null;
  if (p === "/api/health") return json({ ok: true, protocol: 1, version: "mock", gitHash: "mock", pid: 0, libraryRoot: settings.libraryRoot });
  if (p === "/api/library") return json(tree());
  if (p === "/api/jobs" && method === "GET") return json(jobs);
  if (p === "/api/settings") {
    if (method === "PUT") settings = body as Settings;
    return json(settings);
  }
  if (p === "/api/doctor") return json(doctor);
  if (p === "/api/voices") return json(voices);
  if (p === "/api/folders" && method === "POST") {
    const b = body as { parent: string; name: string };
    const path2 = b.parent ? `${b.parent}/${b.name}` : b.name;
    folders.push(path2);
    emit({ type: "library" });
    return json({ path: path2 });
  }
  if ((m = p.match(/^\/api\/videos\/(\w+)\/voice$/))) return json({ voice: { engine: "kokoro", voice: "af_heart", speed: 1 }, chapters: [] });
  if ((m = p.match(/^\/api\/videos\/(\w+)\/preview\/(\d+)$/))) {
    const v = find(m[1]!)!;
    const n = Number(m[2]);
    const ch = v.chapters[n - 1]!;
    const t = v.summary.status === "ready" ? (timings as Record<string, ChapterTiming>)[String(n)]! : estimateTiming(ch);
    return json({ videoTitle: v.summary.title, index: n, count: v.chapters.length, chapter: ch, timing: t, sources: { readme: "README", schema: "Storyboard schema" }, captions: true });
  }
  if ((m = p.match(/^\/api\/videos\/(\w+)$/)) && method === "GET") {
    const v = find(m[1]!);
    return v ? json(detail(v)) : json({ error: "unknown video" }, 404);
  }
  if ((m = p.match(/^\/api\/videos\/(\w+)\/move$/))) {
    const v = find(m[1]!)!;
    v.summary.folder = (body as { folder: string }).folder;
    emit({ type: "library" });
    return json(detail(v));
  }
  if (p === "/api/videos" && method === "POST") {
    const req = body instanceof FormData ? JSON.parse(String(body.get("request"))) : body;
    const id = `v${videos.length + 1}`;
    const topic = req.brief.topic as string;
    const v: MockVideo = {
      summary: { id, slug: id, kind: "explainer", title: req.brief.title || topic.split(/\s+/).slice(0, 6).join(" "), folder: req.folder, status: "draft", minutes: req.brief.minutes ?? 5, chapters: 0, created: new Date().toISOString(), updated: new Date().toISOString() },
      brief: { ...brief("", topic), ...req.brief }, chapters: [],
    };
    videos.unshift(v);
    emit({ type: "library" });
    return json(detail(v));
  }
  if (p === "/api/jobs" && method === "POST") {
    const req = body as { videoId: string; kind: Job["kind"] };
    const v = find(req.videoId)!;
    const job: Job = { id: `j${jobs.length + 1}`, videoId: req.videoId, videoTitle: v.summary.title, kind: req.kind, status: "running", progress: 0, createdAt: new Date().toISOString(), log: [], steps: [{ stage: "outline", lane: "write", status: "running", progress: 0 }] };
    jobs.unshift(job);
    v.summary.status = "making";
    v.summary.job = { id: job.id, kind: job.kind, status: "running", progress: 0 };
    emit({ type: "job", job });
    emit({ type: "library" });
    return json(job);
  }
  if ((m = p.match(/^\/api\/jobs\/(\w+)\/cancel$/))) {
    const j = jobs.find((x) => x.id === m![1])!;
    j.status = "cancelled";
    emit({ type: "job", job: j });
    return json(j);
  }
  return json({ error: `mock: ${method} ${p} not implemented` }, 501);
}

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
function emit(e: ServerEvent) {
  setTimeout(() => listeners.forEach((l) => l(e)), 10);
}
export function mockEvents(l: Listener): () => void {
  listeners.add(l);
  l({ type: "hello", protocol: 1, version: "mock" });
  // The running mock job ticks forward.
  const t = setInterval(() => {
    const j = jobs[0];
    if (!j || j.status !== "running") return;
    j.progress = Math.min(0.99, j.progress + 0.01);
    const step = j.steps.find((s) => s.status === "running");
    if (step) {
      step.progress = Math.min(0.99, step.progress + 0.03);
      step.detail = `Rendering chapter 2 of 5, ${Math.round(step.progress * 100)}%`;
    }
    const v = find(j.videoId);
    if (v?.summary.job) v.summary.job = { ...v.summary.job, progress: j.progress, detail: step?.detail };
    l({ type: "job", job: structuredClone(j) });
  }, 1000);
  return () => {
    listeners.delete(l);
    clearInterval(t);
  };
}
