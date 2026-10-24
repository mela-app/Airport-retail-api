/**
 * Scan-to-claim promo codes.
 *
 * - A promo ad playing on a screen gets a claim link: an unguessable token, shown as a QR code next to the ad.
 *   The link expires when the crowd moves on: at the linked flight's gate close (the largest departing flight
 *   in front of the screen) or after the campaign's fixed validity.
 * - Opening the link on a phone shows the offer (and counts as a scan). Claiming issues a personal code and
 *   records the redemption, which reaches the retailer's dashboard immediately.
 * - "Share with family" turns a claimed code into a second link; claiming that one issues a second code.
 *
 * No personal data is involved: no name, contact or device identifier is asked for or stored. Requests are
 * rate-limited per client address.
 */
import { randomBytes, randomInt } from 'node:crypto';

import type { Campaign, Creative } from '@arm/domain';
import { eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import * as t from '../db/schema.js';
import type { DecisionContext, DecisionEngine, DecisionRun } from '../engine/decision-engine.js';
import type { EventBus } from '../sim/event-bus.js';
import type { SimClock } from '../sim/sim-clock.js';

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'expired' | 'conflict' | 'rate_limited' | 'unavailable',
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

/** Unambiguous characters for printed codes (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_VALIDITY_MIN = 60;

export interface ClaimLink {
  token: string;
  url: string;
  screenId: string;
  campaignId: string;
  flightId: string | null;
  expiresAt: string;
}

export interface ClaimOffer {
  token: string;
  status: 'open' | 'expired';
  expiresAt: string;
  secondsLeft: number;
  shared: boolean;
  campaign: { id: string; name: string; advertiser: string; offerText: string; shareable: boolean };
  creative: {
    id: string;
    content: Creative['content'];
    palette: Creative['palette'];
    artwork: string;
  } | null;
  outlet: { id: string; name: string; zoneId: string; zoneName: string | null; terminalId: string } | null;
  flight: { id: string; label: string; gate: string | null; gateCloseAt: string | null } | null;
  /** The screen whose QR code was scanned. */
  screen: { id: string; name: string } | null;
}

export interface ClaimedCode {
  code: string;
  expiresAt: string;
  offerText: string;
  outlet: ClaimOffer['outlet'];
  shareable: boolean;
  parentCode: string | null;
}

type LinkRow = typeof t.claimLinks.$inferSelect;

export class ClaimService {
  /** Claim link per decision run (a run is one campaign playing on one screen from one context). */
  private readonly linksByRun = new Map<string, ClaimLink>();

  constructor(
    private readonly database: Database,
    private readonly engine: DecisionEngine,
    private readonly bus: EventBus,
    private readonly clock: SimClock,
    private readonly publicBaseUrl: (requestOrigin?: string) => string,
  ) {}

  private url(token: string, requestOrigin?: string): string {
    return `${this.publicBaseUrl(requestOrigin).replace(/\/+$/, '')}/claim/${token}`;
  }

  /** The aggregate segment a claim is attributed to: the crowd's strongest segment for the campaign. */
  private segmentFor(campaign: Campaign, ctx: DecisionContext | null): string | null {
    if (!ctx) return null;
    const weights = new Map(Object.entries(campaign.segmentWeights));
    const options = [
      ...Object.entries(ctx.crowd.profile.segments.partyType).map(([k, v]) => [`partyType.${k}`, v] as const),
      ...Object.entries(ctx.crowd.profile.segments.tripPurpose).map(
        ([k, v]) => [`tripPurpose.${k}`, v] as const,
      ),
    ];
    let best: string | null = null;
    let bestScore = -1;
    for (const [key, share] of options) {
      const score = share * (0.3 + (weights.get(key) ?? 0));
      if (score > bestScore) {
        best = key;
        bestScore = score;
      }
    }
    return best;
  }

