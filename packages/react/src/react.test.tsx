import {
  createCauceConfig,
  createMemoryPendingStore,
  type CauceError,
  type PendingPayment,
  type PendingPaymentStore,
} from '@cauce/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Address, Hash } from 'viem';
import { baseSepolia } from 'viem/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceCheckout } from './checkout';
import { CauceProvider } from './context';
import { resetWallet, wallet } from './test-wagmi';
import { useCaucePayment } from './use-cauce-payment';
import { useCaucePendingPayments } from './use-cauce-pending-payments';
import { useCauceQuote } from './use-cauce-quote';

vi.mock('wagmi', async () => (await import('./test-wagmi')).wagmiModule);
vi.mock('wagmi/actions', async () => (await import('./test-wagmi')).wagmiActionsModule);

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const SETTLEMENT_TX: Hash = `0x${'5e'.repeat(32)}`;
const request = { merchant: MERCHANT, orderId: 'order-1', amount: 25_000_000n };

let relayerStatus: 'attesting' | 'settled' | 'failed' = 'settled';

function stubNetwork() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v2/burn/USDC/fees/')) {
        return Promise.resolve(
          Response.json([
            { finalityThreshold: 1000, minimumFee: 1 },
            { finalityThreshold: 2000, minimumFee: 0 },
          ]),
        );
      }
      if (url.includes('/relay')) {
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        const [, domain, burnTxHash] = /\/relay\/(\d+)\/(0x[0-9a-f]+)/.exec(url) ?? [];
        return Promise.resolve(
          Response.json({
            burnTxHash: body.burnTxHash ?? burnTxHash,
            sourceDomain: body.sourceDomain ?? Number(domain),
            status: relayerStatus,
            ...(relayerStatus === 'settled' ? { settlementTxHash: SETTLEMENT_TX } : {}),
            ...(relayerStatus === 'failed' ? { error: 'relayer gave up' } : {}),
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    }),
  );
}

