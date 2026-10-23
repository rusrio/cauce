import {
  CauceError,
  createPaymentSession,
  getPaymentSteps,
  initialPaymentState,
  isInFlight,
  isTerminal,
  toCauceError,
  type CaucePaymentRequest,
  type CaucePaymentSession,
  type CaucePaymentState,
  type CaucePaymentStatus,
  type PaymentRoute,
  type PaymentStep,
  type PendingPayment,
  type SettledPaymentState,
} from '@cauce/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useConfig, useConnection } from 'wagmi';
import { getPublicClient, getWalletClient } from 'wagmi/actions';
import { useCauceContext } from './context';

export type CauceRoute = PaymentRoute | 'unsupported' | 'disconnected';

export interface UseCaucePaymentOptions {
  onStateChange?: (state: CaucePaymentState) => void;
  onSettled?: (state: SettledPaymentState) => void;
  onError?: (error: CauceError) => void;
}

export interface UseCaucePaymentResult {
  state: CaucePaymentState;
  status: CaucePaymentStatus;
  steps: PaymentStep[];
  /** How the connected wallet would pay: `cctp`, `direct`, or why it cannot. */
  route: CauceRoute;
  /** True while a payment is in flight. */
  isBusy: boolean;
  error: CauceError | undefined;
  /** Starts a payment with the connected wallet. Never rejects: watch `state` or `onError`. */
  pay: (request: CaucePaymentRequest) => Promise<void>;
  /** Settles a payment burned earlier (e.g. before the tab closed). No wallet needed. */
  resume: (pending: PendingPayment) => Promise<void>;
  reset: () => void;
}

const noopSubscribe = () => () => undefined;
const idle = () => initialPaymentState;

/** Runs Cauce payments with the wallet connected through wagmi. */
export function useCaucePayment(options: UseCaucePaymentOptions = {}): UseCaucePaymentResult {
  const { config, pendingStore, notifyPendingChanged } = useCauceContext();
  const wagmiConfig = useConfig();
  const connection = useConnection();
  const [session, setSession] = useState<CaucePaymentSession | null>(null);
  // Errors raised before a payment starts (no wallet, invalid request…) never reach the machine.
  const [preflightError, setPreflightError] = useState<CauceError>();
  const callbacks = useRef(options);
  callbacks.current = options;

  const state = useSyncExternalStore(
    session ? session.subscribe : noopSubscribe,
    session ? session.getState : idle,
    session ? session.getState : idle,
  );

  useEffect(() => {
    if (state === initialPaymentState) return;
    callbacks.current.onStateChange?.(state);
    if (state.status === 'settled') callbacks.current.onSettled?.(state);
    if (state.status === 'failed') callbacks.current.onError?.(state.error);
  }, [state]);

  const route: CauceRoute =
    connection.status !== 'connected'
      ? 'disconnected'
      : (config.getRoute(connection.chainId) ?? 'unsupported');

  /** Starts a fresh session, unless a payment is already in flight. */
  const run = useCallback(
    async (
      create: () => Promise<CaucePaymentSession>,
      operation: (session: CaucePaymentSession) => Promise<unknown>,
    ) => {
      const preflightFailed = (error: CauceError) => {
        setPreflightError(error);
        callbacks.current.onError?.(error);
      };
      if (session && isInFlight(session.getState())) {
        preflightFailed(new CauceError('INVALID_TRANSITION', 'A payment is already in progress'));
        return;
      }
      setPreflightError(undefined);
      session?.reset(); // clear a finished payment so its result is not shown for the new one
      let next: CaucePaymentSession;
      try {
        next = await create();
      } catch (error) {
        preflightFailed(toCauceError(error, 'WALLET_NOT_CONNECTED'));
        return;
      }
      setSession(next);
      // Lists of pending payments re-read the store once the burn is saved and once it settles.
      const unsubscribe = next.subscribe((s) => {
        if (s.status === 'attesting' || isTerminal(s)) notifyPendingChanged();
      });
      try {
        await operation(next);
      } catch (error) {
        // The failure is already in the session state; report errors raised before it started.
        if (next.getState().status === 'idle') preflightFailed(toCauceError(error, 'TX_REVERTED'));
      } finally {
        unsubscribe();
      }
    },
    [session, notifyPendingChanged],
  );

  const pay = useCallback(
    (request: CaucePaymentRequest) =>
      run(
        async () => {
          const walletClient = await getWalletClient(wagmiConfig);
          const publicClient = getPublicClient(wagmiConfig, { chainId: walletClient.chain.id });
          if (!publicClient) {
            throw new CauceError(
              'UNSUPPORTED_CHAIN',
              `Chain ${walletClient.chain.id} is not in the wagmi config`,
            );
          }
          return createPaymentSession(config, { walletClient, publicClient, store: pendingStore });
        },
        (s) => s.pay(request),
      ),
    [run, wagmiConfig, config, pendingStore],
  );

  const resume = useCallback(
    (pending: PendingPayment) =>
      run(
        () => Promise.resolve(createPaymentSession(config, { store: pendingStore })),
        (s) => s.resume(pending),
      ),
    [run, config, pendingStore],
  );

  const reset = useCallback(() => {
    setPreflightError(undefined);
    session?.reset();
  }, [session]);

  const steps = useMemo(() => getPaymentSteps(state), [state]);

  return {
    state,
    status: state.status,
    steps,
    route,
    isBusy: isInFlight(state),
    error: state.status === 'failed' ? state.error : preflightError,
    pay,
    resume,
    reset,
  };
}
