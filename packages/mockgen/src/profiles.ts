/**
 * Rules that give every flight a plausible crowd profile (the POC's stand-in for airline aggregated booking
 * mix and PNR statistics). All values are shares of the flight's passengers, never data about a person.
 *
 * Plausibility, by construction:
 * - Weekday early-morning domestic flights skew to business travellers aged 25–44.
 * - Friday-evening and weekend flights to holiday destinations skew to families and couples.
 * - School holidays raise families; long-haul full-service flights carry more premium cabins.
 */
import {
  type AircraftType,
  type Airline,
  type CrowdProfile,
  DESTINATIONS,
  type Destination,
  type DestinationCharacter,
  FULL_SERVICE_NARROWBODY_BUSINESS_SEATS,
  LANGUAGE_LABELS,
  type LocalParts,
  type SegmentValue,
  type TopShare,
  getOr,
  normaliseShares,
} from '@arm/domain';

import type { Rng } from './prng.js';

type Purpose = SegmentValue<'tripPurpose'>;
type Party = SegmentValue<'partyType'>;
type Age = SegmentValue<'ageBand'>;
type Shares<K extends string> = Record<K, number>;

const PURPOSE_BY_CHARACTER: ReadonlyMap<DestinationCharacter, Shares<Purpose>> = new Map([
  ['capital', { business: 0.45, holiday: 0.2, vfr: 0.25, student: 0.07, religious: 0.03 }],
  ['business_hub', { business: 0.5, holiday: 0.2, vfr: 0.2, student: 0.07, religious: 0.03 }],
  ['beach', { business: 0.07, holiday: 0.72, vfr: 0.15, student: 0.04, religious: 0.02 }],
  ['resort', { business: 0.05, holiday: 0.78, vfr: 0.12, student: 0.03, religious: 0.02 }],
  ['nature', { business: 0.08, holiday: 0.62, vfr: 0.22, student: 0.06, religious: 0.02 }],
  ['vfr', { business: 0.18, holiday: 0.2, vfr: 0.52, student: 0.07, religious: 0.03 }],
  ['university', { business: 0.15, holiday: 0.15, vfr: 0.3, student: 0.36, religious: 0.04 }],
  ['religious', { business: 0.08, holiday: 0.12, vfr: 0.3, student: 0.05, religious: 0.45 }],
]);

const PARTY_BY_PURPOSE: ReadonlyMap<Purpose, Shares<Party>> = new Map([
  ['business', { solo: 0.82, couple: 0.08, family: 0.02, group: 0.08 }],
  ['holiday', { solo: 0.14, couple: 0.36, family: 0.38, group: 0.12 }],
  ['vfr', { solo: 0.35, couple: 0.22, family: 0.35, group: 0.08 }],
  ['student', { solo: 0.7, couple: 0.1, family: 0.02, group: 0.18 }],
  ['religious', { solo: 0.15, couple: 0.25, family: 0.35, group: 0.25 }],
]);

const AGE_BY_PURPOSE: ReadonlyMap<Purpose, Shares<Age>> = new Map([
  ['business', { u12: 0, a12_17: 0, a18_24: 0.05, a25_34: 0.3, a35_44: 0.33, a45_54: 0.22, a55p: 0.1 }],
  ['holiday', { u12: 0.12, a12_17: 0.07, a18_24: 0.1, a25_34: 0.2, a35_44: 0.2, a45_54: 0.15, a55p: 0.16 }],
  ['vfr', { u12: 0.1, a12_17: 0.06, a18_24: 0.12, a25_34: 0.2, a35_44: 0.18, a45_54: 0.14, a55p: 0.2 }],
  ['student', { u12: 0, a12_17: 0.05, a18_24: 0.7, a25_34: 0.2, a35_44: 0.03, a45_54: 0.01, a55p: 0.01 }],
  [
    'religious',
    { u12: 0.08, a12_17: 0.05, a18_24: 0.08, a25_34: 0.15, a35_44: 0.2, a45_54: 0.2, a55p: 0.24 },
  ],
]);

const FEMALE_BY_PURPOSE: ReadonlyMap<Purpose, number> = new Map([
  ['business', 0.38],
  ['holiday', 0.53],
  ['vfr', 0.52],
  ['student', 0.5],
  ['religious', 0.48],
]);

/** Share of passengers on an international departure who are Meridian residents, by destination character. */
const HOME_SHARE_INTERNATIONAL: ReadonlyMap<DestinationCharacter, number> = new Map([
  ['capital', 0.5],
  ['business_hub', 0.45],
  ['beach', 0.66],
  ['resort', 0.7],
  ['nature', 0.6],
  ['vfr', 0.4],
  ['university', 0.5],
  ['religious', 0.42],
]);

