import type { Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import { CauceError } from './errors';
import {
  getPaymentSteps,
  initialPaymentState,
  isInFlight,
  isTerminal,
  transition,
  type CaucePaymentEvent,
  type CaucePaymentState,
} from './machine';
import type { PaymentContext, PendingPayment } from './types';

const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}`;

const cctp: PaymentContext = {
  request: {
    merchant: '0x1111111111111111111111111111111111111111',
    orderId: 'order-1',
    amount: 1_000_000n,
  },
  quote: {
    route: 'cctp',
    amount: 1_000_000n,
    maxFee: 150n,
    total: 1_000_150n,
    minFinalityThreshold: 1000,
  },
  sourceChainId: 84532,
  payer: '0x3333333333333333333333333333333333333333',
};
const direct: PaymentContext = {
  ...cctp,
  quote: {
    route: 'direct',
    amount: 1_000_000n,
    maxFee: 0n,
    total: 1_000_000n,
    minFinalityThreshold: 2000,
  },
  sourceChainId: 5042002,
};
const pending: PendingPayment = { burnTxHash: hash(2), sourceDomain: 6, ctx: cctp, createdAt: 0 };
const error = new CauceError('TX_REVERTED', 'boom');

function run(state: CaucePaymentState, ...events: CaucePaymentEvent[]): CaucePaymentState {
  return events.reduce(transition, state);
}

describe('happy paths', () => {
  it('cctp: idle → approving → burning → attesting → relaying → settled', () => {
    const statuses: string[] = [];
    let state = initialPaymentState;
    for (const event of [
      { type: 'START', ctx: cctp },
      { type: 'APPROVE_SUBMITTED', txHash: hash(1) },
      { type: 'APPROVED' },
      { type: 'BURN_SUBMITTED', txHash: hash(2) },
      { type: 'BURN_CONFIRMED' },
      { type: 'ATTESTED' },
      { type: 'SETTLED', txHash: hash(3) },
    ] satisfies CaucePaymentEvent[]) {
      state = transition(state, event);
      statuses.push(state.status);
    }

    expect(statuses).toEqual([
      'approving',
      'approving',
      'burning',
      'burning',
      'attesting',
      'relaying',
      'settled',
    ]);
    expect(state).toEqual({
      status: 'settled',
      ctx: cctp,
      burnTxHash: hash(2),
      settlementTxHash: hash(3),
    });
  });

  it('direct: idle → approving → paying → settled', () => {
    const state = run(
      initialPaymentState,
      { type: 'START', ctx: direct },
      { type: 'APPROVED' },
      { type: 'PAY_SUBMITTED', txHash: hash(9) },
      { type: 'SETTLED', txHash: hash(9) },
    );
    expect(state).toEqual({ status: 'settled', ctx: direct, settlementTxHash: hash(9) });
  });

  it('skips the approval transaction when the allowance is enough', () => {
    const state = run(initialPaymentState, { type: 'START', ctx: cctp }, { type: 'APPROVED' });
    expect(state).toEqual({ status: 'burning', ctx: cctp });
  });

  it('accepts settlement reported while still attesting', () => {
    const state = run(
      { status: 'attesting', ctx: cctp, burnTxHash: hash(2) },
      { type: 'SETTLED', txHash: hash(3) },
    );
    expect(state.status).toBe('settled');
  });
});

describe('failures and recovery', () => {
  it('is not recoverable before the burn', () => {
    const state = run(initialPaymentState, { type: 'START', ctx: cctp }, { type: 'FAIL', error });
    expect(state).toEqual({
      status: 'failed',
      ctx: cctp,
      error,
      failedDuring: 'approving',
      recoverable: false,
    });
  });

  it('is recoverable once the burn transaction exists', () => {
    const state = run(
      { status: 'burning', ctx: cctp, burnTxHash: hash(2) },
      { type: 'FAIL', error },
    );
    expect(state).toMatchObject({
      failedDuring: 'burning',
      burnTxHash: hash(2),
      recoverable: true,
    });
  });

  it('resumes a pending payment into attesting, from idle or failed', () => {
    const expected = { status: 'attesting', ctx: cctp, burnTxHash: hash(2) };
    expect(transition(initialPaymentState, { type: 'RESUME', pending })).toEqual(expected);

    const failed = run(
      { status: 'relaying', ctx: cctp, burnTxHash: hash(2) },
      { type: 'FAIL', error },
    );
    expect(transition(failed, { type: 'RESUME', pending })).toEqual(expected);
  });

  it('cannot resume a direct payment', () => {
    expect(() =>
      transition(initialPaymentState, { type: 'RESUME', pending: { ...pending, ctx: direct } }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  });
});

describe('transition table', () => {
  const states: Record<string, CaucePaymentState> = {
    idle: initialPaymentState,
    approving: { status: 'approving', ctx: cctp },
    'approving+tx': { status: 'approving', ctx: cctp, approveTxHash: hash(1) },
    burning: { status: 'burning', ctx: cctp },
    'burning+tx': { status: 'burning', ctx: cctp, burnTxHash: hash(2) },
    paying: { status: 'paying', ctx: direct },
    'paying+tx': { status: 'paying', ctx: direct, payTxHash: hash(9) },
    attesting: { status: 'attesting', ctx: cctp, burnTxHash: hash(2) },
    relaying: { status: 'relaying', ctx: cctp, burnTxHash: hash(2) },
    settled: { status: 'settled', ctx: cctp, burnTxHash: hash(2), settlementTxHash: hash(3) },
    failed: { status: 'failed', ctx: cctp, error, failedDuring: 'approving', recoverable: false },
  };
  const events: Record<string, CaucePaymentEvent> = {
    START: { type: 'START', ctx: cctp },
    APPROVE_SUBMITTED: { type: 'APPROVE_SUBMITTED', txHash: hash(1) },
    APPROVED: { type: 'APPROVED' },
    BURN_SUBMITTED: { type: 'BURN_SUBMITTED', txHash: hash(2) },
    BURN_CONFIRMED: { type: 'BURN_CONFIRMED' },
    PAY_SUBMITTED: { type: 'PAY_SUBMITTED', txHash: hash(9) },
    ATTESTED: { type: 'ATTESTED' },
    SETTLED: { type: 'SETTLED', txHash: hash(9) },
    RESUME: { type: 'RESUME', pending },
    FAIL: { type: 'FAIL', error },
    RESET: { type: 'RESET' },
  };
  // Every valid (state, event) pair and the resulting status. Everything else must throw.
  const valid: Record<string, Partial<Record<string, CaucePaymentState['status']>>> = {
    idle: { START: 'approving', RESUME: 'attesting', RESET: 'idle' },
    approving: {
      APPROVE_SUBMITTED: 'approving',
      APPROVED: 'burning',
      FAIL: 'failed',
      RESET: 'idle',
    },
    'approving+tx': { APPROVED: 'burning', FAIL: 'failed', RESET: 'idle' },
    burning: { BURN_SUBMITTED: 'burning', FAIL: 'failed', RESET: 'idle' },
    'burning+tx': { BURN_CONFIRMED: 'attesting', FAIL: 'failed', RESET: 'idle' },
    paying: { PAY_SUBMITTED: 'paying', FAIL: 'failed', RESET: 'idle' },
    'paying+tx': { SETTLED: 'settled', FAIL: 'failed', RESET: 'idle' },
    attesting: { ATTESTED: 'relaying', SETTLED: 'settled', FAIL: 'failed', RESET: 'idle' },
    relaying: { SETTLED: 'settled', FAIL: 'failed', RESET: 'idle' },
    settled: { START: 'approving', RESET: 'idle' },
    failed: { START: 'approving', RESUME: 'attesting', RESET: 'idle' },
  };

  const cases = Object.keys(states).flatMap((stateName) =>
    Object.keys(events).map((eventName) => [stateName, eventName] as const),
  );

  it.each(cases)('%s + %s', (stateName, eventName) => {
    const state = states[stateName]!;
    const event = events[eventName]!;
    const expected = valid[stateName]?.[eventName];

    if (expected) {
      expect(transition(state, event).status).toBe(expected);
    } else {
      expect(() => transition(state, event)).toThrow(
        expect.objectContaining({
          code: 'INVALID_TRANSITION',
          details: { from: state.status, event: event.type },
        }),
      );
    }
  });

  it('never mutates the previous state', () => {
    for (const [stateName, eventName] of cases) {
      const state = structuredClone(states[stateName]!);
      const snapshot = structuredClone(state);
      try {
        transition(state, events[eventName]!);
      } catch {
        // invalid transitions are covered above
      }
      expect(state).toEqual(snapshot);
    }
  });
});

describe('predicates', () => {
  it('classifies states', () => {
    expect(isTerminal(initialPaymentState)).toBe(false);
    expect(isInFlight(initialPaymentState)).toBe(false);
    expect(isInFlight({ status: 'relaying', ctx: cctp, burnTxHash: hash(2) })).toBe(true);
    expect(isTerminal({ status: 'settled', ctx: cctp, settlementTxHash: hash(3) })).toBe(true);
  });
});

describe('getPaymentSteps', () => {
  const states = (s: CaucePaymentState) => getPaymentSteps(s).map((step) => step.state);

  it.each<[string, CaucePaymentState, string[]]>([
    ['idle', initialPaymentState, ['pending', 'pending', 'pending']],
    ['approving', { status: 'approving', ctx: cctp }, ['active', 'pending', 'pending']],
    ['burning', { status: 'burning', ctx: cctp }, ['done', 'active', 'pending']],
    ['paying', { status: 'paying', ctx: direct }, ['done', 'active', 'pending']],
    [
      'attesting',
      { status: 'attesting', ctx: cctp, burnTxHash: hash(2) },
      ['done', 'done', 'active'],
    ],
    [
      'relaying',
      { status: 'relaying', ctx: cctp, burnTxHash: hash(2) },
      ['done', 'done', 'active'],
    ],
    [
      'settled',
      { status: 'settled', ctx: cctp, settlementTxHash: hash(3) },
      ['done', 'done', 'done'],
    ],
    [
      'failed while burning',
      { status: 'failed', ctx: cctp, error, failedDuring: 'burning', recoverable: false },
      ['done', 'error', 'pending'],
    ],
  ])('%s', (_name, state, expected) => {
    expect(states(state)).toEqual(expected);
    expect(getPaymentSteps(state).map((step) => step.id)).toEqual([
      'approve',
      'transfer',
      'settle',
    ]);
  });
});
