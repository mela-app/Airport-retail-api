/**
 * Master data management: vendors (advertisers), outlets and F&B retailers, airlines, locations (terminals,
 * zones, gates), screens, campaigns and creatives.
 *
 * Every write is validated against the canonical schemas and against the rest of the master data (the zone of
 * an outlet exists, a campaign's creatives belong to its advertiser, …). After a write the decision engine
 * reloads its catalog, so the change applies from the next slot, and a `catalog` event tells the UIs to refresh.
 * Records that other data refers to are deactivated rather than deleted.
 */
import { randomUUID } from 'node:crypto';

import {
  type Advertiser,
  AdvertiserSchema,
  type Campaign,
  CampaignSchema,
  type Creative,
  CreativeSchema,
  type Gate,
  GateSchema,
  OutletSchema,
  type Screen,
  ScreenSchema,
  ZoneSchema,
  distance,
  gateId,
  rectCentre,
} from '@arm/domain';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import {
  rowToAdvertiser,
  rowToCampaign,
  rowToCreative,
  rowToOutlet,
  rowToScreen,
} from '../engine/catalog.js';
import type { Simulation } from '../sim/simulation.js';

export class MasterDataError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'conflict',
  ) {
    super(message);
    this.name = 'MasterDataError';
  }
}

const newId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`;

// ---- input schemas ----------------------------------------------------------------------------------------

export const AdvertiserInput = AdvertiserSchema.omit({ id: true, onboardedAt: true });
export const AirlineInput = z.object({
  iata: z.string().regex(/^[A-Z0-9]{2}$/),
  icao: z.string().regex(/^[A-Z]{3}$/),
  name: z.string().min(2).max(80),
  model: z.enum(['low_cost', 'full_service']),
  market: z.enum(['domestic', 'international', 'mixed']),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export const AirlineUpdate = AirlineInput.omit({ iata: true });
export const OutletInput = OutletSchema.omit({
  id: true,
  openedAt: true,
  terminalId: true,
  position: true,
}).extend({
  position: OutletSchema.shape.position.optional(),
});
export const TerminalUpdate = z.object({
  name: z.string().min(2).max(60),
  mainMarket: z.enum(['domestic', 'international', 'mixed']),
});
export const ZoneInput = ZoneSchema;
export const ZoneUpdate = ZoneSchema.omit({ id: true, terminalId: true });
export const GateInput = GateSchema.omit({ id: true, terminalId: true, concourseId: true }).extend({
  terminalId: z.string().min(1),
  active: z.boolean().default(true),
});
export const GateUpdate = GateSchema.pick({ zoneId: true, remote: true, position: true }).extend({
  active: z.boolean(),
});
export const ScreenInput = ScreenSchema.omit({
  id: true,
  terminalId: true,
  status: true,
  installedAt: true,
  nearestGateIds: true,
  position: true,
}).extend({
  position: ScreenSchema.shape.position.optional(),
  nearestGateIds: z.array(z.string()).max(12).optional(),
});
export const CampaignInput = CampaignSchema.omit({
  id: true,
  status: true,
  performanceIndex: true,
  createdAt: true,
  updatedAt: true,
  competitorGroup: true,
}).extend({
  competitorGroup: z.string().max(40).nullable().optional(),
  status: z.enum(['draft', 'pending_review']).default('draft'),
});
export const CreativeInput = CreativeSchema.omit({ id: true, status: true, createdAt: true }).extend({
  status: z.enum(['draft', 'pending_review']).default('pending_review'),
});
export const ReviewInput = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(300).optional(),
  brandSafety: CreativeSchema.shape.brandSafety.optional(),
});

type Sim = Pick<Simulation, 'engine' | 'clock' | 'bus' | 'fleet'>;

export class MasterDataService {
  constructor(
    private readonly database: Database,
    private readonly sim: Sim,
  ) {}

  private get db() {
    return this.database.db;
  }

  private now(): Date {
    return this.sim.clock.now();
  }

  private async changed(entity: string, id: string, action: string): Promise<void> {
    await this.sim.engine.refreshCatalog();
    this.sim.bus.publish('catalog', { entity, id, action, at: this.now().toISOString() });
  }

  private layout() {
    return this.sim.engine.catalog.layout();
  }

  private requireZone(zoneId: string) {
    const zone = this.layout().zone(zoneId);
    if (!zone) throw new MasterDataError(`unknown zone ${zoneId}`, 'invalid');
    return zone;
  }

  // ---- advertisers ----------------------------------------------------------------------------------------

  async listAdvertisers(kind?: string): Promise<(Advertiser & { active: boolean })[]> {
    const rows = await this.db.select().from(t.advertisers);
    return rows
      .filter((r) => !kind || r.kind === kind)
      .map((r) => ({ ...rowToAdvertiser(r), active: r.active }));
  }

  async getAdvertiser(id: string) {
    const [row] = await this.db.select().from(t.advertisers).where(eq(t.advertisers.id, id));
    if (!row) throw new MasterDataError(`unknown advertiser ${id}`, 'not_found');
    return { ...rowToAdvertiser(row), active: row.active };
  }

  private async checkAdvertiser(input: z.infer<typeof AdvertiserInput>): Promise<void> {
    if (input.kind === 'airline') {
      if (!input.airlineIata)
        throw new MasterDataError('airline advertisers need an airline (IATA code)', 'invalid');
      const [al] = await this.db.select().from(t.airlines).where(eq(t.airlines.iata, input.airlineIata));
      if (!al) throw new MasterDataError(`unknown airline ${input.airlineIata}`, 'invalid');
    } else if (input.airlineIata) {
      throw new MasterDataError('only airline advertisers have an airline code', 'invalid');
    }
  }

  async createAdvertiser(input: z.infer<typeof AdvertiserInput>) {
    await this.checkAdvertiser(input);
    const row = { ...input, id: newId('adv'), onboardedAt: this.now(), active: true };
    await this.db.insert(t.advertisers).values(row);
    await this.changed('advertiser', row.id, 'created');
    return this.getAdvertiser(row.id);
  }

  async updateAdvertiser(id: string, input: z.infer<typeof AdvertiserInput>) {
    await this.getAdvertiser(id);
    await this.checkAdvertiser(input);
    await this.db.update(t.advertisers).set(input).where(eq(t.advertisers.id, id));
    await this.changed('advertiser', id, 'updated');
    return this.getAdvertiser(id);
  }

  /** Deactivate a vendor: its running campaigns are paused. */
  async deactivateAdvertiser(id: string) {
    await this.getAdvertiser(id);
    await this.db.update(t.advertisers).set({ active: false }).where(eq(t.advertisers.id, id));
    const campaigns = await this.db.select().from(t.campaigns).where(eq(t.campaigns.advertiserId, id));
    for (const c of campaigns.filter((x) => x.status === 'active'))
      await this.db
        .update(t.campaigns)
        .set({ status: 'paused', updatedAt: this.now() })
        .where(eq(t.campaigns.id, c.id));
    await this.changed('advertiser', id, 'deactivated');
    return this.getAdvertiser(id);
  }

  // ---- airlines -------------------------------------------------------------------------------------------

  async listAirlines() {
    return this.db.select().from(t.airlines);
  }

  async createAirline(input: z.infer<typeof AirlineInput>) {
    const [exists] = await this.db.select().from(t.airlines).where(eq(t.airlines.iata, input.iata));
    if (exists) throw new MasterDataError(`airline ${input.iata} already exists`, 'conflict');
    await this.db.insert(t.airlines).values({ ...input, active: true });
    await this.changed('airline', input.iata, 'created');
    return { ...input, active: true };
  }

  async updateAirline(iata: string, input: z.infer<typeof AirlineUpdate> & { active?: boolean }) {
    const [exists] = await this.db.select().from(t.airlines).where(eq(t.airlines.iata, iata));
    if (!exists) throw new MasterDataError(`unknown airline ${iata}`, 'not_found');
    await this.db.update(t.airlines).set(input).where(eq(t.airlines.iata, iata));
    await this.changed('airline', iata, 'updated');
    const [row] = await this.db.select().from(t.airlines).where(eq(t.airlines.iata, iata));
    return row;
  }

  // ---- outlets --------------------------------------------------------------------------------------------

  async listOutlets(advertiserId?: string) {
    const rows = await this.db.select().from(t.outlets);
    return rows
      .filter((r) => !advertiserId || r.advertiserId === advertiserId)
      .map((r) => ({ ...rowToOutlet(r), active: r.active }));
  }

  async getOutlet(id: string) {
    const [row] = await this.db.select().from(t.outlets).where(eq(t.outlets.id, id));
    if (!row) throw new MasterDataError(`unknown outlet ${id}`, 'not_found');
    return { ...rowToOutlet(row), active: row.active };
  }

  async createOutlet(input: z.infer<typeof OutletInput>) {
    await this.getAdvertiser(input.advertiserId);
    const zone = this.requireZone(input.zoneId);
    const row = {
      ...input,
      id: newId('out'),
      terminalId: zone.terminalId,
      position: input.position ?? rectCentre(zone.area),
      openedAt: this.now(),
      active: true,
    };
    await this.db.insert(t.outlets).values(row);
    await this.changed('outlet', row.id, 'created');
    return this.getOutlet(row.id);
  }

  async updateOutlet(id: string, input: z.infer<typeof OutletInput>) {
    await this.getOutlet(id);
    await this.getAdvertiser(input.advertiserId);
    const zone = this.requireZone(input.zoneId);
    await this.db
      .update(t.outlets)
      .set({ ...input, terminalId: zone.terminalId, position: input.position ?? rectCentre(zone.area) })
      .where(eq(t.outlets.id, id));
    await this.changed('outlet', id, 'updated');
    return this.getOutlet(id);
  }

  async deactivateOutlet(id: string) {
    await this.getOutlet(id);
    await this.db.update(t.outlets).set({ active: false }).where(eq(t.outlets.id, id));
    await this.changed('outlet', id, 'deactivated');
    return this.getOutlet(id);
  }

  // ---- locations ------------------------------------------------------------------------------------------

  locations() {
    const layout = this.layout();
    return { terminals: layout.terminals, zones: layout.zones, gates: layout.gates };
  }

  async updateTerminal(id: string, input: z.infer<typeof TerminalUpdate>) {
    if (!this.layout().terminals.some((x) => x.id === id))
      throw new MasterDataError(`unknown terminal ${id}`, 'not_found');
    await this.db.update(t.terminals).set(input).where(eq(t.terminals.id, id));
    await this.changed('terminal', id, 'updated');
    return this.layout().terminals.find((x) => x.id === id);
  }

  async createZone(input: z.infer<typeof ZoneInput>) {
    if (this.layout().zone(input.id))
      throw new MasterDataError(`zone ${input.id} already exists`, 'conflict');
    if (!this.layout().terminals.some((x) => x.id === input.terminalId))
      throw new MasterDataError(`unknown terminal ${input.terminalId}`, 'invalid');
    await this.db.insert(t.zones).values(input);
    await this.changed('zone', input.id, 'created');
    return this.layout().zone(input.id);
  }

  async updateZone(id: string, input: z.infer<typeof ZoneUpdate>) {
    const zone = this.layout().zone(id);
    if (!zone) throw new MasterDataError(`unknown zone ${id}`, 'not_found');
    await this.db.update(t.zones).set(input).where(eq(t.zones.id, id));
    await this.changed('zone', id, 'updated');
    return this.layout().zone(id);
  }

  async createGate(input: z.infer<typeof GateInput>) {
    const zone = this.requireZone(input.zoneId);
    if (zone.terminalId !== input.terminalId)
      throw new MasterDataError(`zone ${zone.id} is not in ${input.terminalId}`, 'invalid');
    const id = gateId(input.terminalId, input.code);
    if (this.layout().gate(id))
      throw new MasterDataError(`gate ${input.code} already exists in ${input.terminalId}`, 'conflict');
    const row: Gate & { active: boolean } = { ...input, id, concourseId: zone.concourseId };
    await this.db.insert(t.gates).values(row);
    await this.changed('gate', id, 'created');
    return this.layout().gate(id);
  }

  async updateGate(id: string, input: z.infer<typeof GateUpdate>) {
    const gate = this.layout().gate(id);
    if (!gate) throw new MasterDataError(`unknown gate ${id}`, 'not_found');
    const zone = this.requireZone(input.zoneId);
    if (zone.terminalId !== gate.terminalId)
      throw new MasterDataError(`zone ${zone.id} is not in ${gate.terminalId}`, 'invalid');
    await this.db
      .update(t.gates)
      .set({ ...input, concourseId: zone.concourseId })
      .where(eq(t.gates.id, id));
    await this.changed('gate', id, 'updated');
    return this.layout().gate(id);
  }

  // ---- screens --------------------------------------------------------------------------------------------

  async listScreens(zoneId?: string): Promise<Screen[]> {
    const rows = await this.db.select().from(t.screens);
    return rows.filter((r) => !zoneId || r.zoneId === zoneId).map(rowToScreen);
  }

  async getScreen(id: string): Promise<Screen> {
    const [row] = await this.db.select().from(t.screens).where(eq(t.screens.id, id));
    if (!row) throw new MasterDataError(`unknown screen ${id}`, 'not_found');
    return rowToScreen(row);
  }

  /** Gates a screen at `position` faces: its own room for gate areas, else its terminal within 180 m. */
  private nearestGates(zoneId: string, position: { x: number; y: number }): string[] {
    const zone = this.requireZone(zoneId);
    if (['landside_hall', 'security', 'arrivals_hall'].includes(zone.kind)) return [];
    const gateArea = zone.kind === 'pier' || zone.kind === 'bus_lounge';
    return this.layout()
      .gates.filter((g) => g.terminalId === zone.terminalId && (!gateArea || g.zoneId === zone.id))
      .map((g) => ({ id: g.id, d: distance(g.position, position) }))
      .filter((g) => g.d <= 180)
      .sort((a, b) => a.d - b.d)
      .slice(0, 6)
      .map((g) => g.id);
  }

  private checkGates(ids: readonly string[]): void {
    const unknown = ids.filter((id) => !this.layout().gate(id));
    if (unknown.length > 0) throw new MasterDataError(`unknown gates: ${unknown.join(', ')}`, 'invalid');
  }

  async createScreen(input: z.infer<typeof ScreenInput>) {
    const zone = this.requireZone(input.zoneId);
    const position = input.position ?? rectCentre(zone.area);
    if (input.nearestGateIds) this.checkGates(input.nearestGateIds);
    const now = this.now();
    const row = {
      ...input,
      id: newId(`SCR-${zone.id}`),
      terminalId: zone.terminalId,
      position,
      nearestGateIds: input.nearestGateIds ?? this.nearestGates(zone.id, position),
      status: 'online',
      statusSince: now,
      lastHeartbeat: now,
      latencyMs: null,
      installedAt: now,
    };
    await this.db.insert(t.screens).values(row);
    this.sim.fleet.add(row.id, now);
    await this.changed('screen', row.id, 'created');
    return this.getScreen(row.id);
  }

  async updateScreen(id: string, input: z.infer<typeof ScreenInput>) {
    await this.getScreen(id);
    const zone = this.requireZone(input.zoneId);
    const position = input.position ?? rectCentre(zone.area);
    if (input.nearestGateIds) this.checkGates(input.nearestGateIds);
    await this.db
      .update(t.screens)
      .set({
        ...input,
        terminalId: zone.terminalId,
        position,
        nearestGateIds: input.nearestGateIds ?? this.nearestGates(zone.id, position),
      })
      .where(eq(t.screens.id, id));
    await this.changed('screen', id, 'updated');
    return this.getScreen(id);
  }

  // ---- creatives ------------------------------------------------------------------------------------------

  async listCreatives(filter: { advertiserId?: string; status?: string }): Promise<Creative[]> {
    const rows = await this.db.select().from(t.creatives);
    return rows
      .map(rowToCreative)
      .filter(
        (c) =>
          (!filter.advertiserId || c.advertiserId === filter.advertiserId) &&
          (!filter.status || c.status === filter.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getCreative(id: string): Promise<Creative> {
    const [row] = await this.db.select().from(t.creatives).where(eq(t.creatives.id, id));
    if (!row) throw new MasterDataError(`unknown creative ${id}`, 'not_found');
    return rowToCreative(row);
  }

  async createCreative(input: z.infer<typeof CreativeInput>): Promise<Creative> {
    await this.getAdvertiser(input.advertiserId);
    const row = { ...input, id: newId('cr'), createdAt: this.now() };
    await this.db.insert(t.creatives).values(row);
    await this.changed('creative', row.id, 'created');
    return this.getCreative(row.id);
  }

  async updateCreative(id: string, input: z.infer<typeof CreativeInput>): Promise<Creative> {
    const current = await this.getCreative(id);
    if (current.advertiserId !== input.advertiserId)
      throw new MasterDataError('a creative cannot move to another advertiser', 'invalid');
    // Editing an approved creative sends it back for review.
    await this.db
      .update(t.creatives)
      .set({ ...input, status: 'pending_review' })
      .where(eq(t.creatives.id, id));
    await this.changed('creative', id, 'updated');
    return this.getCreative(id);
  }

  async duplicateCreative(id: string): Promise<Creative> {
    const c = await this.getCreative(id);
    const { id: _id, createdAt: _created, status: _status, ...rest } = c;
    return this.createCreative({ ...rest, name: `${c.name} (copy)`, status: 'draft' });
  }

  async reviewCreative(id: string, review: z.infer<typeof ReviewInput>): Promise<Creative> {
    const c = await this.getCreative(id);
    const brandSafety = review.brandSafety ?? c.brandSafety;
    if (review.decision === 'approve' && !Object.values(brandSafety).every(Boolean))
      throw new MasterDataError('every brand-safety check must pass before approval', 'invalid');
    await this.db
      .update(t.creatives)
      .set({ status: review.decision === 'approve' ? 'approved' : 'rejected', brandSafety })
      .where(eq(t.creatives.id, id));
    await this.changed('creative', id, review.decision === 'approve' ? 'approved' : 'rejected');
    return this.getCreative(id);
  }

  // ---- campaigns ------------------------------------------------------------------------------------------

  async listCampaigns(filter: { advertiserId?: string; status?: string }): Promise<Campaign[]> {
    const rows = await this.db.select().from(t.campaigns);
    return rows
      .map(rowToCampaign)
      .filter(
        (c) =>
          (!filter.advertiserId || c.advertiserId === filter.advertiserId) &&
          (!filter.status || c.status === filter.status),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getCampaign(id: string): Promise<Campaign> {
    const [row] = await this.db.select().from(t.campaigns).where(eq(t.campaigns.id, id));
    if (!row) throw new MasterDataError(`unknown campaign ${id}`, 'not_found');
    return rowToCampaign(row);
  }

  private async checkCampaign(input: z.infer<typeof CampaignInput>): Promise<Advertiser> {
    const advertiser = await this.getAdvertiser(input.advertiserId);
    for (const id of input.creativeIds) {
      const c = await this.getCreative(id).catch(() => undefined);
      if (!c) throw new MasterDataError(`unknown creative ${id}`, 'invalid');
      if (c.advertiserId !== input.advertiserId)
        throw new MasterDataError(`creative ${id} belongs to another advertiser`, 'invalid');
    }
    const { zoneIds, screenIds, gateIds, schedule } = input.placement;
    for (const z of zoneIds) this.requireZone(z);
    this.checkGates(gateIds);
    const screens = new Set((await this.listScreens()).map((s) => s.id));
    const unknownScreens = screenIds.filter((s) => !screens.has(s));
    if (unknownScreens.length > 0)
      throw new MasterDataError(`unknown screens: ${unknownScreens.join(', ')}`, 'invalid');
    if (zoneIds.length + screenIds.length + gateIds.length === 0)
      throw new MasterDataError('a campaign needs at least one zone, screen or gate', 'invalid');
    if (Date.parse(schedule.end) <= Date.parse(schedule.start))
      throw new MasterDataError('the schedule must end after it starts', 'invalid');
    if (schedule.hours && schedule.hours.to <= schedule.hours.from)
      throw new MasterDataError('the daily hours must end after they start', 'invalid');
    if (input.budget.dailyCap > input.budget.total)
      throw new MasterDataError('the daily cap cannot exceed the total budget', 'invalid');
    if (input.promo?.outletId) {
      const outlet = await this.getOutlet(input.promo.outletId).catch(() => undefined);
      const sponsors = new Set([input.advertiserId, input.coFundedBy ?? '']);
      if (!outlet || !sponsors.has(outlet.advertiserId))
        throw new MasterDataError(
          'the promo outlet must belong to the advertiser or its co-funding partner',
          'invalid',
        );
    }
    if (input.coFundedBy) await this.getAdvertiser(input.coFundedBy);
    return advertiser;
  }

  async createCampaign(input: z.infer<typeof CampaignInput>): Promise<Campaign> {
    const advertiser = await this.checkCampaign(input);
    const now = this.now();
    const row = {
      ...input,
      id: newId('cmp'),
      competitorGroup: input.competitorGroup ?? advertiser.competitorGroup,
      // New campaigns start from a neutral prior; the learning loop adjusts it from scans and redemptions.
      performanceIndex: 0.3,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(t.campaigns).values(row);
    await this.changed('campaign', row.id, 'created');
    return this.getCampaign(row.id);
  }

  async updateCampaign(id: string, input: z.infer<typeof CampaignInput>): Promise<Campaign> {
    const current = await this.getCampaign(id);
    if (current.advertiserId !== input.advertiserId)
      throw new MasterDataError('a campaign cannot move to another advertiser', 'invalid');
    const advertiser = await this.checkCampaign(input);
    // Changing a live campaign's targeting or creatives sends it back for review.
    const status = current.status === 'active' ? 'pending_review' : input.status;
    await this.db
      .update(t.campaigns)
      .set({
        ...input,
        status,
        competitorGroup: input.competitorGroup ?? advertiser.competitorGroup,
        updatedAt: this.now(),
      })
      .where(eq(t.campaigns.id, id));
    await this.changed('campaign', id, 'updated');
    return this.getCampaign(id);
  }

  /** "Run again" / duplicate: a draft copy starting now, for the same length. */
  async duplicateCampaign(id: string): Promise<Campaign> {
    const c = await this.getCampaign(id);
    const now = this.now();
    const length = Date.parse(c.placement.schedule.end) - Date.parse(c.placement.schedule.start);
    const { id: _id, status: _s, performanceIndex: _p, createdAt: _c, updatedAt: _u, ...rest } = c;
    return this.createCampaign({
      ...rest,
      name: `${c.name} (copy)`,
      status: 'draft',
      placement: {
        ...c.placement,
        schedule: {
          ...c.placement.schedule,
          start: now.toISOString(),
          end: new Date(now.getTime() + Math.max(length, 86_400_000)).toISOString(),
        },
      },
    });
  }

  private async setCampaignStatus(id: string, status: Campaign['status'], action: string): Promise<Campaign> {
    await this.db.update(t.campaigns).set({ status, updatedAt: this.now() }).where(eq(t.campaigns.id, id));
    await this.changed('campaign', id, action);
    return this.getCampaign(id);
  }

  async submitCampaign(id: string): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (!['draft', 'rejected'].includes(c.status))
      throw new MasterDataError(`a ${c.status} campaign cannot be submitted`, 'conflict');
    return this.setCampaignStatus(id, 'pending_review', 'submitted');
  }

  /** Media Manager review. Approval needs every creative approved; the campaign then goes live on schedule. */
  async reviewCampaign(id: string, review: z.infer<typeof ReviewInput>): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (c.status !== 'pending_review')
      throw new MasterDataError(`campaign is ${c.status}, not pending review`, 'conflict');
    if (review.decision === 'reject') return this.setCampaignStatus(id, 'rejected', 'rejected');
    const creatives = await Promise.all(c.creativeIds.map((cid) => this.getCreative(cid)));
    const unapproved = creatives.filter((x) => x.status !== 'approved').map((x) => x.id);
    if (unapproved.length > 0)
      throw new MasterDataError(`creatives not approved yet: ${unapproved.join(', ')}`, 'conflict');
    return this.setCampaignStatus(id, 'active', 'approved');
  }

  async pauseCampaign(id: string): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (c.status !== 'active')
      throw new MasterDataError(`a ${c.status} campaign cannot be paused`, 'conflict');
    return this.setCampaignStatus(id, 'paused', 'paused');
  }

  async resumeCampaign(id: string): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (c.status !== 'paused')
      throw new MasterDataError(`a ${c.status} campaign cannot be resumed`, 'conflict');
    return this.setCampaignStatus(id, 'active', 'resumed');
  }

  /** Mock stock toggle: pausing a promo when the item is out of stock. */
  async setStock(id: string, inStock: boolean): Promise<Campaign> {
    const c = await this.getCampaign(id);
    if (!c.promo) throw new MasterDataError('this campaign has no promo', 'invalid');
    await this.db
      .update(t.campaigns)
      .set({ promo: { ...c.promo, inStock }, updatedAt: this.now() })
      .where(eq(t.campaigns.id, id));
    await this.changed('campaign', id, inStock ? 'back_in_stock' : 'out_of_stock');
    return this.getCampaign(id);
  }

  /** Drafts can be deleted; anything that ran is kept for history. */
  async deleteCampaign(id: string): Promise<{ deleted: string }> {
    const c = await this.getCampaign(id);
    if (c.status !== 'draft')
      throw new MasterDataError('only draft campaigns can be deleted; pause or complete others', 'conflict');
    await this.db.delete(t.campaigns).where(eq(t.campaigns.id, id));
    await this.changed('campaign', id, 'deleted');
    return { deleted: id };
  }
}
