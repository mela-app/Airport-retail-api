/**
 * The decision engine: runs the ad decision pipeline for every screen, every slot (15 simulation seconds).
 *
 *   1. Profile   crowd in front of the screen for the current 5-minute window (presence.ts)
 *   2. Filter    hard rules (scoring.ts)
 *   3. Score     deterministic scores; the AI ranks the candidates and its answer is verified (ai/)
 *   4. Rules     pins, airline priority, pacing, frequency caps, competitor separation, exploration (rules.ts)
 *   5. Choose    play the winner and log the decision with its full evidence trail
 *   6. Learn     plays, scans and redemptions update the learning model (learning.ts)
 *
 * Storage: the inputs of a screen's decisions (crowd, evidence, scores, AI verification) are stored once per
 * change as a decision context; consecutive slots playing the same campaign from the same context form one
 * decision run; plays are aggregated per screen, campaign and 5-minute window.
 */
import { and, desc, gt, gte, lte, sql } from 'drizzle-orm';

import { CreativeSchema, type Screen, floorTo, localToUtc, toLocal } from '@arm/domain';
import { Rng } from '@arm/mockgen';

import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import type { EventBus } from '../sim/event-bus.js';
import type { LiveState } from '../sim/live-state.js';
import type { SimClock } from '../sim/sim-clock.js';
import { buildRankRequest } from './ai/request.js';
import type { AiRanker } from './ai/types.js';
import { type VerificationCheck, verifyRanking } from './ai/verifier.js';
import type { Catalog } from './catalog.js';
import { type DayTotals, DayTally } from './day-tally.js';
import { buildEvidence } from './evidence.js';
import { LearningModel, type ModelSnapshot } from './learning.js';
import {
  type CrowdEstimate,
  type PresenceInputs,
  allZonePresence,
  flightGate,
  screenCrowd,
  zoneWeight,
} from './presence.js';
import { type AppliedRule, applyBusinessRules } from './rules.js';
import {
  type CandidateEvaluation,
  type ScoringContext,
  type SpendState,
  evaluateCampaigns,
} from './scoring.js';

export type DecisionMode = 'ai_verified' | 'ai_rejected' | 'rule_based' | 'manual_pin' | 'house';

export interface AiOutcome {
  provider: string;
  model: string;
  status: 'verified' | 'rejected' | 'off' | 'pending' | 'error';
  latencyMs: number | null;
  checks: VerificationCheck[];
  ranking: string[];
  rationale: string | null;
  error: string | null;
}

export interface DecisionContext {
  id: string;
  screenId: string;
  key: string;
  computedAt: string;
  windowStart: string;
  crowd: CrowdEstimate;
  candidates: CandidateEvaluation[];
  evidence: ReturnType<typeof buildEvidence>;
  ai: AiOutcome;
  /** Eligible candidates in the order used for the decision (verified AI order, or deterministic). */
  order: CandidateEvaluation[];
  /** Flights in the crowd (a change to one of them invalidates the context). Not persisted. */
  flightIds?: ReadonlySet<string>;
}

export interface DecisionRun {
  id: string;
  screenId: string;
  slotStart: string;
  slotEnd: string;
  slots: number;
  decidedAt: string;
  mode: DecisionMode;
  campaignId: string | null;
  creativeId: string | null;
  score: number | null;
  contextId: string;
  checks: VerificationCheck[];
  rules: AppliedRule[];
  reason: string;
}

export interface EngineHooks {
  /** Raise an incident (failed creative). */
  raiseIncident(
    input: {
      kind: 'failed_creative';
      severity: 'medium';
      title: string;
      subject: string;
      details: Record<string, unknown>;
    },
    at: Date,
  ): Promise<unknown>;
  /** Status and heartbeat of a screen. */
  screenStatus(screenId: string): { status: string; lastHeartbeat: string | null } | undefined;
  log(message: string): void;
  warn(message: string): void;
}

export interface EngineOptions {
  slotSeconds: number;
  utcOffsetMinutes: number;
  simDate: string;
  festival: string | null;
  seed: string;
}

/**
 * Share of a screen's crowd counted as viewers of one 15-second play, by screen kind. A passenger waiting an
 * hour near a gate screen sees about 18 plays on it (240 slots × 0.075), not every one.
 */
export const ATTENTION: ReadonlyMap<string, number> = new Map([
  ['gate_display', 0.075],
  ['totem', 0.05],
  ['video_wall', 0.1],
  ['fids_ad_panel', 0.06],
]);
export const DEGRADED_ATTENTION = 0.7;
/**
 * Expected QR scans per viewer, before the fit and performance factors. Calibrated to about 1% of departing
 * passengers redeeming an offer (~1,000 redemptions on a 900-flight day).
 */
export const SCAN_RATE = 0.0004;
/** Operating day used for budget pacing (local hours). */
export const PACING_DAY = { from: 5, to: 24 } as const;
export const RETRAIN_MINUTE = 30;
/** Remote AI calls in flight at once; beyond that, decisions stay rule-based until a slot frees up. */
export const REMOTE_AI_CONCURRENCY = 3;

const MIN = 60_000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const compact = (iso: string) => iso.slice(0, 19).replace(/[-:T]/g, '');

interface ScreenRuntimeState {
  context: DecisionContext | null;
  run: DecisionRun | null;
  lastCampaignId: string | null;
  lastCompetitorGroup: string | null;
  consecutivePlays: number;
  /** [play time, campaign] for the last hour. */
  plays: [number, string][];
  /** Whether the current context has played its first slot (exploration never pre-empts it). */
  contextPlayed: boolean;
}

interface ImpressionAgg {
  decisionId: string;
  screenId: string;
  campaignId: string;
  creativeId: string;
  windowStart: number;
  plays: number;
  viewers: number;
  cost: number;
  scans: number;
}

interface PendingRedemption {
  at: number;
  campaignId: string;
  screenId: string;
  outletId: string | null;
  segment: string;
  revenue: number;
}

