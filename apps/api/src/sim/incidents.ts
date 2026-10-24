/**
 * Incident and bug tracker: alerts raised automatically from the simulated operation, with severity, owner
 * and status, plus manual updates (acknowledge, assign, resolve).
 *
 * Automatic rules (evaluated every simulated minute):
 * - screen_offline: a screen has been offline for more than 5 minutes (resolved when it is back).
 * - feed_lag: a feed is down, or has sent nothing for longer than its lag threshold (resolved when fresh).
 * - failed_creative: raised by the delivery engine when a creative cannot be rendered.
 */
import { desc, eq, gt, ne } from 'drizzle-orm';

import type { FeedHealth, FeedName } from '../adapters/contracts.js';
import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import type { EventBus, IncidentView, ScreenRuntime } from './event-bus.js';

export const SCREEN_OFFLINE_THRESHOLD_MIN = 5;

/** Simulated minutes without a message before a feed counts as lagging. */
export const FEED_LAG_THRESHOLD_MIN: ReadonlyMap<FeedName, number> = new Map([
  ['aidx', 20],
  ['acris', 15],
]);

export const DEFAULT_OWNERS: ReadonlyMap<IncidentView['kind'], string> = new Map([
  ['screen_offline', 'Network Operations'],
  ['feed_lag', 'Integration Support'],
  ['failed_creative', 'Ad Operations'],
]);

type Row = typeof t.incidents.$inferSelect;

const toView = (r: Row): IncidentView => ({
  id: r.id,
  kind: r.kind as IncidentView['kind'],
  severity: r.severity as IncidentView['severity'],
  title: r.title,
  subject: r.subject,
  owner: r.owner,
  status: r.status as IncidentView['status'],
  raisedAt: r.raisedAt.toISOString(),
  resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  details: r.details as Record<string, unknown>,
});

export interface IncidentUpdate {
  status?: IncidentView['status'];
  owner?: string | null;
}

const key = (kind: string, subject: string) => `${kind}|${subject}`;

export class IncidentTracker {
  private counter = 0;
  /** Unresolved incidents by kind and subject (the rules run every simulated minute; no query per check). */
  private readonly open = new Map<string, Row>();

  constructor(
    private readonly database: Database,
    private readonly bus: EventBus,
  ) {}

  /** Load unresolved incidents and the id counter from the database. */
  async init(): Promise<void> {
    this.open.clear();
    const rows = await this.database.db.select().from(t.incidents).where(ne(t.incidents.status, 'resolved'));
    for (const r of rows) this.open.set(key(r.kind, r.subject), r);
    const all = await this.database.db.select({ id: t.incidents.id }).from(t.incidents);
    this.counter = all.length;
  }

  private openFor(kind: IncidentView['kind'], subject: string): Row | undefined {
    return this.open.get(key(kind, subject));
  }

  async raise(
    input: {
      kind: IncidentView['kind'];
      severity: IncidentView['severity'];
      title: string;
      subject: string;
      details: Record<string, unknown>;
    },
    now: Date,
  ): Promise<IncidentView> {
    const existing = this.openFor(input.kind, input.subject);
    if (existing) return toView(existing);
    this.counter += 1;
    const id = `INC-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(this.counter).padStart(4, '0')}`;
    const row: Row = {
      id,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      subject: input.subject,
      owner: DEFAULT_OWNERS.get(input.kind) ?? null,
      status: 'open',
      raisedAt: now,
      resolvedAt: null,
      details: input.details,
    };
    await this.database.db.insert(t.incidents).values(row).onConflictDoNothing();
    this.open.set(key(row.kind, row.subject), row);
    const view = toView(row);
    this.bus.publish('incident', view);
    return view;
  }

  async resolveFor(kind: IncidentView['kind'], subject: string, now: Date, note: string): Promise<void> {
    const open = this.openFor(kind, subject);
    if (!open) return;
    this.open.delete(key(kind, subject));
    const details = { ...(open.details as Record<string, unknown>), resolution: note };
    await this.database.db
      .update(t.incidents)
      .set({ status: 'resolved', resolvedAt: now, details })
      .where(eq(t.incidents.id, open.id));
    this.bus.publish('incident', toView({ ...open, status: 'resolved', resolvedAt: now, details }));
  }

