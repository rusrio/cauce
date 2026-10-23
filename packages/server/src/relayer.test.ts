import { addressToBytes32 } from '@cauce/core';
import { keccak256, zeroHash, type Hash } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRelayJobStore, relayJobKey } from './store';
import {
  ATTESTATION,
  BURN_TX,
  cctpMessage,
  irisComplete,
  irisNotFound,
  irisPending,
  MERCHANT,
  relayRevert,
  RELAYER_ACCOUNT,
  SOURCE_DOMAIN,
  testRelayer,
  VAULT,
} from './test-helpers';

const request = { burnTxHash: BURN_TX, sourceDomain: SOURCE_DOMAIN };
const txHash = (n: number): Hash => `0x${n.toString(16).padStart(64, '0')}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('CauceRelayer — happy path', () => {
  it('waits for Circle, relays once, then reports settlement', async () => {
    const message = cctpMessage();
    const { relayer, chain } = testRelayer([irisNotFound, irisPending, irisComplete(message)]);

    expect(await relayer.submit(request)).toEqual({ ...request, status: 'attesting' });
    expect(await relayer.getStatus(request)).toEqual({ ...request, status: 'attesting' });

    const relaying = await relayer.getStatus(request);
    expect(relaying).toEqual({ ...request, status: 'relaying', settlementTxHash: txHash(1) });
    expect(chain.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        account: RELAYER_ACCOUNT,
        functionName: 'relayPayment',
        args: [message, ATTESTATION],
      }),
    );
    expect(chain.sent).toHaveLength(1);

    // Not mined yet.
    expect(await relayer.getStatus(request)).toMatchObject({ status: 'relaying' });

    chain.mine(txHash(1));
    expect(await relayer.getStatus(request)).toEqual({
      ...request,
      status: 'settled',
      settlementTxHash: txHash(1),
    });
    expect(chain.sent).toHaveLength(1);
  });

  it('is idempotent: re-submitting returns the same job', async () => {
    const { relayer, chain } = testRelayer([irisComplete(cctpMessage())]);

    await relayer.submit(request);
    chain.mine(txHash(1));
    await relayer.submit(request);
    const again = await relayer.submit(request);

    expect(again).toMatchObject({ status: 'settled', settlementTxHash: txHash(1) });
    expect(chain.sent).toHaveLength(1);
  });

  it('sends a single transaction for concurrent requests', async () => {
    const { relayer, chain } = testRelayer([irisComplete(cctpMessage())]);

    await Promise.all([
      relayer.submit(request),
      relayer.submit(request),
      relayer.getStatus(request),
    ]);

    expect(chain.sent).toHaveLength(1);
  });

  it('sends a single transaction across instances sharing a store', async () => {
    const store = createMemoryRelayJobStore();
    const a = testRelayer([irisComplete(cctpMessage())], { store });
    const b = testRelayer([irisComplete(cctpMessage())], { store });

    await Promise.all([a.relayer.submit(request), b.relayer.submit(request)]);

    expect(a.chain.sent.length + b.chain.sent.length).toBe(1);
  });

  it('treats burn hashes case-insensitively', async () => {
    const { relayer } = testRelayer([irisNotFound]);

    await relayer.submit({ ...request, burnTxHash: `0x${'B0'.repeat(32)}` });

    expect(await relayer.getStatus(request)).toMatchObject({ status: 'attesting' });
  });
});

describe('CauceRelayer — never spends gas on payments it must not relay', () => {
  it.each([
    [
      'a burn minted to someone else',
      cctpMessage(
        {},
        { mintRecipient: addressToBytes32('0x00000000000000000000000000000000000000Cc') },
      ),
      'The transaction contains no payment for this Cauce deployment',
    ],
    [
      'a generic message to another recipient',
      cctpMessage({ recipient: addressToBytes32('0x00000000000000000000000000000000000000Dd') }),
      'Not a USDC burn handled by the CCTP TokenMessenger',
    ],
    [
      'a message anyone can receive (destinationCaller = 0)',
      cctpMessage({ destinationCaller: zeroHash }),
      'The message is not reserved for this CauceRelay (destinationCaller)',
    ],
    [
      'a message for another chain',
      cctpMessage({ destinationDomain: 3 }),
      'The transaction contains no payment for this Cauce deployment',
    ],
  ])('rejects %s', async (_name, message, error) => {
    const { relayer, chain } = testRelayer([irisComplete(message)]);

    expect(await relayer.submit(request)).toEqual({ ...request, status: 'failed', error });
    expect(chain.publicClient.simulateContract).not.toHaveBeenCalled();
    expect(chain.sent).toHaveLength(0);
  });

  it('only serves configured merchants', async () => {
    const other = testRelayer([irisComplete(cctpMessage())], {
      policy: { merchants: ['0x2222222222222222222222222222222222222222'] },
    });
    expect(await other.relayer.submit(request)).toMatchObject({
      status: 'failed',
      error: `Merchant ${MERCHANT} is not served by this relayer`,
    });

    const own = testRelayer([irisComplete(cctpMessage())], {
      policy: { merchants: [MERCHANT.toLowerCase() as typeof MERCHANT] },
    });
    expect(await own.relayer.submit(request)).toMatchObject({ status: 'relaying' });
  });

  it('with a merchant allowlist, refuses undecodable hookData', async () => {
    const { relayer } = testRelayer([irisComplete(cctpMessage({}, { hookData: '0xdeadbeef' }))], {
      policy: { merchants: [MERCHANT] },
    });
    expect(await relayer.submit(request)).toMatchObject({ status: 'failed' });
  });

  it('without an allowlist, still relays undecodable hookData so the vault refunds the payer', async () => {
    const { relayer, chain } = testRelayer([
      irisComplete(cctpMessage({}, { hookData: '0xdeadbeef' })),
    ]);
    expect(await relayer.submit(request)).toMatchObject({ status: 'relaying' });
    expect(chain.sent).toHaveLength(1);
  });

  it('enforces the minimum amount on what is actually minted', async () => {
    const message = cctpMessage({}, { amount: 1_000n, feeExecuted: 10n });
    const below = testRelayer([irisComplete(message)], { policy: { minAmount: 991n } });
    expect(await below.relayer.submit(request)).toMatchObject({ status: 'failed' });

    const exact = testRelayer([irisComplete(message)], { policy: { minAmount: 990n } });
    expect(await exact.relayer.submit(request)).toMatchObject({ status: 'relaying' });
  });

  it('rejects source domains that are not configured', async () => {
    const { relayer } = testRelayer([irisNotFound]);
    await expect(relayer.submit({ ...request, sourceDomain: 0 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CHAIN',
    });
  });

  it('fails without sending when CauceRelay would revert', async () => {
    const { relayer, chain } = testRelayer([irisComplete(cctpMessage())]);
    chain.setSimulateError(
      relayRevert({ errorName: 'CauceRelay__WrongMintRecipient', args: [addressToBytes32(VAULT)] }),
    );

    expect(await relayer.submit(request)).toEqual({
      ...request,
      status: 'failed',
      error: 'CauceRelay rejected the payment: CauceRelay__WrongMintRecipient',
    });
    expect(chain.sent).toHaveLength(0);
  });

  it('reports expired attestations as a terminal failure', async () => {
    const { relayer, chain } = testRelayer([irisComplete(cctpMessage())]);
    chain.setSimulateError(relayRevert({ reason: 'Message expired and must be re-signed' }));

    expect(await relayer.submit(request)).toEqual({
      ...request,
      status: 'failed',
      error: 'The attestation expired; the message must be re-attested by Circle',
    });
  });
});

describe('CauceRelayer — already settled by someone else', () => {
  it('detects a used nonce and finds the relay transaction in older blocks', async () => {
    const message = cctpMessage();
    const { relayer, chain } = testRelayer([irisComplete(message)], { logChunkBlocks: 10_000n });
    chain.setNonceUsed();
    chain.setRelayedLog({ blockRange: [215_000n, 215_000n], transactionHash: txHash(0xabc) });

    expect(await relayer.submit(request)).toEqual({
      ...request,
      status: 'settled',
      settlementTxHash: txHash(0xabc),
    });
    expect(chain.sent).toHaveLength(0);
    expect(chain.publicClient.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'PaymentRelayed',
        args: { messageHash: keccak256(message) },
      }),
    );
  });

  it('treats a "Nonce already used" simulation revert as settled', async () => {
    const { relayer, chain } = testRelayer([irisComplete(cctpMessage())]);
    chain.setSimulateError(relayRevert({ reason: 'Nonce already used' }));
    chain.setRelayedLog({ blockRange: [249_990n, 249_990n], transactionHash: txHash(7) });

    expect(await relayer.submit(request)).toMatchObject({
      status: 'settled',
      settlementTxHash: txHash(7),
    });
  });

  it('re-evaluates after its own relay transaction reverts', async () => {
    const { relayer, chain } = testRelayer([irisComplete(cctpMessage())]);
    await relayer.submit(request);
    chain.mine(txHash(1), 'reverted');

    expect(await relayer.getStatus(request)).toMatchObject({ status: 'attesting' });

    chain.setNonceUsed();
    chain.setRelayedLog({ blockRange: [249_000n, 249_000n], transactionHash: txHash(9) });
    expect(await relayer.getStatus(request)).toMatchObject({
      status: 'settled',
      settlementTxHash: txHash(9),
    });
  });
});

describe('CauceRelayer — transient failures never fail a payment', () => {
  it('keeps attesting while Iris is unreachable', async () => {
    const { relayer } = testRelayer(['network-error', irisComplete(cctpMessage())]);

    expect(await relayer.submit(request)).toEqual({ ...request, status: 'attesting' });
    expect(await relayer.getStatus(request)).toMatchObject({ status: 'relaying' });
  });

  it('releases its claim when sending fails for a non-revert reason', async () => {
    const { relayer, chain, store } = testRelayer([irisComplete(cctpMessage())]);
    chain.setSimulateError(new Error('socket hang up'));

    expect(await relayer.submit(request)).toEqual({ ...request, status: 'attesting' });
    expect((await store.get(relayJobKey(SOURCE_DOMAIN, BURN_TX)))?.lastError).toBe(
      'socket hang up',
    );

    chain.setSimulateError(undefined);
    expect(await relayer.getStatus(request)).toMatchObject({ status: 'relaying' });
  });

  it('resends when the relay transaction was dropped', async () => {
    const { relayer, chain, advanceClock } = testRelayer([irisComplete(cctpMessage())], {
      claimTimeoutMs: 60_000,
    });
    await relayer.submit(request);
    chain.drop(txHash(1));

    expect(await relayer.getStatus(request)).toMatchObject({ settlementTxHash: txHash(1) });
    advanceClock(60_001);
    expect(await relayer.getStatus(request)).toMatchObject({ status: 'attesting' });
    expect(await relayer.getStatus(request)).toMatchObject({
      status: 'relaying',
      settlementTxHash: txHash(2),
    });
  });

  it('takes over a claim abandoned by a crashed instance', async () => {
    const store = createMemoryRelayJobStore();
    await store.create(relayJobKey(SOURCE_DOMAIN, BURN_TX), {
      ...request,
      status: 'relaying',
      createdAt: 0,
      updatedAt: 1_000_000,
      version: 3,
    });
    const { relayer, chain, advanceClock } = testRelayer([irisComplete(cctpMessage())], {
      store,
      claimTimeoutMs: 60_000,
    });

    expect(await relayer.getStatus(request)).toMatchObject({ status: 'relaying' });
    expect(chain.sent).toHaveLength(0);

    advanceClock(60_000);
    expect(await relayer.getStatus(request)).toMatchObject({ settlementTxHash: txHash(1) });
  });
});

describe('CauceRelayer.settle', () => {
  it('drives a payment to settlement', async () => {
    vi.useFakeTimers();
    const { relayer, chain } = testRelayer([irisNotFound, irisComplete(cctpMessage())]);

    const result = relayer.settle(request, { pollIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    chain.mine(txHash(1));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toMatchObject({ status: 'settled', settlementTxHash: txHash(1) });
  });

  it('returns a failed payment immediately', async () => {
    const { relayer } = testRelayer([irisComplete(cctpMessage({ destinationCaller: zeroHash }))]);
    await expect(relayer.settle(request)).resolves.toMatchObject({ status: 'failed' });
  });

  it('can be aborted', async () => {
    vi.useFakeTimers();
    const { relayer } = testRelayer([irisNotFound]);
    const controller = new AbortController();

    const result = relayer.settle(request, { signal: controller.signal, pollIntervalMs: 1_000 });
    const assertion = expect(result).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
  });
});

describe('CauceRelayer — misc', () => {
  it('exposes the gas-paying address', () => {
    expect(testRelayer([irisNotFound]).relayer.address).toBe(RELAYER_ACCOUNT.address);
  });

  it('returns undefined for unknown payments', async () => {
    expect(await testRelayer([irisNotFound]).relayer.getStatus(request)).toBeUndefined();
  });
});
