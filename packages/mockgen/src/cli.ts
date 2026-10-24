/**
 * Mock data generator CLI.
 *
 *   pnpm generate [--date YYYY-MM-DD] [--seed text] [--pairs N] [--out dir] [--no-worked-example]
 *
 * Writes one operating day at Meridian International (MQI) in each source's native format.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_DAY_OPTIONS } from './schedule.js';
import { generateWorld, writeWorld } from './world.js';

const { values } = parseArgs({
  options: {
    date: { type: 'string', default: process.env.SIM_DATE ?? DEFAULT_DAY_OPTIONS.date },
    seed: { type: 'string', default: process.env.SIM_SEED ?? DEFAULT_DAY_OPTIONS.seed },
    pairs: { type: 'string', default: String(DEFAULT_DAY_OPTIONS.pairs) },
    out: { type: 'string' },
    'no-worked-example': { type: 'boolean', default: false },
  },
});

const date = values.date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
const pairs = Number.parseInt(values.pairs, 10);
if (!Number.isInteger(pairs) || pairs < 10 || pairs > 2000)
  throw new Error('--pairs must be an integer between 10 and 2000');

const out = resolve(values.out ?? `../../data/generated/${date}`);
const started = Date.now();
const world = generateWorld({
  date,
  seed: values.seed,
  pairs,
  includeWorkedExample: !values['no-worked-example'],
});
const files = writeWorld(world, out);
console.log(
  `Generated ${world.startOfDay.length} flights, ${world.aidx.length} AIDX messages, ${world.inventory.screens.length} screens, ${world.inventory.campaigns.length} campaigns for ${date} in ${Date.now() - started} ms`,
);
console.log(`${files.length} files written to ${out}`);
