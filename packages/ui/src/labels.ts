import type { CaucePaymentStatus, PaymentStepId } from '@cauce/core';

/** Every string <CaucePayment /> renders. Override any of them to translate or rephrase. */
export interface CaucePaymentLabels {
  title: string;
  amount: string;
  currency: string;
  amountPlaceholder: string;
  /** Button text; `amount` is undefined until a valid amount is entered. */
  pay: (amount: string | undefined) => string;
  connectWallet: string;
  unsupportedChain: string;
  networkFee: (fee: string) => string;
  total: (total: string) => string;
  fastTransfer: string;
  standardTransfer: string;
  directPayment: string;
  steps: Record<PaymentStepId, string>;
  status: Record<CaucePaymentStatus, string>;
  viewReceipt: string;
  tryAgain: string;
  finishPayment: string;
  close: string;
  pendingNotice: (amount: string) => string;
  dismiss: string;
}

export const defaultLabels: CaucePaymentLabels = {
  title: 'Pay with USDC',
  amount: 'Amount',
  currency: 'USDC',
  amountPlaceholder: '0.00',
  pay: (amount) => (amount ? `Pay ${amount} USDC` : 'Pay'),
  connectWallet: 'Connect a wallet to pay',
  unsupportedChain: 'Switch to a supported network to pay',
  networkFee: (fee) => `Circle fee up to ${fee} USDC`,
  total: (total) => `You pay at most ${total} USDC`,
  fastTransfer: 'Fast transfer, usually under a minute',
  standardTransfer: 'Standard transfer, may take several minutes',
  directPayment: 'Paid directly on the settlement network',
  steps: { approve: 'Approve', transfer: 'Transfer', settle: 'Settle' },
  status: {
    idle: '',
    approving: 'Confirm the USDC approval in your wallet…',
    burning: 'Confirm the payment in your wallet…',
    paying: 'Confirm the payment in your wallet…',
    attesting: 'Waiting for Circle to confirm the transfer…',
    relaying: 'Settling the payment…',
    settled: 'Payment complete',
    failed: 'The payment could not be completed',
  },
  viewReceipt: 'View receipt',
  tryAgain: 'Try again',
  finishPayment: 'Finish payment',
  close: 'Close',
  pendingNotice: (amount) => `You have an unfinished payment of ${amount} USDC.`,
  dismiss: 'Dismiss',
};
