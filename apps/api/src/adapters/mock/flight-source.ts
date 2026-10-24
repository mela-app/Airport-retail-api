/**
 * `FLIGHT_SOURCE=mock-aidx`: the simulated AODB + AIDX feed.
 *
 * - Snapshot: the AODB start-of-day file (CSV or JSON, the sample's 33 columns), parsed by the AODB adapter.
 * - Real-time: the day's AIDX FlightLegNotifRQ messages (aidx/stream.ndjson), each parsed by the AIDX adapter
 *   from its XML and released when the simulation clock reaches its timestamp.
 * - Injection: simulation controls publish AIDX XML into the same feed; it goes through the same parser and
 *   takes effect at the current clock time. Like a real AODB, the feed then re-times what follows: after an
 *   injected delay, the flight's later milestones (boarding, gate close, off-block, airborne) move by the same
 *   amount; after an injected gate change, later messages carry the new gate.
 *
 * The feed serves one active stream at a time; starting a new stream (e.g. after the clock jumps back)
 * replays from that point and discards injections made after it.
 *
 * Only the XML of each stream entry is interpreted; the generator's index fields are not trusted.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Flight,
  type FlightEvent,
  type FlightEventType,
  applyFlightEvent,
  isoMinute,
} from '@arm/domain';

import type { FeedClock, FeedHealth, FlightSource } from '../contracts.js';
import { FeedStats, type Timed } from '../feed-support.js';
import { type AidxLeg, parseAidxMessage } from '../parsers/aidx.js';
import { parseAodbCsv, parseAodbJson } from '../parsers/aodb.js';

export interface MockFlightSourceOptions {
  /** Directory of one generated day (contains `aodb/` and `aidx/`). */
  dayDir: string;
  homeAirport: string;
  clock: FeedClock;
}

interface StreamLine {
  at: string;
  xml: string;
}

/** Milestones that move when a flight's estimate moves. */
const RETIMED: ReadonlySet<FlightEventType> = new Set([
  'boarding',
  'gate_closed',
  'off_block',
  'airborne',
  'landed',
  'on_block',
]);

function readSnapshot(dir: string): { flights: Flight[]; rejected: string[] } {
  const files = readdirSync(dir);
  const csv = files.find((f) => f.endsWith('_start-of-day.csv'));
  const json = files.find((f) => f.endsWith('_start-of-day.json'));
  const name = csv ?? json;
  if (!name) throw new Error(`no AODB start-of-day snapshot in ${dir}`);
  const text = readFileSync(join(dir, name), 'utf8');
  const receivedAt = new Date(0).toISOString();
  const result = csv ? parseAodbCsv(text, receivedAt) : parseAodbJson(text, receivedAt);
  return { flights: result.flights, rejected: result.errors.map((e) => `row ${e.row}: ${e.reason}`) };
}

const INJECTED_SUFFIX = '#injected-';
/** Injected messages get ids with this suffix (see `inject`), so they never collide with published ones. */
const isInjected = (id: string): boolean => id.includes(INJECTED_SUFFIX);

const shift = (iso: string | null | undefined, ms: number): string | null | undefined =>
  iso ? isoMinute(new Date(Date.parse(iso) + ms)) : iso;

/** The event moved by `ms`: its time and the actual times it reports. */
function retime(event: FlightEvent, ms: number): FlightEvent {
  const c = event.changes;
  return {
    ...event,
    occurredAt: isoMinute(new Date(Date.parse(event.occurredAt) + ms)),
    changes: {
      ...c,
      ...(c.actualBlockTime ? { actualBlockTime: shift(c.actualBlockTime, ms) } : {}),
      ...(c.actualRunwayTime ? { actualRunwayTime: shift(c.actualRunwayTime, ms) } : {}),
    },
  };
}

