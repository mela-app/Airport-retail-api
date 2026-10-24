/**
 * Learning: scans and redemptions per audience segment update each campaign's conversion estimate.
 *
 * - Every play adds its estimated viewers to the campaign's counters, split by the crowd's segment shares.
 * - Every scan and redemption is attributed to a segment (aggregated: the segment of the crowd, never a
 *   person) and counted.
 * - Every simulated hour (at :30) the model retrains: a campaign with enough data moves its performance index
 *   20% towards its observed conversion (redemptions per 1,000 viewers, mapped to 0–1). Each retrain is a new
 *   model version, stored with its counters, so the decision log can name the version in use and a jump back
 *   in time can restore the model of that time.
 */
import { type CrowdProfile, segmentShare } from '@arm/domain';

export const LEARNED_SEGMENTS = [
  'tripPurpose.business',
  'tripPurpose.holiday',
  'tripPurpose.vfr',
  'partyType.solo',
  'partyType.couple',
  'partyType.family',
  'partyType.group',
  'market.domestic',
  'market.international',
] as const;
export type LearnedSegment = (typeof LEARNED_SEGMENTS)[number];

export interface SegmentCounter {
  viewers: number;
  scans: number;
  redemptions: number;
  revenue: number;
}

export interface ModelSnapshot {
  version: string;
  trainedAt: string;
  performance: Record<string, number>;
  counters: Record<string, Record<string, SegmentCounter>>;
  notes: string;
}

/** Minimum viewers before a campaign's estimate moves. */
export const MIN_VIEWERS_TO_LEARN = 2000;
export const LEARNING_RATE = 0.2;
/** Redemptions per 1,000 viewers at which observed performance is 0.5. */
export const HALF_PERFORMANCE_RATE = 2;

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const empty = (): SegmentCounter => ({ viewers: 0, scans: 0, redemptions: 0, revenue: 0 });

export class LearningModel {
  private versionName: string;
  private trained: string;
  private revision = 0;
  private performance = new Map<string, number>();
  private counters = new Map<string, Map<string, SegmentCounter>>();

  constructor(private readonly baseVersion: string) {
    this.versionName = `${baseVersion} r0`;
    this.trained = new Date(0).toISOString();
  }

  /** Start from the campaigns' seeded performance (model r0). */
  reset(seed: ReadonlyMap<string, number>, at: Date): void {
    this.revision = 0;
    this.versionName = `${this.baseVersion} r0`;
    this.trained = at.toISOString();
    this.performance = new Map(seed);
    this.counters = new Map();
  }

  get version(): string {
    return this.versionName;
  }

  get trainedAt(): string {
    return this.trained;
  }

  performanceMap(): ReadonlyMap<string, number> {
    return this.performance;
  }

  private counter(campaignId: string, segment: string): SegmentCounter {
    let bySegment = this.counters.get(campaignId);
    if (!bySegment) {
      bySegment = new Map();
      this.counters.set(campaignId, bySegment);
    }
    let c = bySegment.get(segment);
    if (!c) {
      c = empty();
      bySegment.set(segment, c);
    }
    return c;
  }

  recordPlay(campaignId: string, viewers: number, profile: Pick<CrowdProfile, 'segments'>): void {
    for (const segment of LEARNED_SEGMENTS)
      this.counter(campaignId, segment).viewers += viewers * segmentShare(profile, segment);
  }

  recordScan(campaignId: string, segment: string): void {
    this.counter(campaignId, segment).scans += 1;
  }

  recordRedemption(campaignId: string, segment: string, revenue: number): void {
    const c = this.counter(campaignId, segment);
    c.redemptions += 1;
    c.revenue += revenue;
  }

  /** Totals per campaign over all segments of one dimension (avoids double counting across dimensions). */
  totals(campaignId: string): SegmentCounter {
    const out = empty();
    for (const segment of LEARNED_SEGMENTS.filter((s) => s.startsWith('partyType.'))) {
      const c = this.counters.get(campaignId)?.get(segment);
      if (!c) continue;
      out.viewers += c.viewers;
      out.scans += c.scans;
      out.redemptions += c.redemptions;
      out.revenue += c.revenue;
    }
    return out;
  }

  /** Per-segment conversion and lift against the campaign average (for "families redeemed 3x more"). */
  segmentRates(campaignId: string): {
    segment: string;
    viewers: number;
    scans: number;
    redemptions: number;
    perThousand: number;
    lift: number;
  }[] {
    const total = this.totals(campaignId);
    const avg = total.viewers > 0 ? (total.redemptions / total.viewers) * 1000 : 0;
    return LEARNED_SEGMENTS.map((segment) => {
      const c = this.counters.get(campaignId)?.get(segment) ?? empty();
      const perThousand = c.viewers > 0 ? (c.redemptions / c.viewers) * 1000 : 0;
      return {
        segment,
        viewers: Math.round(c.viewers),
        scans: c.scans,
        redemptions: c.redemptions,
        perThousand: r4(perThousand),
        lift: avg > 0 ? r4(perThousand / avg) : 0,
      };
    });
  }

  /** Retrain from the counters. Returns the campaigns whose estimate changed. */
  retrain(at: Date): { campaignId: string; before: number; after: number }[] {
    const changes: { campaignId: string; before: number; after: number }[] = [];
    for (const campaignId of this.counters.keys()) {
      const total = this.totals(campaignId);
      if (total.viewers < MIN_VIEWERS_TO_LEARN) continue;
      const rate = (total.redemptions / total.viewers) * 1000;
      const observed = rate / (rate + HALF_PERFORMANCE_RATE);
      const before = this.performance.get(campaignId) ?? 0.3;
      const after = r4((1 - LEARNING_RATE) * before + LEARNING_RATE * observed);
      if (after !== before) changes.push({ campaignId, before, after });
      this.performance.set(campaignId, after);
    }
    this.revision += 1;
    this.versionName = `${this.baseVersion} r${this.revision}`;
    this.trained = at.toISOString();
    return changes;
  }

  snapshot(notes: string): ModelSnapshot {
    const counters: Record<string, Record<string, SegmentCounter>> = {};
    for (const [campaignId, bySegment] of this.counters) {
      Object.assign(counters, {
        [campaignId]: Object.fromEntries([...bySegment].map(([s, c]) => [s, { ...c }])),
      });
    }
    return {
      version: this.versionName,
      trainedAt: this.trained,
      performance: Object.fromEntries(this.performance),
      counters,
      notes,
    };
  }

  restore(s: ModelSnapshot): void {
    this.versionName = s.version;
    this.trained = s.trainedAt;
    this.revision = Number(/ r(\d+)$/.exec(s.version)?.at(1) ?? '0');
    this.performance = new Map(Object.entries(s.performance));
    this.counters = new Map(
      Object.entries(s.counters).map(([campaignId, bySegment]) => [
        campaignId,
        new Map(Object.entries(bySegment).map(([seg, c]) => [seg, { ...c }])),
      ]),
    );
  }
}
