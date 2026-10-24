/**
 * Rolling flight profiles up into a crowd profile. Every attribute is a share, so the crowd's share of a
 * segment is the passenger-weighted average of the flights' shares.
 */
import {
  type CrowdProfile,
  SEGMENT_DIMENSIONS,
  type SegmentDimension,
  type TopShare,
  getOr,
  getOwn,
} from '@arm/domain';

export interface WeightedProfile {
  profile: CrowdProfile;
  /** Passengers of this profile that are present (pax × presence weight). */
  pax: number;
}

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

function mergeTop(parts: readonly { tops: readonly TopShare[]; pax: number }[], total: number): TopShare[] {
  const sums = new Map<string, { label: string; value: number }>();
  for (const { tops, pax } of parts) {
    for (const t of tops) {
      const entry = sums.get(t.code) ?? { label: t.label, value: 0 };
      entry.value += t.share * pax;
      sums.set(t.code, entry);
    }
  }
  return [...sums.entries()]
    .map(([code, { label, value }]) => ({ code, label, share: total > 0 ? round(value / total) : 0 }))
    .sort((a, b) => b.share - a.share || a.code.localeCompare(b.code))
    .slice(0, 3);
}

/** An empty crowd (no passengers). */
export function emptyProfile(): CrowdProfile {
  const zeros = <D extends SegmentDimension>(dim: D) =>
    Object.fromEntries(
      (getOwn(SEGMENT_DIMENSIONS, dim) ?? []).map((v) => [v, 0]),
    ) as CrowdProfile['segments'][D];
  return {
    pax: 0,
    segments: {
      tripPurpose: zeros('tripPurpose'),
      partyType: zeros('partyType'),
      ageBand: zeros('ageBand'),
      gender: zeros('gender'),
      cabin: zeros('cabin'),
      market: zeros('market'),
    },
    frequentFlyerShare: 0,
    topNationalities: [],
    topLanguages: [],
    topDestinations: [],
  };
}

/** Passenger-weighted blend of profiles. `pax` of the result is the total present passengers. */
export function blendProfiles(parts: readonly WeightedProfile[]): CrowdProfile {
  const live = parts.filter((p) => p.pax > 0);
  const total = live.reduce((sum, p) => sum + p.pax, 0);
  if (total <= 0) return emptyProfile();
  const out = emptyProfile();
  const dims = Object.keys(SEGMENT_DIMENSIONS) as SegmentDimension[];
  const segments = Object.fromEntries(
    dims.map((dim) => {
      const values: readonly string[] = getOwn(SEGMENT_DIMENSIONS, dim) ?? [];
      const shares = Object.fromEntries(
        values.map((v) => [
          v,
          round(
            live.reduce(
              (sum, p) =>
                sum + getOr((getOwn(p.profile.segments, dim) ?? {}) as Record<string, number>, v, 0) * p.pax,
              0,
            ) / total,
          ),
        ]),
      );
      return [dim, shares];
    }),
  ) as CrowdProfile['segments'];
  return {
    ...out,
    pax: round(total, 2),
    segments,
    frequentFlyerShare: round(live.reduce((s, p) => s + p.profile.frequentFlyerShare * p.pax, 0) / total),
    topNationalities: mergeTop(
      live.map((p) => ({ tops: p.profile.topNationalities, pax: p.pax })),
      total,
    ),
    topLanguages: mergeTop(
      live.map((p) => ({ tops: p.profile.topLanguages, pax: p.pax })),
      total,
    ),
    topDestinations: mergeTop(
      live.map((p) => ({ tops: p.profile.topDestinations, pax: p.pax })),
      total,
    ),
  };
}

/** Weighted median of `value` (weights are passenger counts). */
export function weightedMedian(items: readonly { value: number; weight: number }[]): number | null {
  const sorted = items.filter((i) => i.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (const item of sorted) {
    acc += item.weight;
    if (acc >= total / 2) return item.value;
  }
  return sorted.at(-1)?.value ?? null;
}
