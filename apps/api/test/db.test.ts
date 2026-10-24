import { getTableConfig } from 'drizzle-orm/pg-core';
import { count } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Database, createDatabase } from '../src/db/client.js';
import { listMigrations, migrate } from '../src/db/migrate.js';
import { ALL_TABLES } from '../src/db/schema.js';
import * as t from '../src/db/schema.js';
import { DEFAULT_RULE_ENGINE, seed } from '../src/db/seed.js';

let database: Database;

beforeAll(async () => {
  database = createDatabase('pglite:memory');
  await migrate(database);
}, 60_000);

afterAll(async () => {
  await database.close();
});

/** information_schema data types for the Drizzle column types used in schema.ts. */
const PG_TYPE: ReadonlyMap<string, string> = new Map([
  ['PgText', 'text'],
  ['PgInteger', 'integer'],
  ['PgBoolean', 'boolean'],
  ['PgDoublePrecision', 'double precision'],
  ['PgJsonb', 'jsonb'],
  ['PgTimestamp', 'timestamp with time zone'],
]);

describe('migrations', () => {
  it('are numbered and applied once', async () => {
    expect(listMigrations().map((m) => m.version)).toContain('0001_initial');
    expect(await migrate(database)).toEqual([]);
  });

  it('create exactly the tables, columns, types and nullability declared in schema.ts', async () => {
    const rows = await database.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'",
    );
    const actual = new Map(
      rows.map((r) => [
        `${r.table_name}.${r.column_name}`,
        `${r.data_type} ${r.is_nullable === 'YES' ? 'null' : 'not null'}`,
      ]),
    );
    const expected = new Map<string, string>();
    for (const table of Object.values(ALL_TABLES)) {
      const config = getTableConfig(table);
      for (const col of config.columns) {
        expected.set(
          `${config.name}.${col.name}`,
          `${PG_TYPE.get(col.columnType) ?? col.columnType} ${col.notNull ? 'not null' : 'null'}`,
        );
      }
    }
    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
  });
});

describe('seed', () => {
  it('loads master and platform data at the challenge scale, and is repeatable', async () => {
    const opts = { simDate: '2026-10-16', seed: 'mqi', utcOffsetMinutes: 240, currency: 'USD' };
    await seed(database, opts);
    const counts = await seed(database, opts);
    const n = async (
      table: Parameters<typeof database.db.select>[0] extends never
        ? never
        : (typeof ALL_TABLES)[keyof typeof ALL_TABLES],
    ) => (await database.db.select({ n: count() }).from(table))[0]?.n;
    expect(await n(t.screens)).toBe(180);
    expect(await n(t.outlets)).toBe(40);
    expect(await n(t.campaigns)).toBe(25);
    expect(await n(t.airlines)).toBe(11);
    expect(await n(t.gates)).toBe(counts.gates);
    expect(await n(t.campaignDailyStats)).toBe(counts.historyRows);
  });

  it('stores JSON values and timestamps faithfully', async () => {
    const [campaign] = await database.db
      .select()
      .from(t.campaigns)
      .where((await import('drizzle-orm')).eq(t.campaigns.id, 'c01'));
    expect(campaign?.segmentWeights).toMatchObject({ 'tripPurpose.holiday': 1, 'market.international': 1 });
    expect(campaign?.triggers).toEqual([
      { type: 'delay_over', minutes: 30, airlineIata: null, destinations: [], boost: 1.5 },
    ]);
    expect(campaign?.createdAt).toBeInstanceOf(Date);
    const [rules] = await database.db
      .select()
      .from(t.settings)
      .where((await import('drizzle-orm')).eq(t.settings.key, 'rule_engine'));
    expect(rules?.value).toEqual(DEFAULT_RULE_ENGINE);
  });
});
