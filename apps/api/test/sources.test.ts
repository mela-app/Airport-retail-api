import { mkdtempSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FlightEvent, localToUtc } from '@arm/domain';
import { generateWorld, snapshotAt, toAodbJson, acrisQueueMeasurement } from '@arm/mockgen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AirlineApiAudienceSource } from '../src/adapters/live/airline-audience-source.js';
import { createEndpoint, endpointUrl } from '../src/adapters/live/http.js';
import { NgsiLdSpaceSource } from '../src/adapters/live/ngsi-ld-space-source.js';
import { VendorApiFlightSource, diffFlights } from '../src/adapters/live/vendor-flight-source.js';
import { MockRulesAudienceSource } from '../src/adapters/mock/audience-source.js';
import { MockAidxFlightSource } from '../src/adapters/mock/flight-source.js';
import { MockAcrisSpaceSource } from '../src/adapters/mock/space-source.js';
import { createSources, ensureMockData } from '../src/adapters/registry.js';
import { loadConfig } from '../src/config.js';
import { ManualClock, flush } from './support/manual-clock.js';

const DATE = '2026-10-16';
const baseEnv = { DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-data-')), SIM_DATE: DATE, SIM_SEED: 'mqi' };
const config = loadConfig(baseEnv);
const at = (h: number, m: number) => localToUtc(DATE, h, m, 240);
let dayDir: string;

beforeAll(() => {
  dayDir = ensureMockData(config);
}, 60_000);

/** Collect up to `n` values from a stream, advancing the clock between pulls. */
async function take<T>(iter: AsyncIterable<T>, n: number, clock: ManualClock, stepMs: number): Promise<T[]> {
  const out: T[] = [];
  const it = iter[Symbol.asyncIterator]();
  while (out.length < n) {
    const next = it.next();
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    for (let i = 0; i < 2000 && !settled; i += 1) {
      await flush();
      if (!settled) clock.advance(stepMs);
    }
    const r = await next;
    if (r.done) break;
    out.push(r.value);
  }
  await it.return?.();
  return out;
}

describe('mock-aidx flight source', () => {
  it('snapshots equal the generated truth at any time of day', async () => {
    const clock = new ManualClock(at(0, 0));
    const source = new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock });
    const world = generateWorld({ date: DATE, seed: 'mqi' });
    for (const t of [at(0, 0), at(9, 30), at(14, 10), at(23, 59)]) {
      const fromSource = new Map((await source.snapshot(t)).map((f) => [f.id, f]));
      for (const truth of snapshotAt(world.day, t)) {
        const f = fromSource.get(truth.id);
        expect(f, truth.id).toBeDefined();
        expect({
          status: f?.status,
          gate: f?.gate,
          etd: f?.estimatedTime,
          block: f?.actualBlockTime,
          pax: f?.pax,
        }).toEqual({
          status: truth.status,
          gate: truth.gate,
          etd: truth.estimatedTime,
          block: truth.actualBlockTime,
          pax: truth.pax,
        });
      }
    }
    expect(source.health().every((h) => h.rejectedTotal === 0)).toBe(true);
  });

  it('shows the worked example at 14:10: XH501 at gate 42, delayed to 15:42 local', async () => {
    const source = new MockAidxFlightSource({
      dayDir,
      homeAirport: 'MQI',
      clock: new ManualClock(at(14, 10)),
    });
    const xh501 = (await source.snapshot(at(14, 10))).find((f) => f.id.startsWith('XH501-D'));
    expect(xh501).toMatchObject({
      gate: '42',
      status: 'delayed',
      delayCodes: ['93'],
      estimatedTime: at(15, 42).toISOString().replace('.000', ''),
    });
  });

  it('streams AIDX updates in order as the clock reaches them, with receive times', async () => {
    const clock = new ManualClock(at(14, 0));
    const source = new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock });
    const ctl = new AbortController();
    const events = await take(source.stream(at(14, 0), ctl.signal), 25, clock, 30_000);
    ctl.abort();
    expect(events).toHaveLength(25);
    const times = events.map((e) => Date.parse(e.occurredAt));
    expect(times.every((t, i) => i === 0 || t >= (times.at(i - 1) ?? 0))).toBe(true);
    expect(times.every((t) => t > at(14, 0).getTime())).toBe(true);
    expect(
      events.every(
        (e) => e.source.source === 'aidx' && Date.parse(e.source.receivedAt) >= Date.parse(e.occurredAt),
      ),
    ).toBe(true);
    expect(source.health().find((h) => h.feed === 'aidx')?.messagesTotal).toBeGreaterThanOrEqual(25);
  });

  it('injected AIDX messages reach open streams at once and change the snapshot', async () => {
    const clock = new ManualClock(at(14, 12));
    const source = new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock });
    const target = (await source.snapshot(at(14, 12))).find((f) => f.id.startsWith('XU88-D'));
    if (!target) throw new Error('XU88 missing');
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<IATA_AIDX_FlightLegNotifRQ xmlns="http://www.iata.org/IATA/2007/00" Version="16.1" TimeStamp="2026-10-16T10:12:00Z" TransactionIdentifier="SIM-1" SequenceNmbr="1">',
      '<FlightLeg><LegIdentifier><Airline>XU</Airline><FlightNumber>88</FlightNumber><DepartureAirport>MQI</DepartureAirport><ArrivalAirport>CPZ</ArrivalAirport></LegIdentifier>',
      `<LegData><PublicStatus>DEL</PublicStatus><OperationTime OperationQualifier="OFB" TimeType="SCT">${target.scheduledTime}</OperationTime>`,
      '<OperationTime OperationQualifier="OFB" TimeType="EST">2026-10-16T12:10:00Z</OperationTime><Delay DelayCode="41"/></LegData></FlightLeg>',
      '</IATA_AIDX_FlightLegNotifRQ>',
    ].join('');

    const ctl = new AbortController();
    const it = source.stream(at(14, 12), ctl.signal)[Symbol.asyncIterator]();
    const pending = it.next();
    await flush();
    const injected = source.inject(xml);
    const received = (await pending).value as FlightEvent;
    ctl.abort();
    expect(received.id).toBe(injected.id);
    expect(received).toMatchObject({
      flightId: target.id,
      type: 'delay',
      changes: { estimatedTime: '2026-10-16T12:10:00Z', delayCodes: ['41'] },
    });
    const after = (await source.snapshot(at(14, 12))).find((f) => f.id === target.id);
    expect(after).toMatchObject({ status: 'delayed', estimatedTime: '2026-10-16T12:10:00Z' });

    // The flight's later milestones move with the delay (60 min): no boarding at the old time.
    const atOldOffBlock = (await source.snapshot(at(15, 12))).find((f) => f.id === target.id);
    expect(atOldOffBlock).toMatchObject({ status: 'delayed', actualBlockTime: null });
    const boarding = (await source.snapshot(at(15, 45))).find((f) => f.id === target.id);
    expect(boarding).toMatchObject({ status: 'boarding', actualBlockTime: null });
    const departed = (await source.snapshot(at(16, 30))).find((f) => f.id === target.id);
    expect(departed?.status).toBe('departed');
    expect(Date.parse(departed?.actualBlockTime ?? '')).toBeGreaterThanOrEqual(
      Date.parse('2026-10-16T12:09:00Z'),
    );
  });

  it('an injected gate change sticks: later messages carry the new gate', async () => {
    const clock = new ManualClock(at(14, 0));
    const source = new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock });
    const target = (await source.snapshot(at(14, 0))).find((f) => f.id.startsWith('XU88-D'));
    if (!target) throw new Error('XU88 missing');
    const ctl = new AbortController();
    const it = source.stream(at(14, 0), ctl.signal)[Symbol.asyncIterator]();
    void it.next();
    source.inject(
      `<IATA_AIDX_FlightLegNotifRQ TransactionIdentifier="SIM-2"><FlightLeg><LegIdentifier><Airline>XU</Airline><FlightNumber>88</FlightNumber><DepartureAirport>MQI</DepartureAirport><ArrivalAirport>CPZ</ArrivalAirport></LegIdentifier><LegData><OperationTime OperationQualifier="OFB" TimeType="SCT">${target.scheduledTime}</OperationTime><AirportResources Usage="Planned"><Resource DepartureOrArrival="Departure"><Gate>58</Gate></Resource></AirportResources></LegData></FlightLeg></IATA_AIDX_FlightLegNotifRQ>`,
    );
    ctl.abort();
    const boarding = (await source.snapshot(at(14, 45))).find((f) => f.id === target.id);
    expect(boarding).toMatchObject({ status: 'boarding', gate: '58' });
  });

  it('a new stream from an earlier time discards injections made after it', async () => {
    const clock = new ManualClock(at(14, 30));
    const source = new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock });
    const target = (await source.snapshot(at(14, 30))).find((f) => f.id.startsWith('XU88-D'));
    if (!target) throw new Error('XU88 missing');
    source.inject(
      `<IATA_AIDX_FlightLegNotifRQ TransactionIdentifier="SIM-3"><FlightLeg><LegIdentifier><Airline>XU</Airline><FlightNumber>88</FlightNumber><DepartureAirport>MQI</DepartureAirport><ArrivalAirport>CPZ</ArrivalAirport></LegIdentifier><LegData><PublicStatus>DEL</PublicStatus><OperationTime OperationQualifier="OFB" TimeType="SCT">${target.scheduledTime}</OperationTime><OperationTime OperationQualifier="OFB" TimeType="EST">2026-10-16T13:00:00Z</OperationTime></LegData></FlightLeg></IATA_AIDX_FlightLegNotifRQ>`,
    );
    clock.set(at(14, 0));
    const ctl = new AbortController();
    void source.stream(at(14, 0), ctl.signal)[Symbol.asyncIterator]().next();
    ctl.abort();
    const later = (await source.snapshot(at(14, 31))).find((f) => f.id === target.id);
    expect(later?.estimatedTime).not.toBe('2026-10-16T13:00:00Z');
  });

  it('an injection made while no stream is open is delivered once by the next stream, never twice', async () => {
    const clock = new ManualClock(at(14, 12));
    const source = new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock });
    const target = (await source.snapshot(at(14, 12))).find((f) => f.id.startsWith('XU88-D'));
    if (!target) throw new Error('XU88 missing');
    const xml = [
      '<IATA_AIDX_FlightLegNotifRQ xmlns="http://www.iata.org/IATA/2007/00" TimeStamp="2026-10-16T10:12:00Z">',
      '<FlightLeg><LegIdentifier><Airline>XU</Airline><FlightNumber>88</FlightNumber><DepartureAirport>MQI</DepartureAirport><ArrivalAirport>CPZ</ArrivalAirport></LegIdentifier>',
      `<LegData><PublicStatus>DEL</PublicStatus><OperationTime OperationQualifier="OFB" TimeType="SCT">${target.scheduledTime}</OperationTime>`,
      '<OperationTime OperationQualifier="OFB" TimeType="EST">2026-10-16T12:00:00Z</OperationTime></LegData></FlightLeg>',
      '</IATA_AIDX_FlightLegNotifRQ>',
    ].join('');
    // Injected between two streams (e.g. while the simulation restarts after a jump).
    const injected = source.inject(xml);

    const first = new AbortController();
    const it1 = source.stream(at(14, 12), first.signal)[Symbol.asyncIterator]();
    const got = (await it1.next()).value as FlightEvent;
    first.abort();
    expect(got.id).toBe(injected.id);

    // A later stream from the same time must not repeat it.
    const second = new AbortController();
    const it2 = source.stream(at(14, 12), second.signal)[Symbol.asyncIterator]();
    const pending = it2.next();
    await flush();
    clock.advance(30 * 60_000);
    const next = (await pending).value as FlightEvent;
    second.abort();
    expect(next.id).not.toBe(injected.id);
  });

  it('rejects an injected message for an unknown flight and records it in feed health', () => {
    const source = new MockAidxFlightSource({
      dayDir,
      homeAirport: 'MQI',
      clock: new ManualClock(at(12, 0)),
    });
    const xml =
      '<IATA_AIDX_FlightLegNotifRQ><FlightLeg><LegIdentifier><Airline>ZZ</Airline><FlightNumber>1</FlightNumber><DepartureAirport>MQI</DepartureAirport><ArrivalAirport>CPZ</ArrivalAirport></LegIdentifier><LegData><PublicStatus>DEL</PublicStatus></LegData></FlightLeg></IATA_AIDX_FlightLegNotifRQ>';
    expect(() => source.inject(xml)).toThrow();
    expect(source.health().find((h) => h.feed === 'aidx')?.rejectedTotal).toBe(1);
  });
});

