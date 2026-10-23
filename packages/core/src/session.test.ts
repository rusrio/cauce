import type {
  Account,
  Address,
  Chain,
  Hash,
  Hex,
  PublicClient,
  Transport,
  WalletClient,
} from 'viem';
import { arcTestnet, baseSepolia } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { addressToBytes32 } from './cctp-message';
import { createCauceConfig } from './config';
import { CauceError } from './errors';
import { computeMaxFee } from './fees';
import { decodeHookData } from './hook-data';
import type { CaucePaymentState } from './machine';
import type { RelayerClient, RelayRequest, RelayStatusResponse } from './relayer-client';
import { createPaymentSession, type PaymentSessionDeps } from './session';
import { createMemoryPendingStore, type PendingPaymentStore } from './store';
import type { CaucePaymentRequest } from './types';

const vault: Address = '0x00000000000000000000000000000000000000Aa';
const relay: Address = '0x00000000000000000000000000000000000000bB';
const payer: Address = '0x3333333333333333333333333333333333333333';
const settlementTxHash: Hash = `0x${'5e'.repeat(32)}`;
const BASE_SEPOLIA = {
  tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

const request: CaucePaymentRequest = {
  merchant: '0x1111111111111111111111111111111111111111',
  orderId: 'order-42',
  amount: 25_000_000n,
};
const maxFee = computeMaxFee(request.amount, 1.3 + 0.5);

function txHash(n: number): Hash {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

interface WriteCall {
  address: Address;
  functionName: string;
  args: readonly unknown[];
}

function setup({
  chainId = baseSepolia.id,
  allowance = 0n,
  reverted = new Set<Hash>(),
  rejectApproval = false,
  relayer: relayerOverrides = {},
  store = createMemoryPendingStore(),
}: {
  chainId?: number;
  allowance?: bigint;
  reverted?: Set<Hash>;
  rejectApproval?: boolean;
  relayer?: Partial<RelayerClient>;
  store?: PendingPaymentStore;
} = {}) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      Response.json([
        { finalityThreshold: 1000, minimumFee: 1.3 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
    ),
  );
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = createCauceConfig({
    environment: 'testnet',
    chains: [baseSepolia],
    relayerUrl: 'https://relayer.dev',
    settlement: { vault, relay },
    iris: { fetch: fetchMock },
    logger,
  });

  const events: string[] = [];
  let nonce = 0;
  const writes: WriteCall[] = [];
  const walletClient = {
    account: { address: payer, type: 'json-rpc' },
    getChainId: vi.fn(() => Promise.resolve(chainId)),
    writeContract: vi.fn((call: WriteCall) => {
      if (rejectApproval && call.functionName === 'approve') {
        const error = Object.assign(new Error('User rejected the request.'), { code: 4001 });
        return Promise.reject(error);
      }
      writes.push(call);
      const hash = txHash(++nonce);
      events.push(`write:${call.functionName}`);
      return Promise.resolve(hash);
    }),
  } as unknown as WalletClient<Transport, Chain, Account>;
  const publicClient = {
    chain: { id: chainId },
    readContract: vi.fn(() => Promise.resolve(allowance)),
    waitForTransactionReceipt: vi.fn(({ hash }: { hash: Hash }) => {
      events.push(`receipt:${hash}`);
      return Promise.resolve({
        status: reverted.has(hash) ? 'reverted' : 'success',
        transactionHash: hash,
      });
    }),
  } as unknown as PublicClient;

  const relayer: RelayerClient = {
    submit: vi.fn((req: RelayRequest) =>
      Promise.resolve<RelayStatusResponse>({ ...req, status: 'attesting' }),
    ),
    getStatus: vi.fn(() => Promise.resolve(undefined)),
    waitForSettlement: vi.fn<RelayerClient['waitForSettlement']>((req, options) => {
      options?.onStatus?.({ ...req, status: 'relaying' });
      return Promise.resolve({ ...req, status: 'settled' as const, settlementTxHash });
    }),
    ...relayerOverrides,
  };

  const originalPut = store.put.bind(store);
  store.put = (p) => {
    events.push(`store:put:${p.burnTxHash}`);
    return originalPut(p);
  };

  const deps: PaymentSessionDeps = { walletClient, publicClient, store, relayer };
  const session = createPaymentSession(config, deps);
  const states: CaucePaymentState[] = [];
  session.subscribe((s) => states.push(s));

  return { session, writes, events, store, relayer, logger, states, publicClient, walletClient };
}

describe('PaymentSession — CCTP route', () => {
  it('approves, burns to the vault with the relay as destination caller, and settles', async () => {
    const { session, writes, states, store, relayer } = setup();

    const settled = await session.pay(request);

    expect(states.map((s) => s.status)).toEqual([
      'approving',
      'approving',
      'burning',
      'burning',
      'attesting',
      'relaying',
      'settled',
    ]);
    expect(settled).toMatchObject({ status: 'settled', burnTxHash: txHash(2), settlementTxHash });

    const total = request.amount + maxFee;
    expect(writes[0]).toMatchObject({
      address: BASE_SEPOLIA.usdc,
      functionName: 'approve',
      args: [BASE_SEPOLIA.tokenMessenger, total],
    });
    const burn = writes[1]!;
    expect(burn.address).toBe(BASE_SEPOLIA.tokenMessenger);
    expect(burn.functionName).toBe('depositForBurnWithHook');
    const [amount, domain, mintRecipient, burnToken, destinationCaller, fee, finality, hookData] =
      burn.args;
    expect({ amount, domain, mintRecipient, burnToken, destinationCaller, fee, finality }).toEqual({
      amount: total,
      domain: 26,
      mintRecipient: addressToBytes32(vault),
      burnToken: BASE_SEPOLIA.usdc,
      destinationCaller: addressToBytes32(relay),
      fee: maxFee,
      finality: 1000,
    });
    expect(decodeHookData(hookData as Hex)).toEqual({
      version: 1,
      merchant: request.merchant,
      orderId: request.orderId,
    });

    expect(relayer.submit).toHaveBeenCalledWith(
      { burnTxHash: txHash(2), sourceDomain: 6 },
      expect.anything(),
    );
    expect(await store.list()).toEqual([]);
  });

  it('persists the pending payment before waiting for the burn receipt', async () => {
    const { session, events } = setup();

    await session.pay(request);

    const burnHash = txHash(2);
    expect(events.indexOf(`store:put:${burnHash}`)).toBeLessThan(
      events.indexOf(`receipt:${burnHash}`),
    );
  });

  it('skips the approval when the allowance already covers the total', async () => {
    const { session, writes } = setup({ allowance: 10n ** 12n });

    await session.pay(request);

    expect(writes.map((w) => w.functionName)).toEqual(['depositForBurnWithHook']);
  });

  it('keeps a pending payment when the relay fails, and resumes it later', async () => {
    const relayFailure = new CauceError('RELAY_FAILED', 'relayer down');
    const { session, store, relayer, states } = setup({
      relayer: { waitForSettlement: vi.fn().mockRejectedValueOnce(relayFailure) },
    });

    await expect(session.pay(request)).rejects.toBe(relayFailure);
    expect(session.getState()).toMatchObject({
      status: 'failed',
      failedDuring: 'attesting',
      recoverable: true,
    });
    const [pending] = await store.list();
    expect(pending).toMatchObject({ burnTxHash: txHash(2), sourceDomain: 6 });

    vi.mocked(relayer.waitForSettlement).mockResolvedValueOnce({
      burnTxHash: txHash(2),
      sourceDomain: 6,
      status: 'settled',
      settlementTxHash,
    });
    const settled = await session.resume(pending!);

    expect(settled).toMatchObject({ status: 'settled', settlementTxHash });
    expect(states.at(-2)?.status).toBe('attesting');
    expect(await store.list()).toEqual([]);
  });

  it('fails without a recoverable payment when the burn reverts', async () => {
    const { session, store } = setup({ reverted: new Set([txHash(2)]) });

    await expect(session.pay(request)).rejects.toMatchObject({ code: 'TX_REVERTED' });
    expect(session.getState()).toMatchObject({
      status: 'failed',
      failedDuring: 'burning',
      recoverable: false,
    });
    expect(await store.list()).toEqual([]);
  });

  it('reports wallet rejections as USER_REJECTED', async () => {
    const { session, store } = setup({ rejectApproval: true });

    await expect(session.pay(request)).rejects.toMatchObject({ code: 'USER_REJECTED' });
    expect(session.getState()).toMatchObject({
      status: 'failed',
      failedDuring: 'approving',
      recoverable: false,
    });
    expect(await store.list()).toEqual([]);
  });

  it('still settles if the pending store fails', async () => {
    const store = createMemoryPendingStore();
    store.put = () => Promise.reject(new Error('quota exceeded'));
    const { session, logger } = setup({ store });

    await expect(session.pay(request)).resolves.toMatchObject({ status: 'settled' });
    expect(logger.warn).toHaveBeenCalledWith(
      'cauce: could not persist pending payment',
      expect.anything(),
    );
  });
});

describe('PaymentSession — direct route', () => {
  it('approves the vault and calls pay() with the same hookData', async () => {
    const { session, writes, relayer, states } = setup({ chainId: arcTestnet.id });

    const settled = await session.pay(request);

    expect(writes.map((w) => [w.address, w.functionName])).toEqual([
      ['0x3600000000000000000000000000000000000000', 'approve'],
      ['0x00000000000000000000000000000000000000AA', 'pay'],
    ]);
    expect(writes[1]!.args[0]).toBe(request.amount);
    expect(decodeHookData(writes[1]!.args[1] as Hex).orderId).toBe('order-42');
    expect(states.map((s) => s.status)).toEqual([
      'approving',
      'approving',
      'paying',
      'paying',
      'settled',
    ]);
    expect(settled.settlementTxHash).toBe(txHash(2));
    expect(relayer.submit).not.toHaveBeenCalled();
  });
});

describe('PaymentSession — without a wallet', () => {
  it('resumes a pending payment with only the relayer', async () => {
    const { store, relayer } = setup();
    const pending = {
      burnTxHash: txHash(2),
      sourceDomain: 6,
      createdAt: 0,
      ctx: {
        request,
        quote: {
          route: 'cctp' as const,
          amount: request.amount,
          maxFee,
          total: request.amount + maxFee,
          minFinalityThreshold: 1000 as const,
        },
        sourceChainId: baseSepolia.id,
        payer,
      },
    };
    await store.put(pending);
    const walletless = createPaymentSession(
      createCauceConfig({
        environment: 'testnet',
        chains: [baseSepolia],
        relayerUrl: 'https://relayer.dev',
        settlement: { vault, relay },
      }),
      { store, relayer },
    );

    await expect(walletless.resume(pending)).resolves.toMatchObject({
      status: 'settled',
      settlementTxHash,
    });
    expect(await store.list()).toEqual([]);
  });

  it('refuses to pay without a wallet', async () => {
    const walletless = createPaymentSession(
      createCauceConfig({
        environment: 'testnet',
        chains: [baseSepolia],
        relayerUrl: 'https://relayer.dev',
        settlement: { vault, relay },
      }),
      {},
    );

    await expect(walletless.pay(request)).rejects.toMatchObject({ code: 'WALLET_NOT_CONNECTED' });
    expect(walletless.getState().status).toBe('idle');
  });
});

describe('PaymentSession — guards', () => {
  it('validates the request before touching the wallet', async () => {
    const { session, walletClient } = setup();

    await expect(session.pay({ ...request, orderId: '' })).rejects.toMatchObject({
      code: 'INVALID_HOOK_DATA',
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('idle');
  });

  it('rejects unsupported chains before any transaction', async () => {
    const { session, walletClient } = setup({ chainId: 1 });

    await expect(session.pay(request)).rejects.toMatchObject({ code: 'UNSUPPORTED_CHAIN' });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it('refuses a second payment while one is in flight', async () => {
    let release!: () => void;
    const { session } = setup({
      relayer: {
        waitForSettlement: vi.fn<RelayerClient['waitForSettlement']>(
          (req) =>
            new Promise((resolve) => {
              release = () => {
                resolve({ ...req, status: 'settled', settlementTxHash });
              };
            }),
        ),
      },
    });

    const first = session.pay(request);
    await vi.waitFor(() => {
      expect(session.getState().status).toBe('attesting');
    });

    await expect(session.pay(request)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    release();
    await expect(first).resolves.toMatchObject({ status: 'settled' });
  });

  it('reset() aborts the payment in flight and returns to idle', async () => {
    const { session, states } = setup({
      relayer: {
        waitForSettlement: vi.fn<RelayerClient['waitForSettlement']>(
          (_req, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => {
                reject(new CauceError('ABORTED', 'aborted'));
              });
            }),
        ),
      },
    });

    const payment = session.pay(request);
    await vi.waitFor(() => {
      expect(session.getState().status).toBe('attesting');
    });
    session.reset();

    await expect(payment).rejects.toMatchObject({ code: 'ABORTED' });
    expect(session.getState()).toEqual({ status: 'idle' });
    expect(states.at(-1)).toEqual({ status: 'idle' });
  });

  it('stops notifying after unsubscribe', async () => {
    const { session } = setup();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();

    await session.pay(request);

    expect(listener).not.toHaveBeenCalled();
  });
});
