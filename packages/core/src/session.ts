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
import { cauceVaultAbi, erc20Abi, tokenMessengerV2Abi } from './abis';
import { addressToBytes32 } from './cctp-message';
import type { CauceConfig } from './config';
import { CauceError, toCauceError } from './errors';
import { quotePayment } from './fees';
import { encodeHookData } from './hook-data';
import {
  initialPaymentState,
  isInFlight,
  transition,
  type CaucePaymentEvent,
  type CaucePaymentState,
  type SettledPaymentState,
} from './machine';
import { createRelayerClient, type RelayerClient } from './relayer-client';
import { abortedError } from './retry';
import type { PendingPaymentStore } from './store';
import type { CaucePaymentRequest, PaymentContext, PendingPayment } from './types';

export interface PaymentSessionDeps {
  /**
   * The payer's wallet. Cauce never holds keys: every transaction is signed here. Only needed
   * to pay: resuming a pending payment works without a wallet.
   */
  walletClient?: WalletClient<Transport, Chain, Account>;
  /** A client for the chain the wallet is connected to. Required together with walletClient. */
  publicClient?: PublicClient;
  /** Where burned-but-unsettled payments are kept so they can be resumed. */
  store?: PendingPaymentStore;
  relayer?: RelayerClient;
  /** Relayer polling, mostly for tests. */
  relayPollIntervalMs?: number;
}

interface Clients {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
}

export interface PaymentOperationOptions {
  signal?: AbortSignal;
}

export interface CaucePaymentSession {
  getState(): CaucePaymentState;
  /** Subscribes to state changes; compatible with React's useSyncExternalStore. */
  subscribe(listener: (state: CaucePaymentState) => void): () => void;
  pay(
    request: CaucePaymentRequest,
    options?: PaymentOperationOptions,
  ): Promise<SettledPaymentState>;
  /** Settles a payment that was burned earlier (e.g. before the tab was closed). */
  resume(pending: PendingPayment, options?: PaymentOperationOptions): Promise<SettledPaymentState>;
  /** Aborts any operation in flight and returns to idle. */
  reset(): void;
}

