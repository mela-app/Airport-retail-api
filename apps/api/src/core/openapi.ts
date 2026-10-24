/**
 * OpenAPI from the same zod schemas the controllers validate with, so the specification cannot drift from the
 * validation. Controllers use `@ZodBody(schema)` / `@ZodQuery(schema)` next to `@ApiOperation`.
 *
 * Served at `/api/docs` (Swagger UI) and `/api/openapi.json`; `pnpm --filter @arm/api openapi` writes
 * `docs/openapi.json`.
 */
import { type INestApplication, applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { type ZodObject, type ZodType, z } from 'zod';

type JsonSchema = Record<string, unknown>;

/** JSON Schema of a zod schema's accepted input, tidied for OpenAPI 3.1. */
export function jsonSchema(schema: ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return tidy(raw) as JsonSchema;
}

/** Drop `$schema` and the very long date-time regexes (the `format` says the same). */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (node === null || typeof node !== 'object') return node;
  const entries = Object.entries(node as JsonSchema).filter(
    ([k]) => k !== '$schema' && !(k === 'pattern' && (node as JsonSchema).format === 'date-time'),
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, tidy(v)]));
}

export const ZodBody = (schema: ZodType, description?: string) =>
  ApiBody({ schema: jsonSchema(schema) as never, ...(description ? { description } : {}) });

export function ZodQuery(schema: ZodObject) {
  return applyDecorators(
    ...Object.entries(schema.shape).map(([name, field]) =>
      ApiQuery({
        name,
        required: !(field as ZodType).safeParse(undefined).success,
        schema: jsonSchema(field as ZodType) as never,
      }),
    ),
  );
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Airport Retail Media Platform API')
    .setDescription(
      [
        'REST API of the airport retail media platform: simulation control, live operations, the ad decision engine',
        '(with its evidence trail), master data, and the passenger claim flow. Live updates are streamed as Server-Sent',
        'Events from `GET /api/stream?topics=…` (topics: clock, flight, flights_reloaded, queue, screen, incident, feeds,',
        'sim, decisions, delivery, presence, model, catalog, claims).',
      ].join(' '),
    )
    .setVersion('1.0.0')
    .setOpenAPIVersion('3.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  for (const [path, item] of Object.entries(document.paths)) addPathParameters(path, item);
  return document;
}

type Operation = { parameters?: Array<{ in?: string; name?: string }> };

/**
 * Declare every `{param}` of a path as a required string path parameter. Nest only infers them from decorator
 * metadata, which depends on how the code was compiled; doing it here keeps the document identical everywhere.
 */
function addPathParameters(path: string, item: object): void {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
  for (const op of Object.values(item) as Operation[]) {
    const others = (op.parameters ?? []).filter((p) => p.in !== 'path');
    op.parameters = [
      ...names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...others,
    ];
  }
}

export function serveOpenApi(app: INestApplication): void {
  const document = buildOpenApi(app);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
}
