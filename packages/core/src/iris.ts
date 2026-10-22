import { isHex, type Hash, type Hex } from 'viem';
import { decodeCctpMessage, type DecodedCctpMessage } from './cctp-message';
import { CauceError, isCauceError } from './errors';
import { requestJson } from './http';
import { silentLogger, type CauceLogger } from './logger';
import { defaultRetryOptions, sleep, throwIfAborted, type RetryOptions } from './retry';

export interface IrisClientOptions {
  /** Iris API base URL, e.g. https://iris-api-sandbox.circle.com. */
  baseUrl: string;
  /** Timeout of each HTTP attempt. */
  timeoutMs: number;
  retry: RetryOptions;
  fetch: typeof fetch;
  logger: CauceLogger;
}

export type IrisMessageStatus = 'pending_confirmations' | 'complete';

export interface IrisMessage {
  /** The CCTP message, or null while Iris has not observed it yet. */
  message: Hex | null;
  /** The attestation, or null while it is pending. */
  attestation: Hex | null;
  status: IrisMessageStatus;
  eventNonce: string;
  cctpVersion: number;
  /** Why Circle is delaying the attestation, if it says so (e.g. `insufficient_fee`). */
  delayReason: string | null;
  decoded?: DecodedCctpMessage;
}

export interface AttestedMessage {
  message: Hex;
  attestation: Hex;
  decoded: DecodedCctpMessage;
}

export interface IrisBurnFee {
  /** 1000 = fast transfer, 2000 = standard (finalized) transfer. */
  finalityThreshold: number;
  /** Minimum fee in basis points; may be fractional (e.g. 1.3). */
  minimumFeeBps: number;
}

export interface GetMessagesQuery {
  sourceDomain: number;
  transactionHash: Hash;
  signal?: AbortSignal;
}

export interface WaitForAttestationQuery extends GetMessagesQuery {
  /** Picks the message to wait for when a transaction emits several. Defaults to the first. */
  match?: (message: DecodedCctpMessage) => boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface IrisClient {
  readonly baseUrl: string;
  /** Messages emitted by a source transaction. An empty array means Iris has not indexed it yet. */
  getMessages(query: GetMessagesQuery): Promise<IrisMessage[]>;
  /** Polls until the matching message is attested; throws ATTESTATION_TIMEOUT after `timeoutMs`. */
  waitForAttestation(query: WaitForAttestationQuery): Promise<AttestedMessage>;
  getBurnFees(query: {
    sourceDomain: number;
    destinationDomain: number;
    signal?: AbortSignal;
  }): Promise<IrisBurnFee[]>;
}

export const DEFAULT_IRIS_TIMEOUT_MS = 10_000;
export const DEFAULT_ATTESTATION_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_ATTESTATION_TIMEOUT_MS = 30 * 60_000;

/** Client for Circle's Iris attestation API (CCTP V2 endpoints). */
export function createIrisClient(
  options: Partial<IrisClientOptions> & Pick<IrisClientOptions, 'baseUrl'>,
): IrisClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const http = {
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? DEFAULT_IRIS_TIMEOUT_MS,
    retry: { ...defaultRetryOptions, ...options.retry },
    logger: options.logger ?? silentLogger,
    errorCode: 'IRIS_HTTP',
    timeoutCode: 'IRIS_TIMEOUT',
  } as const;

