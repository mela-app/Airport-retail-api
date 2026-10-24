/** A generated world and helpers shared by the engine tests. */
import { type CrowdProfile, type Flight, type QueueMeasurement, localToUtc } from '@arm/domain';
import { type World, generateWorld, snapshotAt } from '@arm/mockgen';

import type { PresenceInputs } from '../../src/engine/presence.js';

export const DATE = '2026-10-16';
export const OFFSET = 240;

let cached: World | undefined;
export function world(): World {
  cached ??= generateWorld({ date: DATE, seed: 'mqi' });
  return cached;
}

/** UTC instant of a local time on the test date. */
export const at = (hour: number, minute = 0): Date => localToUtc(DATE, hour, minute, OFFSET);

/** Latest queue measurement per queue at `t`. */
export function queuesAt(w: World, t: Date): Map<string, QueueMeasurement> {
  const out = new Map<string, QueueMeasurement>();
  for (const m of w.queueMeasurements) if (Date.parse(m.measuredAt) <= t.getTime()) out.set(m.queueId, m);
  return out;
}

export function presenceInputs(t: Date, flights?: Flight[]): PresenceInputs {
  const w = world();
  const profiles = new Map<string, CrowdProfile>(w.profiles);
  return { flights: flights ?? snapshotAt(w.day, t), profiles, queues: queuesAt(w, t) };
}
