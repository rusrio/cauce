import { serializePendingPayment, type PendingPayment } from '@cauce/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalStoragePendingStore, DEFAULT_PENDING_STORAGE_KEY } from './local-storage-store';

const payment: PendingPayment = {
  burnTxHash: `0x${'ab'.repeat(32)}`,
  sourceDomain: 6,
  createdAt: 1,
  ctx: {
    request: {
      merchant: '0x1111111111111111111111111111111111111111',
      orderId: 'o-1',
      amount: 9_007_199_254_740_993n,
    },
    quote: {
      route: 'cctp',
      amount: 9_007_199_254_740_993n,
      maxFee: 1n,
      total: 9_007_199_254_740_994n,
      minFinalityThreshold: 1000,
    },
    sourceChainId: 84532,
    payer: '0x3333333333333333333333333333333333333333',
  },
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('createLocalStoragePendingStore', () => {
  it('persists across store instances (e.g. a reopened tab) with exact bigints', async () => {
    await createLocalStoragePendingStore().put(payment);

    expect(await createLocalStoragePendingStore().list()).toEqual([payment]);
  });

  it('replaces by burn hash and removes case-insensitively', async () => {
    const store = createLocalStoragePendingStore();
    await store.put(payment);
    await store.put({ ...payment, createdAt: 2 });
    expect(await store.list()).toEqual([{ ...payment, createdAt: 2 }]);

    await store.remove(
      payment.burnTxHash.toUpperCase().replace('0X', '0x') as typeof payment.burnTxHash,
    );
    expect(await store.list()).toEqual([]);
  });

  it('drops corrupt entries instead of failing', async () => {
    window.localStorage.setItem(
      DEFAULT_PENDING_STORAGE_KEY,
      JSON.stringify(['garbage', 42, serializePendingPayment(payment)]),
    );
    expect(await createLocalStoragePendingStore().list()).toEqual([payment]);

    window.localStorage.setItem(DEFAULT_PENDING_STORAGE_KEY, '{not json');
    expect(await createLocalStoragePendingStore().list()).toEqual([]);
  });

  it('falls back to memory when storage is unavailable', async () => {
    const store = createLocalStoragePendingStore('k', null);
    await store.put(payment);
    expect(await store.list()).toEqual([payment]);
    expect(window.localStorage.getItem('k')).toBeNull();
  });
});
