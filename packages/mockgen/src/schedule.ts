/**
 * Generates one operating day at MQI: arrival/departure pairs with A-CDM times, gates, stands, pax, delays,
 * cancellations and gate changes, plus the time-ordered flight events (what an AODB would publish over AIDX
 * as the day unfolds). Shapes follow the sample AODB file.
 */
import {
  AIRCRAFT_TYPES,
  type AircraftType,
  type Airline,
  CODESHARES,
  type CrowdProfile,
  type Destination,
  type Flight,
  type FlightChanges,
  type FlightEventType,
  GATES,
  type Gate,
  GROUND_HANDLERS,
  ROUTES,
  type Route,
  addMinutes,
  aircraftTypeByIcao,
  airlineByIata,
  destinationByIata,
  flightId,
  isoMinute,
  localToUtc,
  toLocal,
} from '@arm/domain';

import { type CalendarDay, calendarDay } from './calendar.js';
import { Rng } from './prng.js';
import { flightProfile } from './profiles.js';
import { WORKED_EXAMPLE, type ScenarioFlight } from './scenario.js';

/** One change in a flight's life, and when the airport learns about it (simulation time, UTC). */
export interface PlannedEvent {
  flightId: string;
  type: FlightEventType;
  at: string;
  changes: FlightChanges;
}

export interface GeneratedFlight {
  /** The flight as published at the start of the day (schedule, planned gate, booked pax). */
  initial: Flight;
  /** The flight at the end of the day, after every event (what the sample end-of-day file holds). */
  final: Flight;
  events: PlannedEvent[];
  profile: CrowdProfile;
}

export interface DayOptions {
  /** Local operating date, `YYYY-MM-DD`. */
  date: string;
  seed: string;
  /** Arrival/departure pairs; each pair is two AODB rows. Default 450 (≈ 900 flights). */
  pairs: number;
  utcOffsetMinutes: number;
  /** Include the challenge's worked example (Gate 42 at 14:10). */
  includeWorkedExample: boolean;
}

export const DEFAULT_DAY_OPTIONS: DayOptions = {
  date: '2026-10-16',
  seed: 'mqi',
  pairs: 450,
  utcOffsetMinutes: 240,
  includeWorkedExample: true,
};

/** Relative departure volume per local hour (morning and evening banks). */
const HOUR_WEIGHTS = [3, 2, 1, 1, 2, 4, 9, 10, 9, 7, 6, 6, 7, 7, 6, 7, 8, 9, 10, 9, 8, 7, 6, 4] as const;

const DELAY_CODE_WEIGHTS: readonly (readonly [string, number])[] = [
  ['89', 30],
  ['41', 26],
  ['81', 18],
  ['93', 18],
  ['63/11', 10],
];

interface GateUse {
  from: number;
  to: number;
}

class GateBook {
  private readonly uses = new Map<string, GateUse[]>();

  free(gate: string, from: number, to: number): boolean {
    return (this.uses.get(gate) ?? []).every((u) => to <= u.from || from >= u.to);
  }

  book(gate: string, from: number, to: number): void {
    const list = this.uses.get(gate) ?? [];
    list.push({ from, to });
    this.uses.set(gate, list);
  }
}

function terminalFor(airline: Airline, dest: Destination, rng: Rng): 'T1' | 'T2' {
  if (dest.market === 'international') return 'T2';
  // Domestic split, following the sample: full-service domestic is in T2, low-cost carriers use both.
  const t2Share = new Map([
    ['YA', 1],
    ['XD', 0.55],
    ['YN', 0.7],
    ['XU', 0.5],
    ['YF', 0.15],
  ]).get(airline.iata);
  return rng.chance(t2Share ?? 0.5) ? 'T2' : 'T1';
}

function registration(airline: Airline, rng: Rng): string {
  const letter = airline.icao.charAt(0) === 'S' ? 'M' : airline.iata.charAt(1);
  return `Q${letter}-${rng.letters(rng.chance(0.5) ? 2 : 3)}`;
}

function checkinCounters(terminal: string, rng: Rng): string {
  const row = rng.pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const first = rng.int(1, 14);
  return `${terminal}-${row}${String(first).padStart(2, '0')}-${rng.int(30, 60)}`;
}

