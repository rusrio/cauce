import { getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import complete from '../test/fixtures/iris-message-complete.json';
import {
  addressToBytes32,
  bytes32ToAddress,
  decodeCctpMessage,
  encodeCctpMessage,
} from './cctp-message';
import { isCauceError } from './errors';

// A real depositForBurnWithHook from Ethereum Sepolia to Sonic Testnet, as returned by Iris.
const irisMessage = complete.messages[0]!;
const expected = irisMessage.decodedMessage;

describe('decodeCctpMessage', () => {
  it('decodes a real CCTP V2 message exactly like Iris does', () => {
    const decoded = decodeCctpMessage(irisMessage.message as Hex);
    const body = expected.decodedMessageBody;

    expect(decoded.version).toBe(1);
    expect(decoded.sourceDomain).toBe(Number(expected.sourceDomain));
    expect(decoded.destinationDomain).toBe(Number(expected.destinationDomain));
    expect(decoded.nonce).toBe(expected.nonce);
    expect(bytes32ToAddress(decoded.sender)).toBe(getAddress(expected.sender));
    expect(bytes32ToAddress(decoded.recipient)).toBe(getAddress(expected.recipient));
    expect(bytes32ToAddress(decoded.destinationCaller)).toBe(
      getAddress(expected.destinationCaller),
    );
    expect(decoded.minFinalityThreshold).toBe(Number(expected.minFinalityThreshold));
    expect(decoded.finalityThresholdExecuted).toBe(Number(expected.finalityThresholdExecuted));

    expect(decoded.body.version).toBe(1);
    expect(bytes32ToAddress(decoded.body.burnToken)).toBe(getAddress(body.burnToken));
    expect(bytes32ToAddress(decoded.body.mintRecipient)).toBe(getAddress(body.mintRecipient));
    expect(decoded.body.amount).toBe(BigInt(body.amount));
    expect(bytes32ToAddress(decoded.body.messageSender)).toBe(getAddress(body.messageSender));
    expect(decoded.body.maxFee).toBe(BigInt(body.maxFee));
    expect(decoded.body.feeExecuted).toBe(BigInt(body.feeExecuted));
    expect(decoded.body.expirationBlock).toBe(BigInt(body.expirationBlock));
    expect(decoded.body.hookData).toBe(body.hookData);
  });

  it('round-trips through encodeCctpMessage', () => {
    const message = irisMessage.message as Hex;
    expect(encodeCctpMessage(decodeCctpMessage(message))).toBe(message);
  });

  it('accepts a burn message without hook data', () => {
    const decoded = decodeCctpMessage(irisMessage.message as Hex);
    const bare = encodeCctpMessage({ ...decoded, body: { ...decoded.body, hookData: '0x' } });
    expect(decodeCctpMessage(bare).body.hookData).toBe('0x');
  });

  it.each([
    ['empty', '0x'],
    ['too short', `0x${'00'.repeat(375)}`],
    ['not hex', 'hello'],
  ])('rejects %s input', (_name, input) => {
    expect(() => decodeCctpMessage(input as Hex)).toThrow(
      expect.objectContaining({ code: 'INVALID_CCTP_MESSAGE' }),
    );
  });
});

describe('address <-> bytes32', () => {
  const address = getAddress('0x21ee1e8bffd84599b69812a0f280181e1e3e0121');

  it('round-trips', () => {
    const bytes32 = addressToBytes32(address);
    expect(bytes32).toBe('0x00000000000000000000000021ee1e8bffd84599b69812a0f280181e1e3e0121');
    expect(bytes32ToAddress(bytes32)).toBe(address);
  });

  it('refuses bytes32 values that are not left-padded addresses', () => {
    try {
      bytes32ToAddress(`0x01${'00'.repeat(31)}`);
      expect.fail('should throw');
    } catch (error) {
      expect(isCauceError(error, 'INVALID_CCTP_MESSAGE')).toBe(true);
    }
  });
});