export interface ProfileContext {
  /** The other end of the flight: destination for departures, origin for arrivals. */
  destination: Destination;
  direction: 'A' | 'D';
  airline: Airline;
  aircraft: AircraftType;
  pax: number;
  /** Local time of departure (or arrival). */
  local: LocalParts;
  schoolHoliday: boolean;
  festival: boolean;
}

const mix = <K extends string>(
  weights: Shares<Purpose>,
  table: ReadonlyMap<Purpose, Shares<K>>,
  keys: readonly K[],
): Shares<K> => {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Shares<K>;
  const acc = new Map<K, number>(keys.map((k) => [k, 0]));
  for (const [purpose, w] of Object.entries(weights) as [Purpose, number][]) {
    const row = table.get(purpose);
    if (!row) continue;
    for (const [k, v] of Object.entries(row) as [K, number][]) acc.set(k, (acc.get(k) ?? 0) + w * v);
  }
  return { ...out, ...Object.fromEntries(acc) } as Shares<K>;
};

const scale = <K extends string>(shares: Shares<K>, factors: Partial<Record<K, number>>): Shares<K> =>
  Object.fromEntries(
    (Object.entries(shares) as [K, number][]).map(([k, v]) => [
      k,
      v * getOr(factors as Record<string, number>, k, 1),
    ]),
  ) as Shares<K>;

const jitter = <K extends string>(shares: Shares<K>, rng: Rng, amount: number): Shares<K> =>
  normaliseShares(
    Object.fromEntries(
      (Object.entries(shares) as [K, number][]).map(([k, v]) => [k, v * rng.float(1 - amount, 1 + amount)]),
    ) as Shares<K>,
  );

const round3 = <K extends string>(shares: Shares<K>): Shares<K> =>
  Object.fromEntries(
    (Object.entries(shares) as [K, number][]).map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
  ) as Shares<K>;

/** Trip-purpose shares for a flight, before noise. Exposed for tests. */
export function purposeShares(
  ctx: Pick<ProfileContext, 'destination' | 'airline' | 'local' | 'schoolHoliday'>,
): Shares<Purpose> {
  const base = PURPOSE_BY_CHARACTER.get(ctx.destination.character) ?? PURPOSE_BY_CHARACTER.get('vfr');
  if (!base) throw new Error('missing purpose table');
  const { isoWeekday, hour } = ctx.local;
  const weekday = isoWeekday <= 5;
  const factors = new Map<Purpose, number>();
  const bump = (k: Purpose, f: number) => factors.set(k, (factors.get(k) ?? 1) * f);

  if (weekday && hour >= 6 && hour < 9) bump('business', 2.6);
  else if (weekday && hour >= 17 && hour < 20 && isoWeekday <= 4) bump('business', 1.5);
  if (isoWeekday === 5 && hour >= 15) {
    bump('holiday', 1.7);
    bump('business', 0.55);
  }
  if (isoWeekday >= 6) {
    bump('business', 0.45);
    bump('holiday', 1.35);
    bump('vfr', 1.2);
  }
  if (ctx.schoolHoliday) bump('holiday', 1.25);
  if (ctx.airline.model === 'low_cost') bump('business', 0.8);
  else bump('business', 1.15);

  return normaliseShares(scale(base, Object.fromEntries(factors) as Partial<Record<Purpose, number>>));
}

function partyShares(purpose: Shares<Purpose>, ctx: ProfileContext): Shares<Party> {
  let party = mix(purpose, PARTY_BY_PURPOSE, ['solo', 'couple', 'family', 'group']);
  const { isoWeekday, hour } = ctx.local;
  if (ctx.schoolHoliday) party = scale(party, { family: 1.45 });
  if (isoWeekday >= 6) party = scale(party, { family: 1.25, couple: 1.1 });
  if (isoWeekday === 5 && hour >= 15) party = scale(party, { family: 1.3, couple: 1.25, solo: 0.8 });
  if (ctx.local.isoWeekday <= 5 && hour >= 6 && hour < 9) party = scale(party, { solo: 1.2, family: 0.7 });
  return normaliseShares(party);
}

function ageShares(purpose: Shares<Purpose>, party: Shares<Party>, baseline: Shares<Party>): Shares<Age> {
  const ages = mix(purpose, AGE_BY_PURPOSE, [
    'u12',
    'a12_17',
    'a18_24',
    'a25_34',
    'a35_44',
    'a45_54',
    'a55p',
  ]);
  // Children travel with families: scale child bands by how far the family share moved from the
  // purpose-only baseline (school holidays, weekends).
  const familyLift = baseline.family > 0 ? party.family / baseline.family : 1;
  return normaliseShares(scale(ages, { u12: familyLift, a12_17: familyLift }));
}

