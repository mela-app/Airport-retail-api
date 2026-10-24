import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CHECKPOINTS,
  GATES,
  SEGMENT_KEYS,
  ZONES,
  checkFreshness,
  delayMinutes,
  flightId,
  getOwn,
  isSegmentKey,
  localToUtc,
  normaliseShares,
  rectContains,
  resolveGate,
  segmentShare,
  toLocal,
  zoneById,
} from '../src/index.js';

const SAMPLE_CSV = fileURLToPath(
  new URL('../../../samples/aodb-samples/MQI_aodb_flights_2026-10-14_SYNTHETIC.csv', import.meta.url),
);

describe('airport layout', () => {
  it('resolves every (terminal, gate) pair used in the challenge sample AODB file', () => {
    const [header, ...rows] = readFileSync(SAMPLE_CSV, 'utf8').trim().split('\n');
    const cols = header?.split(',') ?? [];
    const terminalIdx = cols.indexOf('terminal');
    const gateIdx = cols.indexOf('gate');
    const missing = rows
      .map((r) => r.split(','))
      .filter((r) => (r.at(gateIdx) ?? '') !== '')
      .filter((r) => !resolveGate(r.at(terminalIdx) ?? '', r.at(gateIdx) ?? null));
    expect(missing).toEqual([]);
  });

  it('gate ids are unique and every gate sits inside its zone', () => {
    expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length);
    for (const g of GATES) {
      const zone = zoneById(g.zoneId);
      expect(zone).toBeDefined();
      if (zone) expect(rectContains(zone.area, g.position)).toBe(true);
    }
  });

  it('remote bus gates exist in both terminals with the same codes, kept apart by terminal', () => {
    expect(resolveGate('T1', 'BUS3')?.id).toBe('T1-BUS3');
    expect(resolveGate('T2', 'BUS3')?.id).toBe('T2-BUS3');
  });

  it('checkpoints sit in security or passport-control zones', () => {
    for (const cp of CHECKPOINTS)
      expect(['security', 'passport_control']).toContain(zoneById(cp.zoneId)?.kind);
    expect(ZONES.filter((z) => z.kind === 'airside_plaza')).toHaveLength(2);
  });
});

describe('time', () => {
  it('converts between UTC and airport local time (+04:00)', () => {
    const utc = localToUtc('2026-10-16', 14, 10, 240);
    expect(utc.toISOString()).toBe('2026-10-16T10:10:00.000Z');
    expect(toLocal(utc, 240)).toEqual({ isoWeekday: 5, hour: 14, minute: 10, date: '2026-10-16' });
  });

  it('computes delay from the latest estimate or block time', () => {
    expect(
      delayMinutes({
        scheduledTime: '2026-10-16T10:57:00Z',
        estimatedTime: '2026-10-16T11:42:00Z',
        actualBlockTime: null,
      }),
    ).toBe(45);
    expect(
      delayMinutes({ scheduledTime: '2026-10-16T10:57:00Z', estimatedTime: null, actualBlockTime: null }),
    ).toBe(0);
  });

  it('builds canonical flight ids from the UTC scheduled date', () => {
    expect(flightId('XH', '960', 'A', '2026-10-14T00:15:00Z')).toBe('XH960-A-20261014');
  });
});

describe('audience helpers', () => {
  it('knows every segment key and rejects unknown ones', () => {
    expect(SEGMENT_KEYS).toContain('partyType.family');
    expect(isSegmentKey('tripPurpose.holiday')).toBe(true);
    expect(isSegmentKey('tripPurpose.__proto__')).toBe(false);
  });

  it('reads shares safely, including hostile keys', () => {
    const profile = {
      segments: { tripPurpose: { business: 0.2, holiday: 0.5, vfr: 0.2, student: 0.05, religious: 0.05 } },
    };
    expect(segmentShare(profile as never, 'tripPurpose.holiday')).toBe(0.5);
    expect(getOwn({ a: 1 }, '__proto__')).toBeUndefined();
    expect(getOwn({ a: 1 }, 'constructor')).toBeUndefined();
  });

  it('normalises shares, falling back to uniform when all are zero', () => {
    expect(normaliseShares({ a: 1, b: 3 })).toEqual({ a: 0.25, b: 0.75 });
    expect(normaliseShares({ a: 0, b: 0 })).toEqual({ a: 0.5, b: 0.5 });
  });
});

describe('evidence freshness', () => {
  const now = new Date('2026-10-16T10:10:00Z');
  it('accepts recent data and rejects stale or future-dated data', () => {
    expect(checkFreshness({ source: 'acris', observedAt: '2026-10-16T10:05:00Z' }, now).fresh).toBe(true);
    expect(checkFreshness({ source: 'acris', observedAt: '2026-10-16T09:40:00Z' }, now).fresh).toBe(false);
    expect(checkFreshness({ source: 'aidx', observedAt: '2026-10-16T10:20:00Z' }, now).fresh).toBe(false);
  });
});
