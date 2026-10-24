/**
 * Platform-owned inventory and commercial data: screens, advertisers, outlets, creatives, campaigns and
 * 30 days of campaign history (daily delivery and outcome aggregates).
 */
import {
  type Advertiser,
  type Campaign,
  type Creative,
  GATES,
  type Outlet,
  type Screen,
  ZONES,
  type Zone,
  addMinutes,
  distance,
  isoMinute,
  localToUtc,
} from '@arm/domain';

import { CAMPAIGN_SPECS } from './campaigns.js';
import { OUTLET_SEEDS, buildAdvertisers } from './parties.js';
import { Rng } from './prng.js';

/** Screens per zone (180 in total). */
const SCREENS_PER_ZONE: ReadonlyMap<string, number> = new Map([
  ['T1-A', 9],
  ['T1-B', 11],
  ['T1-C', 11],
  ['T1-BUS', 4],
  ['T1-PLZ', 20],
  ['T1-LS', 10],
  ['T1-SEC', 4],
  ['T1-ARR', 8],
  ['T2-D', 14],
  ['T2-E', 14],
  ['T2-F', 14],
  ['T2-BUS', 4],
  ['T2-PLZ', 34],
  ['T2-LS', 10],
  ['T2-SEC', 3],
  ['T2-PPC', 3],
  ['T2-ARR', 7],
]);

const SCREEN_KINDS: ReadonlyMap<Zone['kind'], readonly Screen['kind'][]> = new Map([
  ['pier', ['gate_display', 'gate_display', 'totem']],
  ['bus_lounge', ['gate_display']],
  ['airside_plaza', ['totem', 'totem', 'video_wall', 'fids_ad_panel']],
  ['landside_hall', ['fids_ad_panel', 'totem', 'video_wall']],
  ['security', ['totem']],
  ['passport_control', ['totem']],
  ['arrivals_hall', ['totem', 'fids_ad_panel', 'video_wall']],
]);

const SCREEN_SPEC: ReadonlyMap<
  Screen['kind'],
  { sizes: number[]; orientation: Screen['orientation']; resolution: string }
> = new Map([
  ['gate_display', { sizes: [55, 65], orientation: 'landscape', resolution: '1920x1080' }],
  ['totem', { sizes: [65, 75], orientation: 'portrait', resolution: '1080x1920' }],
  ['video_wall', { sizes: [138, 165], orientation: 'landscape', resolution: '3840x2160' }],
  ['fids_ad_panel', { sizes: [55], orientation: 'landscape', resolution: '1920x1080' }],
]);

/** Gates whose passengers a screen reaches: same terminal, within 180 m, nearest first (max 6). */
function nearestGates(zone: Zone, x: number, y: number): string[] {
  if (zone.kind === 'landside_hall' || zone.kind === 'security' || zone.kind === 'arrivals_hall') return [];
  // In a pier or bus lounge a screen only faces that room's gates (walls separate the bus lounge from piers).
  const gateArea = zone.kind === 'pier' || zone.kind === 'bus_lounge';
  return GATES.filter((g) => g.terminalId === zone.terminalId && (!gateArea || g.zoneId === zone.id))
    .map((g) => ({ id: g.id, d: distance(g.position, { x, y }) }))
    .filter((g) => g.d <= 180)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6)
    .map((g) => g.id);
}

function buildScreens(rng: Rng, installedAt: string): Screen[] {
  const screens: Screen[] = [];
  for (const zone of ZONES) {
    const count = SCREENS_PER_ZONE.get(zone.id) ?? 0;
    const kinds = SCREEN_KINDS.get(zone.kind) ?? ['totem'];
    for (let i = 0; i < count; i += 1) {
      const kind = rng.pick(kinds);
      const spec = SCREEN_SPEC.get(kind);
      if (!spec) continue;
      // Spread screens along the zone: piers along their length, other zones on a jittered grid.
      const along = (i + 0.5) / count;
      const x =
        zone.kind === 'pier'
          ? zone.area.x + zone.area.width / 2 + rng.float(-22, 22)
          : zone.area.x +
            zone.area.width * (zone.area.width >= zone.area.height ? along : rng.float(0.2, 0.8));
      const y =
        zone.kind === 'pier'
          ? zone.area.y + zone.area.height - 15 - along * (zone.area.height - 30)
          : zone.area.y +
            zone.area.height * (zone.area.width >= zone.area.height ? rng.float(0.25, 0.75) : along);
      const premiumZone =
        zone.kind === 'airside_plaza'
          ? 1.6
          : zone.kind === 'pier'
            ? 1.2
            : zone.kind === 'arrivals_hall'
              ? 0.9
              : 0.8;
      const sizeFactor = kind === 'video_wall' ? 2.4 : kind === 'totem' ? 1.1 : 1;
      screens.push({
        id: `SCR-${zone.id}-${String(i + 1).padStart(2, '0')}`,
        name: `${zone.name} ${kind === 'video_wall' ? 'Video Wall' : kind === 'gate_display' ? 'Gate Screen' : kind === 'fids_ad_panel' ? 'FIDS Panel' : 'Totem'} ${i + 1}`,
        terminalId: zone.terminalId,
        zoneId: zone.id,
        position: { x: Math.round(x), y: Math.round(y) },
        kind,
        orientation: spec.orientation,
        sizeInches: rng.pick(spec.sizes),
        resolution: spec.resolution,
        nearestGateIds: nearestGates(zone, x, y),
        basePricePerSlot: Math.round(4 * premiumZone * sizeFactor * 100) / 100,
        status: 'online',
        installedAt,
      });
    }
  }
  return screens;
}

