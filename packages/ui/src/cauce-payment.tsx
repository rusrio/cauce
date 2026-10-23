import { formatUsdc, type CaucePaymentRequest, type PendingPayment } from '@cauce/core';
import {
  CauceCheckout,
  useCauceConfig,
  useCaucePendingPayments,
  type CauceCheckoutAmount,
  type CauceCheckoutRenderProps,
  type UseCaucePaymentOptions,
} from '@cauce/react';
import { useId, type ReactNode } from 'react';
import type { Address } from 'viem';
import { defaultLabels, type CaucePaymentLabels } from './labels';

export interface CaucePaymentProps extends UseCaucePaymentOptions {
  merchant: Address;
  orderId: string;
  amount: CauceCheckoutAmount;
  referral?: CaucePaymentRequest['referral'];
  /** Rendered instead of the pay button while no wallet is connected (e.g. RainbowKit's). */
  connectButton?: ReactNode;
  /** Shows a close button once the payment settles. */
  onClose?: () => void;
  labels?: Partial<CaucePaymentLabels>;
  /** Forces a theme; by default it follows `prefers-color-scheme`. */
  theme?: 'light' | 'dark';
  className?: string;
}

/**
 * A complete payment form. Import '@cauce/ui/styles.css' once and theme it with the --cauce-*
 * CSS variables.
 */
export function CaucePayment({
  merchant,
  orderId,
  amount,
  referral,
  connectButton,
  onClose,
  labels: labelOverrides,
  theme,
  className,
  ...callbacks
}: CaucePaymentProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  return (
    <CauceCheckout
      merchant={merchant}
      orderId={orderId}
      amount={amount}
      {...(referral ? { referral } : {})}
      {...callbacks}
    >
      {(api) => (
        <PaymentView
          api={api}
          fixed={amount.mode === 'fixed'}
          labels={labels}
          connectButton={connectButton}
          onClose={onClose}
          theme={theme}
          className={className}
        />
      )}
    </CauceCheckout>
  );
}

interface PaymentViewProps {
  api: CauceCheckoutRenderProps;
  fixed: boolean;
  labels: CaucePaymentLabels;
  connectButton: ReactNode;
  onClose: (() => void) | undefined;
  theme: 'light' | 'dark' | undefined;
  className: string | undefined;
}

function PaymentView({
  api,
  fixed,
  labels,
  connectButton,
  onClose,
  theme,
  className,
}: PaymentViewProps) {
  const config = useCauceConfig();
  const { pending, dismiss } = useCaucePendingPayments();
  const inputId = useId();
  const errorId = useId();
  const { state } = api;

  // A burned payment of this checkout that failed to settle can be finished from here.
  const recoverable: PendingPayment | undefined =
    state.status === 'failed' && state.recoverable
      ? pending.find((p) => p.burnTxHash.toLowerCase() === state.burnTxHash?.toLowerCase())
      : undefined;
  // Payments left unfinished in an earlier visit (closed tab), shown while nothing is in flight.
  const leftover = state.status === 'idle' ? pending[0] : undefined;

  const explorer = config.settlement.chain.blockExplorers?.default.url;
  const receiptUrl =
    state.status === 'settled' && explorer ? `${explorer}/tx/${state.settlementTxHash}` : undefined;

  const classes = ['cauce-payment', className].filter(Boolean).join(' ');

  return (
    <section
      className={classes}
      data-status={state.status}
      data-cauce-theme={theme}
      aria-label={labels.title}
    >
      <header className="cauce-header">
        <h2 className="cauce-title">{labels.title}</h2>
      </header>

      {leftover && (
        <div className="cauce-notice" role="status">
          <p>{labels.pendingNotice(formatUsdc(leftover.ctx.request.amount))}</p>
          <div className="cauce-notice-actions">
            <button
              type="button"
              className="cauce-button cauce-button-secondary"
              onClick={() => void api.resume(leftover)}
            >
              {labels.finishPayment}
            </button>
            <button
              type="button"
              className="cauce-button cauce-button-ghost"
              onClick={() => void dismiss(leftover.burnTxHash)}
            >
              {labels.dismiss}
            </button>
          </div>
        </div>
      )}

      <div className="cauce-amount">
        <label className="cauce-label" htmlFor={inputId}>
          {labels.amount}
        </label>
        <div className="cauce-amount-field">
          {fixed ? (
            <output id={inputId} className="cauce-amount-value">
              {api.amountInput}
            </output>
          ) : (
            <input
              id={inputId}
              className="cauce-input"
              inputMode="decimal"
              autoComplete="off"
              placeholder={labels.amountPlaceholder}
              value={api.amountInput}
              disabled={api.isBusy}
              aria-invalid={api.amountError ? true : undefined}
              aria-describedby={api.amountError ? errorId : undefined}
              onChange={(event) => {
                api.setAmountInput(event.target.value);
              }}
            />
          )}
          <span className="cauce-currency">{labels.currency}</span>
        </div>
        {api.amountError && (
          <p id={errorId} className="cauce-field-error" role="alert">
            {api.amountError.message}
          </p>
        )}
      </div>

      {api.quote && state.status === 'idle' && <QuoteSummary api={api} labels={labels} />}

      {state.status !== 'idle' && (
        <ol className="cauce-steps">
          {api.steps.map((step) => (
            <li
              key={step.id}
              className="cauce-step"
              data-state={step.state}
              aria-current={step.state === 'active' ? 'step' : undefined}
            >
              <span className="cauce-step-marker" aria-hidden="true" />
              <span className="cauce-step-label">{labels.steps[step.id]}</span>
            </li>
          ))}
        </ol>
      )}

      <p className="cauce-status" aria-live="polite">
        {labels.status[state.status]}
      </p>

      {api.error && (
        <p className="cauce-error" role="alert">
          {api.error.message}
        </p>
      )}

      {receiptUrl && (
        <a className="cauce-receipt" href={receiptUrl} target="_blank" rel="noreferrer">
          {labels.viewReceipt}
        </a>
      )}

      <div className="cauce-actions">
        <Action
          api={api}
          labels={labels}
          recoverable={recoverable}
          connectButton={connectButton}
          onClose={onClose}
        />
      </div>

      <p className="cauce-network">{config.settlement.chain.name}</p>
    </section>
  );
}

