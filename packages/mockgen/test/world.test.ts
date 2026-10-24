import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AdvertiserSchema,
  CampaignSchema,
  CreativeSchema,
  FlightSchema,
  OutletSchema,
  QueueMeasurementSchema,
  ScreenSchema,
  gateId,
  localToUtc,
  toLocal,
} from '@arm/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import { AODB_COLUMNS, toAodbCsv } from '../src/formats/aodb.js';
import { acrisStaticEntities } from '../src/formats/acris.js';
import { WORKED_EXAMPLE } from '../src/scenario.js';
import { type World, generateWorld } from '../src/world.js';

const SAMPLE_CSV = fileURLToPath(
  new URL('../../../samples/aodb-samples/MQI_aodb_flights_2026-10-14_SYNTHETIC.csv', import.meta.url),
);

let world: World;
beforeAll(() => {
  world = generateWorld({ date: '2026-10-16', seed: 'test' });
});

describe('scale (challenge: ~900 flights, ~180 screens, 40 outlets, 10 airlines, 25 campaigns, 30 days)', () => {
  it('generates about 900 flights in arrival/departure pairs', () => {
    expect(world.startOfDay).toHaveLength(900);
    expect(world.startOfDay.filter((f) => f.direction === 'D')).toHaveLength(450);
  });

  it('has 180 screens, 40 outlets, 25 campaigns and 30 days of history', () => {
    const inv = world.inventory;
    expect(inv.screens).toHaveLength(180);
    expect(inv.outlets).toHaveLength(40);
    expect(inv.campaigns).toHaveLength(25);
    expect(new Set(inv.history.map((h) => h.date)).size).toBe(30);
  });

  it('uses the sample package airlines (11 listed there; the brief says 10)', () => {
    const airlines = new Set(world.startOfDay.map((f) => f.airlineIata));
    expect(airlines.size).toBeGreaterThanOrEqual(10);
    expect(world.inventory.advertisers.filter((a) => a.kind === 'airline')).toHaveLength(11);
  });
});

describe('AODB export', () => {
  it('writes exactly the 33 columns of the sample file, in the same order', () => {
    const sampleHeader = readFileSync(SAMPLE_CSV, 'utf8').split('\n')[0]?.trim();
    expect(AODB_COLUMNS).toHaveLength(33);
    expect(toAodbCsv(world.startOfDay).split('\n')[0]).toBe(sampleHeader);
  });

  it('links each leg to its partner by AODB key, as the sample does', () => {
    const rows = toAodbCsv(world.endOfDay)
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(','));
    const ids = new Set(rows.map((r) => r[0]));
    for (const r of rows) expect(ids.has(r[1])).toBe(true);
  });

  it('end-of-day statuses use the sample codes ARR / DEP / CNL', () => {
    expect(new Set(world.endOfDay.map((f) => f.status))).toEqual(
      new Set(['arrived', 'departed', 'cancelled']),
    );
  });

  it('every flight validates against the canonical schema and links to its pair', () => {
    const byId = new Map(world.endOfDay.map((f) => [f.id, f]));
    for (const f of world.endOfDay) {
      expect(FlightSchema.safeParse(f).success).toBe(true);
      const partner = f.linkedFlightId ? byId.get(f.linkedFlightId) : undefined;
      expect(partner?.direction).toBe(f.direction === 'A' ? 'D' : 'A');
      expect(byId.has(f.id)).toBe(true);
    }
  });

  it('delays about a third of departures with IATA delay codes, like the sample', () => {
    const deps = world.endOfDay.filter((f) => f.direction === 'D' && f.status !== 'cancelled');
    const delayed = deps.filter((f) => f.delayCodes.length > 0).length / deps.length;
    expect(delayed).toBeGreaterThan(0.2);
    expect(delayed).toBeLessThan(0.4);
  });

  it('never books two departures on one gate at overlapping times', () => {
    const deps = world.endOfDay.filter((f) => f.direction === 'D' && f.gate && f.status !== 'cancelled');
    const byGate = new Map<string, [number, number][]>();
    for (const f of deps) {
      const key = gateId(f.terminal, f.gate ?? '');
      const etd = Date.parse(f.estimatedTime ?? f.scheduledTime);
      const list = byGate.get(key) ?? [];
      list.push([etd - 40 * 60_000, etd]);
      byGate.set(key, list);
    }
    for (const [, uses] of byGate) {
      uses.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < uses.length; i += 1) {
        const prev = uses.at(i - 1);
        const cur = uses.at(i);
        expect(prev && cur && cur[0] >= prev[1] - 25 * 60_000).toBe(true);
      }
    }
  });
});