/** The screen of the worked example: a gate display in Pier D between gates 41–44. */
export const WORKED_EXAMPLE_SCREEN_ID = 'SCR-T2-D-01';

function placeWorkedExampleScreen(screens: Screen[]): Screen[] {
  return screens.map((s) =>
    s.id === WORKED_EXAMPLE_SCREEN_ID
      ? {
          ...s,
          name: 'Gate 42 Screen',
          kind: 'gate_display',
          orientation: 'landscape',
          resolution: '1920x1080',
          sizeInches: 65,
          position: { x: 860, y: 490 },
          nearestGateIds: nearestGates(ZONES.find((z) => z.id === 'T2-D') as Zone, 860, 490),
        }
      : s,
  );
}

function buildOutlets(rng: Rng, openedAt: string): Outlet[] {
  return OUTLET_SEEDS.map((o, i) => {
    const zone = ZONES.find((z) => z.id === o.zoneId);
    if (!zone) throw new Error(`unknown outlet zone ${o.zoneId}`);
    return {
      id: `out-${String(i + 1).padStart(2, '0')}`,
      advertiserId: o.advertiserId,
      name: o.name,
      category: o.category,
      terminalId: zone.terminalId,
      zoneId: zone.id,
      position: {
        x: Math.round(zone.area.x + zone.area.width * rng.float(0.1, 0.9)),
        y: Math.round(zone.area.y + zone.area.height * rng.float(0.15, 0.85)),
      },
      averageBasket: o.averageBasket,
      openedAt,
    };
  });
}

export interface CampaignDailyStat {
  campaignId: string;
  /** Local date. */
  date: string;
  plays: number;
  impressions: number;
  scans: number;
  redemptions: number;
  spend: number;
  revenue: number;
  /** Redemptions per dominant segment (aggregated). */
  redemptionsBySegment: Record<string, number>;
}

export interface Inventory {
  advertisers: Advertiser[];
  outlets: Outlet[];
  screens: Screen[];
  creatives: Creative[];
  campaigns: Campaign[];
  history: CampaignDailyStat[];
}

const SEGMENTS_FOR_HISTORY = [
  'partyType.family',
  'partyType.couple',
  'partyType.solo',
  'partyType.group',
  'tripPurpose.business',
  'tripPurpose.holiday',
] as const;

function buildHistory(
  campaign: Campaign,
  outlets: readonly Outlet[],
  simDate: string,
  offset: number,
  rng: Rng,
): CampaignDailyStat[] {
  const out: CampaignDailyStat[] = [];
  const basket = outlets.find((o) => o.id === campaign.promo?.outletId)?.averageBasket ?? 0;
  const weights = new Map(Object.entries(campaign.segmentWeights));
  for (let back = 30; back >= 1; back -= 1) {
    const day = localToUtc(simDate, 12, 0, offset);
    const date = new Date(day.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    const dayStart = localToUtc(date, 0, 0, offset).getTime();
    if (
      dayStart < Date.parse(campaign.placement.schedule.start) ||
      dayStart > Date.parse(campaign.placement.schedule.end)
    )
      continue;
    const weekendLift = [6, 0].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) ? 1.15 : 1;
    const plays = Math.round(
      rng.normal((campaign.budget.dailyCap / Math.max(1, campaign.budget.cpm)) * 55, 200, 40) * weekendLift,
    );
    // Estimated viewers per 15-second play (same calibration as the live delivery engine).
    const impressions = Math.round(plays * rng.float(14, 22));
    const spend = Math.min(
      campaign.budget.dailyCap,
      Math.round((impressions / 1000) * campaign.budget.cpm * 100) / 100,
    );
    const scanRate = campaign.promo ? 0.0003 + campaign.performanceIndex * 0.0008 : 0;
    const scans = Math.round(impressions * scanRate * rng.float(0.8, 1.2));
    const redemptions = Math.round(scans * (0.25 + campaign.performanceIndex * 0.4) * rng.float(0.85, 1.15));
    // Redemptions lean towards the segments the campaign weights highest (e.g. families for the toy offer).
    const affinity = SEGMENTS_FOR_HISTORY.map((s) => ({ s, w: 0.15 + (weights.get(s) ?? 0) }));
    const total = affinity.reduce((sum, a) => sum + a.w, 0);
    const redemptionsBySegment = Object.fromEntries(
      affinity.map((a) => [a.s, Math.round((redemptions * a.w) / total)]),
    );
    out.push({
      campaignId: campaign.id,
      date,
      plays,
      impressions,
      scans,
      redemptions,
      spend,
      revenue: Math.round(redemptions * basket * rng.float(0.9, 1.2) * 100) / 100,
      redemptionsBySegment,
    });
  }
  // History never uses more than 75% of a campaign's total budget, so running campaigns still have budget.
  const spent = out.reduce((sum, d) => sum + d.spend, 0);
  const limit = campaign.budget.total * 0.75;
  if (spent <= limit || spent === 0) return out;
  const f = limit / spent;
  const scaleInt = (v: number) => Math.round(v * f);
  return out.map((d) => ({
    ...d,
    plays: scaleInt(d.plays),
    impressions: scaleInt(d.impressions),
    scans: scaleInt(d.scans),
    redemptions: scaleInt(d.redemptions),
    spend: Math.round(d.spend * f * 100) / 100,
    revenue: Math.round(d.revenue * f * 100) / 100,
    redemptionsBySegment: Object.fromEntries(
      Object.entries(d.redemptionsBySegment).map(([k, v]) => [k, scaleInt(v)]),
    ),
  }));
}

