import { CauceError } from './errors';

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  minDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** Randomize each delay between 50% and 100% to avoid synchronized retries. */
  jitter: boolean;
}

export const defaultRetryOptions: RetryOptions = {
  retries: 5,
  minDelayMs: 500,
  maxDelayMs: 8_000,
  factor: 2,
  jitter: true,
};

/** Exponential backoff delay before retry number `attempt` (0-based). */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  const delay = Math.min(options.maxDelayMs, options.minDelayMs * options.factor ** attempt);
  return options.jitter ? delay / 2 + Math.random() * (delay / 2) : delay;
}

/** Resolves after `ms`, or rejects with an ABORTED CauceError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError(signal);
}

export function abortedError(signal: AbortSignal | undefined): CauceError {
  return new CauceError('ABORTED', 'The operation was aborted', { cause: signal?.reason });
}

/** Parses a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
