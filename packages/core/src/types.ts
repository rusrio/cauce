import type { Address, Hash } from 'viem';

/** How a payment reaches the vault: bridged with CCTP, or paid directly on the settlement chain. */
export type PaymentRoute = 'cctp' | 'direct';

export interface CauceReferral {
  /** Referral campaign id in CauceVault. Must be greater than zero. */
  campaignId: bigint;
  referrer: Address;
}

export interface CaucePaymentRequest {
  merchant: Address;
  /** Merchant-defined order reference, 1 to 128 UTF-8 bytes. */
  orderId: string;
  /** Amount in USDC base units (6 decimals) that the merchant must receive at least. */
  amount: bigint;
  referral?: CauceReferral;
}

export interface PaymentQuote {
  route: PaymentRoute;
  /** What the merchant receives at least (the requested amount). */
  amount: bigint;
  /** Highest CCTP fee the payer allows; 0 for direct payments and standard transfers. */
  maxFee: bigint;
  /** What the payer approves and spends: amount + maxFee. */
  total: bigint;
  /** 1000 = fast transfer, 2000 = standard transfer. Irrelevant for direct payments. */
  minFinalityThreshold: 1000 | 2000;
}

export interface PaymentContext {
  request: CaucePaymentRequest;
  quote: PaymentQuote;
  sourceChainId: number;
  payer: Address;
}

/** A CCTP payment whose USDC was burned but which is not settled yet. Enough to resume it. */
export interface PendingPayment {
  burnTxHash: Hash;
  sourceDomain: number;
  ctx: PaymentContext;
  /** Unix epoch milliseconds. */
  createdAt: number;
}
