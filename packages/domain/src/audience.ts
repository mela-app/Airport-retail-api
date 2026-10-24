/**
 * Audience vocabulary: the crowd attributes the platform estimates and campaigns target.
 *
 * Every value is an aggregated share of a crowd (for example "62% holiday travellers"), never data about a
 * person. A crowd profile is built per flight, then rolled up per screen and per 5-minute window.
 */
import { z } from 'zod';

import { getOr, getOwn } from './records.js';

/** Segment dimensions and their values. Shares within a dimension sum to 1. */
export const SEGMENT_DIMENSIONS = {
  tripPurpose: ['business', 'holiday', 'vfr', 'student', 'religious'],
  partyType: ['solo', 'couple', 'family', 'group'],
  ageBand: ['u12', 'a12_17', 'a18_24', 'a25_34', 'a35_44', 'a45_54', 'a55p'],
  gender: ['female', 'male'],
  cabin: ['economy', 'premium_economy', 'business'],
  market: ['domestic', 'international'],
} as const;

export type SegmentDimension = keyof typeof SEGMENT_DIMENSIONS;
export type SegmentValue<D extends SegmentDimension = SegmentDimension> =
  (typeof SEGMENT_DIMENSIONS)[D][number];

/** A segment key as used in targeting weights, e.g. `tripPurpose.holiday` or `partyType.family`. */
export type SegmentKey = {
  [D in SegmentDimension]: `${D}.${(typeof SEGMENT_DIMENSIONS)[D][number]}`;
}[SegmentDimension];

export const SEGMENT_KEYS: readonly SegmentKey[] = (
  Object.entries(SEGMENT_DIMENSIONS) as [SegmentDimension, readonly string[]][]
).flatMap(([dim, values]) => values.map((v) => `${dim}.${v}` as SegmentKey));

const SEGMENT_KEY_SET: ReadonlySet<string> = new Set(SEGMENT_KEYS);

export function isSegmentKey(value: string): value is SegmentKey {
  return SEGMENT_KEY_SET.has(value);
}

export function segmentDimension(key: SegmentKey): SegmentDimension {
  return key.slice(0, key.indexOf('.')) as SegmentDimension;
}

/** Human-readable labels (English). The web app translates these through i18n keys of the same name. */
export const SEGMENT_LABELS: Readonly<Record<SegmentKey, string>> = {
  'tripPurpose.business': 'Business',
  'tripPurpose.holiday': 'Holiday',
  'tripPurpose.vfr': 'Visiting friends & family',
  'tripPurpose.student': 'Student',
  'tripPurpose.religious': 'Religious travel',
  'partyType.solo': 'Solo',
  'partyType.couple': 'Couple',
  'partyType.family': 'Family with children',
  'partyType.group': 'Group',
  'ageBand.u12': 'Under 12',
  'ageBand.a12_17': '12–17',
  'ageBand.a18_24': '18–24',
  'ageBand.a25_34': '25–34',
  'ageBand.a35_44': '35–44',
  'ageBand.a45_54': '45–54',
  'ageBand.a55p': '55+',
  'gender.female': 'Female',
  'gender.male': 'Male',
  'cabin.economy': 'Economy',
  'cabin.premium_economy': 'Premium economy',
  'cabin.business': 'Business cabin',
  'market.domestic': 'Domestic',
  'market.international': 'International',
};

/** Shares of one dimension: value → share in [0, 1]. */
export type DimensionShares<D extends SegmentDimension> = Record<SegmentValue<D>, number>;

const share = z.number().min(0).max(1);

function dimensionSchema<D extends SegmentDimension>(dim: D) {
  const values: readonly string[] = getOwn(SEGMENT_DIMENSIONS, dim) ?? [];
  const shape = Object.fromEntries(values.map((v) => [v, share])) as Record<SegmentValue<D>, typeof share>;
  return z.object(shape).strict();
}

export const TopShareSchema = z.object({ code: z.string().min(1), label: z.string().min(1), share });
export type TopShare = z.infer<typeof TopShareSchema>;

/**
 * The crowd profile of one flight's passengers, or of a screen catchment for one window.
 * `segments` holds the share of every segment value; the other fields describe size and time context.
 */
export const CrowdProfileSchema = z.object({
  /** Passengers the profile describes (weighted, so it can be fractional after a roll-up). */
  pax: z.number().min(0),
  segments: z.object({
    tripPurpose: dimensionSchema('tripPurpose'),
    partyType: dimensionSchema('partyType'),
    ageBand: dimensionSchema('ageBand'),
    gender: dimensionSchema('gender'),
    cabin: dimensionSchema('cabin'),
    market: dimensionSchema('market'),
  }),
  frequentFlyerShare: share,
  topNationalities: z.array(TopShareSchema).max(3),
  topLanguages: z.array(TopShareSchema).max(3),
  topDestinations: z.array(TopShareSchema).max(3),
});
export type CrowdProfile = z.infer<typeof CrowdProfileSchema>;

/** Read one segment share from a profile, e.g. `segmentShare(p, 'tripPurpose.holiday')`. */
export function segmentShare(profile: Pick<CrowdProfile, 'segments'>, key: SegmentKey): number {
  const dim = segmentDimension(key);
  const shares: Readonly<Record<string, number>> = getOwn(profile.segments, dim) ?? {};
  return getOr(shares, key.slice(dim.length + 1), 0);
}

/** Normalise raw non-negative weights of one dimension so they sum to 1 (uniform if all are zero). */
export function normaliseShares<T extends string>(raw: Readonly<Record<T, number>>): Record<T, number> {
  const entries = Object.entries(raw) as [T, number][];
  const total = entries.reduce((sum, [, v]) => sum + Math.max(0, v), 0);
  return Object.fromEntries(
    entries.map(([k, v]) => [k, total > 0 ? Math.max(0, v) / total : 1 / entries.length]),
  ) as Record<T, number>;
}
