/** Server-sent events: /api/events. Job events are throttled per job; the final state is never dropped. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Job, ServerEvent } from "../shared/api.ts";

export class EventHub {
  private clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout;
  /** jobId -> last send time and a pending trailing send. */
  private jobThrottle = new Map<string, { last: number; timer: NodeJS.Timeout | null; pending: Job | null }>();

  constructor(
    private hello: () => ServerEvent,
    private opts: { heartbeatMs?: number; jobIntervalMs?: number } = {},
  ) {
    this.heartbeat = setInterval(() => this.writeAll(": ping\n\n"), opts.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  get size() {
    return this.clients.size;
  }

  attach(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
    this.writeOne(res, this.hello());
  }

  send(ev: ServerEvent) {
    this.writeAll(frame(ev));
  }

  /** At most one event per job per interval (default 250 ms = 4/s). A final state goes out at once. */
  job(job: Job, final: boolean) {
    const interval = this.opts.jobIntervalMs ?? 250;
    let t = this.jobThrottle.get(job.id);
    if (!t) {
      t = { last: 0, timer: null, pending: null };
      this.jobThrottle.set(job.id, t);
    }
    const nowMs = Date.now();
    if (final) {
      if (t.timer) clearTimeout(t.timer);
      this.jobThrottle.delete(job.id);
      this.send({ type: "job", job });
      return;
    }
    if (nowMs - t.last >= interval && !t.timer) {
      t.last = nowMs;
      this.send({ type: "job", job });
      return;
    }
    t.pending = job;
    if (!t.timer) {
      const entry = t;
      t.timer = setTimeout(() => {
        entry.timer = null;
        entry.last = Date.now();
        if (entry.pending) this.send({ type: "job", job: entry.pending });
        entry.pending = null;
      }, Math.max(0, interval - (nowMs - t.last)));
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const t of this.jobThrottle.values()) if (t.timer) clearTimeout(t.timer);
    this.jobThrottle.clear();
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  private writeOne(res: ServerResponse, ev: ServerEvent) {
    if (!res.writableEnded) res.write(frame(ev));
  }

  private writeAll(data: string) {
    for (const c of this.clients) if (!c.writableEnded) c.write(data);
  }
}

/** Unnamed events (no `event:` line), so a plain EventSource `onmessage` gets every one; `data.type` tells them apart. */
function frame(ev: ServerEvent) {
  return `data: ${JSON.stringify(ev)}\n\n`;
}