function handlerFor(airline: Airline, rng: Rng): string {
  if (airline.iata === 'XD') return GROUND_HANDLERS[0];
  return rng.pick(GROUND_HANDLERS.slice(1));
}

function standFor(gate: Gate | undefined, rng: Rng): string {
  if (gate && !gate.remote) return `C${rng.int(1, 60)}`;
  return `${rng.pick(['R', 'V'])}${rng.int(1, 40)}`;
}

interface Numbering {
  next(airline: Airline): [string, string];
}

function numbering(rng: Rng): Numbering {
  const used = new Set<string>();
  return {
    next(airline) {
      for (;;) {
        const base = airline.model === 'low_cost' ? rng.int(100, 4900) * 2 : rng.int(50, 480) * 2;
        const key = `${airline.iata}${base}`;
        if (!used.has(key)) {
          used.add(key);
          return [String(base), String(base + 1)];
        }
      }
    },
  };
}

interface PairDraft {
  airline: Airline;
  dest: Destination;
  aircraft: AircraftType;
  std: Date;
  turnaroundMin: number;
  terminal: 'T1' | 'T2';
  gate: Gate | undefined;
  pax: number;
  arrPax: number;
  delayMin: number;
  delayCodes: string[];
  delayKnownMin: number;
  cancelled: boolean;
  gateChange: Gate | undefined;
  arrivalDelayMin: number;
  numbers: [string, string];
  pinnedProfile: CrowdProfile | null;
  boardingLeadMin: number;
}

function seatsOf(aircraft: AircraftType): number {
  return aircraft.cabins.business + aircraft.cabins.premium_economy + aircraft.cabins.economy;
}

function pickGate(
  terminal: 'T1' | 'T2',
  aircraft: AircraftType,
  from: number,
  to: number,
  book: GateBook,
  rng: Rng,
  exclude: ReadonlySet<string>,
): Gate | undefined {
  const inTerminal = GATES.filter((g) => g.terminalId === terminal && !exclude.has(g.id));
  const contact = rng.shuffle(inTerminal.filter((g) => !g.remote));
  const remote = rng.shuffle(inTerminal.filter((g) => g.remote));
  // Wide-bodies always get a contact gate; narrow-bodies use bus gates about one time in five.
  const order = aircraft.wideBody || rng.chance(0.8) ? [...contact, ...remote] : [...remote, ...contact];
  return order.find((g) => book.free(g.id, from, to));
}

function draftPair(
  route: Route,
  std: Date,
  rng: Rng,
  book: GateBook,
  ids: Numbering,
  reserved: ReadonlySet<string>,
): PairDraft {
  const airline = airlineByIata(route.airlineIata);
  const dest = destinationByIata(route.destination);
  const aircraft = aircraftTypeByIcao(rng.pick(route.fleet));
  if (!airline || !dest || !aircraft) throw new Error(`bad route ${route.airlineIata}-${route.destination}`);
  const terminal = terminalFor(airline, dest, rng);
  const boardingLeadMin = aircraft.wideBody ? 40 : 30;
  const turnaroundMin = aircraft.wideBody
    ? rng.int(18, 30) * 5
    : airline.model === 'low_cost'
      ? rng.int(9, 12) * 5
      : rng.int(10, 15) * 5;
  const seats = seatsOf(aircraft);
  const loadFactor = Math.min(0.99, Math.max(0.55, rng.normal(0.84, 0.07)));
  const cancelled = rng.chance(0.015);
  const delayed = !cancelled && rng.chance(0.3);
  const delayBand = rng.next();
  const delayMin = delayed
    ? delayBand < 0.5
      ? rng.int(1, 4) * 5
      : delayBand < 0.85
        ? rng.int(4, 12) * 5
        : rng.int(12, 30) * 5
    : 0;
  const code = rng.weighted(DELAY_CODE_WEIGHTS, ([, w]) => w)[0];

  const window = (minutesBefore: number, minutesAfter: number): [number, number] => [
    std.getTime() - minutesBefore * 60_000,
    std.getTime() + (delayMin + minutesAfter) * 60_000,
  ];
  const [from, to] = window(boardingLeadMin + 30, 15);
  const gate = pickGate(terminal, aircraft, from, to, book, rng, reserved);
  if (gate) book.book(gate.id, from, to);
  const gateChange =
    gate && !cancelled && rng.chance(0.08)
      ? pickGate(terminal, aircraft, from, to, book, rng, new Set([...reserved, gate.id]))
      : undefined;
  if (gateChange) book.book(gateChange.id, from, to);

  return {
    airline,
    dest,
    aircraft,
    std,
    turnaroundMin,
    terminal,
    gate,
    pax: Math.round(seats * loadFactor),
    arrPax: Math.round(seats * Math.min(0.99, Math.max(0.5, rng.normal(0.82, 0.08)))),
    delayMin,
    delayCodes: delayed ? [code] : [],
    delayKnownMin: rng.int(25, 120),
    cancelled,
    gateChange,
    arrivalDelayMin: rng.chance(0.35) ? rng.int(1, 8) * 5 : -rng.int(0, 3) * 5,
    numbers: ids.next(airline),
    pinnedProfile: null,
    boardingLeadMin,
  };
}

