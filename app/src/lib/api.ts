import type {
  AddSourcesRequest, Brief, CreateVideoRequest, DoctorCheck, ExportRequest, Health, Job, JobRequest,
  ChapterVoice, LibraryTree, NewShortRequest, PauseEdits, Peaks, PerdixTools, Series, SeriesOverview, Settings, ShortDocument, ShortPreview, ShortTake, SoundLibrary, StartCandidate, VideoDetail, VideoVoice, VoiceOption, Voice, ValidationError,
} from "../../../shared/api.ts";
import type { ChapterProps } from "../../../src/remotion/ChapterVideo.tsx";
import { mockFetch, useMock } from "./mock.ts";

export class ApiError extends Error {
  constructor(public status: number, message: string, public errors?: string[]) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = useMock() ? await mockFetch(method, path, body) : await fetch(path, init);
  if (res.ok) {
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("json") ? await res.json() : await res.blob()) as T;
  }
  let msg = `${res.status} ${res.statusText}`;
  let errors: string[] | undefined;
  try {
    const j = (await res.json()) as { error?: string } & Partial<ValidationError>;
    if (j.error) msg = j.error;
    if (j.errors) {
      errors = j.errors;
      msg = j.errors.join("\n");
    }
  } catch {
    /* not json */
  }
  throw new ApiError(res.status, msg, errors);
}

const enc = encodeURIComponent;

