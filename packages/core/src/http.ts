import { CauceError, type CauceErrorCode } from './errors';
import type { CauceLogger } from './logger';
import { abortedError, backoffDelay, parseRetryAfter, sleep, type RetryOptions } from './retry';

/** Upper bound for a server-provided Retry-After, so a bad header cannot stall a payment. */
const MAX_RETRY_AFTER_MS = 60_000;

export interface JsonRequestOptions {
  fetch: typeof fetch;
  timeoutMs: number;
  retry: RetryOptions;
  logger: CauceLogger;
  errorCode: Extract<CauceErrorCode, 'IRIS_HTTP' | 'RELAYER_HTTP'>;
  timeoutCode: Extract<CauceErrorCode, 'IRIS_TIMEOUT' | 'RELAYER_HTTP'>;
  /** Non-2xx statuses handed back to the caller instead of failing, e.g. 404 = not indexed yet. */
  passthroughStatuses?: readonly number[];
  init?: RequestInit;
  signal?: AbortSignal | undefined;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

/**
 * Fetches JSON with a per-attempt timeout and exponential backoff. Retries network errors,
 * timeouts, 408, 429 (honouring Retry-After) and 5xx; any other status fails immediately.
 */
export async function requestJson(url: string, options: JsonRequestOptions): Promise<JsonResponse> {
  const { retry, signal, logger } = options;
  const method = options.init?.method ?? 'GET';

  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptRequest(url, method, options);
    if (outcome.kind === 'ok') return outcome.response;
    if (outcome.kind === 'fatal' || attempt >= retry.retries) throw outcome.error;

    const delay =
      outcome.retryAfterMs === undefined
        ? backoffDelay(attempt, retry)
        : Math.min(outcome.retryAfterMs, MAX_RETRY_AFTER_MS);
    logger.debug('cauce: retrying request', {
      url,
      attempt: attempt + 1,
      delayMs: delay,
      reason: outcome.error.message,
    });
    await sleep(delay, signal);
  }
}

type Attempt =
  | { kind: 'ok'; response: JsonResponse }
  | { kind: 'retry'; error: CauceError; retryAfterMs?: number | undefined }
  | { kind: 'fatal'; error: CauceError };

async function attemptRequest(
  url: string,
  method: string,
  options: JsonRequestOptions,
): Promise<Attempt> {
  const { signal } = options;
  if (signal?.aborted) throw abortedError(signal);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  const forwardAbort = () => {
    controller.abort();
  };
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const res = await options.fetch(url, { ...options.init, signal: controller.signal });

    if (res.ok || options.passthroughStatuses?.includes(res.status)) {
      const text = await res.text();
      try {
        return {
          kind: 'ok',
          response: { status: res.status, body: text ? JSON.parse(text) : null },
        };
      } catch (error) {
        return {
          kind: 'fatal',
          error: new CauceError(options.errorCode, `${method} ${url} returned invalid JSON`, {
            cause: error,
            details: { status: res.status },
          }),
        };
      }
    }

    const error = new CauceError(
      options.errorCode,
      `${method} ${url} failed with HTTP ${res.status}`,
      { details: { status: res.status, body: await res.text().catch(() => '') } },
    );
    if (!isRetryableStatus(res.status)) return { kind: 'fatal', error };
    return { kind: 'retry', error, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
  } catch (error) {
    if (signal?.aborted) throw abortedError(signal);
    if (controller.signal.aborted) {
      return {
        kind: 'retry',
        error: new CauceError(
          options.timeoutCode,
          `${method} ${url} timed out after ${options.timeoutMs}ms`,
          { cause: error },
        ),
      };
    }
    return {
      kind: 'retry',
      error: new CauceError(options.errorCode, `${method} ${url} failed: ${String(error)}`, {
        cause: error,
      }),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