function scenarioPair(s: ScenarioFlight, date: string, offset: number, rng: Rng, book: GateBook): PairDraft {
  const airline = airlineByIata(s.airlineIata);
  const dest = destinationByIata(s.destination);
  const aircraft = aircraftTypeByIcao(s.aircraftTypeIcao);
  const gate = GATES.find((g) => g.id === s.gateId);
  if (!airline || !dest || !aircraft || !gate) throw new Error(`bad scenario flight ${s.flightNumber}`);
  const std = localToUtc(date, s.localStd.hour, s.localStd.minute, offset);
  const lead = aircraft.wideBody ? 40 : 30;
  book.book(gate.id, std.getTime() - (lead + 30) * 60_000, std.getTime() + (s.delayMinutes + 15) * 60_000);
  return {
    airline,
    dest,
    aircraft,
    std,
    turnaroundMin: aircraft.wideBody ? 120 : 50,
    terminal: gate.terminalId as 'T1' | 'T2',
    gate,
    pax: s.pax,
    arrPax: Math.round(s.pax * 0.9),
    delayMin: s.delayMinutes,
    delayCodes: s.delayMinutes > 0 ? [s.delayCode] : [],
    delayKnownMin: s.delayKnownMinutesBeforeStd,
    cancelled: false,
    gateChange: undefined,
    arrivalDelayMin: 0,
    numbers: [String(Number(s.flightNumber) - 1), s.flightNumber],
    pinnedProfile: s.profile,
    boardingLeadMin: lead,
  };
}

function emptyChanges(): FlightChanges {
  return {};
}

