import { describe, expect, it } from 'vitest';
import {
  createMemoryPendingStore,
  deserializePendingPayment,
  serializePendingPayment,
} from './store';
import type { PendingPayment } from './types';

const payment: PendingPayment = {
  burnTxHash: '0x00000000000000000000000000000000000000000000000000000000000000AB',
  sourceDomain: 6,
  createdAt: 1_761_134_400_000,
  ctx: {
    request: {
      merchant: '0x1111111111111111111111111111111111111111',
      orderId: 'order-1',
      amount: 9_007_199_254_740_993n,
      referral: { campaignId: 7n, referrer: '0x2222222222222222222222222222222222222222' },
    },
    quote: {
      route: 'cctp',
      amount: 9_007_199_254_740_993n,
      maxFee: 1_001n,
      total: 9_007_199_254_741_994n,
      minFinalityThreshold: 1000,
    },
    sourceChainId: 84532,
    payer: '0x3333333333333333333333333333333333333333',
  },
};

describe('memory pending store', () => {
  it('puts, lists and removes by burn hash (case-insensitive)', async () => {
    const store = createMemoryPendingStore();

    await store.put(payment);
    await store.put(payment);
    expect(await store.list()).toEqual([payment]);

    await store.remove('0x00000000000000000000000000000000000000000000000000000000000000ab');
    expect(await store.list()).toEqual([]);
  });
});

describe('pending payment serialization', () => {
  it('round-trips bigint amounts exactly', () => {
    expect(deserializePendingPayment(serializePendingPayment(payment))).toEqual(payment);
  });

  it.each(['not json', '{}', JSON.stringify({ ...payment, ctx: null })])('rejects %s', (input) => {
    expect(() => deserializePendingPayment(input)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
});
