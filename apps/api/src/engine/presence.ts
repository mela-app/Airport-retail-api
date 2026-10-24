/**
 * Passenger presence: who is where, from flight data (AODB/AIDX) and queue data (ACRIS).
 *
 * The model follows a departing passenger through the terminal by "time to boarding" (TTB):
 *
 *   check-in hall ──► security / passport queue ──► airside plaza (shops, F&B) ──► gate area ──► boarding
 *
 * - Landside: from TTB 200 (international) / 150 (domestic) minutes.
 * - Airside: through security by TTB 100 / 80 minutes (ramping in over the previous 50 / 30 minutes).
 * - Gate area: passengers drift to their gate in the last hour: 0 at TTB 120, all of them from TTB 60 until
 *   boarding starts, then leaving linearly until the gate closes (ETD − 10 min).
 * - Arrivals hall: arriving passengers for 30 minutes after on-block, gone by 45 minutes.
 *
 * Boarding starts 40 (wide-body) / 30 (narrow-body) minutes before the estimated departure. A screen next to
 * gates sees each gate's passengers fully within 80 m, fading to none at 140 m. Screens elsewhere see a share
 * of their zone's crowd. Security and passport-control zones use the measured ACRIS queue occupancy.
 *
 * Everything is a pure function of flights, profiles, queue measurements and time, so the same code serves
 * live screens, the 2-hour footfall forecast and inventory pricing.
 */
import {
  CHECKPOINTS,
  type CrowdProfile,
  type Flight,
  type Gate,
  type QueueMeasurement,
  type Screen,
  type Zone,
  aircraftTypeByIcao,
  delayMinutes,
  destinationByIata,
  distance,
} from '@arm/domain';

import { Layout, type LayoutGate } from './layout.js';
import { type WeightedProfile, blendProfiles, weightedMedian } from './profile-math.js';

/** The seeded floor plan, for callers that do not pass the layout in use. */
const DEFAULT_LAYOUT = Layout.default();

export const PRESENCE_MODEL = {
  version: 'presence-v1',
  boardingLeadWideMin: 40,
  boardingLeadNarrowMin: 30,
  gateCloseBeforeEtdMin: 10,
  gateArrivalStartMin: 120,
  gateArrivalFullMin: 60,
  proximityFullM: 80,
  proximityZeroM: 140,
  landsideStartMin: { international: 200, domestic: 150 },
  airsideStartMin: { international: 150, domestic: 110 },
  airsideFullMin: { international: 100, domestic: 80 },
  arrivalsFullMin: 30,
  arrivalsGoneMin: 45,
  /**
   * Screens outside gate areas: each sees `viewShare × zoneScreenCoverage / screens in the zone` of its
   * zone's crowd (e.g. a totem in a 10-screen hall sees 15% of the hall).
   */
  zoneViewShare: { video_wall: 0.35, totem: 0.15, fids_ad_panel: 0.2, gate_display: 0.2 },
  zoneScreenCoverage: 10,
} as const;

const MIN = 60_000;

/**
 * A departure no longer has passengers in the terminal at `at`: it is cancelled, or it had already left (off
 * block) by then. Judging by the time, not just the current status, keeps past hours right in forecasts and
 * heat maps after the flight has departed.
 */
function goneAt(f: Flight, at: Date): boolean {
  if (f.status === 'cancelled') return true;
  if (f.status !== 'departed') return false;
  const left = Date.parse(f.actualBlockTime ?? f.actualRunwayTime ?? f.estimatedTime ?? f.scheduledTime);
  return at.getTime() >= left;
}

/** Linear ramp: 0 at `zeroAt`, 1 at `fullAt` (works in both directions), clamped to [0, 1]. */
function ramp(x: number, zeroAt: number, fullAt: number): number {
  if (zeroAt === fullAt) return x >= fullAt ? 1 : 0;
  return Math.min(1, Math.max(0, (x - zeroAt) / (fullAt - zeroAt)));
}

export interface DepartureTiming {
  etd: number;
  boardingAt: number;
  gateCloseAt: number;
}