  async function getMessages({
    sourceDomain,
    transactionHash,
    signal,
  }: GetMessagesQuery): Promise<IrisMessage[]> {
    const url = `${baseUrl}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
    const { status, body } = await requestJson(url, {
      ...http,
      signal,
      passthroughStatuses: [404],
    });
    if (status === 404) return [];
    return parseMessages(body, url);
  }

  async function waitForAttestation(query: WaitForAttestationQuery): Promise<AttestedMessage> {
    const pollIntervalMs = query.pollIntervalMs ?? DEFAULT_ATTESTATION_POLL_INTERVAL_MS;
    const timeoutMs = query.timeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const match = query.match ?? (() => true);

    for (;;) {
      throwIfAborted(query.signal);
      const messages = await getMessages(query);
      const decoded = messages.filter(
        (m): m is IrisMessage & { decoded: DecodedCctpMessage } => m.decoded !== undefined,
      );
      const candidate = decoded.find((m) => match(m.decoded));

      if (candidate?.status === 'complete' && candidate.message && candidate.attestation) {
        return {
          message: candidate.message,
          attestation: candidate.attestation,
          decoded: candidate.decoded,
        };
      }
      if (!candidate && messages.length > 0 && decoded.length === messages.length) {
        throw new CauceError(
          'INVALID_CCTP_MESSAGE',
          `No message in ${query.transactionHash} matches the expected payment`,
          { details: { sourceDomain: query.sourceDomain, transactionHash: query.transactionHash } },
        );
      }

      http.logger.debug('cauce: attestation pending', {
        transactionHash: query.transactionHash,
        delayReason: candidate?.delayReason ?? messages[0]?.delayReason ?? null,
      });
      if (Date.now() + pollIntervalMs > deadline) {
        throw new CauceError(
          'ATTESTATION_TIMEOUT',
          `No attestation for ${query.transactionHash} after ${timeoutMs}ms`,
          { details: { sourceDomain: query.sourceDomain, transactionHash: query.transactionHash } },
        );
      }
      await sleep(pollIntervalMs, query.signal);
    }
  }

  async function getBurnFees({
    sourceDomain,
    destinationDomain,
    signal,
  }: {
    sourceDomain: number;
    destinationDomain: number;
    signal?: AbortSignal;
  }): Promise<IrisBurnFee[]> {
    const url = `${baseUrl}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`;
    const { body } = await requestJson(url, { ...http, signal });
    if (!Array.isArray(body)) throw unexpected(url, body);
    return body.map((item: unknown) => {
      if (!isRecord(item)) throw unexpected(url, body);
      const { finalityThreshold, minimumFee } = item;
      if (typeof finalityThreshold !== 'number' || typeof minimumFee !== 'number') {
        throw unexpected(url, body);
      }
      return { finalityThreshold, minimumFeeBps: minimumFee };
    });
  }

  return { baseUrl, getMessages, waitForAttestation, getBurnFees };
}

function parseMessages(body: unknown, url: string): IrisMessage[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) throw unexpected(url, body);
  return body.messages.map((raw: unknown) => {
    if (!isRecord(raw)) throw unexpected(url, body);
    const status = raw.status;
    if (status !== 'complete' && status !== 'pending_confirmations') throw unexpected(url, body);

    // Iris reports "missing" as null, "0x" or the literal "PENDING".
    const message = asHexOrNull(raw.message);
    const parsed: IrisMessage = {
      message,
      attestation: asHexOrNull(raw.attestation),
      status,
      eventNonce: typeof raw.eventNonce === 'string' ? raw.eventNonce : '',
      cctpVersion: typeof raw.cctpVersion === 'number' ? raw.cctpVersion : Number(raw.cctpVersion),
      delayReason: typeof raw.delayReason === 'string' ? raw.delayReason : null,
    };
    if (message) {
      try {
        parsed.decoded = decodeCctpMessage(message);
      } catch (error) {
        // Not a burn message (e.g. a generic CCTP message): keep it, undecoded.
        if (!isCauceError(error, 'INVALID_CCTP_MESSAGE')) throw error;
      }
    }
    return parsed;
  });
}

function asHexOrNull(value: unknown): Hex | null {
  return typeof value === 'string' && value !== '0x' && isHex(value, { strict: true })
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unexpected(url: string, body: unknown): CauceError {
  return new CauceError('IRIS_HTTP', `Unexpected response from ${url}`, { details: { body } });
}
