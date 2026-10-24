/**
 * The simulation: owns the clock and runs the simulated world on it.
 *
 * - Start-up: load flights, profiles and queues at the start time; start the feeds; start the minute tick.
 * - Every simulated minute: screen heartbeats, incident rules, feed health.
 * - Clock jumps: the feeds restart from the new time. Jumping back also discards everything recorded after
 *   the new time (flight updates, queue readings, decisions, plays, codes, redemptions, incidents), so the
 *   world stays consistent; injections made after it are discarded by the feed.
 * - The operating day ends at 01:00 the next day; the clock then wraps to the loop start time.
 */
import { gt } from 'drizzle-orm';

import { localToUtc } from '@arm/domain';
import { calendarDay } from '@arm/mockgen';

import type { Sources } from '../adapters/registry.js';
import { ClaimService } from '../claims/claim.service.js';
import { type AppConfig, publicBaseUrl } from '../config.js';
import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import { createRanker } from '../engine/ai/registry.js';
import { Catalog } from '../engine/catalog.js';
import { DecisionEngine } from '../engine/decision-engine.js';
import type { EventBus } from './event-bus.js';
import { IncidentTracker } from './incidents.js';
import { Ingestion, type LogSink } from './ingestion.js';
import { Injectors } from './injectors.js';
import { LiveState } from './live-state.js';
import { ScreenFleet } from './screens.js';
import { type ClockChange, SimClock } from './sim-clock.js';

const parseHm = (hm: string): [number, number] => {
  const [h, m] = hm.split(':').map(Number);
  return [h ?? 0, m ?? 0];
};

export class Simulation {
  readonly clock: SimClock;
  readonly state = new LiveState();
  readonly fleet: ScreenFleet;
  readonly incidents: IncidentTracker;
  readonly injectors: Injectors;
  readonly engine: DecisionEngine;
  readonly claims: ClaimService;
  private readonly ingestion: Ingestion;
  private tickController: AbortController | undefined;
  private tickLoop: Promise<void> | undefined;
  private intervals: ReturnType<typeof setInterval>[] = [];
  /** Clock changes are handled one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private screenNames = new Map<string, string>();
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
    readonly sources: Sources,
    readonly bus: EventBus,
    clock: SimClock,
    private readonly log: LogSink,
  ) {
    this.clock = clock;
    this.fleet = new ScreenFleet(database, bus, config.SIM_SEED);
    this.incidents = new IncidentTracker(database, bus);
    this.injectors = new Injectors(sources.flights, this.state, () => this.engine.catalog.layout());
    this.ingestion = new Ingestion(database, sources, this.state, bus, clock, log);
    this.engine = new DecisionEngine(
      database,
      new Catalog(database),
      this.state,
      bus,
      clock,
      createRanker(config),
      {
        raiseIncident: (input, at) => this.incidents.raise(input, at),
        screenStatus: (id) => {
          const s = this.fleet.get(id);
          return s ? { status: s.status, lastHeartbeat: s.lastHeartbeat } : undefined;
        },
        log: (m) => this.log.log(m),
        warn: (m) => this.log.warn(m),
      },
      {
        slotSeconds: config.SLOT_SECONDS,
        utcOffsetMinutes: config.AIRPORT_UTC_OFFSET_MINUTES,
        simDate: config.SIM_DATE,
        festival: calendarDay(config.SIM_DATE).festival,
        seed: config.SIM_SEED,
      },
    );
    this.claims = new ClaimService(database, this.engine, bus, clock, (origin) =>
      publicBaseUrl(config, origin),
    );
  }

  /** Clock bounds and start time for a configuration. */
  static clockSettings(config: AppConfig) {
    const offset = config.AIRPORT_UTC_OFFSET_MINUTES;
    const [sh, sm] = parseHm(config.SIM_START_TIME);
    const dayStart = localToUtc(config.SIM_DATE, 0, 0, offset);
    return {
      start: localToUtc(config.SIM_DATE, sh, sm, offset),
      bounds: { start: dayStart, end: new Date(dayStart.getTime() + 25 * 3600_000) },
    };
  }

  startTime(): Date {
    return Simulation.clockSettings(this.config).start;
  }

  loopStartTime(): Date {
    const [h, m] = parseHm(this.config.SIM_LOOP_START_TIME);
    return localToUtc(this.config.SIM_DATE, h, m, this.config.AIRPORT_UTC_OFFSET_MINUTES);
  }

  async start(): Promise<void> {
    const now = this.clock.now();
    const screens = await this.database.db.select({ id: t.screens.id, name: t.screens.name }).from(t.screens);
    this.screenNames = new Map(screens.map((s) => [s.id, s.name]));
    await this.incidents.init();
    this.incidents.noteJump(now);
    // A restart begins at the configured start time: anything an earlier run recorded after it is the future.
    await this.rewindData(now);
    await this.ingestion.load(now);
    await this.fleet.load(now);
    await this.engine.load(now);
    this.ingestion.start(now);
    this.engine.start(now);
    this.startTicks();
    this.clock.onChange((change) => this.onClockChange(change));
    this.intervals.push(
      setInterval(() => this.bus.publish('clock', this.clock.state()), 1000),
      setInterval(() => this.bus.publish('feeds', this.sources.health()), 3000),
    );
    for (const i of this.intervals) i.unref?.();
    this.running = true;
    this.bus.publish('clock', this.clock.state());
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    this.tickController?.abort();
    await this.tickLoop;
    await this.engine.stop();
    await this.ingestion.stop();
    this.clock.dispose();
  }

