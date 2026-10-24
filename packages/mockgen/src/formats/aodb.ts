/**
 * AODB flight-movement export: one row per flight leg, the 33 columns of the sample file
 * (samples/aodb-samples/MQI_aodb_flights_2026-10-14_SYNTHETIC.csv). Paired columns such as STA_STD hold the
 * arrival value on `A` rows and the departure value on `D` rows. Times are ISO 8601 UTC.
 */
import { type Flight, type FlightStatus, getOwn } from '@arm/domain';

export const AODB_COLUMNS = [
  'aodb_flight_id',
  'linked_flight_id',
  'direction',
  'airline_iata',
  'airline_icao',
  'flight_number',
  'callsign',
  'service_type',
  'flight_nature',
  'origin',
  'destination',
  'via',
  'terminal',
  'STA_STD',
  'ETA_ETD',
  'ELDT_ETOT',
  'ALDT_ATOT',
  'AIBT_AOBT',
  'TOBT',
  'TSAT',
  'stand',
  'gate',
  'checkin_counters',
  'baggage_belt',
  'aircraft_reg',
  'aircraft_type_icao',
  'seats',
  'pax_total',
  'status',
  'delay_codes',
  'codeshares',
  'handler',
  'last_update_utc',
] as const;

export type AodbColumn = (typeof AODB_COLUMNS)[number];
export type AodbRow = Record<AodbColumn, string>;

/**
 * AODB status codes. The sample end-of-day file only uses ARR, DEP and CNL; intra-day snapshots also carry
 * the operational codes below.
 */
export const AODB_STATUS: ReadonlyMap<FlightStatus, string> = new Map([
  ['scheduled', 'SCH'],
  ['delayed', 'DEL'],
  ['boarding', 'BRD'],
  ['gate_closed', 'GCL'],
  ['departed', 'DEP'],
  ['approaching', 'EXP'],
  ['landed', 'LND'],
  ['arrived', 'ARR'],
  ['cancelled', 'CNL'],
]);

const t = (v: string | null): string => v ?? '';

/**
 * One AODB row. `linkedSourceId` is the partner leg's AODB key (`linked_flight_id`); the canonical model links
 * flights by canonical id, so the caller resolves it.
 */
export function toAodbRow(f: Flight, linkedSourceId: string | null = null): AodbRow {
  return {
    aodb_flight_id: t(f.sourceFlightId),
    linked_flight_id: t(linkedSourceId),
    direction: f.direction,
    airline_iata: f.airlineIata,
    airline_icao: f.airlineIcao,
    flight_number: f.flightNumber,
    callsign: t(f.callsign),
    service_type: f.serviceType,
    flight_nature: f.nature === 'international' ? 'I' : 'D',
    origin: f.origin,
    destination: f.destination,
    via: f.via.join('|'),
    terminal: f.terminal,
    STA_STD: f.scheduledTime,
    ETA_ETD: t(f.estimatedTime),
    ELDT_ETOT: t(f.estimatedRunwayTime),
    ALDT_ATOT: t(f.actualRunwayTime),
    AIBT_AOBT: t(f.actualBlockTime),
    TOBT: t(f.tobt),
    TSAT: t(f.tsat),
    stand: t(f.stand),
    gate: t(f.gate),
    checkin_counters: t(f.checkinCounters),
    baggage_belt: t(f.baggageBelt),
    aircraft_reg: t(f.aircraftRegistration),
    aircraft_type_icao: f.aircraftTypeIcao,
    seats: String(f.seats),
    pax_total: f.pax === null ? '' : String(f.pax),
    status: AODB_STATUS.get(f.status) ?? 'SCH',
    delay_codes: f.delayCodes.join('/'),
    codeshares: f.codeshares.join('|'),
    handler: t(f.handler),
    last_update_utc: f.lastUpdate,
  };
}

const csvCell = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

function toAodbRows(flights: readonly Flight[]): AodbRow[] {
  const sourceIdOf = new Map(flights.map((f) => [f.id, f.sourceFlightId]));
  return flights.map((f) =>
    toAodbRow(f, f.linkedFlightId ? (sourceIdOf.get(f.linkedFlightId) ?? null) : null),
  );
}

export function toAodbCsv(flights: readonly Flight[]): string {
  const lines = [AODB_COLUMNS.join(',')];
  for (const row of toAodbRows(flights))
    lines.push(AODB_COLUMNS.map((c) => csvCell(getOwn(row, c) ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}

export function toAodbJson(flights: readonly Flight[]): string {
  return `${JSON.stringify(toAodbRows(flights), null, 2)}\n`;
}