describe('determinism', () => {
  it('the same date and seed produce identical data', () => {
    const again = generateWorld({ date: '2026-10-16', seed: 'test' });
    expect(toAodbCsv(again.endOfDay)).toBe(toAodbCsv(world.endOfDay));
    expect(again.aidx.map((m) => m.xml)).toEqual(world.aidx.map((m) => m.xml));
  });

  it('a different seed produces a different day', () => {
    const other = generateWorld({ date: '2026-10-16', seed: 'other' });
    expect(toAodbCsv(other.endOfDay)).not.toBe(toAodbCsv(world.endOfDay));
  });
});

describe('worked example (Gate 42 at 14:10)', () => {
  it('places XH501 to Zarhan (delayed 45 min, 240 pax) and XU88 to Coralport (180 pax) next to each other', () => {
    const xh = world.endOfDay.find((f) => f.id.startsWith('XH501-D'));
    const xu = world.endOfDay.find((f) => f.id.startsWith('XU88-D'));
    expect(xh).toMatchObject({
      gate: '42',
      terminal: 'T2',
      destination: 'ZHQ',
      pax: 240,
      nature: 'international',
    });
    expect(xu).toMatchObject({
      gate: '43',
      terminal: 'T2',
      destination: 'CPZ',
      pax: 180,
      nature: 'domestic',
    });
    const delay = (Date.parse(xh?.estimatedTime ?? '') - Date.parse(xh?.scheduledTime ?? '')) / 60_000;
    expect(delay).toBe(45);
    expect(toLocal(xh?.scheduledTime ?? '', 240)).toMatchObject({ hour: 14, minute: 57 });
  });

  it('publishes the XH501 delay before 14:10 local', () => {
    const delayMsg = world.aidx.find((m) => m.flightId.startsWith('XH501-D') && m.type === 'delay');
    expect(delayMsg).toBeDefined();
    expect(Date.parse(delayMsg?.at ?? '')).toBeLessThan(localToUtc('2026-10-16', 14, 10, 240).getTime());
    expect(delayMsg?.xml).toContain('<Delay DelayCode="93"');
  });

  it('keeps the neighbouring gates free, so only the two example flights form the crowd', () => {
    const neighbours = new Set(WORKED_EXAMPLE.keepFreeGateIds.map((g) => g.replace('T2-', '')));
    expect(world.endOfDay.some((f) => f.terminal === 'T2' && f.gate !== null && neighbours.has(f.gate))).toBe(
      false,
    );
  });

  it('pins the two flight profiles so the combined crowd is 58% holiday, 31% family, 22% business, 57% international', () => {
    const profiles = ['XH501-D', 'XU88-D'].map(
      (p) => [...world.profiles].find(([id]) => id.startsWith(p))?.[1],
    );
    const total = profiles.reduce((s, p) => s + (p?.pax ?? 0), 0);
    const share = (pick: (p: NonNullable<(typeof profiles)[number]>) => number) =>
      profiles.reduce((s, p) => s + (p ? pick(p) * p.pax : 0), 0) / total;
    expect(share((p) => p.segments.tripPurpose.holiday)).toBeCloseTo(0.58, 2);
    expect(share((p) => p.segments.partyType.family)).toBeCloseTo(0.31, 2);
    expect(share((p) => p.segments.tripPurpose.business)).toBeCloseTo(0.22, 2);
    expect(share((p) => p.segments.market.international)).toBeCloseTo(0.571, 2);
  });
});

