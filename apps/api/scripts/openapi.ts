/**
 * Write the OpenAPI document to `docs/openapi.json` (the running API also serves it at `/api/openapi.json`
 * and Swagger UI at `/api/docs`). A test fails when the committed file is out of date.
 *
 *   pnpm --filter @arm/api openapi
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildOpenApi } from '../src/core/openapi.js';

export const OPENAPI_FILE = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'pglite:memory',
  DATA_DIR: mkdtempSync(join(tmpdir(), 'arm-openapi-')),
  SIM_AUTOPLAY: 'false',
});
const app = await createApp(config, false);
await app.init();
writeFileSync(OPENAPI_FILE, `${JSON.stringify(buildOpenApi(app), null, 2)}\n`);
await app.close();
console.log(`wrote ${OPENAPI_FILE}`);
