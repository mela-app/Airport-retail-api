/**
 * Campaign eligibility and scoring against a crowd estimate.
 *
 * Filter (hard rules, all must pass) → score:
 *
 *   audience match  = mean over the dimensions a campaign targets of Σ (crowd share × segment weight)
 *                     i.e. how much the campaign wants the average passenger in front of the screen
 *   boost           = the largest boost among the campaign's active triggers (1 when none)
 *   final score     = audienceWeight × min(1, match × boost) + performanceWeight × performance index
 *
 * Every number is reproducible from the logged inputs (crowd shares, weights, triggers, performance index).
 */
import {
  type Advertiser,
  type Campaign,
  type Creative,
  type CrowdProfile,
  SEGMENT_DIMENSIONS,
  type SegmentDimension,
  type Screen,
  type Trigger,
  getOr,
  isSegmentKey,
  segmentDimension,
  segmentShare,
  toLocal,
} from '@arm/domain';

import type { CrowdContributor, CrowdEstimate } from './presence.js';

export interface RuleEngineSettings {
  audienceWeight: number;
  performanceWeight: number;
  explorationPct: number;
  defaultFrequencyCap: number;
  maxConsecutivePlays: number;
  /** Candidates scoring below this do not play on the screen (held for screens where they fit better). */
  minScoreToPlay: number;
  competitorSeparation: boolean;
  airlinePriorityInBoardingWindow: boolean;
  airlinePriorityWindowMin: number;
  segmentModelVersion: string;
}

/** Share of the crowd that must meet a market / region / destination filter. */
export const FILTER_SHARE = 0.5;
/** A gate change counts as a trigger for this long. */
export const GATE_CHANGE_TRIGGER_MIN = 30;

export interface FilterResult {
  rule:
    | 'status'
    | 'creative'
    | 'brand_safety'
    | 'schedule'
    | 'placement'
    | 'stock'
    | 'budget'
    | 'market'
    | 'region'
    | 'destination'
    | 'dwell'
    | 'crowd_size'
    | 'airline_window'
    | 'trigger_required';
  passed: boolean;
  detail: string;
}

export interface DimensionMatch {
  dimension: SegmentDimension;
  /** Σ share × weight for the dimension. */
  value: number;
  terms: { segment: string; share: number; weight: number }[];
}

export interface ActiveTrigger {
  type: Trigger['type'];
  boost: number;
  detail: string;
  /** Flights that activated it. */
  flightIds: string[];
}

export interface ScoreBreakdown {
  match: number;
  dimensions: DimensionMatch[];
  boost: number;
  triggers: ActiveTrigger[];
  performance: number;
  audienceWeight: number;
  performanceWeight: number;
  final: number;
}

export interface CandidateEvaluation {
  campaignId: string;
  campaignName: string;
  advertiserId: string;
  advertiserName: string;
  competitorGroup: string | null;
  airlinePriority: boolean;
  creativeId: string | null;
  eligible: boolean;
  filters: FilterResult[];
  score: ScoreBreakdown | null;
}

export interface SpendState {
  today: number;
  total: number;
}

