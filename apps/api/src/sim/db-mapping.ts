/**
 * Mapping between canonical entities (ISO time strings) and database rows (Date objects).
 */
import type { Flight, FlightChanges, QueueMeasurement } from '@arm/domain';

import type * as t from '../db/schema.js';

const toDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);
const toIso = (d: Date | null): string | null => (d ? `${d.toISOString().slice(0, 19)}Z` : null);

export type FlightRow = typeof t.flights.$inferInsert;

export function flightToRow(f: Flight): FlightRow {
  return {
    ...f,
    scheduledTime: new Date(f.scheduledTime),
    estimatedTime: toDate(f.estimatedTime),
    estimatedRunwayTime: toDate(f.estimatedRunwayTime),
    actualRunwayTime: toDate(f.actualRunwayTime),
    actualBlockTime: toDate(f.actualBlockTime),
    tobt: toDate(f.tobt),
    tsat: toDate(f.tsat),
    lastUpdate: new Date(f.lastUpdate),
  };
}

export function rowToFlight(r: typeof t.flights.$inferSelect): Flight {
  return {
    ...r,
    direction: r.direction as Flight['direction'],
    nature: r.nature as Flight['nature'],
    status: r.status as Flight['status'],
    via: r.via as string[],
    delayCodes: r.delayCodes as string[],
    codeshares: r.codeshares as string[],
    source: r.source as Flight['source'],
    scheduledTime: toIso(r.scheduledTime) ?? '',
    estimatedTime: toIso(r.estimatedTime),
    estimatedRunwayTime: toIso(r.estimatedRunwayTime),
    actualRunwayTime: toIso(r.actualRunwayTime),
    actualBlockTime: toIso(r.actualBlockTime),
    tobt: toIso(r.tobt),
    tsat: toIso(r.tsat),
    lastUpdate: toIso(r.lastUpdate) ?? '',
  };
}

const TIME_FIELDS = new Set([
  'estimatedTime',
  'estimatedRunwayTime',
  'actualRunwayTime',
  'actualBlockTime',
  'tobt',
  'tsat',
]);

/** The columns to update for an event's changes. */
export function changesToRow(changes: FlightChanges, lastUpdate: string): Partial<FlightRow> {
  const out: Record<string, unknown> = { lastUpdate: new Date(lastUpdate) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    Object.assign(out, { [key]: TIME_FIELDS.has(key) ? toDate(value as string | null) : value });
  }
  return out as Partial<FlightRow>;
}

export function queueToRow(m: QueueMeasurement): typeof t.queueMeasurements.$inferInsert {
  return { ...m, measuredAt: new Date(m.measuredAt) };
}
