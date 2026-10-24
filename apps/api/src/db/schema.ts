/**
 * Database schema (PostgreSQL). Migrations are plain SQL in `apps/api/migrations/`; a test checks that the
 * migrated database matches these table definitions column by column.
 *
 * Time columns hold simulation time (timestamptz). JSON columns hold structured values whose shape is the
 * canonical zod schema in @arm/domain (validated on write).
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---- airport space (ACRIS) ------------------------------------------------------------------------------

export const terminals = pgTable('terminals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mainMarket: text('main_market').notNull(),
  outline: jsonb('outline').notNull(),
});

export const concourses = pgTable('concourses', {
  id: text('id').primaryKey(),
  terminalId: text('terminal_id')
    .notNull()
    .references(() => terminals.id),
  name: text('name').notNull(),
});

export const zones = pgTable('zones', {
  id: text('id').primaryKey(),
  terminalId: text('terminal_id')
    .notNull()
    .references(() => terminals.id),
  concourseId: text('concourse_id').references(() => concourses.id),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  side: text('side').notNull(),
  area: jsonb('area').notNull(),
});

export const gates = pgTable('gates', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  terminalId: text('terminal_id')
    .notNull()
    .references(() => terminals.id),
  concourseId: text('concourse_id').references(() => concourses.id),
  zoneId: text('zone_id')
    .notNull()
    .references(() => zones.id),
  remote: boolean('remote').notNull(),
  position: jsonb('position').notNull(),
  active: boolean('active').notNull().default(true),
});

export const checkpoints = pgTable('checkpoints', {
  id: text('id').primaryKey(),
  terminalId: text('terminal_id')
    .notNull()
    .references(() => terminals.id),
  zoneId: text('zone_id')
    .notNull()
    .references(() => zones.id),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  lanes: integer('lanes').notNull(),
  position: jsonb('position').notNull(),
});

export const passengerQueues = pgTable('passenger_queues', {
  id: text('id').primaryKey(),
  checkpointId: text('checkpoint_id')
    .notNull()
    .references(() => checkpoints.id),
  name: text('name').notNull(),
  queueType: text('queue_type').notNull(),
});

// ---- reference data -------------------------------------------------------------------------------------

export const airlines = pgTable('airlines', {
  iata: text('iata').primaryKey(),
  icao: text('icao').notNull(),
  name: text('name').notNull(),
  model: text('model').notNull(),
  market: text('market').notNull(),
  brandColor: text('brand_color').notNull(),
  active: boolean('active').notNull().default(true),
});

export const aircraftTypes = pgTable('aircraft_types', {
  icao: text('icao').primaryKey(),
  name: text('name').notNull(),
  wideBody: boolean('wide_body').notNull(),
  cabins: jsonb('cabins').notNull(),
});

export const destinations = pgTable('destinations', {
  iata: text('iata').primaryKey(),
  city: text('city').notNull(),
  country: text('country').notNull(),
  nationality: text('nationality').notNull(),
  language: text('language').notNull(),
  market: text('market').notNull(),
  region: text('region').notNull(),
  character: text('character').notNull(),
  blockMinutes: integer('block_minutes').notNull(),
});

// ---- parties and inventory ------------------------------------------------------------------------------

export const advertisers = pgTable('advertisers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  category: text('category').notNull(),
  competitorGroup: text('competitor_group'),
  airlineIata: text('airline_iata').references(() => airlines.iata),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  brandColor: text('brand_color').notNull(),
  onboardedAt: ts('onboarded_at').notNull(),
  active: boolean('active').notNull().default(true),
});

export const outlets = pgTable('outlets', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id')
    .notNull()
    .references(() => advertisers.id),
  name: text('name').notNull(),
  category: text('category').notNull(),
  terminalId: text('terminal_id')
    .notNull()
    .references(() => terminals.id),
  zoneId: text('zone_id')
    .notNull()
    .references(() => zones.id),
  position: jsonb('position').notNull(),
  averageBasket: doublePrecision('average_basket').notNull(),
  openedAt: ts('opened_at').notNull(),
  active: boolean('active').notNull().default(true),
});

export const screens = pgTable(
  'screens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    terminalId: text('terminal_id')
      .notNull()
      .references(() => terminals.id),
    zoneId: text('zone_id')
      .notNull()
      .references(() => zones.id),
    position: jsonb('position').notNull(),
    kind: text('kind').notNull(),
    orientation: text('orientation').notNull(),
    sizeInches: integer('size_inches').notNull(),
    resolution: text('resolution').notNull(),
    nearestGateIds: jsonb('nearest_gate_ids').notNull(),
    basePricePerSlot: doublePrecision('base_price_per_slot').notNull(),
    status: text('status').notNull(),
    statusSince: ts('status_since'),
    lastHeartbeat: ts('last_heartbeat'),
    latencyMs: integer('latency_ms'),
    installedAt: ts('installed_at').notNull(),
  },
  (t) => [index('screens_zone_idx').on(t.zoneId)],
);

export const creatives = pgTable('creatives', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id')
    .notNull()
    .references(() => advertisers.id),
  name: text('name').notNull(),
  template: text('template').notNull(),
  artwork: text('artwork').notNull(),
  palette: jsonb('palette').notNull(),
  content: jsonb('content').notNull(),
  formats: jsonb('formats').notNull(),
  status: text('status').notNull(),
  brandSafety: jsonb('brand_safety').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const campaigns = pgTable('campaigns', {
  id: text('id').primaryKey(),
  advertiserId: text('advertiser_id')
    .notNull()
    .references(() => advertisers.id),
  name: text('name').notNull(),
  objective: text('objective').notNull(),
  status: text('status').notNull(),
  creativeIds: jsonb('creative_ids').notNull(),
  segmentWeights: jsonb('segment_weights').notNull(),
  hardFilters: jsonb('hard_filters').notNull(),
  placement: jsonb('placement').notNull(),
  budget: jsonb('budget').notNull(),
  triggers: jsonb('triggers').notNull(),
  promo: jsonb('promo'),
  airlinePriority: boolean('airline_priority').notNull(),
  coFundedBy: text('co_funded_by').references(() => advertisers.id),
  competitorGroup: text('competitor_group'),
  performanceIndex: doublePrecision('performance_index').notNull(),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const campaignDailyStats = pgTable(
  'campaign_daily_stats',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    date: text('date').notNull(),
    plays: integer('plays').notNull(),
    impressions: integer('impressions').notNull(),
    scans: integer('scans').notNull(),
    redemptions: integer('redemptions').notNull(),
    spend: doublePrecision('spend').notNull(),
    revenue: doublePrecision('revenue').notNull(),
    redemptionsBySegment: jsonb('redemptions_by_segment').notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.date] })],
);

// ---- flights (canonical, maintained by the AODB / AIDX adapters) ----------------------------------------

export const flights = pgTable(
  'flights',
  {
    id: text('id').primaryKey(),
    sourceFlightId: text('source_flight_id'),
    linkedFlightId: text('linked_flight_id'),
    direction: text('direction').notNull(),
    airlineIata: text('airline_iata').notNull(),
    airlineIcao: text('airline_icao').notNull(),
    flightNumber: text('flight_number').notNull(),
    callsign: text('callsign'),
    serviceType: text('service_type').notNull(),
    nature: text('nature').notNull(),
    origin: text('origin').notNull(),
    destination: text('destination').notNull(),
    via: jsonb('via').notNull(),
    terminal: text('terminal').notNull(),
    scheduledTime: ts('scheduled_time').notNull(),
    estimatedTime: ts('estimated_time'),
    estimatedRunwayTime: ts('estimated_runway_time'),
    actualRunwayTime: ts('actual_runway_time'),
    actualBlockTime: ts('actual_block_time'),
    tobt: ts('tobt'),
    tsat: ts('tsat'),
    stand: text('stand'),
    gate: text('gate'),
    checkinCounters: text('checkin_counters'),
    baggageBelt: text('baggage_belt'),
    aircraftRegistration: text('aircraft_registration'),
    aircraftTypeIcao: text('aircraft_type_icao').notNull(),
    seats: integer('seats').notNull(),
    pax: integer('pax'),
    status: text('status').notNull(),
    delayCodes: jsonb('delay_codes').notNull(),
    codeshares: jsonb('codeshares').notNull(),
    handler: text('handler'),
    lastUpdate: ts('last_update').notNull(),
    source: jsonb('source').notNull(),
  },
  (t) => [
    index('flights_scheduled_idx').on(t.scheduledTime),
    index('flights_gate_idx').on(t.terminal, t.gate),
  ],
);

export const flightEvents = pgTable(
  'flight_events',
  {
    id: text('id').primaryKey(),
    flightId: text('flight_id').notNull(),
    type: text('type').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    changes: jsonb('changes').notNull(),
    sequence: integer('sequence'),
    source: jsonb('source').notNull(),
  },
  (t) => [index('flight_events_flight_idx').on(t.flightId), index('flight_events_time_idx').on(t.occurredAt)],
);

/** Aggregated audience profile per flight (from the audience-profile source; never per passenger). */
export const crowdProfiles = pgTable('crowd_profiles', {
  flightId: text('flight_id').primaryKey(),
  profile: jsonb('profile').notNull(),
  source: text('source').notNull(),
  observedAt: ts('observed_at').notNull(),
});

