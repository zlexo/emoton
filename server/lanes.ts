/** A counting semaphore with FIFO waiters and abortable waits. One per job lane. */
export class LaneSlots {
  private active = 0;
  private waiters: { grant: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];

  constructor(public readonly limit: number) {}

  get running() {
    return this.active;
  }

  get waiting() {
    return this.waiters.length;
  }

  /** Resolves with a release function once a slot is free. Rejects if the signal aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.next();
        });
      };
      if (this.active < this.limit && this.waiters.length === 0) return grant();
      const w: (typeof this.waiters)[number] = { grant, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  private next() {
    while (this.active < this.limit && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      w.grant();
    }
  }
}
