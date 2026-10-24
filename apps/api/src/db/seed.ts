/**
 * Seeds master data (airport layout, airlines, aircraft types, destinations) and the platform-owned data
 * (advertisers, outlets, screens, creatives, campaigns, 30-day history, rule-engine settings) from the mock
 * generator. Flight, AIDX and ACRIS data are not seeded here: they arrive through the source adapters.
 *
 * Seeding replaces existing seed data, so it is repeatable.
 */
import {
  AIRCRAFT_TYPES,
  AIRLINES,
  CHECKPOINTS,
  CONCOURSES,
  DESTINATIONS,
  GATES,
  PASSENGER_QUEUES,
  TERMINALS,
  ZONES,
} from '@arm/domain';
import { buildInventory } from '@arm/mockgen';

import type { Database } from './client.js';
import * as t from './schema.js';

export interface SeedOptions {
  simDate: string;
  seed: string;
  utcOffsetMinutes: number;
  currency: string;
}

/** Default rule-engine settings (editable by the Platform Admin). */
export const DEFAULT_RULE_ENGINE = {
  /** Final score = audienceWeight × min(1, audience match × boost) + performanceWeight × performance index. */
  audienceWeight: 0.8,
  performanceWeight: 0.2,
  /** Share of slots given to a random eligible campaign so new campaigns get learning data. */
  explorationPct: 5,
  /** Plays per screen per hour when a campaign sets none (a 15-second slot gives 240 slots an hour). */
  defaultFrequencyCap: 60,
  /** Plays in a row of one campaign on a screen before another eligible campaign gets the slot. */
  maxConsecutivePlays: 2,
  /** Candidates scoring below this do not play on a screen; they are held for screens where they fit better. */
  minScoreToPlay: 0.25,
  competitorSeparation: true,
  airlinePriorityInBoardingWindow: true,
  /** Minutes before boarding that an airline's own gate messaging takes priority. */
  airlinePriorityWindowMin: 45,
  segmentModelVersion: 'mqi-segments-2026.10',
} as const;

const date = (iso: string) => new Date(iso);

async function insertChunks<T>(
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
  size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/** Tables in dependency order (children first when deleting). */
const SEEDED_TABLES = [
  // runtime data derived from the seeded campaigns and screens
  'manual_pins',
  'campaign_segment_stats',
  'model_versions',
  'decision_contexts',
  'decisions',
  'impressions',
  'redemptions',
  'claim_links',
  'promo_codes',
  'zone_presence',
  'incidents',
  'campaign_daily_stats',
  'campaigns',
  'creatives',
  'screens',
  'outlets',
  'advertisers',
  'passenger_queues',
  'checkpoints',
  'gates',
  'zones',
  'concourses',
  'terminals',
  'destinations',
  'aircraft_types',
  'airlines',
  'settings',
] as const;

export async function seed(database: Database, opts: SeedOptions): Promise<Record<string, number>> {
  const inv = buildInventory(opts.simDate, opts.seed, opts.utcOffsetMinutes);
  const { db } = database;
  const now = new Date();

  await database.transaction(async (runner) => {
    // Fixed table names from the list above, never user input.
    await runner.exec(SEEDED_TABLES.map((name) => `DELETE FROM ${name};`).join('\n'));
  });

  await db
    .insert(t.terminals)
    .values(TERMINALS.map((x) => ({ id: x.id, name: x.name, mainMarket: x.mainMarket, outline: x.outline })));
  await db.insert(t.concourses).values(CONCOURSES.map((x) => ({ ...x })));
  await db.insert(t.zones).values(ZONES.map((x) => ({ ...x })));
  await db.insert(t.gates).values(GATES.map((x) => ({ ...x, active: true })));
  await db.insert(t.checkpoints).values(CHECKPOINTS.map((x) => ({ ...x })));
  await db.insert(t.passengerQueues).values(PASSENGER_QUEUES.map((x) => ({ ...x })));
  await db.insert(t.airlines).values(AIRLINES.map((x) => ({ ...x, active: true })));
  await db.insert(t.aircraftTypes).values(AIRCRAFT_TYPES.map((x) => ({ ...x })));
  await db.insert(t.destinations).values(DESTINATIONS.map((x) => ({ ...x })));

  await db
    .insert(t.advertisers)
    .values(inv.advertisers.map((x) => ({ ...x, onboardedAt: date(x.onboardedAt), active: true })));
  await db
    .insert(t.outlets)
    .values(inv.outlets.map((x) => ({ ...x, openedAt: date(x.openedAt), active: true })));
  await insertChunks(inv.screens, (chunk) =>
    db.insert(t.screens).values(
      chunk.map((x) => ({
        ...x,
        installedAt: date(x.installedAt),
        statusSince: date(x.installedAt),
        lastHeartbeat: null,
        latencyMs: null,
      })),
    ),
  );
  await db.insert(t.creatives).values(inv.creatives.map((x) => ({ ...x, createdAt: date(x.createdAt) })));
  await db
    .insert(t.campaigns)
    .values(inv.campaigns.map((x) => ({ ...x, createdAt: date(x.createdAt), updatedAt: date(x.updatedAt) })));
  await insertChunks(inv.history, (chunk) => db.insert(t.campaignDailyStats).values(chunk));

  await db.insert(t.settings).values([
    { key: 'rule_engine', value: DEFAULT_RULE_ENGINE, updatedAt: now },
    {
      key: 'platform',
      value: {
        currency: opts.currency,
        simDate: opts.simDate,
        seed: opts.seed,
        utcOffsetMinutes: opts.utcOffsetMinutes,
      },
      updatedAt: now,
    },
  ]);

  return {
    terminals: TERMINALS.length,
    zones: ZONES.length,
    gates: GATES.length,
    airlines: AIRLINES.length,
    advertisers: inv.advertisers.length,
    outlets: inv.outlets.length,
    screens: inv.screens.length,
    creatives: inv.creatives.length,
    campaigns: inv.campaigns.length,
    historyRows: inv.history.length,
  };
}