// ---- ACRIS measurements and derived presence ------------------------------------------------------------

export const queueMeasurements = pgTable(
  'queue_measurements',
  {
    id: text('id').primaryKey(),
    queueId: text('queue_id').notNull(),
    checkpointId: text('checkpoint_id').notNull(),
    measuredAt: ts('measured_at').notNull(),
    occupancy: integer('occupancy').notNull(),
    waitTimeSec: integer('wait_time_sec').notNull(),
    projectedWaitTimeSec: integer('projected_wait_time_sec').notNull(),
    throughputPerHour: integer('throughput_per_hour').notNull(),
  },
  (t) => [index('queue_measurements_time_idx').on(t.measuredAt)],
);

/** ZonePresence: estimated passengers and crowd profile per zone per 5-minute window. */
export const zonePresence = pgTable(
  'zone_presence',
  {
    zoneId: text('zone_id').notNull(),
    windowStart: ts('window_start').notNull(),
    pax: doublePrecision('pax').notNull(),
    profile: jsonb('profile').notNull(),
    computedAt: ts('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.windowStart] })],
);

// ---- delivery, outcomes and operations ------------------------------------------------------------------

/** Every ad decision with its full evidence trail. */
/**
 * The inputs of a screen's decisions: crowd, profile, evidence, candidate scores and AI verification. Stored
 * once per change of the screen's inputs, and shared by the decision runs that used it.
 */
export const decisionContexts = pgTable(
  'decision_contexts',
  {
    id: text('id').primaryKey(),
    screenId: text('screen_id').notNull(),
    computedAt: ts('computed_at').notNull(),
    windowStart: ts('window_start').notNull(),
    crowd: jsonb('crowd').notNull(),
    profile: jsonb('profile').notNull(),
    evidence: jsonb('evidence').notNull(),
    candidates: jsonb('candidates').notNull(),
    ai: jsonb('ai').notNull(),
  },
  (t) => [index('decision_contexts_screen_time_idx').on(t.screenId, t.computedAt)],
);

/** One run of consecutive slots on a screen playing the same campaign from the same context. */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    screenId: text('screen_id').notNull(),
    slotStart: ts('slot_start').notNull(),
    decidedAt: ts('decided_at').notNull(),
    mode: text('mode').notNull(),
    campaignId: text('campaign_id'),
    creativeId: text('creative_id'),
    score: doublePrecision('score'),
    checks: jsonb('checks').notNull(),
    reason: text('reason').notNull(),
    contextId: text('context_id').notNull(),
    slotEnd: ts('slot_end').notNull(),
    slots: integer('slots').notNull(),
    rules: jsonb('rules').notNull(),
  },
  (t) => [
    index('decisions_screen_slot_idx').on(t.screenId, t.slotStart),
    index('decisions_campaign_idx').on(t.campaignId),
    index('decisions_context_idx').on(t.contextId),
  ],
);

