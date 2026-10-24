/**
 * Master data REST API: vendors (advertisers), airlines, outlets, locations, screens, creatives and campaigns.
 */
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodBody, ZodQuery } from '../core/openapi.js';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';

import { DATABASE, SIMULATION } from '../core/tokens.js';
import { parseInput } from '../core/http.js';
import type { Database } from '../db/client.js';
import {
  AdvertiserInput,
  AirlineInput,
  AirlineUpdate,
  CampaignInput,
  CreativeInput,
  GateInput,
  GateUpdate,
  MasterDataService,
  OutletInput,
  ReviewInput,
  ScreenInput,
  TerminalUpdate,
  ZoneInput,
  ZoneUpdate,
} from '../master/master-data.service.js';
import type { Simulation } from '../sim/simulation.js';

const KindQuery = z.object({ kind: z.enum(['retailer', 'fnb', 'airline', 'brand', 'service']).optional() });
const AdvertiserQuery = z.object({ advertiserId: z.string().max(40).optional() });
const StatusQuery = AdvertiserQuery.extend({ status: z.string().max(20).optional() });
const ZoneQuery = z.object({ zoneId: z.string().max(20).optional() });
const AirlinePut = AirlineUpdate.extend({ active: z.boolean().optional() });
const StockBody = z.object({ inStock: z.boolean() });

@ApiTags('Master data')
@Controller('api')
export class MasterDataController {
  private readonly service: MasterDataService;

  constructor(@Inject(DATABASE) database: Database, @Inject(SIMULATION) sim: Simulation) {
    this.service = new MasterDataService(database, sim);
  }

  // ---- vendors --------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Vendors (advertisers): retailers, F&B, airlines, brands, services' })
  @ZodQuery(KindQuery)
  @Get('advertisers')
  advertisers(@Query() q: unknown) {
    return this.service.listAdvertisers(parseInput(KindQuery, q).kind);
  }

  @ApiOperation({ summary: 'One vendor' })
  @Get('advertisers/:id')
  advertiser(@Param('id') id: string) {
    return this.service.getAdvertiser(id);
  }

  @ApiOperation({ summary: 'Onboard a vendor' })
  @ZodBody(AdvertiserInput)
  @Post('advertisers')
  createAdvertiser(@Body() body: unknown) {
    return this.service.createAdvertiser(parseInput(AdvertiserInput, body));
  }

  @ApiOperation({ summary: 'Edit a vendor' })
  @ZodBody(AdvertiserInput)
  @Put('advertisers/:id')
  updateAdvertiser(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateAdvertiser(id, parseInput(AdvertiserInput, body));
  }

  @ApiOperation({ summary: 'Deactivate a vendor (its running campaigns are paused)' })
  @Delete('advertisers/:id')
  @HttpCode(200)
  deactivateAdvertiser(@Param('id') id: string) {
    return this.service.deactivateAdvertiser(id);
  }

  // ---- airlines -------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Airlines' })
  @Get('airlines')
  airlines() {
    return this.service.listAirlines();
  }

  @ApiOperation({ summary: 'Add an airline' })
  @ZodBody(AirlineInput)
  @Post('airlines')
  createAirline(@Body() body: unknown) {
    return this.service.createAirline(parseInput(AirlineInput, body));
  }

  @ApiOperation({ summary: 'Edit or deactivate an airline' })
  @ZodBody(AirlinePut)
  @Put('airlines/:iata')
  updateAirline(@Param('iata') iata: string, @Body() body: unknown) {
    return this.service.updateAirline(iata, parseInput(AirlinePut, body));
  }

  // ---- outlets --------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Outlets and F&B retailers' })
  @ZodQuery(AdvertiserQuery)
  @Get('outlets')
  outlets(@Query() q: unknown) {
    return this.service.listOutlets(parseInput(AdvertiserQuery, q).advertiserId);
  }

  @ApiOperation({ summary: 'One outlet' })
  @Get('outlets/:id')
  outlet(@Param('id') id: string) {
    return this.service.getOutlet(id);
  }

  @ApiOperation({ summary: 'Add an outlet' })
  @ZodBody(OutletInput)
  @Post('outlets')
  createOutlet(@Body() body: unknown) {
    return this.service.createOutlet(parseInput(OutletInput, body));
  }

  @ApiOperation({ summary: 'Edit an outlet' })
  @ZodBody(OutletInput)
  @Put('outlets/:id')
  updateOutlet(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateOutlet(id, parseInput(OutletInput, body));
  }

  @ApiOperation({ summary: 'Deactivate an outlet' })
  @Delete('outlets/:id')
  @HttpCode(200)
  deactivateOutlet(@Param('id') id: string) {
    return this.service.deactivateOutlet(id);
  }

  // ---- locations ------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Locations: terminals, zones and gates' })
  @Get('locations')
  locations() {
    return this.service.locations();
  }

  @ApiOperation({ summary: 'Edit a terminal' })
  @ZodBody(TerminalUpdate)
  @Put('terminals/:id')
  updateTerminal(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateTerminal(id, parseInput(TerminalUpdate, body));
  }

  @ApiOperation({ summary: 'Add a zone' })
  @ZodBody(ZoneInput)
  @Post('zones')
  createZone(@Body() body: unknown) {
    return this.service.createZone(parseInput(ZoneInput, body));
  }

  @ApiOperation({ summary: 'Edit a zone' })
  @ZodBody(ZoneUpdate)
  @Put('zones/:id')
  updateZone(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateZone(id, parseInput(ZoneUpdate, body));
  }

