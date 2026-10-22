import { getAddress, isAddress, type Address, type Chain } from 'viem';
import { CauceError } from './errors';
import { createIrisClient, type IrisClient, type IrisClientOptions } from './iris';
import { silentLogger, type CauceLogger } from './logger';
import {
  cctpPresets,
  deploymentPresets,
  irisUrls,
  settlementChains,
  type CauceEnvironment,
  type CctpChainPreset,
} from './presets';
import type { PaymentRoute } from './types';

/** The settlement side of Cauce: the chain where CauceVault and CauceRelay live. */
export interface CauceSettlement {
  chain: Chain;
  domain: number;
  usdc: Address;
  messageTransmitter: Address;
  tokenMessenger: Address;
  vault: Address;
  relay: Address;
}

export interface CauceSourceChain extends CctpChainPreset {
  chain: Chain;
}

export interface CauceFeeOptions {
  /** `fast` (finality 1000, pays Circle's fast-transfer fee) or `standard` (finality 2000, free). */
  speed: 'fast' | 'standard';
  /** Extra basis points on top of Circle's minimum fee, absorbing fee changes between quote and burn. */
  bufferBps: number;
  /** Highest maxFee Cauce will offer; above it the payment falls back to standard speed. */
  maxFeeCap?: bigint | undefined;
}

export interface CreateCauceConfigOptions {
  environment: CauceEnvironment;
  /** Source chains to accept payments from. Each needs a CCTP preset or a complete override. */
  chains: readonly Chain[];
  /** Base URL of the @cauce/server relayer. */
  relayerUrl: string;
  /** Overrides the settlement chain or deployment. Required where there is no deployment preset. */
  settlement?: Partial<CauceSettlement>;
  /** Per-chain overrides or additions to the CCTP presets, keyed by EVM chain id. */
  cctpOverrides?: Readonly<Record<number, Partial<Omit<CctpChainPreset, 'chainId'>>>>;
  fees?: Partial<CauceFeeOptions>;
  iris?: Partial<IrisClientOptions>;
  logger?: CauceLogger;
}

export interface CauceConfig {
  readonly environment: CauceEnvironment;
  readonly settlement: Readonly<CauceSettlement>;
  readonly sourceChains: readonly Readonly<CauceSourceChain>[];
  readonly relayerUrl: string;
  readonly fees: Readonly<CauceFeeOptions>;
  readonly iris: IrisClient;
  readonly logger: CauceLogger;
  /** `direct` on the settlement chain, `cctp` on a configured source chain, otherwise undefined. */
  getRoute(chainId: number): PaymentRoute | undefined;
  /** The CCTP settings of a configured source chain; throws UNSUPPORTED_CHAIN otherwise. */
  getSourceChain(chainId: number): Readonly<CauceSourceChain>;
}

export const DEFAULT_FEE_BUFFER_BPS = 0.5;

/** Validates and freezes the configuration shared by every Cauce package. */
export function createCauceConfig(options: CreateCauceConfigOptions): CauceConfig {
  const { environment } = options;
  if (!isOneOf(environment, ['testnet', 'mainnet'])) {
    throw invalidConfig(`environment must be "testnet" or "mainnet", got ${environment}`);
  }
  const overrides = options.cctpOverrides ?? {};
  const logger = options.logger ?? silentLogger;

  const settlement = resolveSettlement(environment, options.settlement, overrides);

  const sourceChains = new Map<number, Readonly<CauceSourceChain>>();
  for (const chain of options.chains) {
    if (chain.id === settlement.chain.id || sourceChains.has(chain.id)) continue;
    const preset = resolveCctpPreset(environment, chain.id, overrides);
    if (preset.domain === settlement.domain) {
      throw invalidConfig(`${chain.name} uses the settlement CCTP domain ${preset.domain}`);
    }
    sourceChains.set(chain.id, Object.freeze({ ...preset, chain }));
  }

  const fees = resolveFees(options.fees);
  const iris = createIrisClient({
    baseUrl: irisUrls[environment],
    logger,
    ...options.iris,
  });

  return Object.freeze({
    environment,
    settlement,
    sourceChains: Object.freeze([...sourceChains.values()]),
    relayerUrl: resolveRelayerUrl(options.relayerUrl),
    fees,
    iris,
    logger,
    getRoute(chainId: number): PaymentRoute | undefined {
      if (chainId === settlement.chain.id) return 'direct';
      return sourceChains.has(chainId) ? 'cctp' : undefined;
    },
    getSourceChain(chainId: number): Readonly<CauceSourceChain> {
      const source = sourceChains.get(chainId);
      if (!source) {
        throw new CauceError(
          'UNSUPPORTED_CHAIN',
          `Chain ${chainId} is not a configured source chain`,
          {
            details: { chainId, supported: [...sourceChains.keys()] },
          },
        );
      }
      return source;
    },
  });
}

