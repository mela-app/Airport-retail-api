/**
 * Performance check: run the application at 60x for 60 real seconds (one simulated hour) on an in-memory
 * database and report the playlist build time per slot. At 60x a 15-second slot lasts 250 ms of real time,
 * so building every screen's playlist must stay within that. Exits with status 1 if p95 exceeds the budget.
 *
 *   pnpm --filter @arm/api perf
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SIMULATION } from '../src/core/tokens.js';
import type { Simulation } from '../src/sim/simulation.js';

const BUDGET_MS = 250;
const SECONDS = Number(process.env.PERF_SECONDS ?? '60');

const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'pglite:memory',
  DATA_DIR: process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), 'arm-perf-')),
  SIM_AUTOPLAY: 'false',
});
const app = await createApp(config, false);
await app.init();
const sim = app.get<Simulation>(SIMULATION);
await sim.workedExample();
sim.clock.setSpeed(60);
sim.clock.play();
const started = sim.clock.now();
await new Promise((r) => setTimeout(r, SECONDS * 1000));
sim.clock.pause();
const stats = sim.engine.performanceStats();
const today = sim.engine.todayTotals();
console.log(
  JSON.stringify(
    {
      simulated: `${started.toISOString()} → ${sim.clock.now().toISOString()}`,
      screens: sim.engine.catalog.screens().length,
      playlistBuild: stats,
      budgetMs: BUDGET_MS,
      plays: today.plays,
      scans: today.scans,
      redemptions: today.redemptions,
    },
    null,
    2,
  ),
);
await app.close();
process.exit(stats.p95Ms !== null && stats.p95Ms <= BUDGET_MS ? 0 : 1);