export function createPaymentSession(
  config: CauceConfig,
  deps: PaymentSessionDeps,
): CaucePaymentSession {
  const { store } = deps;
  const relayer = deps.relayer ?? createRelayerClient(config);
  const listeners = new Set<(state: CaucePaymentState) => void>();
  let state = initialPaymentState;
  let operation: AbortController | undefined;

  function dispatch(event: CaucePaymentEvent, signal: AbortSignal): void {
    if (signal.aborted) throw abortedError(signal);
    state = transition(state, event);
    config.logger.debug('cauce: payment state', { status: state.status, event: event.type });
    for (const listener of listeners) listener(state);
  }

  /** Runs one pay/resume operation; reset() or the caller's signal abort it. */
  async function run(
    external: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<SettledPaymentState>,
  ): Promise<SettledPaymentState> {
    if (isInFlight(state)) {
      throw new CauceError('INVALID_TRANSITION', `A payment is already ${state.status}`);
    }
    const controller = new AbortController();
    operation = controller;
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;

    try {
      return await body(signal);
    } catch (error) {
      const cauceError = toCauceError(error, 'TX_REVERTED');
      // A reset() already moved the session on; only the current operation may fail it.
      if (operation === controller && isInFlight(state)) {
        state = transition(state, { type: 'FAIL', error: cauceError });
        for (const listener of listeners) listener(state);
      }
      throw cauceError;
    } finally {
      if (operation === controller) operation = undefined;
    }
  }

  async function confirm({ publicClient }: Clients, hash: Hash): Promise<void> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new CauceError('TX_REVERTED', `Transaction ${hash} reverted`, { details: { hash } });
    }
  }

  async function ensureAllowance(
    clients: Clients,
    token: Address,
    spender: Address,
    amount: bigint,
    signal: AbortSignal,
  ): Promise<void> {
    const { walletClient, publicClient } = clients;
    const owner = walletClient.account.address;
    const allowance = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    });
    if (allowance < amount) {
      const hash = await walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
      });
      dispatch({ type: 'APPROVE_SUBMITTED', txHash: hash }, signal);
      await confirm(clients, hash);
    }
    dispatch({ type: 'APPROVED' }, signal);
  }

  async function settle(
    pending: PendingPayment,
    signal: AbortSignal,
  ): Promise<SettledPaymentState> {
    const request = { burnTxHash: pending.burnTxHash, sourceDomain: pending.sourceDomain };
    await relayer.submit(request, { signal });
    const result = await relayer.waitForSettlement(request, {
      signal,
      ...(deps.relayPollIntervalMs ? { pollIntervalMs: deps.relayPollIntervalMs } : {}),
      onStatus: ({ status }) => {
        if (status === 'relaying' && state.status === 'attesting') {
          dispatch({ type: 'ATTESTED' }, signal);
        }
      },
    });
    dispatch({ type: 'SETTLED', txHash: result.settlementTxHash }, signal);
    await forget(pending.burnTxHash);
    return state as SettledPaymentState;
  }

  async function remember(pending: PendingPayment): Promise<void> {
    try {
      await store?.put(pending);
    } catch (error) {
      config.logger.warn('cauce: could not persist pending payment', {
        burnTxHash: pending.burnTxHash,
        error: String(error),
      });
    }
  }

  async function forget(burnTxHash: Hash): Promise<void> {
    try {
      await store?.remove(burnTxHash);
    } catch (error) {
      config.logger.warn('cauce: could not remove settled payment', {
        burnTxHash,
        error: String(error),
      });
    }
  }

  async function payDirect(
    clients: Clients,
    ctx: PaymentContext,
    hookData: Hex,
    signal: AbortSignal,
  ) {
    const { vault, usdc } = config.settlement;
    await ensureAllowance(clients, usdc, vault, ctx.quote.total, signal);

    const hash = await clients.walletClient.writeContract({
      address: vault,
      abi: cauceVaultAbi,
      functionName: 'pay',
      args: [ctx.quote.total, hookData],
    });
    dispatch({ type: 'PAY_SUBMITTED', txHash: hash }, signal);
    await confirm(clients, hash);
    dispatch({ type: 'SETTLED', txHash: hash }, signal);
    return state as SettledPaymentState;
  }

  async function payCctp(
    clients: Clients,
    ctx: PaymentContext,
    hookData: Hex,
    signal: AbortSignal,
  ) {
    const source = config.getSourceChain(ctx.sourceChainId);
    const { domain, vault, relay } = config.settlement;
    await ensureAllowance(clients, source.usdc, source.tokenMessenger, ctx.quote.total, signal);

    const burnTxHash = await clients.walletClient.writeContract({
      address: source.tokenMessenger,
      abi: tokenMessengerV2Abi,
      functionName: 'depositForBurnWithHook',
      args: [
        ctx.quote.total,
        domain,
        addressToBytes32(vault),
        source.usdc,
        // Only CauceRelay may receive the message, so nobody can mint to the vault without
        // crediting the merchant.
        addressToBytes32(relay),
        ctx.quote.maxFee,
        ctx.quote.minFinalityThreshold,
        hookData,
      ],
    });
    dispatch({ type: 'BURN_SUBMITTED', txHash: burnTxHash }, signal);

    const pending: PendingPayment = {
      burnTxHash,
      sourceDomain: source.domain,
      ctx,
      createdAt: Date.now(),
    };
    await remember(pending);
    try {
      await confirm(clients, burnTxHash);
    } catch (error) {
      if (error instanceof CauceError && error.code === 'TX_REVERTED') await forget(burnTxHash);
      throw error;
    }
    dispatch({ type: 'BURN_CONFIRMED' }, signal);
    return settle(pending, signal);
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    pay(request, { signal } = {}) {
      return run(signal, async (signal) => {
        const hookData = encodeHookData(request);
        const { walletClient, publicClient } = deps;
        if (!walletClient || !publicClient) {
          throw new CauceError('WALLET_NOT_CONNECTED', 'Connect a wallet to pay');
        }
        const clients: Clients = { walletClient, publicClient };
        const sourceChainId = await walletClient.getChainId();
        if (publicClient.chain && publicClient.chain.id !== sourceChainId) {
          throw new CauceError(
            'INVALID_CONFIG',
            `publicClient is for chain ${publicClient.chain.id} but the wallet is on ${sourceChainId}`,
          );
        }
        const quote = await quotePayment(config, { amount: request.amount, sourceChainId, signal });
        const ctx: PaymentContext = {
          request,
          quote,
          sourceChainId,
          payer: walletClient.account.address,
        };

        dispatch({ type: 'START', ctx }, signal);
        return quote.route === 'direct'
          ? payDirect(clients, ctx, hookData, signal)
          : payCctp(clients, ctx, hookData, signal);
      });
    },

    resume(pending, { signal } = {}) {
      return run(signal, (signal) => {
        dispatch({ type: 'RESUME', pending }, signal);
        return settle(pending, signal);
      });
    },

    reset() {
      operation?.abort();
      operation = undefined;
      state = transition(state, { type: 'RESET' });
      for (const listener of listeners) listener(state);
    },
  };
}
