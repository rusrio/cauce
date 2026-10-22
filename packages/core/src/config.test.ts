import { getAddress, type Address, type Chain } from 'viem';
import { arcTestnet, base, baseSepolia, optimismSepolia, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { createCauceConfig, type CreateCauceConfigOptions } from './config';
import { cctpPresets, deploymentPresets, irisUrls } from './presets';

const vault: Address = '0x00000000000000000000000000000000000000Aa';
const relay: Address = '0x00000000000000000000000000000000000000bB';

function config(overrides: Partial<CreateCauceConfigOptions> = {}) {
  return createCauceConfig({
    environment: 'testnet',
    chains: [sepolia, baseSepolia],
    relayerUrl: 'https://shop.example/api/cauce/',
    settlement: { vault, relay },
    ...overrides,
  });
}

describe('createCauceConfig', () => {
  it('resolves testnet settlement on Arc Testnet from the presets', () => {
    const { settlement } = config();

    expect(settlement).toEqual({
      chain: arcTestnet,
      domain: 26,
      usdc: '0x3600000000000000000000000000000000000000',
      messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      vault: getAddress(vault),
      relay: getAddress(relay),
    });
  });

  it('resolves source chains and routes', () => {
    const cfg = config();

    expect(cfg.sourceChains.map((c) => [c.chainId, c.domain])).toEqual([
      [sepolia.id, 0],
      [baseSepolia.id, 6],
    ]);
    expect(cfg.getSourceChain(baseSepolia.id)).toMatchObject({
      chain: baseSepolia,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
    expect(cfg.getRoute(baseSepolia.id)).toBe('cctp');
    expect(cfg.getRoute(arcTestnet.id)).toBe('direct');
    expect(cfg.getRoute(1)).toBeUndefined();
  });

  it('ignores the settlement chain and duplicates in `chains`', () => {
    const cfg = config({ chains: [sepolia, arcTestnet, sepolia] });
    expect(cfg.sourceChains.map((c) => c.chainId)).toEqual([sepolia.id]);
  });

  it('throws UNSUPPORTED_CHAIN for chains without a preset', () => {
    expect(() => config({ chains: [optimismSepolia] })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CHAIN' }),
    );
    expect(() => config().getSourceChain(optimismSepolia.id)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CHAIN' }),
    );
  });

  it('does not mix environments', () => {
    expect(() => config({ chains: [base] })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CHAIN' }),
    );
  });

  it('accepts new chains through cctpOverrides', () => {
    const cfg = config({
      chains: [optimismSepolia],
      cctpOverrides: {
        [optimismSepolia.id]: {
          domain: 2,
          tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
          messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
          usdc: '0x00000000000000000000000000000000000000C0',
        },
      },
    });
    expect(cfg.getSourceChain(optimismSepolia.id).domain).toBe(2);
  });

  it('requires an explicit deployment where there is no preset', () => {
    if (deploymentPresets.mainnet) return;
    expect(() =>
      createCauceConfig({ environment: 'mainnet', chains: [base], relayerUrl: 'https://x.dev' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('builds a mainnet config with an explicit deployment', () => {
    const cfg = createCauceConfig({
      environment: 'mainnet',
      chains: [base],
      relayerUrl: 'https://x.dev',
      settlement: { vault, relay },
    });
    expect(cfg.settlement.domain).toBe(26);
    expect(cfg.settlement.messageTransmitter).toBe('0x81D40F21F12A8F0E3252Bccb954D722d4c464B64');
    expect(cfg.iris.baseUrl).toBe(irisUrls.mainnet);
  });

  it('uses the sandbox Iris API on testnet unless overridden', () => {
    expect(config().iris.baseUrl).toBe('https://iris-api-sandbox.circle.com');
    expect(config({ iris: { baseUrl: 'https://iris.proxy.dev/' } }).iris.baseUrl).toBe(
      'https://iris.proxy.dev',
    );
  });

  it('normalizes the relayer URL', () => {
    expect(config().relayerUrl).toBe('https://shop.example/api/cauce');
  });

  it.each<[string, Partial<CreateCauceConfigOptions>]>([
    ['an invalid relayer URL', { relayerUrl: 'not a url' }],
    ['a non-http relayer URL', { relayerUrl: 'ftp://relayer.dev' }],
    ['an invalid vault address', { settlement: { vault: '0x123', relay } }],
    ['a negative fee buffer', { fees: { bufferBps: -1 } }],
    ['a negative fee cap', { fees: { maxFeeCap: -1n } }],
    ['an unknown environment', { environment: 'devnet' as 'testnet' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => config(overrides)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('defaults to fast transfers with a small fee buffer', () => {
    expect(config().fees).toEqual({ speed: 'fast', bufferBps: 0.5, maxFeeCap: undefined });
  });

  it('returns a frozen object', () => {
    const cfg = config();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.settlement)).toBe(true);
    expect(Object.isFrozen(cfg.sourceChains)).toBe(true);
  });
});

describe('presets', () => {
  it('uses one CCTP V2 TokenMessenger/MessageTransmitter pair per environment', () => {
    for (const env of ['testnet', 'mainnet'] as const) {
      const presets = Object.values(cctpPresets[env]);
      expect(new Set(presets.map((p) => p.tokenMessenger)).size).toBe(1);
      expect(new Set(presets.map((p) => p.messageTransmitter)).size).toBe(1);
    }
  });

  it('keys every preset by its own chain id', () => {
    for (const env of ['testnet', 'mainnet'] as const) {
      for (const [chainId, preset] of Object.entries(cctpPresets[env])) {
        expect(preset.chainId).toBe(Number(chainId));
      }
    }
  });

  it('is immutable', () => {
    const presets = cctpPresets.testnet as Record<number, unknown>;
    expect(() => {
      presets[1] = {};
    }).toThrow(TypeError);
    const chain: Chain = sepolia;
    expect(Object.isFrozen(cctpPresets.testnet[chain.id])).toBe(true);
  });
});
