/**
 * Public, passenger-facing endpoints behind the QR codes: open an offer, claim a code, share it with family.
 * They are rate-limited per client address and take no personal data.
 */
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { ClaimError } from '../claims/claim.service.js';
import { RateLimiter } from '../claims/rate-limit.js';
import { type AppConfig, publicBaseUrl } from '../config.js';
import { requestOrigin } from '../core/http.js';
import { CONFIG, SIMULATION } from '../core/tokens.js';
import type { Simulation } from '../sim/simulation.js';

const TEN_MINUTES = 10 * 60_000;

@ApiTags('Passenger claims')
@Controller('api')
export class ClaimsController {
  private readonly opens = new RateLimiter(120, TEN_MINUTES);
  private readonly claims = new RateLimiter(30, TEN_MINUTES);

  constructor(
    @Inject(SIMULATION) private readonly sim: Simulation,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private limit(limiter: RateLimiter, req: Request): void {
    if (!limiter.allow(req.ip ?? 'unknown'))
      throw new ClaimError('too many requests; please try again in a few minutes', 'rate_limited');
  }

  @ApiOperation({ summary: "Open a claim link from a screen's QR code (counts as a scan)" })
  @Get('claims/:token')
  open(@Param('token') token: string, @Req() req: Request) {
    this.limit(this.opens, req);
    return this.sim.claims.open(token);
  }

  @ApiOperation({ summary: 'Claim the offer: issues a personal code and records the redemption' })
  @Post('claims/:token')
  @HttpCode(201)
  claim(@Param('token') token: string, @Req() req: Request) {
    this.limit(this.claims, req);
    return this.sim.claims.claim(token);
  }

  @ApiOperation({ summary: 'Share a claimed code with family (once): returns a second claim link' })
  @Post('promo-codes/:code/share')
  @HttpCode(201)
  share(@Param('code') code: string, @Req() req: Request) {
    this.limit(this.claims, req);
    return this.sim.claims.share(code, requestOrigin(req));
  }

  /** Settings the web app needs before it can render (white-label theme comes from the web config). */
  @ApiOperation({ summary: 'Public settings for the web app' })
  @Get('config/public')
  publicConfig(@Req() req: Request) {
    return {
      publicBaseUrl: publicBaseUrl(this.config, requestOrigin(req)),
      airport: { code: this.config.HOME_AIRPORT, utcOffsetMinutes: this.config.AIRPORT_UTC_OFFSET_MINUTES },
      currency: this.config.CURRENCY,
      simDate: this.config.SIM_DATE,
      slotSeconds: this.config.SLOT_SECONDS,
      aiProvider: this.config.AI_PROVIDER,
    };
  }
}
