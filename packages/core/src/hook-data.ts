import {
  decodeAbiParameters,
  encodeAbiParameters,
  isAddress,
  isHex,
  parseAbiParameters,
  stringToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { CauceError } from './errors';
import type { CaucePaymentRequest } from './types';

/** Mirrors HookData.sol in contracts/. */
export const HOOK_DATA_VERSION = 1;
export const MAX_ORDER_ID_LENGTH = 128;

const hookDataParameters = parseAbiParameters('uint8, address, string, uint256, address');

export type HookDataInput = Omit<CaucePaymentRequest, 'amount'>;
export type DecodedHookData = HookDataInput & { version: typeof HOOK_DATA_VERSION };

/**
 * Encodes Cauce payment metadata for the CCTP `hookData` field (version 1):
 * `abi.encode(uint8 version, address merchant, string orderId, uint256 campaignId, address referrer)`.
 */
export function encodeHookData(input: HookDataInput): Hex {
  assertMerchant(input.merchant);
  assertOrderId(input.orderId);

  let campaignId = 0n;
  let referrer: Address = zeroAddress;
  if (input.referral) {
    if (input.referral.campaignId <= 0n) {
      throw invalid('Referral campaignId must be greater than zero');
    }
    if (!isAddress(input.referral.referrer) || input.referral.referrer === zeroAddress) {
      throw invalid('Referral referrer must be a non-zero address');
    }
    campaignId = input.referral.campaignId;
    referrer = input.referral.referrer;
  }

  return encodeAbiParameters(hookDataParameters, [
    HOOK_DATA_VERSION,
    input.merchant,
    input.orderId,
    campaignId,
    referrer,
  ]);
}

/**
 * Decodes version 1 hookData with the same rules as the vault: anything the vault would refund
 * instead of crediting throws `INVALID_HOOK_DATA`.
 */
export function decodeHookData(data: Hex): DecodedHookData {
  if (!isHex(data)) throw invalid('hookData must be a hex string');

  let decoded: readonly [number, Address, string, bigint, Address];
  try {
    decoded = decodeAbiParameters(hookDataParameters, data);
  } catch (error) {
    throw invalid('hookData is not a valid version 1 encoding', error);
  }

  const [version, merchant, orderId, campaignId, referrer] = decoded;
  if (version !== HOOK_DATA_VERSION) throw invalid(`Unsupported hookData version ${version}`);
  assertMerchant(merchant);
  assertOrderId(orderId);

  const result: DecodedHookData = { version: HOOK_DATA_VERSION, merchant, orderId };
  if (campaignId !== 0n && referrer !== zeroAddress) {
    result.referral = { campaignId, referrer };
  }

  // The vault only accepts the canonical encoding (exact offsets and length).
  const canonical = encodeAbiParameters(hookDataParameters, [
    version,
    merchant,
    orderId,
    campaignId,
    referrer,
  ]);
  if (canonical.toLowerCase() !== data.toLowerCase()) {
    throw invalid('hookData is not canonically encoded');
  }
  return result;
}

function assertMerchant(merchant: Address): void {
  if (!isAddress(merchant) || merchant === zeroAddress) {
    throw invalid('merchant must be a non-zero address');
  }
}

function assertOrderId(orderId: string): void {
  const length = stringToBytes(orderId).length;
  if (length === 0 || length > MAX_ORDER_ID_LENGTH) {
    throw invalid(`orderId must be 1 to ${MAX_ORDER_ID_LENGTH} UTF-8 bytes, got ${length}`);
  }
}

function invalid(message: string, cause?: unknown): CauceError {
  return new CauceError('INVALID_HOOK_DATA', message, cause === undefined ? {} : { cause });
}