function setup(store: PendingPaymentStore = createMemoryPendingStore()) {
  const config = createCauceConfig({
    environment: 'testnet',
    chains: [baseSepolia],
    relayerUrl: 'https://shop.dev/api/cauce',
    settlement: {
      vault: '0x00000000000000000000000000000000000000Aa',
      relay: '0x00000000000000000000000000000000000000bB',
    },
    iris: { retry: { retries: 0 } },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <CauceProvider config={config} pendingStore={store}>
        {children}
      </CauceProvider>
    </QueryClientProvider>
  );
  return { wrapper, store, config };
}

beforeEach(() => {
  resetWallet();
  relayerStatus = 'settled';
  stubNetwork();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useCaucePayment', () => {
  it('reports the route of the connected wallet', () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(() => useCaucePayment(), { wrapper });
    expect(result.current.route).toBe('cctp');

    wallet.chainId = 5042002;
    rerender();
    expect(result.current.route).toBe('direct');

    wallet.chainId = 1;
    rerender();
    expect(result.current.route).toBe('unsupported');

    wallet.status = 'disconnected';
    rerender();
    expect(result.current.route).toBe('disconnected');
  });

  it('pays through CCTP and settles, notifying callbacks', async () => {
    const { wrapper, store } = setup();
    const onSettled = vi.fn();
    const onStateChange = vi.fn();
    const { result } = renderHook(() => useCaucePayment({ onSettled, onStateChange }), { wrapper });

    await act(() => result.current.pay(request));

    expect(result.current.status).toBe('settled');
    expect(result.current.steps.every((step) => step.state === 'done')).toBe(true);
    expect(result.current.isBusy).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ settlementTxHash: SETTLEMENT_TX }),
    );
    expect(onStateChange).toHaveBeenCalled();
    expect(wallet.writes.map((w) => w.functionName)).toEqual(['approve', 'depositForBurnWithHook']);
    expect(await store.list()).toEqual([]);
  });

  it('pays directly on the settlement chain', async () => {
    wallet.chainId = 5042002;
    const { wrapper } = setup();
    const { result } = renderHook(() => useCaucePayment(), { wrapper });

    await act(() => result.current.pay(request));

    expect(result.current.status).toBe('settled');
    expect(wallet.writes.map((w) => w.functionName)).toEqual(['approve', 'pay']);
  });

  it('never rejects: failures land in state and onError', async () => {
    wallet.rejectNextWrite = true;
    const { wrapper } = setup();
    const onError = vi.fn<(error: CauceError) => void>();
    const { result } = renderHook(() => useCaucePayment({ onError }), { wrapper });

    await act(() => result.current.pay(request));

    expect(result.current.status).toBe('failed');
    expect(result.current.error?.code).toBe('USER_REJECTED');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_REJECTED' }));
  });

  it.each<[string, () => void, Partial<typeof request>, string]>([
    [
      'no wallet is connected',
      () => {
        wallet.status = 'disconnected';
      },
      {},
      'WALLET_NOT_CONNECTED',
    ],
    [
      'the chain is missing from the wagmi config',
      () => {
        wallet.configuredChains.delete(84532);
      },
      {},
      'UNSUPPORTED_CHAIN',
    ],
    ['the request is invalid', () => undefined, { orderId: '' }, 'INVALID_HOOK_DATA'],
  ])(
    'reports an error when %s, before any transaction',
    async (_name, arrange, overrides, code) => {
      arrange();
      const { wrapper } = setup();
      const onError = vi.fn();
      const { result } = renderHook(() => useCaucePayment({ onError }), { wrapper });

      await act(() => result.current.pay({ ...request, ...overrides }));

      expect(result.current.status).toBe('idle');
      expect(result.current.error?.code).toBe(code);
      expect(onError).toHaveBeenCalledOnce();
      expect(wallet.writes).toEqual([]);
    },
  );

  it('keeps a failed relay as a recoverable pending payment, then resumes it without a wallet', async () => {
    relayerStatus = 'failed';
    const { wrapper, store } = setup();
    const { result } = renderHook(
      () => ({ payment: useCaucePayment(), pending: useCaucePendingPayments() }),
      { wrapper },
    );

    await act(() => result.current.payment.pay(request));
    expect(result.current.payment.state).toMatchObject({ status: 'failed', recoverable: true });
    await waitFor(() => {
      expect(result.current.pending.pending).toHaveLength(1);
    });

    relayerStatus = 'settled';
    wallet.status = 'disconnected';
    const [pending] = result.current.pending.pending;
    await act(() => result.current.payment.resume(pending!));

    expect(result.current.payment.status).toBe('settled');
    await waitFor(() => {
      expect(result.current.pending.pending).toEqual([]);
    });
    expect(await store.list()).toEqual([]);
  });

  it('reset() clears a finished payment', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCaucePayment(), { wrapper });
    await act(() => result.current.pay(request));

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
  });
});

describe('useCaucePendingPayments', () => {
  const pending = (burnTxHash: Hash, createdAt: number): PendingPayment => ({
    burnTxHash,
    sourceDomain: 6,
    createdAt,
    ctx: {
      request,
      quote: {
        route: 'cctp',
        amount: request.amount,
        maxFee: 2_501n,
        total: 25_002_501n,
        minFinalityThreshold: 1000,
      },
      sourceChainId: 84532,
      payer: '0x3333333333333333333333333333333333333333',
    },
  });

  it('lists newest first and dismisses', async () => {
    const store = createMemoryPendingStore();
    await store.put(pending(`0x${'01'.repeat(32)}`, 1));
    await store.put(pending(`0x${'02'.repeat(32)}`, 2));
    const { wrapper } = setup(store);
    const { result } = renderHook(() => useCaucePendingPayments(), { wrapper });

    await waitFor(() => {
      expect(result.current.pending.map((p) => p.createdAt)).toEqual([2, 1]);
    });

    await act(() => result.current.dismiss(`0x${'02'.repeat(32)}`));
    await waitFor(() => {
      expect(result.current.pending.map((p) => p.createdAt)).toEqual([1]);
    });
  });

  it('re-reads the store when another tab changes it', async () => {
    const store = createMemoryPendingStore();
    const { wrapper } = setup(store);
    const { result } = renderHook(() => useCaucePendingPayments(), { wrapper });
    await store.put(pending(`0x${'03'.repeat(32)}`, 3));

    act(() => {
      window.dispatchEvent(new StorageEvent('storage'));
    });

    await waitFor(() => {
      expect(result.current.pending).toHaveLength(1);
    });
  });
});

