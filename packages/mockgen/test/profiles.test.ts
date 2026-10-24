import {
  CrowdProfileSchema,
  SEGMENT_DIMENSIONS,
  aircraftTypeByIcao,
  airlineByIata,
  destinationByIata,
  sumValues,
  toLocal,
} from '@arm/domain';
import { describe, expect, it } from 'vitest';

import { Rng } from '../src/prng.js';
import { flightProfile, purposeShares } from '../src/profiles.js';

const ctx = (dest: string, airline: string, aircraft: string, localIso: string, schoolHoliday = false) => {
  const destination = destinationByIata(dest);
  const al = airlineByIata(airline);
  const ac = aircraftTypeByIcao(aircraft);
  if (!destination || !al || !ac) throw new Error('bad fixture');
  return {
    destination,
    airline: al,
    aircraft: ac,
    local: toLocal(localIso, 0),
    schoolHoliday,
    festival: false,
    direction: 'D' as const,
    pax: 150,
  };
};

const average = (n: number, build: (rng: Rng) => number) => {
  let total = 0;
  for (let i = 0; i < n; i += 1) total += build(new Rng(`avg-${i}`));
  return total / n;
};

describe('crowd profile plausibility', () => {
  it('Monday 07:00 domestic flight skews to business travellers aged 25–44', () => {
    // 2026-10-19 is a Monday; Eastholm is a domestic business city.
    const c = ctx('EHQ', 'YA', 'A20N', '2026-10-19T07:00:00Z');
    const p = flightProfile(c, new Rng('monday'));
    expect(p.segments.tripPurpose.business).toBeGreaterThan(0.5);
    expect(p.segments.tripPurpose.business).toBeGreaterThan(p.segments.tripPurpose.holiday);
    const age25to44 = p.segments.ageBand.a25_34 + p.segments.ageBand.a35_44;
    expect(age25to44).toBeGreaterThan(0.5);
    expect(age25to44).toBeGreaterThan(p.segments.ageBand.u12 + p.segments.ageBand.a55p);
    expect(p.segments.partyType.solo).toBeGreaterThan(0.5);
  });

  it('Friday evening holiday route skews to families and couples', () => {
    // 2026-10-23 is a Friday; Goldsand is a domestic beach destination.
    const c = ctx('GSZ', 'XD', 'A20N', '2026-10-23T18:30:00Z');
    const p = flightProfile(c, new Rng('friday'));
    const familiesAndCouples = p.segments.partyType.family + p.segments.partyType.couple;
    expect(familiesAndCouples).toBeGreaterThan(0.65);
    expect(p.segments.partyType.family).toBeGreaterThan(p.segments.partyType.solo);
    expect(p.segments.tripPurpose.holiday).toBeGreaterThan(0.7);
    expect(p.segments.tripPurpose.business).toBeLessThan(0.08);
  });

  it('the same route is more business-heavy on a weekday morning than on a Friday evening', () => {
    const monday = purposeShares(ctx('ADN', 'XD', 'A20N', '2026-10-19T07:00:00Z'));
    const friday = purposeShares(ctx('ADN', 'XD', 'A20N', '2026-10-23T19:00:00Z'));
    expect(monday.business).toBeGreaterThan(friday.business * 2);
  });

  it('school holidays raise the family share', () => {
    const term = average(
      30,
      (rng) =>
        flightProfile(ctx('CBP', 'XD', 'A20N', '2026-10-14T11:00:00Z', false), rng).segments.partyType.family,
    );
    const holiday = average(
      30,
      (rng) =>
        flightProfile(ctx('CBP', 'XD', 'A20N', '2026-10-14T11:00:00Z', true), rng).segments.partyType.family,
    );
    expect(holiday).toBeGreaterThan(term * 1.15);
  });

  it('low-cost flights are all economy; long-haul full-service flights carry a business cabin', () => {
    const lcc = flightProfile(ctx('JFQ', 'XD', 'AT76', '2026-10-14T09:00:00Z'), new Rng('a'));
    const fsc = flightProfile(ctx('KST', 'ZO', 'A388', '2026-10-14T09:00:00Z'), new Rng('b'));
    expect(lcc.segments.cabin.economy).toBe(1);
    expect(fsc.segments.cabin.business).toBeGreaterThan(0.05);
  });

  it('international flights name the destination nationality and its language; domestic flights are mostly Meridian', () => {
    const intl = flightProfile(ctx('ZHQ', 'XH', 'A359', '2026-10-14T09:00:00Z'), new Rng('c'));
    expect(intl.topNationalities.map((n) => n.label)).toContain('Zarhani');
    expect(intl.topLanguages.map((l) => l.code)).toContain('ar');
    const dom = flightProfile(ctx('LMW', 'YN', 'B38M', '2026-10-14T09:00:00Z'), new Rng('d'));
    expect(dom.topNationalities[0]).toMatchObject({ label: 'Meridian' });
    expect(dom.topNationalities[0]?.share).toBeGreaterThan(0.85);
  });

  it('every dimension of a profile sums to 1 and the profile validates', () => {
    for (const [i, dest] of ['ADN', 'ZHQ', 'PVQ', 'LMW', 'SMG'].entries()) {
      const p = flightProfile(
        ctx(dest, dest === 'ZHQ' ? 'XH' : 'XD', dest === 'ZHQ' ? 'A359' : 'A21N', '2026-10-17T15:00:00Z'),
        new Rng(`sum-${i}`),
      );
      expect(CrowdProfileSchema.safeParse(p).success).toBe(true);
      for (const dim of Object.keys(SEGMENT_DIMENSIONS) as (keyof typeof SEGMENT_DIMENSIONS)[]) {
        const shares: Record<string, number> = p.segments[dim];
        expect(sumValues(shares)).toBeCloseTo(1, 2);
      }
    }
  });
});
