import { toFunctionSignature } from 'viem';
import { describe, expect, it } from 'vitest';
import { cauceRelayAbi, cauceVaultAbi, tokenMessengerV2Abi } from './index';

function signatures(abi: readonly { type: string }[]): string[] {
  return abi.flatMap((item) =>
    item.type === 'function' ? [toFunctionSignature(item as Parameters<typeof toFunctionSignature>[0])] : [],
  );
}

describe('contract ABIs', () => {
  it('exposes the vault entry points Cauce relies on', () => {
    expect(signatures(cauceVaultAbi)).toEqual(
      expect.arrayContaining([
        'pay(uint256,bytes)',
        'settle(uint32,bytes32,address,uint256,bytes)',
        'withdraw(uint256)',
        'balances(address)',
      ]),
    );
  });

  it('exposes relayPayment on the relay', () => {
    expect(signatures(cauceRelayAbi)).toContain('relayPayment(bytes,bytes)');
  });

  it('matches the CCTP V2 depositForBurnWithHook signature', () => {
    expect(signatures(tokenMessengerV2Abi)).toEqual([
      'depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)',
    ]);
  });
});
