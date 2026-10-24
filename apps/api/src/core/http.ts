/**
 * HTTP helpers: zod validation of request input, and one exception filter that turns errors into consistent
 * JSON responses without leaking internals.
 */
import {
  type ArgumentsHost,
  BadRequestException,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, type ZodType } from 'zod';

import { AnalyticsError } from '../analytics/analytics.service.js';
import { ClaimError } from '../claims/claim.service.js';
import { MasterDataError } from '../master/master-data.service.js';
import { InjectionError } from '../sim/injectors.js';

/** Validate request input against a zod schema; invalid input becomes a 400 with the problems listed. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({
      error: 'invalid_request',
      message: 'The request is not valid.',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const INJECTION_STATUS: ReadonlyMap<InjectionError['code'], number> = new Map([
  ['not_found', HttpStatus.NOT_FOUND],
  ['invalid', HttpStatus.BAD_REQUEST],
  ['unsupported', HttpStatus.CONFLICT],
]);

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();
      res.status(status).json(typeof body === 'string' ? { error: 'error', message: body } : body);
      return;
    }
    if (exception instanceof InjectionError) {
      res
        .status(INJECTION_STATUS.get(exception.code) ?? 400)
        .json({ error: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof ClaimError) {
      const status = new Map([
        ['not_found', 404],
        ['expired', 410],
        ['unavailable', 410],
        ['conflict', 409],
        ['rate_limited', 429],
      ]).get(exception.code);
      res.status(status ?? 400).json({ error: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof AnalyticsError) {
      res
        .status(exception.code === 'not_found' ? 404 : 400)
        .json({ error: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof MasterDataError) {
      const status = exception.code === 'not_found' ? 404 : exception.code === 'conflict' ? 409 : 400;
      res.status(status).json({ error: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof RangeError || exception instanceof ZodError) {
      res.status(400).json({ error: 'invalid_request', message: exception.message });
      return;
    }
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    res
      .status(500)
      .json({ error: 'internal_error', message: 'Something went wrong. The error has been logged.' });
  }
}

/** The origin a request was made to (`https://host:port`), honouring the trust-proxy setting. */
export function requestOrigin(req: {
  protocol: string;
  get(name: string): string | undefined;
}): string | undefined {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : undefined;
}
