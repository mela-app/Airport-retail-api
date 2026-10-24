/**
 * End-to-end: the decision engine inside the running application (PGlite, mock feeds, mock AI agent).
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SIMULATION } from '../src/core/tokens.js';
import type { Simulation } from '../src/sim/simulation.js';

let app: INestApplication;
let base: string;
const SCREEN = 'SCR-T2-D-01';

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'pglite:memory',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-engine-')),
    SIM_DATE: '2026-10-16',
    SIM_SEED: 'mqi',
    SIM_AUTOPLAY: 'false',
    AI_MOCK_FAULT_RATE: '0',
  });
  app = await createApp(config, false);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

type Json = Record<string, unknown>;
const get = async <T = Json>(path: string) => (await (await fetch(base + path)).json()) as T;
const send = async (method: string, path: string, body: unknown = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Json };
};

interface NowView {
  run: {
    campaignId: string | null;
    score: number | null;
    mode: string;
    reason: string;
    rules: { rule: string }[];
  } | null;
  context: {
    crowd: { pax: number; medianDwellMin: number; international: number; flights: { flight: string }[] };
    candidates: {
      campaignId: string;
      eligible: boolean;
      score: { final: number; match: number; boost: number } | null;
    }[];
    order: string[];
    ai: { status: string; checks: { name: string; passed: boolean }[]; rationale: string | null };
  } | null;
}

const waitFor = async <T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('decision engine (end to end)', () => {
  it('the worked example plays at Gate 42, 14:10, with a verified AI ranking and full evidence', async () => {
    expect((await send('POST', '/api/sim/scenario/worked-example')).status).toBe(200);
    const now = await waitFor(async () => {
      const v = await get<NowView>(`/api/screens/${SCREEN}/now`);
      return v.run ? v : undefined;
    });
    expect(now.run).toMatchObject({ campaignId: 'c01', score: 0.86, mode: 'ai_verified' });
    expect(now.run?.reason).toContain('Perfume Week');
    expect(now.run?.reason).toContain('XH501 delayed 45 min');
    const ctx = now.context;
    expect(ctx?.crowd).toMatchObject({ pax: 420, medianDwellMin: 52, international: 57.1 });
    const top = ctx?.order.slice(0, 3).map((id) => {
      const c = ctx.candidates.find((x) => x.campaignId === id);
      return [id, Number(c?.score?.final.toFixed(2))];
    });
    expect(top).toEqual([
      ['c01', 0.86],
      ['c02', 0.52],
      ['c03', 0.21],
    ]);
    expect(ctx?.ai.status).toBe('verified');
    expect(ctx?.ai.checks.every((c) => c.passed)).toBe(true);
    expect(ctx?.ai.rationale).toContain('71% audience match');

    const log = await get<{ campaignId: string; open: boolean }[]>(`/api/decisions?screenId=${SCREEN}`);
    expect(log.at(0)).toMatchObject({ campaignId: 'c01', open: true });
  });

  it('rotates after two perfume plays in a row (toys next), and records plays, impressions and spend', async () => {
    await send('POST', '/api/sim/speed', { speed: 60 });
    await send('POST', '/api/sim/play');
    const rotated = await waitFor(async () => {
      const v = await get<NowView>(`/api/screens/${SCREEN}/now`);
      return v.run?.campaignId === 'c02' ? v : undefined;
    }, 20_000);
    const ruleNames = rotated.run?.rules.map((r) => r.rule) ?? [];
    expect(ruleNames.some((r) => r === 'rotation' || r === 'frequency_cap')).toBe(true);
    // The lounge (0.21) never plays here: it is held for screens where it fits better.
    expect(ruleNames).toContain('relevance_floor');
    await send('POST', '/api/sim/pause');
    const kpis = await get<{
      playsToday: number;
      impressionsToday: number;
      mediaRevenueToday: number;
      screens: { onlinePct: number };
    }>('/api/kpis/network');
    expect(kpis.playsToday).toBeGreaterThan(180);
    expect(kpis.impressionsToday).toBeGreaterThan(0);
    expect(kpis.mediaRevenueToday).toBeGreaterThan(0);
  }, 40_000);

  it('a further delay on XH501 hands Gate 42 to the Halcyon goodwill voucher', async () => {
    await send('POST', '/api/sim/scenario/worked-example');
    const injected = await send('POST', '/api/sim/inject/delay', {
      flightId: 'XH501-D-20261016',
      minutes: 20,
    });
    expect(injected.status).toBe(200);
    await send('POST', '/api/sim/speed', { speed: 10 });
    await send('POST', '/api/sim/play');
    const voucher = await waitFor(async () => {
      const v = await get<NowView>(`/api/screens/${SCREEN}/now`);
      return v.run?.campaignId === 'c08' ? v : undefined;
    }, 15_000);
    await send('POST', '/api/sim/pause');
    expect(voucher.run?.reason).toContain('XH501 delayed 65 min');
  }, 40_000);

  it('a Media Manager pin overrides the ranking, with its reason', async () => {
    await send('POST', '/api/sim/scenario/worked-example');
    const pin = await send('POST', '/api/pins', {
      screenId: SCREEN,
      campaignId: 'c03',
      minutes: 30,
      reason: 'lounge launch week',
    });
    expect(pin.status).toBe(201);
    await send('POST', '/api/sim/speed', { speed: 10 });
    await send('POST', '/api/sim/play');
    const pinned = await waitFor(async () => {
      const v = await get<NowView>(`/api/screens/${SCREEN}/now`);
      return v.run?.mode === 'manual_pin' ? v : undefined;
    }, 15_000);
    await send('POST', '/api/sim/pause');
    expect(pinned.run?.campaignId).toBe('c03');
    expect(pinned.run?.reason).toContain('lounge launch week');
    expect((await send('DELETE', `/api/pins/${String(pin.body.id)}`)).status).toBe(200);
  }, 40_000);

  it('learns: simulated scans and redemptions accumulate and the model retrains at :30', async () => {
    await send('POST', '/api/sim/scenario/worked-example');
    await send('POST', '/api/sim/speed', { speed: 60 });
    await send('POST', '/api/sim/play');
    // 14:10 → past 14:30 at 60x is about 20 real seconds.
    const model = await waitFor(async () => {
      const m = await get<{ version: string }>('/api/model');
      return m.version.endsWith(' r1') ? m : undefined;
    }, 45_000);
    await send('POST', '/api/sim/pause');
    expect(model.version).toMatch(/ r1$/);
    const kpis = await get<{
      scansToday: number;
      redemptionsToday: number;
      attributedSalesToday: number;
      playlistBuild: { p95Ms: number; skippedSlots: number };
    }>('/api/kpis/network');
    expect(kpis.scansToday).toBeGreaterThan(0);
    expect(kpis.redemptionsToday).toBeGreaterThan(0);
    expect(kpis.attributedSalesToday).toBeGreaterThan(0);
    // Only a guard against pathological regressions: this runs while every other test file (and, under
    // `pnpm -r test`, the other packages) compete for the CPU. The real 250 ms budget at 60x is measured in
    // isolation by `pnpm --filter @arm/api perf`.
    expect(kpis.playlistBuild.p95Ms).toBeLessThan(1500);
    const segments = await get<{
      campaigns: { campaignId: string; segments: { segment: string; viewers: number }[] }[];
    }>('/api/model');
    const perfume = segments.campaigns.find((c) => c.campaignId === 'c01');
    expect(perfume?.segments.some((s) => s.viewers > 0)).toBe(true);
  }, 60_000);

  it('serves presence now and as a 2-hour forecast', async () => {
    await send('POST', '/api/sim/scenario/worked-example');
    const zones = await get<{ zones: { zoneId: string; pax: number }[] }>('/api/presence/zones');
    expect(zones.zones).toHaveLength(17);
    expect(zones.zones.find((z) => z.zoneId === 'T2-PLZ')?.pax).toBeGreaterThan(0);
    const forecast = await get<{ points: { pax: number; topDestinations: unknown[] }[] }>(
      '/api/presence/forecast?zoneId=T2-PLZ&hours=2&stepMin=15',
    );
    expect(forecast.points).toHaveLength(9);
    const screens = await get<{ screenId: string; pax: number }[]>('/api/presence/screens');
    expect(screens.find((s) => s.screenId === SCREEN)?.pax).toBe(420);
  });

  it('validates rule-engine settings and applies valid ones', async () => {
    const current = (await get<{ settings: Json }>('/api/settings/rule-engine')).settings;
    expect((await send('PUT', '/api/settings/rule-engine', { ...current, explorationPct: 99 })).status).toBe(
      400,
    );
    const ok = await send('PUT', '/api/settings/rule-engine', { ...current, explorationPct: 8 });
    expect(ok.status).toBe(200);
    expect((ok.body.settings as Json).explorationPct).toBe(8);
  });

  it('exposes the learning model with per-segment conversion', async () => {
    const model = await get<{
      version: string;
      campaigns: { campaignId: string; segments: { segment: string }[] }[];
    }>('/api/model');
    expect(model.version).toMatch(/r\d+$/);
    expect(model.campaigns.find((c) => c.campaignId === 'c01')?.segments.length).toBeGreaterThan(0);
  });
});

describe('context refresh (60x without lag)', () => {
  const windowCount = (window: string) =>
    [...app.get<Simulation>(SIMULATION).engine.contextsInUse().values()].filter(
      (c) => Date.parse(c.windowStart) === Date.parse(window),
    ).length;

  it('spreads a new presence window over a few slots, but applies master-data changes at once', async () => {
    await send('POST', '/api/sim/scenario/worked-example');
    const sim = app.get<Simulation>(SIMULATION);
    const screens = sim.engine.catalog.screens().length;
    // Paused at 14:10 local (10:10Z): the next presence window starts at 14:15.
    const next = '2026-10-16T10:15:00.000Z';
    await sim.engine.processSlot(new Date(next));
    const first = windowCount(next);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(screens);
    for (const s of [15, 30, 45]) await sim.engine.processSlot(new Date(Date.parse(next) + s * 1000));
    expect(windowCount(next)).toBe(screens);

    // A master-data change (stock toggle) must reach every screen in the very next slot.
    const before = new Map(sim.engine.contextsInUse());
    expect((await send('PUT', '/api/campaigns/c01/stock', { inStock: false })).status).toBe(200);
    await sim.engine.processSlot(new Date(Date.parse(next) + 60_000));
    const after = sim.engine.contextsInUse();
    const rebuilt = [...after].filter(([id, c]) => before.get(id)?.contextId !== c.contextId).length;
    expect(rebuilt).toBe(screens);
    await send('PUT', '/api/campaigns/c01/stock', { inStock: true });
  }, 60_000);
});

describe('cause and effect (≤ 2 s)', () => {
  it('re-plans the Gate 42 screen at once when XH501 is delayed further, even with the clock paused', async () => {
    await send('POST', '/api/sim/scenario/worked-example');
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/stream?topics=decisions`, { signal: ctl.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen = (async () => {
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const data = JSON.parse(line.slice(6)) as {
            changes?: { screenId: string; campaignId: string | null }[];
          };
          const change = data.changes?.find((c) => c.screenId === SCREEN);
          if (change) return change;
        }
      }
    })();
    const started = performance.now();
    expect(
      (await send('POST', '/api/sim/inject/delay', { flightId: 'XH501-D-20261016', minutes: 30 })).status,
    ).toBe(200);
    const change = await Promise.race([seen, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    const elapsed = performance.now() - started;
    ctl.abort();
    // 75 minutes late now: the airline's co-funded goodwill voucher (threshold 60 min) takes the screen.
    expect(change?.campaignId).toBe('c08');
    expect(elapsed).toBeLessThan(2000);
    const now = await get<NowView>(`/api/screens/${SCREEN}/now`);
    expect(now.run?.campaignId).toBe('c08');
  }, 30_000);
});
