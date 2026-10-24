/**
 * Read models for the role views: advertiser dashboards, passenger flow, promo codes, campaign performance
 * and suggested weights, the campaign builder's live audience preview, airline views, the media manager's
 * inventory, pricing and delivery, and segment heat maps.
 *
 * Everything is computed with the same presence, scoring and learning code the decision engine uses, so a
 * number on a dashboard can always be traced to a decision.
 */
import {
  type Advertiser,
  type Campaign,
  type CrowdProfile,
  type Flight,
  type Screen,
  SEGMENT_DIMENSIONS,
  addMinutes,
  floorTo,
  gateId,
  getOwn,
  localToUtc,
  segmentShare,
  toLocal,
} from '@arm/domain';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import { ATTENTION } from '../engine/decision-engine.js';
import type { DayTotals } from '../engine/day-tally.js';
import {
  type CrowdEstimate,
  type PresenceInputs,
  allZonePresence,
  departureTiming,
  proximityWeight,
  screenCrowd,
  zonePresence,
} from '../engine/presence.js';
import { blendProfiles } from '../engine/profile-math.js';
import {
  type CampaignBundle,
  audienceMatch,
  evaluateCampaigns,
  placementFilter,
  scheduleFilter,
} from '../engine/scoring.js';
import type { Simulation } from '../sim/simulation.js';

export class AnalyticsError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid',
  ) {
    super(message);
  }
}

type Sim = Pick<Simulation, 'engine' | 'state' | 'clock' | 'fleet'>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const HOUR = 60;

export interface Totals extends DayTotals {
  /** Attributed sales per unit of media cost. */
  roas: number | null;
  /** Return on investment: (attributed sales − media cost) ÷ media cost, as a fraction (0.5 = +50%). */
  roi: number | null;
}

/** (attributed sales − spend) ÷ spend; null when nothing was spent. */
const roiOf = (revenue: number, spend: number): number | null =>
  spend > 0 ? r4((revenue - spend) / spend) : null;

const withRoas = (d: DayTotals): Totals => ({
  plays: d.plays,
  viewers: Math.round(d.viewers),
  cost: r2(d.cost),
  scans: d.scans,
  redemptions: d.redemptions,
  revenue: r2(d.revenue),
  roas: d.cost > 0 ? r2(d.revenue / d.cost) : null,
  roi: roiOf(d.revenue, d.cost),
});

const sumTotals = (rows: readonly DayTotals[]): DayTotals =>
  rows.reduce(
    (a, b) => ({
      plays: a.plays + b.plays,
      viewers: a.viewers + b.viewers,
      cost: a.cost + b.cost,
      scans: a.scans + b.scans,
      redemptions: a.redemptions + b.redemptions,
      revenue: a.revenue + b.revenue,
    }),
    { plays: 0, viewers: 0, cost: 0, scans: 0, redemptions: 0, revenue: 0 },
  );

