/**
 * Platform-owned entities (no industry standard): screens, advertisers, outlets, campaigns, creatives,
 * promo codes, impressions and redemptions.
 */
import { z } from 'zod';

import { isSegmentKey } from './audience.js';
import { PointSchema } from './space.js';

const instant = z.iso.datetime({ offset: true });
const money = z.number().min(0);

// ---- inventory ------------------------------------------------------------------------------------------

export const ScreenStatusSchema = z.enum(['online', 'degraded', 'offline']);
export type ScreenStatus = z.infer<typeof ScreenStatusSchema>;

export const ScreenSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  terminalId: z.string(),
  zoneId: z.string(),
  position: PointSchema,
  kind: z.enum(['gate_display', 'totem', 'video_wall', 'fids_ad_panel']),
  orientation: z.enum(['landscape', 'portrait']),
  sizeInches: z.number().int().positive(),
  resolution: z.string(),
  /** Gates whose passengers can see the screen, nearest first. */
  nearestGateIds: z.array(z.string()),
  /** List price per 15-second slot at an average crowd (platform currency). */
  basePricePerSlot: money,
  status: ScreenStatusSchema,
  installedAt: instant,
});
export type Screen = z.infer<typeof ScreenSchema>;

// ---- parties --------------------------------------------------------------------------------------------

export const AdvertiserKindSchema = z.enum(['retailer', 'fnb', 'airline', 'brand', 'service']);
export type AdvertiserKind = z.infer<typeof AdvertiserKindSchema>;

export const AdvertiserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: AdvertiserKindSchema,
  category: z.string(),
  /** Campaigns of the same group are never played back to back on one screen (e.g. `perfume`). */
  competitorGroup: z.string().nullable(),
  /** For airline advertisers: the IATA code of the airline. */
  airlineIata: z.string().length(2).nullable(),
  contactName: z.string(),
  contactEmail: z.string(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  onboardedAt: instant,
});
export type Advertiser = z.infer<typeof AdvertiserSchema>;

export const OutletSchema = z.object({
  id: z.string().min(1),
  advertiserId: z.string(),
  name: z.string(),
  category: z.enum([
    'duty_free',
    'perfume_cosmetics',
    'fashion',
    'electronics',
    'toys',
    'books',
    'fnb_coffee',
    'fnb_dining',
    'fnb_sweets',
    'pharmacy',
    'lounge',
    'services',
  ]),
  terminalId: z.string(),
  zoneId: z.string(),
  position: PointSchema,
  /** Average basket value, used to attribute revenue to redemptions. */
  averageBasket: money,
  openedAt: instant,
});
export type Outlet = z.infer<typeof OutletSchema>;

// ---- campaigns ------------------------------------------------------------------------------------------

/** Segment weights: how much each segment matters to the campaign, 0–1 (e.g. `partyType.family: 1`). */
export const SegmentWeightsSchema = z
  .record(z.string(), z.number().min(0).max(1))
  .refine((weights) => Object.keys(weights).every(isSegmentKey), { message: 'unknown segment key' });
export type SegmentWeights = z.infer<typeof SegmentWeightsSchema>;

/** Conditions that must all hold for the campaign to be eligible on a screen in a slot. */
export const HardFiltersSchema = z.object({
  market: z.enum(['domestic', 'international']).nullable(),
  /** Destination regions (e.g. `gulf`); empty means any. */
  destinationRegions: z.array(z.string()),
  /** Destination airport codes; empty means any. */
  destinations: z.array(z.string().length(3)),
  /** Minimum median dwell time of the crowd, in minutes. */
  minDwellMinutes: z.number().min(0).nullable(),
  /** Minimum passengers in the screen's catchment. */
  minCrowd: z.number().min(0).nullable(),
});
export type HardFilters = z.infer<typeof HardFiltersSchema>;

export const ScheduleSchema = z.object({
  start: instant,
  end: instant,
  /** ISO weekdays 1 (Mon) – 7 (Sun); empty means every day. */
  daysOfWeek: z.array(z.number().int().min(1).max(7)),
  /** Local hours [from, to) the campaign may play; null means all day. */
  hours: z.object({ from: z.number().int().min(0).max(23), to: z.number().int().min(1).max(24) }).nullable(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const PlacementSchema = z.object({
  zoneIds: z.array(z.string()),
  screenIds: z.array(z.string()),
  gateIds: z.array(z.string()),
  schedule: ScheduleSchema,
});
export type Placement = z.infer<typeof PlacementSchema>;

export const BudgetSchema = z.object({
  total: money,
  dailyCap: money,
  /** Price paid per 1,000 estimated impressions. */
  cpm: money,
  /** Maximum plays per screen per hour. */
  frequencyCapPerScreenHour: z.number().int().min(1),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delay_over'),
    minutes: z.number().int().min(1),
    airlineIata: z.string().length(2).nullable(),
    destinations: z.array(z.string().length(3)),
    /** Score multiplier while the trigger is active. */
    boost: z.number().min(1).max(3),
  }),
  z.object({ type: z.literal('gate_change'), boost: z.number().min(1).max(3) }),
  z.object({ type: z.literal('boarding_starts'), boost: z.number().min(1).max(3) }),
  z.object({ type: z.literal('festival_day'), boost: z.number().min(1).max(3) }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const CampaignStatusSchema = z.enum([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'active',
  'paused',
  'completed',
]);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const PromoSettingsSchema = z.object({
  offerText: z.string(),
  codePrefix: z.string().regex(/^[A-Z0-9]{2,8}$/),
  /** `boarding_close`: valid until the linked flight's boarding closes; otherwise a fixed number of minutes. */
  validity: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('boarding_close') }),
    z.object({
      mode: z.literal('minutes'),
      minutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60),
    }),
  ]),
  shareable: z.boolean(),
  /** The outlet where the code is redeemed. */
  outletId: z.string().nullable(),
  /** Mock stock toggle: when false the promo is paused. */
  inStock: z.boolean(),
});
export type PromoSettings = z.infer<typeof PromoSettingsSchema>;