  /** The claim link for the ad currently playing on a screen (created on first display), or null. */
  async linkForRun(
    run: DecisionRun,
    ctx: DecisionContext | null,
    requestOrigin?: string,
  ): Promise<ClaimLink | null> {
    if (!run.campaignId) return null;
    const campaign = this.engine.catalog.campaign(run.campaignId);
    if (!campaign?.promo?.inStock) return null;
    const cached = this.linksByRun.get(run.id);
    if (cached) return { ...cached, url: this.url(cached.token, requestOrigin) };
    const now = this.clock.now();
    // The linked flight: the largest departing flight in front of the screen whose gate has not closed.
    const flight = ctx?.crowd.contributors
      .filter(
        (c) => c.direction === 'D' && c.gateCloseAt !== null && Date.parse(c.gateCloseAt) > now.getTime(),
      )
      .sort((a, b) => b.pax - a.pax)
      .at(0);
    const validity = campaign.promo.validity;
    const expiresAt =
      validity.mode === 'boarding_close' && flight?.gateCloseAt
        ? new Date(flight.gateCloseAt)
        : new Date(
            now.getTime() + (validity.mode === 'minutes' ? validity.minutes : DEFAULT_VALIDITY_MIN) * 60_000,
          );
    const token = randomBytes(12).toString('base64url');
    await this.database.db.insert(t.claimLinks).values({
      token,
      screenId: run.screenId,
      campaignId: campaign.id,
      creativeId: run.creativeId,
      decisionId: run.id,
      flightId: flight?.flightId ?? null,
      outletId: campaign.promo.outletId,
      segment: this.segmentFor(campaign, ctx),
      parentCode: null,
      createdAt: now,
      expiresAt,
    });
    const link: ClaimLink = {
      token,
      url: this.url(token, requestOrigin),
      screenId: run.screenId,
      campaignId: campaign.id,
      flightId: flight?.flightId ?? null,
      expiresAt: expiresAt.toISOString(),
    };
    this.linksByRun.set(run.id, link);
    if (this.linksByRun.size > 5000) this.linksByRun.delete(this.linksByRun.keys().next().value ?? '');
    return link;
  }

  private async link(token: string): Promise<LinkRow> {
    if (!/^[A-Za-z0-9_-]{16,24}$/.test(token)) throw new ClaimError('unknown claim link', 'not_found');
    const [row] = await this.database.db.select().from(t.claimLinks).where(eq(t.claimLinks.token, token));
    if (!row) throw new ClaimError('unknown claim link', 'not_found');
    return row;
  }

  private offerOf(row: LinkRow): ClaimOffer {
    const catalog = this.engine.catalog;
    const campaign = catalog.campaign(row.campaignId);
    if (!campaign?.promo) throw new ClaimError('this offer is no longer available', 'unavailable');
    const creative = row.creativeId ? catalog.creative(row.creativeId) : undefined;
    const outlet = row.outletId ? catalog.outlet(row.outletId) : undefined;
    const advertiser = catalog.advertiser(campaign.advertiserId);
    const screen = catalog.screen(row.screenId);
    const now = this.clock.now().getTime();
    const expires = row.expiresAt.getTime();
    return {
      token: row.token,
      status: expires > now && campaign.promo.inStock ? 'open' : 'expired',
      expiresAt: row.expiresAt.toISOString(),
      secondsLeft: Math.max(0, Math.round((expires - now) / 1000)),
      shared: row.parentCode !== null,
      campaign: {
        id: campaign.id,
        name: campaign.name,
        advertiser: advertiser?.name ?? campaign.advertiserId,
        offerText: campaign.promo.offerText,
        shareable: campaign.promo.shareable && row.parentCode === null,
      },
      creative: creative
        ? { id: creative.id, content: creative.content, palette: creative.palette, artwork: creative.artwork }
        : null,
      outlet: outlet
        ? {
            id: outlet.id,
            name: outlet.name,
            zoneId: outlet.zoneId,
            zoneName: catalog.layout().zone(outlet.zoneId)?.name ?? null,
            terminalId: outlet.terminalId,
          }
        : null,
      flight: this.flightOf(row.flightId),
      screen: screen ? { id: screen.id, name: screen.name } : null,
    };
  }

  private flightOf(flightId: string | null): ClaimOffer['flight'] {
    if (!flightId) return null;
    for (const ctx of this.engine.openRuns().map((r) => this.engine.now(r.screenId).context)) {
      const c = ctx?.crowd.contributors.find((x) => x.flightId === flightId);
      if (c)
        return {
          id: c.flightId,
          label: `${c.airlineIata}${c.flightNumber} → ${c.destination}`,
          gate: c.gateId,
          gateCloseAt: c.gateCloseAt,
        };
    }
    return { id: flightId, label: flightId.split('-').at(0) ?? flightId, gate: null, gateCloseAt: null };
  }

  /** Open a claim link (a QR scan). */
  async open(token: string): Promise<ClaimOffer> {
    const row = await this.link(token);
    const offer = this.offerOf(row);
    await this.database.db
      .update(t.claimLinks)
      .set({ opens: sql`${t.claimLinks.opens} + 1` })
      .where(eq(t.claimLinks.token, token));
    if (offer.status === 'open') {
      this.engine.recordExternalScan(row.campaignId, row.segment ?? 'partyType.solo');
      this.bus.publish('claims', {
        action: 'opened',
        campaignId: row.campaignId,
        screenId: row.screenId,
        outletId: row.outletId,
        code: null,
        revenue: 0,
        at: this.clock.now().toISOString(),
      });
    }
    return offer;
  }

  private newCode(prefix: string): string {
    let suffix = '';
    for (let i = 0; i < 5; i += 1) suffix += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
    return `${prefix}-${suffix}`;
  }

