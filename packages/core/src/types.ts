import type { Address } from 'viem';

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
