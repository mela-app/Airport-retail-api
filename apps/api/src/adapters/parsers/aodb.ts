/**
 * AODB flight-movement snapshot → canonical `Flight`.
 *
 * Input: CSV or JSON, one row per flight leg, with the 33 columns of the challenge sample file. Column order
 * does not matter and extra vendor columns are ignored. Paired columns (STA_STD, ETA_ETD, ELDT_ETOT, ALDT_ATOT,
 * AIBT_AOBT) hold the arrival value on `A` rows and the departure value on `D` rows. Times are ISO 8601 UTC.
 *
 * Rows that fail validation are reported individually; the rest of the snapshot is still loaded.
 */
import { type Flight, FlightSchema, type FlightStatus, flightId } from '@arm/domain';

import { parseCsv } from './csv.js';

export const AODB_REQUIRED_COLUMNS = [
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

/** AODB status codes → canonical status. The sample end-of-day file uses ARR / DEP / CNL. */
const STATUS: ReadonlyMap<string, FlightStatus> = new Map([
  ['SCH', 'scheduled'],
  ['DEL', 'delayed'],
  ['BRD', 'boarding'],
  ['GCL', 'gate_closed'],
  ['DEP', 'departed'],
  ['EXP', 'approaching'],
  ['LND', 'landed'],
  ['ARR', 'arrived'],
  ['CNL', 'cancelled'],
]);

export interface AodbRowError {
  /** 1-based data row number (excluding the header). */
  row: number;
  sourceId: string | null;
  reason: string;
}

export interface AodbParseResult {
  flights: Flight[];
  errors: AodbRowError[];
}

type Row = ReadonlyMap<string, string>;

const cell = (row: Row, column: string): string => (row.get(column) ?? '').trim();
const optional = (row: Row, column: string): string | null => cell(row, column) || null;
const list = (row: Row, column: string, sep: string): string[] =>
  cell(row, column)
    .split(sep)
    .map((v) => v.trim())
    .filter((v) => v !== '');

/** Normalise any ISO 8601 instant to `YYYY-MM-DDTHH:MM:SSZ`; null for empty, throws on invalid. */
function instant(row: Row, column: string): string | null {
  const v = cell(row, column);
  if (!v) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`${column} is not a valid ISO 8601 time: ${v}`);
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

function integer(row: Row, column: string, required: boolean): number | null {
  const v = cell(row, column);
  if (!v) {
    if (required) throw new Error(`${column} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${column} must be a non-negative integer: ${v}`);
  return n;
}

function rowToFlight(row: Row, receivedAt: string, linkedIds: ReadonlyMap<string, string>): Flight {
  const direction = cell(row, 'direction');
  if (direction !== 'A' && direction !== 'D') throw new Error(`direction must be A or D: ${direction}`);
  const scheduled = instant(row, 'STA_STD');
  if (!scheduled) throw new Error('STA_STD is required');
  const airline = cell(row, 'airline_iata');
  const number = cell(row, 'flight_number');
  const statusCode = cell(row, 'status');
  const status = STATUS.get(statusCode);
  if (!status) throw new Error(`unknown status code: ${statusCode}`);
  const nature = cell(row, 'flight_nature');
  if (nature !== 'I' && nature !== 'D') throw new Error(`flight_nature must be I or D: ${nature}`);
  const sourceId = optional(row, 'aodb_flight_id');
  const linkedSource = optional(row, 'linked_flight_id');

  const flight = {
    id: flightId(airline, number, direction, scheduled),
    sourceFlightId: sourceId,
    linkedFlightId: linkedSource ? (linkedIds.get(linkedSource) ?? null) : null,
    direction,
    airlineIata: airline,
    airlineIcao: cell(row, 'airline_icao'),
    flightNumber: number,
    callsign: optional(row, 'callsign'),
    serviceType: cell(row, 'service_type') || 'J',
    nature: nature === 'I' ? 'international' : 'domestic',
    origin: cell(row, 'origin'),
    destination: cell(row, 'destination'),
    via: list(row, 'via', '|'),
    terminal: cell(row, 'terminal'),
    scheduledTime: scheduled,
    estimatedTime: instant(row, 'ETA_ETD'),
    estimatedRunwayTime: instant(row, 'ELDT_ETOT'),
    actualRunwayTime: instant(row, 'ALDT_ATOT'),
    actualBlockTime: instant(row, 'AIBT_AOBT'),
    tobt: instant(row, 'TOBT'),
    tsat: instant(row, 'TSAT'),
    stand: optional(row, 'stand'),
    gate: optional(row, 'gate'),
    checkinCounters: optional(row, 'checkin_counters'),
    baggageBelt: optional(row, 'baggage_belt'),
    aircraftRegistration: optional(row, 'aircraft_reg'),
    aircraftTypeIcao: cell(row, 'aircraft_type_icao'),
    seats: integer(row, 'seats', true),
    pax: integer(row, 'pax_total', false),
    status,
    delayCodes: list(row, 'delay_codes', '/'),
    codeshares: list(row, 'codeshares', '|'),
    handler: optional(row, 'handler'),
    lastUpdate: instant(row, 'last_update_utc') ?? receivedAt,
    source: { source: 'aodb' as const, ref: sourceId ?? `${airline}${number}`, receivedAt },
  };
  const parsed = FlightSchema.safeParse(flight);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

function parseRows(rows: readonly Row[], receivedAt: string): AodbParseResult {
  // First pass: AODB key → canonical id, to resolve `linked_flight_id`.
  const linkedIds = new Map<string, string>();
  for (const row of rows) {
    const sourceId = optional(row, 'aodb_flight_id');
    const scheduled = cell(row, 'STA_STD');
    const direction = cell(row, 'direction');
    if (
      sourceId &&
      scheduled &&
      (direction === 'A' || direction === 'D') &&
      !Number.isNaN(Date.parse(scheduled))
    ) {
      linkedIds.set(
        sourceId,
        flightId(
          cell(row, 'airline_iata'),
          cell(row, 'flight_number'),
          direction,
          new Date(Date.parse(scheduled)).toISOString(),
        ),
      );
    }
  }
  const flights: Flight[] = [];
  const errors: AodbRowError[] = [];
  rows.forEach((row, idx) => {
    try {
      flights.push(rowToFlight(row, receivedAt, linkedIds));
    } catch (err) {
      errors.push({
        row: idx + 1,
        sourceId: optional(row, 'aodb_flight_id'),
        reason: (err as Error).message,
      });
    }
  });
  return { flights, errors };
}

function checkColumns(columns: readonly string[]): void {
  const present = new Set(columns);
  const missing = AODB_REQUIRED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length > 0) throw new Error(`AODB snapshot is missing columns: ${missing.join(', ')}`);
}

/** Parse an AODB CSV snapshot. */
export function parseAodbCsv(text: string, receivedAt: string): AodbParseResult {
  const table = parseCsv(text);
  checkColumns(table.header);
  return parseRows(table.records, receivedAt);
}

/** Parse an AODB JSON snapshot: an array of row objects keyed by the same column names. */
export function parseAodbJson(text: string, receivedAt: string): AodbParseResult {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('AODB JSON snapshot must be an array of rows');
  const rows = data.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('AODB JSON rows must be objects');
    return new Map(Object.entries(item).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
  });
  if (rows.length > 0) checkColumns([...(rows[0]?.keys() ?? [])]);
  return parseRows(rows, receivedAt);
}