  /** Claim the offer: issue a personal code and record the redemption. */
  async claim(token: string): Promise<ClaimedCode> {
    const row = await this.link(token);
    const offer = this.offerOf(row);
    if (offer.status !== 'open') throw new ClaimError('this offer has expired', 'expired');
    const campaign = this.engine.catalog.campaign(row.campaignId);
    if (!campaign?.promo) throw new ClaimError('this offer is no longer available', 'unavailable');
    if (row.parentCode !== null && row.claims > 0)
      throw new ClaimError('this shared offer has already been claimed', 'conflict');
    const now = this.clock.now();
    const code = this.newCode(campaign.promo.codePrefix);
    const outlet = row.outletId ? this.engine.catalog.outlet(row.outletId) : undefined;
    const revenue = Math.round((outlet?.averageBasket ?? 20) * 100) / 100;
    const { db } = this.database;
    await db.insert(t.promoCodes).values({
      code,
      campaignId: campaign.id,
      screenId: row.screenId,
      flightId: row.flightId,
      parentCode: row.parentCode,
      issuedAt: now,
      expiresAt: row.expiresAt,
      status: 'redeemed',
      claimedAt: now,
    });
    await db.insert(t.redemptions).values({
      id: `red-claim-${code}`,
      code,
      campaignId: campaign.id,
      outletId: row.outletId,
      screenId: row.screenId,
      redeemedAt: now,
      revenue,
      segment: row.segment,
    });
    await db
      .update(t.claimLinks)
      .set({ claims: sql`${t.claimLinks.claims} + 1` })
      .where(eq(t.claimLinks.token, token));
    this.engine.recordExternalRedemption(campaign.id, row.segment ?? 'partyType.solo', revenue);
    this.bus.publish('claims', {
      action: 'claimed',
      campaignId: campaign.id,
      screenId: row.screenId,
      outletId: row.outletId,
      code,
      revenue,
      at: now.toISOString(),
    });
    return {
      code,
      expiresAt: row.expiresAt.toISOString(),
      offerText: campaign.promo.offerText,
      outlet: offer.outlet,
      shareable: offer.campaign.shareable,
      parentCode: row.parentCode,
    };
  }

  /** Share a claimed code with family: a second link, once per code. */
  async share(code: string, requestOrigin?: string): Promise<ClaimLink> {
    if (!isPromoCode(code)) throw new ClaimError('unknown code', 'not_found');
    const { db } = this.database;
    const [promo] = await db.select().from(t.promoCodes).where(eq(t.promoCodes.code, code));
    if (!promo) throw new ClaimError('unknown code', 'not_found');
    if (promo.parentCode !== null) throw new ClaimError('a shared code cannot be shared again', 'conflict');
    const campaign = this.engine.catalog.campaign(promo.campaignId);
    if (!campaign?.promo?.shareable) throw new ClaimError('this offer cannot be shared', 'conflict');
    const now = this.clock.now();
    if (promo.expiresAt.getTime() <= now.getTime()) throw new ClaimError('this offer has expired', 'expired');
    const [existing] = await db.select().from(t.claimLinks).where(eq(t.claimLinks.parentCode, code));
    if (existing) throw new ClaimError('this code has already been shared', 'conflict');
    const [origin] = await db.select().from(t.redemptions).where(eq(t.redemptions.code, code));
    const token = randomBytes(12).toString('base64url');
    await db.insert(t.claimLinks).values({
      token,
      screenId: promo.screenId,
      campaignId: promo.campaignId,
      creativeId: null,
      decisionId: null,
      flightId: promo.flightId,
      outletId: origin?.outletId ?? campaign.promo.outletId,
      segment: origin?.segment ?? null,
      parentCode: code,
      createdAt: now,
      expiresAt: promo.expiresAt,
    });
    this.bus.publish('claims', {
      action: 'shared',
      campaignId: promo.campaignId,
      screenId: promo.screenId,
      outletId: origin?.outletId ?? null,
      code,
      revenue: 0,
      at: now.toISOString(),
    });
    return {
      token,
      url: this.url(token, requestOrigin),
      screenId: promo.screenId,
      campaignId: promo.campaignId,
      flightId: promo.flightId,
      expiresAt: promo.expiresAt.toISOString(),
    };
  }

  /** Forget cached links (after a clock jump; links stay valid in the database). */
  reset(): void {
    this.linksByRun.clear();
  }
}

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `PREFIX-XXXXX`: a 2–8 character prefix and 5 characters, upper-case letters and digits only. */
export function isPromoCode(code: string): boolean {
  const [prefix, suffix, ...rest] = code.split('-');
  if (rest.length > 0 || prefix === undefined || suffix === undefined) return false;
  const ok = (s: string) => [...s].every((c) => CODE_CHARS.includes(c));
  return prefix.length >= 2 && prefix.length <= 8 && suffix.length === 5 && ok(prefix) && ok(suffix);
}
