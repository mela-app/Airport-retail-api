/**
 * `AI_PROVIDER=openai-compatible`: an LLM ranking agent behind any OpenAI-compatible chat-completions API
 * (OpenAI, Google's OpenAI-compatible Gemini endpoint, Azure-style gateways, local Ollama, …).
 *
 *   POST {AI_API_URL}/chat/completions   (JSON mode, temperature 0)
 *
 * The model gets the crowd, the eligible candidates with their scoring inputs, and the evidence ids. It must
 * answer with JSON in the AiRanking shape. The answer is untrusted: the verifier checks every citation,
 * claim and score before anything plays, and the platform falls back to the rule-based choice otherwise.
 */
import { type HttpEndpoint, httpPostJson } from '../../adapters/live/http.js';
import type { AiRankRequest, AiRankResult, AiRanker } from './types.js';

const SYSTEM_PROMPT = [
  'You rank advertising campaigns for one airport screen for the next few minutes.',
  'Use ONLY the data in the request. Never invent flights, delays, shares or numbers.',
  'For each candidate return: campaignId, score, inputs {match, boost, performance} (copy them from the',
  'candidate), a one-sentence rationale, citations (evidence ids from the request that support the rationale)',
  'and claims (evidenceId + the exact value from the request for each fact you state).',
  'score = audienceWeight * min(1, match * boost) + performanceWeight * performance, rounded to 4 decimals.',
  'Rank by score, highest first. Answer with JSON only: {"ranking": [...]}.',
].join(' ');

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string } }[];
}

export interface OpenAiCompatibleOptions {
  endpoint: HttpEndpoint;
  model: string;
}

export class OpenAiCompatibleRanker implements AiRanker {
  readonly provider = 'openai-compatible';

  constructor(private readonly opts: OpenAiCompatibleOptions) {}

  get model(): string {
    return this.opts.model;
  }

  async rank(request: AiRankRequest): Promise<AiRankResult> {
    const started = Date.now();
    try {
      const body = await httpPostJson(this.opts.endpoint, ['chat', 'completions'], {
        model: this.opts.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(request) },
        ],
      });
      const parsed = JSON.parse(body) as ChatResponse;
      const content = parsed.choices?.at(0)?.message?.content;
      if (typeof content !== 'string') throw new Error('response has no message content');
      return {
        provider: this.provider,
        model: parsed.model ?? this.opts.model,
        latencyMs: Date.now() - started,
        answer: JSON.parse(content) as unknown,
        error: null,
      };
    } catch (err) {
      return {
        provider: this.provider,
        model: this.opts.model,
        latencyMs: Date.now() - started,
        answer: null,
        error: (err as Error).message,
      };
    }
  }
}
