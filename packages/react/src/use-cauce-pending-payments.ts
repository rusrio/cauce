import type { PendingPayment } from '@cauce/core';
import type { Hash } from 'viem';
import { useCallback, useEffect, useState } from 'react';
import { useCauceContext } from './context';

export interface UseCaucePendingPaymentsResult {
  /** Burned-but-unsettled payments in this browser, newest first. */
  pending: PendingPayment[];
  /** Forgets a pending payment locally (it can still settle through the relayer). */
  dismiss: (burnTxHash: Hash) => Promise<void>;
  refresh: () => void;
}

/** Lists payments that can be resumed with `useCaucePayment().resume(pending)`. */
export function useCaucePendingPayments(): UseCaucePendingPaymentsResult {
  const { pendingStore, pendingVersion, notifyPendingChanged } = useCauceContext();
  const [pending, setPending] = useState<PendingPayment[]>([]);

  useEffect(() => {
    let cancelled = false;
    void pendingStore.list().then((payments) => {
      if (!cancelled) setPending([...payments].sort((a, b) => b.createdAt - a.createdAt));
    });
    return () => {
      cancelled = true;
    };
  }, [pendingStore, pendingVersion]);

  // Another tab may have stored or settled a payment.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('storage', notifyPendingChanged);
    return () => {
      window.removeEventListener('storage', notifyPendingChanged);
    };
  }, [notifyPendingChanged]);

  const dismiss = useCallback(
    async (burnTxHash: Hash) => {
      await pendingStore.remove(burnTxHash);
      notifyPendingChanged();
    },
    [pendingStore, notifyPendingChanged],
  );

  return { pending, dismiss, refresh: notifyPendingChanged };
}
