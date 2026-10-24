/**
 * `FLIGHT_SOURCE=vendor-api`: a live AODB vendor REST API.
 *
 * Contract expected from the vendor (adapt the two paths to the vendor's API):
 *   GET {VENDOR_API_URL}/flights?date=YYYY-MM-DD  →  JSON array of AODB rows (the same 33 columns as the snapshot)
 *
 * The snapshot is the latest response. Real-time updates are produced by polling and diffing consecutive
 * snapshots into canonical FlightEvents, so the core sees the same events as from an AIDX feed. A vendor that
 * pushes AIDX messages instead can reuse the AIDX parser (see docs/adapter-guide.md).
 */
import {
  type Flight,
  type FlightChanges,
  type FlightEvent,
  type FlightEventType,
  type FlightStatus,
} from '@arm/domain';

import type { FeedClock, FeedHealth, FlightSource } from '../contracts.js';
import { FeedStats } from '../feed-support.js';
import { parseAodbJson } from '../parsers/aodb.js';
import { type HttpEndpoint, httpGet } from './http.js';

export interface VendorFlightSourceOptions {
  endpoint: HttpEndpoint;
  pollIntervalMs: number;
  clock: FeedClock;
}

const TRACKED = [
  'estimatedTime',
  'estimatedRunwayTime',
  'actualRunwayTime',
  'actualBlockTime',
  'tobt',
  'tsat',
  'stand',
  'gate',
  'baggageBelt',
  'pax',
  'status',
  'delayCodes',
] as const satisfies readonly (keyof FlightChanges)[];

const STATUS_EVENT: ReadonlyMap<FlightStatus, FlightEventType> = new Map([
  ['cancelled', 'cancelled'],
  ['boarding', 'boarding'],
  ['gate_closed', 'gate_closed'],
  ['departed', 'off_block'],
  ['landed', 'landed'],
  ['arrived', 'on_block'],
  ['delayed', 'delay'],
]);

/** The changes between two versions of a flight, as one canonical event (or null when nothing changed). */
export function diffFlights(before: Flight, after: Flight, at: string, seq: number): FlightEvent | null {
  const changes: FlightChanges = {};
  for (const field of TRACKED) {
    const a = JSON.stringify(Reflect.get(before, field));
    const b = JSON.stringify(Reflect.get(after, field));
    if (a !== b) Object.assign(changes, { [field]: Reflect.get(after, field) });
  }
  if (Object.keys(changes).length === 0) return null;
  const type: FlightEventType =
    (changes.status ? STATUS_EVENT.get(changes.status) : undefined) ??
    (changes.gate !== undefined ? 'gate_change' : changes.stand !== undefined ? 'stand_change' : 'estimate');
  return {
    id: `vendor-${after.id}-${seq}`,
    flightId: after.id,
    type,
    occurredAt: after.lastUpdate || at,
    changes,
    sequence: seq,
    source: { source: 'vendor-api', ref: after.sourceFlightId ?? after.id, receivedAt: at },
  };
}

export class VendorApiFlightSource implements FlightSource {
  readonly adapter = 'vendor-api';
  private readonly aodbStats = new FeedStats('aodb', this.adapter);
  private readonly updateStats = new FeedStats('aidx', this.adapter);
  private sequence = 0;

  constructor(private readonly opts: VendorFlightSourceOptions) {}

  private async fetchFlights(at: Date): Promise<Flight[]> {
    const date = at.toISOString().slice(0, 10);
    try {
      const body = await httpGet(this.opts.endpoint, ['flights'], new Map([['date', date]]));
      const { flights, errors } = parseAodbJson(body, this.opts.clock.now().toISOString());
      for (const e of errors) this.aodbStats.rejectedMessage(`row ${e.row}: ${e.reason}`);
      this.aodbStats.received(this.opts.clock.now(), flights.length);
      return flights;
    } catch (err) {
      this.aodbStats.unavailable((err as Error).message);
      throw err;
    }
  }

  async snapshot(at: Date): Promise<Flight[]> {
    return this.fetchFlights(at);
  }

  async *stream(from: Date, signal: AbortSignal): AsyncIterable<FlightEvent> {
    let previous = new Map((await this.fetchFlights(from)).map((f) => [f.id, f]));
    while (!signal.aborted) {
      await this.opts.clock.sleepUntil(
        new Date(this.opts.clock.now().getTime() + this.opts.pollIntervalMs),
        signal,
      );
      if (signal.aborted) return;
      let current: Map<string, Flight>;
      try {
        current = new Map((await this.fetchFlights(this.opts.clock.now())).map((f) => [f.id, f]));
      } catch {
        continue; // recorded in feed health; retry on the next poll
      }
      const at = this.opts.clock.now().toISOString();
      for (const [id, after] of current) {
        const before = previous.get(id);
        if (!before) continue;
        this.sequence += 1;
        const event = diffFlights(before, after, at, this.sequence);
        if (event) {
          this.updateStats.received(this.opts.clock.now());
          yield event;
        }
      }
      previous = current;
    }
  }

  health(): FeedHealth[] {
    return [this.aodbStats.health(), this.updateStats.health()];
  }
}
