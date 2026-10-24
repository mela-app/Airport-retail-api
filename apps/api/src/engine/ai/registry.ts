/** Chooses the AI ranker from configuration (AI_PROVIDER). */
import { createEndpoint } from '../../adapters/live/http.js';
import type { AppConfig } from '../../config.js';
import { MockAiRanker } from './mock-agent.js';
import { OpenAiCompatibleRanker } from './openai-compatible.js';
import type { AiRanker } from './types.js';

const MAX_AI_RESPONSE_BYTES = 512 * 1024;

export function createRanker(config: AppConfig): AiRanker | null {
  switch (config.AI_PROVIDER) {
    case 'off':
      return null;
    case 'openai-compatible':
      return new OpenAiCompatibleRanker({
        endpoint: createEndpoint({
          baseUrl: config.AI_API_URL ?? '',
          token: config.AI_API_KEY,
          timeoutMs: config.AI_TIMEOUT_MS,
          maxBytes: MAX_AI_RESPONSE_BYTES,
        }),
        model: config.AI_MODEL,
      });
    default:
      return new MockAiRanker({ faultRate: config.AI_MOCK_FAULT_RATE });
  }
}
