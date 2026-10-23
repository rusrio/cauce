/**
 * End to end against anvil: the real CauceVault/CauceRelay bytecode, Circle-like CCTP mocks
 * (contracts/test/mocks) and the relayer talking JSON-RPC through viem. Only Iris is mocked.
 *
 * Requires Foundry (`anvil`) and `forge build` in contracts/. Skipped when unavailable unless
 * CAUCE_E2E=1, which CI sets so a missing toolchain fails loudly.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  addressToBytes32,
  cauceVaultAbi,
  createCauceConfig,
  encodeCctpMessage,
  encodeHookData,
  messageTransmitterV2Abi,
  type CauceConfig,
} from '@cauce/core';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCauceRelayer } from '../src/relayer';

const CONTRACTS_OUT = fileURLToPath(new URL('../../../contracts/out/', import.meta.url));
const anvilAvailable = spawnSync('anvil', ['--version']).status === 0;
const artifactsAvailable = existsSync(`${CONTRACTS_OUT}CauceRelay.sol/CauceRelay.json`);
const required = process.env.CAUCE_E2E === '1';
const runnable = anvilAvailable && artifactsAvailable;

if (required && !runnable) {
  throw new Error(`CAUCE_E2E=1 but anvil=${anvilAvailable} artifacts=${artifactsAvailable}`);
}

// Anvil's well-known dev keys (test only).
const deployer = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const relayerAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const ARC_DOMAIN = 26;
const BASE_DOMAIN = 6;
const REMOTE_TOKEN_MESSENGER: Hex = `0x${'00'.repeat(30)}ba5e`;
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const PAYER: Address = '0x3333333333333333333333333333333333333333';
const ATTESTATION: Hex = '0x01';

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS_OUT}${file}/${name}.json`, 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

describe.skipIf(!runnable)('relayer end to end (anvil)', () => {
  let anvil: ChildProcess;
  let publicClient: PublicClient;
  let rpcUrl: string;
  let contracts: {
    usdc: Address;
    transmitter: Address;
    tokenMessenger: Address;
    vault: Address;
    relay: Address;
  };
  let nonce = 0;

  beforeAll(async () => {
    const port = await freePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' });
    const chain = defineChain({
      id: 31337,
      name: 'Anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    for (let attempt = 0; ; attempt++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (error) {
        if (attempt > 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const wallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
    const deploy = async (file: string, name: string, args: readonly unknown[] = []) => {
      const { abi, bytecode } = artifact(file, name);
      const hash = await wallet.deployContract({ abi, bytecode, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error(`${name} not deployed`);
      return receipt.contractAddress;
    };
    const call = async (
      address: Address,
      abi: Abi,
      functionName: string,
      args: readonly unknown[],
    ) => {
      const hash = await wallet.writeContract({ address, abi, functionName, args });
      await publicClient.waitForTransactionReceipt({ hash });
    };

    const usdc = await deploy('MockUSDC.sol', 'MockUSDC');
    const transmitter = await deploy('MockCctp.sol', 'MockMessageTransmitter', [ARC_DOMAIN]);
    const tokenMessenger = await deploy('MockCctp.sol', 'MockTokenMessenger', [transmitter, usdc]);
    const vault = await deploy('CauceVault.sol', 'CauceVault', [usdc]);
    const relay = await deploy('CauceRelay.sol', 'CauceRelay', [
      transmitter,
      tokenMessenger,
      vault,
    ]);
    await call(vault, cauceVaultAbi, 'setRelay', [relay]);
    await call(
      tokenMessenger,
      artifact('MockCctp.sol', 'MockTokenMessenger').abi,
      'addRemoteTokenMessenger',
      [BASE_DOMAIN, REMOTE_TOKEN_MESSENGER],
    );
    contracts = { usdc, transmitter, tokenMessenger, vault, relay };
  }, 120_000);

  afterAll(() => {
    anvil.kill();
  });

  /** A burn as Iris would return it once attested. */
  function burn(overrides: { mintRecipient?: Address; hookData?: Hex; amount?: bigint } = {}) {
    nonce += 1;
    const message = encodeCctpMessage({
      version: 1,
      sourceDomain: BASE_DOMAIN,
      destinationDomain: ARC_DOMAIN,
      nonce: keccak256(`0x${nonce.toString(16).padStart(2, '0')}`),
      sender: REMOTE_TOKEN_MESSENGER,
      recipient: addressToBytes32(contracts.tokenMessenger),
      destinationCaller: addressToBytes32(contracts.relay),
      minFinalityThreshold: 1000,
      finalityThresholdExecuted: 1000,
      body: {
        version: 1,
        burnToken: addressToBytes32('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
        mintRecipient: addressToBytes32(overrides.mintRecipient ?? contracts.vault),
        amount: overrides.amount ?? 25_004_501n,
        messageSender: addressToBytes32(PAYER),
        maxFee: 4_501n,
        feeExecuted: 3_251n,
        expirationBlock: 0n,
        hookData:
          overrides.hookData ?? encodeHookData({ merchant: MERCHANT, orderId: `order-${nonce}` }),
      },
    });
    const burnTxHash: Hash = `0x${nonce.toString(16).padStart(64, '0')}`;
    return { message, request: { burnTxHash, sourceDomain: BASE_DOMAIN } };
  }

  function relayerFor(message: Hex) {
    const config: CauceConfig = createCauceConfig({
      environment: 'testnet',
      chains: [baseSepolia],
      relayerUrl: 'https://shop.dev/api/cauce',
      settlement: {
        chain: publicClient.chain!,
        domain: ARC_DOMAIN,
        usdc: contracts.usdc,
        messageTransmitter: contracts.transmitter,
        tokenMessenger: contracts.tokenMessenger,
        vault: contracts.vault,
        relay: contracts.relay,
      },
      iris: {
        fetch: () =>
          Promise.resolve(
            Response.json({
              messages: [
                {
                  message,
                  attestation: ATTESTATION,
                  status: 'complete',
                  eventNonce: '1',
                  cctpVersion: 2,
                },
              ],
            }),
          ),
      },
    });
    return createCauceRelayer({ config, account: relayerAccount, transport: http(rpcUrl) });
  }

  const balanceOf = (account: Address) =>
    publicClient.readContract({
      address: contracts.vault,
      abi: cauceVaultAbi,
      functionName: 'balances',
      args: [account],
    });

  it('settles a payment on-chain and credits the merchant with the minted amount', async () => {
    const { message, request } = burn();
    const before = await balanceOf(MERCHANT);

    const result = await relayerFor(message).settle(request, {
      pollIntervalMs: 50,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe('settled');
    expect(result.settlementTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await balanceOf(MERCHANT)) - before).toBe(25_004_501n - 3_251n);
    const receipt = await publicClient.getTransactionReceipt({ hash: result.settlementTxHash! });
    expect(receipt.from.toLowerCase()).toBe(relayerAccount.address.toLowerCase());
    expect(
      await publicClient.readContract({
        address: contracts.transmitter,
        abi: messageTransmitterV2Abi,
        functionName: 'usedNonces',
        args: [keccak256(`0x${nonce.toString(16).padStart(2, '0')}`)],
      }),
    ).toBe(1n);
  });

  it('is idempotent across relayer instances: a fresh one finds the existing settlement', async () => {
    const { message, request } = burn();
    const first = await relayerFor(message).settle(request, { pollIntervalMs: 50 });
    const txCount = await publicClient.getTransactionCount({ address: relayerAccount.address });

    const second = await relayerFor(message).submit(request);

    expect(second).toEqual({
      ...request,
      status: 'settled',
      settlementTxHash: first.settlementTxHash,
    });
    expect(await publicClient.getTransactionCount({ address: relayerAccount.address })).toBe(
      txCount,
    );
  });

  it('spends no gas on a burn minted to someone else', async () => {
    const { message, request } = burn({ mintRecipient: PAYER });
    const txCount = await publicClient.getTransactionCount({ address: relayerAccount.address });

    const result = await relayerFor(message).submit(request);

    expect(result).toMatchObject({ status: 'failed' });
    expect(await publicClient.getTransactionCount({ address: relayerAccount.address })).toBe(
      txCount,
    );
  });

  it('relays undecodable hookData so the vault refunds the payer', async () => {
    const { message, request } = burn({ hookData: '0xdeadbeef' });
    const before = await balanceOf(PAYER);

    const result = await relayerFor(message).settle(request, { pollIntervalMs: 50 });

    expect(result.status).toBe('settled');
    expect((await balanceOf(PAYER)) - before).toBe(25_004_501n - 3_251n);
  });
});
