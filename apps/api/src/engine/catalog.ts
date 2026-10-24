/**
 * The engine's view of the platform's master data: campaigns, advertisers, creatives, screens, outlets, the
 * rule-engine settings and manual pins, loaded from the database. `version` changes on every reload, so
 * cached decision contexts are recomputed after an edit.
 */
import { and, gte, lte } from 'drizzle-orm';

import type { Advertiser, Campaign, Creative, Outlet, Screen, Terminal, Zone } from '@arm/domain';

import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEFAULT_RULE_ENGINE } from '../db/seed.js';
import { Layout, type LayoutGate } from './layout.js';
import type { Pin } from './rules.js';
import type { CampaignBundle, RuleEngineSettings } from './scoring.js';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function rowToCampaign(r: typeof t.campaigns.$inferSelect): Campaign {
  return {
    ...r,
    objective: r.objective as Campaign['objective'],
    status: r.status as Campaign['status'],
    creativeIds: r.creativeIds as string[],
    segmentWeights: r.segmentWeights as Campaign['segmentWeights'],
    hardFilters: r.hardFilters as Campaign['hardFilters'],
    placement: r.placement as Campaign['placement'],
    budget: r.budget as Campaign['budget'],
    triggers: r.triggers as Campaign['triggers'],
    promo: r.promo as Campaign['promo'],
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function rowToAdvertiser(r: typeof t.advertisers.$inferSelect): Advertiser {
  const { active: _active, ...rest } = r;
  return { ...rest, kind: r.kind as Advertiser['kind'], onboardedAt: iso(r.onboardedAt) };
}

export function rowToCreative(r: typeof t.creatives.$inferSelect): Creative {
  return {
    ...r,
    template: r.template as Creative['template'],
    palette: r.palette as Creative['palette'],
    content: r.content as Creative['content'],
    formats: r.formats as Creative['formats'],
    status: r.status as Creative['status'],
    brandSafety: r.brandSafety as Creative['brandSafety'],
    createdAt: iso(r.createdAt),
  };
}

export function rowToScreen(r: typeof t.screens.$inferSelect): Screen {
  return {
    id: r.id,
    name: r.name,
    terminalId: r.terminalId,
    zoneId: r.zoneId,
    position: r.position as Screen['position'],
    kind: r.kind as Screen['kind'],
    orientation: r.orientation as Screen['orientation'],
    sizeInches: r.sizeInches,
    resolution: r.resolution,
    nearestGateIds: r.nearestGateIds as string[],
    basePricePerSlot: r.basePricePerSlot,
    status: r.status as Screen['status'],
    installedAt: iso(r.installedAt),
  };
}

export function rowToOutlet(r: typeof t.outlets.$inferSelect): Outlet {
  const { active: _active, ...rest } = r;
  return {
    ...rest,
    category: r.category as Outlet['category'],
    position: r.position as Outlet['position'],
    openedAt: iso(r.openedAt),
  };
}

export interface PinRecord extends Pin {
  screenId: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export class Catalog {
  private campaignsById = new Map<string, Campaign>();
  private advertisersById = new Map<string, Advertiser>();
  private creativesById = new Map<string, Creative>();
  private screensById = new Map<string, Screen>();
  private outletsById = new Map<string, Outlet>();
  private screensPerZone = new Map<string, number>();
  private pinsByScreen = new Map<string, PinRecord[]>();
  private ruleSettings: RuleEngineSettings = { ...DEFAULT_RULE_ENGINE };
  private layoutInUse = Layout.default();
  private bundleList: CampaignBundle[] = [];
  private counter = 0;

  constructor(private readonly database: Database) {}

  get version(): number {
    return this.counter;
  }

  /** Reload everything (start-up and after any master-data edit). */
  async reload(): Promise<void> {
    const { db } = this.database;
    const [campaigns, advertisers, creatives, screens, outlets, settingsRows, terminals, zones, gates] =
      await Promise.all([
        db.select().from(t.campaigns),
        db.select().from(t.advertisers),
        db.select().from(t.creatives),
        db.select().from(t.screens),
        db.select().from(t.outlets),
        db.select().from(t.settings),
        db.select().from(t.terminals),
        db.select().from(t.zones),
        db.select().from(t.gates),
      ]);
    this.layoutInUse = new Layout(
      terminals.map((r) => ({
        ...r,
        mainMarket: r.mainMarket as Terminal['mainMarket'],
        outline: r.outline as Terminal['outline'],
      })),
      zones.map((r) => ({
        ...r,
        kind: r.kind as Zone['kind'],
        side: r.side as Zone['side'],
        area: r.area as Zone['area'],
      })),
      gates.map((r): LayoutGate => ({ ...r, position: r.position as LayoutGate['position'] })),
    );
    this.campaignsById = new Map(campaigns.map((r) => [r.id, rowToCampaign(r)]));
    this.advertisersById = new Map(advertisers.map((r) => [r.id, rowToAdvertiser(r)]));
    this.creativesById = new Map(creatives.map((r) => [r.id, rowToCreative(r)]));
    this.screensById = new Map(screens.map((r) => [r.id, rowToScreen(r)]));
    this.outletsById = new Map(outlets.filter((o) => o.active).map((r) => [r.id, rowToOutlet(r)]));
    this.screensPerZone = new Map();
    for (const s of this.screensById.values())
      this.screensPerZone.set(s.zoneId, (this.screensPerZone.get(s.zoneId) ?? 0) + 1);
    const rules = settingsRows.find((s) => s.key === 'rule_engine')?.value;
    this.ruleSettings = {
      ...DEFAULT_RULE_ENGINE,
      ...(typeof rules === 'object' && rules !== null ? (rules as Partial<RuleEngineSettings>) : {}),
    };
    this.bundleList = [...this.campaignsById.values()].map((campaign) => ({
      campaign,
      advertiser: this.advertisersById.get(campaign.advertiserId),
      creatives: campaign.creativeIds
        .map((id) => this.creativesById.get(id))
        .filter((c): c is Creative => c !== undefined),
    }));
    this.counter += 1;
  }

  /** Reload pins active around `at` (pins are small; refreshed on change and on jumps). */
  async reloadPins(at: Date): Promise<void> {
    const rows = await this.database.db
      .select()
      .from(t.manualPins)
      .where(
        and(
          lte(t.manualPins.startsAt, new Date(at.getTime() + 24 * 3600_000)),
          gte(t.manualPins.endsAt, new Date(at.getTime() - 24 * 3600_000)),
        ),
      );
    this.pinsByScreen = new Map();
    for (const r of rows) {
      const list = this.pinsByScreen.get(r.screenId) ?? [];
      list.push({
        id: r.id,
        screenId: r.screenId,
        campaignId: r.campaignId,
        reason: r.reason,
        createdBy: r.createdBy,
        startsAt: iso(r.startsAt),
        endsAt: iso(r.endsAt),
        createdAt: iso(r.createdAt),
      });
      this.pinsByScreen.set(r.screenId, list);
    }
    this.counter += 1;
  }

  pinAt(screenId: string, at: Date): PinRecord | null {
    const t0 = at.getTime();
    const active = (this.pinsByScreen.get(screenId) ?? []).filter(
      (p) => Date.parse(p.startsAt) <= t0 && t0 < Date.parse(p.endsAt),
    );
    return active.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0) ?? null;
  }

  layout(): Layout {
    return this.layoutInUse;
  }

  bundles(): readonly CampaignBundle[] {
    return this.bundleList;
  }

  settings(): RuleEngineSettings {
    return this.ruleSettings;
  }

  campaign(id: string): Campaign | undefined {
    return this.campaignsById.get(id);
  }

  campaigns(): Campaign[] {
    return [...this.campaignsById.values()];
  }

  advertiser(id: string): Advertiser | undefined {
    return this.advertisersById.get(id);
  }

  creative(id: string): Creative | undefined {
    return this.creativesById.get(id);
  }

  screen(id: string): Screen | undefined {
    return this.screensById.get(id);
  }

  screens(): Screen[] {
    return [...this.screensById.values()];
  }

  outlet(id: string): Outlet | undefined {
    return this.outletsById.get(id);
  }

  outlets(): Outlet[] {
    return [...this.outletsById.values()];
  }

  advertisers(): Advertiser[] {
    return [...this.advertisersById.values()];
  }

  screensInZone(zoneId: string): number {
    return this.screensPerZone.get(zoneId) ?? 1;
  }

  /** Pin timestamps for the decision log. */
  static pinWindow(p: PinRecord): { startsAt: string; endsAt: string | null } {
    return { startsAt: p.startsAt, endsAt: isoOrNull(new Date(p.endsAt)) };
  }
}
