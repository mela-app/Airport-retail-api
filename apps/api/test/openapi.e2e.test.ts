import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildOpenApi } from '../src/core/openapi.js';

const COMMITTED = new URL('../../../docs/openapi.json', import.meta.url);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

let app: INestApplication;

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'pglite:memory',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-openapi-test-')),
    SIM_AUTOPLAY: 'false',
  });
  app = await createApp(config, false);
  await app.init();
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('OpenAPI', () => {
  it('documents every route with a summary', () => {
    const doc = buildOpenApi(app);
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      METHODS.flatMap((m) => {
        const op = new Map(Object.entries(item)).get(m) as { summary?: string } | undefined;
        return op ? [{ route: `${m.toUpperCase()} ${path}`, summary: op.summary }] : [];
      }),
    );
    expect(operations.length).toBeGreaterThan(70);
    expect(operations.filter((o) => !o.summary).map((o) => o.route)).toEqual([]);
  });

  it('describes request bodies from the zod schemas', () => {
    const doc = buildOpenApi(app);
    const post = doc.paths['/api/sim/inject/delay']?.post;
    const body = post?.requestBody as
      { content: Record<string, { schema: { properties?: object } }> } | undefined;
    expect(Object.keys(body?.content['application/json']?.schema.properties ?? {})).toContain('minutes');
  });

  it('matches the committed docs/openapi.json (run `pnpm --filter @arm/api openapi`)', () => {
    const committed = JSON.parse(readFileSync(COMMITTED, 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(buildOpenApi(app)))).toEqual(committed);
  });

  it('serves Swagger UI and the JSON document', async () => {
    await request(app.getHttpServer()).get('/api/docs/').expect(200);
    const res = await request(app.getHttpServer()).get('/api/openapi.json').expect(200);
    expect(res.body.info.title).toBe('Airport Retail Media Platform API');
  });
});
