import { formatUnits, parseUnits } from 'viem';
import { CauceError } from './errors';

export const USDC_DECIMALS = 6;

const AMOUNT_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parses a user-entered USDC amount ("12", "12.5", ".5") into base units without floating point.
 * More than 6 decimals is rejected rather than silently rounded.
 */
export function parseUsdc(input: string): bigint {
  const value = input.trim();
  if (!AMOUNT_PATTERN.test(value)) {
    throw new CauceError('INVALID_AMOUNT', `"${input}" is not a valid USDC amount`);
  }
  const decimals = value.split('.')[1] ?? '';
  if (decimals.length > USDC_DECIMALS) {
    throw new CauceError('INVALID_AMOUNT', `USDC has at most ${USDC_DECIMALS} decimals`);
  }
  return parseUnits(value.endsWith('.') ? value.slice(0, -1) : value, USDC_DECIMALS);
}

/** Formats USDC base units for display, keeping at least `minDecimals` decimals ("12.50"). */
export function formatUsdc(
  amount: bigint,
  { minDecimals = 2 }: { minDecimals?: number } = {},
): string {
  const [whole, fraction = ''] = formatUnits(amount, USDC_DECIMALS).split('.');
  const padded = fraction.padEnd(Math.min(minDecimals, USDC_DECIMALS), '0');
  return padded ? `${whole}.${padded}` : (whole ?? '0');
}
