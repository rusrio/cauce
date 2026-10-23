import {
  createMemoryPendingStore,
  deserializePendingPayment,
  serializePendingPayment,
  type PendingPayment,
  type PendingPaymentStore,
} from '@cauce/core';

export const DEFAULT_PENDING_STORAGE_KEY = 'cauce:pending-payments:v1';

/**
 * Keeps burned-but-unsettled payments in localStorage so they survive a closed tab. Falls back to
 * memory where storage is unavailable (SSR, privacy modes). Corrupt entries are dropped.
 */
export function createLocalStoragePendingStore(
  key: string = DEFAULT_PENDING_STORAGE_KEY,
  /** Defaults to window.localStorage; pass `null` to keep payments in memory only. */
  storage: Storage | null = safeLocalStorage(),
): PendingPaymentStore {
  if (!storage) return createMemoryPendingStore();

  const read = (): PendingPayment[] => {
    let raw: unknown;
    try {
      raw = JSON.parse(storage.getItem(key) ?? '[]');
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry: unknown) => {
      if (typeof entry !== 'string') return [];
      try {
        return [deserializePendingPayment(entry)];
      } catch {
        return [];
      }
    });
  };

  const write = (payments: PendingPayment[]) => {
    storage.setItem(key, JSON.stringify(payments.map(serializePendingPayment)));
  };

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  return {
    list: () => Promise.resolve(read()),
    put(payment) {
      write([...read().filter((p) => !same(p.burnTxHash, payment.burnTxHash)), payment]);
      return Promise.resolve();
    },
    remove(burnTxHash) {
      write(read().filter((p) => !same(p.burnTxHash, burnTxHash)));
      return Promise.resolve();
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Accessing localStorage throws when storage is disabled.
    return null;
  }
}