export class MockAidxFlightSource implements FlightSource {
  readonly adapter = 'mock-aidx';
  private readonly base: ReadonlyMap<string, Flight>;
  /** The day's messages as published by the (simulated) AODB, sorted by time. Never modified. */
  private readonly original: Timed<FlightEvent>[] = [];
  /** Messages injected through simulation controls, in injection order. */
  private injections: Timed<FlightEvent>[] = [];
  /** The timeline the active stream replays: original messages with injections applied. */
  private live: Timed<FlightEvent>[] = [];
  private wakeStream: (() => void) | undefined;
  /** Injected messages a stream has actually delivered (so a restarted stream neither repeats nor drops them). */
  private readonly deliveredInjections = new Set<string>();
  private injectionCount = 0;
  private readonly aodbStats = new FeedStats('aodb', this.adapter);
  private readonly aidxStats = new FeedStats('aidx', this.adapter);

  constructor(private readonly opts: MockFlightSourceOptions) {
    const { flights, rejected } = readSnapshot(join(opts.dayDir, 'aodb'));
    this.base = new Map(flights.map((f) => [f.id, f]));
    this.aodbStats.received(opts.clock.now(), flights.length);
    for (const reason of rejected) this.aodbStats.rejectedMessage(reason);

    const lines = readFileSync(join(opts.dayDir, 'aidx', 'stream.ndjson'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as StreamLine;
        const event = parseAidxMessage(entry.xml, {
          homeAirport: opts.homeAirport,
          receivedAt: entry.at,
          resolveFlightId: (leg) => this.resolve(leg),
        });
        this.original.push({ at: Date.parse(event.occurredAt), value: event });
      } catch (err) {
        this.aidxStats.rejectedMessage((err as Error).message);
      }
    }
    this.original.sort((a, b) => a.at - b.at);
    this.live = this.buildTimeline(this.injections);
  }

  /** Match a leg without a scheduled time to a known flight: same airline, number and direction, nearest to now. */
  private resolve(leg: AidxLeg): string | undefined {
    const now = this.opts.clock.now().getTime();
    let best: Flight | undefined;
    for (const f of this.base.values()) {
      if (
        f.airlineIata !== leg.airlineIata ||
        f.flightNumber !== leg.flightNumber ||
        f.direction !== leg.direction
      )
        continue;
      if (
        !best ||
        Math.abs(Date.parse(f.scheduledTime) - now) < Math.abs(Date.parse(best.scheduledTime) - now)
      )
        best = f;
    }
    return best?.id;
  }

  /** A flight's estimate at time `at` on a timeline. */
  private estimateAt(timeline: readonly Timed<FlightEvent>[], flightId: string, at: number): string | null {
    const flight = this.base.get(flightId);
    let estimate = flight ? (flight.estimatedTime ?? flight.scheduledTime) : null;
    for (const t of timeline) {
      if (t.at > at) break;
      if (t.value.flightId === flightId && t.value.changes.estimatedTime)
        estimate = t.value.changes.estimatedTime;
    }
    return estimate;
  }

  /** Insert one injection into a timeline and re-time what follows for that flight. */
  private applyInjection(timeline: Timed<FlightEvent>[], injection: Timed<FlightEvent>): void {
    const { at, value: injected } = injection;
    const previous = this.estimateAt(timeline, injected.flightId, at);
    const next = injected.changes.estimatedTime;
    const delta = next && previous ? Date.parse(next) - Date.parse(previous) : 0;
    const gate = injected.changes.gate;
    for (let i = 0; i < timeline.length; i += 1) {
      const item = timeline.at(i);
      if (!item || item.at <= at || item.value.flightId !== injected.flightId) continue;
      let value = item.value;
      let itemAt = item.at;
      if (delta !== 0 && RETIMED.has(value.type)) {
        value = retime(value, delta);
        itemAt += delta;
      }
      if (gate && value.changes.gate !== undefined) value = { ...value, changes: { ...value.changes, gate } };
      if (value !== item.value) timeline.splice(i, 1, { at: itemAt, value });
    }
    timeline.push({ at, value: injected });
    timeline.sort((a, b) => a.at - b.at);
  }

