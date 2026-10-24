/**
 * End-to-end: master data management and the scan-to-claim flow, over HTTP on a fresh application.
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'pglite:memory',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-crud-')),
    SIM_DATE: '2026-10-16',
    SIM_SEED: 'mqi',
    SIM_AUTOPLAY: 'false',
    AI_MOCK_FAULT_RATE: '0',
    PUBLIC_BASE_URL: 'https://playground.example',
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
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Json & Json[] };
};
const get = (p: string) => call('GET', p);
const post = (p: string, b: unknown = {}) => call('POST', p, b);
const put = (p: string, b: unknown) => call('PUT', p, b);

const creativeBody = (advertiserId: string) => ({
  advertiserId,
  name: 'Mango smoothie',
  template: 'offer_split',
  artwork: 'coffee',
  palette: { background: '#FFF4E6', foreground: '#2B2B2B', accent: '#E94F37' },
  content: {
    en: {
      headline: 'Mango smoothie, 2 for 1',
      body: 'Freshly blended at the plaza bar.',
      cta: 'Scan to claim',
      badge: '2 FOR 1',
    },
  },
  formats: ['16:9', '9:16'],
  brandSafety: {
    noRealBrandMarks: true,
    claimsVerified: false,
    ageAppropriate: true,
    legibleAtDistance: true,
  },
});

const campaignBody = (advertiserId: string, creativeIds: string[], outletId: string | null) => ({
  advertiserId,
  name: 'Smoothie launch',
  objective: 'conversion',
  creativeIds,
  segmentWeights: { 'tripPurpose.holiday': 1, 'partyType.family': 0.8 },
  hardFilters: {
    market: null,
    destinationRegions: [],
    destinations: [],
    minDwellMinutes: null,
    minCrowd: null,
  },
  placement: {
    zoneIds: ['T2-PLZ'],
    screenIds: [],
    gateIds: [],
    schedule: { start: '2026-10-16T00:00:00Z', end: '2026-10-30T00:00:00Z', daysOfWeek: [], hours: null },
  },
  budget: { total: 30000, dailyCap: 3000, cpm: 10, frequencyCapPerScreenHour: 40 },
  triggers: [],
  promo: outletId
    ? {
        offerText: 'Two smoothies for one',
        codePrefix: 'MANGO',
        validity: { mode: 'minutes', minutes: 45 },
        shareable: true,
        outletId,
        inStock: true,
      }
    : null,
  airlinePriority: false,
  coFundedBy: null,
});

describe('master data', () => {
  let advertiserId = '';
  let outletId = '';
  let creativeId = '';
  let campaignId = '';

  it('creates and validates vendors and outlets', async () => {
    const bad = await post('/api/advertisers', {
      name: 'X',
      kind: 'airline',
      category: 'Airline',
      competitorGroup: null,
      airlineIata: null,
      contactName: 'A',
      contactEmail: 'a@b.example',
      brandColor: '#112233',
    });
    expect(bad.status).toBe(400);
    const adv = await post('/api/advertisers', {
      name: 'Mango Bay Juices',
      kind: 'fnb',
      category: 'Juice bar',
      competitorGroup: null,
      airlineIata: null,
      contactName: 'Ana Ruiz',
      contactEmail: 'ana@mangobay.example',
      brandColor: '#F2994A',
    });
    expect(adv.status).toBe(201);
    advertiserId = String(adv.body.id);
    expect(
      (
        await post('/api/outlets', {
          advertiserId,
          name: 'Mango Bay',
          category: 'fnb_dining',
          zoneId: 'NOPE',
          averageBasket: 9,
        })
      ).status,
    ).toBe(400);
    const outlet = await post('/api/outlets', {
      advertiserId,
      name: 'Mango Bay – T2 Plaza',
      category: 'fnb_dining',
      zoneId: 'T2-PLZ',
      averageBasket: 9,
    });
    expect(outlet.status).toBe(201);
    expect(outlet.body).toMatchObject({ terminalId: 'T2', zoneId: 'T2-PLZ', active: true });
    outletId = String(outlet.body.id);
  });

  it('runs the creative review: brand-safety checks must pass before approval', async () => {
    const cr = await post('/api/creatives', creativeBody(advertiserId));
    expect(cr.status).toBe(201);
    creativeId = String(cr.body.id);
    expect((await post(`/api/creatives/${creativeId}/review`, { decision: 'approve' })).status).toBe(400);
    const ok = await post(`/api/creatives/${creativeId}/review`, {
      decision: 'approve',
      brandSafety: {
        noRealBrandMarks: true,
        claimsVerified: true,
        ageAppropriate: true,
        legibleAtDistance: true,
      },
    });
    expect(ok.body.status).toBe('approved');
  });

  it('validates campaigns against the rest of the master data', async () => {
    expect((await post('/api/campaigns', campaignBody(advertiserId, ['cr-c01-a'], outletId))).status).toBe(
      400,
    ); // another advertiser's creative
    const wrongDates = campaignBody(advertiserId, [creativeId], outletId);
    wrongDates.placement.schedule.end = '2026-10-01T00:00:00Z';
    expect((await post('/api/campaigns', wrongDates)).status).toBe(400);
    expect((await post('/api/campaigns', campaignBody(advertiserId, [creativeId], 'out-01'))).status).toBe(
      400,
    ); // outlet of another vendor
  });

  it('creates, submits, approves, pauses and duplicates a campaign; drafts can be deleted', async () => {
    const c = await post('/api/campaigns', campaignBody(advertiserId, [creativeId], outletId));
    expect(c.status).toBe(201);
    campaignId = String(c.body.id);
    expect(c.body).toMatchObject({ status: 'draft', performanceIndex: 0.3 });
    expect((await post(`/api/campaigns/${campaignId}/review`, { decision: 'approve' })).status).toBe(409); // not submitted
    expect((await post(`/api/campaigns/${campaignId}/submit`)).body.status).toBe('pending_review');
    expect((await post(`/api/campaigns/${campaignId}/review`, { decision: 'approve' })).body.status).toBe(
      'active',
    );
    expect((await post(`/api/campaigns/${campaignId}/pause`)).body.status).toBe('paused');
    expect((await post(`/api/campaigns/${campaignId}/resume`)).body.status).toBe('active');
    expect((await put(`/api/campaigns/${campaignId}/stock`, { inStock: false })).body.promo).toMatchObject({
      inStock: false,
    });
    const copy = await post(`/api/campaigns/${campaignId}/duplicate`);
    expect(copy.body).toMatchObject({ status: 'draft', name: 'Smoothie launch (copy)' });
    expect((await call('DELETE', `/api/campaigns/${campaignId}`)).status).toBe(409);
    expect((await call('DELETE', `/api/campaigns/${String(copy.body.id)}`)).status).toBe(200);
    const listed = await get(`/api/campaigns?advertiserId=${advertiserId}`);
    expect(listed.body).toHaveLength(1);
  });

  it('a new gate can be used for gate changes, until it is taken out of service', async () => {
    const gate = await post('/api/gates', {
      code: '89',
      terminalId: 'T2',
      zoneId: 'T2-F',
      remote: false,
      position: { x: 1400, y: 120 },
    });
    expect(gate.status).toBe(201);
    expect(gate.body).toMatchObject({ id: 'T2-89', concourseId: 'T2-F', active: true });
    const flights = (await get('/api/flights?direction=D&terminal=T2&status=scheduled')).body as unknown as {
      id: string;
    }[];
    const flight = flights.at(-1);
    expect((await post('/api/sim/inject/gate-change', { flightId: flight?.id, gate: '89' })).status).toBe(
      200,
    );
    await put('/api/gates/T2-89', {
      zoneId: 'T2-F',
      remote: false,
      position: { x: 1400, y: 120 },
      active: false,
    });
    const other = flights.at(-2);
    const refused = await post('/api/sim/inject/gate-change', { flightId: other?.id, gate: '89' });
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toContain('out of service');
  });

  it('a new screen joins the network with its nearest gates computed', async () => {
    const s = await post('/api/screens', {
      name: 'Pier F Totem 15',
      zoneId: 'T2-F',
      kind: 'totem',
      orientation: 'portrait',
      sizeInches: 75,
      resolution: '1080x1920',
      basePricePerSlot: 5,
    });
    expect(s.status).toBe(201);
    expect((s.body.nearestGateIds as string[]).length).toBeGreaterThan(0);
    const status = (await get('/api/screens/status')).body as unknown as {
      screens: { id: string; status: string }[];
    };
    expect(status.screens.find((x) => x.id === s.body.id)?.status).toBe('online');
  });

  it('airlines can be added and edited', async () => {
    expect(
      (
        await post('/api/airlines', {
          iata: 'XQ',
          icao: 'QXQ',
          name: 'Quill Air',
          model: 'low_cost',
          market: 'domestic',
          brandColor: '#336699',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post('/api/airlines', {
          iata: 'XQ',
          icao: 'QXQ',
          name: 'Quill Air',
          model: 'low_cost',
          market: 'domestic',
          brandColor: '#336699',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await put('/api/airlines/XQ', {
          icao: 'QXQ',
          name: 'Quill Airways',
          model: 'low_cost',
          market: 'mixed',
          brandColor: '#336699',
          active: false,
        })
      ).body,
    ).toMatchObject({ name: 'Quill Airways', active: false });
  });
});

describe('scan to claim', () => {
  let token = '';
  let code = '';

  it('the worked-example screen shows a QR link that expires at XH501 gate close', async () => {
    await post('/api/sim/scenario/worked-example');
    let now: Json = {};
    const deadline = Date.now() + 20_000;
    while (!now.claim && Date.now() < deadline) {
      now = (await get('/api/screens/SCR-T2-D-01/now')).body;
      if (!now.claim) await new Promise((r) => setTimeout(r, 50));
    }
    const claim = now.claim as { url: string; token: string; expiresAt: string; flightId: string };
    expect(claim.url).toBe(`https://playground.example/claim/${claim.token}`);
    expect(claim.flightId).toBe('XH501-D-20261016');
    expect(claim.expiresAt).toBe('2026-10-16T11:32:00.000Z'); // 15:32 local: ETD 15:42 − 10 min
    token = claim.token;
  }, 90_000);

  it('opening the link shows the offer with a countdown', async () => {
    const offer = await get(`/api/claims/${token}`);
    expect(offer.status).toBe(200);
    expect(offer.body).toMatchObject({
      status: 'open',
      campaign: { id: 'c01', offerText: '15% off all fragrances', shareable: true },
    });
    expect(Number(offer.body.secondsLeft)).toBeGreaterThan(60 * 60);
    expect((offer.body.flight as { label: string }).label).toContain('XH501');
  });

  it('claiming issues a code and records a redemption immediately', async () => {
    const before = (await get('/api/kpis/network')).body.redemptionsToday as number;
    const claimed = await post(`/api/claims/${token}`);
    expect(claimed.status).toBe(201);
    code = String(claimed.body.code);
    expect(code).toMatch(/^PERF15-[A-Z0-9]{5}$/);
    expect((await get('/api/kpis/network')).body.redemptionsToday).toBe(before + 1);
  });

  it('a code can be shared once; the family link issues a second code', async () => {
    const shared = await post(`/api/promo-codes/${code}/share`);
    expect(shared.status).toBe(201);
    const familyToken = String(shared.body.token);
    expect((await post(`/api/promo-codes/${code}/share`)).status).toBe(409);
    const second = await post(`/api/claims/${familyToken}`);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ parentCode: code, shareable: false });
    expect((await post(`/api/claims/${familyToken}`)).status).toBe(409);
    expect((await post(`/api/promo-codes/${String(second.body.code)}/share`)).status).toBe(409);
  });

  it('rejects unknown and expired links', async () => {
    expect((await get('/api/claims/not-a-token')).status).toBe(404);
    expect((await get('/api/claims/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    await post('/api/sim/jump', { localTime: '15:40' });
    expect((await post(`/api/claims/${token}`)).status).toBe(410);
  });

  it('rate-limits a client that opens links too often', async () => {
    let limited = false;
    for (let i = 0; i < 130 && !limited; i += 1)
      limited = (await get('/api/claims/AAAAAAAAAAAAAAAAAAAAAA')).status === 429;
    expect(limited).toBe(true);
  });
});
