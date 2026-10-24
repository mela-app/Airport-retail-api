/**
 * Ingestion: moves data from the source adapters into the live state, the database and the event bus.
 *
 * - `load(at)`: the flight snapshot, crowd profiles and latest queue measurements at `at` (start-up, jumps).
 * - `start(from)`: consumes the real-time streams (flight events, queue measurements) until `stop()`.
 *
 * Each flight event is applied once (event ids are unique), persisted with the updated flight, and published.
 */
import { eq } from 'drizzle-orm';

import type { FeedClock } from '../adapters/contracts.js';
import type { Sources } from '../adapters/registry.js';
import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import { changesToRow, flightToRow, queueToRow } from './db-mapping.js';
import type { EventBus } from './event-bus.js';
import type { LiveState } from './live-state.js';

export interface LogSink {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const CHUNK = 300;
/** Simulation minutes between AODB snapshot re-syncs (a real AODB republishes its snapshot periodically). */
export const SNAPSHOT_RESYNC_MIN = 30;
/** Simulation seconds to wait before restarting a failed stream. */
const RETRY_SIM_MS = 30_000;

export class Ingestion {
  private controller: AbortController | undefined;
  private loops: Promise<void>[] = [];
  private readonly seenEvents = new Set<string>();

  constructor(
    private readonly database: Database,
    private readonly sources: Sources,
    private readonly state: LiveState,
    private readonly bus: EventBus,
    private readonly clock: FeedClock,
    private readonly log: LogSink,
  ) {}

  /** Replace the world with the sources' view at `at`. */
  async load(at: Date): Promise<number> {
    const flights = await this.sources.flights.snapshot(at);
    const profiles = await this.sources.audience.profiles(flights);
    const queues = await this.sources.space.latest(at);
    this.state.replaceFlights(flights, profiles, at);
    this.state.setQueues(queues);
    this.seenEvents.clear();

    const { db } = this.database;
    await db.delete(t.crowdProfiles);
    await db.delete(t.flights);
    for (let i = 0; i < flights.length; i += CHUNK) {
      await db.insert(t.flights).values(flights.slice(i, i + CHUNK).map(flightToRow));
    }
    const profileRows = [...profiles].map(([flightId, profile]) => ({
      flightId,
      profile,
      source: this.sources.audience.adapter,
      observedAt: at,
    }));
    for (let i = 0; i < profileRows.length; i += CHUNK) {
      await db.insert(t.crowdProfiles).values(profileRows.slice(i, i + CHUNK));
    }
    if (queues.length > 0)
      await db.insert(t.queueMeasurements).values(queues.map(queueToRow)).onConflictDoNothing();

    this.bus.publish('flights_reloaded', { at: at.toISOString(), count: flights.length });
    this.log.log(
      `Loaded ${flights.length} flights, ${profiles.size} profiles and ${queues.length} queue readings at ${at.toISOString()}`,
    );
    return flights.length;
  }

  start(from: Date): void {
    if (this.controller) throw new Error('ingestion is already running');
    const controller = new AbortController();
    this.controller = controller;
    this.loops = [
      this.flightLoop(from, controller.signal),
      this.queueLoop(from, controller.signal),
      this.resyncLoop(from, controller.signal),
    ];
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private async flightLoop(from: Date, signal: AbortSignal): Promise<void> {
    let since = from;
    while (!signal.aborted) {
      try {
        for await (const event of this.sources.flights.stream(since, signal)) {
          if (this.seenEvents.has(event.id)) continue;
          this.seenEvents.add(event.id);
          const flight = this.state.applyEvent(event);
          if (!flight) continue;
          // Publish first so screens and dashboards react at once; the database write follows.
          this.bus.publish('flight', { flight, event });
          await this.persistFlightEvent(event, flight.lastUpdate);
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        this.log.warn(`Flight stream failed (${(err as Error).message}); retrying`);
        since = this.clock.now();
        await this.clock.sleepUntil(new Date(since.getTime() + RETRY_SIM_MS), signal);
      }
    }
  }

  /**
   * Re-fetch the AODB snapshot periodically. The real-time stream stays authoritative for values; the re-sync
   * confirms the flight list (so snapshot evidence stays fresh) and reports flights the stream missed.
   */
  private async resyncLoop(from: Date, signal: AbortSignal): Promise<void> {
    let next = from.getTime() + SNAPSHOT_RESYNC_MIN * 60_000;
    while (!signal.aborted) {
      await this.clock.sleepUntil(new Date(next), signal);
      if (signal.aborted) return;
      const now = this.clock.now();
      try {
        const snapshot = await this.sources.flights.snapshot(now);
        const known = new Set(this.state.allFlights().map((f) => f.id));
        const missing = snapshot.filter((f) => !known.has(f.id)).length;
        if (missing > 0) this.log.warn(`AODB re-sync: ${missing} flights not in the live state`);
        this.state.confirmSnapshot(now);
      } catch (err) {
        this.log.warn(`AODB re-sync failed (${(err as Error).message})`);
      }
      next = now.getTime() + SNAPSHOT_RESYNC_MIN * 60_000;
    }
  }

  private async queueLoop(from: Date, signal: AbortSignal): Promise<void> {
    let since = from;
    while (!signal.aborted) {
      try {
        for await (const m of this.sources.space.stream(since, signal)) {
          this.state.recordQueue(m);
          this.bus.publish('queue', m);
          await this.database.db.insert(t.queueMeasurements).values(queueToRow(m)).onConflictDoNothing();
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        this.log.warn(`Queue stream failed (${(err as Error).message}); retrying`);
        since = this.clock.now();
        await this.clock.sleepUntil(new Date(since.getTime() + RETRY_SIM_MS), signal);
      }
    }
  }

  private async persistFlightEvent(
    event: Parameters<LiveState['applyEvent']>[0],
    lastUpdate: string,
  ): Promise<void> {
    const { db } = this.database;
    try {
      await db
        .update(t.flights)
        .set(changesToRow(event.changes, lastUpdate))
        .where(eq(t.flights.id, event.flightId));
      await db
        .insert(t.flightEvents)
        .values({ ...event, occurredAt: new Date(event.occurredAt) })
        .onConflictDoNothing();
    } catch (err) {
      // The live state stays authoritative; a failed write is logged, not fatal.
      this.log.error(`Could not persist flight event ${event.id}: ${(err as Error).message}`);
    }
  }
}