describe('AIDX stream', () => {
  it('is time-ordered, sequenced, and every message is an AIDX FlightLegNotifRQ', () => {
    for (let i = 1; i < world.aidx.length; i += 1) {
      const prev = world.aidx.at(i - 1);
      const cur = world.aidx.at(i);
      expect(prev && cur && prev.at <= cur.at && prev.sequence < cur.sequence).toBe(true);
    }
    for (const m of world.aidx.slice(0, 50)) {
      expect(m.xml).toMatch(
        /^<\?xml version="1.0" encoding="UTF-8"\?>\n<IATA_AIDX_FlightLegNotifRQ xmlns="http:\/\/www.iata.org\/IATA\/2007\/00"/,
      );
      expect(m.xml.trim().endsWith('</IATA_AIDX_FlightLegNotifRQ>')).toBe(true);
    }
  });

  it('covers every event type the platform reacts to', () => {
    const types = new Set(world.aidx.map((m) => m.type));
    for (const t of [
      'delay',
      'gate_change',
      'boarding',
      'gate_closed',
      'off_block',
      'airborne',
      'landed',
      'on_block',
      'cancelled',
    ]) {
      expect(types.has(t as never)).toBe(true);
    }
  });
});

describe('ACRIS', () => {
  it('static entities are NGSI-LD with ids, types and a context', () => {
    const entities = acrisStaticEntities();
    const types = new Set(entities.map((e) => e.type));
    expect(types).toEqual(
      new Set([
        'TerminalFacility',
        'ConcourseFacility',
        'ZoneAreaLocation',
        'CheckpointFacility',
        'PassengerQueue',
      ]),
    );
    for (const e of entities) expect(e.id).toMatch(/^urn:ngsi-ld:[A-Za-z]+:MQI:/);
  });

  it('queue measurements every 5 minutes for each queue, with realistic peak waits', () => {
    expect(world.queueMeasurements).toHaveLength(288 * 6);
    for (const m of world.queueMeasurements.slice(0, 100))
      expect(QueueMeasurementSchema.safeParse(m).success).toBe(true);
    const maxWaitMin = Math.max(...world.queueMeasurements.map((m) => m.waitTimeSec)) / 60;
    expect(maxWaitMin).toBeGreaterThan(5);
    expect(maxWaitMin).toBeLessThan(60);
  });
});

describe('platform data validates against the canonical schemas', () => {
  it('advertisers, outlets, screens, creatives and campaigns', () => {
    const inv = world.inventory;
    const check = (
      schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
      items: readonly unknown[],
    ) => {
      for (const item of items) {
        const r = schema.safeParse(item);
        if (!r.success) throw new Error(`${JSON.stringify(item).slice(0, 120)}: ${String(r.error)}`);
      }
    };
    check(AdvertiserSchema, inv.advertisers);
    check(OutletSchema, inv.outlets);
    check(ScreenSchema, inv.screens);
    check(CreativeSchema, inv.creatives);
    check(CampaignSchema, inv.campaigns);
  });

  it('every campaign references existing creatives, outlets and advertisers', () => {
    const inv = world.inventory;
    const creatives = new Set(inv.creatives.map((c) => c.id));
    const outlets = new Set(inv.outlets.map((o) => o.id));
    const advertisers = new Set(inv.advertisers.map((a) => a.id));
    for (const c of inv.campaigns) {
      expect(advertisers.has(c.advertiserId)).toBe(true);
      for (const id of c.creativeIds) expect(creatives.has(id)).toBe(true);
      if (c.promo?.outletId) expect(outlets.has(c.promo.outletId)).toBe(true);
      if (c.coFundedBy) expect(advertisers.has(c.coFundedBy)).toBe(true);
    }
  });

  it('every creative has English and Arabic content', () => {
    for (const c of world.inventory.creatives) expect(Object.keys(c.content).sort()).toEqual(['ar', 'en']);
  });

  it('gate screens reach nearby gates; the worked-example screen covers gates 42 and 43', () => {
    const screen = world.inventory.screens.find((s) => s.id === 'SCR-T2-D-01');
    expect(screen?.nearestGateIds).toEqual(expect.arrayContaining(['T2-42', 'T2-43']));
    const pierScreens = world.inventory.screens.filter((s) => s.zoneId.match(/^T[12]-[A-F]$/));
    expect(pierScreens.every((s) => s.nearestGateIds.length > 0)).toBe(true);
  });
});
