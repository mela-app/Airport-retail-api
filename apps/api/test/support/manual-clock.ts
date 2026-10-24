import type { FeedClock } from '../../src/adapters/contracts.js';

/** A test clock moved explicitly with `set` / `advance`. */
export class ManualClock implements FeedClock {
  private t: number;
  private sleepers: { at: number; resolve: () => void }[] = [];

  constructor(start: Date) {
    this.t = start.getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  sleepUntil(at: Date, signal?: AbortSignal): Promise<void> {
    if (at.getTime() <= this.t || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = { at: at.getTime(), resolve };
      this.sleepers.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((s) => s !== entry);
          resolve();
        },
        { once: true },
      );
    });
  }

  set(at: Date): void {
    this.t = at.getTime();
    const due = this.sleepers.filter((s) => s.at <= this.t);
    this.sleepers = this.sleepers.filter((s) => s.at > this.t);
    for (const s of due) s.resolve();
  }

  /** Resolve once something is waiting on this clock (real I/O may have to finish first). */
  async waitForSleeper(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.sleepers.length === 0) {
      if (Date.now() > deadline) throw new Error('nothing is waiting on the clock');
      await flush();
    }
  }

  advance(ms: number): void {
    this.set(new Date(this.t + ms));
  }
}

/** Let pending promise callbacks run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