function QuoteSummary({
  api,
  labels,
}: {
  api: CauceCheckoutRenderProps;
  labels: CaucePaymentLabels;
}) {
  const quote = api.quote;
  if (!quote) return null;
  const speed =
    quote.route === 'direct'
      ? labels.directPayment
      : quote.minFinalityThreshold === 1000
        ? labels.fastTransfer
        : labels.standardTransfer;
  return (
    <ul className="cauce-quote">
      {quote.maxFee > 0n && <li>{labels.networkFee(formatUsdc(quote.maxFee))}</li>}
      {quote.maxFee > 0n && (
        <li className="cauce-quote-total">{labels.total(formatUsdc(quote.total))}</li>
      )}
      <li>{speed}</li>
    </ul>
  );
}

function Action({
  api,
  labels,
  recoverable,
  connectButton,
  onClose,
}: {
  api: CauceCheckoutRenderProps;
  labels: CaucePaymentLabels;
  recoverable: PendingPayment | undefined;
  connectButton: ReactNode;
  onClose: (() => void) | undefined;
}) {
  const { status } = api;

  if (status === 'settled') {
    return onClose ? (
      <button type="button" className="cauce-button cauce-button-secondary" onClick={onClose}>
        {labels.close}
      </button>
    ) : null;
  }
  if (status === 'failed') {
    return recoverable ? (
      <button type="button" className="cauce-button" onClick={() => void api.resume(recoverable)}>
        {labels.finishPayment}
      </button>
    ) : (
      <button type="button" className="cauce-button" onClick={api.reset}>
        {labels.tryAgain}
      </button>
    );
  }
  if (api.route === 'disconnected' && connectButton) return <>{connectButton}</>;

  const reason =
    api.route === 'disconnected'
      ? labels.connectWallet
      : api.route === 'unsupported'
        ? labels.unsupportedChain
        : undefined;

  return (
    <>
      <button
        type="button"
        className="cauce-button"
        disabled={!api.canPay}
        aria-busy={api.isBusy || undefined}
        onClick={() => void api.submit()}
      >
        {api.isBusy && <span className="cauce-spinner" aria-hidden="true" />}
        {labels.pay(api.amount === undefined ? undefined : formatUsdc(api.amount))}
      </button>
      {reason && <p className="cauce-hint">{reason}</p>}
    </>
  );
}
