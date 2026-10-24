/**
 * Shared machinery for feed adapters: health statistics, time-ordered replay against the clock, and a
 * broadcast channel for injected messages.
 */
import type { FeedClock, FeedHealth, FeedName } from './contracts.js';

export class FeedStats {
  private total = 0;
  private rejected = 0;
  private lastAt: string | null = null;
  private error: string | null = null;
  private recent: number[] = [];
  private failing = false;

  constructor(
    readonly feed: FeedName,
    readonly adapter: string,
  ) {}

  received(clockTime: Date, count = 1): void {
    this.total += count;
    this.lastAt = clockTime.toISOString();
    this.failing = false;
    const now = Date.now();
    for (let i = 0; i < count; i += 1) this.recent.push(now);
    this.prune(now);
  }

  rejectedMessage(reason: string): void {
    this.rejected += 1;
    this.error = reason;
  }

  /** The feed could not be reached (live adapters). */
  unavailable(reason: string): void {
    this.failing = true;
    this.error = reason;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    if (this.recent.length > 0 && (this.recent.at(0) ?? now) < cutoff)
      this.recent = this.recent.filter((t) => t >= cutoff);
  }

  health(): FeedHealth {
    this.prune(Date.now());
    return {
      feed: this.feed,
      adapter: this.adapter,
      status: this.failing
        ? 'down'
        : this.rejected > 0 && this.rejected * 20 > this.total
          ? 'degraded'
          : 'up',
      messagesTotal: this.total,
      rejectedTotal: this.rejected,
      messagesPerMinute: this.recent.length,
      lastMessageAt: this.lastAt,
      lastError: this.error,
    };
  }
}

/** Fan-out of injected values to every open stream. */
export class Broadcast<T> {
  private readonly subscribers = new Set<{ queue: T[]; wake: () => void }>();

  publish(value: T): void {
    for (const s of this.subscribers) {
      s.queue.push(value);
      s.wake();
    }
  }

  subscribe(): { take(): T | undefined; onPublish(fn: () => void): void; close(): void } {
    const sub = { queue: [] as T[], wake: () => undefined as void };
    this.subscribers.add(sub);
    return {
      take: () => sub.queue.shift(),
      onPublish: (fn) => {
        sub.wake = fn;
      },
      close: () => {
        this.subscribers.delete(sub);
      },
    };
  }
}

export interface Timed<T> {
  /** Clock time (epoch ms) at which the item becomes visible. */
  at: number;
  value: T;
}

/** Index of the first item strictly after `from` in a list sorted by `at`. */
export function firstAfter<T>(items: readonly Timed<T>[], from: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items.at(mid)?.at ?? Infinity) <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * Yield `items` (sorted by `at`) that come after `from`, each once clock time reaches it, plus anything
 * published on `injected` as soon as it is published. Ends when `signal` aborts (or when the scheduled items
 * are exhausted and there is no injection channel).
 */
export async function* replay<T>(
  items: readonly Timed<T>[],
  from: Date,
  clock: FeedClock,
  signal: AbortSignal,
  injected?: Broadcast<T>,
): AsyncGenerator<T> {
  let i = firstAfter(items, from.getTime());
  const inbox = injected?.subscribe();
  try {
    while (!signal.aborted) {
      for (let v = inbox?.take(); v !== undefined; v = inbox?.take()) yield v;
      const next = items.at(i);
      if (!next && !inbox) return;
      const wake = new AbortController();
      inbox?.onPublish(() => wake.abort());
      const both = AbortSignal.any([signal, wake.signal]);
      if (next) await clock.sleepUntil(new Date(next.at), both);
      else await waitForAbort(both);
      inbox?.onPublish(() => undefined);
      if (signal.aborted) return;
      if (next && clock.now().getTime() >= next.at) {
        i += 1;
        yield next.value;
      }
    }
  } finally {
    inbox?.close();
  }
}

export interface TimerRequest {
  /** Epoch milliseconds (wall clock). */
  at: number;
  signal: AbortSignal | undefined;
}

/** Resolves when the wall clock reaches `at`, or as soon as the signal aborts (never rejects). */
export function timerUntil(req: TimerRequest): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(() => finish(), Math.max(0, req.at - Date.now()));
    req.signal?.addEventListener('abort', finish, { once: true });
    if (req.signal?.aborted) finish();
  });
}

/** A clock that follows real time (live adapters, and tests that need one). */
export const realTimeClock: FeedClock = {
  now: () => new Date(),
  sleepUntil: (at, signal) => timerUntil({ at: at.getTime(), signal }),
};
