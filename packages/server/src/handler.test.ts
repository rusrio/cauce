import { createRelayerClient, silentLogger } from '@cauce/core';
import type { Hash } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createRelayHandler } from './handler';
import { createCauceRouteHandlers } from './next';
import type { CauceRelayer } from './relayer';
import {
  BURN_TX,
  cctpMessage,
  irisComplete,
  irisNotFound,
  SOURCE_DOMAIN,
  testRelayer,
} from './test-helpers';

const BASE = 'https://shop.dev/api/cauce';
const body = { burnTxHash: BURN_TX, sourceDomain: SOURCE_DOMAIN };

function post(payload: unknown, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`${BASE}/relay`, {
    ...init,
    method: 'POST',
    headers,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

describe('createRelayHandler', () => {
  it('speaks the same contract as the @cauce/core relayer client', async () => {
    const { relayer, chain } = testRelayer([irisNotFound, irisComplete(cctpMessage())]);
    const handler = createRelayHandler(relayer);
    const client = createRelayerClient(
      { relayerUrl: BASE, logger: silentLogger },
      { fetch: (input, init) => handler(new Request(input, init)) },
    );

    expect(await client.submit(body)).toEqual({ ...body, status: 'attesting' });
    expect(await client.getStatus(body)).toMatchObject({ status: 'relaying' });
    chain.mine(chain.sent[0]!.hash);
    await expect(client.waitForSettlement(body, { pollIntervalMs: 1 })).resolves.toEqual({
      ...body,
      status: 'settled',
      settlementTxHash: chain.sent[0]!.hash,
    });
  });

  it('answers 404 for payments it never saw, which makes the client re-submit', async () => {
    const handler = createRelayHandler(testRelayer([irisNotFound]).relayer);

    const res = await handler(new Request(`${BASE}/relay/${SOURCE_DOMAIN}/${BURN_TX}`));

    expect(res.status).toBe(404);
  });

  it('works under any mount path and never caches statuses', async () => {
    const handler = createRelayHandler(testRelayer([irisNotFound]).relayer);

    const res = await handler(post(body, {}));
    const nested = await handler(
      new Request(`https://shop.dev/deep/prefix/relay/${SOURCE_DOMAIN}/${BURN_TX}`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(nested.status).toBe(200);
  });

  it.each([
    ['invalid JSON', post('{nope'), 'Invalid JSON'],
    ['a non-object body', post('[]'), 'burnTxHash must be a 32-byte hex transaction hash'],
    [
      'a malformed hash',
      post({ ...body, burnTxHash: '0x1234' }),
      'burnTxHash must be a 32-byte hex transaction hash',
    ],
    [
      'a fractional domain',
      post({ ...body, sourceDomain: 6.5 }),
      'sourceDomain must be a non-negative integer',
    ],
    [
      'the wrong content type',
      post(body, { headers: { 'content-type': 'text/plain' } }),
      'Expected an application/json body',
    ],
    ['an oversized body', post({ ...body, padding: 'x'.repeat(2_000) }), 'Body too large'],
    [
      'an unsupported source domain',
      post({ ...body, sourceDomain: 0 }),
      'Source domain 0 is not configured',
    ],
  ])('rejects %s with 400', async (_name, request, error) => {
    const handler = createRelayHandler(testRelayer([irisNotFound]).relayer);

    const res = await handler(request);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it('rejects wrong methods and unknown routes', async () => {
    const handler = createRelayHandler(testRelayer([irisNotFound]).relayer);

    expect((await handler(new Request(`${BASE}/relay`))).status).toBe(405);
    expect(
      (await handler(new Request(`${BASE}/relay/6/${BURN_TX}`, { method: 'DELETE' }))).status,
    ).toBe(405);
    expect((await handler(new Request(`${BASE}/health`))).status).toBe(404);
  });

  it('hides internal errors', async () => {
    const relayer = {
      address: '0x0000000000000000000000000000000000000001',
      submit: vi.fn(() => Promise.reject(new Error('RPC https://secret-key@rpc.example failed'))),
      getStatus: vi.fn(),
      settle: vi.fn(),
    } as unknown as CauceRelayer;

    const res = await createRelayHandler(relayer)(post(body));

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret');
  });

  it('keeps settling in the background through waitUntil', async () => {
    const { relayer } = testRelayer([irisNotFound]);
    const settle = vi.spyOn(relayer, 'settle').mockResolvedValue({ ...body, status: 'settled' });
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();

    await createRelayHandler(relayer, { waitUntil })(post(body));

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(body);
  });

  it('does not schedule background work for finished payments', async () => {
    const { relayer } = testRelayer([irisComplete(cctpMessage({ destinationDomain: 3 }))]);
    const waitUntil = vi.fn();

    const res = await createRelayHandler(relayer, { waitUntil })(post(body));

    expect(await res.json()).toMatchObject({ status: 'failed' });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  describe('CORS', () => {
    const handler = createRelayHandler(testRelayer([irisNotFound]).relayer, {
      cors: { origins: ['https://checkout.shop.dev'] },
    });

    it('answers preflight requests from allowed origins', async () => {
      const res = await handler(
        new Request(`${BASE}/relay`, {
          method: 'OPTIONS',
          headers: { origin: 'https://checkout.shop.dev' },
        }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://checkout.shop.dev');
    });

    it('does not grant other origins', async () => {
      const res = await handler(post(body, { headers: { origin: 'https://evil.dev' } }));
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('is off by default', async () => {
      const res = await createRelayHandler(testRelayer([irisNotFound]).relayer)(
        new Request(`${BASE}/relay`, {
          method: 'OPTIONS',
          headers: { origin: 'https://checkout.shop.dev' },
        }),
      );
      expect(res.status).toBe(405);
    });
  });
});

describe('createCauceRouteHandlers (Next.js)', () => {
  it('exposes GET, POST and OPTIONS backed by the same handler', async () => {
    const { relayer } = testRelayer([irisNotFound]);
    const { GET, POST, OPTIONS } = createCauceRouteHandlers(relayer);

    expect((await POST(post(body))).status).toBe(200);
    const status = (await (
      await GET(new Request(`${BASE}/relay/${SOURCE_DOMAIN}/${BURN_TX}`))
    ).json()) as {
      burnTxHash: Hash;
    };
    expect(status.burnTxHash).toBe(BURN_TX);
    expect((await OPTIONS(new Request(`${BASE}/relay`, { method: 'OPTIONS' }))).status).toBe(405);
  });
});