export const api = {
  health: () => call<Health>("GET", "/api/health"),
  doctor: () => call<DoctorCheck[]>("GET", "/api/doctor"),
  doctorFix: (action: string) => call<DoctorCheck[]>("POST", "/api/doctor/fix", { action }),
  library: () => call<LibraryTree>("GET", "/api/library"),
  createFolder: (parent: string, name: string) => call<{ path: string }>("POST", "/api/folders", { parent, name }),
  updateFolder: (path: string, change: { name?: string; parent?: string }) => call<{ path: string }>("PATCH", "/api/folders", { path, ...change }),
  trashFolder: (path: string) => call<unknown>("DELETE", `/api/folders?path=${enc(path)}`),
  createVideo: (req: CreateVideoRequest, files: File[] = []) => {
    if (!files.length) return call<VideoDetail>("POST", "/api/videos", req);
    const fd = new FormData();
    fd.append("request", JSON.stringify(req));
    for (const f of files) fd.append("files", f, f.name);
    return call<VideoDetail>("POST", "/api/videos", fd);
  },
  video: (id: string) => call<VideoDetail>("GET", `/api/videos/${id}`),
  updateBrief: (id: string, patch: Partial<Brief>) => call<VideoDetail>("PATCH", `/api/videos/${id}/brief`, patch),
  saveOutline: (id: string, outline: unknown) => call<VideoDetail>("PUT", `/api/videos/${id}/outline`, outline),
  saveChapter: (id: string, n: number, chapter: unknown) => call<VideoDetail>("PUT", `/api/videos/${id}/chapters/${n}`, chapter),
  addSources: (id: string, req: AddSourcesRequest, files: File[] = []) => {
    if (!files.length) return call<VideoDetail>("POST", `/api/videos/${id}/sources`, req);
    const fd = new FormData();
    fd.append("request", JSON.stringify(req));
    for (const f of files) fd.append("files", f, f.name);
    return call<VideoDetail>("POST", `/api/videos/${id}/sources`, fd);
  },
  removeSource: (id: string, sourceId: string) => call<VideoDetail>("DELETE", `/api/videos/${id}/sources/${enc(sourceId)}`),
  moveVideo: (id: string, folder: string) => call<VideoDetail>("POST", `/api/videos/${id}/move`, { folder }),
  duplicateVideo: (id: string) => call<VideoDetail>("POST", `/api/videos/${id}/duplicate`),
  trashVideo: (id: string) => call<unknown>("DELETE", `/api/videos/${id}`),
  preview: (id: string, n: number) => call<ChapterProps>("GET", `/api/videos/${id}/preview/${n}`),
  voice: (id: string) => call<VideoVoice>("GET", `/api/videos/${id}/voice`),
  slidesPdf: (id: string) => call<Blob>("GET", `/api/videos/${id}/slides.pdf`),
  saveVoiceEdits: (id: string, n: number, edits: PauseEdits) => call<ChapterVoice>("PUT", `/api/videos/${id}/voice/${n}`, edits),
  shortDocument: (id: string) => call<ShortDocument>("GET", `/api/shorts/${id}/document`),
  saveShortDocument: (id: string, document: unknown, revision: string) => call<ShortDocument>("PUT", `/api/shorts/${id}/document`, { document, revision }),
  shortPreview: (id: string) => call<ShortPreview>("GET", `/api/shorts/${id}/preview`),
  shortPeaks: (id: string, track: "voice" | "music") => call<Peaks>("GET", `/api/shorts/${id}/peaks/${track}`),
  shortTakes: (id: string) => call<ShortTake[]>("GET", `/api/shorts/${id}/takes`),
  sounds: () => call<SoundLibrary>("GET", "/api/sounds"),
  dropShortProposal: (id: string) => call<{ ok: true }>("DELETE", `/api/shorts/${id}/ask`),
  newShort: (req: NewShortRequest) => call<VideoDetail>("POST", "/api/shorts", req),
  series: () => call<Series[]>("GET", "/api/series"),
  seriesOverview: (id: string) => call<SeriesOverview>("GET", `/api/series/${id}`),
  perdixKinds: () => call<{ kinds: Record<string, { about: string; knobs: Record<string, { default: number; unit?: string; min?: number; max?: number; step?: number; switch?: boolean; time?: boolean; about?: string }> }>; searches: Record<string, { for: string[]; about: string }> }>("GET", "/api/perdix/kinds"),
  perdixTools: () => call<PerdixTools>("GET", "/api/perdix/tools"),
  buildPerdixTool: (commit: string) => call<PerdixTools>("POST", "/api/perdix/tools", { commit }),
  searchShotStarts: (id: string, scene: string) => call<StartCandidate[]>("POST", `/api/shorts/${id}/shots/${scene}/search`),
  addShortMusic: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("request", "{}");
    fd.append("files", file, file.name);
    return call<{ asset: string }>("POST", `/api/shorts/${id}/music`, fd);
  },
  addShortClips: (id: string, files: File[]) => {
    const fd = new FormData();
    fd.append("request", "{}");
    for (const f of files) fd.append("files", f, f.name);
    return call<{ assets: string[] }>("POST", `/api/shorts/${id}/clips`, fd);
  },
  importSound: (id: string, path: string) => call<{ asset: string }>("POST", `/api/shorts/${id}/sounds`, { path }),
  renameShortPauses: (id: string, renames: { from: string; to: string; words?: number }[]) => call<{ ok: true }>("POST", `/api/shorts/${id}/voice/rename`, { renames }),
  saveShortTake: (id: string, name: string) => call<ShortTake>("POST", `/api/shorts/${id}/takes`, { name }),
  restoreShortTake: (id: string, name: string, revision: string) => call<ShortDocument>("POST", `/api/shorts/${id}/takes/restore`, { name, revision }),
  jobs: () => call<Job[]>("GET", "/api/jobs"),
  startJob: (req: JobRequest) => call<Job>("POST", "/api/jobs", req),
  cancelJob: (id: string) => call<Job>("POST", `/api/jobs/${id}/cancel`),
  resumeJob: (id: string) => call<Job>("POST", `/api/jobs/${id}/resume`),
  exportVideos: (req: ExportRequest) => call<Job>("POST", "/api/export", req),
  voices: () => call<VoiceOption[]>("GET", "/api/voices"),
  voiceSample: (voice: Voice, text?: string) => call<Blob>("POST", "/api/voices/sample", { voice, text }),
  settings: () => call<Settings>("GET", "/api/settings"),
  saveSettings: (s: Settings) => call<Settings>("PUT", "/api/settings", s),
  listDir: (dir?: string) => call<{ dir: string; entries: { name: string; dir: boolean }[] }>("GET", `/api/fs/list${dir ? `?dir=${enc(dir)}` : ""}`),
};