  get isRunning(): boolean {
    return this.running;
  }

  private startTicks(): void {
    const controller = new AbortController();
    this.tickController = controller;
    this.tickLoop = this.runTicks(controller.signal);
  }

  private async runTicks(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = this.clock.now();
      const nextMinute = new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000);
      await this.clock.sleepUntil(nextMinute, signal);
      if (signal.aborted) return;
      try {
        await this.tick(this.clock.now());
      } catch (err) {
        this.log.error(`Simulation tick failed: ${(err as Error).message}`);
      }
    }
  }

  /** One simulated minute. */
  async tick(now: Date): Promise<void> {
    if (now.getTime() >= this.clock.bounds.end.getTime()) {
      this.log.log('Operating day ended; wrapping to the loop start time');
      this.clock.jump(this.loopStartTime());
      return;
    }
    await this.fleet.tick(now);
    await this.incidents.evaluate(now, this.fleet.all(), this.screenNames, this.sources.health());
  }

  private onClockChange(change: ClockChange): void {
    this.bus.publish('clock', this.clock.state());
    this.bus.publish('sim', {
      action: change.kind,
      detail: change.kind === 'jump' ? { to: change.to.toISOString(), backwards: change.backwards } : {},
      at: this.clock.now().toISOString(),
    });
    if (change.kind !== 'jump') return;
    this.incidents.noteJump(change.to);
    this.queue = this.queue
      .then(() => this.afterJump(change.to, change.backwards))
      .catch((err: unknown) => {
        this.log.error(`Could not move the simulation: ${(err as Error).message}`);
      });
  }

  private async afterJump(to: Date, backwards: boolean): Promise<void> {
    this.tickController?.abort();
    await this.tickLoop;
    await this.engine.stop();
    await this.ingestion.stop();
    if (backwards) await this.rewindData(to);
    await this.ingestion.load(to);
    if (backwards) await this.fleet.load(to);
    await this.engine.load(to);
    this.claims.reset();
    this.ingestion.start(to);
    this.engine.start(to);
    this.startTicks();
  }

  /**
   * Let an injected flight event take effect now: wait until ingestion has applied it (it travels through the
   * flight adapter like any AIDX message), then re-plan the screens it affects.
   */
  async settleInjection(eventId: string): Promise<void> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !this.state.recentEvents(200).some((e) => e.id === eventId))
      await new Promise((resolve) => setTimeout(resolve, 5));
    await this.engine.replanNow();
  }

  /** Wait until pending clock changes have been applied (API calls return once the world has moved). */
  settled(): Promise<void> {
    return this.queue;
  }

  private async rewindData(to: Date): Promise<void> {
    const { db } = this.database;
    await db.delete(t.flightEvents).where(gt(t.flightEvents.occurredAt, to));
    await db.delete(t.queueMeasurements).where(gt(t.queueMeasurements.measuredAt, to));
    await db.delete(t.zonePresence).where(gt(t.zonePresence.windowStart, to));
    await db.delete(t.decisions).where(gt(t.decisions.slotStart, to));
    await db.delete(t.impressions).where(gt(t.impressions.playedAt, to));
    await db.delete(t.redemptions).where(gt(t.redemptions.redeemedAt, to));
    await db.delete(t.promoCodes).where(gt(t.promoCodes.issuedAt, to));
    await db.delete(t.claimLinks).where(gt(t.claimLinks.createdAt, to));
    await this.engine.rewind(to);
    await this.incidents.truncateAfter(to);
  }

  /**
   * The challenge's worked example: Gate 42 at 14:10, paused, every screen online, the learning model back to
   * its seeded state. The Gate 42 screen then plays the duty-free perfume offer at 0.86.
   */
  async workedExample(localHour = 14, localMinute = 10): Promise<Date> {
    const target = localToUtc(
      this.config.SIM_DATE,
      localHour,
      localMinute,
      this.config.AIRPORT_UTC_OFFSET_MINUTES,
    );
    this.clock.pause();
    this.clock.setSpeed(1);
    this.sources.flights.discardInjections?.(target);
    this.clock.jump(target);
    await this.settled();
    this.queue = this.queue.then(async () => {
      await this.engine.stop();
      await this.fleet.load(target);
      await this.engine.resetModel(target);
      await this.engine.load(target);
      this.engine.start(target);
    });
    await this.settled();
    // Return once every screen has decided, so the scenario shows complete (bounded, in case of load).
    await Promise.race([this.engine.ready(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
    this.bus.publish('sim', {
      action: 'worked_example',
      detail: { at: target.toISOString() },
      at: target.toISOString(),
    });
    return target;
  }

  /** Back to the configured start time, playing at the configured speed. */
  async reset(): Promise<void> {
    this.clock.setSpeed(this.config.SIM_SPEED);
    this.clock.jump(this.startTime());
    await this.settled();
    await this.fleet.load(this.clock.now());
    if (this.config.SIM_AUTOPLAY) this.clock.play();
    this.bus.publish('sim', { action: 'reset', detail: {}, at: this.clock.now().toISOString() });
  }

  screenName(id: string): string | undefined {
    return this.screenNames.get(id);
  }
}
