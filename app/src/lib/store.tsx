import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import { mockEvents, useMock } from "./mock.ts";
import { notify, reveal } from "./native.ts";
import type { DoctorCheck, Job, LibraryTree, ServerEvent, Settings, VideoDetail } from "./types.ts";

type Toast = { id: number; text: string; tone: "info" | "error" | "ok"; action?: { label: string; run: () => void } };

type Store = {
  tree: LibraryTree | null;
  jobs: Job[];
  settings: Settings | null;
  doctor: DoctorCheck[] | null;
  refreshDoctor(): Promise<void>;
  connected: boolean;
  refreshLibrary(): Promise<void>;
  setSettings(s: Settings): void;
  toast(text: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  toasts: Toast[];
  dismiss(id: number): void;
  /** Increments whenever video `id` may have changed. */
  videoVersion(id: string): number;
};

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("no store");
  return s;
};

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [tree, setTree] = useState<LibraryTree | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const jobsRef = useRef<Job[]>([]);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [versions, setVersions] = useState<Record<string, number>>({});
  const seq = useRef(0);
  const libTimer = useRef<number | undefined>(undefined);

  const refreshLibrary = useCallback(async () => {
    try {
      setTree(await api.library());
    } catch (e) {
      console.error(e);
    }
  }, []);
  const bump = useCallback((id: string) => setVersions((v) => ({ ...v, [id]: (v[id] ?? 0) + 1 })), []);
  const toast = useCallback((text: string, tone: Toast["tone"] = "info", action?: Toast["action"]) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone, action }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 9000 : 5000);
  }, []);

  const refreshDoctor = useCallback(async () => {
    try {
      setDoctor(await api.doctor());
    } catch {
      /* server down: the reconnect banner covers it */
    }
  }, []);
  useEffect(() => {
    void refreshDoctor();
    const t = window.setInterval(() => void refreshDoctor(), 60000);
    return () => window.clearInterval(t);
  }, [refreshDoctor]);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    void refreshLibrary();
    void api.jobs().then(setJobs).catch(() => {});
    void api.settings().then(setSettings).catch(() => {});
  }, [refreshLibrary]);

  useEffect(() => {
    const onEvent = (e: ServerEvent) => {
      if (e.type === "hello") setConnected(true);
      if (e.type === "library") {
        window.clearTimeout(libTimer.current);
        libTimer.current = window.setTimeout(() => void refreshLibrary(), 150);
      }
      if (e.type === "video") bump(e.id);
      if (e.type === "job") {
        // Side effects run once, outside the state updater.
        const prev = jobsRef.current.find((j) => j.id === e.job.id);
        if (prev && prev.status !== e.job.status) {
          bump(e.job.videoId);
          if (!document.hasFocus()) {
            if (e.job.status === "done" && e.job.kind !== "export") void notify("Video ready", e.job.videoTitle);
            if (e.job.status === "failed") void notify("Emoton job failed", `${e.job.videoTitle}: ${e.job.error ?? ""}`);
          }
          if (e.job.status === "done" && e.job.kind === "export" && e.job.files?.length) {
            const first = e.job.files[0]!;
            toast(`Exported ${e.job.files.length} ${e.job.files.length === 1 ? "file" : "files"}`, "ok", { label: "Show in Finder", run: () => void reveal(first) });
          }
        }
        jobsRef.current = prev ? jobsRef.current.map((j) => (j.id === e.job.id ? e.job : j)) : [e.job, ...jobsRef.current];
        setJobs(jobsRef.current);
        if (e.job.kind === "export") return;
        // Keep the card progress in step without refetching the whole tree.
        setTree((t) =>
          t && {
            ...t,
            videos: t.videos.map((v) =>
              v.id === e.job.videoId
                ? {
                    ...v,
                    status: e.job.status === "running" || e.job.status === "queued" ? "making" : v.status,
                    job: { id: e.job.id, kind: e.job.kind, status: e.job.status, progress: e.job.progress, detail: e.job.steps.find((s) => s.status === "running")?.detail },
                  }
                : v,
            ),
          },
        );
      }
    };
    if (useMock()) return mockEvents(onEvent);
    let es: EventSource | null = null;
    let retry: number | undefined;
    const open = () => {
      es = new EventSource("/api/events");
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = window.setTimeout(() => {
          open();
          void refreshLibrary();
          void api.jobs().then(setJobs).catch(() => {});
        }, 2000);
      };
    };
    open();
    return () => {
      es?.close();
      window.clearTimeout(retry);
    };
  }, [bump, refreshLibrary, toast]);

  const value = useMemo<Store>(
    () => ({
      tree, jobs, settings, doctor, refreshDoctor, connected, refreshLibrary, setSettings, toast, toasts,
      dismiss: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
      videoVersion: (id) => versions[id] ?? 0,
    }),
    [tree, jobs, settings, doctor, refreshDoctor, connected, refreshLibrary, toast, toasts, versions],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Live video detail: refetches whenever the server says it changed. */
export function useVideo(id: string | null): { video: VideoDetail | null; error: string | null; reload(): void } {
  const { videoVersion } = useStore();
  const [video, setVideo] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const v = id ? videoVersion(id) : 0;
  useEffect(() => {
    if (!id) return;
    let live = true;
    api.video(id).then((d) => live && (setVideo(d), setError(null))).catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id, v, nonce]);
  return { video, error, reload: () => setNonce((n) => n + 1) };
}
