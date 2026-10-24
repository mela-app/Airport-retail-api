/**
 * HTTP for live adapters, built so a request can only reach the configured endpoint:
 *
 * - The endpoint is created once from configuration: http/https only, no credentials in the URL.
 * - Requests only append URL-encoded path segments and query parameters to that base URL.
 * - Every request checks the target origin against the endpoint's allow-list (SSRF guard), refuses
 *   redirects, has a timeout and a response-size limit.
 * - The bearer token is sent as a header and never appears in errors.
 */

export interface HttpEndpoint {
  readonly base: URL;
  /** Origins this endpoint may contact (the base URL's origin). */
  readonly allowedOrigins: ReadonlySet<string>;
  readonly token: string | null;
  readonly timeoutMs: number;
  /** Maximum response size in bytes. */
  readonly maxBytes: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface EndpointSettings {
  baseUrl: string;
  token?: string | undefined;
  timeoutMs: number;
  maxBytes: number;
}

export function createEndpoint(settings: EndpointSettings): HttpEndpoint {
  let base: URL;
  try {
    base = new URL(settings.baseUrl);
  } catch {
    throw new Error('invalid endpoint URL');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:')
    throw new Error('endpoint URL must use http or https');
  if (base.username || base.password)
    throw new Error('endpoint URL must not contain credentials; use the token setting');
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  base.search = '';
  base.hash = '';
  return {
    base,
    allowedOrigins: new Set([base.origin]),
    token: settings.token ? settings.token : null,
    timeoutMs: settings.timeoutMs,
    maxBytes: settings.maxBytes,
  };
}

/** The base URL plus encoded path segments and query parameters. */
export function endpointUrl(
  endpoint: HttpEndpoint,
  segments: readonly string[],
  query: ReadonlyMap<string, string> = new Map(),
): URL {
  const url = new URL(endpoint.base.href);
  url.pathname = url.pathname + segments.map((s) => encodeURIComponent(s)).join('/');
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url;
}

async function send(endpoint: HttpEndpoint, url: URL, init: RequestInit): Promise<Response> {
  if (endpoint.allowedOrigins.has(url.origin)) {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json, application/ld+json');
    if (endpoint.token) headers.set('Authorization', `Bearer ${endpoint.token}`);
    return fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(endpoint.timeoutMs),
      redirect: 'error',
    });
  }
  throw new HttpError(`origin ${url.origin} is not allowed for this endpoint`, null);
}

async function request(endpoint: HttpEndpoint, url: URL, init: RequestInit): Promise<string> {
  const where = `${url.origin}${url.pathname}`;
  let response: Response;
  try {
    response = await send(endpoint, url, init);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      `${where}: ${(err as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable'}`,
      null,
    );
  }
  if (!response.ok) throw new HttpError(`${where}: HTTP ${response.status}`, response.status);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > endpoint.maxBytes) throw new HttpError(`${where}: response too large`, response.status);
  const body = await response.text();
  if (body.length > endpoint.maxBytes) throw new HttpError(`${where}: response too large`, response.status);
  return body;
}

export const httpGet = (
  endpoint: HttpEndpoint,
  segments: readonly string[],
  query?: ReadonlyMap<string, string>,
) => request(endpoint, endpointUrl(endpoint, segments, query), { method: 'GET' });

export const httpPostJson = (endpoint: HttpEndpoint, segments: readonly string[], body: unknown) =>
  request(endpoint, endpointUrl(endpoint, segments), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