export const impressions = pgTable(
  'impressions',
  {
    id: text('id').primaryKey(),
    decisionId: text('decision_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    creativeId: text('creative_id').notNull(),
    screenId: text('screen_id').notNull(),
    playedAt: ts('played_at').notNull(),
    durationSec: doublePrecision('duration_sec').notNull(),
    estimatedViewers: doublePrecision('estimated_viewers').notNull(),
    cost: doublePrecision('cost').notNull(),
    /** Plays aggregated into this row (one row per screen, campaign, creative and 5-minute window). */
    plays: integer('plays').notNull(),
    windowStart: ts('window_start').notNull(),
    /** QR scans of plays in this row. */
    scans: integer('scans').notNull().default(0),
  },
  (t) => [
    index('impressions_campaign_time_idx').on(t.campaignId, t.playedAt),
    uniqueIndex('impressions_window_uidx').on(t.screenId, t.campaignId, t.creativeId, t.windowStart),
  ],
);

/** Learning: outcome counters per campaign and audience segment. */
export const campaignSegmentStats = pgTable(
  'campaign_segment_stats',
  {
    campaignId: text('campaign_id').notNull(),
    segment: text('segment').notNull(),
    viewers: doublePrecision('viewers').notNull(),
    scans: integer('scans').notNull(),
    redemptions: integer('redemptions').notNull(),
    revenue: doublePrecision('revenue').notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.segment] })],
);