function resolveSettlement(
  environment: CauceEnvironment,
  input: Partial<CauceSettlement> | undefined,
  overrides: NonNullable<CreateCauceConfigOptions['cctpOverrides']>,
): Readonly<CauceSettlement> {
  const chain = input?.chain ?? settlementChains[environment];
  const cctp = resolveCctpPreset(environment, chain.id, overrides, input);
  const deployment = deploymentPresets[environment];
  const preset = deployment?.chainId === chain.id ? deployment : undefined;

  const vault = input?.vault ?? preset?.vault;
  const relay = input?.relay ?? preset?.relay;
  if (!vault || !relay) {
    throw invalidConfig(
      `There is no Cauce deployment preset for ${chain.name} (${environment}); ` +
        'pass settlement.vault and settlement.relay',
    );
  }

  return Object.freeze({
    chain,
    domain: cctp.domain,
    usdc: cctp.usdc,
    messageTransmitter: cctp.messageTransmitter,
    tokenMessenger: cctp.tokenMessenger,
    vault: checkedAddress(vault, 'settlement.vault'),
    relay: checkedAddress(relay, 'settlement.relay'),
  });
}

function resolveCctpPreset(
  environment: CauceEnvironment,
  chainId: number,
  overrides: NonNullable<CreateCauceConfigOptions['cctpOverrides']>,
  extra: Partial<Omit<CctpChainPreset, 'chainId'>> = {},
): CctpChainPreset {
  const merged = { ...cctpPresets[environment][chainId], ...overrides[chainId], ...pick(extra) };
  const { domain, tokenMessenger, messageTransmitter, usdc } = merged;
  if (domain === undefined || !tokenMessenger || !messageTransmitter || !usdc) {
    throw new CauceError(
      'UNSUPPORTED_CHAIN',
      `Chain ${chainId} has no CCTP V2 preset for ${environment}; add it to cctpOverrides`,
      { details: { chainId, environment } },
    );
  }
  if (!Number.isInteger(domain) || domain < 0) {
    throw invalidConfig(`Invalid CCTP domain ${domain} for chain ${chainId}`);
  }
  return {
    chainId,
    domain,
    tokenMessenger: checkedAddress(tokenMessenger, `${chainId}.tokenMessenger`),
    messageTransmitter: checkedAddress(messageTransmitter, `${chainId}.messageTransmitter`),
    usdc: checkedAddress(usdc, `${chainId}.usdc`),
  };
}

/** Keeps only the CCTP fields of a settlement override that were actually provided. */
function pick(
  extra: Partial<Omit<CctpChainPreset, 'chainId'>>,
): Partial<Omit<CctpChainPreset, 'chainId'>> {
  const out: Partial<Omit<CctpChainPreset, 'chainId'>> = {};
  if (extra.domain !== undefined) out.domain = extra.domain;
  if (extra.tokenMessenger !== undefined) out.tokenMessenger = extra.tokenMessenger;
  if (extra.messageTransmitter !== undefined) out.messageTransmitter = extra.messageTransmitter;
  if (extra.usdc !== undefined) out.usdc = extra.usdc;
  return out;
}

function resolveFees(input: Partial<CauceFeeOptions> | undefined): Readonly<CauceFeeOptions> {
  const speed = input?.speed ?? 'fast';
  const bufferBps = input?.bufferBps ?? DEFAULT_FEE_BUFFER_BPS;
  const maxFeeCap = input?.maxFeeCap;
  if (!isOneOf(speed, ['fast', 'standard'])) throw invalidConfig(`Unknown fee speed ${speed}`);
  if (!Number.isFinite(bufferBps) || bufferBps < 0)
    throw invalidConfig('fees.bufferBps must be >= 0');
  if (maxFeeCap !== undefined && maxFeeCap < 0n) throw invalidConfig('fees.maxFeeCap must be >= 0');
  return Object.freeze({ speed, bufferBps, maxFeeCap });
}

function resolveRelayerUrl(relayerUrl: string): string {
  let url: URL;
  try {
    url = new URL(relayerUrl);
  } catch (error) {
    throw new CauceError('INVALID_CONFIG', `relayerUrl is not a valid URL: ${relayerUrl}`, {
      cause: error,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidConfig('relayerUrl must use http or https');
  }
  return url.toString().replace(/\/+$/, '');
}

function checkedAddress(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) throw invalidConfig(`${field} is not a valid address`);
  return getAddress(value);
}

/** Runtime guard for values typed as unions that may come from untyped (JS) callers. */
function isOneOf(value: string, allowed: readonly string[]): boolean {
  return allowed.includes(value);
}

function invalidConfig(message: string): CauceError {
  return new CauceError('INVALID_CONFIG', message);
}
