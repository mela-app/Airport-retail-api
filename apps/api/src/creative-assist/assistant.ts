/**
 * GenAI creative assistant: turns a short brief into three ready-to-edit creative variants (template,
 * artwork, colours, copy in English and Arabic).
 *
 * - `mock` (default, offline): a deterministic copywriter built from a bilingual phrasebook.
 * - `openai-compatible`: any chat-completions API (AI_PROVIDER / AI_API_URL / AI_MODEL, as for ranking).
 *
 * Whatever the provider, the answer is untrusted: it is validated against the creative schema and every
 * variant goes through brand-safety checks (no real brand names, no unverifiable claims, copy length,
 * Arabic present). A provider failure falls back to the offline copywriter, and says so.
 */
import { z } from 'zod';

import { type HttpEndpoint, createEndpoint, httpPostJson } from '../adapters/live/http.js';
import type { AppConfig } from '../config.js';
import { CATEGORY_COPY, type CategoryCopy, capitalise, categoryFor, fill, findOffer } from './phrasebook.js';

export const TEMPLATES = ['offer_split', 'hero_full', 'gate_message', 'voucher', 'destination'] as const;
export const ARTWORKS = [
  'perfume',
  'oud',
  'coffee',
  'toys',
  'sweets',
  'headphones',
  'books',
  'fashion',
  'grill',
  'burger',
  'pharmacy',
  'lounge',
  'currency',
  'car',
  'card',
  'esim',
  'seat',
  'flatbed',
  'city',
  'voucher',
] as const;

export const AssistRequest = z.object({
  advertiserId: z.string().min(1).max(40),
  brief: z.string().trim().min(3).max(400),
  tone: z.enum(['warm', 'premium', 'playful', 'urgent']).default('warm'),
});
export type AssistRequest = z.infer<typeof AssistRequest>;

const Copy = z.object({
  headline: z.string().min(1).max(80),
  body: z.string().min(1).max(240),
  cta: z.string().min(1).max(40),
  badge: z.string().max(24).nullable(),
});

const Hex = z
  .string()
  .refine(
    (v) =>
      v.length === 7 &&
      v.startsWith('#') &&
      [...v.slice(1).toLowerCase()].every((c) => '0123456789abcdef'.includes(c)),
    'colour must be #rrggbb',
  );

export const Variant = z.object({
  name: z.string().min(1).max(80),
  template: z.enum(TEMPLATES),
  artwork: z.enum(ARTWORKS),
  palette: z.object({ background: Hex, foreground: Hex, accent: Hex }),
  content: z.object({ en: Copy, ar: Copy }),
  rationale: z.string().max(300),
});
export type Variant = z.infer<typeof Variant>;

export interface SafetyCheck {
  name:
    'no_real_brand_marks' | 'claims_verifiable' | 'copy_length' | 'arabic_present' | 'legible_at_distance';
  passed: boolean;
  detail: string;
}

export interface AssistResult {
  provider: string;
  model: string;
  latencyMs: number;
  fallback: string | null;
  variants: (Variant & { checks: SafetyCheck[] })[];
}

export interface BrandContext {
  name: string;
  category: string;
  brandColor: string;
}

interface Copywriter {
  readonly provider: string;
  readonly model: string;
  write(req: AssistRequest, brand: BrandContext): Promise<unknown>;
}

// ---- brand safety -----------------------------------------------------------------------------------------

/** Real brand names that must never appear on a fictional airport's screens (a short, illustrative list). */
const REAL_BRANDS = [
  'chanel',
  'dior',
  'gucci',
  'hermès',
  'hermes',
  'rolex',
  'starbucks',
  'costa',
  'mcdonald',
  'burger king',
  'kfc',
  'apple',
  'samsung',
  'sony',
  'bose',
  'nike',
  'adidas',
  'zara',
  'lego',
  'mattel',
  'visa',
  'mastercard',
  'amex',
  'emirates',
  'qatar airways',
  'etihad',
  'lufthansa',
  'ryanair',
  'easyjet',
  'hertz',
  'avis',
  'coca-cola',
  'pepsi',
];
const UNVERIFIABLE = [
  'best',
  'no.1',
  'number one',
  'guaranteed',
  'cheapest',
  'lowest price',
  'world-class',
  'unbeatable',
];

