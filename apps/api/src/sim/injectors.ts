/**
 * "Inject event" controls. Flight events are injected as IATA AIDX messages into the flight feed, so they take
 * exactly the path a real AODB update would: adapter parser → ingestion → live state → bus → screens and
 * dashboards. Screen outages are platform-side and go to the screen fleet directly.
 */
import {
  type Flight,
  type FlightChanges,
  addMinutes,
  applyFlightEvent,
  destinationByIata,
  gateId,
  isoMinute,
} from '@arm/domain';
import { type PlannedEvent, toAidxXml } from '@arm/mockgen';

import type { FlightSource } from '../adapters/contracts.js';
import type { Layout } from '../engine/layout.js';
import type { LiveState } from './live-state.js';

export class InjectionError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'unsupported',
  ) {
    super(message);
    this.name = 'InjectionError';
  }
}

const FINISHED = new Set(['departed', 'arrived', 'landed', 'cancelled']);

export class Injectors {
  private sequence = 900_000;

  constructor(
    private readonly flights: FlightSource,
    private readonly state: LiveState,
    /** The layout in use (gates can be added or taken out of service through the master-data API). */
    private readonly layout: () => Layout,
  ) {}

  private flight(id: string): Flight {
    const flight = this.state.flight(id);
    if (!flight) throw new InjectionError(`unknown flight ${id}`, 'not_found');
    if (FINISHED.has(flight.status))
      throw new InjectionError(`flight ${id} is already ${flight.status}`, 'invalid');
    return flight;
  }

  private send(flight: Flight, type: PlannedEvent['type'], changes: FlightChanges, now: Date) {
    if (!this.flights.inject)
      throw new InjectionError(
        `the ${this.flights.adapter} feed does not accept injected messages`,
        'unsupported',
      );
    const event: PlannedEvent = { flightId: flight.id, type, at: isoMinute(now), changes };
    const after = applyFlightEvent(flight, { changes, occurredAt: event.at });
    const other = flight.direction === 'D' ? flight.destination : flight.origin;
    this.sequence += 1;
    const xml = toAidxXml(after, event, this.sequence, destinationByIata(other)?.blockMinutes ?? 60);
    return { xml, event: this.flights.inject(xml) };
  }

  /** Delay a flight by `minutes` beyond its current estimate. */
  delay(flightId: string, minutes: number, delayCode: string, now: Date) {
    const flight = this.flight(flightId);
    const base = new Date(flight.estimatedTime ?? flight.scheduledTime);
    const estimate = addMinutes(base, minutes);
    const departure = flight.direction === 'D';
    const changes: FlightChanges = departure
      ? {
          estimatedTime: isoMinute(estimate),
          estimatedRunwayTime: isoMinute(addMinutes(estimate, 14)),
          tobt: isoMinute(addMinutes(estimate, -2)),
          status: 'delayed',
          delayCodes: [...new Set([...flight.delayCodes, delayCode])],
        }
      : {
          estimatedTime: isoMinute(estimate),
          estimatedRunwayTime: isoMinute(addMinutes(estimate, -8)),
          status: 'approaching',
        };
    return this.send(flight, departure ? 'delay' : 'estimate', changes, now);
  }

  /** Move a departure to another gate in the same terminal. */
  changeGate(flightId: string, gateCode: string, now: Date) {
    const flight = this.flight(flightId);
    if (flight.direction !== 'D') throw new InjectionError('gate changes apply to departures', 'invalid');
    const gate = this.layout().gate(gateId(flight.terminal, gateCode));
    if (!gate) throw new InjectionError(`gate ${gateCode} does not exist in ${flight.terminal}`, 'invalid');
    if (!gate.active) throw new InjectionError(`gate ${gateCode} is out of service`, 'invalid');
    if (flight.gate === gate.code)
      throw new InjectionError(`flight is already at gate ${gate.code}`, 'invalid');
    return this.send(flight, 'gate_change', { gate: gate.code }, now);
  }
}
