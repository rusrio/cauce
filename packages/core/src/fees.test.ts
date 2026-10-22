import type { Address } from 'viem';
import { arcTestnet, baseSepolia, sepolia } from 'viem/chains';
import { describe, expect, it, vi } from 'vitest';
import { createCauceConfig, type CauceFeeOptions } from './config';
import { computeMaxFee, quotePayment } from './fees';
import type { IrisBurnFee } from './iris';

const settlement = {
  vault: '0x00000000000000000000000000000000000000aa' as Address,
  relay: '0x00000000000000000000000000000000000000bb' as Address,
};

function setup(fees: IrisBurnFee[], feeOptions: Partial<CauceFeeOptions> = {}) {
  const body = fees.map((f) => ({
    finalityThreshold: f.finalityThreshold,
    minimumFee: f.minimumFeeBps,
  }));
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body)));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = createCauceConfig({
    environment: 'testnet',
    chains: [sepolia, baseSepolia],
    relayerUrl: 'https://relayer.dev',
    settlement,
    fees: feeOptions,
    iris: { fetch: fetchMock },
    logger,
  });
  return { config, fetchMock, logger };
}

const circleFees: IrisBurnFee[] = [
  { finalityThreshold: 1000, minimumFeeBps: 1.3 },
  { finalityThreshold: 2000, minimumFeeBps: 0 },
];

describe('computeMaxFee', () => {
  it('matches the maxFee of a real 10 USDC fast transfer at 1 bps', () => {
    // Captured Sepolia burn: amount 10_001_001, maxFee 1_001, feeExecuted 1_000.
    expect(computeMaxFee(10_000_000n, 1)).toBe(1_001n);
  });

  it('returns the smallest fee that covers the fee charged on the whole burn', () => {
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    const covers = (amount: bigint, fee: bigint, rate: bigint) =>
      fee >= ceilDiv((amount + fee) * rate, 100_000_000n);

    for (const [amount, bps] of [
      [1n, 1],
      [999_999n, 1.3],
      [10_000_000n, 0.5],
      [123_456_789_000n, 7.25],
    ] as const) {
      const rate = BigInt(Math.round(bps * 10_000));
      const fee = computeMaxFee(amount, bps);
      expect(covers(amount, fee, rate)).toBe(true);
      expect(covers(amount, fee - 1n, rate)).toBe(false);
    }
  });

  it('is zero for a zero rate', () => {
    expect(computeMaxFee(10_000_000n, 0)).toBe(0n);
  });

  it.each([-1, 10_000, Number.NaN])('rejects %s bps', (bps) => {
    expect(() => computeMaxFee(1n, bps)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
});

describe('quotePayment', () => {
  it('quotes a fast CCTP transfer with Circle fee + buffer', async () => {
    const { config, fetchMock } = setup(circleFees);

    const quote = await quotePayment(config, {
      amount: 100_000_000n,
      sourceChainId: baseSepolia.id,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/26',
    );
    const maxFee = computeMaxFee(100_000_000n, 1.8);
    expect(quote).toEqual({
      route: 'cctp',
      amount: 100_000_000n,
      maxFee,
      total: 100_000_000n + maxFee,
      minFinalityThreshold: 1000,
    });
  });

  it('quotes direct payments on the settlement chain without fees or Iris calls', async () => {
    const { config, fetchMock } = setup(circleFees);

    await expect(
      quotePayment(config, { amount: 5n, sourceChainId: arcTestnet.id }),
    ).resolves.toEqual({
      route: 'direct',
      amount: 5n,
      maxFee: 0n,
      total: 5n,
      minFinalityThreshold: 2000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses free standard transfers when configured', async () => {
    const { config, fetchMock } = setup(circleFees, { speed: 'standard' });

    const quote = await quotePayment(config, { amount: 5n, sourceChainId: sepolia.id });

    expect(quote).toMatchObject({
      route: 'cctp',
      maxFee: 0n,
      total: 5n,
      minFinalityThreshold: 2000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to standard when the fee exceeds maxFeeCap', async () => {
    const { config, logger } = setup(circleFees, { maxFeeCap: 10n });

    const quote = await quotePayment(config, { amount: 100_000_000n, sourceChainId: sepolia.id });

    expect(quote).toMatchObject({ maxFee: 0n, minFinalityThreshold: 2000 });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('falls back to standard when Circle offers no fast transfer', async () => {
    const { config } = setup([{ finalityThreshold: 2000, minimumFeeBps: 0 }]);

    const quote = await quotePayment(config, { amount: 1_000_000n, sourceChainId: sepolia.id });

    expect(quote.minFinalityThreshold).toBe(2000);
  });

  it('rejects non-positive amounts and unsupported chains', async () => {
    const { config } = setup(circleFees);

    await expect(
      quotePayment(config, { amount: 0n, sourceChainId: sepolia.id }),
    ).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    await expect(quotePayment(config, { amount: 1n, sourceChainId: 1 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CHAIN',
    });
  });
});
