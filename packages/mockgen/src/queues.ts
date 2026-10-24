/**
 * Checkpoint queue simulation, the source of the mock ACRIS QueueMeasurement series.
 *
 * Departing passengers reach a checkpoint before their flight (international earlier than domestic), spread
 * over a window. Each checkpoint processes `lanes × rate` passengers per hour; the queue is what is left over.
 * Measurements are taken every 5 minutes over the operating day.
 */
import {
  CHECKPOINTS,
  type Flight,
  PASSENGER_QUEUES,
  type QueueMeasurement,
  isoMinute,
  localToUtc,
} from '@arm/domain';

import type { Rng } from './prng.js';

const STEP_MIN = 5;
/** Passengers per lane per hour. */
const LANE_RATE = new Map([
  ['security', 140],
  ['passport_control', 190],
]);
/** Share of passengers using the priority queue. */
const PRIORITY_SHARE = 0.1;
/** Staffing covers this share of forecast demand, so short queues form at the banks. */
const STAFFING_RATIO = 0.9;
const MIN_OPEN_LANES = 2;

/** When departing passengers reach security, relative to STD (minutes): [earliest, latest]. */
function arrivalWindow(f: Flight): [number, number] {
  return f.nature === 'international' ? [-170, -45] : [-120, -35];
}

/** Which checkpoints a departing flight's passengers pass. */
function checkpointsFor(f: Flight): string[] {
  if (f.terminal === 'T1') return ['T1-SEC-CP'];
  return f.nature === 'international' ? ['T2-SEC-CP', 'T2-PPC-CP'] : ['T2-SEC-CP'];
}

export function simulateQueues(
  date: string,
  utcOffsetMinutes: number,
  departures: readonly Flight[],
  rng: Rng,
): QueueMeasurement[] {
  const start = localToUtc(date, 0, 0, utcOffsetMinutes).getTime();
  const steps = (24 * 60) / STEP_MIN;
  // demand per checkpoint per step
  const demand = new Map<string, Float64Array>(CHECKPOINTS.map((c) => [c.id, new Float64Array(steps)]));
  for (const f of departures) {
    if (f.status === 'cancelled' || f.pax === null) continue;
    const [from, to] = arrivalWindow(f);
    const std = Date.parse(f.scheduledTime);
    const span = (to - from) / STEP_MIN;
    for (const cp of checkpointsFor(f)) {
      const series = demand.get(cp);
      if (!series) continue;
      // triangular arrival profile peaking at the middle of the window
      for (let k = 0; k < span; k += 1) {
        const at = std + (from + k * STEP_MIN) * 60_000;
        const step = Math.floor((at - start) / (STEP_MIN * 60_000));
        if (step < 0 || step >= steps) continue;
        const x = (k + 0.5) / span;
        const weight = ((x < 0.5 ? x : 1 - x) * 4) / span;
        series.set([(series.at(step) ?? 0) + f.pax * weight], step);
      }
    }
  }

  const out: QueueMeasurement[] = [];
  for (const cp of CHECKPOINTS) {
    const series = demand.get(cp.id);
    if (!series) continue;
    const laneRatePerStep = ((LANE_RATE.get(cp.kind) ?? 150) * STEP_MIN) / 60;
    const queues = PASSENGER_QUEUES.filter((q) => q.checkpointId === cp.id).map((q) => ({
      queue: q,
      // Priority lanes are slightly over-provisioned relative to their passenger share.
      paxShare: q.queueType === 'priority' ? PRIORITY_SHARE : 1 - PRIORITY_SHARE,
      laneShare: q.queueType === 'priority' ? PRIORITY_SHARE * 1.3 : 1 - PRIORITY_SHARE * 1.3,
      backlog: 0,
    }));
    for (let step = 0; step < steps; step += 1) {
      // Lanes are staffed to the next hour's forecast plus the people already queuing, as a duty manager
      // would; staffing slightly under the forecast lets short queues form at the banks.
      let nextHour = 0;
      for (let k = 0; k < 60 / STEP_MIN; k += 1) nextHour += series.at(step + k) ?? 0;
      const backlog = queues.reduce((sum, q) => sum + q.backlog, 0);
      const forecastPerStep = nextHour / (60 / STEP_MIN);
      const needed = Math.ceil((forecastPerStep * STAFFING_RATIO + backlog / 6) / laneRatePerStep);
      const lanes = Math.min(cp.lanes, Math.max(MIN_OPEN_LANES, needed));
      const measuredAt = isoMinute(new Date(start + (step + 1) * STEP_MIN * 60_000));
      const jitter = rng.float(0.9, 1.1);
      for (const q of queues) {
        const capacity = lanes * laneRatePerStep * q.laneShare;
        const arriving = (series.at(step) ?? 0) * q.paxShare * jitter;
        const processed = Math.min(capacity, q.backlog + arriving);
        q.backlog = Math.max(0, q.backlog + arriving - processed);
        const next = (series.at(step + 1) ?? 0) * q.paxShare;
        out.push({
          id: `${q.queue.id}-${measuredAt.slice(0, 16).replace(/[-:T]/g, '')}`,
          queueId: q.queue.id,
          checkpointId: cp.id,
          measuredAt,
          occupancy: Math.round(q.backlog),
          waitTimeSec: Math.round(capacity > 0 ? (q.backlog / capacity) * STEP_MIN * 60 : 0),
          projectedWaitTimeSec: Math.round(
            capacity > 0 ? (Math.max(0, q.backlog + next - capacity) / capacity) * STEP_MIN * 60 : 0,
          ),
          throughputPerHour: Math.round((processed * 60) / STEP_MIN),
        });
      }
    }
  }
  return out.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.queueId.localeCompare(b.queueId));
}