  @ApiOperation({ summary: 'Add a gate' })
  @ZodBody(GateInput)
  @Post('gates')
  createGate(@Body() body: unknown) {
    return this.service.createGate(parseInput(GateInput, body));
  }

  @ApiOperation({ summary: 'Edit a gate or take it out of service' })
  @ZodBody(GateUpdate)
  @Put('gates/:id')
  updateGate(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateGate(id, parseInput(GateUpdate, body));
  }

  // ---- screens --------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Screens' })
  @ZodQuery(ZoneQuery)
  @Get('screens')
  screens(@Query() q: unknown) {
    return this.service.listScreens(parseInput(ZoneQuery, q).zoneId);
  }

  @ApiOperation({ summary: 'One screen' })
  @Get('screens/:id')
  screen(@Param('id') id: string) {
    return this.service.getScreen(id);
  }

  @ApiOperation({ summary: 'Install a screen (nearest gates computed when omitted)' })
  @ZodBody(ScreenInput)
  @Post('screens')
  createScreen(@Body() body: unknown) {
    return this.service.createScreen(parseInput(ScreenInput, body));
  }

  @ApiOperation({ summary: 'Edit a screen' })
  @ZodBody(ScreenInput)
  @Put('screens/:id')
  updateScreen(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateScreen(id, parseInput(ScreenInput, body));
  }

  // ---- creatives ------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Creative library' })
  @ZodQuery(StatusQuery)
  @Get('creatives')
  creatives(@Query() q: unknown) {
    return this.service.listCreatives(parseInput(StatusQuery, q));
  }

  @ApiOperation({ summary: 'One creative' })
  @Get('creatives/:id')
  creative(@Param('id') id: string) {
    return this.service.getCreative(id);
  }

  @ApiOperation({ summary: 'Create a creative' })
  @ZodBody(CreativeInput)
  @Post('creatives')
  createCreative(@Body() body: unknown) {
    return this.service.createCreative(parseInput(CreativeInput, body));
  }

  @ApiOperation({ summary: 'Edit a creative (sends it back for review)' })
  @ZodBody(CreativeInput)
  @Put('creatives/:id')
  updateCreative(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCreative(id, parseInput(CreativeInput, body));
  }

  @ApiOperation({ summary: 'Duplicate a creative' })
  @Post('creatives/:id/duplicate')
  duplicateCreative(@Param('id') id: string) {
    return this.service.duplicateCreative(id);
  }

  @ApiOperation({ summary: 'Approve or reject a creative (brand-safety checklist)' })
  @ZodBody(ReviewInput)
  @Post('creatives/:id/review')
  @HttpCode(200)
  reviewCreative(@Param('id') id: string, @Body() body: unknown) {
    return this.service.reviewCreative(id, parseInput(ReviewInput, body));
  }

  // ---- campaigns ------------------------------------------------------------------------------------------

  @ApiOperation({ summary: 'Campaigns' })
  @ZodQuery(StatusQuery)
  @Get('campaigns')
  campaigns(@Query() q: unknown) {
    return this.service.listCampaigns(parseInput(StatusQuery, q));
  }

  @ApiOperation({ summary: 'One campaign' })
  @Get('campaigns/:id')
  campaign(@Param('id') id: string) {
    return this.service.getCampaign(id);
  }

  @ApiOperation({ summary: 'Create a campaign (draft)' })
  @ZodBody(CampaignInput)
  @Post('campaigns')
  createCampaign(@Body() body: unknown) {
    return this.service.createCampaign(parseInput(CampaignInput, body));
  }

  @ApiOperation({ summary: 'Edit a campaign' })
  @ZodBody(CampaignInput)
  @Put('campaigns/:id')
  updateCampaign(@Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCampaign(id, parseInput(CampaignInput, body));
  }

  @ApiOperation({ summary: 'Delete a draft campaign' })
  @Delete('campaigns/:id')
  @HttpCode(200)
  deleteCampaign(@Param('id') id: string) {
    return this.service.deleteCampaign(id);
  }

  @ApiOperation({ summary: 'Duplicate a campaign ("run again")' })
  @Post('campaigns/:id/duplicate')
  duplicateCampaign(@Param('id') id: string) {
    return this.service.duplicateCampaign(id);
  }

  @ApiOperation({ summary: 'Submit a campaign for review' })
  @Post('campaigns/:id/submit')
  @HttpCode(200)
  submitCampaign(@Param('id') id: string) {
    return this.service.submitCampaign(id);
  }

  @ApiOperation({ summary: 'Approve or reject a campaign' })
  @ZodBody(ReviewInput)
  @Post('campaigns/:id/review')
  @HttpCode(200)
  reviewCampaign(@Param('id') id: string, @Body() body: unknown) {
    return this.service.reviewCampaign(id, parseInput(ReviewInput, body));
  }

  @ApiOperation({ summary: 'Pause a campaign' })
  @Post('campaigns/:id/pause')
  @HttpCode(200)
  pauseCampaign(@Param('id') id: string) {
    return this.service.pauseCampaign(id);
  }

  @ApiOperation({ summary: 'Resume a paused campaign' })
  @Post('campaigns/:id/resume')
  @HttpCode(200)
  resumeCampaign(@Param('id') id: string) {
    return this.service.resumeCampaign(id);
  }

  @ApiOperation({ summary: 'Stock toggle: pause the promo while the item is out of stock' })
  @ZodBody(StockBody)
  @Put('campaigns/:id/stock')
  setStock(@Param('id') id: string, @Body() body: unknown) {
    return this.service.setStock(id, parseInput(StockBody, body).inStock);
  }
}
