import {
  CauceError,
  createCauceConfig,
  getPaymentSteps,
  initialPaymentState,
  type CaucePaymentState,
  type PendingPayment,
} from '@cauce/core';
import type { CauceCheckoutRenderProps } from '@cauce/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Hash } from 'viem';
import { arcTestnet, baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaucePayment } from './cauce-payment';

const config = createCauceConfig({
  environment: 'testnet',
  chains: [baseSepolia],
  relayerUrl: 'https://shop.dev/api/cauce',
  settlement: {
    vault: '0x00000000000000000000000000000000000000Aa',
    relay: '0x00000000000000000000000000000000000000bB',
  },
});

const BURN: Hash = `0x${'b0'.repeat(32)}`;
const SETTLED: Hash = `0x${'5e'.repeat(32)}`;
const ctx = {
  request: {
    merchant: '0x1111111111111111111111111111111111111111' as const,
    orderId: 'o-1',
    amount: 25_000_000n,
  },
  quote: {
    route: 'cctp' as const,
    amount: 25_000_000n,
    maxFee: 3_251n,
    total: 25_003_251n,
    minFinalityThreshold: 1000 as const,
  },
  sourceChainId: baseSepolia.id,
  payer: '0x3333333333333333333333333333333333333333' as const,
};
const pendingPayment: PendingPayment = { burnTxHash: BURN, sourceDomain: 6, createdAt: 1, ctx };

// Controllable stand-ins for the @cauce/react hooks the component uses.
const mock = {
  api: {} as CauceCheckoutRenderProps,
  pending: [] as PendingPayment[],
  dismiss: vi.fn(),
};

vi.mock('@cauce/react', () => ({
  CauceCheckout: ({ children }: { children: (api: CauceCheckoutRenderProps) => unknown }) =>
    children(mock.api),
  useCauceConfig: () => config,
  useCaucePendingPayments: () => ({
    pending: mock.pending,
    dismiss: mock.dismiss,
    refresh: vi.fn(),
  }),
}));

