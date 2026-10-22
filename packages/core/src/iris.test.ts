import type { Hash } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import complete from '../test/fixtures/iris-message-complete.json';
import pending from '../test/fixtures/iris-message-pending.json';
import { createIrisClient, type IrisClientOptions } from './iris';

const BASE_URL = 'https://iris.test';
const TX = '0x8907d4c24cb2b060b45d7057fb0dab67d8e48eb9c0be4cea57c752d7ce073da1' as Hash;
const noJitter = { retries: 3, minDelayMs: 100, maxDelayMs: 1_000, factor: 2, jitter: false };

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** A fetch that never answers until its signal aborts, like a stalled connection. */
const stalledFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });

function setup(
  responses: (Response | Error | typeof stalledFetch)[],
  options: Partial<IrisClientOptions> = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const next = responses.shift();
    if (next === undefined) throw new Error('Unexpected request');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(input, init);
    return next;
  });
  const client = createIrisClient({
    baseUrl: `${BASE_URL}/`,
    fetch: fetchMock,
    retry: noJitter,
    timeoutMs: 5_000,
    ...options,
  });
  return { client, fetchMock };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IrisClient.getMessages', () => {
  it('requests the CCTP V2 messages endpoint and parses a complete message', async () => {
    const { client, fetchMock } = setup([json(complete)]);

    const [message] = await client.getMessages({ sourceDomain: 0, transactionHash: TX });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/v2/messages/0?transactionHash=${TX}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(message).toMatchObject({
      status: 'complete',
      cctpVersion: 2,
      message: complete.messages[0]!.message,
      attestation: complete.messages[0]!.attestation,
      delayReason: null,
    });
    expect(message?.decoded?.body.feeExecuted).toBe(1000n);
  });

  it('normalizes pending messages (null message, "PENDING" attestation)', async () => {
    const { client } = setup([json(pending)]);

    const [message] = await client.getMessages({ sourceDomain: 0, transactionHash: TX });

    expect(message).toMatchObject({
      status: 'pending_confirmations',
      message: null,
      attestation: null,
    });
    expect(message?.decoded).toBeUndefined();
  });

  it('treats 404 as "not indexed yet"', async () => {
    const { client, fetchMock } = setup([
      json({ error: 'Message not found for provided parameters' }, { status: 404 }),
    ]);

    await expect(client.getMessages({ sourceDomain: 0, transactionHash: TX })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx responses with exponential backoff', async () => {
    const { client, fetchMock } = setup([
      json({}, { status: 503 }),
      json({}, { status: 502 }),
      json(complete),
    ]);

    const result = client.getMessages({ sourceDomain: 0, transactionHash: TX });

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // first retry after 100ms
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // second retry after 200ms
    await expect(result).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After on 429', async () => {
    const { client, fetchMock } = setup([
      json({}, { status: 429, headers: { 'retry-after': '2' } }),
      json(complete),
    ]);

    const result = client.getMessages({ sourceDomain: 0, transactionHash: TX });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveLength(1);
  });

  it('retries network errors', async () => {
    const { client, fetchMock } = setup([new TypeError('fetch failed'), json(complete)]);

    const result = client.getMessages({ sourceDomain: 0, transactionHash: TX });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry other 4xx responses', async () => {
    const { client, fetchMock } = setup([json({ code: 400, message: 'bad' }, { status: 400 })]);

    await expect(
      client.getMessages({ sourceDomain: 0, transactionHash: TX }),
    ).rejects.toMatchObject({
      code: 'IRIS_HTTP',
      details: { status: 400 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured retries', async () => {
    const { client, fetchMock } = setup(Array.from({ length: 4 }, () => json({}, { status: 500 })));

    const result = client.getMessages({ sourceDomain: 0, transactionHash: TX });
    const assertion = expect(result).rejects.toMatchObject({
      code: 'IRIS_HTTP',
      details: { status: 500 },
    });
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('times out stalled requests and reports IRIS_TIMEOUT', async () => {
    const { client, fetchMock } = setup([stalledFetch, stalledFetch], {
      retry: { ...noJitter, retries: 1 },
      timeoutMs: 1_000,
    });

    const result = client.getMessages({ sourceDomain: 0, transactionHash: TX });
    const assertion = expect(result).rejects.toMatchObject({ code: 'IRIS_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000); // first attempt times out
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100 + 1_000); // backoff, then second attempt times out

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops immediately when the caller aborts', async () => {
    const { client } = setup([stalledFetch]);
    const controller = new AbortController();

    const result = client.getMessages({
      sourceDomain: 0,
      transactionHash: TX,
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects malformed payloads', async () => {
    const { client } = setup([json({ unexpected: true })]);

    await expect(
      client.getMessages({ sourceDomain: 0, transactionHash: TX }),
    ).rejects.toMatchObject({
      code: 'IRIS_HTTP',
    });
  });
});

describe('IrisClient.waitForAttestation', () => {
  it('polls until the message is attested', async () => {
    const { client, fetchMock } = setup([
      json({ error: 'not found' }, { status: 404 }),
      json(pending),
      json(complete),
    ]);

    const result = client.waitForAttestation({
      sourceDomain: 0,
      transactionHash: TX,
      pollIntervalMs: 3_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toMatchObject({
      message: complete.messages[0]!.message,
      attestation: complete.messages[0]!.attestation,
      decoded: { destinationDomain: 13 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('only resolves with a message accepted by `match`', async () => {
    const { client } = setup([json(complete)]);

    await expect(
      client.waitForAttestation({
        sourceDomain: 0,
        transactionHash: TX,
        match: (message) => message.destinationDomain === 26,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CCTP_MESSAGE' });
  });

  it('throws ATTESTATION_TIMEOUT when the deadline passes', async () => {
    const { client } = setup(Array.from({ length: 10 }, () => json(pending)));

    const result = client.waitForAttestation({
      sourceDomain: 0,
      transactionHash: TX,
      pollIntervalMs: 1_000,
      timeoutMs: 3_500,
    });
    const assertion = expect(result).rejects.toMatchObject({ code: 'ATTESTATION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
  });

  it('can be aborted while waiting between polls', async () => {
    const { client } = setup([json(pending)]);
    const controller = new AbortController();

    const result = client.waitForAttestation({
      sourceDomain: 0,
      transactionHash: TX,
      signal: controller.signal,
    });
    const assertion = expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await assertion;
  });
});

describe('IrisClient.getBurnFees', () => {
  it('parses fractional basis points', async () => {
    const { client, fetchMock } = setup([
      json([
        { finalityThreshold: 1000, minimumFee: 1.3 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
    ]);

    await expect(client.getBurnFees({ sourceDomain: 6, destinationDomain: 26 })).resolves.toEqual([
      { finalityThreshold: 1000, minimumFeeBps: 1.3 },
      { finalityThreshold: 2000, minimumFeeBps: 0 },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/v2/burn/USDC/fees/6/26`);
  });
});
