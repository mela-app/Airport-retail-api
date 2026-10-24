/**
 * Screen fleet runtime: heartbeats, latency and status for the ~180 screens.
 *
 * Every simulated minute each screen reports a heartbeat with its render latency. A small, seeded share of
 * screens degrades for a while (slow player, network) and recovers on its own, so the network map looks like
 * a real network. "Screen goes offline" from the simulation controls forces a screen offline until it is
 * restored. Status changes are persisted and published; heartbeats stay in memory.
 */
import { eq } from 'drizzle-orm';

import { Rng } from '@arm/mockgen';

import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import type { EventBus, ScreenRuntime } from './event-bus.js';
import { InjectionError } from './injectors.js';

/** Chance per screen per simulated minute that a healthy screen starts degrading. */
const DEGRADE_PER_MINUTE = 0.0004;

export class ScreenFleet {
  private readonly screens = new Map<string, ScreenRuntime & { recoverAt: number | null }>();
  private rng: Rng;

  constructor(
    private readonly database: Database,
    private readonly bus: EventBus,
    private readonly seed: string,
  ) {
    this.rng = new Rng(`${seed}:screens`);
  }

  /** Load the fleet from the database; every screen starts online. */
  async load(at: Date): Promise<void> {
    const rows = await this.database.db.select({ id: t.screens.id }).from(t.screens);
    this.screens.clear();
    this.rng = new Rng(`${this.seed}:screens:${at.toISOString()}`);
    for (const { id } of rows) {
      this.screens.set(id, {
        id,
        status: 'online',
        since: at.toISOString(),
        latencyMs: Math.round(this.rng.normal(110, 25, 40, 400)),
        lastHeartbeat: at.toISOString(),
        forced: false,
        recoverAt: null,
      });
    }
    await this.database.db.update(t.screens).set({ status: 'online', statusSince: at, lastHeartbeat: at });
  }

  /** A screen installed while the simulation runs. */
  add(id: string, at: Date): void {
    if (this.screens.has(id)) return;
    this.screens.set(id, {
      id,
      status: 'online',
      since: at.toISOString(),
      latencyMs: Math.round(this.rng.normal(110, 25, 40, 400)),
      lastHeartbeat: at.toISOString(),
      forced: false,
      recoverAt: null,
    });
  }

  /** One simulated minute: heartbeats, random degradation and recovery. */
  async tick(now: Date): Promise<void> {
    for (const screen of this.screens.values()) {
      if (screen.forced) continue;
      if (screen.status === 'degraded' && screen.recoverAt !== null && now.getTime() >= screen.recoverAt) {
        await this.setStatus(screen, 'online', now, false);
      } else if (screen.status === 'online' && this.rng.chance(DEGRADE_PER_MINUTE)) {
        screen.recoverAt = now.getTime() + this.rng.int(8, 30) * 60_000;
        await this.setStatus(screen, 'degraded', now, false);
      }
      if (screen.status !== 'offline') {
        const base = screen.status === 'degraded' ? 900 : 110;
        screen.latencyMs = Math.round(this.rng.normal(base, base * 0.25, 30, 5000));
        screen.lastHeartbeat = now.toISOString();
      }
    }
  }

  async forceOffline(id: string, now: Date): Promise<ScreenRuntime> {
    const screen = this.require(id);
    await this.setStatus(screen, 'offline', now, true);
    return this.view(screen);
  }

  async restore(id: string, now: Date): Promise<ScreenRuntime> {
    const screen = this.require(id);
    screen.recoverAt = null;
    await this.setStatus(screen, 'online', now, false);
    screen.lastHeartbeat = now.toISOString();
    return this.view(screen);
  }

  private require(id: string) {
    const screen = this.screens.get(id);
    if (!screen) throw new InjectionError(`unknown screen ${id}`, 'not_found');
    return screen;
  }

  private async setStatus(
    screen: ScreenRuntime & { recoverAt: number | null },
    status: ScreenRuntime['status'],
    now: Date,
    forced: boolean,
  ): Promise<void> {
    screen.status = status;
    screen.since = now.toISOString();
    screen.forced = forced;
    if (status === 'offline') screen.latencyMs = null;
    await this.database.db
      .update(t.screens)
      .set({
        status,
        statusSince: now,
        lastHeartbeat: screen.lastHeartbeat ? new Date(screen.lastHeartbeat) : null,
      })
      .where(eq(t.screens.id, screen.id));
    this.bus.publish('screen', this.view(screen));
  }

  private view(screen: ScreenRuntime & { recoverAt: number | null }): ScreenRuntime {
    const { recoverAt: _recoverAt, ...rest } = screen;
    return { ...rest };
  }

  get(id: string): ScreenRuntime | undefined {
    const s = this.screens.get(id);
    return s ? this.view(s) : undefined;
  }

  all(): ScreenRuntime[] {
    return [...this.screens.values()].map((s) => this.view(s));
  }

  /** Mean latency of screens that are not offline. */
  averageLatencyMs(): number | null {
    const values = [...this.screens.values()].map((s) => s.latencyMs).filter((v): v is number => v !== null);
    return values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  }
}