describe('mock-acris space source', () => {
  it('reads facilities, the latest measurement per queue, and streams new ones', async () => {
    const clock = new ManualClock(at(8, 2));
    const source = new MockAcrisSpaceSource({ dayDir, clock });
    expect((await source.facilities()).filter((f) => f.type === 'CheckpointFacility')).toHaveLength(3);
    const latest = await source.latest(at(8, 2));
    expect(latest).toHaveLength(6);
    expect(latest.every((m) => m.measuredAt === at(8, 0).toISOString().replace('.000', ''))).toBe(true);
    const ctl = new AbortController();
    const next = await take(source.stream(at(8, 2), ctl.signal), 6, clock, 60_000);
    ctl.abort();
    expect(next.every((m) => m.measuredAt === at(8, 5).toISOString().replace('.000', ''))).toBe(true);
  });
});

describe('mock-rules audience source', () => {
  it('returns feed profiles, and rule-based ones for flights the feed does not know', async () => {
    const clock = new ManualClock(at(12, 0));
    const flights = await new MockAidxFlightSource({ dayDir, homeAirport: 'MQI', clock }).snapshot(at(12, 0));
    const source = new MockRulesAudienceSource({ dayDir, utcOffsetMinutes: 240, clock });
    const xh501 = flights.find((f) => f.id.startsWith('XH501-D'));
    if (!xh501) throw new Error('XH501 missing');
    const unknown = { ...xh501, id: 'XH777-D-20261016', flightNumber: '777' };
    const profiles = await source.profiles([xh501, unknown]);
    expect(profiles.get(xh501.id)?.segments.tripPurpose.holiday).toBe(0.415);
    expect(profiles.get(unknown.id)?.segments.market.international).toBe(1);
  });
});