  async update(id: string, change: IncidentUpdate, now: Date): Promise<IncidentView | undefined> {
    const [row] = await this.database.db.select().from(t.incidents).where(eq(t.incidents.id, id));
    if (!row) return undefined;
    const next: Row = {
      ...row,
      ...(change.owner !== undefined ? { owner: change.owner } : {}),
      ...(change.status
        ? { status: change.status, resolvedAt: change.status === 'resolved' ? now : null }
        : {}),
    };
    await this.database.db.update(t.incidents).set(next).where(eq(t.incidents.id, id));
    if (next.status === 'resolved') this.open.delete(key(next.kind, next.subject));
    else this.open.set(key(next.kind, next.subject), next);
    const view = toView(next);
    this.bus.publish('incident', view);
    return view;
  }

  async list(filter: { status?: IncidentView['status'] | 'active'; limit: number }): Promise<IncidentView[]> {
    const rows = await this.database.db
      .select()
      .from(t.incidents)
      .orderBy(desc(t.incidents.raisedAt))
      .limit(500);
    return rows
      .map(toView)
      .filter(
        (i) =>
          !filter.status ||
          (filter.status === 'active' ? i.status !== 'resolved' : i.status === filter.status),
      )
      .slice(0, filter.limit);
  }

  /** Remove incidents raised after `at` (when the clock jumps back) and reopen nothing. */
  async truncateAfter(at: Date): Promise<void> {
    await this.database.db.delete(t.incidents).where(gt(t.incidents.raisedAt, at));
    await this.init();
  }

  /** Simulation time of the last clock jump: feed lag is measured from it at the earliest. */
  private jumpedAt = 0;

  /** After a jump in time, feeds get a fresh grace period instead of looking silent since before the jump. */
  noteJump(at: Date): void {
    this.jumpedAt = at.getTime();
  }

  /** Evaluate the automatic rules. */
  async evaluate(
    now: Date,
    screens: readonly ScreenRuntime[],
    names: ReadonlyMap<string, string>,
    feeds: readonly FeedHealth[],
  ): Promise<void> {
    for (const s of screens) {
      const offlineMin = s.status === 'offline' ? (now.getTime() - Date.parse(s.since)) / 60_000 : 0;
      if (s.status === 'offline' && offlineMin >= SCREEN_OFFLINE_THRESHOLD_MIN) {
        await this.raise(
          {
            kind: 'screen_offline',
            severity: 'high',
            title: `${names.get(s.id) ?? s.id} offline for more than ${SCREEN_OFFLINE_THRESHOLD_MIN} min`,
            subject: s.id,
            details: { offlineSince: s.since, forced: s.forced },
          },
          now,
        );
      } else if (s.status !== 'offline') {
        await this.resolveFor('screen_offline', s.id, now, `screen back ${s.status}`);
      }
    }
    for (const f of feeds) {
      const threshold = FEED_LAG_THRESHOLD_MIN.get(f.feed);
      // A feed that has not delivered anything yet is not lagging (it is either starting or reported down).
      const lagMin = f.lastMessageAt
        ? (now.getTime() - Math.max(Date.parse(f.lastMessageAt), this.jumpedAt)) / 60_000
        : 0;
      const lagging = f.status === 'down' || (threshold !== undefined && lagMin > threshold);
      const subject = `feed:${f.feed}`;
      if (lagging) {
        await this.raise(
          {
            kind: 'feed_lag',
            severity: f.status === 'down' ? 'critical' : 'medium',
            title:
              f.status === 'down'
                ? `${f.feed.toUpperCase()} feed unavailable`
                : `${f.feed.toUpperCase()} feed silent for ${Math.round(lagMin)} min`,
            subject,
            details: { adapter: f.adapter, lastMessageAt: f.lastMessageAt, lastError: f.lastError },
          },
          now,
        );
      } else {
        await this.resolveFor('feed_lag', subject, now, 'feed messages flowing again');
      }
    }
  }
}
