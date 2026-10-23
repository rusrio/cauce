import type { RelayStatus } from '@cauce/core';
import type { Hash } from 'viem';

export interface RelayJob {
  burnTxHash: Hash;
  sourceDomain: number;
  status: RelayStatus;
  /** The CauceRelay.relayPayment transaction, once sent. */
  settlementTxHash?: Hash;
  /** Terminal failure reason (status `failed`). */
  error?: string;
  /** Last transient problem (Iris or RPC unavailable); the job keeps progressing. */
  lastError?: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** Incremented on every write; the compare-and-set token. */
  version: number;
}

/**
 * Persistence for relay jobs. `compareAndSet` must be atomic across every relayer instance that
 * shares the store, so two instances never both send the same relay transaction. The in-memory
 * store is only safe with a single instance.
 */
export interface RelayJobStore {
  get(key: string): Promise<RelayJob | undefined>;
  /** Stores the job unless one exists; resolves with whichever job is stored afterwards. */
  create(key: string, job: RelayJob): Promise<RelayJob>;
  /** Replaces the job only if its stored version is still `expectedVersion`. */
  compareAndSet(key: string, expectedVersion: number, job: RelayJob): Promise<boolean>;
}

export function relayJobKey(sourceDomain: number, burnTxHash: Hash): string {
  return `${sourceDomain}:${burnTxHash.toLowerCase()}`;
}

export function createMemoryRelayJobStore(): RelayJobStore {
  const jobs = new Map<string, RelayJob>();
  return {
    get: (key) => Promise.resolve(jobs.get(key)),
    create(key, job) {
      const existing = jobs.get(key);
      if (existing) return Promise.resolve(existing);
      jobs.set(key, job);
      return Promise.resolve(job);
    },
    compareAndSet(key, expectedVersion, job) {
      if (jobs.get(key)?.version !== expectedVersion) return Promise.resolve(false);
      jobs.set(key, job);
      return Promise.resolve(true);
    },
  };
}
