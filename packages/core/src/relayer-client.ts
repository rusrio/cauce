import { isHash, type Hash } from 'viem';
import type { CauceConfig } from './config';
import { CauceError } from './errors';
import { requestJson, type JsonRequestOptions } from './http';
import { defaultRetryOptions, sleep, throwIfAborted, type RetryOptions } from './retry';

/**
 * HTTP contract between clients and @cauce/server:
 *
 *   POST {relayerUrl}/relay                          body: RelayRequest  → RelayStatusResponse
 *   GET  {relayerUrl}/relay/{sourceDomain}/{hash}                         → RelayStatusResponse | 404
 *
 * POST is idempotent: submitting the same burn again returns its current status.
 */
export interface RelayRequest {
  burnTxHash: Hash;
  sourceDomain: number;
}

export type RelayStatus = 'attesting' | 'relaying' | 'settled' | 'failed';

export interface RelayStatusResponse extends RelayRequest {
  status: RelayStatus;
  /** CauceRelay.relayPayment transaction on the settlement chain, once known. */
  settlementTxHash?: Hash;
  /** Why the relay failed, when status is `failed`. */
  error?: string;
}

export interface WaitForSettlementOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with every status the relayer reports, e.g. to move a UI from attesting to relaying. */
  onStatus?: (status: RelayStatusResponse) => void;
}

export interface RelayerClient {
  submit(request: RelayRequest, options?: { signal?: AbortSignal }): Promise<RelayStatusResponse>;
  /** Current status, or undefined if the relayer does not know the payment. */
  getStatus(
    request: RelayRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RelayStatusResponse | undefined>;
  /** Polls until settled. Throws RELAY_FAILED if the relayer gives up, or on timeout. */
  waitForSettlement(
    request: RelayRequest,
    options?: WaitForSettlementOptions,
  ): Promise<RelayStatusResponse & { status: 'settled'; settlementTxHash: Hash }>;
}

export interface RelayerClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
}

export const DEFAULT_RELAY_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_RELAY_TIMEOUT_MS = 30 * 60_000;

const STATUSES: readonly RelayStatus[] = ['attesting', 'relaying', 'settled', 'failed'];

export function createRelayerClient(
  config: Pick<CauceConfig, 'relayerUrl' | 'logger'>,
  options: RelayerClientOptions = {},
): RelayerClient {
  const http: Omit<JsonRequestOptions, 'signal'> = {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? 15_000,
    retry: { ...defaultRetryOptions, ...options.retry },
    logger: config.logger,
    errorCode: 'RELAYER_HTTP',
    timeoutCode: 'RELAYER_HTTP',
  };

  async function submit(
    request: RelayRequest,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<RelayStatusResponse> {
    const url = `${config.relayerUrl}/relay`;
    const { body } = await requestJson(url, {
      ...http,
      signal,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          burnTxHash: request.burnTxHash,
          sourceDomain: request.sourceDomain,
        }),
      },
    });
    return parseStatus(body, url);
  }

  async function getStatus(
    request: RelayRequest,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<RelayStatusResponse | undefined> {
    const url = `${config.relayerUrl}/relay/${request.sourceDomain}/${request.burnTxHash}`;
    const { status, body } = await requestJson(url, {
      ...http,
      signal,
      passthroughStatuses: [404],
    });
    return status === 404 ? undefined : parseStatus(body, url);
  }

  async function waitForSettlement(
    request: RelayRequest,
    {
      pollIntervalMs = DEFAULT_RELAY_POLL_INTERVAL_MS,
      timeoutMs = DEFAULT_RELAY_TIMEOUT_MS,
      signal,
      onStatus,
    }: WaitForSettlementOptions = {},
  ): Promise<RelayStatusResponse & { status: 'settled'; settlementTxHash: Hash }> {
    const deadline = Date.now() + timeoutMs;
    const opts = signal ? { signal } : {};

    for (;;) {
      throwIfAborted(signal);
      // The relayer may have restarted and forgotten the payment: submitting again is safe.
      const current = (await getStatus(request, opts)) ?? (await submit(request, opts));
      onStatus?.(current);

      if (current.status === 'settled' && current.settlementTxHash) {
        return { ...current, status: 'settled', settlementTxHash: current.settlementTxHash };
      }
      if (current.status === 'failed') {
        throw new CauceError(
          'RELAY_FAILED',
          current.error ?? 'The relayer could not settle the payment',
          {
            details: { ...request },
          },
        );
      }
      if (Date.now() + pollIntervalMs > deadline) {
        throw new CauceError(
          current.status === 'attesting' ? 'ATTESTATION_TIMEOUT' : 'RELAY_FAILED',
          `Payment ${request.burnTxHash} not settled after ${timeoutMs}ms (${current.status})`,
          { details: { ...request, status: current.status } },
        );
      }
      await sleep(pollIntervalMs, signal);
    }
  }

  return { submit, getStatus, waitForSettlement };
}

function parseStatus(body: unknown, url: string): RelayStatusResponse {
  if (typeof body !== 'object' || body === null) throw unexpected(url, body);
  const { burnTxHash, sourceDomain, status, settlementTxHash, error } = body as Record<
    string,
    unknown
  >;
  if (
    typeof burnTxHash !== 'string' ||
    !isHash(burnTxHash) ||
    typeof sourceDomain !== 'number' ||
    !STATUSES.includes(status as RelayStatus) ||
    (settlementTxHash !== undefined &&
      (typeof settlementTxHash !== 'string' || !isHash(settlementTxHash))) ||
    (error !== undefined && typeof error !== 'string')
  ) {
    throw unexpected(url, body);
  }
  return {
    burnTxHash,
    sourceDomain,
    status: status as RelayStatus,
    ...(settlementTxHash ? { settlementTxHash } : {}),
    ...(error ? { error } : {}),
  };
}

function unexpected(url: string, body: unknown): CauceError {
  return new CauceError('RELAYER_HTTP', `Unexpected response from ${url}`, { details: { body } });
}