export class DecisionEngine {
  readonly learning: LearningModel;
  private readonly screensState = new Map<string, ScreenRuntimeState>();
  private spend = new Map<string, SpendState>();
  private impressions = new Map<string, ImpressionAgg>();
  private pending: PendingRedemption[] = [];
  private redemptionRows: (typeof t.redemptions.$inferInsert)[] = [];
  private closedRuns: DecisionRun[] = [];
  private newContexts: DecisionContext[] = [];
  private presenceCache: { key: string; inputs: PresenceInputs } | null = null;
  private zoneCache: { key: string; zones: Map<string, CrowdEstimate> } | null = null;
  /** LiveState version the screens' contexts reflect. */
  private seenStateVersion = -1;
  /** Database writes run in the background, in order, so a slot never waits for them. */
  private writes: Promise<void> = Promise.resolve();
  private zoneWindowWritten = 0;
  private nextRetrain = 0;
  private contextCounter = 0;
  private redemptionCounter = 0;
  private remoteInFlight = 0;
  private invalidCreatives = new Map<string, string>();
  private reportedCreatives = new Set<string>();
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private processing: Promise<void> = Promise.resolve();
  /** Real milliseconds spent building each slot's playlists (all screens), most recent last. */
  private slotTimings: number[] = [];
  private skippedSlots = 0;
  /** Today's totals for KPIs (since local midnight of the simulated day). */
  private readonly today = new DayTally();

  constructor(
    private readonly database: Database,
    readonly catalog: Catalog,
    private readonly state: LiveState,
    private readonly bus: EventBus,
    private readonly clock: SimClock,
    private readonly ai: AiRanker | null,
    private readonly hooks: EngineHooks,
    private readonly opts: EngineOptions,
  ) {
    this.learning = new LearningModel(catalog.settings().segmentModelVersion);
  }

