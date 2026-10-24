/**
 * Read models for the role views: advertiser dashboards and passenger flow, promo codes, campaign performance
 * and the builder's live audience preview, airline overviews, inventory and pricing, delivery, and segment
 * heat maps.
 */
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { AnalyticsService } from '../analytics/analytics.service.js';
import { type AppConfig } from '../config.js';
import { parseInput } from '../core/http.js';
import { ZodBody, ZodQuery } from '../core/openapi.js';
import { CONFIG, DATABASE, SIMULATION } from '../core/tokens.js';
import type { Database } from '../db/client.js';
import { CampaignInput } from '../master/master-data.service.js';
import type { Simulation } from '../sim/simulation.js';

const FlowQuery = z.object({
  hours: z.coerce.number().int().min(1).max(6).default(2),
  zoneId: z.string().max(20).optional(),
});
const ZoneQuery = z.object({ zoneId: z.string().max(20).optional() });
const HeatmapQuery = ZoneQuery.extend({
  from: z.coerce.number().int().min(0).max(23).default(5),
  to: z.coerce.number().int().min(0).max(23).default(23),
});
const PreviewBody = CampaignInput.omit({ status: true });

@ApiTags('Analytics')
@Controller('api')
export class AnalyticsController {
  private readonly service: AnalyticsService;

  constructor(
    @Inject(DATABASE) database: Database,
    @Inject(SIMULATION) sim: Simulation,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.service = new AnalyticsService(database, sim, {
      simDate: config.SIM_DATE,
      utcOffsetMinutes: config.AIRPORT_UTC_OFFSET_MINUTES,
      slotSeconds: config.SLOT_SECONDS,
    });
  }

  @ApiOperation({
    summary: "An advertiser's live dashboard: today's totals, campaigns, hourly delivery, recent sales",
  })
  @Get('advertisers/:id/overview')
  overview(@Param('id') id: string) {
    return this.service.advertiserOverview(id);
  }

  @ApiOperation({
    summary: "Passenger flow in an advertiser's zones for the next hours (summary for the next 60 min)",
  })
  @ZodQuery(FlowQuery)
  @Get('advertisers/:id/flow')
  flow(@Param('id') id: string, @Query() q: unknown) {
    const query = parseInput(FlowQuery, q);
    return this.service.passengerFlow(id, query.hours, query.zoneId);
  }

  @ApiOperation({
    summary: "Promo codes issued for an advertiser's campaigns, with family shares and redemption state",
  })
  @Get('advertisers/:id/promo-codes')
  promoCodes(@Param('id') id: string) {
    return this.service.promoCodes(id);
  }

  @ApiOperation({
    summary: 'Campaign performance: today, last 30 days with ROI, conversion by segment, suggested weights',
  })
  @Get('campaigns/:id/performance')
  performance(@Param('id') id: string) {
    return this.service.campaignPerformance(id);
  }

  @ApiOperation({
    summary: 'Best three slots tomorrow for a campaign (zone × hour by expected fit, crowd and price)',
  })
  @Get('campaigns/:id/best-slots')
  bestSlots(@Param('id') id: string) {
    return this.service.bestSlots(id);
  }

  @ApiOperation({
    summary: 'Live audience preview of a campaign being built: how it would score on its screens now',
  })
  @ZodBody(PreviewBody)
  @Post('campaigns/preview')
  @HttpCode(200)
  preview(@Body() body: unknown) {
    return this.service.preview(parseInput(PreviewBody, body));
  }

  @ApiOperation({
    summary:
      "An airline's day: flights, passenger profile, what plays at its gates, goodwill, partner offers",
  })
  @Get('airlines/:iata/overview')
  airline(@Param('iata') iata: string) {
    return this.service.airlineOverview(iata.toUpperCase());
  }

  @ApiOperation({
    summary: 'Inventory calendar: screen × hour with predicted crowd, bookings, status and price',
  })
  @ZodQuery(ZoneQuery)
  @Get('inventory')
  inventory(@Query() q: unknown) {
    return this.service.inventory(parseInput(ZoneQuery, q).zoneId);
  }

  @ApiOperation({
    summary: 'Seven-day outlook: footfall, expected occupancy and average suggested price per day',
  })
  @Get('inventory/forecast')
  forecast() {
    return this.service.forecast7();
  }

  @ApiOperation({
    summary: 'Delivery per advertiser today against its pacing target (under-delivery flagged)',
  })
  @Get('delivery/advertisers')
  delivery() {
    return this.service.delivery();
  }

  @ApiOperation({ summary: 'Segment shares by hour for a zone (or all airside zones): the segment heat map' })
  @ZodQuery(HeatmapQuery)
  @Get('insights/segments')
  segments(@Query() q: unknown) {
    const query = parseInput(HeatmapQuery, q);
    return this.service.segmentHeatmap(query.zoneId, query.from, Math.max(query.from, query.to));
  }
}