/** Top segments of a dimension in a profile, largest first. */
function topSegments(
  profile: Pick<CrowdProfile, 'segments'>,
  dimension: keyof typeof SEGMENT_DIMENSIONS,
  n = 3,
) {
  const values: readonly string[] = getOwn<readonly string[]>(SEGMENT_DIMENSIONS, dimension) ?? [];
  return values
    .map((v) => ({
      segment: `${dimension}.${v}`,
      share: r4(segmentShare(profile, `${dimension}.${v}` as never)),
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, n);
}

export class AnalyticsService {
  constructor(
    private readonly database: Database,
    private readonly sim: Sim,
    private readonly opts: { simDate: string; utcOffsetMinutes: number; slotSeconds: number },
  ) {}

  private get slotSeconds(): number {
    return this.opts.slotSeconds;
  }

  private get catalog() {
    return this.sim.engine.catalog;
  }

  private now(): Date {
    return this.sim.clock.now();
  }

  private dayStart(): Date {
    return localToUtc(this.opts.simDate, 0, 0, this.opts.utcOffsetMinutes);
  }

  private inputs(): PresenceInputs {
    return {
      flights: this.sim.state.allFlights(),
      profiles: this.sim.state.profileMap(),
      queues: this.sim.state.queueMap(),
      layout: this.catalog.layout(),
    };
  }

  private advertiser(id: string): Advertiser {
    const a = this.catalog.advertiser(id);
    if (!a) throw new AnalyticsError(`unknown advertiser ${id}`, 'not_found');
    return a;
  }

  private campaignsOf(advertiserId: string): Campaign[] {
    return this.catalog.campaigns().filter((c) => c.advertiserId === advertiserId);
  }

  // ---- advertisers ----------------------------------------------------------------------------------------

  /** Live dashboard of one advertiser: today's totals, its campaigns, hourly delivery and recent sales. */
  async advertiserOverview(advertiserId: string) {
    const advertiser = this.advertiser(advertiserId);
    const campaigns = this.campaignsOf(advertiserId);
    const ids = campaigns.map((c) => c.id);
    const engine = this.sim.engine;
    const perf = engine.learning.performanceMap();
    const rows = campaigns.map((c) => {
      const today = engine.campaignToday(c.id);
      const spend = engine.spendOf(c.id);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        today: withRoas(today),
        spend: { today: r2(spend.today), total: r2(spend.total) },
        budget: { dailyCap: c.budget.dailyCap, total: c.budget.total, cpm: c.budget.cpm },
        pacing: {
          daily: c.budget.dailyCap > 0 ? r4(spend.today / c.budget.dailyCap) : null,
          total: c.budget.total > 0 ? r4(spend.total / c.budget.total) : null,
        },
        performance: r4(perf.get(c.id) ?? c.performanceIndex),
        promo: c.promo ? { offerText: c.promo.offerText, inStock: c.promo.inStock } : null,
        schedule: c.placement.schedule,
      };
    });
    const totals = withRoas(sumTotals(campaigns.map((c) => engine.campaignToday(c.id))));
    return {
      at: this.now().toISOString(),
      advertiser,
      today: totals,
      campaigns: rows,
      hourly: await this.hourly(ids),
      recentRedemptions: await this.recentRedemptions(ids, 12),
    };
  }

  /** Delivery and sales per local hour today (recorded windows plus the current one). */
  private async hourly(campaignIds: readonly string[]) {
    const out = new Map<
      number,
      { plays: number; viewers: number; cost: number; scans: number; redemptions: number; revenue: number }
    >();
    const slot = (h: number) => {
      let v = out.get(h);
      if (!v) {
        v = { plays: 0, viewers: 0, cost: 0, scans: 0, redemptions: 0, revenue: 0 };
        out.set(h, v);
      }
      return v;
    };
    const now = this.now();
    for (let h = 0; h <= toLocal(now, this.opts.utcOffsetMinutes).hour; h += 1) slot(h);
    if (campaignIds.length === 0) return [];
    const { db } = this.database;
    const imp = await db
      .select({
        windowStart: t.impressions.windowStart,
        plays: sql<number>`sum(${t.impressions.plays})`,
        viewers: sql<number>`sum(${t.impressions.estimatedViewers})`,
        cost: sql<number>`sum(${t.impressions.cost})`,
        scans: sql<number>`sum(${t.impressions.scans})`,
      })
      .from(t.impressions)
      .where(
        and(
          inArray(t.impressions.campaignId, [...campaignIds]),
          gte(t.impressions.windowStart, this.dayStart()),
          lte(t.impressions.windowStart, now),
        ),
      )
      .groupBy(t.impressions.windowStart);
    for (const r of imp) {
      const v = slot(toLocal(r.windowStart, this.opts.utcOffsetMinutes).hour);
      v.plays += Number(r.plays);
      v.viewers += Number(r.viewers);
      v.cost += Number(r.cost);
      v.scans += Number(r.scans);
    }
    const red = await db
      .select({ at: t.redemptions.redeemedAt, revenue: t.redemptions.revenue })
      .from(t.redemptions)
      .where(
        and(
          inArray(t.redemptions.campaignId, [...campaignIds]),
          gte(t.redemptions.redeemedAt, this.dayStart()),
          lte(t.redemptions.redeemedAt, now),
        ),
      );
    for (const r of red) {
      const v = slot(toLocal(r.at, this.opts.utcOffsetMinutes).hour);
      v.redemptions += 1;
      v.revenue += r.revenue;
    }
    return [...out.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([hour, v]) => ({
        hour,
        plays: v.plays,
        viewers: Math.round(v.viewers),
        cost: r2(v.cost),
        scans: v.scans,
        redemptions: v.redemptions,
        revenue: r2(v.revenue),
      }));
  }

  private async recentRedemptions(campaignIds: readonly string[], limit: number) {
    if (campaignIds.length === 0) return [];
    const rows = await this.database.db
      .select()
      .from(t.redemptions)
      .where(
        and(inArray(t.redemptions.campaignId, [...campaignIds]), lte(t.redemptions.redeemedAt, this.now())),
      )
      .orderBy(desc(t.redemptions.redeemedAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      at: r.redeemedAt.toISOString(),
      code: r.code,
      campaignId: r.campaignId,
      campaignName: this.catalog.campaign(r.campaignId)?.name ?? r.campaignId,
      outletName: r.outletId ? (this.catalog.outlet(r.outletId)?.name ?? r.outletId) : null,
      screenId: r.screenId,
      segment: r.segment,
      revenue: r2(r.revenue),
      fromPhone: !r.id.startsWith('red-sim-'),
    }));
  }

  /**
   * Passenger flow for the next hours in the zones of an advertiser's outlets (or the given zone): sampled
   * every 15 minutes, with a summary for the next 60 minutes.
   */
  passengerFlow(advertiserId: string, hours: number, zoneId?: string) {
    const advertiser = this.advertiser(advertiserId);
    const layout = this.catalog.layout();
    const outletZones = [
      ...new Set(
        this.catalog
          .outlets()
          .filter((o) => o.advertiserId === advertiserId)
          .map((o) => o.zoneId),
      ),
    ];
    const zoneIds = zoneId ? [zoneId] : outletZones.length > 0 ? outletZones : ['T2-PLZ'];
    const zones = zoneIds.map((id) => layout.zone(id)).filter((z) => z !== undefined);
    if (zones.length === 0) throw new AnalyticsError(`unknown zone ${zoneId ?? ''}`, 'not_found');
    const inputs = this.inputs();
    const now = floorTo(this.now(), 5);
    const points: { at: string; pax: number; international: number; profile: CrowdProfile }[] = [];
    for (let m = 0; m <= hours * HOUR; m += 15) {
      const at = addMinutes(now, m);
      const parts = zones.map((z) => zonePresence(z, inputs, at));
      const pax = parts.reduce((s, p) => s + p.pax, 0);
      const profile = blendProfiles(parts.map((p) => ({ profile: p.profile, pax: p.pax })));
      points.push({
        at: at.toISOString(),
        pax: Math.round(pax),
        international: r4(segmentShare(profile, 'market.international')),
        profile,
      });
    }
    const next = points.filter((p) => Date.parse(p.at) <= addMinutes(now, HOUR).getTime());
    const nextPax = next.reduce((s, p) => s + p.pax, 0);
    const blended = blendProfiles(next.map((p) => ({ profile: p.profile, pax: p.pax })));
    return {
      advertiserId: advertiser.id,
      zones: zones.map((z) => ({ id: z.id, name: z.name })),
      at: now.toISOString(),
      next60: {
        averagePax: next.length > 0 ? Math.round(nextPax / next.length) : 0,
        peakPax: Math.max(0, ...next.map((p) => p.pax)),
        international: r4(segmentShare(blended, 'market.international')),
        topDestinations: blended.topDestinations.slice(0, 3),
        topNationalities: blended.topNationalities.slice(0, 3),
        tripPurpose: topSegments(blended, 'tripPurpose'),
        partyType: topSegments(blended, 'partyType'),
      },
      points: points.map((p) => ({
        at: p.at,
        pax: p.pax,
        international: p.international,
        families: r4(segmentShare(p.profile, 'partyType.family')),
        business: r4(segmentShare(p.profile, 'tripPurpose.business')),
      })),
    };
  }

  /** Codes issued from the QR flow, with their family shares and redemption state. */
  async promoCodes(advertiserId: string) {
    this.advertiser(advertiserId);
    const ids = this.campaignsOf(advertiserId).map((c) => c.id);
    if (ids.length === 0) return { codes: [], redemptionsToday: 0, revenueToday: 0 };
    const { db } = this.database;
    const codes = await db
      .select()
      .from(t.promoCodes)
      .where(inArray(t.promoCodes.campaignId, ids))
      .orderBy(desc(t.promoCodes.issuedAt))
      .limit(200);
    const redeemed = new Set(
      codes.length === 0
        ? []
        : (
            await db
              .select({ code: t.redemptions.code })
              .from(t.redemptions)
              .where(
                inArray(
                  t.redemptions.code,
                  codes.map((c) => c.code),
                ),
              )
          ).map((r) => r.code),
    );
    const now = this.now().getTime();
    const today = sumTotals(ids.map((id) => this.sim.engine.campaignToday(id)));
    return {
      codes: codes.map((c) => ({
        code: c.code,
        campaignId: c.campaignId,
        campaignName: this.catalog.campaign(c.campaignId)?.name ?? c.campaignId,
        screenId: c.screenId,
        flight: c.flightId ? (c.flightId.split('-').at(0) ?? c.flightId) : null,
        parentCode: c.parentCode,
        issuedAt: c.issuedAt.toISOString(),
        expiresAt: c.expiresAt.toISOString(),
        status: redeemed.has(c.code) ? 'redeemed' : c.expiresAt.getTime() <= now ? 'expired' : 'active',
      })),
      redemptionsToday: today.redemptions,
      revenueToday: r2(today.revenue),
    };
  }

  // ---- campaigns ------------------------------------------------------------------------------------------

  /**
   * Performance of one campaign: today, the last 30 days (ROI per day), conversion by segment, and suggested
   * segment weights from the learned lift ("families redeem 2.1× the average: raise their weight").
   */
  async campaignPerformance(campaignId: string) {
    const campaign = this.catalog.campaign(campaignId);
    if (!campaign) throw new AnalyticsError(`unknown campaign ${campaignId}`, 'not_found');
    const history = await this.database.db
      .select()
      .from(t.campaignDailyStats)
      .where(eq(t.campaignDailyStats.campaignId, campaignId))
      .orderBy(t.campaignDailyStats.date);
    const days = history.map((d) => ({
      date: d.date,
      plays: d.plays,
      impressions: d.impressions,
      scans: d.scans,
      redemptions: d.redemptions,
      spend: r2(d.spend),
      revenue: r2(d.revenue),
      roas: d.spend > 0 ? r2(d.revenue / d.spend) : null,
      roi: roiOf(d.revenue, d.spend),
    }));
    const thirty = days.reduce(
      (a, d) => ({
        spend: a.spend + d.spend,
        revenue: a.revenue + d.revenue,
        redemptions: a.redemptions + d.redemptions,
        impressions: a.impressions + d.impressions,
      }),
      { spend: 0, revenue: 0, redemptions: 0, impressions: 0 },
    );
    const learning = this.sim.engine.learning;
    // Who redeems: each segment's share of the campaign's redemptions (30 days of history plus today's live
    // outcomes) against its share of the passengers at the airport today. 2× = twice their share.
    const redeemed = new Map<string, number>();
    for (const d of history)
      for (const [segment, n] of Object.entries(d.redemptionsBySegment as Record<string, number>))
        redeemed.set(segment, (redeemed.get(segment) ?? 0) + Number(n));
    for (const s of learning.segmentRates(campaignId))
      if (redeemed.has(s.segment)) redeemed.set(s.segment, (redeemed.get(s.segment) ?? 0) + s.redemptions);
    const baseline = this.passengerProfile();
    const dimensionTotals = new Map<string, number>();
    for (const [segment, n] of redeemed) {
      const dim = segment.split('.')[0] ?? '';
      dimensionTotals.set(dim, (dimensionTotals.get(dim) ?? 0) + n);
    }
    const segments = [...redeemed.entries()].map(([segment, n]) => {
      const total = dimensionTotals.get(segment.split('.')[0] ?? '') ?? 0;
      const share = total > 0 ? n / total : 0;
      const passengers = baseline ? segmentShare(baseline, segment as never) : 0;
      return {
        segment,
        redemptions: n,
        share: r4(share),
        passengerShare: r4(passengers),
        lift: passengers > 0 ? r4(share / passengers) : 0,
      };
    });
    const weights = new Map(Object.entries(campaign.segmentWeights));
    // Only tune dimensions the campaign already targets: adding a dimension changes what "match" averages.
    const targeted = new Set([...weights.keys()].map((s) => s.split('.')[0]));
    const suggestions = segments
      .filter((s) => s.redemptions >= 20 && s.lift > 0 && targeted.has(s.segment.split('.')[0]))
      .map((s) => {
        const current = weights.get(s.segment) ?? 0;
        // Scale the weight by √lift (damped): over-indexing segments only go up, under-indexing ones down.
        const target = current > 0 ? current * Math.sqrt(s.lift) : Math.max(0, (s.lift - 1) / 2);
        const suggested = r2(Math.min(1, Math.max(0, target)));
        return {
          segment: s.segment,
          current,
          suggested,
          lift: s.lift,
          share: s.share,
          passengerShare: s.passengerShare,
        };
      })
      .filter((s) => Math.abs(s.suggested - s.current) >= 0.1)
      .sort((a, b) => Math.abs(b.suggested - b.current) - Math.abs(a.suggested - a.current))
      .slice(0, 6);
    // A/B: the engine alternates a campaign's approved creatives by hour and screen; compare them today.
    const abRows = await this.database.db
      .select({
        creativeId: t.impressions.creativeId,
        plays: sql<number>`sum(${t.impressions.plays})`,
        viewers: sql<number>`sum(${t.impressions.estimatedViewers})`,
        scans: sql<number>`sum(${t.impressions.scans})`,
      })
      .from(t.impressions)
      .where(
        and(
          eq(t.impressions.campaignId, campaignId),
          gte(t.impressions.windowStart, this.dayStart()),
          lte(t.impressions.windowStart, this.now()),
        ),
      )
      .groupBy(t.impressions.creativeId);
    const creatives = campaign.creativeIds.map((id) => {
      const row = abRows.find((r) => r.creativeId === id);
      const viewers = Number(row?.viewers ?? 0);
      const scans = Number(row?.scans ?? 0);
      return {
        creativeId: id,
        name: this.catalog.creative(id)?.name ?? id,
        plays: Number(row?.plays ?? 0),
        viewers: Math.round(viewers),
        scans,
        scansPerThousand: viewers > 0 ? r2((scans / viewers) * 1000) : null,
      };
    });
    return {
      creatives,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        segmentWeights: campaign.segmentWeights,
      },
      today: withRoas(this.sim.engine.campaignToday(campaignId)),
      performance: r4(learning.performanceMap().get(campaignId) ?? campaign.performanceIndex),
      modelVersion: learning.version,
      last30: {
        days,
        spend: r2(thirty.spend),
        revenue: r2(thirty.revenue),
        redemptions: thirty.redemptions,
        impressions: thirty.impressions,
        roas: thirty.spend > 0 ? r2(thirty.revenue / thirty.spend) : null,
        roi: roiOf(thirty.revenue, thirty.spend),
      },
      segments,
      suggestions,
    };
  }

  /** Profile of all departing passengers today (the baseline for "who redeems"). */
  private passengerProfile(): CrowdProfile | null {
    const profiles = this.sim.state.profileMap();
    const parts = this.sim.state
      .allFlights()
      .filter((f) => f.direction === 'D')
      .map((f) => ({ profile: profiles.get(f.id), pax: f.pax ?? f.seats }))
      .filter((p): p is { profile: CrowdProfile; pax: number } => p.profile !== undefined && p.pax > 0);
    return parts.length > 0 ? blendProfiles(parts) : null;
  }

  /**
   * Live audience preview for a campaign being built: how it would score on every screen it is placed on,
   * right now, and why it would not play where it is filtered out.
   */
  preview(
    draft: Omit<
      Campaign,
      'id' | 'status' | 'performanceIndex' | 'createdAt' | 'updatedAt' | 'competitorGroup'
    > & {
      competitorGroup?: string | null;
    },
  ) {
    const now = this.now();
    const advertiser = this.catalog.advertiser(draft.advertiserId);
    const campaign: Campaign = {
      ...draft,
      id: 'preview',
      status: 'active',
      competitorGroup: draft.competitorGroup ?? advertiser?.competitorGroup ?? null,
      performanceIndex: 0.3,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    // The preview only judges audience and placement: the creative is assumed approved.
    const bundle: CampaignBundle = {
      campaign,
      advertiser,
      creatives: [
        {
          id: 'preview-creative',
          advertiserId: campaign.advertiserId,
          name: 'preview',
          template: 'offer_split',
          artwork: 'voucher',
          palette: { background: '#000000', foreground: '#FFFFFF', accent: '#FFFFFF' },
          content: { en: { headline: 'preview', body: 'preview', cta: '', badge: null } },
          formats: ['16:9'],
          status: 'approved',
          brandSafety: {
            ageAppropriate: true,
            claimsVerified: true,
            noRealBrandMarks: true,
            legibleAtDistance: true,
          },
          createdAt: now.toISOString(),
        },
      ],
    };
    const inputs = this.inputs();
    const zones = allZonePresence(inputs, now);
    const placed = this.catalog.screens().filter((s) => placementFilter(campaign, s).passed);
    const reasons = new Map<string, number>();
    const results: { screen: Screen; crowd: CrowdEstimate; final: number; match: number }[] = [];
    for (const screen of placed) {
      const crowd = screenCrowd(screen, inputs, now, this.catalog.screensInZone(screen.zoneId), zones);
      const [evaluation] = evaluateCampaigns([bundle], this.sim.engine.scoringContext(screen, crowd, now));
      if (!evaluation) continue;
      if (evaluation.eligible && evaluation.score) {
        results.push({ screen, crowd, final: evaluation.score.final, match: evaluation.score.match });
      } else {
        for (const f of evaluation.filters.filter((x) => !x.passed))
          reasons.set(f.rule, (reasons.get(f.rule) ?? 0) + 1);
      }
    }
    const minScore = this.catalog.settings().minScoreToPlay;
    const playable = results.filter((r) => r.final >= minScore);
    const avg = (xs: readonly number[]) =>
      xs.length > 0 ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    const viewersPerHour = playable.reduce((s, r) => s + r.crowd.pax, 0) * 0.07 * 4;
    const blended = blendProfiles(playable.map((r) => ({ profile: r.crowd.profile, pax: r.crowd.pax })));
    return {
      at: now.toISOString(),
      screensPlaced: placed.length,
      screensEligible: results.length,
      screensPlayable: playable.length,
      minScoreToPlay: minScore,
      averageMatch: avg(results.map((r) => r.match)),
      averageScore: avg(results.map((r) => r.final)),
      estimatedViewersPerHour: Math.round(viewersPerHour),
      estimatedCostPerHour: r2((viewersPerHour / 1000) * campaign.budget.cpm),
      filtered: [...reasons.entries()]
        .map(([rule, screens]) => ({ rule, screens }))
        .sort((a, b) => b.screens - a.screens),
      best: [...results]
        .sort((a, b) => b.final - a.final)
        .slice(0, 5)
        .map((r) => ({
          screenId: r.screen.id,
          name: r.screen.name,
          zoneId: r.screen.zoneId,
          pax: Math.round(r.crowd.pax),
          match: r4(r.match),
          score: r4(r.final),
        })),
      audience:
        playable.length > 0
          ? {
              tripPurpose: topSegments(blended, 'tripPurpose'),
              partyType: topSegments(blended, 'partyType'),
              international: r4(segmentShare(blended, 'market.international')),
            }
          : null,
    };
  }

  // ---- airlines -------------------------------------------------------------------------------------------

  private airlineFlights(iata: string): Flight[] {
    return this.sim.state
      .allFlights()
      .filter((f) => f.airlineIata === iata)
      .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  }

  /**
   * An airline's day: its flights with boarding windows, the aggregated profile of its departing passengers,
   * what plays on the screens at its gates and why, its goodwill and gate-message campaigns, and partner offers
   * ranked by fit with its passengers.
   */
  airlineOverview(iata: string) {
    const advertiser = this.catalog.advertisers().find((a) => a.kind === 'airline' && a.airlineIata === iata);
    if (!advertiser) throw new AnalyticsError(`unknown airline ${iata}`, 'not_found');
    const now = this.now();
    const flights = this.airlineFlights(iata);
    const profiles = this.sim.state.profileMap();
    const layout = this.catalog.layout();
    const flightRows = flights.map((f) => {
      const timing = f.direction === 'D' ? departureTiming(f) : null;
      return {
        id: f.id,
        flight: `${f.airlineIata}${f.flightNumber}`,
        direction: f.direction,
        other: f.direction === 'D' ? f.destination : f.origin,
        terminal: f.terminal,
        gate: f.gate,
        gateId: f.gate ? gateId(f.terminal, f.gate) : null,
        scheduledTime: f.scheduledTime,
        estimatedTime: f.estimatedTime,
        status: f.status,
        pax: f.pax ?? f.seats,
        aircraft: f.aircraftTypeIcao,
        boardingAt: timing ? new Date(timing.boardingAt).toISOString() : null,
        gateCloseAt: timing ? new Date(timing.gateCloseAt).toISOString() : null,
        inBoardingWindow: timing
          ? now.getTime() >= timing.boardingAt && now.getTime() < timing.gateCloseAt
          : false,
        delayMinutes: f.estimatedTime
          ? Math.max(0, Math.round((Date.parse(f.estimatedTime) - Date.parse(f.scheduledTime)) / 60_000))
          : 0,
      };
    });
    const departures = flights.filter(
      (f) => f.direction === 'D' && !['departed', 'cancelled'].includes(f.status),
    );
    const upcoming = departures.filter(
      (f) => Date.parse(f.estimatedTime ?? f.scheduledTime) - now.getTime() < 6 * 3_600_000,
    );
    const parts = upcoming
      .map((f) => ({ profile: profiles.get(f.id), pax: f.pax ?? f.seats }))
      .filter((p): p is { profile: CrowdProfile; pax: number } => p.profile !== undefined);
    const profile = parts.length > 0 ? blendProfiles(parts) : null;

    // What plays at my gates: screens facing the gates of my departures in (or close to) their boarding window.
    const gatePlays = flightRows
      .filter(
        (f) =>
          f.direction === 'D' &&
          f.gateId &&
          f.boardingAt &&
          Date.parse(f.boardingAt) - now.getTime() < 2 * 3_600_000 &&
          Date.parse(f.gateCloseAt ?? '') > now.getTime(),
      )
      .slice(0, 8)
      .map((f) => {
        // Same rule as the presence model: screens in the gate's own room whose passengers can see it.
        const gate = f.gateId ? layout.gate(f.gateId) : undefined;
        const screens = gate
          ? this.catalog
              .screens()
              .filter((s) => s.zoneId === gate.zoneId)
              .map((s) => ({
                s,
                d: Math.hypot(s.position.x - gate.position.x, s.position.y - gate.position.y),
              }))
              .filter((x) => proximityWeight(x.d) > 0)
              .sort((a, b) => a.d - b.d)
              .map((x) => x.s)
          : [];
        return {
          flight: f.flight,
          flightId: f.id,
          gateId: f.gateId,
          inBoardingWindow: f.inBoardingWindow,
          screens: screens.slice(0, 3).map((s) => {
            const { run } = this.sim.engine.now(s.id);
            const campaign = run?.campaignId ? this.catalog.campaign(run.campaignId) : undefined;
            return {
              screenId: s.id,
              name: s.name,
              campaignId: campaign?.id ?? null,
              campaignName: campaign?.name ?? null,
              advertiser: campaign ? (this.catalog.advertiser(campaign.advertiserId)?.name ?? null) : null,
              own: campaign?.advertiserId === advertiser.id,
              mode: run?.mode ?? null,
              score: run?.score ?? null,
              reason: run?.reason ?? null,
            };
          }),
        };
      });

    const own = this.campaignsOf(advertiser.id).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      airlinePriority: c.airlinePriority,
      triggers: c.triggers,
      coFundedBy: c.coFundedBy,
      today: withRoas(this.sim.engine.campaignToday(c.id)),
    }));
    const goodwill = own.filter((c) => c.triggers.some((tr) => tr.type === 'delay_over'));
    const activations = goodwill.flatMap((c) =>
      c.triggers
        .filter((tr) => tr.type === 'delay_over')
        .flatMap((tr) =>
          flightRows
            .filter(
              (f) =>
                f.direction === 'D' &&
                f.delayMinutes >= (tr.minutes ?? 30) &&
                !['departed', 'cancelled'].includes(f.status),
            )
            .map((f) => ({
              campaignId: c.id,
              campaignName: c.name,
              flight: f.flight,
              delayMinutes: f.delayMinutes,
              gateId: f.gateId,
            })),
        ),
    );

    const partnerOffers = profile
      ? this.catalog
          .campaigns()
          .filter(
            (c) =>
              c.status === 'active' &&
              c.advertiserId !== advertiser.id &&
              this.catalog.advertiser(c.advertiserId)?.kind !== 'airline',
          )
          .map((c) => ({
            campaignId: c.id,
            name: c.name,
            advertiser: this.catalog.advertiser(c.advertiserId)?.name ?? c.advertiserId,
            offerText: c.promo?.offerText ?? null,
            match: audienceMatch(c.segmentWeights, profile).match,
          }))
          .sort((a, b) => b.match - a.match)
          .slice(0, 8)
      : [];

    return {
      at: now.toISOString(),
      airline: advertiser,
      flights: flightRows,
      summary: {
        departures: flightRows.filter((f) => f.direction === 'D').length,
        arrivals: flightRows.filter((f) => f.direction === 'A').length,
        delayed: flightRows.filter((f) => f.delayMinutes > 0 && !['departed', 'arrived'].includes(f.status))
          .length,
        paxToday: flightRows.reduce((s, f) => s + f.pax, 0),
        inBoarding: flightRows.filter((f) => f.inBoardingWindow).length,
      },
      profile: profile
        ? {
            flights: parts.length,
            tripPurpose: topSegments(profile, 'tripPurpose', 5),
            partyType: topSegments(profile, 'partyType', 4),
            ageBand: topSegments(profile, 'ageBand', 7),
            cabin: topSegments(profile, 'cabin', 3),
            international: r4(segmentShare(profile, 'market.international')),
            topNationalities: profile.topNationalities.slice(0, 4),
            topDestinations: profile.topDestinations.slice(0, 4),
          }
        : null,
      gatePlays,
      campaigns: own,
      goodwill: { campaigns: goodwill, activations },
      partnerOffers,
      layoutGates: layout.gates.length,
    };
  }

  // ---- media manager --------------------------------------------------------------------------------------

  /**
   * Inventory calendar for today: screen × local hour with the predicted crowd, the share of its slots that
   * campaigns will buy, a status (booked / available / premium / quiet) and a suggested price per slot.
   *
   * Demand follows the engine's own limits: a campaign competes for a screen-hour only where it is placed,
   * scheduled and would clear the relevance floor for the predicted crowd; there it takes the smaller of its
   * frequency cap and its share of what its daily budget buys at that crowd's price.
   */
  inventory(zoneId?: string) {
    const grid = this.inventoryGrid();
    const screens = grid.screens.filter((s) => !zoneId || s.zoneId === zoneId);
    let soldSum = 0;
    let liveCells = 0;
    for (const s of screens)
      for (const c of s.cells)
        if (c.pax > 0) {
          liveCells += 1;
          soldSum += c.sold;
        }
    return {
      date: this.opts.simDate,
      hours: grid.hours,
      slotsPerHour: grid.capacity,
      premiumThresholdPax: grid.p80,
      occupancy: liveCells > 0 ? r4(soldSum / liveCells) : 0,
      screens,
    };
  }

  private inventoryCache: { key: string; grid: InventoryGrid } | null = null;

  private inventoryGrid(): InventoryGrid {
    const key = [this.catalog.version, this.sim.state.version, this.sim.engine.learning.version].join('|');
    if (this.inventoryCache?.key === key) return this.inventoryCache.grid;
    const inputs = this.inputs();
    const screens = this.catalog.screens().sort((a, b) => a.id.localeCompare(b.id));
    const settings = this.catalog.settings();
    const performance = this.sim.engine.learning.performanceMap();
    const campaigns = this.catalog.campaigns().filter((c) => c.status === 'active');
    const capacity = Math.round(3600 / this.slotSeconds);
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const pax = new Map<string, number>();
    const relevant = new Map<string, string[]>();
    // Pass 1: crowd per screen-hour and the campaigns that would compete for it.
    for (const h of hours) {
      const at = localToUtc(this.opts.simDate, h, 30, this.opts.utcOffsetMinutes);
      const zones = allZonePresence(inputs, at);
      for (const s of screens) {
        const crowd = screenCrowd(s, inputs, at, this.catalog.screensInZone(s.zoneId), zones);
        const cell = `${s.id}|${h}`;
        pax.set(cell, crowd.pax);
        if (crowd.pax <= 0) continue;
        const ids: string[] = [];
        for (const c of campaigns) {
          if (!placementFilter(c, s).passed) continue;
          if (!scheduleFilter(c, { now: at, utcOffsetMinutes: this.opts.utcOffsetMinutes }).passed) continue;
          const { match } = audienceMatch(c.segmentWeights, crowd.profile);
          const score =
            settings.audienceWeight * Math.min(1, match) +
            settings.performanceWeight * (performance.get(c.id) ?? c.performanceIndex);
          if (score >= settings.minScoreToPlay) ids.push(c.id);
        }
        relevant.set(cell, ids);
      }
    }
    // Pass 2: plays each campaign can afford per eligible screen-hour (budget-limited, capped).
    const kindOf = new Map(screens.map((s) => [s.id, s.kind]));
    const playsPerCell = new Map<string, number>();
    for (const c of campaigns) {
      const cells = [...relevant.entries()].filter(([, ids]) => ids.includes(c.id)).map(([cell]) => cell);
      if (cells.length === 0) continue;
      const costs = cells.map((cell) => {
        const screenId = cell.split('|')[0] ?? '';
        const viewers = (pax.get(cell) ?? 0) * (ATTENTION.get(kindOf.get(screenId) ?? '') ?? 0.06);
        return (viewers / 1000) * c.budget.cpm;
      });
      const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
      const affordable = avgCost > 0 ? c.budget.dailyCap / avgCost : capacity * cells.length;
      playsPerCell.set(c.id, Math.min(c.budget.frequencyCapPerScreenHour, affordable / cells.length));
    }
    const live = [...pax.values()].filter((p) => p > 0).sort((a, b) => a - b);
    const p80 = live.at(Math.floor(live.length * 0.8)) ?? 0;
    const mean = live.length > 0 ? live.reduce((a, b) => a + b, 0) / live.length : 0;
    const grid: InventoryGrid = {
      hours,
      capacity,
      p80: Math.round(p80),
      screens: screens.map((s) => ({
        screenId: s.id,
        name: s.name,
        zoneId: s.zoneId,
        kind: s.kind,
        basePrice: s.basePricePerSlot,
        cells: hours.map((h) => {
          const cell = `${s.id}|${h}`;
          const crowd = pax.get(cell) ?? 0;
          const ids = relevant.get(cell) ?? [];
          const demand = ids.reduce((sum, id) => sum + (playsPerCell.get(id) ?? 0), 0);
          const sold = Math.min(1, demand / capacity);
          const premium = crowd > 0 && crowd >= p80;
          return {
            hour: h,
            pax: Math.round(crowd),
            campaigns: ids.length,
            sold: r4(sold),
            status: crowd <= 0 ? 'quiet' : sold >= 0.85 ? 'booked' : premium ? 'premium' : 'available',
            premium,
            price: suggestedPrice(s.basePricePerSlot, crowd, mean),
          };
        }),
      })),
    };
    this.inventoryCache = { key, grid };
    return grid;
  }

  /**
   * Best three slots tomorrow for a campaign: zone × hour scored by the expected audience match with the
   * predicted crowd, the size of that crowd and the share still unsold, per unit of price. Tomorrow's crowd is
   * today's presence pattern scaled by the weekday factor.
   */
  bestSlots(campaignId: string) {
    const campaign = this.catalog.campaign(campaignId);
    if (!campaign) throw new AnalyticsError(`unknown campaign ${campaignId}`, 'not_found');
    const grid = this.inventoryGrid();
    const inputs = this.inputs();
    const layout = this.catalog.layout();
    const base = Date.parse(`${this.opts.simDate}T12:00:00Z`);
    const tomorrow = new Date(base + 86_400_000);
    const factor =
      (WEEKDAY_FACTOR.get(tomorrow.getUTCDay()) ?? 1) / (WEEKDAY_FACTOR.get(new Date(base).getUTCDay()) ?? 1);
    // Where the campaign makes sense: its own zones, plus zones on the same side of security in the same
    // terminals (a duty-free code cannot be redeemed before security). Halls and checkpoints only when placed.
    const placed = new Set(campaign.placement.zoneIds);
    const placedZones = campaign.placement.zoneIds
      .map((id) => layout.zone(id))
      .filter((z) => z !== undefined);
    const sides = new Set(placedZones.map((z) => `${z.terminalId}|${z.side}`));
    const passThrough = new Set(['landside_hall', 'security', 'passport_control', 'arrivals_hall']);
    const eligible = (zoneId: string) => {
      const z = layout.zone(zoneId);
      if (!z) return false;
      if (placed.has(zoneId)) return true;
      return sides.has(`${z.terminalId}|${z.side}`) && !passThrough.has(z.kind);
    };
    const byZone = new Map<string, InventoryGrid['screens']>();
    for (const s of grid.screens)
      if (eligible(s.zoneId)) byZone.set(s.zoneId, [...(byZone.get(s.zoneId) ?? []), s]);
    const candidates: {
      zoneId: string;
      zoneName: string;
      hour: number;
      pax: number;
      match: number;
      available: number;
      price: number;
      value: number;
    }[] = [];
    const hours = campaign.placement.schedule.hours;
    for (let h = 6; h <= 23; h += 1) {
      if (hours && (h < hours.from || h >= hours.to)) continue;
      const at = localToUtc(this.opts.simDate, h, 30, this.opts.utcOffsetMinutes);
      for (const [zoneId, screens] of byZone) {
        const zone = layout.zone(zoneId);
        if (!zone) continue;
        const cells = screens.map((s) => s.cells.at(h)).filter((c) => c !== undefined && c.pax > 0);
        if (cells.length === 0) continue;
        const profile = zonePresence(zone, inputs, at).profile;
        const { match } = audienceMatch(campaign.segmentWeights, profile);
        const pax = cells.reduce((s, c) => s + (c?.pax ?? 0), 0) * factor;
        const available = 1 - cells.reduce((s, c) => s + (c?.sold ?? 0), 0) / cells.length;
        const price = cells.reduce((s, c) => s + (c?.price ?? 0), 0) / cells.length;
        if (match <= 0 || available <= 0.05 || price <= 0) continue;
        candidates.push({
          zoneId,
          zoneName: zone.name,
          hour: h,
          pax,
          match,
          available,
          price,
          value: (match * pax * available) / price,
        });
      }
    }
    candidates.sort((a, b) => b.value - a.value);
    const picked: typeof candidates = [];
    for (const c of candidates) {
      if (picked.some((p) => p.zoneId === c.zoneId && Math.abs(p.hour - c.hour) <= 1)) continue;
      picked.push(c);
      if (picked.length === 3) break;
    }
    return {
      campaignId,
      date: tomorrow.toISOString().slice(0, 10),
      weekdayIndex: r2(factor),
      slots: picked.map((c) => ({
        zoneId: c.zoneId,
        zoneName: c.zoneName,
        hour: c.hour,
        expectedPax: Math.round(c.pax),
        match: r4(c.match),
        available: r4(c.available),
        pricePerSlot: r2(c.price),
        expectedViewersPerHour: Math.round(c.pax * 0.07 * c.available * 4),
      })),
    };
  }

  /**
   * Seven-day outlook from today's simulated day: footfall by day scaled by weekday and event factors, with
   * the expected occupancy and an average suggested price.
   */
  forecast7() {
    const inputs = this.inputs();
    const byHour: number[] = [];
    for (let h = 0; h < 24; h += 1) {
      const at = localToUtc(this.opts.simDate, h, 30, this.opts.utcOffsetMinutes);
      let pax = 0;
      for (const e of allZonePresence(inputs, at).values()) pax += e.pax;
      byHour.push(pax);
    }
    const todayPax = byHour.reduce((a, b) => a + b, 0);
    const base = Date.parse(`${this.opts.simDate}T12:00:00Z`);
    const todayFactor = WEEKDAY_FACTOR.get(new Date(base).getUTCDay()) ?? 1;
    const inv = this.inventory();
    const screens = this.catalog.screens();
    const avgBase = screens.reduce((s, x) => s + x.basePricePerSlot, 0) / Math.max(1, screens.length);
    return {
      model:
        'Today’s simulated footfall scaled by weekday factors (published schedule pattern); festival days +8%.',
      days: Array.from({ length: 7 }, (_, i) => {
        const date = new Date(base + i * 86_400_000);
        const factor = (WEEKDAY_FACTOR.get(date.getUTCDay()) ?? 1) / todayFactor;
        const pax = Math.round(todayPax * factor);
        return {
          date: date.toISOString().slice(0, 10),
          weekday: date.getUTCDay(),
          paxHours: pax,
          index: r2(factor),
          occupancy: r4(Math.min(0.98, inv.occupancy * (0.85 + 0.15 * factor))),
          averagePrice: r2(avgBase * Math.min(2.5, Math.max(0.6, Math.sqrt(factor)))),
        };
      }),
    };
  }

  /** Delivery per advertiser today against its pacing target; under-delivery is flagged. */
  async delivery() {
    const now = this.now();
    // Pacing is judged over the time the network has actually delivered today (the simulation may have
    // started mid-day), and only over each campaign's own scheduled hours.
    const [first] = await this.database.db
      .select({ at: sql<Date | null>`min(${t.impressions.windowStart})` })
      .from(t.impressions)
      .where(and(gte(t.impressions.windowStart, this.dayStart()), lte(t.impressions.windowStart, now)));
    const since = first?.at ? new Date(first.at).getTime() : now.getTime();
    const scheduledMinutes = (c: Campaign, fromMs: number, toMs: number): number => {
      const hours = c.placement.schedule.hours;
      let minutes = 0;
      for (let ms = fromMs; ms < toMs; ms += 5 * 60_000) {
        const h = toLocal(new Date(ms), this.opts.utcOffsetMinutes).hour;
        if (!hours || (h >= hours.from && h < hours.to)) minutes += 5;
      }
      return minutes;
    };
    const dayStart = this.dayStart().getTime();
    return this.catalog
      .advertisers()
      .map((a) => {
        const campaigns = this.campaignsOf(a.id).filter((c) => c.status === 'active');
        const today = sumTotals(campaigns.map((c) => this.sim.engine.campaignToday(c.id)));
        const target = campaigns.reduce((s, c) => {
          const perDay = scheduledMinutes(c, dayStart, dayStart + 86_400_000);
          return perDay > 0
            ? s + (c.budget.dailyCap * scheduledMinutes(c, since, now.getTime())) / perDay
            : s;
        }, 0);
        const ratio = target > 0 ? today.cost / target : null;
        return {
          advertiserId: a.id,
          name: a.name,
          kind: a.kind,
          brandColor: a.brandColor,
          activeCampaigns: campaigns.length,
          today: withRoas(today),
          pacingTarget: r2(target),
          deliveryRatio: ratio === null ? null : r4(ratio),
          underDelivering: ratio !== null && ratio < 0.7,
        };
      })
      .filter((a) => a.activeCampaigns > 0)
      .sort((a, b) => (a.deliveryRatio ?? 9) - (b.deliveryRatio ?? 9));
  }

  /** Segment shares by local hour for one zone (or the whole airside), for the segment heat map. */
  segmentHeatmap(zoneId: string | undefined, fromHour: number, toHour: number) {
    const layout = this.catalog.layout();
    const zones = zoneId
      ? [layout.zone(zoneId)].filter((z) => z !== undefined)
      : layout.zones.filter((z) => z.side === 'airside');
    if (zones.length === 0) throw new AnalyticsError(`unknown zone ${zoneId ?? ''}`, 'not_found');
    const inputs = this.inputs();
    const segments = (['tripPurpose', 'partyType', 'ageBand', 'market'] as const).flatMap((d) =>
      (getOwn<readonly string[]>(SEGMENT_DIMENSIONS, d) ?? []).map((v) => `${d}.${v}`),
    );
    const hours = [];
    for (let h = fromHour; h <= toHour; h += 1) {
      const at = localToUtc(this.opts.simDate, h, 30, this.opts.utcOffsetMinutes);
      const parts = zones.map((z) => zonePresence(z, inputs, at));
      const pax = parts.reduce((s, p) => s + p.pax, 0);
      const profile = blendProfiles(parts.map((p) => ({ profile: p.profile, pax: p.pax })));
      hours.push({
        hour: h,
        pax: Math.round(pax),
        shares: segments.map((s) => r4(pax > 0 ? segmentShare(profile, s as never) : 0)),
      });
    }
    return { zoneId: zoneId ?? null, zones: zones.map((z) => ({ id: z.id, name: z.name })), segments, hours };
  }
}

interface InventoryGrid {
  hours: number[];
  capacity: number;
  p80: number;
  screens: {
    screenId: string;
    name: string;
    zoneId: string;
    kind: string;
    basePrice: number;
    cells: {
      hour: number;
      pax: number;
      campaigns: number;
      sold: number;
      status: 'quiet' | 'booked' | 'premium' | 'available';
      premium: boolean;
      price: number;
    }[];
  }[];
}

/** Relative footfall by weekday (0 = Sunday), from the published weekly schedule pattern. */
const WEEKDAY_FACTOR = new Map<number, number>([
  [0, 1.08],
  [1, 0.92],
  [2, 0.88],
  [3, 0.9],
  [4, 1.0],
  [5, 1.12],
  [6, 1.02],
]);

/** Price per slot: the list price scaled by the predicted crowd against the network average. */
export function suggestedPrice(base: number, pax: number, mean: number): number {
  if (mean <= 0) return r2(base);
  const factor = Math.min(2.5, Math.max(0.6, Math.sqrt(pax / mean)));
  return r2(base * factor);
}
