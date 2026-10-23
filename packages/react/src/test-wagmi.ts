/**
 * A controllable stand-in for `wagmi` and `wagmi/actions` in tests: connection state plus fake
 * viem clients that record transactions and mine them instantly.
 */
import type { Address, Hash } from 'viem';
import { vi } from 'vitest';

export const PAYER: Address = '0x3333333333333333333333333333333333333333';

export const wallet = {
  status: 'connected' as 'connected' | 'disconnected',
  chainId: 84532,
  /** Chains the fake wagmi config knows. */
  configuredChains: new Set([84532, 5042002]),
  rejectNextWrite: false,
  writes: [] as { functionName: string; args: readonly unknown[] }[],
};

export function resetWallet() {
  wallet.status = 'connected';
  wallet.chainId = 84532;
  wallet.configuredChains = new Set([84532, 5042002]);
  wallet.rejectNextWrite = false;
  wallet.writes = [];
}

const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}`;

export const wagmiModule = {
  useConfig: () => ({}),
  useConnection: () =>
    wallet.status === 'connected'
      ? { status: 'connected', chainId: wallet.chainId, address: PAYER }
      : { status: 'disconnected', chainId: undefined, address: undefined },
};

export const wagmiActionsModule = {
  getWalletClient: vi.fn(() => {
    if (wallet.status !== 'connected') {
      return Promise.reject(
        Object.assign(new Error('Connector not connected.'), {
          name: 'ConnectorNotConnectedError',
        }),
      );
    }
    return Promise.resolve({
      account: { address: PAYER, type: 'json-rpc' },
      chain: { id: wallet.chainId },
      getChainId: () => Promise.resolve(wallet.chainId),
      writeContract: (call: { functionName: string; args: readonly unknown[] }) => {
        if (wallet.rejectNextWrite) {
          wallet.rejectNextWrite = false;
          return Promise.reject(
            Object.assign(new Error('User rejected the request.'), { code: 4001 }),
          );
        }
        wallet.writes.push(call);
        return Promise.resolve(hash(wallet.writes.length));
      },
    });
  }),
  getPublicClient: vi.fn((_config: unknown, { chainId }: { chainId: number }) =>
    wallet.configuredChains.has(chainId)
      ? {
          chain: { id: chainId },
          readContract: () => Promise.resolve(0n),
          waitForTransactionReceipt: ({ hash: txHash }: { hash: Hash }) =>
            Promise.resolve({ status: 'success', transactionHash: txHash }),
        }
      : undefined,
  ),
};
