import { CauceError, type CauceConfig, type PendingPaymentStore } from '@cauce/core';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createLocalStoragePendingStore } from './local-storage-store';

interface CauceContextValue {
  config: CauceConfig;
  pendingStore: PendingPaymentStore;
  /** Bumped whenever the pending store changes, so lists re-read it. */
  pendingVersion: number;
  notifyPendingChanged: () => void;
}

const CauceContext = createContext<CauceContextValue | null>(null);

export interface CauceProviderProps {
  config: CauceConfig;
  /** Defaults to localStorage in the browser (memory during SSR). */
  pendingStore?: PendingPaymentStore;
  children: ReactNode;
}

/** Provides the Cauce config to the hooks. Place it inside WagmiProvider and QueryClientProvider. */
export function CauceProvider({ config, pendingStore, children }: CauceProviderProps) {
  const store = useMemo(() => pendingStore ?? createLocalStoragePendingStore(), [pendingStore]);
  const [pendingVersion, setPendingVersion] = useState(0);
  const notifyPendingChanged = useCallback(() => {
    setPendingVersion((version) => version + 1);
  }, []);

  const value = useMemo(
    () => ({ config, pendingStore: store, pendingVersion, notifyPendingChanged }),
    [config, store, pendingVersion, notifyPendingChanged],
  );
  return <CauceContext.Provider value={value}>{children}</CauceContext.Provider>;
}

export function useCauceContext(): CauceContextValue {
  const value = useContext(CauceContext);
  if (!value) {
    throw new CauceError('INVALID_CONFIG', 'Cauce hooks must be used inside <CauceProvider>');
  }
  return value;
}

export function useCauceConfig(): CauceConfig {
  return useCauceContext().config;
}
