/**
 * Canonical flight entities. Adapters translate source formats (an AODB snapshot, IATA AIDX messages, a
 * vendor API) into these shapes; the application core never sees a source format.
 * All instants are ISO 8601 strings in UTC.
 */
import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const optionalInstant = instant.nullable();

export const FlightDirectionSchema = z.enum(['A', 'D']);
export type FlightDirection = z.infer<typeof FlightDirectionSchema>;

export const FlightNatureSchema = z.enum(['domestic', 'international']);
export type FlightNature = z.infer<typeof FlightNatureSchema>;

/**
 * Operational status as the platform tracks it during the day. An end-of-day AODB snapshot only carries
 * ARR / DEP / CNL; the live statuses come from AIDX updates and the simulation clock.
 */
export const FlightStatusSchema = z.enum([
  'scheduled',
  'delayed',
  'boarding',
  'gate_closed',
  'departed',
  'approaching',
  'landed',
  'arrived',
  'cancelled',
]);
export type FlightStatus = z.infer<typeof FlightStatusSchema>;

/** Where a record came from, for the evidence trail. */
export const SourceRefSchema = z.object({
  source: z.enum(['aodb', 'aidx', 'acris', 'vendor-api', 'platform', 'simulation']),
  ref: z.string().min(1),
  receivedAt: instant,
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const FlightSchema = z.object({
  /** Canonical id: `<airline><number>-<D|A>-<YYYYMMDD>` of the scheduled date (UTC), e.g. `XH960-A-20261014`. */
  id: z.string().min(1),
  /** The source system's own key (the AODB `aodb_flight_id`). */
  sourceFlightId: z.string().nullable(),
  linkedFlightId: z.string().nullable(),
  direction: FlightDirectionSchema,
  airlineIata: z.string().length(2),
  airlineIcao: z.string().length(3),
  flightNumber: z.string().min(1).max(5),
  callsign: z.string().nullable(),
  serviceType: z.string().max(1),
  nature: FlightNatureSchema,
  origin: z.string().length(3),
  destination: z.string().length(3),
  via: z.array(z.string().length(3)),
  terminal: z.string().min(1),
  /** STA (arrival) or STD (departure). */
  scheduledTime: instant,
  /** ETA / ETD. */
  estimatedTime: optionalInstant,
  /** ELDT / ETOT. */
  estimatedRunwayTime: optionalInstant,
  /** ALDT / ATOT. */
  actualRunwayTime: optionalInstant,
  /** AIBT / AOBT. */
  actualBlockTime: optionalInstant,
  /** A-CDM target off-block time (departures). */
  tobt: optionalInstant,
  /** A-CDM target start-up approval time (departures). */
  tsat: optionalInstant,
  stand: z.string().nullable(),
  gate: z.string().nullable(),
  checkinCounters: z.string().nullable(),
  baggageBelt: z.string().nullable(),
  aircraftRegistration: z.string().nullable(),
  aircraftTypeIcao: z.string().min(2).max(4),
  seats: z.number().int().min(0),
  pax: z.number().int().min(0).nullable(),
  status: FlightStatusSchema,
  delayCodes: z.array(z.string()),
  codeshares: z.array(z.string()),
  handler: z.string().nullable(),
  lastUpdate: instant,
  source: SourceRefSchema,
});
export type Flight = z.infer<typeof FlightSchema>;

/** A flight's use of a gate. A gate change closes one assignment and opens another. */
export const GateAssignmentSchema = z.object({
  flightId: z.string().min(1),
  /** Canonical gate id, terminal-qualified: `T2-42`, `T1-BUS3`. */
  gateId: z.string().min(1),
  /** From when passengers are expected in the gate area (typically boarding start minus a lead time). */
  from: instant,
  /** Until when (gate close / off-block). */
  to: instant,
  kind: z.enum(['planned', 'actual']),
});
export type GateAssignment = z.infer<typeof GateAssignmentSchema>;

export const AircraftTypeSchema = z.object({
  icao: z.string().min(2).max(4),
  name: z.string(),
  wideBody: z.boolean(),
  /** Typical cabin layout used to estimate cabin mix: seats per cabin. */
  cabins: z.object({
    business: z.number().int().min(0),
    premium_economy: z.number().int().min(0),
    economy: z.number().int().min(0),
  }),
});
export type AircraftType = z.infer<typeof AircraftTypeSchema>;

/** Kinds of real-time flight-leg updates (an AIDX FlightLegNotifRQ carries one or more of these). */
export const FlightEventTypeSchema = z.enum([
  'schedule',
  'estimate',
  'delay',
  'gate_change',
  'stand_change',
  'boarding',
  'gate_closed',
  'off_block',
  'airborne',
  'landed',
  'on_block',
  'cancelled',
]);
export type FlightEventType = z.infer<typeof FlightEventTypeSchema>;

/** The flight fields an event may change. */
export const FlightChangesSchema = FlightSchema.pick({
  estimatedTime: true,
  estimatedRunwayTime: true,
  actualRunwayTime: true,
  actualBlockTime: true,
  tobt: true,
  tsat: true,
  stand: true,
  gate: true,
  baggageBelt: true,
  pax: true,
  status: true,
  delayCodes: true,
}).partial();
export type FlightChanges = z.infer<typeof FlightChangesSchema>;

export const FlightEventSchema = z.object({
  /** Unique per message: the source's transaction id, or a generated one. */
  id: z.string().min(1),
  flightId: z.string().min(1),
  type: FlightEventTypeSchema,
  /** When the change happened (or was decided) operationally. */
  occurredAt: instant,
  changes: FlightChangesSchema,
  /** The source sequence number, used to drop out-of-order duplicates. */
  sequence: z.number().int().min(0).nullable(),
  source: SourceRefSchema,
});
export type FlightEvent = z.infer<typeof FlightEventSchema>;

/** Apply an event's changes to a flight (events carry only the fields they change). */
export function applyFlightEvent(flight: Flight, event: Pick<FlightEvent, 'changes' | 'occurredAt'>): Flight {
  const changes = Object.fromEntries(Object.entries(event.changes).filter(([, v]) => v !== undefined));
  return { ...flight, ...changes, lastUpdate: event.occurredAt };
}

/** Canonical flight id: `<airline><number>-<D|A>-<YYYYMMDD>` (scheduled date in UTC). */
export function flightId(
  airlineIata: string,
  flightNumber: string,
  direction: FlightDirection,
  scheduledUtc: string,
): string {
  const day = scheduledUtc.slice(0, 10).replace(/-/g, '');
  return `${airlineIata}${flightNumber}-${direction}-${day}`;
}

/** Canonical gate id: terminal-qualified, because remote bus gates reuse names across terminals. */
export function gateId(terminal: string, gate: string): string {
  return `${terminal}-${gate}`;
}

/** Delay in whole minutes between the schedule and the latest estimate or actual block time. */
export function delayMinutes(
  flight: Pick<Flight, 'scheduledTime' | 'estimatedTime' | 'actualBlockTime'>,
): number {
  const latest = flight.actualBlockTime ?? flight.estimatedTime;
  if (!latest) return 0;
  return Math.max(0, Math.round((Date.parse(latest) - Date.parse(flight.scheduledTime)) / 60_000));
}
