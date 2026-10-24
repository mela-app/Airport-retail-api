import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  generateWorld,
  toAodbCsv,
  toAodbJson,
  acrisQueueMeasurement,
  acrisStaticEntities,
} from '@arm/mockgen';
import type { World } from '@arm/mockgen';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseFacility, parseQueueMeasurement } from '../src/adapters/parsers/acris.js';
import { AidxError, parseAidxMessage } from '../src/adapters/parsers/aidx.js';
import { parseAodbCsv, parseAodbJson } from '../src/adapters/parsers/aodb.js';
import { CsvError, parseCsv, parseCsvRows } from '../src/adapters/parsers/csv.js';
import { XmlError, parseXml } from '../src/adapters/parsers/xml.js';

const sample = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../samples/aodb-samples/${name}`, import.meta.url)), 'utf8');
const SAMPLE_CSV = sample('MQI_aodb_flights_2026-10-14_SYNTHETIC.csv');
const SAMPLE_AIDX = sample('AIDX_FlightLegNotifRQ_XH960_arrival_ILLUSTRATIVE.xml');
const RECEIVED = '2026-10-16T00:00:00Z';

let world: World;
beforeAll(() => {
  world = generateWorld({ date: '2026-10-16', seed: 'adapters' });
});

describe('XML parser (strict)', () => {
  it('parses the challenge sample AIDX message', () => {
    const root = parseXml(SAMPLE_AIDX);
    expect(root.name).toBe('IATA_AIDX_FlightLegNotifRQ');
    expect(root.attributes.get('SequenceNmbr')).toBe('184533');
  });

  it('decodes predefined entities, character references and CDATA', () => {
    const root = parseXml('<a t="x &amp; y">1 &lt; 2 &#65;&#x42;<![CDATA[<raw>]]></a>');
    expect(root.attributes.get('t')).toBe('x & y');
    expect(root.text).toBe('1 < 2 AB<raw>');
  });

  it('rejects DOCTYPE, so external entities (XXE) and entity expansion cannot happen', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    const laughs = '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><l>&b;</l>';
    expect(() => parseXml(xxe)).toThrow(XmlError);
    expect(() => parseXml(laughs)).toThrow(/DOCTYPE/);
    expect(() => parseXml('<r>&custom;</r>')).toThrow(/undefined entity/);
  });

  it('rejects malformed documents and bounds nesting depth', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(/mismatched/);
    expect(() => parseXml('<a>')).toThrow(XmlError);
    expect(() => parseXml('<a></a><b></b>')).toThrow(/after the root/);
    expect(() => parseXml('<a x=1/>')).toThrow(/quoted/);
    expect(() => parseXml(`${'<a>'.repeat(70)}${'</a>'.repeat(70)}`)).toThrow(/too deeply/);
  });
});

describe('CSV parser', () => {
  it('handles quoted fields, escaped quotes, embedded newlines and CRLF', () => {
    expect(parseCsvRows('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('reports field-count mismatches with the line number', () => {
    expect(() => parseCsv('a,b\n1,2,3\n')).toThrow(CsvError);
  });
});

describe('AODB adapter', () => {
  it('parses the challenge sample file: 320 flights, no rejected rows', () => {
    const { flights, errors } = parseAodbCsv(SAMPLE_CSV, RECEIVED);
    expect(errors).toEqual([]);
    expect(flights).toHaveLength(320);
    const xh960 = flights.find((f) => f.id === 'XH960-A-20261014');
    expect(xh960).toMatchObject({
      sourceFlightId: '100180',
      direction: 'A',
      nature: 'international',
      origin: 'ZHQ',
      terminal: 'T2',
      stand: 'C38',
      baggageBelt: '3',
      aircraftTypeIcao: 'A359',
      seats: 283,
      pax: 224,
      status: 'arrived',
      codeshares: ['XD', 'XH'],
      actualBlockTime: '2026-10-14T00:18:00Z',
    });
    expect(xh960?.linkedFlightId).toBe(flights.find((f) => f.sourceFlightId === '100181')?.id);
  });

  it('reads multiple IATA delay codes and cancelled flights from the sample', () => {
    const { flights } = parseAodbCsv(SAMPLE_CSV, RECEIVED);
    expect(
      flights.some(
        (f) => f.delayCodes.length === 2 && f.delayCodes.includes('63') && f.delayCodes.includes('11'),
      ),
    ).toBe(true);
    expect(flights.filter((f) => f.status === 'cancelled')).toHaveLength(6);
  });

  it('round-trips the generated start-of-day snapshot, in CSV and JSON', () => {
    const fromCsv = parseAodbCsv(toAodbCsv(world.startOfDay), RECEIVED);
    const fromJson = parseAodbJson(toAodbJson(world.startOfDay), RECEIVED);
    expect(fromCsv.errors).toEqual([]);
    expect(fromJson.errors).toEqual([]);
    const strip = ({ source: _s, lastUpdate: _l, ...rest }: (typeof world.startOfDay)[number]) => rest;
    expect(fromCsv.flights.map(strip)).toEqual(world.startOfDay.map(strip));
    expect(fromJson.flights.map(strip)).toEqual(world.startOfDay.map(strip));
  });

  it('accepts any column order and ignores extra vendor columns', () => {
    const [header, ...rows] = SAMPLE_CSV.trim().split('\n');
    const cols = (header ?? '').split(',');
    const reordered = [
      [...cols].reverse().join(','),
      ...rows.map((r) => r.split(',').reverse().join(',')),
    ].join('\n');
    expect(parseAodbCsv(reordered, RECEIVED).flights).toHaveLength(320);
    const extra = [`${header},vendor_note`, ...rows.map((r) => `${r},x`)].join('\n');
    expect(parseAodbCsv(extra, RECEIVED).flights).toHaveLength(320);
  });

  it('rejects a snapshot that lacks required columns', () => {
    expect(() => parseAodbCsv('aodb_flight_id,direction\n1,A\n', RECEIVED)).toThrow(/missing columns/);
  });

  it('reports bad rows individually and loads the rest', () => {
    const lines = SAMPLE_CSV.trim().split('\n');
    lines.splice(2, 1, (lines[2] ?? '').replace(',A,', ',X,'));
    lines.splice(3, 1, (lines[3] ?? '').replace('2026-10-14T00:40:00Z', 'not-a-time'));
    const { flights, errors } = parseAodbCsv(lines.join('\n'), RECEIVED);
    expect(flights).toHaveLength(318);
    expect(errors.map((e) => e.row)).toEqual([2, 3]);
    expect(errors[0]?.reason).toMatch(/direction/);
  });
});

describe('AIDX adapter', () => {
  const opts = { homeAirport: 'MQI', receivedAt: RECEIVED };

  it('parses the challenge sample message (XH960 arrival, on block)', () => {
    const e = parseAidxMessage(SAMPLE_AIDX, opts);
    expect(e).toMatchObject({
      id: 'MQI-AODB-000184533',
      flightId: 'XH960-A-20261014',
      type: 'on_block',
      sequence: 184533,
      occurredAt: '2026-10-14T00:19:02Z',
      changes: {
        status: 'arrived',
        stand: 'C38',
        baggageBelt: '3',
        actualRunwayTime: '2026-10-14T00:10:00Z',
        actualBlockTime: '2026-10-14T00:18:00Z',
        pax: 224,
      },
    });
  });

  it('agrees with the sample AODB row for the same flight', () => {
    const e = parseAidxMessage(SAMPLE_AIDX, opts);
    const row = parseAodbCsv(SAMPLE_CSV, RECEIVED).flights.find((f) => f.id === e.flightId);
    expect(row).toMatchObject({
      stand: e.changes.stand,
      baggageBelt: e.changes.baggageBelt,
      actualBlockTime: e.changes.actualBlockTime,
      pax: e.changes.pax,
    });
  });

  it('round-trips every generated message: same flight, event type and changes', () => {
    const planned = new Map(world.day.events.map((e) => [`${e.flightId}|${e.at}|${e.type}`, e]));
    for (const m of world.aidx) {
      const e = parseAidxMessage(m.xml, opts);
      expect(e.flightId).toBe(m.flightId);
      expect(e.type).toBe(m.type);
      const source = planned.get(`${m.flightId}|${m.at}|${m.type}`);
      // Every change the generator made must come back (TSAT is A-CDM data that AIDX does not carry).
      const { tsat: _tsat, ...expected } = source?.changes ?? {};
      expect(e.changes).toMatchObject(expected);
    }
  });

  it('identifies a flight without a scheduled time through the resolver', () => {
    const xml = SAMPLE_AIDX.replace(
      /<OperationTime OperationQualifier="ONB" CodeContext="9750" TimeType="SCT">[^<]*<\/OperationTime>/,
      '',
    );
    expect(() => parseAidxMessage(xml, opts)).toThrow(/cannot identify/);
    expect(parseAidxMessage(xml, { ...opts, resolveFlightId: () => 'XH960-A-20261014' }).flightId).toBe(
      'XH960-A-20261014',
    );
  });

  it('rejects messages for other airports, unknown statuses and foreign roots', () => {
    expect(() => parseAidxMessage(SAMPLE_AIDX, { ...opts, homeAirport: 'ZZZ' })).toThrow(AidxError);
    expect(() =>
      parseAidxMessage(SAMPLE_AIDX.replace('<PublicStatus>ARR', '<PublicStatus>XYZ'), opts),
    ).toThrow(/PublicStatus/);
    expect(() => parseAidxMessage('<Other/>', opts)).toThrow(/root/);
  });
});

describe('ACRIS adapter', () => {
  it('parses every generated facility and queue measurement', () => {
    const facilities = acrisStaticEntities().map(parseFacility);
    expect(facilities.find((f) => f.id === 'T2-SEC-CP')).toMatchObject({
      type: 'CheckpointFacility',
      parentId: 'T2',
    });
    expect(facilities.find((f) => f.id === 'T2-D')).toMatchObject({
      type: 'ConcourseFacility',
      parentId: 'T2',
    });
    for (const m of world.queueMeasurements.slice(0, 200)) {
      expect(parseQueueMeasurement(acrisQueueMeasurement(m))).toEqual(m);
    }
  });

  it('accepts the keyValues representation as well as normalized', () => {
    const m = world.queueMeasurements[0];
    if (!m) throw new Error('no measurements');
    const normalized = acrisQueueMeasurement(m);
    const keyValues = Object.fromEntries(
      Object.entries(normalized).map(([k, v]) => [
        k,
        typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v,
      ]),
    );
    expect(parseQueueMeasurement(keyValues)).toEqual(m);
  });

  it('rejects entities of the wrong type or with invalid values', () => {
    const m = world.queueMeasurements[0];
    if (!m) throw new Error('no measurements');
    expect(() => parseQueueMeasurement({ ...acrisQueueMeasurement(m), type: 'PassengerQueue' })).toThrow(
      /QueueMeasurement/,
    );
    expect(() =>
      parseQueueMeasurement({ ...acrisQueueMeasurement(m), Occupancy: { type: 'Property', value: -5 } }),
    ).toThrow(/Occupancy/);
  });
});