export function buildInventory(simDate: string, seed: string, utcOffsetMinutes: number): Inventory {
  const rng = new Rng(`${seed}:inventory`);
  const dayStart = localToUtc(simDate, 0, 0, utcOffsetMinutes);
  const longAgo = isoMinute(new Date(dayStart.getTime() - 400 * 86_400_000));
  const advertisers = buildAdvertisers(longAgo);
  const screens = placeWorkedExampleScreen(buildScreens(rng.fork('screens'), longAgo));
  const outlets = buildOutlets(rng.fork('outlets'), longAgo);

  const creatives: Creative[] = [];
  const campaigns: Campaign[] = [];
  for (const spec of CAMPAIGN_SPECS) {
    const createdAt = isoMinute(addMinutes(dayStart, (spec.days[0] - 7) * 1440));
    const creative: Creative = {
      id: `cr-${spec.id}-a`,
      advertiserId: spec.advertiserId,
      name: `${spec.name} – A`,
      template: spec.creative.template,
      artwork: spec.creative.artwork,
      palette: spec.creative.palette,
      content: spec.creative.content,
      formats: ['16:9', '9:16'],
      status: spec.status === 'pending_review' ? 'pending_review' : 'approved',
      brandSafety: {
        noRealBrandMarks: true,
        claimsVerified: spec.status !== 'pending_review',
        ageAppropriate: true,
        legibleAtDistance: true,
      },
      createdAt,
    };
    creatives.push(creative);
    const creativeIds = [creative.id];
    if (spec.variantB) {
      creatives.push({
        ...creative,
        id: `cr-${spec.id}-b`,
        name: `${spec.name} – B`,
        content: spec.variantB,
      });
      creativeIds.push(`cr-${spec.id}-b`);
    }
    campaigns.push({
      id: spec.id,
      advertiserId: spec.advertiserId,
      name: spec.name,
      objective: spec.objective,
      status: spec.status,
      creativeIds,
      segmentWeights: spec.weights,
      hardFilters: {
        market: spec.market ?? null,
        destinationRegions: spec.regions ?? [],
        destinations: spec.destinations ?? [],
        minDwellMinutes: spec.minDwell ?? null,
        minCrowd: spec.minCrowd ?? null,
      },
      placement: {
        zoneIds: spec.zones,
        screenIds: [],
        gateIds: [],
        schedule: {
          start: isoMinute(addMinutes(dayStart, spec.days[0] * 1440)),
          end: isoMinute(addMinutes(dayStart, spec.days[1] * 1440 - 1)),
          daysOfWeek: [],
          hours: spec.hours ?? null,
        },
      },
      budget: {
        total: spec.budget.total,
        dailyCap: spec.budget.dailyCap,
        cpm: spec.budget.cpm,
        frequencyCapPerScreenHour: spec.budget.cap,
      },
      triggers: spec.triggers ?? [],
      promo: spec.promo ?? null,
      airlinePriority: spec.airlinePriority ?? false,
      coFundedBy: spec.coFundedBy ?? null,
      competitorGroup: spec.competitorGroup ?? null,
      performanceIndex: spec.performance,
      createdAt,
      updatedAt: createdAt,
    });
  }

  const historyRng = rng.fork('history');
  const history = campaigns.flatMap((c) =>
    buildHistory(c, outlets, simDate, utcOffsetMinutes, historyRng.fork(c.id)),
  );
  return { advertisers, outlets, screens, creatives, campaigns, history };
}