export function safetyChecks(v: Variant): SafetyCheck[] {
  const en =
    `${v.content.en.headline} ${v.content.en.body} ${v.content.en.cta} ${v.content.en.badge ?? ''}`.toLowerCase();
  const ar = `${v.content.ar.headline} ${v.content.ar.body}`;
  const brands = REAL_BRANDS.filter((b) => en.includes(b) || ar.toLowerCase().includes(b));
  const claims = UNVERIFIABLE.filter((w) => en.includes(w));
  return [
    {
      name: 'no_real_brand_marks',
      passed: brands.length === 0,
      detail: brands.length === 0 ? 'no real brand names' : `mentions real brands: ${brands.join(', ')}`,
    },
    {
      name: 'claims_verifiable',
      passed: claims.length === 0,
      detail:
        claims.length === 0 ? 'no superlative or guaranteed claims' : `needs proof: ${claims.join(', ')}`,
    },
    {
      name: 'copy_length',
      passed: v.content.en.headline.length <= 48 && v.content.en.body.length <= 140,
      detail: `headline ${v.content.en.headline.length}/48, body ${v.content.en.body.length}/140 characters`,
    },
    {
      name: 'arabic_present',
      passed: v.content.ar.headline.trim().length > 0 && v.content.ar.body.trim().length > 0,
      detail: 'Arabic copy provided',
    },
    {
      name: 'legible_at_distance',
      passed: contrast(v.palette.background, v.palette.foreground) >= 4.5,
      detail: `text contrast ${contrast(v.palette.background, v.palette.foreground).toFixed(1)}:1 (needs 4.5:1)`,
    },
  ];
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Mix two #rrggbb colours (t = share of `b`). */
function mix(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) * (1 - t) + ch(b, i) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

// ---- offline copywriter -----------------------------------------------------------------------------------

const ACCENTS = ['#F2B134', '#E8C468', '#7FD1AE', '#FF9E6D'];

export class MockCopywriter implements Copywriter {
  readonly provider = 'mock';
  readonly model = 'mock-copywriter-v1';

  write(req: AssistRequest, brand: BrandContext): Promise<unknown> {
    const category = categoryFor(req.brief, brand.category);
    const copy = CATEGORY_COPY.get(category) ?? (CATEGORY_COPY.get('duty_free') as CategoryCopy);
    const offer = findOffer(req.brief);
    const seed = [...req.brief].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 9973, 7);
    const base = brand.brandColor.length === 7 ? brand.brandColor : '#1B2A4A';
    const templates: readonly (typeof TEMPLATES)[number][] =
      category === 'airline'
        ? ['gate_message', 'destination', 'hero_full']
        : offer
          ? ['offer_split', 'voucher', 'hero_full']
          : ['offer_split', 'hero_full', 'destination'];
    const variants = templates.map((template, i) => {
      const headline = copy.headlines.at((seed + i) % copy.headlines.length) ?? copy.headlines.at(0);
      // The third variant describes the place and leaves the offer to its badge.
      const body = offer && i < 2 ? copy.bodyOffer : copy.body;
      const offerEn = offer ? capitalise(offer.en) : '';
      const background = i === 1 ? mix(base, '#000000', 0.35) : mix(base, '#000000', 0.6);
      const accent = ACCENTS.at((seed + i) % ACCENTS.length) ?? '#F2B134';
      const urgent = req.tone === 'urgent';
      return {
        name: `${brand.name} – ${headline?.en ?? 'Offer'}`.slice(0, 80),
        template,
        artwork: copy.artworks.at(i % copy.artworks.length) ?? 'voucher',
        palette: { background, foreground: '#FFFFFF', accent },
        content: {
          en: {
            headline: urgent ? `${headline?.en ?? ''} – today only` : (headline?.en ?? ''),
            body: fill(body.en, brand.name, offerEn),
            cta: copy.cta.en,
            badge: offer ? offer.badgeEn : req.tone === 'premium' ? 'EXCLUSIVE' : null,
          },
          ar: {
            headline: urgent ? `${headline?.ar ?? ''} – اليوم فقط` : (headline?.ar ?? ''),
            body: fill(body.ar, brand.name, offer?.ar ?? ''),
            cta: copy.cta.ar,
            badge: offer ? offer.badgeAr : req.tone === 'premium' ? 'حصري' : null,
          },
        },
        rationale: [
          `Category "${category}" from the ${offer ? 'brief and offer' : 'brief'}`,
          `${template.replace(/_/g, ' ')} layout`,
          `colours derived from the brand colour ${base}`,
        ].join('; '),
      };
    });
    return Promise.resolve({ variants });
  }
}

