import {
  addressToBytes32,
  cauceRelayAbi,
  createCauceConfig,
  encodeCctpMessage,
  encodeHookData,
  type CauceConfig,
  type DecodedCctpMessage,
} from '@cauce/core';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  keccak256,
  parseAbi,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { vi } from 'vitest';
import { createCauceRelayer, type CreateCauceRelayerOptions } from './relayer';
import { createMemoryRelayJobStore, type RelayJobStore } from './store';

export const VAULT: Address = '0x00000000000000000000000000000000000000Aa';
export const RELAY: Address = '0x00000000000000000000000000000000000000bB';
export const TOKEN_MESSENGER: Address = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
export const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
export const PAYER: Address = '0x3333333333333333333333333333333333333333';
export const BURN_TX: Hash = `0x${'b0'.repeat(32)}`;
export const ATTESTATION: Hex = `0x${'aa'.repeat(65)}`;
export const SOURCE_DOMAIN = 6; // Base Sepolia
/** Anvil's first well-known key; test only. */
export const RELAYER_ACCOUNT = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

export function cctpMessage(
  overrides: Partial<DecodedCctpMessage> = {},
  body: Partial<DecodedCctpMessage['body']> = {},
): Hex {
  return encodeCctpMessage({
    version: 1,
    sourceDomain: SOURCE_DOMAIN,
    destinationDomain: 26,
    nonce: keccak256('0x01'),
    sender: addressToBytes32(TOKEN_MESSENGER),
    recipient: addressToBytes32(TOKEN_MESSENGER),
    destinationCaller: addressToBytes32(RELAY),
    minFinalityThreshold: 1000,
    finalityThresholdExecuted: 1000,
    ...overrides,
    body: {
      version: 1,
      burnToken: addressToBytes32('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
      mintRecipient: addressToBytes32(VAULT),
      amount: 25_004_501n,
      messageSender: addressToBytes32(PAYER),
      maxFee: 4_501n,
      feeExecuted: 3_251n,
      expirationBlock: 0n,
      hookData: encodeHookData({ merchant: MERCHANT, orderId: 'order-42' }),
      ...body,
    },
  });
}

export type IrisReply = { status: number; body?: unknown } | 'network-error';

export function irisComplete(message: Hex): IrisReply {
  return {
    status: 200,
    body: {
      messages: [
        { message, attestation: ATTESTATION, status: 'complete', eventNonce: '1', cctpVersion: 2 },
      ],
    },
  };
}

export const irisPending: IrisReply = {
  status: 200,
  body: {
    messages: [
      {
        message: null,
        attestation: 'PENDING',
        status: 'pending_confirmations',
        eventNonce: '1',
        cctpVersion: 2,
      },
    ],
  },
};

export const irisNotFound: IrisReply = { status: 404, body: { error: 'not found' } };

/** A fake settlement chain: transactions are mined when `mine()` is called. */
export function fakeChain() {
  const sent: { args: readonly unknown[]; hash: Hash }[] = [];
  const mined = new Map<Hash, 'success' | 'reverted'>();
  const dropped = new Set<Hash>();
  let usedNonce = 0n;
  let simulateError: Error | undefined;
  let relayedLog: { blockRange: [bigint, bigint]; transactionHash: Hash } | undefined;

  const publicClient = {
    readContract: vi.fn(() => Promise.resolve(usedNonce)),
    simulateContract: vi.fn((call: { args: readonly unknown[] }) => {
      if (simulateError) return Promise.reject(simulateError);
      return Promise.resolve({
        request: { ...call, address: RELAY, functionName: 'relayPayment' },
      });
    }),
    getTransactionReceipt: vi.fn(({ hash }: { hash: Hash }) => {
      const status = mined.get(hash);
      return status
        ? Promise.resolve({ status, transactionHash: hash })
        : Promise.reject(new TransactionReceiptNotFoundError({ hash }));
    }),
    getTransaction: vi.fn(({ hash }: { hash: Hash }) =>
      dropped.has(hash)
        ? Promise.reject(new TransactionNotFoundError({ hash }))
        : Promise.resolve({ hash }),
    ),
    getBlockNumber: vi.fn(() => Promise.resolve(250_000n)),
    getContractEvents: vi.fn(({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (!relayedLog) return Promise.resolve([]);
      const [from, to] = relayedLog.blockRange;
      const overlaps = from <= toBlock && to >= fromBlock;
      return Promise.resolve(overlaps ? [{ transactionHash: relayedLog.transactionHash }] : []);
    }),
  } as unknown as PublicClient;

  const walletClient = {
    writeContract: vi.fn((request: { args: readonly unknown[] }) => {
      const hash: Hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`;
      sent.push({ args: request.args, hash });
      return Promise.resolve(hash);
    }),
  } as unknown as WalletClient<Transport, Chain, Account>;

  return {
    publicClient,
    walletClient,
    sent,
    mine: (hash: Hash, status: 'success' | 'reverted' = 'success') => mined.set(hash, status),
    drop: (hash: Hash) => dropped.add(hash),
    setNonceUsed: () => {
      usedNonce = 1n;
    },
    setSimulateError: (error: Error | undefined) => {
      simulateError = error;
    },
    setRelayedLog: (log: typeof relayedLog) => {
      relayedLog = log;
    },
  };
}

/** A revert as viem reports it from simulateContract, for a custom error or a reason string. */
export function relayRevert(
  revert: { errorName: string; args?: readonly unknown[] } | { reason: string },
) {
  const abi = parseAbi([
    'error CauceRelay__WrongMintRecipient(bytes32 mintRecipient)',
    'error Error(string)',
  ]);
  const data =
    'reason' in revert
      ? encodeErrorResult({ abi, errorName: 'Error', args: [revert.reason] })
      : encodeErrorResult({
          abi,
          errorName: revert.errorName as 'CauceRelay__WrongMintRecipient',
          args: revert.args as [Hex],
        });
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: 'relayPayment' });
  return new ContractFunctionExecutionError(cause, {
    abi: cauceRelayAbi,
    functionName: 'relayPayment',
    args: [],
    contractAddress: RELAY,
  });
}

export function testConfig(iris: IrisReply[]): {
  config: CauceConfig;
  irisFetch: ReturnType<typeof vi.fn<typeof fetch>>;
} {
  const irisFetch = vi.fn<typeof fetch>(() => {
    // Replies are consumed in order; the last one repeats.
    const reply = iris.length > 1 ? iris.shift() : iris[0];
    if (!reply) return Promise.reject(new Error('No Iris reply configured'));
    if (reply === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(Response.json(reply.body ?? {}, { status: reply.status }));
  });
  const config = createCauceConfig({
    environment: 'testnet',
    chains: [baseSepolia],
    relayerUrl: 'https://shop.dev/api/cauce',
    settlement: { vault: VAULT, relay: RELAY },
    iris: {
      fetch: irisFetch,
      retry: { retries: 0, minDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false },
    },
  });
  return { config, irisFetch };
}

export function testRelayer(
  iris: IrisReply[],
  options: Partial<CreateCauceRelayerOptions> & { store?: RelayJobStore } = {},
) {
  const chain = fakeChain();
  const { config, irisFetch } = testConfig(iris);
  let clock = 1_000_000;
  const store = options.store ?? createMemoryRelayJobStore();
  const relayer = createCauceRelayer({
    config,
    account: RELAYER_ACCOUNT,
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    store,
    now: () => clock,
    ...options,
  });
  return {
    relayer,
    chain,
    store,
    irisFetch,
    config,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
}
