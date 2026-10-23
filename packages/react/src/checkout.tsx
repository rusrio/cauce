import {
  CauceError,
  formatUsdc,
  parseUsdc,
  type CaucePaymentRequest,
  type PaymentQuote,
} from '@cauce/core';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { Address } from 'viem';
import {
  useCaucePayment,
  type UseCaucePaymentOptions,
  type UseCaucePaymentResult,
} from './use-cauce-payment';
import { useCauceQuote } from './use-cauce-quote';

export type CauceCheckoutAmount =
  /** A price set by the merchant, in USDC base units. */
  | { mode: 'fixed'; value: bigint }
  /** The payer types the amount (donations, tips), optionally bounded. */
  | { mode: 'variable'; min?: bigint; max?: bigint };

export interface CauceCheckoutRenderProps extends UseCaucePaymentResult {
  /** Text of the amount field (pre-filled with the fixed price). */
  amountInput: string;
  setAmountInput: (value: string) => void;
  /** The parsed amount, if valid. */
  amount: bigint | undefined;
  /** Why the typed amount is not valid (only once something was typed). */
  amountError: CauceError | undefined;
  /** Current cost estimate for the connected chain, Circle's fee included. */
  quote: PaymentQuote | undefined;
  isQuoting: boolean;
  /** True when a payment can start right now. */
  canPay: boolean;
  /** Pays the current amount; no-op unless `canPay`. */
  submit: () => Promise<void>;
}

export interface CauceCheckoutProps extends UseCaucePaymentOptions {
  merchant: Address;
  orderId: string;
  referral?: CaucePaymentRequest['referral'];
  amount: CauceCheckoutAmount;
  children: (api: CauceCheckoutRenderProps) => ReactNode;
}

/**
 * Headless checkout: all the state and logic of a payment form, no markup. Render whatever you
 * want from the render prop, or use `<CaucePayment />` from @cauce/ui.
 */
export function CauceCheckout({
  merchant,
  orderId,
  referral,
  amount: amountConfig,
  children,
  ...callbacks
}: CauceCheckoutProps) {
  const payment = useCaucePayment(callbacks);
  const [amountInput, setAmountInput] = useState(() =>
    amountConfig.mode === 'fixed' ? formatUsdc(amountConfig.value) : '',
  );

  const { amount, amountError } = useMemo(
    () => resolveAmount(amountConfig, amountInput),
    [amountConfig, amountInput],
  );
  const { quote, isLoading: isQuoting } = useCauceQuote({ amount });

  const canPay =
    amount !== undefined &&
    (payment.route === 'cctp' || payment.route === 'direct') &&
    !payment.isBusy;

  const { pay } = payment;
  const submit = useCallback(async () => {
    if (!canPay) return;
    await pay({ merchant, orderId, amount, ...(referral ? { referral } : {}) });
  }, [canPay, pay, merchant, orderId, amount, referral]);

  return (
    <>
      {children({
        ...payment,
        amountInput,
        setAmountInput,
        amount,
        amountError,
        quote,
        isQuoting,
        canPay,
        submit,
      })}
    </>
  );
}

function resolveAmount(
  config: CauceCheckoutAmount,
  input: string,
): { amount: bigint | undefined; amountError: CauceError | undefined } {
  if (config.mode === 'fixed') return { amount: config.value, amountError: undefined };
  if (input.trim() === '') return { amount: undefined, amountError: undefined };

  let amount: bigint;
  try {
    amount = parseUsdc(input);
  } catch (error) {
    return { amount: undefined, amountError: error as CauceError };
  }
  const invalid = (message: string) => ({
    amount: undefined,
    amountError: new CauceError('INVALID_AMOUNT', message),
  });
  if (amount <= 0n) return invalid('Enter an amount greater than zero');
  if (config.min !== undefined && amount < config.min) {
    return invalid(`The minimum is ${formatUsdc(config.min)} USDC`);
  }
  if (config.max !== undefined && amount > config.max) {
    return invalid(`The maximum is ${formatUsdc(config.max)} USDC`);
  }
  return { amount, amountError: undefined };
}