export const CampaignSchema = z.object({
  id: z.string().min(1),
  advertiserId: z.string(),
  name: z.string(),
  objective: z.enum(['awareness', 'footfall', 'conversion', 'goodwill']),
  status: CampaignStatusSchema,
  creativeIds: z.array(z.string()).min(1),
  segmentWeights: SegmentWeightsSchema,
  hardFilters: HardFiltersSchema,
  placement: PlacementSchema,
  budget: BudgetSchema,
  triggers: z.array(TriggerSchema),
  promo: PromoSettingsSchema.nullable(),
  /** Airline-owned gate messaging gets priority in that airline's own boarding windows. */
  airlinePriority: z.boolean(),
  /** For co-funded offers (e.g. a delay voucher paid by an airline and a café): the partner advertiser. */
  coFundedBy: z.string().nullable(),
  /** Campaigns of the same group never play back to back on one screen (e.g. two perfume campaigns). */
  competitorGroup: z.string().nullable(),
  /** Learned conversion performance index in [0, 1]; updated from scans and redemptions. */
  performanceIndex: z.number().min(0).max(1),
  createdAt: instant,
  updatedAt: instant,
});
export type Campaign = z.infer<typeof CampaignSchema>;

// ---- creatives ------------------------------------------------------------------------------------------

export const CreativeContentSchema = z.object({
  headline: z.string().max(80),
  body: z.string().max(240),
  cta: z.string().max(40),
  /** A short badge such as `15% OFF`. */
  badge: z.string().max(24).nullable(),
});
export type CreativeContent = z.infer<typeof CreativeContentSchema>;

export const CreativeSchema = z.object({
  id: z.string().min(1),
  advertiserId: z.string(),
  name: z.string(),
  template: z.enum(['offer_split', 'hero_full', 'gate_message', 'voucher', 'destination']),
  /** Built-in illustration key (no external images, so the demo works offline). */
  artwork: z.string(),
  palette: z.object({ background: z.string(), foreground: z.string(), accent: z.string() }),
  /** Content per language code (English is required; the second configured language is optional). */
  content: z
    .record(z.string(), CreativeContentSchema)
    .refine((c) => Object.hasOwn(c, 'en'), { message: 'English content is required' }),
  formats: z.array(z.enum(['16:9', '9:16'])).min(1),
  status: z.enum(['draft', 'pending_review', 'approved', 'rejected']),
  brandSafety: z.object({
    noRealBrandMarks: z.boolean(),
    claimsVerified: z.boolean(),
    ageAppropriate: z.boolean(),
    legibleAtDistance: z.boolean(),
  }),
  createdAt: instant,
});
export type Creative = z.infer<typeof CreativeSchema>;

// ---- delivery and outcomes ------------------------------------------------------------------------------

export const PromoCodeSchema = z.object({
  code: z.string().min(4),
  campaignId: z.string(),
  screenId: z.string(),
  /** The flight whose boarding window defines the expiry, if any. */
  flightId: z.string().nullable(),
  /** The code this one was shared from (family sharing), if any. */
  parentCode: z.string().nullable(),
  issuedAt: instant,
  expiresAt: instant,
  status: z.enum(['issued', 'claimed', 'redeemed', 'expired']),
});
export type PromoCode = z.infer<typeof PromoCodeSchema>;

export const ImpressionSchema = z.object({
  id: z.string().min(1),
  decisionId: z.string(),
  campaignId: z.string(),
  creativeId: z.string(),
  screenId: z.string(),
  playedAt: instant,
  durationSec: z.number().positive(),
  /** Estimated viewers during the play (aggregated, from the crowd estimate). */
  estimatedViewers: z.number().min(0),
  cost: money,
});
export type Impression = z.infer<typeof ImpressionSchema>;

export const RedemptionSchema = z.object({
  id: z.string().min(1),
  code: z.string(),
  campaignId: z.string(),
  outletId: z.string().nullable(),
  screenId: z.string(),
  redeemedAt: instant,
  /** Revenue attributed to the campaign (average basket of the outlet). */
  revenue: money,
  /** Dominant segment of the crowd when the code was issued (aggregate; never about the person). */
  segment: z.string().nullable(),
});
export type Redemption = z.infer<typeof RedemptionSchema>;
