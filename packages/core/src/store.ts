import type { Hash } from 'viem';
import { CauceError } from './errors';
import type { PendingPayment } from './types';

/**
 * Persistence for burned-but-unsettled payments, so they can be resumed after the tab closes.
 * Implementations: in memory (here), localStorage (@cauce/react), or your own backend.
 */
export interface PendingPaymentStore {
  list(): Promise<PendingPayment[]>;
  put(payment: PendingPayment): Promise<void>;
  remove(burnTxHash: Hash): Promise<void>;
}

export function createMemoryPendingStore(): PendingPaymentStore {
  const payments = new Map<string, PendingPayment>();
  return {
    list: () => Promise.resolve([...payments.values()]),
    put: (payment) => {
      payments.set(payment.burnTxHash.toLowerCase(), payment);
      return Promise.resolve();
    },
    remove: (burnTxHash) => {
      payments.delete(burnTxHash.toLowerCase());
      return Promise.resolve();
    },
  };
}

const BIGINT_TAG = '$bigint';

/** JSON encoding that preserves bigint amounts, for stores backed by strings. */
export function serializePendingPayment(payment: PendingPayment): string {
  return JSON.stringify(payment, (_key, value: unknown) =>
    typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value,
  );
}

export function deserializePendingPayment(json: string): PendingPayment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null && BIGINT_TAG in value) {
        return BigInt((value as Record<typeof BIGINT_TAG, string>)[BIGINT_TAG]);
      }
      return value;
    });
  } catch (error) {
    throw new CauceError('INVALID_CONFIG', 'Stored pending payment is not valid JSON', {
      cause: error,
    });
  }
  if (!isPendingPayment(parsed)) {
    throw new CauceError('INVALID_CONFIG', 'Stored pending payment has an unexpected shape');
  }
  return parsed;
}

function isPendingPayment(value: unknown): value is PendingPayment {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<PendingPayment>;
  return (
    typeof p.burnTxHash === 'string' &&
    typeof p.sourceDomain === 'number' &&
    typeof p.createdAt === 'number' &&
    typeof p.ctx?.request.amount === 'bigint' &&
    typeof p.ctx.quote.total === 'bigint' &&
    typeof p.ctx.sourceChainId === 'number'
  );
}
