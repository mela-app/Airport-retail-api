/**
 * The simulation clock: one shared "now" for every feed, engine and screen. It can play, pause, run at any
 * speed (the UI offers 1x / 10x / 60x) and jump to a time. Anything waiting on it (`sleepUntil`) wakes at the
 * right simulation time, also when the speed changes or the clock jumps while it waits.
 */
import type { FeedClock } from '../adapters/contracts.js';

export interface ClockState {
  /** Simulation time, ISO 8601 UTC. */
  now: string;
  playing: boolean;
  speed: number;
  /** Bounds of the simulated operating period. */
  start: string;
  end: string;
}

export type ClockChange =
  { kind: 'play' | 'pause' | 'speed' } | { kind: 'jump'; from: Date; to: Date; backwards: boolean };

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 120;

interface Waiter {
  at: number;
  resolve: () => void;
}

export interface SimClockOptions {
  start: Date;
  /** Earliest and latest simulation time the clock may show. */
  bounds: { start: Date; end: Date };
  speed?: number;
  playing?: boolean;
  /** Wall-clock source (tests inject a fake). */
  wallNow?: () => number;
}

export class SimClock implements FeedClock {
  private anchorSim: number;
  private anchorWall: number;
  private playingNow: boolean;
  private speedNow: number;
  private readonly waiters = new Set<Waiter>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(change: ClockChange) => void>();
  private readonly wallNow: () => number;
  readonly bounds: { start: Date; end: Date };

  constructor(opts: SimClockOptions) {
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.bounds = opts.bounds;
    this.anchorSim = this.clamp(opts.start.getTime());
    this.anchorWall = this.wallNow();
    this.speedNow = opts.speed ?? 1;
    this.playingNow = opts.playing ?? true;
  }

  private clamp(t: number): number {
    return Math.min(this.bounds.end.getTime(), Math.max(this.bounds.start.getTime(), t));
  }

  private nowMs(): number {
    if (!this.playingNow) return this.anchorSim;
    return this.clamp(this.anchorSim + (this.wallNow() - this.anchorWall) * this.speedNow);
  }

  now(): Date {
    return new Date(this.nowMs());
  }

  get playing(): boolean {
    return this.playingNow;
  }

  get speed(): number {
    return this.speedNow;
  }

  state(): ClockState {
    return {
      now: this.now().toISOString(),
      playing: this.playingNow,
      speed: this.speedNow,
      start: this.bounds.start.toISOString(),
      end: this.bounds.end.toISOString(),
    };
  }

  /** Re-anchor at the current simulation time (before any change of speed or play state). */
  private reanchor(): void {
    this.anchorSim = this.nowMs();
    this.anchorWall = this.wallNow();
  }

  onChange(listener: (change: ClockChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: ClockChange): void {
    for (const l of this.listeners) l(change);
  }

  play(): void {
    if (this.playingNow) return;
    this.anchorWall = this.wallNow();
    this.playingNow = true;
    this.reschedule();
    this.emit({ kind: 'play' });
  }

  pause(): void {
    if (!this.playingNow) return;
    this.reanchor();
    this.playingNow = false;
    this.reschedule();
    this.emit({ kind: 'pause' });
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
      throw new RangeError(`speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
    }
    this.reanchor();
    this.speedNow = speed;
    this.reschedule();
    this.emit({ kind: 'speed' });
  }

  jump(to: Date): void {
    const from = this.now();
    this.anchorSim = this.clamp(to.getTime());
    this.anchorWall = this.wallNow();
    this.reschedule();
    this.emit({ kind: 'jump', from, to: this.now(), backwards: this.anchorSim < from.getTime() });
  }

  sleepUntil(at: Date, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || at.getTime() <= this.nowMs()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { at: at.getTime(), resolve: () => undefined };
      const done = () => {
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      waiter.resolve = done;
      this.waiters.add(waiter);
      signal?.addEventListener('abort', done, { once: true });
      this.reschedule();
    });
  }

  /** Wake every due waiter, then arm one wall-clock timer for the earliest remaining waiter. */
  private reschedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.nowMs();
    let earliest = Infinity;
    for (const w of [...this.waiters]) {
      if (w.at <= now) w.resolve();
      else earliest = Math.min(earliest, w.at);
    }
    if (!this.playingNow || earliest === Infinity) return;
    // Cap the wait so the clock stays accurate even if the wall clock drifts.
    const wallDelay = Math.min(60_000, Math.max(1, Math.ceil((earliest - now) / this.speedNow)));
    this.timer = setTimeout(() => this.reschedule(), wallDelay);
    this.timer.unref?.();
  }

  /** Stop timers and release every waiter (shutdown). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const w of [...this.waiters]) w.resolve();
    this.listeners.clear();
  }
}