describe('live adapters (against a local fake vendor)', () => {
  let server: Server;
  let base: string;
  let version = 0;
  const world = generateWorld({ date: DATE, seed: 'mqi', pairs: 40, includeWorkedExample: false });
  let down = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (down) {
        res.writeHead(503).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/flights') {
        const flights = version === 0 ? world.startOfDay : world.endOfDay;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(toAodbJson(flights));
      } else if (url.pathname === '/ngsi-ld/v1/entities') {
        const type = url.searchParams.get('type');
        const body =
          type === 'QueueMeasurement' ? world.queueMeasurements.slice(0, 12).map(acrisQueueMeasurement) : [];
        res.writeHead(200, { 'Content-Type': 'application/ld+json' }).end(JSON.stringify(body));
      } else if (url.pathname === '/audience-aggregates' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c: Buffer) => {
          raw += c.toString();
        });
        req.on('end', () => {
          const ids = (JSON.parse(raw) as { flightIds: string[] }).flightIds;
          const body = Object.fromEntries(ids.map((id) => [id, world.profiles.get(id)]).filter(([, p]) => p));
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const endpoint = () =>
    createEndpoint({ baseUrl: base, token: 'secret', timeoutMs: 2000, maxBytes: 5_000_000 });

  it('vendor-api: loads the snapshot and turns changes between polls into flight events', async () => {
    version = 0;
    const clock = new ManualClock(at(0, 0));
    const source = new VendorApiFlightSource({ endpoint: endpoint(), pollIntervalMs: 15_000, clock });
    expect(await source.snapshot(at(0, 0))).toHaveLength(80);
    const ctl = new AbortController();
    const it = source.stream(at(0, 0), ctl.signal)[Symbol.asyncIterator]();
    const first = it.next();
    await clock.waitForSleeper();
    version = 1;
    clock.advance(15_000);
    const event = (await first).value as FlightEvent;
    ctl.abort();
    expect(event.source.source).toBe('vendor-api');
    expect(Object.keys(event.changes).length).toBeGreaterThan(0);
  });

  it('vendor-api: diffs classify gate changes and delays', () => {
    const f = world.startOfDay.find((x) => x.direction === 'D');
    if (!f) throw new Error('no departure');
    expect(diffFlights(f, { ...f, gate: 'B9' }, f.scheduledTime, 1)?.type).toBe('gate_change');
    expect(
      diffFlights(f, { ...f, status: 'delayed', estimatedTime: f.scheduledTime }, f.scheduledTime, 2)?.type,
    ).toBe('delay');
    expect(diffFlights(f, f, f.scheduledTime, 3)).toBeNull();
  });

  it('ngsi-ld: reads queue measurements from a context broker', async () => {
    const source = new NgsiLdSpaceSource({
      endpoint: endpoint(),
      pollIntervalMs: 15_000,
      clock: new ManualClock(at(1, 0)),
    });
    expect((await source.latest()).length).toBeGreaterThan(0);
  });

  it('airline-api: fetches aggregated profiles in batches', async () => {
    const source = new AirlineApiAudienceSource({ endpoint: endpoint(), clock: new ManualClock(at(1, 0)) });
    const profiles = await source.profiles(world.startOfDay);
    expect(profiles.size).toBe(world.startOfDay.length);
  });

  it('reports an unreachable or failing vendor as down in feed health', async () => {
    down = true;
    const source = new VendorApiFlightSource({
      endpoint: endpoint(),
      pollIntervalMs: 15_000,
      clock: new ManualClock(at(0, 0)),
    });
    await expect(source.snapshot(at(0, 0))).rejects.toThrow(/HTTP 503/);
    expect(source.health().find((h) => h.feed === 'aodb')).toMatchObject({
      status: 'down',
      lastError: expect.stringContaining('503'),
    });
    expect(JSON.stringify(source.health())).not.toContain('secret');
    down = false;
  });
});

describe('live endpoint safety', () => {
  it('accepts only http(s) endpoints without embedded credentials', () => {
    const ok = { timeoutMs: 1000, maxBytes: 1000 };
    expect(() => createEndpoint({ ...ok, baseUrl: 'ftp://aodb.example/' })).toThrow(/http or https/);
    expect(() => createEndpoint({ ...ok, baseUrl: 'https://user:pw@aodb.example/' })).toThrow(/credentials/);
    expect(() => createEndpoint({ ...ok, baseUrl: 'not a url' })).toThrow(/invalid/);
  });

  it('builds request URLs from encoded segments, so a path cannot leave the configured endpoint', () => {
    const ep = createEndpoint({ baseUrl: 'https://aodb.example/api', timeoutMs: 1000, maxBytes: 1000 });
    expect(endpointUrl(ep, ['flights'], new Map([['date', '2026-10-16']])).href).toBe(
      'https://aodb.example/api/flights?date=2026-10-16',
    );
    const hostile = endpointUrl(ep, ['//evil.example/x', '../../admin']);
    expect(hostile.origin).toBe('https://aodb.example');
    expect(hostile.pathname.startsWith('/api/')).toBe(true);
    expect(ep.allowedOrigins).toEqual(new Set(['https://aodb.example']));
  });
});

describe('configuration switch', () => {
  it('one value per source selects the mock or the live adapter', () => {
    const clock = new ManualClock(at(0, 0));
    const mock = createSources(config, clock);
    expect([mock.flights.adapter, mock.space.adapter, mock.audience.adapter]).toEqual([
      'mock-aidx',
      'mock-acris',
      'mock-rules',
    ]);
    const live = createSources(
      loadConfig({
        ...baseEnv,
        FLIGHT_SOURCE: 'vendor-api',
        VENDOR_API_URL: 'https://aodb.example/api/',
        SPACE_SOURCE: 'ngsi-ld',
        NGSI_LD_URL: 'https://broker.example/',
        AUDIENCE_SOURCE: 'airline-api',
        AIRLINE_API_URL: 'https://airline.example/',
      }),
      clock,
    );
    expect([live.flights.adapter, live.space.adapter, live.audience.adapter]).toEqual([
      'vendor-api',
      'ngsi-ld',
      'airline-api',
    ]);
  });

  it('refuses a live adapter without its endpoint', () => {
    expect(() => loadConfig({ FLIGHT_SOURCE: 'vendor-api' })).toThrow(/VENDOR_API_URL/);
    expect(() => loadConfig({ FLIGHT_SOURCE: 'something-else' })).toThrow(/FLIGHT_SOURCE/);
  });
});
