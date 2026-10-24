/**
 * End-to-end: the read models behind the retailer, airline and media-manager views.
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

type Json = Record<string, unknown>;
const get = async <T = Json>(path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as T };
};
const post = async <T = Json>(path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
};

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'pglite:memory',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-analytics-')),
    SIM_AUTOPLAY: 'false',
    AI_MOCK_FAULT_RATE: '0',
  });
  app = await createApp(config, false);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  await post('/api/sim/scenario/worked-example', {});
  // Deliver a few slots so today's totals move.
  const sim = app.get<Simulation>(SIMULATION);
  for (let s = 1; s <= 8; s += 1)
    await sim.engine.processSlot(new Date(Date.parse('2026-10-16T10:10:00Z') + s * 15_000));
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('advertiser views', () => {
  it('shows a live dashboard with per-campaign totals', async () => {
    const { status, body } = await get<{
      today: { plays: number; cost: number };
      campaigns: { id: string; today: { plays: number }; pacing: { daily: number | null } }[];
      hourly: { hour: number }[];
    }>('/api/advertisers/adv-aurelia/overview');
    expect(status).toBe(200);
    const perfume = body.campaigns.find((c) => c.id === 'c01');
    expect(perfume?.today.plays).toBeGreaterThan(0);
    expect(body.today.plays).toBe(body.campaigns.reduce((s, c) => s + c.today.plays, 0));
    expect(body.hourly.at(-1)?.hour).toBe(14);
  });

  it('forecasts passenger flow in its zones for the next two hours', async () => {
    const { body } = await get<{
      zones: { id: string }[];
      points: unknown[];
      next60: { averagePax: number };
    }>('/api/advertisers/adv-aurelia/flow?hours=2');
    expect(body.zones.map((z) => z.id)).toContain('T2-PLZ');
    expect(body.points).toHaveLength(9);
    expect(body.next60.averagePax).toBeGreaterThan(0);
  });

  it('reports campaign performance with 30 days of history', async () => {
    const { body } = await get<{
      last30: { days: unknown[]; spend: number; revenue: number; roi: number | null };
      today: { roi: number | null };
      segments: unknown[];
    }>('/api/campaigns/c01/performance');
    expect(body.last30.days.length).toBeGreaterThan(0);
    expect(body.segments.length).toBeGreaterThan(0);
    // ROI = (attributed sales − spend) ÷ spend
    const { spend, revenue, roi } = body.last30;
    expect(spend).toBeGreaterThan(0);
    expect(roi).toBeCloseTo((revenue - spend) / spend, 3);
    expect(body.today).toHaveProperty('roi');
  });

  it('previews a draft campaign against the crowd on its screens', async () => {
    const campaign = (await get<Json>('/api/campaigns/c01')).body;
    const { id: _id, status: _s, performanceIndex: _p, createdAt: _c, updatedAt: _u, ...draft } = campaign;
    const { status, body } = await post<{
      screensPlaced: number;
      screensEligible: number;
      averageMatch: number;
    }>('/api/campaigns/preview', draft);
    expect(status).toBe(200);
    expect(body.screensPlaced).toBeGreaterThan(0);
    expect(body.screensEligible).toBeGreaterThan(0);
    expect(body.averageMatch).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown advertiser', async () => {
    expect((await get('/api/advertisers/nobody/overview')).status).toBe(404);
  });
});

describe('airline view', () => {
  it("lists the airline's flights, profile, gate plays and goodwill activations", async () => {
    const { body } = await get<{
      flights: { flight: string; delayMinutes: number }[];
      profile: { flights: number } | null;
      goodwill: { activations: { flight: string }[] };
      partnerOffers: { match: number }[];
    }>('/api/airlines/XH/overview');
    const xh501 = body.flights.find((f) => f.flight === 'XH501');
    expect(xh501?.delayMinutes).toBe(45);
    expect(body.profile?.flights).toBeGreaterThan(0);
    expect(body.partnerOffers.length).toBeGreaterThan(0);
    // The goodwill voucher triggers at 60 minutes: 45 is not enough…
    expect(body.goodwill.activations.some((a) => a.flight === 'XH501')).toBe(false);
    // …another 30 minutes through the AIDX adapter is.
    expect((await post('/api/sim/inject/delay', { flightId: 'XH501-D-20261016', minutes: 30 })).status).toBe(
      200,
    );
    const after = await get<{ goodwill: { activations: { flight: string; delayMinutes: number }[] } }>(
      '/api/airlines/XH/overview',
    );
    expect(after.body.goodwill.activations.find((a) => a.flight === 'XH501')?.delayMinutes).toBe(75);
  });
});

describe('media manager views', () => {
  it('builds an inventory calendar with sold shares and statuses', async () => {
    const { body } = await get<{
      occupancy: number;
      screens: { cells: { status: string; sold: number }[] }[];
    }>('/api/inventory?zoneId=T2-D');
    expect(body.screens.length).toBeGreaterThan(0);
    expect(body.screens[0]?.cells).toHaveLength(24);
    expect(body.occupancy).toBeGreaterThan(0);
    expect(body.occupancy).toBeLessThanOrEqual(1);
  });

  it('flags under-delivering advertisers', async () => {
    const { body } =
      await get<{ advertiserId: string; deliveryRatio: number | null }[]>('/api/delivery/advertisers');
    expect(body.length).toBeGreaterThan(0);
  });

  it('serves a segment heat map by hour', async () => {
    const { body } = await get<{ segments: string[]; hours: { shares: number[] }[] }>(
      '/api/insights/segments?zoneId=T2-PLZ&from=10&to=12',
    );
    expect(body.hours).toHaveLength(3);
    expect(body.hours[0]?.shares).toHaveLength(body.segments.length);
  });
});

describe('WOW: best slots and the creative assistant', () => {
  it('recommends three slots tomorrow within the campaign schedule', async () => {
    const { body } = await get<{ date: string; slots: { hour: number; zoneId: string; match: number }[] }>(
      '/api/campaigns/c04/best-slots',
    );
    expect(body.date).toBe('2026-10-17');
    expect(body.slots).toHaveLength(3);
    // c04 runs 05:00–11:00 only.
    for (const s of body.slots) expect(s.hour).toBeLessThan(11);
  });

  it('breaks a campaign down by creative for A/B', async () => {
    const { body } = await get<{ creatives: { creativeId: string; plays: number }[] }>(
      '/api/campaigns/c01/performance',
    );
    expect(body.creatives.map((c) => c.creativeId).sort()).toEqual(['cr-c01-a', 'cr-c01-b']);
  });

  it('writes three bilingual creative variants from a brief, with brand-safety checks', async () => {
    const { status, body } = await post<{
      provider: string;
      variants: {
        content: { en: { badge: string | null }; ar: { headline: string } };
        checks: { passed: boolean }[];
      }[];
    }>('/api/creatives/assist', {
      advertiserId: 'adv-brewline',
      brief: 'Morning flat white 2 for 1',
      tone: 'warm',
    });
    expect(status).toBe(200);
    expect(body.provider).toBe('mock');
    expect(body.variants).toHaveLength(3);
    for (const v of body.variants) {
      expect(v.content.en.badge).toBe('2 FOR 1');
      expect(v.content.ar.headline.length).toBeGreaterThan(0);
      expect(v.checks.every((c) => c.passed)).toBe(true);
    }
    expect((await post('/api/creatives/assist', { advertiserId: 'nobody', brief: 'x x x' })).status).toBe(
      404,
    );
  });
});
