import type { Hash } from 'viem';
import { CauceError } from './errors';
import type { PaymentContext, PendingPayment } from './types';

/**
 * Payment lifecycle.
 *
 *   cctp:   idle → approving → burning → attesting → relaying → settled
 *   direct: idle → approving → paying → settled
 *
 * Any in-flight state can move to `failed`. `RESET` returns to `idle` from anywhere, and a
 * burned-but-unsettled payment can be picked up again with `RESUME`.
 */
export type CaucePaymentStatus =
  'idle' | 'approving' | 'burning' | 'paying' | 'attesting' | 'relaying' | 'settled' | 'failed';

export type InFlightStatus = Exclude<CaucePaymentStatus, 'idle' | 'settled' | 'failed'>;

export type CaucePaymentState =
  | { status: 'idle' }
  | { status: 'approving'; ctx: PaymentContext; approveTxHash?: Hash }
  | { status: 'burning'; ctx: PaymentContext; burnTxHash?: Hash }
  | { status: 'paying'; ctx: PaymentContext; payTxHash?: Hash }
  | { status: 'attesting'; ctx: PaymentContext; burnTxHash: Hash }
  | { status: 'relaying'; ctx: PaymentContext; burnTxHash: Hash }
  | { status: 'settled'; ctx: PaymentContext; burnTxHash?: Hash; settlementTxHash: Hash }
  | {
      status: 'failed';
      ctx?: PaymentContext;
      burnTxHash?: Hash;
      error: CauceError;
      failedDuring: InFlightStatus;
      /** True once USDC has been burned: the payment can still be settled with `RESUME`. */
      recoverable: boolean;
    };

export type SettledPaymentState = Extract<CaucePaymentState, { status: 'settled' }>;
export type FailedPaymentState = Extract<CaucePaymentState, { status: 'failed' }>;

export type CaucePaymentEvent =
  | { type: 'START'; ctx: PaymentContext }
  | { type: 'APPROVE_SUBMITTED'; txHash: Hash }
  /** Allowance is in place (approved now or already sufficient). */
  | { type: 'APPROVED' }
  | { type: 'BURN_SUBMITTED'; txHash: Hash }
  | { type: 'BURN_CONFIRMED' }
  | { type: 'PAY_SUBMITTED'; txHash: Hash }
  | { type: 'ATTESTED' }
  | { type: 'SETTLED'; txHash: Hash }
  | { type: 'RESUME'; pending: PendingPayment }
  | { type: 'FAIL'; error: CauceError }
  | { type: 'RESET' };

export const initialPaymentState: CaucePaymentState = Object.freeze({ status: 'idle' });

/**
 * Pure transition function. Throws `INVALID_TRANSITION` for events that make no sense in the
 * current state instead of silently ignoring them.
 */
export function transition(state: CaucePaymentState, event: CaucePaymentEvent): CaucePaymentState {
  switch (event.type) {
    case 'RESET':
      return initialPaymentState;

    case 'START':
      if (state.status === 'idle' || isTerminal(state)) {
        return { status: 'approving', ctx: event.ctx };
      }
      break;

    case 'RESUME':
      if (state.status === 'idle' || state.status === 'failed') {
        if (event.pending.ctx.quote.route !== 'cctp') break;
        return {
          status: 'attesting',
          ctx: event.pending.ctx,
          burnTxHash: event.pending.burnTxHash,
        };
      }
      break;

    case 'APPROVE_SUBMITTED':
      if (state.status === 'approving' && state.approveTxHash === undefined) {
        return { ...state, approveTxHash: event.txHash };
      }
      break;

    case 'APPROVED':
      if (state.status === 'approving') {
        return state.ctx.quote.route === 'cctp'
          ? { status: 'burning', ctx: state.ctx }
          : { status: 'paying', ctx: state.ctx };
      }
      break;

    case 'BURN_SUBMITTED':
      if (state.status === 'burning' && state.burnTxHash === undefined) {
        return { ...state, burnTxHash: event.txHash };
      }
      break;

    case 'BURN_CONFIRMED':
      if (state.status === 'burning' && state.burnTxHash !== undefined) {
        return { status: 'attesting', ctx: state.ctx, burnTxHash: state.burnTxHash };
      }
      break;

    case 'PAY_SUBMITTED':
      if (state.status === 'paying' && state.payTxHash === undefined) {
        return { ...state, payTxHash: event.txHash };
      }
      break;

    case 'ATTESTED':
      if (state.status === 'attesting') {
        return { status: 'relaying', ctx: state.ctx, burnTxHash: state.burnTxHash };
      }
      break;

    case 'SETTLED':
      // The relayer may report settlement before Cauce observed the attestation.
      if (state.status === 'attesting' || state.status === 'relaying') {
        return {
          status: 'settled',
          ctx: state.ctx,
          burnTxHash: state.burnTxHash,
          settlementTxHash: event.txHash,
        };
      }
      if (state.status === 'paying' && state.payTxHash === event.txHash) {
        return { status: 'settled', ctx: state.ctx, settlementTxHash: event.txHash };
      }
      break;

    case 'FAIL':
      if (isInFlight(state)) {
        const burnTxHash = 'burnTxHash' in state ? state.burnTxHash : undefined;
        return {
          status: 'failed',
          ctx: state.ctx,
          ...(burnTxHash ? { burnTxHash } : {}),
          error: event.error,
          failedDuring: state.status,
          recoverable: burnTxHash !== undefined,
        };
      }
      break;
  }

  throw new CauceError(
    'INVALID_TRANSITION',
    `Cannot apply ${event.type} while the payment is ${state.status}`,
    { details: { from: state.status, event: event.type } },
  );
}

export function isTerminal(
  state: CaucePaymentState,
): state is SettledPaymentState | FailedPaymentState {
  return state.status === 'settled' || state.status === 'failed';
}

export function isInFlight(
  state: CaucePaymentState,
): state is Extract<CaucePaymentState, { status: InFlightStatus }> {
  return state.status !== 'idle' && !isTerminal(state);
}

export type PaymentStepId = 'approve' | 'transfer' | 'settle';
export type PaymentStepState = 'pending' | 'active' | 'done' | 'error';

export interface PaymentStep {
  id: PaymentStepId;
  state: PaymentStepState;
}

const STEP_ORDER: readonly PaymentStepId[] = ['approve', 'transfer', 'settle'];

const STEP_OF: Readonly<Record<InFlightStatus, PaymentStepId>> = {
  approving: 'approve',
  burning: 'transfer',
  paying: 'transfer',
  attesting: 'settle',
  relaying: 'settle',
};

/** Progress for a stepper UI, derived from the state alone (no string matching). */
export function getPaymentSteps(state: CaucePaymentState): PaymentStep[] {
  const steps = (current: number, currentState: PaymentStepState): PaymentStep[] =>
    STEP_ORDER.map((id, index) => ({
      id,
      state: index < current ? 'done' : index === current ? currentState : 'pending',
    }));

  switch (state.status) {
    case 'idle':
      return steps(-1, 'pending');
    case 'settled':
      return steps(STEP_ORDER.length, 'done');
    case 'failed':
      return steps(STEP_ORDER.indexOf(STEP_OF[state.failedDuring]), 'error');
    default:
      return steps(STEP_ORDER.indexOf(STEP_OF[state.status]), 'active');
  }
}
