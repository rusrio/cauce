import type { CauceConfig } from './config';
import { CauceError } from './errors';
import type { PaymentQuote } from './types';

const FAST = 1000;
const STANDARD = 2000;
/** Basis points are scaled by 1e4 so fractional fees like 1.3 bps stay exact. */
const BPS_SCALE = 10_000n;
const RATE_DENOMINATOR = 10_000n * BPS_SCALE;

/**
 * Smallest maxFee that covers a fee of `bps` charged on the whole burn (amount + maxFee), so the
 * vault still receives at least `amount`.
 */
export function computeMaxFee(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new CauceError('INVALID_AMOUNT', 'amount must be positive');
  if (!Number.isFinite(bps) || bps < 0 || bps >= 10_000) {
    throw new CauceError('INVALID_CONFIG', `Invalid fee of ${bps} bps`);
  }
  const rate = BigInt(Math.round(bps * Number(BPS_SCALE)));
  if (rate === 0n) return 0n;
  // f >= (amount + f) * rate / D  <=>  f >= amount * rate / (D - rate)
  const numerator = amount * rate;
  const denominator = RATE_DENOMINATOR - rate;
  return (numerator + denominator - 1n) / denominator;
}

export interface QuotePaymentQuery {
  /** USDC base units the merchant must receive. */
  amount: bigint;
  /** Chain the payer pays from. */
  sourceChainId: number;
  signal?: AbortSignal;
}

/**
 * Prices a payment. Direct payments on the settlement chain are free; CCTP fast transfers pay
 * Circle's current minimum fee plus `fees.bufferBps`. If fast transfers are unavailable or the
 * fee exceeds `fees.maxFeeCap`, the quote falls back to a standard (finalized, free) transfer.
 */
export async function quotePayment(
  config: CauceConfig,
  { amount, sourceChainId, signal }: QuotePaymentQuery,
): Promise<PaymentQuote> {
  if (amount <= 0n) throw new CauceError('INVALID_AMOUNT', 'amount must be greater than zero');

  const route = config.getRoute(sourceChainId);
  if (route === undefined) {
    throw new CauceError('UNSUPPORTED_CHAIN', `Chain ${sourceChainId} cannot pay with Cauce`, {
      details: { chainId: sourceChainId },
    });
  }

  const standard: PaymentQuote = {
    route,
    amount,
    maxFee: 0n,
    total: amount,
    minFinalityThreshold: STANDARD,
  };
  if (route === 'direct' || config.fees.speed === 'standard') return standard;

  const source = config.getSourceChain(sourceChainId);
  const fees = await config.iris.getBurnFees({
    sourceDomain: source.domain,
    destinationDomain: config.settlement.domain,
    ...(signal ? { signal } : {}),
  });
  const fast = fees.find((fee) => fee.finalityThreshold === FAST);
  if (!fast) {
    config.logger.warn('cauce: fast transfers unavailable, using a standard transfer', {
      sourceDomain: source.domain,
    });
    return standard;
  }

  const maxFee = computeMaxFee(amount, fast.minimumFeeBps + config.fees.bufferBps);
  const cap = config.fees.maxFeeCap;
  if (cap !== undefined && maxFee > cap) {
    config.logger.warn('cauce: fast transfer fee above maxFeeCap, using a standard transfer', {
      maxFee: maxFee.toString(),
      maxFeeCap: cap.toString(),
    });
    return standard;
  }
  return { route, amount, maxFee, total: amount + maxFee, minFinalityThreshold: FAST };
}
