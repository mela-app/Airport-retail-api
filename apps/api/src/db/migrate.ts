/**
 * Applies the SQL migrations in `apps/api/migrations/` in order, each in its own transaction, and records
 * them in `schema_migrations`. Already-applied migrations are skipped, so it is safe to run on every start.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Database } from './client.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{4}_[a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  path: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .map((name) => MIGRATION_FILE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ version: m[1] ?? '', path: `${dir}${m[0]}` }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** Returns the versions applied by this run. */
export async function migrate(database: Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  await database.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await database.query<{ version: string }>('SELECT version FROM schema_migrations')).map(
      (r) => r.version,
    ),
  );
  const applied: string[] = [];
  for (const file of listMigrations(dir)) {
    if (done.has(file.version)) continue;
    const sqlText = readFileSync(file.path, 'utf8');
    await database.transaction(async (runner) => {
      await runner.exec(sqlText);
      await runner.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file.version]);
    });
    applied.push(file.version);
  }
  return applied;
}
