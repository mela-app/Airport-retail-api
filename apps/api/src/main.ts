import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Logger } from '@nestjs/common';

import { createApp } from './app.js';
import { loadConfig } from './config.js';

// Local runs read backend/.env (copied from .env.example) when it exists; Docker and CI set real environment
// variables instead. A variable already set in the environment wins over the file.
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const logger = new Logger('Bootstrap');
const config = loadConfig();
const app = await createApp(config);
await app.listen(config.PORT, config.HOST);
logger.log(`API listening on http://${config.HOST}:${config.PORT}`);
logger.log(
  config.AI_PROVIDER === 'openai-compatible' && config.AI_API_URL
    ? `AI: ${config.AI_MODEL} at ${new URL(config.AI_API_URL).origin}`
    : `AI: ${config.AI_PROVIDER}`,
);
