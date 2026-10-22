import {
  concat,
  getAddress,
  hexToBigInt,
  hexToNumber,
  isHex,
  numberToHex,
  pad,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem';
import { CauceError } from './errors';

// CCTP V2 layouts, from circlefin/evm-cctp-contracts (src/messages/v2). Same offsets as
// contracts/src/libraries/CctpMessage.sol.
const BODY_INDEX = 148;
const HOOK_DATA_INDEX = 228;
const MIN_LENGTH = BODY_INDEX + HOOK_DATA_INDEX;

export interface DecodedBurnMessage {
  version: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
}

export interface DecodedCctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: DecodedBurnMessage;
}

/** Decodes a CCTP V2 message whose body is a BurnMessageV2 (a USDC burn). */
export function decodeCctpMessage(message: Hex): DecodedCctpMessage {
  if (!isHex(message, { strict: true }) || size(message) < MIN_LENGTH) {
    throw new CauceError(
      'INVALID_CCTP_MESSAGE',
      `A CCTP V2 burn message is at least ${MIN_LENGTH} bytes`,
      { details: { message } },
    );
  }
  const u32 = (start: number) => hexToNumber(slice(message, start, start + 4, { strict: true }));
  const b32 = (start: number) => slice(message, start, start + 32, { strict: true });
  const body = (start: number) => BODY_INDEX + start;

  return {
    version: u32(0),
    sourceDomain: u32(4),
    destinationDomain: u32(8),
    nonce: b32(12),
    sender: b32(44),
    recipient: b32(76),
    destinationCaller: b32(108),
    minFinalityThreshold: u32(140),
    finalityThresholdExecuted: u32(144),
    body: {
      version: u32(body(0)),
      burnToken: b32(body(4)),
      mintRecipient: b32(body(36)),
      amount: hexToBigInt(b32(body(68))),
      messageSender: b32(body(100)),
      maxFee: hexToBigInt(b32(body(132))),
      feeExecuted: hexToBigInt(b32(body(164))),
      expirationBlock: hexToBigInt(b32(body(196))),
      hookData: size(message) > MIN_LENGTH ? slice(message, body(HOOK_DATA_INDEX)) : '0x',
    },
  };
}

/** Builds a CCTP V2 burn message byte-for-byte as Circle does. Useful for tests and tooling. */
export function encodeCctpMessage(m: DecodedCctpMessage): Hex {
  const u32 = (value: number) => numberToHex(value, { size: 4 });
  const u256 = (value: bigint) => numberToHex(value, { size: 32 });
  return concat([
    u32(m.version),
    u32(m.sourceDomain),
    u32(m.destinationDomain),
    m.nonce,
    m.sender,
    m.recipient,
    m.destinationCaller,
    u32(m.minFinalityThreshold),
    u32(m.finalityThresholdExecuted),
    u32(m.body.version),
    m.body.burnToken,
    m.body.mintRecipient,
    u256(m.body.amount),
    m.body.messageSender,
    u256(m.body.maxFee),
    u256(m.body.feeExecuted),
    u256(m.body.expirationBlock),
    m.body.hookData,
  ]);
}

/** Left-pads an address to the bytes32 form CCTP uses for recipients and callers. */
export function addressToBytes32(address: Address): Hex {
  return pad(getAddress(address), { size: 32 }).toLowerCase() as Hex;
}

/** Reads an EVM address from its bytes32 form; throws if the upper 12 bytes are not zero. */
export function bytes32ToAddress(value: Hex): Address {
  if (size(value) !== 32 || hexToBigInt(slice(value, 0, 12)) !== 0n) {
    throw new CauceError('INVALID_CCTP_MESSAGE', `${value} is not a left-padded EVM address`);
  }
  return getAddress(slice(value, 12));
}
