/**
 * Database connection. `DATABASE_URL` selects the engine:
 *
 * - `postgres://…` / `postgresql://…`: PostgreSQL (Docker Compose, the playground)
 * - `pglite:memory`: embedded PostgreSQL in memory (tests)
 * - `pglite:<directory>`: embedded PostgreSQL persisted to a directory (local run without Docker)
 *
 * Both engines run the same SQL migrations and the same Drizzle queries.
 */
import { mkdirSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';

import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Low-level access for migrations: multi-statement SQL and parameterised queries in one transaction. */
export interface SqlRunner {
  exec(sqlText: string): Promise<void>;
  query<T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Database {
  db: Db;
  engine: 'postgres' | 'pglite';
  transaction<R>(fn: (runner: SqlRunner) => Promise<R>): Promise<R>;
  query<T extends Record<string, unknown>>(sqlText: string, params?: readonly unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    db: drizzleNodePg(pool, { schema }) as unknown as Db,
    engine: 'postgres',
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const runner: SqlRunner = {
          exec: async (text) => {
            await client.query(text);
          },
          query: async (text, params = []) => (await client.query(text, [...params])).rows,
        };
        const result = await fn(runner);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    query: async (text, params = []) => (await pool.query(text, [...params])).rows,
    close: () => pool.end(),
  };
}

function pglite(location: string): Database {
  // PGlite creates only the last directory of the path; create the parents on a first run.
  if (location !== 'memory') mkdirSync(location, { recursive: true });
  const client = location === 'memory' ? new PGlite() : new PGlite(location);
  return {
    db: drizzlePglite(client, { schema }) as unknown as Db,
    engine: 'pglite',
    transaction: (fn) =>
      client.transaction((tx) =>
        fn({
          exec: async (text) => {
            await tx.exec(text);
          },
          query: async <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) =>
            (await tx.query<T>(text, [...params])).rows,
        }),
      ),
    query: async <T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []) =>
      (await client.query<T>(text, [...params])).rows,
    close: () => client.close(),
  };
}

export function createDatabase(url: string): Database {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return postgres(url);
  if (url.startsWith('pglite:')) return pglite(url.slice('pglite:'.length) || 'memory');
  throw new Error('DATABASE_URL must start with postgres://, postgresql:// or pglite:');
}