export function departureTiming(f: Flight): DepartureTiming {
  const etd = Date.parse(f.estimatedTime ?? f.scheduledTime);
  const wide = aircraftTypeByIcao(f.aircraftTypeIcao)?.wideBody ?? false;
  const lead = wide ? PRESENCE_MODEL.boardingLeadWideMin : PRESENCE_MODEL.boardingLeadNarrowMin;
  return { etd, boardingAt: etd - lead * MIN, gateCloseAt: etd - PRESENCE_MODEL.gateCloseBeforeEtdMin * MIN };
}

/** Minutes until boarding starts (negative once boarding has started). */
export function timeToBoardingMin(f: Flight, at: Date): number {
  return (departureTiming(f).boardingAt - at.getTime()) / MIN;
}

/** Share of a departing flight's passengers in its gate area. */
export function gateAreaWeight(f: Flight, at: Date): number {
  if (f.direction !== 'D' || goneAt(f, at)) return 0;
  const { boardingAt, gateCloseAt } = departureTiming(f);
  const t = at.getTime();
  if (t >= gateCloseAt) return 0;
  if (t >= boardingAt) return 1 - ramp(t, boardingAt, gateCloseAt);
  const ttb = (boardingAt - t) / MIN;
  return ramp(ttb, PRESENCE_MODEL.gateArrivalStartMin, PRESENCE_MODEL.gateArrivalFullMin);
}

/** Share of a departing flight's passengers that are airside (through security). */
export function airsideWeight(f: Flight, at: Date): number {
  if (f.direction !== 'D' || goneAt(f, at)) return 0;
  const { gateCloseAt } = departureTiming(f);
  if (at.getTime() >= gateCloseAt) return 0;
  const ttb = timeToBoardingMin(f, at);
  const intl = f.nature === 'international';
  const { airsideStartMin: start, airsideFullMin: full } = PRESENCE_MODEL;
  return ramp(ttb, intl ? start.international : start.domestic, intl ? full.international : full.domestic);
}

/** Share of a departing flight's passengers that are in the terminal (landside or airside). */
export function inTerminalWeight(f: Flight, at: Date): number {
  if (f.direction !== 'D' || goneAt(f, at)) return 0;
  const { gateCloseAt } = departureTiming(f);
  if (at.getTime() >= gateCloseAt) return 0;
  const ttb = timeToBoardingMin(f, at);
  const { landsideStartMin } = PRESENCE_MODEL;
  const start = f.nature === 'international' ? landsideStartMin.international : landsideStartMin.domestic;
  return ramp(ttb, start, start - 40);
}

/** Share of an arriving flight's passengers in the arrivals hall. */
export function arrivalsWeight(f: Flight, at: Date): number {
  if (f.direction !== 'A' || f.status === 'cancelled') return 0;
  const onBlock = Date.parse(f.actualBlockTime ?? f.estimatedTime ?? f.scheduledTime);
  const since = (at.getTime() - onBlock) / MIN;
  if (since < 0) return 0;
  return since <= PRESENCE_MODEL.arrivalsFullMin
    ? 1
    : 1 - ramp(since, PRESENCE_MODEL.arrivalsFullMin, PRESENCE_MODEL.arrivalsGoneMin);
}

export function proximityWeight(distanceM: number): number {
  return 1 - ramp(distanceM, PRESENCE_MODEL.proximityFullM, PRESENCE_MODEL.proximityZeroM);
}

export function flightGate(f: Flight, layout: Layout = DEFAULT_LAYOUT): Gate | undefined {
  return layout.gateOf(f.terminal, f.gate);
}

/** One flight's part of a crowd estimate. */
export interface CrowdContributor {
  flightId: string;
  airlineIata: string;
  flightNumber: string;
  direction: 'A' | 'D';
  destination: string;
  region: string;
  market: 'domestic' | 'international';
  gateId: string | null;
  status: Flight['status'];
  /** Flight passengers (latest count). */
  flightPax: number;
  /** Presence weight in [0, 1] (time × proximity, or zone share). */
  weight: number;
  /** Passengers of this flight in the crowd. */
  pax: number;
  /** Minutes until boarding starts (departures), 0 when boarding or for arrivals. */
  dwellMin: number;
  delayMin: number;
  boardingAt: string | null;
  gateCloseAt: string | null;
}

