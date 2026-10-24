/**
 * Live operational reads: flights, feed health, screen runtime status, incidents, service health.
 */
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZodBody, ZodQuery } from '../core/openapi.js';
import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { DESTINATIONS, type Flight, delayMinutes, gateId } from '@arm/domain';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { DATABASE, SIMULATION } from '../core/tokens.js';
import { parseInput } from '../core/http.js';
import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import type { Simulation } from '../sim/simulation.js';

const FlightQuery = z.object({
  direction: z.enum(['A', 'D']).optional(),
  terminal: z.string().max(4).optional(),
  airline: z.string().length(2).optional(),
  status: z.string().max(20).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  q: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});

const IncidentQuery = z.object({
  status: z.enum(['active', 'open', 'acknowledged', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const IncidentPatch = z
  .object({
    status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
    owner: z.string().min(1).max(80).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.owner !== undefined, { message: 'nothing to update' });

const CITIES = new Map(DESTINATIONS.map((d) => [d.iata, d.city]));

const view = (f: Flight) => ({
  ...f,
  gateId: f.gate ? gateId(f.terminal, f.gate) : null,
  delayMinutes: delayMinutes(f),
  /** City at the other end (destination of a departure, origin of an arrival). */
  otherCity: CITIES.get(f.direction === 'D' ? f.destination : f.origin) ?? null,
});

@ApiTags('Operations')
@Controller('api')
export class OperationsController {
  constructor(
    @Inject(SIMULATION) private readonly sim: Simulation,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  @ApiOperation({ summary: 'Service health' })
  @Get('health')
  health() {
    return {
      status: this.sim.isRunning ? 'ok' : 'starting',
      simTime: this.sim.clock.now().toISOString(),
      database: this.database.engine,
      uptimeSec: Math.round(process.uptime()),
    };
  }

  @ApiOperation({ summary: 'Flights (canonical model) with filters' })
  @ZodQuery(FlightQuery)
  @Get('flights')
  flights(@Query() query: unknown) {
    const q = parseInput(FlightQuery, query);
    const from = q.from ? Date.parse(q.from) : -Infinity;
    const to = q.to ? Date.parse(q.to) : Infinity;
    const text = q.q?.toUpperCase();
    return this.sim.state
      .allFlights()
      .filter((f) => !q.direction || f.direction === q.direction)
      .filter((f) => !q.terminal || f.terminal === q.terminal)
      .filter((f) => !q.airline || f.airlineIata === q.airline)
      .filter((f) => !q.status || f.status === q.status)
      .filter((f) => {
        const t0 = Date.parse(f.estimatedTime ?? f.scheduledTime);
        return t0 >= from && t0 <= to;
      })
      .filter(
        (f) =>
          !text ||
          `${f.airlineIata}${f.flightNumber}`.includes(text) ||
          f.destination === text ||
          f.origin === text,
      )
      .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))
      .slice(0, q.limit)
      .map(view);
  }

  @ApiOperation({ summary: 'One flight with its event history' })
  @Get('flights/:id')
  async flight(@Param('id') id: string) {
    const flight = this.sim.state.flight(id);
    if (!flight) throw new NotFoundException({ error: 'not_found', message: `unknown flight ${id}` });
    const events = await this.database.db
      .select()
      .from(t.flightEvents)
      .where(eq(t.flightEvents.flightId, id))
      .orderBy(desc(t.flightEvents.occurredAt))
      .limit(50);
    return { flight: view(flight), profile: this.sim.state.profile(id) ?? null, events };
  }

  @ApiOperation({ summary: 'Most recent flight events (newest first)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  })
  @Get('flight-events/recent')
  recentEvents(@Query('limit') limit?: string) {
    const n = Math.min(200, Math.max(1, Number.parseInt(limit ?? '50', 10) || 50));
    return this.sim.state.recentEvents(n);
  }

  @ApiOperation({ summary: 'Feed health per adapter (AODB, AIDX, ACRIS, audience)' })
  @Get('feeds')
  feeds() {
    return {
      adapters: {
        flights: this.sim.sources.flights.adapter,
        space: this.sim.sources.space.adapter,
        audience: this.sim.sources.audience.adapter,
      },
      feeds: this.sim.sources.health(),
    };
  }

  @ApiOperation({ summary: 'Latest ACRIS queue measurement per queue' })
  @Get('queues/latest')
  queues() {
    return this.sim.state.latestQueues();
  }

  @ApiOperation({ summary: 'Runtime status, heartbeat and latency of every screen' })
  @Get('screens/status')
  screens() {
    return { averageLatencyMs: this.sim.fleet.averageLatencyMs(), screens: this.sim.fleet.all() };
  }

  @ApiOperation({ summary: 'Incidents and alerts' })
  @ZodQuery(IncidentQuery)
  @Get('incidents')
  incidents(@Query() query: unknown) {
    const q = parseInput(IncidentQuery, query);
    return this.sim.incidents.list({ ...(q.status ? { status: q.status } : {}), limit: q.limit });
  }

  @ApiOperation({ summary: "Update an incident's status or owner" })
  @ZodBody(IncidentPatch)
  @Patch('incidents/:id')
  async updateIncident(@Param('id') id: string, @Body() body: unknown) {
    const change = parseInput(IncidentPatch, body);
    const updated = await this.sim.incidents.update(
      id,
      {
        ...(change.status ? { status: change.status } : {}),
        ...(change.owner !== undefined ? { owner: change.owner } : {}),
      },
      this.sim.clock.now(),
    );
    if (!updated) throw new NotFoundException({ error: 'not_found', message: `unknown incident ${id}` });
    return updated;
  }
}
