import { CauceError } from '@cauce/core';
import type { LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const DEFAULT_RELAYER_KEY_VARIABLE = 'CAUCE_RELAYER_PRIVATE_KEY';

/**
 * Builds the relayer account from a server-side environment variable. The key never leaves the
 * server: errors name the variable, never its value. Do not prefix the variable with
 * NEXT_PUBLIC_ (or any bundler's public prefix).
 */
export function relayerAccountFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  variable: string = DEFAULT_RELAYER_KEY_VARIABLE,
): LocalAccount {
  if (/^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_)/.test(variable)) {
    throw new CauceError(
      'INVALID_CONFIG',
      `${variable} would be exposed to the browser; use a server-only variable`,
    );
  }
  const raw = env[variable]?.trim();
  if (!raw) {
    throw new CauceError('INVALID_CONFIG', `${variable} is not set`);
  }
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new CauceError('INVALID_CONFIG', `${variable} is not a 32-byte hex private key`);
  }
  return privateKeyToAccount(key as `0x${string}`);
}