function buildFlights(
  d: PairDraft,
  rng: Rng,
  generatedAt: string,
  cal: CalendarDay,
  offset: number,
): [GeneratedFlight, GeneratedFlight] {
  const { airline, dest, aircraft, std } = d;
  const seats = seatsOf(aircraft);
  const sta = addMinutes(std, -d.turnaroundMin);
  const eta = addMinutes(sta, d.arrivalDelayMin);
  const aldt = addMinutes(eta, -rng.int(5, 9));
  const etd = addMinutes(std, d.delayMin);
  const aobt = addMinutes(etd, rng.int(-1, 3));
  const atot = addMinutes(aobt, rng.int(12, 22));
  const [arrNumber, depNumber] = d.numbers;
  const arrId = flightId(airline.iata, arrNumber, 'A', isoMinute(sta));
  const depId = flightId(airline.iata, depNumber, 'D', isoMinute(std));
  const codeshares = rng.chance(0.4) ? [...(CODESHARES.get(airline.iata) ?? [])] : [];
  const marketing = codeshares.length > 0 ? [airline.iata, ...codeshares] : [];
  const handler = handlerFor(airline, rng);
  const registrationMark = registration(airline, rng);
  const sourceOf = (id: string) => ({ source: 'aodb' as const, ref: id, receivedAt: generatedAt });
  const status = d.cancelled ? 'cancelled' : 'scheduled';

  const baseArr: Flight = {
    id: arrId,
    sourceFlightId: null,
    linkedFlightId: depId,
    direction: 'A',
    airlineIata: airline.iata,
    airlineIcao: airline.icao,
    flightNumber: arrNumber,
    callsign: `${airline.icao}${arrNumber}`,
    serviceType: 'J',
    nature: dest.market,
    origin: dest.iata,
    destination: 'MQI',
    via: [],
    terminal: d.terminal,
    scheduledTime: isoMinute(sta),
    estimatedTime: isoMinute(sta),
    estimatedRunwayTime: isoMinute(addMinutes(sta, -8)),
    actualRunwayTime: null,
    actualBlockTime: null,
    tobt: null,
    tsat: null,
    stand: standFor(d.gate, rng),
    gate: d.gate && rng.chance(0.4) ? d.gate.code : null,
    checkinCounters: null,
    baggageBelt: null,
    aircraftRegistration: registrationMark,
    aircraftTypeIcao: aircraft.icao,
    seats,
    pax: d.arrPax,
    status: d.cancelled ? 'cancelled' : 'scheduled',
    delayCodes: [],
    codeshares: marketing,
    handler,
    lastUpdate: generatedAt,
    source: sourceOf(arrId),
  };
  const baseDep: Flight = {
    ...baseArr,
    id: depId,
    linkedFlightId: arrId,
    direction: 'D',
    flightNumber: depNumber,
    callsign: `${airline.icao}${depNumber}`,
    origin: 'MQI',
    destination: dest.iata,
    scheduledTime: isoMinute(std),
    estimatedTime: isoMinute(std),
    estimatedRunwayTime: isoMinute(addMinutes(std, 14)),
    tobt: isoMinute(addMinutes(std, -2)),
    tsat: isoMinute(std),
    gate: d.gate?.code ?? null,
    stand: baseArr.stand,
    checkinCounters: checkinCounters(d.terminal, rng),
    pax: d.pax,
    status,
    source: sourceOf(depId),
  };

  const arrEvents: PlannedEvent[] = [];
  const depEvents: PlannedEvent[] = [];
  const ev = (list: PlannedEvent[], id: string, type: FlightEventType, at: Date, changes: FlightChanges) =>
    list.push({ flightId: id, type, at: isoMinute(at), changes: { ...emptyChanges(), ...changes } });

  if (d.cancelled) {
    const known = addMinutes(sta, -rng.int(60, 240));
    ev(arrEvents, arrId, 'cancelled', known, { status: 'cancelled' });
    ev(depEvents, depId, 'cancelled', known, { status: 'cancelled' });
  } else {
    // arrival
    if (d.arrivalDelayMin !== 0) {
      ev(arrEvents, arrId, 'estimate', addMinutes(sta, -120), {
        estimatedTime: isoMinute(eta),
        estimatedRunwayTime: isoMinute(addMinutes(eta, -8)),
        status: 'approaching',
      });
    } else {
      ev(arrEvents, arrId, 'estimate', addMinutes(sta, -40), { status: 'approaching' });
    }
    ev(arrEvents, arrId, 'landed', aldt, { actualRunwayTime: isoMinute(aldt), status: 'landed' });
    ev(arrEvents, arrId, 'on_block', eta, {
      actualBlockTime: isoMinute(eta),
      status: 'arrived',
      baggageBelt: String(rng.int(1, 14)),
    });
    // departure
    if (d.delayMin > 0) {
      ev(depEvents, depId, 'delay', addMinutes(std, -d.delayKnownMin), {
        estimatedTime: isoMinute(etd),
        estimatedRunwayTime: isoMinute(addMinutes(etd, 14)),
        tobt: isoMinute(addMinutes(etd, -2)),
        tsat: isoMinute(etd),
        delayCodes: d.delayCodes,
        status: 'delayed',
      });
    }
    if (d.gateChange) {
      ev(depEvents, depId, 'gate_change', addMinutes(std, -rng.int(40, 90)), { gate: d.gateChange.code });
    }
    ev(depEvents, depId, 'boarding', addMinutes(etd, -d.boardingLeadMin), { status: 'boarding' });
    ev(depEvents, depId, 'gate_closed', addMinutes(etd, -10), { status: 'gate_closed' });
    ev(depEvents, depId, 'off_block', aobt, { actualBlockTime: isoMinute(aobt), status: 'departed' });
    ev(depEvents, depId, 'airborne', atot, { actualRunwayTime: isoMinute(atot) });
  }

  const apply = (base: Flight, events: readonly PlannedEvent[]): Flight =>
    events.reduce<Flight>((f, e) => ({ ...f, ...e.changes, lastUpdate: e.at }), base);

  const localDep = toLocal(std, offset);
  const profileCtx = {
    destination: dest,
    airline,
    aircraft,
    local: localDep,
    schoolHoliday: cal.schoolHoliday,
    festival: cal.festival !== null,
  };
  const depProfile =
    d.pinnedProfile ?? flightProfile({ ...profileCtx, direction: 'D', pax: d.pax }, rng.fork(`p:${depId}`));
  const arrProfile = flightProfile(
    { ...profileCtx, local: toLocal(sta, offset), direction: 'A', pax: d.arrPax },
    rng.fork(`p:${arrId}`),
  );

  return [
    { initial: baseArr, final: apply(baseArr, arrEvents), events: arrEvents, profile: arrProfile },
    { initial: baseDep, final: apply(baseDep, depEvents), events: depEvents, profile: depProfile },
  ];
}

