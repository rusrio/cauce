import { zeroAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/test/fixtures/hook-data.json';
import { isCauceError } from './errors';
import {
  decodeHookData,
  encodeHookData,
  MAX_ORDER_ID_LENGTH,
  type HookDataInput,
} from './hook-data';

const merchant: Address = '0x1111111111111111111111111111111111111111';
const referrer: Address = '0x2222222222222222222222222222222222222222';

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(isCauceError(error, 'INVALID_HOOK_DATA')).toBe(true);
    return;
  }
  expect.fail('expected INVALID_HOOK_DATA');
}

describe('hookData', () => {
  describe('shared fixture (also checked by the Forge suite)', () => {
    it.each(fixture.valid)('encodes and decodes "$name"', (vector) => {
      const campaignId = BigInt(vector.campaignId);
      const input = {
        merchant: vector.merchant as Address,
        orderId: vector.orderId,
        ...(campaignId > 0n
          ? { referral: { campaignId, referrer: vector.referrer as Address } }
          : {}),
      };

      expect(encodeHookData(input)).toBe(vector.encoded);
      expect(decodeHookData(vector.encoded as Hex)).toEqual({ version: 1, ...input });
    });

    it.each(fixture.invalid)('rejects "$name"', (vector) => {
      expectInvalid(() => decodeHookData(vector.encoded as Hex));
    });
  });

  it('round-trips with and without referral', () => {
    const plain = { merchant, orderId: 'order-1' };
    const withReferral = { ...plain, referral: { campaignId: 3n, referrer } };

    expect(decodeHookData(encodeHookData(plain))).toEqual({ version: 1, ...plain });
    expect(decodeHookData(encodeHookData(withReferral))).toEqual({ version: 1, ...withReferral });
  });

  it('counts the order id length in UTF-8 bytes, like the vault', () => {
    const fourByteChar = '🚀';
    expect(() =>
      encodeHookData({ merchant, orderId: fourByteChar.repeat(MAX_ORDER_ID_LENGTH / 4) }),
    ).not.toThrow();
    expectInvalid(() =>
      encodeHookData({ merchant, orderId: fourByteChar.repeat(MAX_ORDER_ID_LENGTH / 4) + 'x' }),
    );
  });

  it.each<[string, HookDataInput]>([
    ['zero merchant', { merchant: zeroAddress, orderId: 'a' }],
    ['malformed merchant', { merchant: '0x1234', orderId: 'a' }],
    ['empty order id', { merchant, orderId: '' }],
    ['zero campaign id', { merchant, orderId: 'a', referral: { campaignId: 0n, referrer } }],
    [
      'zero referrer',
      { merchant, orderId: 'a', referral: { campaignId: 1n, referrer: zeroAddress } },
    ],
  ])('refuses to encode with %s', (_name, input) => {
    expectInvalid(() => encodeHookData(input));
  });

  it('rejects non-canonical encodings the vault would refund', () => {
    const encoded = encodeHookData({ merchant, orderId: 'order-1' });
    expectInvalid(() => decodeHookData(`${encoded}00` as Hex));
  });
});