// ---- any OpenAI-compatible API ----------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You write short advertising creatives for screens in a fictional airport (Meridian International, MQI).',
  'Never use real brand names, celebrities, real airlines or real airports. Do not claim "best", "No.1" or',
  'guarantees. English headline at most 48 characters, body at most 140. Provide natural Arabic copy as well.',
  `template is one of ${TEMPLATES.join(', ')}; artwork is one of ${ARTWORKS.join(', ')}; colours are #RRGGBB with`,
  'white or near-white text on a dark background. Answer with JSON only:',
  '{"variants":[{"name","template","artwork","palette":{"background","foreground","accent"},',
  '"content":{"en":{"headline","body","cta","badge"},"ar":{"headline","body","cta","badge"}},"rationale"}]}',
  'with exactly three variants.',
].join(' ');

export class OpenAiCompatibleCopywriter implements Copywriter {
  readonly provider = 'openai-compatible';

  constructor(
    private readonly endpoint: HttpEndpoint,
    readonly model: string,
  ) {}

  async write(req: AssistRequest, brand: BrandContext): Promise<unknown> {
    const body = await httpPostJson(this.endpoint, ['chat', 'completions'], {
      model: this.model,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            advertiser: brand.name,
            category: brand.category,
            brandColor: brand.brandColor,
            tone: req.tone,
            brief: req.brief,
          }),
        },
      ],
    });
    const content = (JSON.parse(body) as { choices?: { message?: { content?: string } }[] }).choices?.at(0)
      ?.message?.content;
    if (typeof content !== 'string') throw new Error('response has no message content');
    return JSON.parse(content) as unknown;
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;

export class CreativeAssistant {
  private readonly offline = new MockCopywriter();
  private readonly primary: Copywriter;

  constructor(
    config: Pick<AppConfig, 'AI_PROVIDER' | 'AI_API_URL' | 'AI_API_KEY' | 'AI_MODEL' | 'AI_TIMEOUT_MS'>,
  ) {
    this.primary =
      config.AI_PROVIDER === 'openai-compatible' && config.AI_API_URL
        ? new OpenAiCompatibleCopywriter(
            createEndpoint({
              baseUrl: config.AI_API_URL,
              token: config.AI_API_KEY,
              timeoutMs: Math.max(config.AI_TIMEOUT_MS, 15_000),
              maxBytes: MAX_RESPONSE_BYTES,
            }),
            config.AI_MODEL,
          )
        : this.offline;
  }

  async assist(req: AssistRequest, brand: BrandContext): Promise<AssistResult> {
    const started = Date.now();
    let writer = this.primary;
    let fallback: string | null = null;
    let variants: Variant[];
    try {
      variants = parseVariants(await writer.write(req, brand));
    } catch (err) {
      if (writer === this.offline) throw err;
      fallback = `${writer.provider} failed (${(err as Error).message}); used the offline copywriter`;
      writer = this.offline;
      variants = parseVariants(await writer.write(req, brand));
    }
    return {
      provider: writer.provider,
      model: writer.model,
      latencyMs: Date.now() - started,
      fallback,
      variants: variants.map((v) => ({ ...v, checks: safetyChecks(v) })),
    };
  }
}

function parseVariants(answer: unknown): Variant[] {
  const parsed = z.object({ variants: z.array(Variant).min(1).max(5) }).safeParse(answer);
  if (!parsed.success)
    throw new Error(`answer does not match the creative schema: ${parsed.error.issues.at(0)?.message ?? ''}`);
  return parsed.data.variants;
}
