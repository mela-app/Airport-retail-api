/**
 * Decision engine API: the current decision of a screen with its evidence ("Why this ad?"), the searchable
 * decision log, passenger presence (now and forecast), rule-engine settings, the learning model, manual pins,
 * network KPIs, and the worked-example scenario.
 */
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodBody, ZodQuery } from '../core/openapi.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { addMinutes, getOwn, segmentShare } from '@arm/domain';
import { and, desc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';

import { DATABASE, SIMULATION } from '../core/tokens.js';
import { parseInput, requestOrigin } from '../core/http.js';
import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEFAULT_RULE_ENGINE } from '../db/seed.js';
import type { DecisionContext, DecisionRun } from '../engine/decision-engine.js';
import { PRESENCE_MODEL, allZonePresence, screenCrowd, zonePresence } from '../engine/presence.js';
import type { Simulation } from '../sim/simulation.js';

const DecisionQuery = z.object({
  screenId: z.string().max(40).optional(),
  campaignId: z.string().max(40).optional(),
  mode: z.enum(['ai_verified', 'ai_rejected', 'rule_based', 'manual_pin', 'house']).optional(),
  q: z.string().max(80).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ForecastQuery = z.object({
  zoneId: z.string().max(20),
  hours: z.coerce.number().min(0.5).max(12).default(2),
  stepMin: z.coerce.number().int().min(5).max(60).default(15),
});

const AtQuery = z.object({ at: z.iso.datetime({ offset: true }).optional() });

const RuleEngineBody = z.object({
  audienceWeight: z.number().min(0).max(1),
  performanceWeight: z.number().min(0).max(1),
  explorationPct: z.number().min(0).max(50),
  defaultFrequencyCap: z.number().int().min(1).max(240),
  maxConsecutivePlays: z.number().int().min(1).max(20),
  minScoreToPlay: z.number().min(0).max(1),
  competitorSeparation: z.boolean(),
  airlinePriorityInBoardingWindow: z.boolean(),
  airlinePriorityWindowMin: z.number().int().min(5).max(180),
  segmentModelVersion: z.string().min(1).max(60),
});

const PinBody = z.object({
  screenId: z.string().min(1).max(40),
  campaignId: z.string().min(1).max(40),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  reason: z.string().min(3).max(200),
  createdBy: z.string().min(1).max(80).default('Media Manager'),
});

const WorkedExampleBody = z.object({
  localTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('14:10'),
});

const pct = (v: number) => Math.round(v * 1000) / 10;

/** A compact, presentation-ready summary of a decision context. */
function contextSummary(ctx: DecisionContext) {
  const shares = (dim: keyof DecisionContext['crowd']['profile']['segments']) =>
    Object.entries((getOwn(ctx.crowd.profile.segments, dim) ?? {}) as Record<string, number>).map(
      ([k, v]) => ({
        segment: `${dim}.${k}`,
        share: v,
      }),
    );
  return {
    id: ctx.id,
    computedAt: ctx.computedAt,
    windowStart: ctx.windowStart,
    crowd: {
      pax: ctx.crowd.pax,
      medianDwellMin: ctx.crowd.medianDwellMin,
      maxDelayMin: ctx.crowd.maxDelayMin,
      international: pct(segmentShare(ctx.crowd.profile, 'market.international')),
      tripPurpose: shares('tripPurpose'),
      partyType: shares('partyType'),
      ageBand: shares('ageBand'),
      topNationalities: ctx.crowd.profile.topNationalities,
      topDestinations: ctx.crowd.profile.topDestinations,
      flights: ctx.crowd.contributors.map((c) => ({
        flightId: c.flightId,
        flight: `${c.airlineIata}${c.flightNumber}`,
        destination: c.destination,
        gateId: c.gateId,
        pax: Math.round(c.pax),
        delayMin: c.delayMin,
        dwellMin: c.dwellMin,
        status: c.status,
      })),
    },
    candidates: ctx.candidates.map((c) => ({
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      advertiserName: c.advertiserName,
      eligible: c.eligible,
      failed: c.filters.filter((f) => !f.passed),
      score: c.score,
    })),
    order: ctx.order.map((c) => c.campaignId),
    ai: ctx.ai,
    evidenceCount: ctx.evidence.length,
  };
}

@ApiTags('Decision engine')
@Controller('api')
export class EngineController {
  constructor(
    @Inject(SIMULATION) private readonly sim: Simulation,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  private presenceInputs() {
    return {
      flights: this.sim.state.allFlights(),
      profiles: this.sim.state.profileMap(),
      queues: this.sim.state.queueMap(),
      layout: this.sim.engine.catalog.layout(),
    };
  }

  // ---- decisions ------------------------------------------------------------------------------------------

  @ApiOperation({
    summary: 'What a screen plays now and why: decision, crowd profile, candidates, AI checks, claim QR',
  })
  @Get('screens/:id/now')
  async screenNow(@Param('id') id: string, @Req() req: Request) {
    const screen = this.sim.engine.catalog.screen(id);
    if (!screen) throw new NotFoundException({ error: 'not_found', message: `unknown screen ${id}` });
    const { run, context } = this.sim.engine.now(id);
    const runtime = this.sim.fleet.get(id);
    const campaign = run?.campaignId ? this.sim.engine.catalog.campaign(run.campaignId) : undefined;
    const creative = run?.creativeId ? this.sim.engine.catalog.creative(run.creativeId) : undefined;
    const claim = run ? await this.sim.claims.linkForRun(run, context, requestOrigin(req)) : null;
    return {
      screen,
      status: runtime ?? null,
      run,
      claim,
      campaign: campaign ?? null,
      creative: creative ?? null,
      context: context ? contextSummary(context) : null,
    };
  }

  @ApiOperation({ summary: 'Search the decision log' })
  @ZodQuery(DecisionQuery)
  @Get('decisions')
  async decisions(@Query() query: unknown) {
    const q = parseInput(DecisionQuery, query);
    const where: SQL[] = [];
    if (q.screenId) where.push(eq(t.decisions.screenId, q.screenId));
    if (q.campaignId) where.push(eq(t.decisions.campaignId, q.campaignId));
    if (q.mode) where.push(eq(t.decisions.mode, q.mode));
    if (q.from) where.push(gte(t.decisions.slotStart, new Date(q.from)));
    if (q.to) where.push(lte(t.decisions.slotStart, new Date(q.to)));
    if (q.q) {
      const text = or(ilike(t.decisions.reason, `%${q.q}%`), ilike(t.decisions.screenId, `%${q.q}%`));
      if (text) where.push(text);
    }
    const stored = await this.database.db
      .select()
      .from(t.decisions)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(t.decisions.slotStart))
      .limit(q.limit);
    const open = this.sim.engine
      .openRuns()
      .filter(
        (r) =>
          (!q.screenId || r.screenId === q.screenId) &&
          (!q.campaignId || r.campaignId === q.campaignId) &&
          (!q.mode || r.mode === q.mode) &&
          (!q.q ||
            r.reason.toLowerCase().includes(q.q.toLowerCase()) ||
            r.screenId.toLowerCase().includes(q.q.toLowerCase())),
      );
    const rows: (DecisionRun & { open: boolean })[] = [
      ...open.map((r) => ({ ...r, open: true })),
      ...stored.map((r) => ({
        id: r.id,
        screenId: r.screenId,
        slotStart: r.slotStart.toISOString(),
        slotEnd: r.slotEnd.toISOString(),
        slots: r.slots,
        decidedAt: r.decidedAt.toISOString(),
        mode: r.mode as DecisionRun['mode'],
        campaignId: r.campaignId,
        creativeId: r.creativeId,
        score: r.score,
        contextId: r.contextId,
        checks: r.checks as DecisionRun['checks'],
        rules: r.rules as DecisionRun['rules'],
        reason: r.reason,
        open: false,
      })),
    ];
    return rows.sort((a, b) => b.slotStart.localeCompare(a.slotStart)).slice(0, q.limit);
  }

  @ApiOperation({ summary: 'A decision context with its full evidence trail' })
  @Get('decision-contexts/:id')
  async decisionContext(@Param('id') id: string) {
    const live = this.sim.engine.context(id);
    if (live) return { ...contextSummary(live), evidence: live.evidence };
    const [row] = await this.database.db
      .select()
      .from(t.decisionContexts)
      .where(eq(t.decisionContexts.id, id));
    if (!row) throw new NotFoundException({ error: 'not_found', message: `unknown decision context ${id}` });
    const ctx = {
      id: row.id,
      screenId: row.screenId,
      key: '',
      computedAt: row.computedAt.toISOString(),
      windowStart: row.windowStart.toISOString(),
      crowd: {
        ...(row.crowd as Omit<DecisionContext['crowd'], 'profile'>),
        profile: row.profile as DecisionContext['crowd']['profile'],
      },
      candidates: row.candidates as DecisionContext['candidates'],
      evidence: row.evidence as DecisionContext['evidence'],
      ai: row.ai as DecisionContext['ai'],
      order: [],
    } satisfies DecisionContext;
    return { ...contextSummary(ctx), evidence: ctx.evidence };
  }

  // ---- presence -------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Passenger presence per zone (now, or at a given time for forecasts)' })
  @ZodQuery(AtQuery)
  @Get('presence/zones')
  zones(@Query() query: unknown) {
    const { at } = parseInput(AtQuery, query);
    const when = at ? new Date(at) : this.sim.clock.now();
    const zones = allZonePresence(this.presenceInputs(), when);
    return {
      at: when.toISOString(),
      model: PRESENCE_MODEL.version,
      zones: this.sim.engine.catalog.layout().zones.map((z) => {
        const e = zones.get(z.id);
        return {
          zoneId: z.id,
          name: z.name,
          terminalId: z.terminalId,
          kind: z.kind,
          pax: Math.round(e?.pax ?? 0),
          international: pct(e ? segmentShare(e.profile, 'market.international') : 0),
          medianDwellMin: e?.medianDwellMin ?? null,
          topDestinations: e?.profile.topDestinations ?? [],
          topNationalities: e?.profile.topNationalities ?? [],
        };
      }),
    };
  }

  @ApiOperation({ summary: 'Footfall forecast for a zone (e.g. the next 2 hours)' })
  @ZodQuery(ForecastQuery)
  @Get('presence/forecast')
  forecast(@Query() query: unknown) {
    const q = parseInput(ForecastQuery, query);
    const zone = this.sim.engine.catalog.layout().zone(q.zoneId);
    if (!zone) throw new NotFoundException({ error: 'not_found', message: `unknown zone ${q.zoneId}` });
    const now = this.sim.clock.now();
    const inputs = this.presenceInputs();
    const points = [];
    for (let m = 0; m <= q.hours * 60; m += q.stepMin) {
      const at = addMinutes(now, m);
      const e = zonePresence(zone, inputs, at);
      points.push({
        at: at.toISOString(),
        pax: Math.round(e.pax),
        international: pct(segmentShare(e.profile, 'market.international')),
        topDestinations: e.profile.topDestinations,
        topNationalities: e.profile.topNationalities,
      });
    }
    return { zoneId: zone.id, name: zone.name, stepMin: q.stepMin, points };
  }

  @ApiOperation({ summary: 'Crowd in front of every screen (heat map)' })
  @Get('presence/screens')
  screens() {
    const now = this.sim.clock.now();
    const inputs = this.presenceInputs();
    const catalog = this.sim.engine.catalog;
    return catalog.screens().map((s) => {
      const crowd = screenCrowd(s, inputs, now, catalog.screensInZone(s.zoneId));
      const runtime = this.sim.fleet.get(s.id);
      return {
        screenId: s.id,
        zoneId: s.zoneId,
        position: s.position,
        pax: Math.round(crowd.pax),
        status: runtime?.status ?? s.status,
      };
    });
  }

  // ---- settings, model, pins ------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Rule-engine settings' })
  @Get('settings/rule-engine')
  ruleEngine() {
    return { settings: this.sim.engine.catalog.settings(), defaults: DEFAULT_RULE_ENGINE };
  }

  @ApiOperation({ summary: 'Update rule-engine settings (weights, exploration, caps, floor)' })
  @ZodBody(RuleEngineBody)
  @Put('settings/rule-engine')
  async updateRuleEngine(@Body() body: unknown) {
    const settings = parseInput(RuleEngineBody, body);
    const now = this.sim.clock.now();
    await this.database.db
      .insert(t.settings)
      .values({ key: 'rule_engine', value: settings, updatedAt: now })
      .onConflictDoUpdate({ target: t.settings.key, set: { value: settings, updatedAt: now } });
    await this.sim.engine.refreshCatalog();
    this.sim.bus.publish('sim', { action: 'rule_engine_updated', detail: settings, at: now.toISOString() });
    return { settings: this.sim.engine.catalog.settings() };
  }

  @ApiOperation({
    summary: 'Learning model in use: version, performance per campaign, per-segment conversion',
  })
  @Get('model')
  model() {
    const learning = this.sim.engine.learning;
    return {
      version: learning.version,
      trainedAt: learning.trainedAt,
      performance: Object.fromEntries(learning.performanceMap()),
      campaigns: this.sim.engine.catalog.campaigns().map((c) => ({
        campaignId: c.id,
        name: c.name,
        performance: learning.performanceMap().get(c.id) ?? c.performanceIndex,
        segments: learning.segmentRates(c.id),
      })),
    };
  }

  @ApiOperation({ summary: 'Manual pins (Media Manager overrides)' })
  @Get('pins')
  async pins() {
    const rows = await this.database.db
      .select()
      .from(t.manualPins)
      .orderBy(desc(t.manualPins.createdAt))
      .limit(200);
    return rows;
  }

  @ApiOperation({ summary: 'Pin a campaign to a screen for a period, with a reason' })
  @ZodBody(PinBody)
  @Post('pins')
  async createPin(@Body() body: unknown) {
    const input = parseInput(PinBody, body);
    const catalog = this.sim.engine.catalog;
    if (!catalog.screen(input.screenId))
      throw new NotFoundException({ error: 'not_found', message: `unknown screen ${input.screenId}` });
    if (!catalog.campaign(input.campaignId))
      throw new NotFoundException({ error: 'not_found', message: `unknown campaign ${input.campaignId}` });
    const now = this.sim.clock.now();
    const row = {
      id: `pin-${input.screenId}-${now.getTime()}`,
      screenId: input.screenId,
      campaignId: input.campaignId,
      startsAt: now,
      endsAt: addMinutes(now, input.minutes),
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: now,
    };
    await this.database.db.insert(t.manualPins).values(row);
    await this.sim.engine.refreshCatalog();
    this.sim.bus.publish('sim', {
      action: 'pin_created',
      detail: {
        ...row,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
      at: now.toISOString(),
    });
    return row;
  }

  @ApiOperation({ summary: 'Remove a pin' })
  @Delete('pins/:id')
  @HttpCode(200)
  async deletePin(@Param('id') id: string) {
    const deleted = await this.database.db
      .delete(t.manualPins)
      .where(eq(t.manualPins.id, id))
      .returning({ id: t.manualPins.id });
    if (deleted.length === 0)
      throw new NotFoundException({ error: 'not_found', message: `unknown pin ${id}` });
    await this.sim.engine.refreshCatalog();
    return { deleted: id };
  }

  // ---- KPIs and scenario ----------------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Network KPIs: screens online, plays, impressions, revenue, scans, redemptions, latency',
  })
  @Get('kpis/network')
  network() {
    const fleet = this.sim.fleet.all();
    const online = fleet.filter((s) => s.status !== 'offline').length;
    const today = this.sim.engine.todayTotals();
    const active = this.sim.engine.catalog.campaigns().filter((c) => c.status === 'active').length;
    return {
      at: this.sim.clock.now().toISOString(),
      screens: {
        total: fleet.length,
        online,
        degraded: fleet.filter((s) => s.status === 'degraded').length,
        onlinePct: fleet.length > 0 ? pct(online / fleet.length) : 0,
      },
      playsToday: today.plays,
      impressionsToday: Math.round(today.viewers),
      mediaRevenueToday: Math.round(today.cost * 100) / 100,
      scansToday: today.scans,
      redemptionsToday: today.redemptions,
      attributedSalesToday: Math.round(today.revenue * 100) / 100,
      activeCampaigns: active,
      averageScreenLatencyMs: this.sim.fleet.averageLatencyMs(),
      modelVersion: this.sim.engine.learning.version,
      playlistBuild: this.sim.engine.performanceStats(),
    };
  }

  @ApiOperation({ summary: 'Load the worked example: Gate 42 at 14:10, paused' })
  @ZodBody(WorkedExampleBody)
  @Post('sim/scenario/worked-example')
  @HttpCode(200)
  async workedExample(@Body() body: unknown) {
    const { localTime } = parseInput(WorkedExampleBody, body ?? {});
    const at = await this.sim.workedExample(Number(localTime.slice(0, 2)), Number(localTime.slice(3, 5)));
    return { at: at.toISOString(), screenId: 'SCR-T2-D-01', clock: this.sim.clock.state() };
  }
}
