import { afterEach, describe, expect, it, vi } from 'vitest';

import { SimClock } from '../src/sim/sim-clock.js';

const T0 = new Date('2026-10-16T09:50:00Z');
const bounds = { start: new Date('2026-10-15T20:00:00Z'), end: new Date('2026-10-16T22:00:00Z') };

afterEach(() => {
  vi.useRealTimers();
});

function fakeClock(speed = 1, playing = true) {
  vi.useFakeTimers({ now: 1_000_000 });
  return new SimClock({ start: T0, bounds, speed, playing, wallNow: () => Date.now() });
}

describe('simulation clock', () => {
  it('advances with wall time at the chosen speed', () => {
    const clock = fakeClock(60);
    vi.advanceTimersByTime(1000);
    expect(clock.now().toISOString()).toBe('2026-10-16T09:51:00.000Z');
    clock.setSpeed(10);
    vi.advanceTimersByTime(6000);
    expect(clock.now().toISOString()).toBe('2026-10-16T09:52:00.000Z');
  });

  it('stands still while paused and resumes from the same time', () => {
    const clock = fakeClock(1);
    clock.pause();
    vi.advanceTimersByTime(60_000);
    expect(clock.now()).toEqual(T0);
    clock.play();
    vi.advanceTimersByTime(30_000);
    expect(clock.now().toISOString()).toBe('2026-10-16T09:50:30.000Z');
  });

  it('wakes sleepers at the right simulation time, also after a speed change', async () => {
    const clock = fakeClock(1);
    let woke = false;
    void clock.sleepUntil(new Date('2026-10-16T10:00:00Z')).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 09:55 at 1x
    expect(woke).toBe(false);
    clock.setSpeed(60);
    await vi.advanceTimersByTimeAsync(4_000); // 09:59
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100); // past 10:00
    expect(woke).toBe(true);
  });

  it('a jump past a sleeper wakes it at once and reports the direction', async () => {
    const clock = fakeClock(1, false);
    const changes: unknown[] = [];
    clock.onChange((c) => changes.push(c));
    let woke = false;
    void clock.sleepUntil(new Date('2026-10-16T12:00:00Z')).then(() => {
      woke = true;
    });
    clock.jump(new Date('2026-10-16T12:30:00Z'));
    await Promise.resolve();
    expect(woke).toBe(true);
    clock.jump(new Date('2026-10-16T08:00:00Z'));
    expect(changes.map((c) => (c as { backwards?: boolean }).backwards)).toEqual([false, true]);
  });

  it('aborting a sleep resolves it without waiting', async () => {
    const clock = fakeClock(1);
    const ctl = new AbortController();
    const sleep = clock.sleepUntil(new Date('2026-10-16T20:00:00Z'), ctl.signal);
    ctl.abort();
    await expect(sleep).resolves.toBeUndefined();
  });

  it('stays inside its bounds and rejects unreasonable speeds', () => {
    const clock = fakeClock(1, false);
    clock.jump(new Date('2027-01-01T00:00:00Z'));
    expect(clock.now()).toEqual(bounds.end);
    expect(() => clock.setSpeed(0)).toThrow(RangeError);
    expect(() => clock.setSpeed(1000)).toThrow(RangeError);
  });
});
