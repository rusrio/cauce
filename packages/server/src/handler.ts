import { isCauceError, type RelayRequest } from '@cauce/core';
import { isHash } from 'viem';
import type { CauceRelayer } from './relayer';

export interface RelayHandlerOptions {
  /**
   * Keeps settling a submitted payment after the response is sent, on platforms that support it
   * (Next.js `after`, Vercel/Cloudflare `waitUntil`). Without it, progress is driven by polling.
   */
  waitUntil?: (task: Promise<unknown>) => void;
  /** Allowed origins for cross-origin checkouts. Same-origin needs no CORS. */
  cors?: { origins: '*' | readonly string[] };
}

export type RelayHandler = (request: Request) => Promise<Response>;

const MAX_BODY_BYTES = 1_024;
const STATUS_PATH = /\/relay\/(\d{1,10})\/(0x[0-9a-fA-F]{64})\/?$/;
const SUBMIT_PATH = /\/relay\/?$/;

/**
 * Framework-agnostic Fetch API handler implementing the relayer contract of @cauce/core:
 *
 *   POST …/relay                        { burnTxHash, sourceDomain } → RelayStatusResponse
 *   GET  …/relay/:sourceDomain/:hash                                  → RelayStatusResponse | 404
 *
 * Routes match on the end of the path, so the handler can be mounted under any prefix. Both
 * routes advance the payment (polling drives it), and both are idempotent.
 */
export function createRelayHandler(
  relayer: CauceRelayer,
  options: RelayHandlerOptions = {},
): RelayHandler {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const cors = corsHeaders(request, options.cors);

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: cors ? 204 : 405, headers: cors ?? {} });
      }

      const statusMatch = STATUS_PATH.exec(pathname);
      if (statusMatch) {
        if (request.method !== 'GET')
          return json(405, { error: 'Method not allowed' }, cors, 'GET');
        const relayRequest = {
          sourceDomain: Number(statusMatch[1]),
          burnTxHash: statusMatch[2] as RelayRequest['burnTxHash'],
        };
        const status = await relayer.getStatus(relayRequest);
        return status ? json(200, status, cors) : json(404, { error: 'Unknown payment' }, cors);
      }

      if (SUBMIT_PATH.test(pathname)) {
        if (request.method !== 'POST')
          return json(405, { error: 'Method not allowed' }, cors, 'POST');
        const parsed = await parseRelayRequest(request);
        if ('error' in parsed) return json(400, { error: parsed.error }, cors);

        const status = await relayer.submit(parsed);
        if (options.waitUntil && status.status !== 'settled' && status.status !== 'failed') {
          options.waitUntil(relayer.settle(parsed).catch(() => undefined));
        }
        return json(200, status, cors);
      }

      return json(404, { error: 'Not found' }, cors);
    } catch (error) {
      if (isCauceError(error, 'UNSUPPORTED_CHAIN'))
        return json(400, { error: error.message }, cors);
      // Never leak internals (RPC URLs, stack traces) to clients.
      return json(500, { error: 'Internal relayer error' }, cors);
    }
  };
}

async function parseRelayRequest(request: Request): Promise<RelayRequest | { error: string }> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return { error: 'Expected an application/json body' };
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return { error: 'Body too large' };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'Body too large' };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: 'Invalid JSON' };
  }
  if (typeof body !== 'object' || body === null) return { error: 'Expected a JSON object' };

  const { burnTxHash, sourceDomain } = body as Record<string, unknown>;
  if (typeof burnTxHash !== 'string' || !isHash(burnTxHash)) {
    return { error: 'burnTxHash must be a 32-byte hex transaction hash' };
  }
  if (typeof sourceDomain !== 'number' || !Number.isInteger(sourceDomain) || sourceDomain < 0) {
    return { error: 'sourceDomain must be a non-negative integer' };
  }
  return { burnTxHash, sourceDomain };
}

function corsHeaders(
  request: Request,
  cors: RelayHandlerOptions['cors'],
): Record<string, string> | undefined {
  const origin = request.headers.get('origin');
  if (!cors || !origin) return undefined;
  const allowed = cors.origins === '*' || cors.origins.includes(origin);
  if (!allowed) return undefined;
  return {
    'access-control-allow-origin': cors.origins === '*' ? '*' : origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function json(
  status: number,
  body: unknown,
  cors: Record<string, string> | undefined,
  allow?: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Statuses change while the payment progresses: never cache them.
      'cache-control': 'no-store',
      ...(allow ? { allow } : {}),
      ...cors,
    },
  });
}