describe('useCauceQuote', () => {
  it('quotes the connected chain with Circle fees', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCauceQuote({ amount: 10_000_000n }), { wrapper });

    await waitFor(() => {
      expect(result.current.quote).toMatchObject({ route: 'cctp', minFinalityThreshold: 1000 });
    });
    expect(result.current.quote!.total).toBeGreaterThan(10_000_000n);
  });

  it('stays idle without an amount or wallet', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCauceQuote({ amount: undefined }), { wrapper });
    expect(result.current).toEqual({ quote: undefined, isLoading: false, error: undefined });
  });
});

describe('CauceCheckout', () => {
  function Form(props: { amount: Parameters<typeof CauceCheckout>[0]['amount'] }) {
    return (
      <CauceCheckout merchant={MERCHANT} orderId="order-9" amount={props.amount}>
        {(api) => (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void api.submit();
            }}
          >
            <label>
              Amount
              <input
                value={api.amountInput}
                onChange={(e) => {
                  api.setAmountInput(e.target.value);
                }}
              />
            </label>
            {api.amountError && <p role="alert">{api.amountError.message}</p>}
            <p data-testid="status">{api.status}</p>
            <button type="submit" disabled={!api.canPay}>
              Pay
            </button>
          </form>
        )}
      </CauceCheckout>
    );
  }

  it('validates a variable amount against min and max', () => {
    const { wrapper } = setup();
    render(<Form amount={{ mode: 'variable', min: 1_000_000n, max: 100_000_000n }} />, { wrapper });
    const input = screen.getByLabelText('Amount');
    const button = screen.getByRole('button', { name: 'Pay' });

    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(screen.getByRole('alert').textContent).toBe('The minimum is 1.00 USDC');
    fireEvent.change(input, { target: { value: '101' } });
    expect(screen.getByRole('alert').textContent).toBe('The maximum is 100.00 USDC');
    fireEvent.change(input, { target: { value: '1.2345678' } });
    expect(screen.getByRole('alert').textContent).toBe('USDC has at most 6 decimals');
    fireEvent.change(input, { target: { value: '12.5' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button).toHaveProperty('disabled', false);
  });

  it('pays a fixed price with the merchant and order id', async () => {
    const { wrapper } = setup();
    render(<Form amount={{ mode: 'fixed', value: 7_500_000n }} />, { wrapper });

    expect(screen.getByLabelText<HTMLInputElement>('Amount').value).toBe('7.50');
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('settled');
    });
    const burn = wallet.writes.find((w) => w.functionName === 'depositForBurnWithHook');
    expect(burn?.args[0]).toBeGreaterThan(7_500_000n);
  });

  it('cannot pay while disconnected', () => {
    wallet.status = 'disconnected';
    const { wrapper } = setup();
    render(<Form amount={{ mode: 'fixed', value: 1n }} />, { wrapper });
    expect(screen.getByRole('button', { name: 'Pay' })).toHaveProperty('disabled', true);
  });
});

describe('CauceProvider', () => {
  it('is required by the hooks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useCaucePayment())).toThrow(/inside <CauceProvider>/);
  });
});
