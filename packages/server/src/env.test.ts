import { describe, expect, it } from 'vitest';
import { relayerAccountFromEnv } from './env';

// Anvil's first well-known test key; never holds real funds.
const TEST_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('relayerAccountFromEnv', () => {
  it('reads the key from CAUCE_RELAYER_PRIVATE_KEY, with or without 0x', () => {
    const expected = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    expect(relayerAccountFromEnv({ CAUCE_RELAYER_PRIVATE_KEY: TEST_KEY }).address).toBe(expected);
    expect(relayerAccountFromEnv({ CAUCE_RELAYER_PRIVATE_KEY: ` 0x${TEST_KEY}\n` }).address).toBe(
      expected,
    );
  });

  it('supports a custom variable name', () => {
    expect(relayerAccountFromEnv({ RELAYER_KEY: TEST_KEY }, 'RELAYER_KEY').type).toBe('local');
  });

  it('fails clearly when the variable is missing', () => {
    expect(() => relayerAccountFromEnv({})).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: 'CAUCE_RELAYER_PRIVATE_KEY is not set',
      }),
    );
  });

  it('never echoes a malformed key', () => {
    const secretish = 'deadbeef'.repeat(7);
    try {
      relayerAccountFromEnv({ CAUCE_RELAYER_PRIVATE_KEY: secretish });
      expect.fail('should throw');
    } catch (error) {
      expect(String(error)).not.toContain(secretish);
      expect(error).toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });

  it('refuses public (client-exposed) variable names', () => {
    expect(() =>
      relayerAccountFromEnv({ NEXT_PUBLIC_RELAYER_KEY: TEST_KEY }, 'NEXT_PUBLIC_RELAYER_KEY'),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
