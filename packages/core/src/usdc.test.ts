import { describe, expect, it } from 'vitest';
import { formatUsdc, parseUsdc } from './usdc';

describe('parseUsdc', () => {
  it.each([
    ['1', 1_000_000n],
    ['12.5', 12_500_000n],
    ['0.000001', 1n],
    ['.5', 500_000n],
    ['7.', 7_000_000n],
    [' 3.25 ', 3_250_000n],
    ['1000000.123456', 1_000_000_123_456n],
  ])('parses "%s"', (input, expected) => {
    expect(parseUsdc(input)).toBe(expected);
  });

  it.each(['', '.', 'abc', '-1', '1e6', '1,5', '1.2345678', '0x10'])('rejects "%s"', (input) => {
    expect(() => parseUsdc(input)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
  });

  it('keeps precision where floating point would not', () => {
    expect(parseUsdc('0.29')).toBe(290_000n);
    expect(parseUsdc('9007199254.740993')).toBe(9_007_199_254_740_993n);
  });
});

describe('formatUsdc', () => {
  it.each([
    [1_000_000n, '1.00'],
    [12_500_000n, '12.50'],
    [1n, '0.000001'],
    [0n, '0.00'],
    [9_007_199_254_740_993n, '9007199254.740993'],
  ])('formats %s', (amount, expected) => {
    expect(formatUsdc(amount)).toBe(expected);
  });

  it('can drop trailing decimals', () => {
    expect(formatUsdc(5_000_000n, { minDecimals: 0 })).toBe('5');
  });
});