  private buildTimeline(injections: readonly Timed<FlightEvent>[]): Timed<FlightEvent>[] {
    const timeline = this.original.map((t) => ({ at: t.at, value: t.value }));
    for (const injection of injections) this.applyInjection(timeline, injection);
    return timeline;
  }

  async snapshot(at: Date): Promise<Flight[]> {
    const cutoff = at.getTime();
    const timeline = this.buildTimeline(this.injections.filter((i) => i.at <= cutoff));
    const state = new Map(this.base);
    const lastSequence = new Map<string, number>();
    for (const { at: t, value: event } of timeline) {
      if (t > cutoff) break;
      const flight = state.get(event.flightId);
      if (!flight) continue;
      // Drop out-of-order duplicates: a lower sequence number than one already applied.
      const seq = event.sequence;
      if (seq !== null && seq <= (lastSequence.get(event.flightId) ?? -1)) continue;
      if (seq !== null) lastSequence.set(event.flightId, seq);
      state.set(event.flightId, applyFlightEvent(flight, event));
    }
    return [...state.values()];
  }

  async *stream(from: Date, signal: AbortSignal): AsyncIterable<FlightEvent> {
    const start = from.getTime();
    this.injections = this.injections.filter((i) => i.at <= start);
    this.live = this.buildTimeline(this.injections);
    // Published messages up to `start` are part of the snapshot the consumer loaded. Injected messages are
    // only skipped if a stream really delivered them: one injected while the stream was restarting is sent now.
    const delivered = new Set<string>(this.deliveredInjections);
    for (const t of this.live) {
      if (t.at > start) break;
      if (!isInjected(t.value.id)) delivered.add(t.value.id);
    }
    while (!signal.aborted) {
      const next = this.live.find((t) => !delivered.has(t.value.id));
      const clock = this.opts.clock;
      if (next && next.at <= clock.now().getTime()) {
        delivered.add(next.value.id);
        if (isInjected(next.value.id)) this.deliveredInjections.add(next.value.id);
        const now = clock.now();
        this.aidxStats.received(now);
        yield { ...next.value, source: { ...next.value.source, receivedAt: now.toISOString() } };
        continue;
      }
      const wake = new AbortController();
      this.wakeStream = () => wake.abort();
      const both = AbortSignal.any([signal, wake.signal]);
      if (next) await clock.sleepUntil(new Date(next.at), both);
      else
        await new Promise<void>((resolve) => both.addEventListener('abort', () => resolve(), { once: true }));
      this.wakeStream = undefined;
    }
  }

  inject(aidxXml: string): FlightEvent {
    const now = this.opts.clock.now();
    try {
      const event = parseAidxMessage(aidxXml, {
        homeAirport: this.opts.homeAirport,
        receivedAt: now.toISOString(),
        resolveFlightId: (leg) => this.resolve(leg),
      });
      if (!this.base.has(event.flightId)) throw new Error(`unknown flight ${event.flightId}`);
      this.injectionCount += 1;
      // An injected message takes effect now, whatever timestamp or sequence number it carries, and gets
      // an id that cannot collide with the published stream.
      const effective: FlightEvent = {
        ...event,
        id: `${event.id}${INJECTED_SUFFIX}${this.injectionCount}`,
        occurredAt: now.toISOString(),
        sequence: null,
      };
      const injection = { at: now.getTime(), value: effective };
      this.injections.push(injection);
      this.applyInjection(this.live, injection);
      this.wakeStream?.();
      return effective;
    } catch (err) {
      this.aidxStats.rejectedMessage((err as Error).message);
      throw err;
    }
  }

  discardInjections(from: Date): void {
    const cutoff = from.getTime();
    this.injections = this.injections.filter((i) => i.at < cutoff);
    this.live = this.buildTimeline(this.injections);
  }

  health(): FeedHealth[] {
    return [this.aodbStats.health(), this.aidxStats.health()];
  }
}
