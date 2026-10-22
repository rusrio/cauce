/**
 * The only module in Cauce that contains addresses, CCTP domains and service URLs.
 *
 * Bump CAUCE_PRESETS_VERSION (and add a changeset) whenever any value here changes, so apps can
 * tell which deployment they are talking to. Sources:
 * - CCTP V2 contracts and domains: https://developers.circle.com/cctp/references/contract-addresses
 * - USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - Cauce deployments: broadcast output of contracts/script/DeployCauce.s.sol
 */
import type { Address, Chain } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  arc,
  arcTestnet,
  base,
  baseSepolia,
  mainnet,
  sepolia,
} from 'viem/chains';

export const CAUCE_PRESETS_VERSION = '1.0.0';

export type CauceEnvironment = 'testnet' | 'mainnet';

export interface CctpChainPreset {
  chainId: number;
  /** Circle's CCTP domain id (not the EVM chain id). */
  domain: number;
  tokenMessenger: Address;
  messageTransmitter: Address;
  usdc: Address;
}

/** A Cauce deployment (CauceVault + CauceRelay) on a settlement chain. */
export interface CauceDeployment {
  chainId: number;
  vault: Address;
  relay: Address;
}

const CCTP_V2_TESTNET = {
  tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
} as const satisfies Partial<CctpChainPreset>;

const CCTP_V2_MAINNET = {
  tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
} as const satisfies Partial<CctpChainPreset>;

/** Arc's ERC-20 interface to its native USDC (6 decimals), identical on testnet and mainnet. */
const ARC_USDC = '0x3600000000000000000000000000000000000000';

function byChainId(presets: CctpChainPreset[]): Readonly<Record<number, CctpChainPreset>> {
  return Object.freeze(Object.fromEntries(presets.map((p) => [p.chainId, Object.freeze(p)])));
}

export const cctpPresets: Readonly<
  Record<CauceEnvironment, Readonly<Record<number, CctpChainPreset>>>
> = Object.freeze({
  testnet: byChainId([
    {
      chainId: sepolia.id,
      domain: 0,
      ...CCTP_V2_TESTNET,
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    },
    {
      chainId: arbitrumSepolia.id,
      domain: 3,
      ...CCTP_V2_TESTNET,
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    },
    {
      chainId: baseSepolia.id,
      domain: 6,
      ...CCTP_V2_TESTNET,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    { chainId: arcTestnet.id, domain: 26, ...CCTP_V2_TESTNET, usdc: ARC_USDC },
  ]),
  mainnet: byChainId([
    {
      chainId: mainnet.id,
      domain: 0,
      ...CCTP_V2_MAINNET,
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    },
    {
      chainId: arbitrum.id,
      domain: 3,
      ...CCTP_V2_MAINNET,
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    },
    {
      chainId: base.id,
      domain: 6,
      ...CCTP_V2_MAINNET,
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    { chainId: arc.id, domain: 26, ...CCTP_V2_MAINNET, usdc: ARC_USDC },
  ]),
});

/** Where payments settle by default in each environment. */
export const settlementChains: Readonly<Record<CauceEnvironment, Chain>> = Object.freeze({
  testnet: arcTestnet,
  mainnet: arc,
});

/**
 * Official Cauce deployments. Environments without an entry require `settlement.vault` and
 * `settlement.relay` in createCauceConfig.
 */
export const deploymentPresets: Readonly<Partial<Record<CauceEnvironment, CauceDeployment>>> =
  Object.freeze({});

export const irisUrls: Readonly<Record<CauceEnvironment, string>> = Object.freeze({
  testnet: 'https://iris-api-sandbox.circle.com',
  mainnet: 'https://iris-api.circle.com',
});
