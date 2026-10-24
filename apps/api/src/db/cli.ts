/**
 * Database CLI: `migrate`, `seed` (migrate, then load master and platform data) or `reset` (same as seed).
 * Uses DATABASE_URL (default: an embedded PGlite database in ./.pglite).
 */
import { createDatabase } from './client.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

const command = process.argv.at(2) ?? 'migrate';
const url = process.env.DATABASE_URL ?? 'pglite:../../.pglite/arm';
const database = createDatabase(url);

try {
  const applied = await migrate(database);
  console.log(
    applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date',
  );
  if (command === 'seed' || command === 'reset') {
    const counts = await seed(database, {
      simDate: process.env.SIM_DATE ?? '2026-10-16',
      seed: process.env.SIM_SEED ?? 'mqi',
      utcOffsetMinutes: Number.parseInt(process.env.AIRPORT_UTC_OFFSET_MINUTES ?? '240', 10),
      currency: process.env.CURRENCY ?? 'USD',
    });
    console.log('Seeded', counts);
  } else if (command !== 'migrate') {
    throw new Error(`unknown command ${command} (use migrate, seed or reset)`);
  }
} finally {
  await database.close();
}