function cabinShares(purpose: Shares<Purpose>, ctx: ProfileContext): Shares<SegmentValue<'cabin'>> {
  if (ctx.airline.model === 'low_cost') return { economy: 1, premium_economy: 0, business: 0 };
  const { cabins } = ctx.aircraft;
  const seats = cabins.business + cabins.premium_economy + cabins.economy;
  const businessSeats = cabins.business > 0 ? cabins.business : FULL_SERVICE_NARROWBODY_BUSINESS_SEATS;
  const businessFill = 0.55 + 0.9 * purpose.business;
  const premiumFill = 0.6 + 0.6 * purpose.business;
  const business = (businessSeats / seats) * businessFill;
  const premium = (cabins.premium_economy / seats) * premiumFill;
  return normaliseShares({
    economy: Math.max(0, 1 - business - premium),
    premium_economy: premium,
    business,
  });
}

function nationalityShares(
  ctx: ProfileContext,
  rng: Rng,
): { nationalities: TopShare[]; languages: TopShare[] } {
  const home: TopShare = { code: 'MER', label: 'Meridian', share: 0 };
  const dest = ctx.destination;
  if (dest.market === 'domestic') {
    const homeShare = rng.float(0.88, 0.95);
    const others = DESTINATIONS.filter((d) => d.market === 'international');
    const a = rng.pick(others);
    const b = rng.pick(others.filter((d) => d.nationality !== a.nationality));
    const rest = 1 - homeShare;
    const nationalities = [
      { ...home, share: homeShare },
      { code: a.iata, label: a.nationality, share: rest * 0.6 },
      { code: b.iata, label: b.nationality, share: rest * 0.4 },
    ];
    return { nationalities, languages: languagesFor(nationalities) };
  }
  let homeShare = HOME_SHARE_INTERNATIONAL.get(dest.character) ?? 0.5;
  if (ctx.direction === 'A') homeShare = 1 - homeShare;
  homeShare = Math.min(0.9, Math.max(0.1, homeShare * rng.float(0.9, 1.1)));
  const transit = rng.pick(DESTINATIONS.filter((d) => d.market === 'international' && d.iata !== dest.iata));
  const transitShare = rng.float(0.06, 0.14);
  const nationalities = [
    { ...home, share: homeShare },
    { code: dest.iata, label: dest.nationality, share: Math.max(0, 1 - homeShare - transitShare) },
    { code: transit.iata, label: transit.nationality, share: transitShare },
  ].sort((x, y) => y.share - x.share);
  return { nationalities, languages: languagesFor(nationalities) };
}

/** Languages follow nationalities (home: English); English is also the common second language. */
function languagesFor(nationalities: readonly TopShare[]): TopShare[] {
  const byLang = new Map<string, number>();
  for (const n of nationalities) {
    const lang = n.code === 'MER' ? 'en' : (DESTINATIONS.find((d) => d.iata === n.code)?.language ?? 'en');
    byLang.set(lang, (byLang.get(lang) ?? 0) + n.share);
  }
  return [...byLang.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, share]) => ({
      code,
      label: LANGUAGE_LABELS.get(code) ?? code,
      share: Math.round(share * 1000) / 1000,
    }));
}

/** Build a flight's crowd profile. */
export function flightProfile(ctx: ProfileContext, rng: Rng): CrowdProfile {
  const purpose = jitter(purposeShares(ctx), rng, 0.08);
  const baselineParty = normaliseShares(
    mix(purpose, PARTY_BY_PURPOSE, ['solo', 'couple', 'family', 'group']),
  );
  const party = jitter(partyShares(purpose, ctx), rng, 0.06);
  const ages = jitter(ageShares(purpose, party, baselineParty), rng, 0.05);
  const femaleBase = [...FEMALE_BY_PURPOSE].reduce((sum, [k, v]) => sum + v * getOr(purpose, k, 0), 0);
  const female = Math.min(0.7, Math.max(0.3, femaleBase + rng.float(-0.03, 0.03)));
  const cabin = cabinShares(purpose, ctx);
  const { nationalities, languages } = nationalityShares(ctx, rng);
  const frequentFlyer = Math.min(
    0.8,
    0.05 + 0.55 * purpose.business + (ctx.airline.model === 'full_service' ? 0.08 : 0) + cabin.business * 0.4,
  );

  return {
    pax: ctx.pax,
    segments: {
      tripPurpose: round3(purpose),
      partyType: round3(party),
      ageBand: round3(ages),
      gender: round3({ female, male: 1 - female }),
      cabin: round3(cabin),
      market:
        ctx.destination.market === 'international'
          ? { domestic: 0, international: 1 }
          : { domestic: 1, international: 0 },
    },
    frequentFlyerShare: Math.round(frequentFlyer * 1000) / 1000,
    topNationalities: nationalities.map((n) => ({ ...n, share: Math.round(n.share * 1000) / 1000 })),
    topLanguages: languages,
    topDestinations: [{ code: ctx.destination.iata, label: ctx.destination.city, share: 1 }],
  };
}