/** Trained versions of the segment/performance model. */
export const modelVersions = pgTable(
  'model_versions',
  {
    version: text('version').primaryKey(),
    trainedAt: ts('trained_at').notNull(),
    performance: jsonb('performance').notNull(),
    segmentRates: jsonb('segment_rates').notNull(),
    notes: text('notes').notNull(),
  },
  (t) => [index('model_versions_time_idx').on(t.trainedAt)],
);

/** Media Manager pins: play a campaign on a screen for a period, with a reason. */
export const manualPins = pgTable(
  'manual_pins',
  {
    id: text('id').primaryKey(),
    screenId: text('screen_id').notNull(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('manual_pins_screen_idx').on(t.screenId, t.startsAt)],
);

export const promoCodes = pgTable('promo_codes', {
  code: text('code').primaryKey(),
  campaignId: text('campaign_id').notNull(),
  screenId: text('screen_id').notNull(),
  flightId: text('flight_id'),
  parentCode: text('parent_code'),
  issuedAt: ts('issued_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  status: text('status').notNull(),
  claimedAt: ts('claimed_at'),
});

/** Claim links behind the QR codes on screens (and family share links). */
export const claimLinks = pgTable(
  'claim_links',
  {
    token: text('token').primaryKey(),
    screenId: text('screen_id').notNull(),
    campaignId: text('campaign_id').notNull(),
    creativeId: text('creative_id'),
    decisionId: text('decision_id'),
    flightId: text('flight_id'),
    outletId: text('outlet_id'),
    segment: text('segment'),
    parentCode: text('parent_code'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    opens: integer('opens').notNull().default(0),
    claims: integer('claims').notNull().default(0),
  },
  (t) => [
    index('claim_links_screen_idx').on(t.screenId, t.createdAt),
    index('claim_links_parent_idx').on(t.parentCode),
  ],
);

export const redemptions = pgTable(
  'redemptions',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    campaignId: text('campaign_id').notNull(),
    outletId: text('outlet_id'),
    screenId: text('screen_id').notNull(),
    redeemedAt: ts('redeemed_at').notNull(),
    revenue: doublePrecision('revenue').notNull(),
    segment: text('segment'),
  },
  (t) => [index('redemptions_campaign_time_idx').on(t.campaignId, t.redeemedAt)],
);

export const incidents = pgTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    subject: text('subject').notNull(),
    owner: text('owner'),
    status: text('status').notNull(),
    raisedAt: ts('raised_at').notNull(),
    resolvedAt: ts('resolved_at'),
    details: jsonb('details').notNull(),
  },
  (t) => [index('incidents_status_idx').on(t.status)],
);

/** Rule-engine settings and other runtime configuration (one JSON value per key). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const ALL_TABLES = {
  terminals,
  concourses,
  zones,
  gates,
  checkpoints,
  passengerQueues,
  airlines,
  aircraftTypes,
  destinations,
  advertisers,
  outlets,
  screens,
  creatives,
  campaigns,
  campaignDailyStats,
  flights,
  flightEvents,
  crowdProfiles,
  queueMeasurements,
  zonePresence,
  decisionContexts,
  decisions,
  impressions,
  campaignSegmentStats,
  modelVersions,
  manualPins,
  promoCodes,
  claimLinks,
  redemptions,
  incidents,
  settings,
} as const;