  private get slotMs(): number {
    return this.opts.slotSeconds * 1000;
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------

  /** Prepare for running from `at`: master data, spend, learning model, and fresh per-screen state. */
  async load(at: Date): Promise<void> {
    await this.catalog.reload();
    await this.catalog.reloadPins(at);
    this.validateCreatives();
    await this.loadSpend(at);
    await this.loadModel(at);
    this.screensState.clear();
    this.impressions.clear();
    this.pending = [];
    this.presenceCache = null;
    this.zoneCache = null;
    this.seenStateVersion = -1;
    this.zoneWindowWritten = 0;
    this.nextRetrain = this.nextRetrainAfter(at.getTime());
  }

  start(from: Date): void {
    if (this.controller) throw new Error('decision engine is already running');
    const controller = new AbortController();
    this.controller = controller;
    this.firstSlot = new Promise((resolve) => {
      this.markFirstSlot = resolve;
    });
    this.loop = this.run(from, controller.signal);
  }

  private firstSlot: Promise<void> = Promise.resolve();
  private markFirstSlot: () => void = () => undefined;

  /** Resolves once the first slot after `start` has been decided (every screen has a decision). */
  ready(): Promise<void> {
    return this.firstSlot;
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
    await this.loop;
    await this.processing;
    // A re-plan queued behind the last slot must finish before the state is reloaded.
    await this.serial;
    for (const s of this.screensState.values()) if (s.run) this.closedRuns.push(s.run);
    for (const s of this.screensState.values()) s.run = null;
    await this.writes;
    await this.flush(true);
  }

  private async run(from: Date, signal: AbortSignal): Promise<void> {
    let next = Math.ceil(from.getTime() / this.slotMs) * this.slotMs;
    while (!signal.aborted) {
      await this.clock.sleepUntil(new Date(next), signal);
      if (signal.aborted) return;
      const slot = Math.floor(this.clock.now().getTime() / this.slotMs) * this.slotMs;
      // If processing fell behind the clock (very high speeds), skip to the current slot instead of queueing.
      if (slot > next) this.skippedSlots += Math.round((slot - next) / this.slotMs);
      const started = performance.now();
      try {
        this.processing = this.serialize(() => this.processSlot(new Date(slot)));
        await this.processing;
        this.markFirstSlot();
        this.slotTimings.push(performance.now() - started);
        if (this.slotTimings.length > 400) this.slotTimings.splice(0, this.slotTimings.length - 400);
      } catch (err) {
        this.hooks.warn(`Decision slot ${new Date(slot).toISOString()} failed: ${(err as Error).message}`);
      }
      next = slot + this.slotMs;
    }
  }

  // ---- master data ------------------------------------------------------------------------------------------

  /** Reload campaigns, settings and pins after an edit, and re-plan the screens at once. */
  async refreshCatalog(): Promise<void> {
    await this.catalog.reload();
    await this.catalog.reloadPins(this.clock.now());
    this.validateCreatives();
    await this.replanNow();
  }

  private validateCreatives(): void {
    this.invalidCreatives = new Map();
    for (const { creatives } of this.catalog.bundles()) {
      for (const c of creatives) {
        const parsed = CreativeSchema.safeParse(c);
        if (!parsed.success)
          this.invalidCreatives.set(c.id, parsed.error.issues.at(0)?.message ?? 'invalid creative');
      }
    }
  }

  // ---- spend and model ----------------------------------------------------------------------------------------

  private localDayStart(): Date {
    return localToUtc(this.opts.simDate, 0, 0, this.opts.utcOffsetMinutes);
  }

  private async loadSpend(at: Date): Promise<void> {
    const { db } = this.database;
    const history = await db
      .select({
        campaignId: t.campaignDailyStats.campaignId,
        spend: sql<number>`sum(${t.campaignDailyStats.spend})`,
      })
      .from(t.campaignDailyStats)
      .groupBy(t.campaignDailyStats.campaignId);
    const todayRows = await db
      .select({
        campaignId: t.impressions.campaignId,
        cost: sql<number>`sum(${t.impressions.cost})`,
        plays: sql<number>`sum(${t.impressions.plays})`,
        viewers: sql<number>`sum(${t.impressions.estimatedViewers})`,
        scans: sql<number>`sum(${t.impressions.scans})`,
      })
      .from(t.impressions)
      .where(and(gte(t.impressions.playedAt, this.localDayStart()), lte(t.impressions.playedAt, at)))
      .groupBy(t.impressions.campaignId);
    const redemptionRows = await db
      .select({
        campaignId: t.redemptions.campaignId,
        n: sql<number>`count(*)`,
        revenue: sql<number>`coalesce(sum(${t.redemptions.revenue}), 0)`,
      })
      .from(t.redemptions)
      .where(and(gte(t.redemptions.redeemedAt, this.localDayStart()), lte(t.redemptions.redeemedAt, at)))
      .groupBy(t.redemptions.campaignId);
    this.spend = new Map();
    for (const h of history) this.spend.set(h.campaignId, { today: 0, total: Number(h.spend) });
    this.today.reset();
    for (const r of todayRows) {
      const s = this.spend.get(r.campaignId) ?? { today: 0, total: 0 };
      this.spend.set(r.campaignId, { today: Number(r.cost), total: s.total + Number(r.cost) });
      this.today.add(r.campaignId, {
        plays: Number(r.plays),
        viewers: Number(r.viewers),
        cost: Number(r.cost),
        scans: Number(r.scans),
      });
    }
    for (const r of redemptionRows)
      this.today.add(r.campaignId, { redemptions: Number(r.n), revenue: Number(r.revenue) });
  }

  private seedPerformance(): Map<string, number> {
    return new Map(this.catalog.campaigns().map((c) => [c.id, c.performanceIndex]));
  }

  /** Restore the model trained most recently at or before `at`, or start from the seeded performance. */
  private async loadModel(at: Date): Promise<void> {
    const [row] = await this.database.db
      .select()
      .from(t.modelVersions)
      .where(lte(t.modelVersions.trainedAt, at))
      .orderBy(desc(t.modelVersions.trainedAt))
      .limit(1);
    if (row) {
      this.learning.restore({
        version: row.version,
        trainedAt: row.trainedAt.toISOString(),
        performance: row.performance as ModelSnapshot['performance'],
        counters: row.segmentRates as ModelSnapshot['counters'],
        notes: row.notes,
      });
    } else {
      this.learning.reset(this.seedPerformance(), at);
      await this.saveModel('seeded performance from campaign set-up');
    }
  }

  /** Start the model over from the seeded performance (used by the worked-example scenario). */
  async resetModel(at: Date): Promise<void> {
    await this.database.db.delete(t.modelVersions);
    await this.database.db.delete(t.campaignSegmentStats);
    this.learning.reset(this.seedPerformance(), at);
    await this.saveModel('reset to seeded performance');
    this.screensState.clear();
    this.presenceCache = null;
  }

  private async saveModel(notes: string): Promise<void> {
    const s = this.learning.snapshot(notes);
    await this.database.db
      .insert(t.modelVersions)
      .values({
        version: s.version,
        trainedAt: new Date(s.trainedAt),
        performance: s.performance,
        segmentRates: s.counters,
        notes,
      })
      .onConflictDoUpdate({
        target: t.modelVersions.version,
        set: {
          trainedAt: new Date(s.trainedAt),
          performance: s.performance,
          segmentRates: s.counters,
          notes,
        },
      });
  }

  private nextRetrainAfter(t0: number): number {
    const hour = Math.floor(t0 / (60 * MIN)) * 60 * MIN;
    const candidate = hour + RETRAIN_MINUTE * MIN;
    return candidate > t0 ? candidate : candidate + 60 * MIN;
  }

  private async retrain(at: Date): Promise<void> {
    const changes = this.learning.retrain(at);
    await this.saveModel(
      changes.length > 0 ? `${changes.length} campaign estimates updated` : 'no campaign had enough new data',
    );
    const rows = [];
    for (const campaign of this.catalog.campaigns()) {
      for (const r of this.learning.segmentRates(campaign.id)) {
        if (r.viewers === 0) continue;
        rows.push({
          campaignId: campaign.id,
          segment: r.segment,
          viewers: r.viewers,
          scans: r.scans,
          redemptions: r.redemptions,
          revenue: 0,
        });
      }
    }
    if (rows.length > 0) {
      await this.database.db
        .insert(t.campaignSegmentStats)
        .values(rows)
        .onConflictDoUpdate({
          target: [t.campaignSegmentStats.campaignId, t.campaignSegmentStats.segment],
          set: {
            viewers: sql`excluded.viewers`,
            scans: sql`excluded.scans`,
            redemptions: sql`excluded.redemptions`,
          },
        });
    }
    this.bus.publish('model', {
      version: this.learning.version,
      trainedAt: this.learning.trainedAt,
      changes,
    });
    this.presenceCache = null;
  }

  // ---- per slot -------------------------------------------------------------------------------------------

  private presenceInputs(windowStart: number): PresenceInputs {
    const key = `${windowStart}|${this.state.version}|${this.catalog.version}`;
    if (this.presenceCache?.key !== key) {
      this.presenceCache = {
        key,
        inputs: {
          flights: this.state.allFlights(),
          profiles: this.state.profileMap(),
          queues: this.state.queueMap(),
          layout: this.catalog.layout(),
        },
      };
    }
    return this.presenceCache.inputs;
  }

  /**
   * Identifies the inputs a context was built from. The part after `#` (master data, campaigns out of budget)
   * must take effect at once; the part before it (presence window, model version) is refreshed gradually.
   */
  private contextKey(screenId: string, windowStart: number): string {
    return `${[screenId, windowStart, this.learning.version].join('|')}#${this.hardKey()}`;
  }

  private hardKey(): string {
    return `${this.catalog.version}|${this.budgetFlags()}`;
  }

  /** Changes when a campaign runs out of budget, so contexts are re-evaluated. */
  private budgetFlags(): string {
    let flags = '';
    for (const { campaign } of this.catalog.bundles()) {
      const s = this.spend.get(campaign.id);
      flags += s && (s.today >= campaign.budget.dailyCap || s.total >= campaign.budget.total) ? '1' : '0';
    }
    return flags;
  }

  /** Zone presence for the window, computed once and shared by every screen outside a gate area. */
  private zoneEstimates(windowStart: number, inputs: PresenceInputs): Map<string, CrowdEstimate> {
    const key = `${windowStart}|${this.state.version}`;
    if (this.zoneCache?.key !== key)
      this.zoneCache = { key, zones: allZonePresence(inputs, new Date(windowStart)) };
    return this.zoneCache.zones;
  }

  /**
   * Screens whose crowd changed because flights changed since the last slot: screens in zones where a changed
   * flight is present, screens at its gate, and screens whose current crowd includes it. `null` = all screens.
   */
  private dirtyScreens(windowStart: number): Set<string> | null {
    const changed = this.state.changedSince(this.seenStateVersion);
    this.seenStateVersion = this.state.version;
    if (changed === null) return null;
    const dirty = new Set<string>();
    if (changed.size === 0) return dirty;
    const at = new Date(windowStart);
    const zones = new Set<string>();
    for (const id of changed) {
      const f = this.state.flight(id);
      if (!f) continue;
      const layout = this.catalog.layout();
      const gate = flightGate(f, layout);
      if (gate) zones.add(gate.zoneId);
      for (const z of layout.zones) if (zoneWeight(f, z, at, layout) > 0) zones.add(z.id);
    }
    for (const screen of this.catalog.screens()) if (zones.has(screen.zoneId)) dirty.add(screen.id);
    for (const [screenId, st] of this.screensState) {
      const ids = st.context?.flightIds;
      if (ids && [...changed].some((id) => ids.has(id))) dirty.add(screenId);
    }
    return dirty;
  }

  private screenState(screenId: string): ScreenRuntimeState {
    let s = this.screensState.get(screenId);
    if (!s) {
      s = {
        context: null,
        run: null,
        lastCampaignId: null,
        lastCompetitorGroup: null,
        consecutivePlays: 0,
        plays: [],
        contextPlayed: false,
      };
      this.screensState.set(screenId, s);
    }
    return s;
  }

  async processSlot(slot: Date): Promise<void> {
    const t0 = slot.getTime();
    const windowStart = floorTo(slot, 5).getTime();
    const inputs = this.presenceInputs(windowStart);
    if (windowStart > this.zoneWindowWritten) await this.writeZonePresence(new Date(windowStart), inputs);
    if (t0 >= this.nextRetrain) {
      await this.retrain(new Date(this.nextRetrain));
      this.nextRetrain = this.nextRetrainAfter(t0);
    }

    const summary = {
      plays: 0,
      viewers: 0,
      cost: 0,
      scans: 0,
      redemptions: [] as { campaignId: string; outletId: string | null; revenue: number; screenId: string }[],
    };
    const changed: DecisionRun[] = [];
    const dirty = this.dirtyScreens(windowStart);
    // A new 5-minute window makes every context stale at once. Screens without a context, and screens whose
    // flights changed, rebuild now; routine refreshes are spread over the next few slots so no single slot
    // rebuilds the whole network.
    let refreshBudget = ROUTINE_REFRESHES_PER_SLOT;
    const hard = `#${this.hardKey()}`;
    for (const screen of this.catalog.screens()) {
      const runtime = this.hooks.screenStatus(screen.id);
      const st = this.screenState(screen.id);
      if (runtime?.status === 'offline') {
        if (st.run) {
          this.closedRuns.push(st.run);
          st.run = null;
        }
        continue;
      }
      const key = this.contextKey(screen.id, windowStart);
      const current = st.context;
      const mustRebuild = !current || !current.key.endsWith(hard) || dirty === null || dirty.has(screen.id);
      const routine = !mustRebuild && current.key !== key && refreshBudget > 0;
      if (routine) refreshBudget -= 1;
      const context =
        mustRebuild || routine
          ? await this.buildContext(screen.id, key, new Date(windowStart), slot, inputs)
          : current;
      if (context !== current) {
        st.context = context;
        st.contextPlayed = false;
      }
      const run = this.choose(screen.id, st, slot);
      if (run !== st.run) changed.push(run);
      st.run = run;
      if (run.campaignId && run.creativeId) {
        const played = this.deliver(screen.id, run, context, slot, runtime?.status === 'degraded');
        summary.plays += 1;
        summary.viewers += played.viewers;
        summary.cost += played.cost;
        summary.scans += played.scans;
      }
    }
    for (const r of this.releaseRedemptions(t0)) summary.redemptions.push(r);
    this.writes = this.writes
      .then(() => this.flush(false, windowStart))
      .catch((err: unknown) => this.hooks.warn(`Could not write decisions: ${(err as Error).message}`));

    if (changed.length > 0) {
      this.bus.publish('decisions', {
        at: slot.toISOString(),
        changes: changed.map((r) => ({
          screenId: r.screenId,
          runId: r.id,
          campaignId: r.campaignId,
          creativeId: r.creativeId,
          score: r.score,
          mode: r.mode,
          contextId: r.contextId,
        })),
      });
    }
    this.bus.publish('delivery', {
      at: slot.toISOString(),
      plays: summary.plays,
      viewers: r2(summary.viewers),
      cost: r2(summary.cost),
      scans: summary.scans,
      redemptions: summary.redemptions,
      today: roundTotals(this.today.network()),
    });
  }

  private async buildContext(
    screenId: string,
    key: string,
    windowStart: Date,
    now: Date,
    inputs: PresenceInputs,
  ): Promise<DecisionContext> {
    const screen = this.catalog.screen(screenId);
    if (!screen) throw new Error(`unknown screen ${screenId}`);
    const crowd = screenCrowd(
      screen,
      inputs,
      windowStart,
      this.catalog.screensInZone(screen.zoneId),
      this.zoneEstimates(windowStart.getTime(), inputs),
    );
    const settings = this.catalog.settings();
    const candidates = evaluateCampaigns(
      this.catalog.bundles(),
      this.scoringContext(screen, crowd, windowStart),
    ).map((c) => {
      const invalid = c.creativeId ? this.invalidCreatives.get(c.creativeId) : undefined;
      if (!c.eligible || invalid === undefined) return c;
      return {
        ...c,
        eligible: false,
        score: null,
        filters: [
          ...c.filters,
          { rule: 'creative' as const, passed: false, detail: `creative failed validation: ${invalid}` },
        ],
      };
    });
    for (const c of candidates) {
      const reason = c.creativeId ? this.invalidCreatives.get(c.creativeId) : undefined;
      if (reason && c.creativeId && !this.reportedCreatives.has(c.creativeId)) {
        this.reportedCreatives.add(c.creativeId);
        void this.hooks.raiseIncident(
          {
            kind: 'failed_creative',
            severity: 'medium',
            title: `Creative ${c.creativeId} cannot be rendered`,
            subject: c.creativeId,
            details: { campaignId: c.campaignId, reason },
          },
          now,
        );
      }
    }
    const eligible = candidates.filter((c) => c.eligible);
    // Evidence and verification use the actual decision time: feed data may have arrived after the slot began.
    const decidedAt = new Date(Math.max(now.getTime(), this.clock.now().getTime()));
    const evidence = buildEvidence({
      now: decidedAt,
      screenId,
      screenStatus: this.hooks.screenStatus(screenId) ?? { status: 'online', lastHeartbeat: null },
      crowd,
      candidates,
      state: this.state,
      model: { version: this.learning.version, trainedAt: this.learning.trainedAt },
    });
    this.contextCounter += 1;
    const context: DecisionContext = {
      id: `ctx-${screenId}-${compact(windowStart.toISOString())}-${this.contextCounter}`,
      screenId,
      key,
      computedAt: now.toISOString(),
      windowStart: windowStart.toISOString(),
      crowd,
      candidates,
      evidence,
      ai: {
        provider: this.ai?.provider ?? 'none',
        model: this.ai?.model ?? 'none',
        status: 'off',
        latencyMs: null,
        checks: [],
        ranking: [],
        rationale: null,
        error: null,
      },
      order: eligible,
      flightIds: new Set(crowd.contributors.map((c) => c.flightId)),
    };
    if (this.ai && eligible.length > 0) {
      const request = buildRankRequest({
        screenId,
        at: windowStart,
        crowd,
        candidates,
        evidence,
        settings,
        segmentWeights: new Map(this.catalog.campaigns().map((c) => [c.id, c.segmentWeights])),
      });
      const apply = (result: Awaited<ReturnType<AiRanker['rank']>>) => {
        if (result.error !== null) {
          context.ai = { ...context.ai, status: 'error', latencyMs: result.latencyMs, error: result.error };
          return;
        }
        const v = verifyRanking(result.answer, candidates, evidence, decidedAt);
        const top = v.parsed?.ranking.at(0);
        context.ai = {
          provider: result.provider,
          model: result.model,
          status: v.passed ? 'verified' : 'rejected',
          latencyMs: result.latencyMs,
          checks: v.checks,
          ranking: v.parsed?.ranking.map((r) => r.campaignId) ?? [],
          rationale: top?.rationale ?? null,
          error: null,
        };
        if (v.passed) {
          const byId = new Map(eligible.map((c) => [c.campaignId, c]));
          context.order = v.ranking
            .map((id) => byId.get(id))
            .filter((c): c is CandidateEvaluation => c !== undefined);
        }
      };
      if (this.ai.provider === 'mock') {
        apply(await this.ai.rank(request, new AbortController().signal));
      } else if (this.remoteInFlight < REMOTE_AI_CONCURRENCY) {
        // Remote models answer in seconds: decide by rules now, switch to the verified AI order when it arrives.
        this.remoteInFlight += 1;
        context.ai = { ...context.ai, status: 'pending' };
        void this.ai
          .rank(request, new AbortController().signal)
          .then(apply)
          .finally(() => {
            this.remoteInFlight -= 1;
          });
      }
    }
    this.newContexts.push(context);
    return context;
  }

  /**
   * Pick what plays on a screen in `slot`. A dry choice (a mid-slot re-plan) decides without counting a
   * play: the play is counted when the next slot is delivered.
   */
  private choose(
    screenId: string,
    st: ScreenRuntimeState,
    slot: Date,
    opts: { dry?: boolean; decidedAt?: Date } = {},
  ): DecisionRun {
    const ctx = st.context;
    if (!ctx) throw new Error('no decision context');
    const t0 = slot.getTime();
    st.plays = st.plays.filter(([at]) => at > t0 - 60 * MIN);
    const playsLastHour = new Map<string, number>();
    const lastPlayedAt = new Map<string, number>();
    for (const [at, c] of st.plays) {
      playsLastHour.set(c, (playsLastHour.get(c) ?? 0) + 1);
      lastPlayedAt.set(c, Math.max(lastPlayedAt.get(c) ?? 0, at));
    }
    const settings = this.catalog.settings();
    const local = toLocal(slot, this.opts.utcOffsetMinutes);
    const hour = local.hour + local.minute / 60;
    const dayElapsed = Math.min(1, Math.max(0, (hour - PACING_DAY.from) / (PACING_DAY.to - PACING_DAY.from)));
    const rng = new Rng(`${this.opts.seed}:slot:${screenId}:${t0}`);
    const pin = this.catalog.pinAt(screenId, slot);
    const campaigns = this.catalog.campaigns();
    const outcome = applyBusinessRules({
      ranked: ctx.order,
      // Exploration never pre-empts the first play of a fresh decision context.
      settings: st.contextPlayed ? settings : { ...settings, explorationPct: 0 },
      history: {
        lastCampaignId: st.lastCampaignId,
        lastCompetitorGroup: st.lastCompetitorGroup,
        consecutivePlays: st.consecutivePlays,
        playsLastHour,
        lastPlayedAt,
      },
      pin: pin
        ? { id: pin.id, campaignId: pin.campaignId, reason: pin.reason, createdBy: pin.createdBy }
        : null,
      frequencyCaps: new Map(campaigns.map((c) => [c.id, c.budget.frequencyCapPerScreenHour])),
      pacing: new Map(
        campaigns.map((c) => [
          c.id,
          { dailyCap: c.budget.dailyCap, spend: this.spend.get(c.id) ?? { today: 0, total: 0 } },
        ]),
      ),
      dayElapsed,
      now: t0,
      random: rng.next(),
      random2: rng.next(),
    });
    if (!opts.dry) st.contextPlayed = true;
    const winner = outcome.winner;
    let mode: DecisionMode = 'rule_based';
    if (!winner) mode = 'house';
    else if (outcome.applied.some((a) => a.rule === 'manual_pin')) mode = 'manual_pin';
    else if (ctx.ai.status === 'verified') mode = 'ai_verified';
    else if (ctx.ai.status === 'rejected') mode = 'ai_rejected';
    const current = st.run;
    if (opts.dry && current && current.campaignId === (winner?.campaignId ?? null) && current.mode === mode)
      return current;
    if (
      !opts.dry &&
      current &&
      current.campaignId === (winner?.campaignId ?? null) &&
      current.contextId === ctx.id &&
      current.mode === mode &&
      Date.parse(current.slotEnd) === t0
    ) {
      current.slotEnd = new Date(t0 + this.slotMs).toISOString();
      current.slots += 1;
      if (winner) this.recordPlay(st, winner, t0);
      return current;
    }
    const decidedAt = opts.decidedAt ?? slot;
    if (current) {
      // A re-plan ends the current run now, part-way through its last slot.
      if (opts.dry) current.slotEnd = decidedAt.toISOString();
      this.closedRuns.push(current);
    }
    if (winner && !opts.dry) this.recordPlay(st, winner, t0);
    return {
      id: `dec-${screenId}-${compact(decidedAt.toISOString())}${opts.dry ? `-r${decidedAt.getUTCMilliseconds()}` : ''}`,
      screenId,
      slotStart: slot.toISOString(),
      slotEnd: new Date(t0 + this.slotMs).toISOString(),
      slots: 1,
      decidedAt: decidedAt.toISOString(),
      mode,
      campaignId: winner?.campaignId ?? null,
      creativeId: winner ? this.pickCreative(winner, screenId, t0) : null,
      score: winner?.score?.final ?? null,
      contextId: ctx.id,
      checks: ctx.ai.checks,
      rules: outcome.applied,
      reason: this.reason(winner, ctx, mode, outcome.applied),
    };
  }

  private recordPlay(st: ScreenRuntimeState, winner: CandidateEvaluation, t0: number): void {
    st.plays.push([t0, winner.campaignId]);
    st.consecutivePlays = st.lastCampaignId === winner.campaignId ? st.consecutivePlays + 1 : 1;
    st.lastCampaignId = winner.campaignId;
    st.lastCompetitorGroup = winner.competitorGroup;
  }

  /** A/B creatives alternate by hour and screen, so both variants collect comparable data. */
  private pickCreative(winner: CandidateEvaluation, screenId: string, t0: number): string | null {
    const campaign = this.catalog.campaign(winner.campaignId);
    const approved = (campaign?.creativeIds ?? []).filter(
      (id) => this.catalog.creative(id)?.status === 'approved' && !this.invalidCreatives.has(id),
    );
    if (approved.length <= 1) return approved.at(0) ?? winner.creativeId;
    let h = Math.floor(t0 / (60 * MIN));
    for (const ch of screenId) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1_000_003;
    return approved.at(h % approved.length) ?? winner.creativeId;
  }

  private reason(
    winner: CandidateEvaluation | null,
    ctx: DecisionContext,
    mode: DecisionMode,
    rules: readonly AppliedRule[],
  ): string {
    if (!winner) return 'No eligible campaign for this crowd; the platform house ad plays.';
    const s = winner.score;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const parts = [`${winner.campaignName}: score ${s?.final.toFixed(2) ?? '–'}`];
    if (s) {
      parts.push(`${pct(s.match)} audience match`);
      if (s.boost > 1) parts.push(`×${s.boost} boost (${s.triggers.map((x) => x.detail).join('; ')})`);
      parts.push(`performance ${s.performance.toFixed(2)}`);
    }
    const ruleText = rules.map((r) => `${r.rule.replace(/_/g, ' ')}: ${r.detail}`).join('; ');
    let aiText = 'rule-based ranking';
    if (mode === 'ai_verified')
      aiText = `AI ranking verified (${ctx.ai.checks.filter((c) => c.passed).length}/${ctx.ai.checks.length} checks)`;
    else if (mode === 'ai_rejected')
      aiText = `AI choice rejected (${ctx.ai.checks
        .filter((c) => !c.passed)
        .map((c) => `${c.name}: ${c.detail}`)
        .join('; ')}); rule-based ranking used`;
    else if (mode === 'manual_pin') aiText = 'manual pin';
    return `${parts.join(', ')}. ${aiText}.${ruleText ? ` Rules: ${ruleText}.` : ''}`;
  }

  // ---- delivery and outcomes ---------------------------------------------------------------------------------

  private deliver(
    screenId: string,
    run: DecisionRun,
    ctx: DecisionContext,
    slot: Date,
    degraded: boolean,
  ): { viewers: number; cost: number; scans: number } {
    const campaign = run.campaignId ? this.catalog.campaign(run.campaignId) : undefined;
    const screen = this.catalog.screen(screenId);
    if (!campaign || !screen || !run.creativeId) return { viewers: 0, cost: 0, scans: 0 };
    const viewers = ctx.crowd.pax * (ATTENTION.get(screen.kind) ?? 0.2) * (degraded ? DEGRADED_ATTENTION : 1);
    const cost = (viewers / 1000) * campaign.budget.cpm;
    const spend = this.spend.get(campaign.id) ?? { today: 0, total: 0 };
    this.spend.set(campaign.id, { today: spend.today + cost, total: spend.total + cost });
    const windowStart = floorTo(slot, 5).getTime();
    const aggKey = `${screenId}|${campaign.id}|${run.creativeId}|${windowStart}`;
    const agg = this.impressions.get(aggKey) ?? {
      decisionId: run.id,
      screenId,
      campaignId: campaign.id,
      creativeId: run.creativeId,
      windowStart,
      plays: 0,
      viewers: 0,
      cost: 0,
      scans: 0,
    };
    agg.plays += 1;
    agg.viewers += viewers;
    agg.cost += cost;
    this.learning.recordPlay(campaign.id, viewers, ctx.crowd.profile);
    this.today.play(campaign.id, viewers, cost);

    // Simulated passengers scan the promo QR; some redeem it at the outlet later.
    let scans = 0;
    if (campaign.promo?.inStock) {
      const candidate = ctx.candidates.find((c) => c.campaignId === campaign.id);
      const match = candidate?.score?.match ?? 0.3;
      const performance = this.learning.performanceMap().get(campaign.id) ?? campaign.performanceIndex;
      const rng = new Rng(`${this.opts.seed}:scan:${screenId}:${slot.getTime()}`);
      scans = poisson(viewers * SCAN_RATE * (0.5 + match) * (0.6 + performance), rng);
      const outlet = campaign.promo.outletId ? this.catalog.outlet(campaign.promo.outletId) : undefined;
      for (let i = 0; i < scans; i += 1) {
        const segment = pickSegment(ctx.crowd, campaign.segmentWeights, rng);
        this.learning.recordScan(campaign.id, segment);
        if (rng.chance(0.25 + 0.4 * performance)) {
          this.pending.push({
            at: slot.getTime() + rng.int(4, 35) * MIN,
            campaignId: campaign.id,
            screenId,
            outletId: outlet?.id ?? null,
            segment,
            revenue: r2((outlet?.averageBasket ?? 20) * rng.float(0.85, 1.3)),
          });
        }
      }
      if (scans > 0) this.pending.sort((a, b) => a.at - b.at);
    }
    agg.scans += scans;
    this.today.scans(campaign.id, scans);
    this.impressions.set(aggKey, agg);
    return { viewers, cost, scans };
  }

  private releaseRedemptions(
    now: number,
  ): { campaignId: string; outletId: string | null; revenue: number; screenId: string }[] {
    const due: PendingRedemption[] = [];
    while (this.pending.length > 0 && (this.pending.at(0)?.at ?? Infinity) <= now) {
      const p = this.pending.shift();
      if (p) due.push(p);
    }
    for (const p of due) {
      this.redemptionCounter += 1;
      this.learning.recordRedemption(p.campaignId, p.segment, p.revenue);
      this.today.redemption(p.campaignId, p.revenue);
      this.redemptionRows.push({
        id: `red-sim-${p.at}-${this.redemptionCounter}`,
        code: `SIM-${(p.at % 1_000_000).toString(36).toUpperCase()}${this.redemptionCounter}`,
        campaignId: p.campaignId,
        outletId: p.outletId,
        screenId: p.screenId,
        redeemedAt: new Date(p.at),
        revenue: p.revenue,
        segment: p.segment,
      });
    }
    return due.map((p) => ({
      campaignId: p.campaignId,
      outletId: p.outletId,
      revenue: p.revenue,
      screenId: p.screenId,
    }));
  }

  /** Record a QR scan that happened outside the simulation (a real phone opened a claim link). */
  recordExternalScan(campaignId: string, segment: string): void {
    this.learning.recordScan(campaignId, segment);
    this.today.scans(campaignId, 1);
  }

  /** Record a redemption that happened outside the simulation (a real phone claim). */
  recordExternalRedemption(campaignId: string, segment: string, revenue: number): void {
    this.learning.recordRedemption(campaignId, segment, revenue);
    this.today.redemption(campaignId, revenue);
  }

  // ---- persistence --------------------------------------------------------------------------------------------

  private async writeZonePresence(windowStart: Date, inputs: PresenceInputs): Promise<void> {
    const zones = allZonePresence(inputs, windowStart);
    const rows = this.catalog.layout().zones.map((z) => {
      const e = zones.get(z.id);
      return {
        zoneId: z.id,
        windowStart,
        pax: e?.pax ?? 0,
        profile: e?.profile ?? {},
        computedAt: windowStart,
      };
    });
    await this.database.db
      .insert(t.zonePresence)
      .values(rows)
      .onConflictDoUpdate({
        target: [t.zonePresence.zoneId, t.zonePresence.windowStart],
        set: {
          pax: sql`excluded.pax`,
          profile: sql`excluded.profile`,
          computedAt: sql`excluded.computed_at`,
        },
      });
    this.zoneWindowWritten = windowStart.getTime();
    this.bus.publish('presence', {
      windowStart: windowStart.toISOString(),
      zones: rows.map((r) => ({ zoneId: r.zoneId, pax: Math.round(r.pax) })),
    });
  }

  /** Write new contexts, closed runs, finished impression windows and redemptions. */
  private async flush(all: boolean, currentWindow = Infinity): Promise<void> {
    const { db } = this.database;
    const contexts = this.newContexts.splice(0);
    // Contexts are large (evidence, candidates, AI checks) and a new window brings one per screen. The
    // embedded database runs on this thread, so write them in small batches and let slots run in between.
    for (const batch of chunks(contexts, WRITE_BATCH)) {
      await yieldToEventLoop();
      await db
        .insert(t.decisionContexts)
        .values(
          batch.map((c) => {
            const { profile, ...crowd } = c.crowd;
            return {
              id: c.id,
              screenId: c.screenId,
              computedAt: new Date(c.computedAt),
              windowStart: new Date(c.windowStart),
              crowd,
              profile,
              evidence: c.evidence,
              candidates: c.candidates,
              ai: c.ai,
            };
          }),
        )
        .onConflictDoNothing();
    }
    const runs = this.closedRuns.splice(0);
    for (const batch of chunks(runs, WRITE_BATCH * 4)) {
      await yieldToEventLoop();
      await db
        .insert(t.decisions)
        .values(batch.map(runToRow))
        .onConflictDoUpdate({
          target: t.decisions.id,
          set: { slotEnd: sql`excluded.slot_end`, slots: sql`excluded.slots` },
        });
    }
    const finished = [...this.impressions.entries()].filter(([, a]) => all || a.windowStart < currentWindow);
    for (const [k] of finished) this.impressions.delete(k);
    for (const batch of chunks(finished, WRITE_BATCH * 4)) {
      await yieldToEventLoop();
      await db
        .insert(t.impressions)
        .values(
          batch.map(([, a]) => ({
            id: `imp-${a.screenId}-${a.campaignId}-${a.creativeId}-${a.windowStart}`,
            decisionId: a.decisionId,
            campaignId: a.campaignId,
            creativeId: a.creativeId,
            screenId: a.screenId,
            playedAt: new Date(a.windowStart),
            durationSec: a.plays * this.opts.slotSeconds,
            estimatedViewers: r2(a.viewers),
            cost: r4(a.cost),
            plays: a.plays,
            windowStart: new Date(a.windowStart),
            scans: a.scans,
          })),
        )
        .onConflictDoUpdate({
          target: [
            t.impressions.screenId,
            t.impressions.campaignId,
            t.impressions.creativeId,
            t.impressions.windowStart,
          ],
          set: {
            plays: sql`${t.impressions.plays} + excluded.plays`,
            estimatedViewers: sql`${t.impressions.estimatedViewers} + excluded.estimated_viewers`,
            cost: sql`${t.impressions.cost} + excluded.cost`,
            durationSec: sql`${t.impressions.durationSec} + excluded.duration_sec`,
            scans: sql`${t.impressions.scans} + excluded.scans`,
          },
        });
    }
    const redemptions = this.redemptionRows.splice(0);
    if (redemptions.length > 0) await db.insert(t.redemptions).values(redemptions).onConflictDoNothing();
  }

  /** Remove engine data recorded after `to` (backward jumps). */
  async rewind(to: Date): Promise<void> {
    const { db } = this.database;
    await db.delete(t.decisionContexts).where(gt(t.decisionContexts.computedAt, to));
    await db.delete(t.modelVersions).where(gt(t.modelVersions.trainedAt, to));
  }

  // ---- queries --------------------------------------------------------------------------------------------------

  /** The current decision of a screen with its context (the "Why this ad?" view). */
  now(screenId: string): { run: DecisionRun | null; context: DecisionContext | null } {
    const st = this.screensState.get(screenId);
    return { run: st?.run ?? null, context: st?.context ?? null };
  }

  /** Decision runs still playing. */
  openRuns(): DecisionRun[] {
    return [...this.screensState.values()].map((s) => s.run).filter((r): r is DecisionRun => r !== null);
  }

  /** A context still in memory (current, or not yet written). */
  context(id: string): DecisionContext | undefined {
    for (const s of this.screensState.values()) if (s.context?.id === id) return s.context;
    return this.newContexts.find((c) => c.id === id);
  }

  /** Playlist build time per slot (all screens) and slots skipped because processing fell behind. */
  performanceStats(): {
    slots: number;
    lastMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    skippedSlots: number;
  } {
    const sorted = [...this.slotTimings].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted.length > 0
        ? Math.round((sorted.at(Math.min(sorted.length - 1, Math.floor(p * sorted.length))) ?? 0) * 10) / 10
        : null;
    const last = this.slotTimings.at(-1);
    return {
      slots: this.slotTimings.length,
      lastMs: last === undefined ? null : Math.round(last * 10) / 10,
      p50Ms: q(0.5),
      p95Ms: q(0.95),
      skippedSlots: this.skippedSlots,
    };
  }

  private serial: Promise<unknown> = Promise.resolve();

  /** Slot processing and re-plans never overlap. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => undefined);
    return next;
  }

  /**
   * Re-plan now, part-way through a slot, after an external change (an injected delay or gate change, a
   * screen going offline or online, a master-data edit, a pin, new rule settings). Screens whose crowd or
   * catalog changed get a fresh context and choice at once, so the effect shows within a second instead of
   * at the next slot (15 simulated seconds, or never while the clock is paused).
   */
  async replanNow(opts: { screenIds?: readonly string[] } = {}): Promise<number> {
    return this.serialize(async () => {
      const controller = this.controller;
      if (!controller) return 0;
      const now = this.clock.now();
      const slot = new Date(Math.floor(now.getTime() / this.slotMs) * this.slotMs);
      const windowStart = floorTo(now, 5).getTime();
      const inputs = this.presenceInputs(windowStart);
      const dirty = this.dirtyScreens(windowStart);
      const hard = `#${this.hardKey()}`;
      const forced = new Set(opts.screenIds ?? []);
      const changed: DecisionRun[] = [];
      for (const screen of this.catalog.screens()) {
        const st = this.screenState(screen.id);
        const affected =
          forced.has(screen.id) || dirty === null || dirty.has(screen.id) || !st.context?.key.endsWith(hard);
        if (!affected) continue;
        if (this.hooks.screenStatus(screen.id)?.status === 'offline') {
          if (st.run) {
            st.run.slotEnd = now.toISOString();
            this.closedRuns.push(st.run);
            st.run = null;
          }
          continue;
        }
        const context = await this.buildContext(
          screen.id,
          this.contextKey(screen.id, windowStart),
          new Date(windowStart),
          now,
          inputs,
        );
        // The engine was stopped or restarted (a clock jump) while this context was built: drop the re-plan.
        if (this.controller !== controller) return changed.length;
        st.context = context;
        st.contextPlayed = false;
        const run = this.choose(screen.id, st, slot, { dry: true, decidedAt: now });
        if (run !== st.run) changed.push(run);
        st.run = run;
      }
      if (changed.length > 0)
        this.bus.publish('decisions', {
          at: now.toISOString(),
          changes: changed.map((r) => ({
            screenId: r.screenId,
            runId: r.id,
            campaignId: r.campaignId,
            creativeId: r.creativeId,
            score: r.score,
            mode: r.mode,
            contextId: r.contextId,
          })),
        });
      return changed.length;
    });
  }

  /** Inputs for scoring campaigns against a crowd at a screen (shared with previews and analytics). */
  scoringContext(screen: Screen, crowd: CrowdEstimate, at: Date): ScoringContext {
    return {
      now: at,
      utcOffsetMinutes: this.opts.utcOffsetMinutes,
      screen,
      crowd,
      settings: this.catalog.settings(),
      performance: this.learning.performanceMap(),
      spend: this.spend,
      gateChanges: this.state.recentGateChanges(),
      festival: this.opts.festival,
    };
  }

  /** The context each screen is deciding from: its id and presence window (for monitoring and tests). */
  contextsInUse(): Map<string, { contextId: string; windowStart: string }> {
    const out = new Map<string, { contextId: string; windowStart: string }>();
    for (const [screenId, st] of this.screensState)
      if (st.context) out.set(screenId, { contextId: st.context.id, windowStart: st.context.windowStart });
    return out;
  }

  /** Today's totals for the whole network. */
  todayTotals(): DayTotals {
    return this.today.network();
  }

  /** Today's totals for one campaign. */
  campaignToday(campaignId: string): DayTotals {
    return this.today.campaign(campaignId);
  }

  spendOf(campaignId: string): SpendState {
    return this.spend.get(campaignId) ?? { today: 0, total: 0 };
  }
}

function runToRow(r: DecisionRun): typeof t.decisions.$inferInsert {
  return {
    id: r.id,
    screenId: r.screenId,
    slotStart: new Date(r.slotStart),
    decidedAt: new Date(r.decidedAt),
    mode: r.mode,
    campaignId: r.campaignId,
    creativeId: r.creativeId,
    score: r.score,
    checks: r.checks,
    reason: r.reason,
    contextId: r.contextId,
    slotEnd: new Date(r.slotEnd),
    slots: r.slots,
    rules: r.rules,
  };
}

/** Poisson-distributed count (Knuth's method; λ is small here). */
function poisson(lambda: number, rng: Rng): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng.next();
  while (p > limit && k < 50) {
    k += 1;
    p *= rng.next();
  }
  return k;
}

/** The (aggregate) segment a scan is attributed to: crowd share × campaign affinity, over party and purpose. */
function pickSegment(crowd: CrowdEstimate, weights: Readonly<Record<string, number>>, rng: Rng): string {
  const w = new Map(Object.entries(weights));
  const options = [
    ...Object.entries(crowd.profile.segments.partyType).map(
      ([k, share]) => [`partyType.${k}`, share] as const,
    ),
    ...Object.entries(crowd.profile.segments.tripPurpose).map(
      ([k, share]) => [`tripPurpose.${k}`, share] as const,
    ),
  ];
  return rng.weighted(options, ([key, share]) => share * (0.3 + (w.get(key) ?? 0)))[0];
}

const roundTotals = (d: DayTotals): DayTotals => ({
  ...d,
  viewers: Math.round(d.viewers),
  cost: r2(d.cost),
  revenue: r2(d.revenue),
});

/** Window-rollover context refreshes per slot: the whole network (180 screens) within 4 slots. */
const ROUTINE_REFRESHES_PER_SLOT = 45;

/** Rows per insert statement for decision contexts (other tables use a multiple). */
const WRITE_BATCH = 15;

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Let pending timers and I/O run (the next slot) before continuing a long write. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