export interface ScoringContext {
  now: Date;
  utcOffsetMinutes: number;
  screen: Screen;
  crowd: CrowdEstimate;
  settings: RuleEngineSettings;
  /** Learned performance index per campaign (model in use). */
  performance: ReadonlyMap<string, number>;
  spend: ReadonlyMap<string, SpendState>;
  /** Flights whose gate changed recently (flight id → change time). */
  gateChanges: ReadonlyMap<string, string>;
  festival: string | null;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Audience match of a campaign's segment weights against a crowd profile. */
export function audienceMatch(
  weights: Readonly<Record<string, number>>,
  profile: Pick<CrowdProfile, 'segments'>,
): {
  match: number;
  dimensions: DimensionMatch[];
} {
  const byDim = new Map<SegmentDimension, DimensionMatch>();
  for (const [segment, weight] of Object.entries(weights)) {
    if (!isSegmentKey(segment)) continue;
    const dimension = segmentDimension(segment);
    const entry = byDim.get(dimension) ?? { dimension, value: 0, terms: [] };
    const share = segmentShare(profile, segment);
    entry.value += share * weight;
    entry.terms.push({ segment, share: round(share), weight });
    byDim.set(dimension, entry);
  }
  const dimensions = [...byDim.values()]
    .map((d) => ({ ...d, value: round(d.value) }))
    .sort(
      (a, b) =>
        Object.keys(SEGMENT_DIMENSIONS).indexOf(a.dimension) -
        Object.keys(SEGMENT_DIMENSIONS).indexOf(b.dimension),
    );
  const match = dimensions.length > 0 ? dimensions.reduce((s, d) => s + d.value, 0) / dimensions.length : 0;
  return { match: round(match), dimensions };
}

function inBoarding(c: CrowdContributor, now: Date): boolean {
  if (!c.boardingAt || !c.gateCloseAt) return false;
  const t = now.getTime();
  return t >= Date.parse(c.boardingAt) && t < Date.parse(c.gateCloseAt);
}

export function activeTriggers(campaign: Campaign, ctx: ScoringContext): ActiveTrigger[] {
  const out: ActiveTrigger[] = [];
  const departures = ctx.crowd.contributors.filter((c) => c.direction === 'D');
  for (const trigger of campaign.triggers) {
    switch (trigger.type) {
      case 'delay_over': {
        const flights = departures.filter(
          (c) =>
            c.delayMin > trigger.minutes &&
            (trigger.airlineIata === null || c.airlineIata === trigger.airlineIata) &&
            (trigger.destinations.length === 0 || trigger.destinations.includes(c.destination)),
        );
        if (flights.length > 0)
          out.push({
            type: trigger.type,
            boost: trigger.boost,
            detail: `${flights.map((f) => `${f.airlineIata}${f.flightNumber} delayed ${f.delayMin} min`).join(', ')} (> ${trigger.minutes} min)`,
            flightIds: flights.map((f) => f.flightId),
          });
        break;
      }
      case 'gate_change': {
        const flights = departures.filter((c) => {
          const changed = ctx.gateChanges.get(c.flightId);
          return (
            changed !== undefined &&
            ctx.now.getTime() - Date.parse(changed) <= GATE_CHANGE_TRIGGER_MIN * 60_000
          );
        });
        if (flights.length > 0)
          out.push({
            type: trigger.type,
            boost: trigger.boost,
            detail: `gate change: ${flights.map((f) => `${f.airlineIata}${f.flightNumber}`).join(', ')}`,
            flightIds: flights.map((f) => f.flightId),
          });
        break;
      }
      case 'boarding_starts': {
        const flights = departures.filter((c) => inBoarding(c, ctx.now));
        if (flights.length > 0)
          out.push({
            type: trigger.type,
            boost: trigger.boost,
            detail: `boarding: ${flights.map((f) => `${f.airlineIata}${f.flightNumber}`).join(', ')}`,
            flightIds: flights.map((f) => f.flightId),
          });
        break;
      }
      case 'festival_day':
        if (ctx.festival)
          out.push({ type: trigger.type, boost: trigger.boost, detail: ctx.festival, flightIds: [] });
        break;
    }
  }
  return out;
}

export function scheduleFilter(
  campaign: Campaign,
  ctx: Pick<ScoringContext, 'now' | 'utcOffsetMinutes'>,
): FilterResult {
  const { schedule } = campaign.placement;
  const t = ctx.now.getTime();
  if (t < Date.parse(schedule.start) || t > Date.parse(schedule.end))
    return { rule: 'schedule', passed: false, detail: 'outside the campaign dates' };
  const local = toLocal(ctx.now, ctx.utcOffsetMinutes);
  if (schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(local.isoWeekday))
    return { rule: 'schedule', passed: false, detail: 'not scheduled on this weekday' };
  if (schedule.hours && (local.hour < schedule.hours.from || local.hour >= schedule.hours.to))
    return {
      rule: 'schedule',
      passed: false,
      detail: `runs ${schedule.hours.from}:00–${schedule.hours.to}:00 only`,
    };
  return { rule: 'schedule', passed: true, detail: 'within schedule' };
}

export function placementFilter(campaign: Campaign, screen: Screen): FilterResult {
  const { zoneIds, screenIds, gateIds } = campaign.placement;
  const ok =
    zoneIds.includes(screen.zoneId) ||
    screenIds.includes(screen.id) ||
    gateIds.some((g) => screen.nearestGateIds.includes(g));
  return {
    rule: 'placement',
    passed: ok,
    detail: ok ? `placed in ${screen.zoneId}` : `not booked on ${screen.zoneId}`,
  };
}

/** Run the hard filters; all results are returned (for the decision log), in evaluation order. */
export function hardFilters(
  campaign: Campaign,
  advertiser: Advertiser | undefined,
  creative: Creative | undefined,
  ctx: ScoringContext,
  triggers: readonly ActiveTrigger[],
): FilterResult[] {
  const out: FilterResult[] = [];
  const crowd = ctx.crowd;
  const hf = campaign.hardFilters;
  out.push({ rule: 'status', passed: campaign.status === 'active', detail: `campaign ${campaign.status}` });
  out.push({
    rule: 'creative',
    passed: creative !== undefined && creative.status === 'approved',
    detail: creative ? `creative ${creative.status}` : 'no creative',
  });
  const safety = creative ? Object.values(creative.brandSafety).every(Boolean) : false;
  out.push({
    rule: 'brand_safety',
    passed: safety,
    detail: safety ? 'brand-safety checklist passed' : 'brand-safety checklist incomplete',
  });
  out.push(scheduleFilter(campaign, ctx));
  out.push(placementFilter(campaign, ctx.screen));
  if (campaign.promo)
    out.push({
      rule: 'stock',
      passed: campaign.promo.inStock,
      detail: campaign.promo.inStock ? 'in stock' : 'promoted item out of stock',
    });
  const spend = ctx.spend.get(campaign.id) ?? { today: 0, total: 0 };
  const budgetLeft = spend.total < campaign.budget.total && spend.today < campaign.budget.dailyCap;
  out.push({
    rule: 'budget',
    passed: budgetLeft,
    detail: budgetLeft
      ? 'budget available'
      : spend.total >= campaign.budget.total
        ? 'total budget spent'
        : 'daily cap reached',
  });
  if (hf.market) {
    const share = getOr(crowd.profile.segments.market as Record<string, number>, hf.market, 0);
    out.push({
      rule: 'market',
      passed: share >= FILTER_SHARE,
      detail: `${pct(share)} ${hf.market} (needs ${pct(FILTER_SHARE)})`,
    });
  }
  if (hf.destinationRegions.length > 0) {
    const share = hf.destinationRegions.reduce((s, r) => s + getOr(crowd.regionShares, r, 0), 0);
    out.push({
      rule: 'region',
      passed: share >= FILTER_SHARE,
      detail: `${pct(share)} to ${hf.destinationRegions.join(', ')}`,
    });
  }
  if (hf.destinations.length > 0) {
    const share = hf.destinations.reduce((s, d) => s + getOr(crowd.destinationShares, d, 0), 0);
    out.push({
      rule: 'destination',
      passed: share >= FILTER_SHARE,
      detail: `${pct(share)} to ${hf.destinations.join(', ')}`,
    });
  }
  if (hf.minDwellMinutes !== null) {
    const dwell = crowd.medianDwellMin ?? 0;
    out.push({
      rule: 'dwell',
      passed: dwell >= hf.minDwellMinutes,
      detail: `median dwell ${dwell} min (needs ${hf.minDwellMinutes})`,
    });
  }
  if (hf.minCrowd !== null)
    out.push({
      rule: 'crowd_size',
      passed: crowd.pax >= hf.minCrowd,
      detail: `${Math.round(crowd.pax)} pax (needs ${hf.minCrowd})`,
    });
  if (advertiser?.kind === 'airline' && advertiser.airlineIata && campaign.objective !== 'goodwill') {
    // Airline gate messaging plays in the airline's own boarding window: one of its departures at these gates
    // boards within the window (and has not closed). Delay goodwill is exempt: it is pushed as soon as its
    // delay trigger fires on the airline's flight here (the trigger filters by airline).
    const own = crowd.contributors.filter(
      (c) =>
        c.direction === 'D' &&
        c.airlineIata === advertiser.airlineIata &&
        c.dwellMin <= ctx.settings.airlinePriorityWindowMin &&
        (c.gateCloseAt === null || ctx.now.getTime() < Date.parse(c.gateCloseAt)),
    );
    out.push({
      rule: 'airline_window',
      passed: own.length > 0,
      detail:
        own.length > 0
          ? `${own.map((c) => `${c.airlineIata}${c.flightNumber}`).join(', ')} in boarding window`
          : `no ${advertiser.airlineIata} flight within ${ctx.settings.airlinePriorityWindowMin} min of boarding here`,
    });
  }
  if (campaign.objective === 'goodwill')
    out.push({
      rule: 'trigger_required',
      passed: triggers.length > 0,
      detail:
        triggers.length > 0 ? 'trigger active' : 'goodwill offers play only while their trigger is active',
    });
  return out;
}

export function scoreCampaign(
  campaign: Campaign,
  ctx: ScoringContext,
  triggers: readonly ActiveTrigger[],
): ScoreBreakdown {
  const { match, dimensions } = audienceMatch(campaign.segmentWeights, ctx.crowd.profile);
  const boost = triggers.reduce((m, t) => Math.max(m, t.boost), 1);
  const performance = ctx.performance.get(campaign.id) ?? campaign.performanceIndex;
  const { audienceWeight, performanceWeight } = ctx.settings;
  const final = audienceWeight * Math.min(1, match * boost) + performanceWeight * performance;
  return {
    match,
    dimensions,
    boost,
    triggers: [...triggers],
    performance: round(performance),
    audienceWeight,
    performanceWeight,
    final: round(final),
  };
}

/** Recompute a final score from its logged inputs (used by the verifier). */
export function recomputeFinal(
  s: Pick<ScoreBreakdown, 'match' | 'boost' | 'performance' | 'audienceWeight' | 'performanceWeight'>,
): number {
  return round(s.audienceWeight * Math.min(1, s.match * s.boost) + s.performanceWeight * s.performance);
}

export interface CampaignBundle {
  campaign: Campaign;
  advertiser: Advertiser | undefined;
  creatives: Creative[];
}

/** Evaluate every campaign for a screen and crowd: filters, triggers and (for eligible ones) scores. */
export function evaluateCampaigns(
  bundles: readonly CampaignBundle[],
  ctx: ScoringContext,
): CandidateEvaluation[] {
  return bundles
    .map(({ campaign, advertiser, creatives }) => {
      const creative = creatives.find((c) => c.status === 'approved') ?? creatives.at(0);
      const triggers = activeTriggers(campaign, ctx);
      const filters = hardFilters(campaign, advertiser, creative, ctx, triggers);
      const eligible = filters.every((f) => f.passed);
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        advertiserId: campaign.advertiserId,
        advertiserName: advertiser?.name ?? campaign.advertiserId,
        competitorGroup: campaign.competitorGroup,
        airlinePriority: campaign.airlinePriority,
        creativeId: creative?.id ?? null,
        eligible,
        filters,
        score: eligible ? scoreCampaign(campaign, ctx, triggers) : null,
      };
    })
    .sort(
      (a, b) => (b.score?.final ?? -1) - (a.score?.final ?? -1) || a.campaignId.localeCompare(b.campaignId),
    );
}