export interface GeneratedDay {
  options: DayOptions;
  calendar: CalendarDay;
  /** All flights, arrivals and departures, sorted by scheduled time. */
  flights: GeneratedFlight[];
  /** Every event of the day, sorted by time. */
  events: PlannedEvent[];
}

/** Generate one operating day. Deterministic for a given date and seed. */
export function generateDay(opts: Partial<DayOptions> = {}): GeneratedDay {
  const options: DayOptions = { ...DEFAULT_DAY_OPTIONS, ...opts };
  const rng = new Rng(`${options.seed}:${options.date}`);
  const cal = calendarDay(options.date);
  const book = new GateBook();
  const ids = numbering(rng.fork('numbers'));
  const generatedAt = isoMinute(localToUtc(options.date, 0, 0, options.utcOffsetMinutes));

  const drafts: PairDraft[] = [];
  const reserved = new Set<string>();
  if (options.includeWorkedExample) {
    for (const g of WORKED_EXAMPLE.keepFreeGateIds) reserved.add(g);
    for (const s of WORKED_EXAMPLE.flights) {
      reserved.add(s.gateId);
      drafts.push(scenarioPair(s, options.date, options.utcOffsetMinutes, rng.fork(s.flightNumber), book));
    }
  }

  const scheduleRng = rng.fork('schedule');
  const hours = HOUR_WEIGHTS.map((w, h) => ({ h, w }));
  const toGenerate = Math.max(0, options.pairs - drafts.length);
  for (let i = 0; i < toGenerate; i += 1) {
    const route = scheduleRng.weighted(ROUTES, (r) => r.weight);
    const { h } = scheduleRng.weighted(hours, (x) => x.w);
    const std = localToUtc(options.date, h, scheduleRng.int(0, 11) * 5, options.utcOffsetMinutes);
    drafts.push(draftPair(route, std, scheduleRng, book, ids, reserved));
  }

  const flightRng = rng.fork('flights');
  const flights = drafts
    .flatMap((d) => buildFlights(d, flightRng, generatedAt, cal, options.utcOffsetMinutes))
    .sort(
      (a, b) =>
        a.initial.scheduledTime.localeCompare(b.initial.scheduledTime) ||
        a.initial.id.localeCompare(b.initial.id),
    );

  // AODB-style numeric keys, as in the sample (`aodb_flight_id`). `linkedFlightId` stays canonical; the AODB
  // writer turns it into the partner's numeric key.
  const sourceIds = new Map(flights.map((f, i) => [f.initial.id, String(200000 + i)]));
  const withSourceIds = flights.map((f) => {
    const sourceFlightId = sourceIds.get(f.initial.id) ?? null;
    const patch = (x: Flight): Flight => ({
      ...x,
      sourceFlightId,
      source: { ...x.source, ref: sourceFlightId ?? x.id },
    });
    return { ...f, initial: patch(f.initial), final: patch(f.final) };
  });

  const events = withSourceIds
    .flatMap((f) => f.events)
    .sort((a, b) => a.at.localeCompare(b.at) || a.flightId.localeCompare(b.flightId));
  return { options, calendar: cal, flights: withSourceIds, events };
}

/** The state of every flight as known at `at` (UTC): the initial schedule with all earlier events applied. */
export function snapshotAt(day: GeneratedDay, at: Date): Flight[] {
  const cutoff = isoMinute(at);
  return day.flights.map((f) =>
    f.events
      .filter((e) => e.at <= cutoff)
      .reduce<Flight>((flight, e) => ({ ...flight, ...e.changes, lastUpdate: e.at }), f.initial),
  );
}

export { AIRCRAFT_TYPES };
