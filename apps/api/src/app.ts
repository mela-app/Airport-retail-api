/**
 * Builds the Nest application (used by `main.ts` and by the end-to-end tests).
 */
import 'reflect-metadata';

import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { ApiExceptionFilter } from './core/http.js';
import { serveOpenApi } from './core/openapi.js';

/** Conservative headers for a JSON + SSE API. */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export async function createApp(
  config: AppConfig,
  logger: false | Logger = new Logger('App'),
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), {
    logger: logger === false ? false : ['log', 'warn', 'error'],
    // No CORS: the frontend reaches the API on its own origin (its Vite dev proxy, or the Caddy server in its
    // image forwarding /api), so browsers never need cross-origin access.
    cors: false,
  });
  if (config.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', config.TRUST_PROXY);
  app.use(securityHeaders);
  app.useGlobalFilters(new ApiExceptionFilter());
  serveOpenApi(app);
  app.enableShutdownHooks();
  return app;
}
