/** The GenAI creative assistant: a brief in, three bilingual creative variants with brand-safety checks out. */
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { ClaimError } from '../claims/claim.service.js';
import { RateLimiter } from '../claims/rate-limit.js';
import type { AppConfig } from '../config.js';
import { parseInput } from '../core/http.js';
import { ZodBody } from '../core/openapi.js';
import { CONFIG, SIMULATION } from '../core/tokens.js';
import { AssistRequest, CreativeAssistant } from '../creative-assist/assistant.js';
import { MasterDataError } from '../master/master-data.service.js';
import type { Simulation } from '../sim/simulation.js';

const TEN_MINUTES = 10 * 60_000;

@ApiTags('Creative assistant')
@Controller('api')
export class AssistantController {
  private readonly assistant: CreativeAssistant;
  private readonly limiter = new RateLimiter(30, TEN_MINUTES);

  constructor(
    @Inject(SIMULATION) private readonly sim: Simulation,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.assistant = new CreativeAssistant(config);
  }

  @ApiOperation({
    summary:
      'GenAI creative assistant: three creative variants (English and Arabic) from a brief, with brand-safety checks',
  })
  @ZodBody(AssistRequest)
  @Post('creatives/assist')
  @HttpCode(200)
  async assist(@Body() body: unknown, @Req() req: Request) {
    if (!this.limiter.allow(req.ip ?? 'unknown'))
      throw new ClaimError('too many requests; please try again in a few minutes', 'rate_limited');
    const input = parseInput(AssistRequest, body);
    const advertiser = this.sim.engine.catalog.advertiser(input.advertiserId);
    if (!advertiser) throw new MasterDataError(`unknown advertiser ${input.advertiserId}`, 'not_found');
    return this.assistant.assist(input, {
      name: advertiser.name,
      category: advertiser.category,
      brandColor: advertiser.brandColor,
    });
  }
}