export interface CrowdEstimate {
  at: string;
  /** Passengers in front of the screen / in the zone. */
  pax: number;
  profile: CrowdProfile;
  medianDwellMin: number | null;
  maxDelayMin: number;
  contributors: CrowdContributor[];
  /** Shares of the crowd by destination region, destination airport and airline. */
  regionShares: Record<string, number>;
  destinationShares: Record<string, number>;
  airlineShares: Record<string, number>;
  /** ACRIS queue measurements used (security / passport zones), if any. */
  queues: QueueMeasurement[];
}

export interface PresenceInputs {
  flights: readonly Flight[];
  profiles: ReadonlyMap<string, CrowdProfile>;
  queues: ReadonlyMap<string, QueueMeasurement>;
  /** The layout in use (default: the seeded floor plan). */
  layout?: Layout;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

function contributor(f: Flight, weight: number, at: Date, layout: Layout): CrowdContributor {
  const other = f.direction === 'D' ? f.destination : f.origin;
  const dest = destinationByIata(other);
  const timing = f.direction === 'D' ? departureTiming(f) : null;
  const flightPax = f.pax ?? Math.round(f.seats * 0.8);
  return {
    flightId: f.id,
    airlineIata: f.airlineIata,
    flightNumber: f.flightNumber,
    direction: f.direction,
    destination: other,
    region: dest?.region ?? 'unknown',
    market: f.nature,
    gateId: flightGate(f, layout)?.id ?? null,
    status: f.status,
    flightPax,
    weight: round(weight),
    pax: round(flightPax * weight, 2),
    dwellMin: timing ? Math.max(0, Math.round((timing.boardingAt - at.getTime()) / MIN)) : 0,
    delayMin: delayMinutes(f),
    boardingAt: timing ? new Date(timing.boardingAt).toISOString() : null,
    gateCloseAt: timing ? new Date(timing.gateCloseAt).toISOString() : null,
  };
}

function shares(
  contributors: readonly CrowdContributor[],
  key: (c: CrowdContributor) => string,
): Record<string, number> {
  const total = contributors.reduce((s, c) => s + c.pax, 0);
  const sums = new Map<string, number>();
  for (const c of contributors) sums.set(key(c), (sums.get(key(c)) ?? 0) + c.pax);
  return Object.fromEntries([...sums].map(([k, v]) => [k, total > 0 ? round(v / total) : 0]));
}

/** Build an estimate from weighted flights (`scale` multiplies every weight, e.g. a screen's view share). */
function estimate(
  at: Date,
  weighted: readonly { flight: Flight; weight: number }[],
  inputs: PresenceInputs,
  scale = 1,
  queues: QueueMeasurement[] = [],
  paxOverride: number | null = null,
): CrowdEstimate {
  const contributors = weighted
    .filter((w) => w.weight > 0)
    .map((w) => contributor(w.flight, w.weight * scale, at, inputs.layout ?? DEFAULT_LAYOUT))
    .filter((c) => c.pax > 0)
    .sort((a, b) => b.pax - a.pax);
  const parts: WeightedProfile[] = [];
  for (const c of contributors) {
    const profile = inputs.profiles.get(c.flightId);
    if (profile) parts.push({ profile, pax: c.pax });
  }
  const profile = blendProfiles(parts);
  const pax = paxOverride ?? contributors.reduce((s, c) => s + c.pax, 0);
  return {
    at: at.toISOString(),
    pax: round(pax, 1),
    profile: { ...profile, pax: round(pax, 1) },
    medianDwellMin: weightedMedian(contributors.map((c) => ({ value: c.dwellMin, weight: c.pax }))),
    maxDelayMin: contributors.reduce((m, c) => Math.max(m, c.delayMin), 0),
    contributors,
    regionShares: shares(contributors, (c) => c.region),
    destinationShares: shares(contributors, (c) => c.destination),
    airlineShares: shares(contributors, (c) => c.airlineIata),
    queues,
  };
}

/** Presence weight of a flight in a zone. */
export function zoneWeight(f: Flight, zone: Zone, at: Date, layout: Layout = DEFAULT_LAYOUT): number {
  if (f.terminal !== zone.terminalId) return 0;
  switch (zone.kind) {
    case 'pier':
    case 'bus_lounge': {
      const gate = flightGate(f, layout);
      return gate && gate.zoneId === zone.id ? gateAreaWeight(f, at) : 0;
    }
    case 'airside_plaza':
      return Math.max(0, airsideWeight(f, at) - gateAreaWeight(f, at));
    case 'landside_hall':
    case 'security':
      return Math.max(0, inTerminalWeight(f, at) - airsideWeight(f, at));
    case 'passport_control':
      return f.nature === 'international' ? Math.max(0, inTerminalWeight(f, at) - airsideWeight(f, at)) : 0;
    case 'arrivals_hall':
      return arrivalsWeight(f, at);
    default:
      return 0;
  }
}

function queuesOfZone(zone: Zone, inputs: PresenceInputs): QueueMeasurement[] {
  const checkpointIds = new Set(CHECKPOINTS.filter((c) => c.zoneId === zone.id).map((c) => c.id));
  return [...inputs.queues.values()].filter((q) => checkpointIds.has(q.checkpointId));
}

/** ZonePresence: passengers and crowd profile of a zone at `at`. */
export function zonePresence(zone: Zone, inputs: PresenceInputs, at: Date): CrowdEstimate {
  const weighted = inputs.flights.map((flight) => ({
    flight,
    weight: zoneWeight(flight, zone, at, inputs.layout ?? DEFAULT_LAYOUT),
  }));
  if (zone.kind === 'security' || zone.kind === 'passport_control') {
    // Queues: the measured ACRIS occupancy is the crowd; its profile is that of the passengers on their way in.
    const queues = queuesOfZone(zone, inputs);
    const occupancy = queues.reduce((s, q) => s + q.occupancy, 0);
    return estimate(at, weighted, inputs, 1, queues, occupancy);
  }
  return estimate(at, weighted, inputs);
}

/** Presence of every zone at `at`. */
export function allZonePresence(inputs: PresenceInputs, at: Date): Map<string, CrowdEstimate> {
  const layout = inputs.layout ?? DEFAULT_LAYOUT;
  return new Map(layout.zones.map((z) => [z.id, zonePresence(z, inputs, at)]));
}

/** The crowd in front of a screen at `at`. */
export function screenCrowd(
  screen: Screen,
  inputs: PresenceInputs,
  at: Date,
  screensInZone: number,
  /** Zone presence already computed for `at` (the decision engine computes it once per window). */
  zoneEstimates?: ReadonlyMap<string, CrowdEstimate>,
): CrowdEstimate {
  const layout = inputs.layout ?? DEFAULT_LAYOUT;
  const zone = layout.zone(screen.zoneId);
  if (!zone) return estimate(at, [], inputs);
  if ((zone.kind === 'pier' || zone.kind === 'bus_lounge') && screen.nearestGateIds.length > 0) {
    const gates = new Map(
      screen.nearestGateIds
        .map((id) => layout.gate(id))
        // Only gates in the screen's own room (a pier screen cannot be seen from the bus lounge).
        .filter((g): g is LayoutGate => g !== undefined && g.zoneId === screen.zoneId)
        .map((g) => [g.id, proximityWeight(distance(g.position, screen.position))]),
    );
    const weighted = inputs.flights.map((flight) => {
      const gate = flightGate(flight, layout);
      const proximity = gate ? (gates.get(gate.id) ?? 0) : 0;
      return { flight, weight: proximity > 0 ? proximity * gateAreaWeight(flight, at) : 0 };
    });
    return estimate(at, weighted, inputs);
  }
  // Elsewhere a screen sees a share of its zone's crowd: same profile, scaled passenger counts.
  const zoneEstimate = zoneEstimates?.get(zone.id) ?? zonePresence(zone, inputs, at);
  const viewShare = new Map(Object.entries(PRESENCE_MODEL.zoneViewShare)).get(screen.kind) ?? 0.15;
  const share = Math.min(1, (viewShare * PRESENCE_MODEL.zoneScreenCoverage) / Math.max(1, screensInZone));
  return scaleEstimate(zoneEstimate, share);
}

/** The same crowd, with every passenger count multiplied by `share` (shares and dwell are unchanged). */
export function scaleEstimate(e: CrowdEstimate, share: number): CrowdEstimate {
  const pax = round(e.pax * share, 1);
  return {
    ...e,
    pax,
    profile: { ...e.profile, pax },
    contributors: e.contributors.map((c) => ({
      ...c,
      weight: round(c.weight * share),
      pax: round(c.pax * share, 2),
    })),
  };
}
