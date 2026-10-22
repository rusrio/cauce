import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, parseRetryAfter, sleep, type RetryOptions } from './retry';

const options: RetryOptions = {
  retries: 5,
  minDelayMs: 100,
  maxDelayMs: 1_000,
  factor: 2,
  jitter: false,
};

describe('backoffDelay', () => {
  it('grows exponentially up to maxDelayMs', () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, options))).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ]);
  });

  it('keeps jittered delays between 50% and 100% of the backoff', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    expect(backoffDelay(2, { ...options, jitter: true })).toBe(200);
    expect(backoffDelay(2, { ...options, jitter: true })).toBeCloseTo(400, 3);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Thu, 22 Oct 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Thu, 22 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('sleep', () => {
  it('rejects with ABORTED when the signal is already aborted', async () => {
    await expect(sleep(1_000, AbortSignal.abort())).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