function api(
  state: CaucePaymentState = initialPaymentState,
  overrides: Partial<CauceCheckoutRenderProps> = {},
) {
  mock.api = {
    state,
    status: state.status,
    steps: getPaymentSteps(state),
    route: 'cctp',
    isBusy: !['idle', 'settled', 'failed'].includes(state.status),
    error: state.status === 'failed' ? state.error : undefined,
    pay: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    amountInput: '25.00',
    setAmountInput: vi.fn(),
    amount: 25_000_000n,
    amountError: undefined,
    quote: undefined,
    isQuoting: false,
    canPay: true,
    submit: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  return mock.api;
}

const fixed = { mode: 'fixed', value: 25_000_000n } as const;
const props = { merchant: ctx.request.merchant, orderId: 'o-1', amount: fixed };

beforeEach(() => {
  mock.pending = [];
  mock.dismiss.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('<CaucePayment />', () => {
  it('shows a fixed amount and pays on click', () => {
    const current = api();
    render(<CaucePayment {...props} />);

    expect(screen.getByRole('region', { name: 'Pay with USDC' })).toBeTruthy();
    expect(screen.getByLabelText('Amount').textContent).toBe('25.00');
    fireEvent.click(screen.getByRole('button', { name: 'Pay 25.00 USDC' }));
    expect(current.submit).toHaveBeenCalledOnce();
  });

  it('lets the payer type a variable amount and explains invalid input', () => {
    const current = api(initialPaymentState, {
      amountInput: '1.2345678',
      amount: undefined,
      amountError: new CauceError('INVALID_AMOUNT', 'USDC has at most 6 decimals'),
      canPay: false,
    });
    render(<CaucePayment {...props} amount={{ mode: 'variable' }} />);

    const input = screen.getByLabelText('Amount');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('USDC has at most 6 decimals');
    expect(screen.getByRole('button', { name: 'Pay' })).toHaveProperty('disabled', true);

    fireEvent.change(input, { target: { value: '3' } });
    expect(current.setAmountInput).toHaveBeenCalledWith('3');
  });

  it('summarizes the quote before paying', () => {
    api(initialPaymentState, { quote: ctx.quote });
    render(<CaucePayment {...props} />);

    expect(screen.getByText('Circle fee up to 0.003251 USDC')).toBeTruthy();
    expect(screen.getByText('You pay at most 25.003251 USDC')).toBeTruthy();
    expect(screen.getByText('Fast transfer, usually under a minute')).toBeTruthy();
  });

  it('renders progress as an ordered list with the active step marked', () => {
    api({ status: 'attesting', ctx, burnTxHash: BURN });
    render(<CaucePayment {...props} />);

    const steps = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(steps.map((step) => step.dataset.state)).toEqual(['done', 'done', 'active']);
    expect(steps[2]?.getAttribute('aria-current')).toBe('step');
    expect(
      screen.getByText('Waiting for Circle to confirm the transfer…').getAttribute('aria-live'),
    ).toBe('polite');
    expect(screen.getByRole('button', { name: /Pay/ }).getAttribute('aria-busy')).toBe('true');
  });

  it('links the settlement transaction on the settlement chain explorer and can close', () => {
    api({ status: 'settled', ctx, burnTxHash: BURN, settlementTxHash: SETTLED });
    const onClose = vi.fn();
    render(<CaucePayment {...props} onClose={onClose} />);

    const receipt = screen.getByRole('link', { name: 'View receipt' });
    expect(receipt.getAttribute('href')).toBe(
      `${arcTestnet.blockExplorers.default.url}/tx/${SETTLED}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers to finish a recoverable failed payment', () => {
    const current = api({
      status: 'failed',
      ctx,
      burnTxHash: BURN,
      error: new CauceError('RELAY_FAILED', 'relayer unavailable'),
      failedDuring: 'attesting',
      recoverable: true,
    });
    mock.pending = [pendingPayment];
    render(<CaucePayment {...props} />);

    expect(screen.getByRole('alert').textContent).toBe('relayer unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Finish payment' }));
    expect(current.resume).toHaveBeenCalledWith(pendingPayment);
  });

  it('offers to try again after a failure before the burn', () => {
    const current = api({
      status: 'failed',
      ctx,
      error: new CauceError('USER_REJECTED', 'rejected'),
      failedDuring: 'approving',
      recoverable: false,
    });
    render(<CaucePayment {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(current.reset).toHaveBeenCalledOnce();
  });

  it('surfaces a payment left unfinished in an earlier visit', () => {
    const current = api();
    mock.pending = [pendingPayment];
    render(<CaucePayment {...props} />);

    expect(screen.getByText('You have an unfinished payment of 25.00 USDC.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish payment' }));
    expect(current.resume).toHaveBeenCalledWith(pendingPayment);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(mock.dismiss).toHaveBeenCalledWith(BURN);
  });

  it('renders the app connect button while disconnected', () => {
    api(initialPaymentState, { route: 'disconnected', canPay: false });
    render(<CaucePayment {...props} connectButton={<button type="button">Connect</button>} />);

    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });

  it('explains why it cannot pay on an unsupported network', () => {
    api(initialPaymentState, { route: 'unsupported', canPay: false });
    render(<CaucePayment {...props} />);

    expect(screen.getByText('Switch to a supported network to pay')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pay 25.00 USDC' })).toHaveProperty('disabled', true);
  });

  it('accepts translated labels and a forced theme', () => {
    api();
    render(
      <CaucePayment
        {...props}
        theme="dark"
        className="mine"
        labels={{ title: 'Pagar con USDC', pay: (amount) => `Pagar ${amount ?? ''} USDC` }}
      />,
    );

    const region = screen.getByRole('region', { name: 'Pagar con USDC' });
    expect(region.dataset.cauceTheme).toBe('dark');
    expect(region.className).toBe('cauce-payment mine');
    expect(screen.getByRole('button', { name: 'Pagar 25.00 USDC' })).toBeTruthy();
  });
});
