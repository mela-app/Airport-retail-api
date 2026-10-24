/**
 * Runtime configuration from environment variables, validated at start-up. See `.env.example`.
 */
import { networkInterfaces } from 'node:os';

import { z } from 'zod';

const url = z.string().url();
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    DATABASE_URL: z.string().min(1).default('pglite:./.pglite/arm'),

    // simulation
    SIM_DATE: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .default('2026-10-16'),
    SIM_SEED: z.string().min(1).max(64).default('mqi'),
    SIM_PAIRS: z.coerce.number().int().min(10).max(2000).default(450),
    AIRPORT_UTC_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(240),
    HOME_AIRPORT: z.string().length(3).default('MQI'),
    CURRENCY: z.string().length(3).default('USD'),
    /** Local time the simulation starts at (and returns to on reset). 13:50 is 20 minutes before the worked example. */
    SIM_START_TIME: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('13:50'),
    /** Local time the simulation wraps to when the operating day ends, so a long-running playground keeps going. */
    SIM_LOOP_START_TIME: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('05:00'),
    SIM_SPEED: z.coerce.number().min(0.25).max(120).default(1),
    SIM_AUTOPLAY: bool.default(true),
    /** Root of generated mock data; one sub-directory per simulation date. */
    DATA_DIR: z.string().min(1).default('./data/generated'),

    // adapters (one value per source switches mock ↔ live)
    FLIGHT_SOURCE: z.enum(['mock-aidx', 'vendor-api']).default('mock-aidx'),
    SPACE_SOURCE: z.enum(['mock-acris', 'ngsi-ld']).default('mock-acris'),
    AUDIENCE_SOURCE: z.enum(['mock-rules', 'airline-api']).default('mock-rules'),
    VENDOR_API_URL: url.optional(),
    VENDOR_API_TOKEN: z.string().optional(),
    NGSI_LD_URL: url.optional(),
    NGSI_LD_TOKEN: z.string().optional(),
    AIRLINE_API_URL: url.optional(),
    AIRLINE_API_TOKEN: z.string().optional(),
    LIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
    LIVE_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

    // decision engine
    /** Length of one ad slot in simulation seconds. */
    SLOT_SECONDS: z.coerce.number().int().min(5).max(60).default(15),
    /**
     * AI ranking agent: `mock` (offline, default), `openai-compatible` (any OpenAI-compatible chat-completions
     * API), or `off` (rule-based decisions only).
     */
    AI_PROVIDER: z.enum(['mock', 'openai-compatible', 'off']).default('mock'),
    /** Share of mock-agent answers with a deliberate error, so the verifier can be seen working. */
    AI_MOCK_FAULT_RATE: z.coerce.number().min(0).max(1).default(0.03),
    AI_API_URL: url.optional(),
    AI_API_KEY: z.string().min(1).optional(),
    AI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8000),

    /** Port of the web app (used to build the LAN address in QR codes when PUBLIC_BASE_URL is not set). */
    WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
    /**
     * Express "trust proxy" setting, so rate limits see the client address behind a reverse proxy (e.g.
     * `loopback` when Caddy runs on the same host). Empty: trust no proxy.
     */
    TRUST_PROXY: z.string().max(100).default(''),
    /** Base URL encoded in promo QR codes (the LAN address locally, the public URL on the playground). */
    PUBLIC_BASE_URL: url.optional(),
    LOG_REQUESTS: bool.default(false),
  })
  .superRefine((c, ctx) => {
    const need = (when: boolean, key: string, value: string | undefined) => {
      if (when && !value)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required for the selected live adapter`,
        });
    };
    need(c.FLIGHT_SOURCE === 'vendor-api', 'VENDOR_API_URL', c.VENDOR_API_URL);
    need(c.SPACE_SOURCE === 'ngsi-ld', 'NGSI_LD_URL', c.NGSI_LD_URL);
    need(c.AUDIENCE_SOURCE === 'airline-api', 'AIRLINE_API_URL', c.AIRLINE_API_URL);
    need(c.AI_PROVIDER === 'openai-compatible', 'AI_API_URL', c.AI_API_URL);
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty variable means "not set" (Docker Compose and hosting dashboards pass unset values as "").
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = ConfigSchema.safeParse(set);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

/**
 * Base URL for claim links: PUBLIC_BASE_URL when set (the playground); otherwise the address the page was
 * opened on (so a phone on the same network can follow the QR code); otherwise the first LAN address.
 */
export function publicBaseUrl(
  config: Pick<AppConfig, 'PUBLIC_BASE_URL' | 'WEB_PORT'>,
  requestOrigin?: string,
): string {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const origin = safeOrigin(requestOrigin);
  if (origin) return origin;
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
  return `http://${lan?.address ?? 'localhost'}:${config.WEB_PORT}`;
}

/** `http(s)://host[:port]` of a request, canonicalised by the URL parser; anything else is ignored. */
export function safeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}
