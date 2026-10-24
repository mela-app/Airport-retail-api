/**
 * The whole mock world for one operating day, and its export in each source's native format:
 *
 * data/generated/<date>/
 *   aodb/      start-of-day and end-of-day snapshots (CSV and JSON, the sample's 33 columns)
 *   aidx/      the day's IATA AIDX FlightLegNotifRQ messages as a replayable stream, plus a few sample files
 *   acris/     NGSI-LD entities and the QueueMeasurement series
 *   audience/  per-flight crowd profiles (the mock "airline aggregates" feed)
 *   platform/  screens, advertisers, outlets, creatives, campaigns and 30-day history
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type CrowdProfile,
  type Flight,
  type QueueMeasurement,
  destinationByIata,
  isoMinute,
  localToUtc,
} from '@arm/domain';

import { toAidxXml } from './formats/aidx.js';
import { acrisQueueMeasurement, acrisStaticEntities } from './formats/acris.js';
import { toAodbCsv, toAodbJson } from './formats/aodb.js';
import { type Inventory, buildInventory } from './inventory.js';
import { Rng } from './prng.js';
import { simulateQueues } from './queues.js';
import {
  type DayOptions,
  type GeneratedDay,
  type PlannedEvent,
  generateDay,
  snapshotAt,
} from './schedule.js';

/**
 * Version of the generated data format and calibration. The API regenerates a data directory whose manifest
 * names another version (or another seed, size or offset), so generated files never go stale.
 */
export const GENERATOR_VERSION = '2026.10.23-2';

export interface AidxMessage {
  sequence: number;
  /** Simulation time the message is published (UTC). */
  at: string;
  flightId: string;
  type: PlannedEvent['type'];
  xml: string;
}

export interface World {
  day: GeneratedDay;
  /** Flights as published at local midnight (the AODB start-of-day snapshot). */
  startOfDay: Flight[];
  /** Flights at the end of the day (comparable to the sample end-of-day file). */
  endOfDay: Flight[];
  aidx: AidxMessage[];
  queueMeasurements: QueueMeasurement[];
  profiles: Map<string, CrowdProfile>;
  inventory: Inventory;
}

export function generateWorld(opts: Partial<DayOptions> = {}): World {
  const day = generateDay(opts);
  const { date, seed, utcOffsetMinutes } = day.options;
  const dayStart = localToUtc(date, 0, 0, utcOffsetMinutes);
  const dayEnd = localToUtc(date, 23, 59, utcOffsetMinutes);
  const startOfDay = snapshotAt(day, dayStart);
  const endOfDay = snapshotAt(day, new Date(dayEnd.getTime() + 6 * 3600_000));

  // AIDX: every event after the start-of-day snapshot, rendered with the flight state after the event.
  const state = new Map(day.flights.map((f) => [f.initial.id, f.initial]));
  const aidx: AidxMessage[] = [];
  const snapshotCutoff = isoMinute(dayStart);
  let sequence = 500000;
  for (const e of day.events) {
    const before = state.get(e.flightId);
    if (!before) continue;
    const after: Flight = { ...before, ...e.changes, lastUpdate: e.at };
    state.set(e.flightId, after);
    // Events up to the snapshot time are already part of the start-of-day AODB snapshot.
    if (e.at <= snapshotCutoff) continue;
    sequence += 1;
    const other = after.direction === 'D' ? after.destination : after.origin;
    const block = destinationByIata(other)?.blockMinutes ?? 60;
    aidx.push({
      sequence,
      at: e.at,
      flightId: e.flightId,
      type: e.type,
      xml: toAidxXml(after, e, sequence, block),
    });
  }

  const departures = endOfDay.filter((f) => f.direction === 'D');
  const queueMeasurements = simulateQueues(
    date,
    utcOffsetMinutes,
    departures,
    new Rng(`${seed}:${date}:queues`),
  );
  const profiles = new Map(day.flights.map((f) => [f.initial.id, f.profile]));
  const inventory = buildInventory(date, seed, utcOffsetMinutes);
  return { day, startOfDay, endOfDay, aidx, queueMeasurements, profiles, inventory };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ndjson = (rows: readonly unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/** Write the world into `dir` (created if missing). Returns the list of written files, relative to `dir`. */
export function writeWorld(world: World, dir: string): string[] {
  const { date } = world.day.options;
  const files = new Map<string, string>();
  const base = `MQI_aodb_flights_${date}`;
  files.set(`aodb/${base}_start-of-day.csv`, toAodbCsv(world.startOfDay));
  files.set(`aodb/${base}_start-of-day.json`, toAodbJson(world.startOfDay));
  files.set(`aodb/${base}_end-of-day.csv`, toAodbCsv(world.endOfDay));
  files.set('aidx/stream.ndjson', ndjson(world.aidx));
  const sampleTypes = new Set<string>();
  for (const m of world.aidx) {
    if (sampleTypes.has(m.type)) continue;
    sampleTypes.add(m.type);
    files.set(`aidx/samples/${String(m.sequence)}_${m.flightId}_${m.type}.xml`, m.xml);
  }
  files.set('acris/entities.jsonld', json(acrisStaticEntities()));
  files.set('acris/queue-measurements.ndjson', ndjson(world.queueMeasurements.map(acrisQueueMeasurement)));
  files.set('audience/flight-profiles.json', json(Object.fromEntries(world.profiles)));
  const inv = world.inventory;
  files.set('platform/advertisers.json', json(inv.advertisers));
  files.set('platform/outlets.json', json(inv.outlets));
  files.set('platform/screens.json', json(inv.screens));
  files.set('platform/creatives.json', json(inv.creatives));
  files.set('platform/campaigns.json', json(inv.campaigns));
  files.set('platform/campaign-history.json', json(inv.history));
  files.set(
    'manifest.json',
    json({
      generatorVersion: GENERATOR_VERSION,
      airport: 'MQI',
      date,
      pairs: world.day.options.pairs,
      seed: world.day.options.seed,
      utcOffsetMinutes: world.day.options.utcOffsetMinutes,
      calendar: world.day.calendar,
      counts: {
        flights: world.startOfDay.length,
        departures: world.startOfDay.filter((f) => f.direction === 'D').length,
        aidxMessages: world.aidx.length,
        queueMeasurements: world.queueMeasurements.length,
        screens: inv.screens.length,
        outlets: inv.outlets.length,
        advertisers: inv.advertisers.length,
        airlines: inv.advertisers.filter((a) => a.kind === 'airline').length,
        campaigns: inv.campaigns.length,
        creatives: inv.creatives.length,
        historyDays: new Set(inv.history.map((h) => h.date)).size,
      },
    }),
  );

  for (const [rel, content] of files) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return [...files.keys()];
}
