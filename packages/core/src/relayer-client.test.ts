import type { Hash } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from './logger';
import { createRelayerClient, type RelayStatusResponse } from './relayer-client';

const burnTxHash: Hash = `0x${'ab'.repeat(32)}`;
const settlementTxHash: Hash = `0x${'cd'.repeat(32)}`;
const request = { burnTxHash, sourceDomain: 6 };

function status(s: RelayStatusResponse['status'], extra: Partial<RelayStatusResponse> = {}) {
  return Response.json({ ...request, status: s, ...extra });
}

function setup(responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>(() => {
    const next = responses.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('Unexpected request'));
  });
  const client = createRelayerClient(
    { relayerUrl: 'https://shop.dev/api/cauce', logger: silentLogger },
    { fetch: fetchMock, retry: { retries: 1, minDelayMs: 10, jitter: false } },
  );
  return { client, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RelayerClient', () => {
  it('submits the burn as JSON', async () => {
    const { client, fetchMock } = setup([status('attesting')]);

    await expect(client.submit(request)).resolves.toEqual({ ...request, status: 'attesting' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://shop.dev/api/cauce/relay');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it('returns undefined for payments the relayer does not know', async () => {
    const { client, fetchMock } = setup([Response.json({ error: 'not found' }, { status: 404 })]);

    await expect(client.getStatus(request)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://shop.dev/api/cauce/relay/6/${burnTxHash}`);
  });

  it('waits for settlement, reporting each status', async () => {
    const { client } = setup([
      status('attesting'),
      status('relaying'),
      status('settled', { settlementTxHash }),
    ]);
    const onStatus = vi.fn<(status: RelayStatusResponse) => void>();

    const result = client.waitForSettlement(request, { pollIntervalMs: 1_000, onStatus });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual({ ...request, status: 'settled', settlementTxHash });
    expect(onStatus.mock.calls.map(([s]) => s.status)).toEqual([
      'attesting',
      'relaying',
      'settled',
    ]);
  });

  it('re-submits when the relayer forgot the payment', async () => {
    const { client, fetchMock } = setup([
      Response.json({}, { status: 404 }),
      status('settled', { settlementTxHash }),
    ]);

    await expect(client.waitForSettlement(request)).resolves.toMatchObject({ status: 'settled' });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
  });

  it('throws RELAY_FAILED when the relayer gives up', async () => {
    const { client } = setup([status('failed', { error: 'attestation expired' })]);

    await expect(client.waitForSettlement(request)).rejects.toMatchObject({
      code: 'RELAY_FAILED',
      message: 'attestation expired',
    });
  });

  it('times out with ATTESTATION_TIMEOUT while still attesting', async () => {
    const { client } = setup(Array.from({ length: 5 }, () => status('attesting')));

    const result = client.waitForSettlement(request, { pollIntervalMs: 1_000, timeoutMs: 2_500 });
    const assertion = expect(result).rejects.toMatchObject({ code: 'ATTESTATION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(3_000);

    await assertion;
  });

  it('rejects malformed responses', async () => {
    const { client } = setup([Response.json({ ...request, status: 'done' })]);

    await expect(client.submit(request)).rejects.toMatchObject({ code: 'RELAYER_HTTP' });
  });

  it('retries server errors', async () => {
    const { client, fetchMock } = setup([Response.json({}, { status: 502 }), status('relaying')]);

    const result = client.submit(request);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ status: 'relaying' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
