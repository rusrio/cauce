import {
  addressToBytes32,
  CauceError,
  cauceRelayAbi,
  decodeHookData,
  messageTransmitterV2Abi,
  type CauceConfig,
  type DecodedCctpMessage,
  type IrisMessage,
  type RelayRequest,
  type RelayStatusResponse,
} from '@cauce/core';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { createMemoryRelayJobStore, relayJobKey, type RelayJob, type RelayJobStore } from './store';

/** Fields to change on a job; `undefined` clears an optional field. */
type JobPatch = { [K in keyof RelayJob]?: RelayJob[K] | undefined };

export interface RelayerPolicy {
  /** Only pay gas for payments to these merchants. Strongly recommended for a shop's relayer. */
  merchants?: readonly Address[];
  /** Minimum USDC (base units) minted to the vault that is worth paying gas for. */
  minAmount?: bigint;
}

export interface CreateCauceRelayerOptions {
  config: CauceConfig;
  /** The relayer's account; pays gas on the settlement chain. See relayerAccountFromEnv. */
  account: Account;
  /** Transport to the settlement chain. Defaults to the chain's public RPC. */
  transport?: Transport;
  /** Pre-built clients for the settlement chain (they take precedence over `transport`). */
  publicClient?: PublicClient;
  walletClient?: WalletClient<Transport, Chain, Account>;
  store?: RelayJobStore;
  policy?: RelayerPolicy;
  /** A job claimed for sending but without a transaction after this long is retried. */
  claimTimeoutMs?: number;
  /** How far back to look for the relay transaction of a payment settled by someone else. */
  settlementLookbackBlocks?: bigint;
  logChunkBlocks?: bigint;
  now?: () => number;
}

export interface SettleOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface CauceRelayer {
  /** The address paying gas for relay transactions. */
  readonly address: Address;
  /** Registers a burn (idempotent) and advances it one step without blocking on Circle. */
  submit(request: RelayRequest): Promise<RelayStatusResponse>;
  /** Advances a known payment one step; undefined if it was never submitted. */
  getStatus(request: RelayRequest): Promise<RelayStatusResponse | undefined>;
  /** Advances a payment until it is settled or failed, e.g. inside waitUntil or a worker. */
  settle(request: RelayRequest, options?: SettleOptions): Promise<RelayStatusResponse>;
}

export const DEFAULT_CLAIM_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_SETTLE_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 30 * 60_000;

/** MessageTransmitterV2 revert strings that tell us the outcome instead of a failure. */
const NONCE_USED = 'Nonce already used';
const MESSAGE_EXPIRED = 'Message expired and must be re-signed';

export function createCauceRelayer(options: CreateCauceRelayerOptions): CauceRelayer {
  const { config, account } = options;
  const { settlement, logger } = config;
  const store = options.store ?? createMemoryRelayJobStore();
  const policy = options.policy ?? {};
  const now = options.now ?? Date.now;
  const claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const lookback = options.settlementLookbackBlocks ?? 100_000n;
  const chunk = options.logChunkBlocks ?? 10_000n;
  const transport = options.transport ?? http();
  const publicClient =
    options.publicClient ?? createPublicClient({ chain: settlement.chain, transport });
  const walletClient =
    options.walletClient ?? createWalletClient({ account, chain: settlement.chain, transport });
  const sourceDomains = new Set(config.sourceChains.map((chain) => chain.domain));
  const inflight = new Map<string, Promise<RelayJob>>();

  // --- job persistence ---

  async function write(job: RelayJob, patch: JobPatch): Promise<RelayJob | undefined> {
    // A patch value of undefined clears that (optional) field.
    const merged = { ...job, ...patch, updatedAt: now(), version: job.version + 1 };
    const next = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as unknown as RelayJob;
    const ok = await store.compareAndSet(key(job), job.version, next);
    return ok ? next : undefined;
  }

  /** Writes a patch; if another worker got there first, returns what it stored instead. */
  async function writeOrReload(job: RelayJob, patch: JobPatch): Promise<RelayJob> {
    return (await write(job, patch)) ?? (await store.get(key(job))) ?? job;
  }

  const fail = (job: RelayJob, error: string) => {
    logger.warn('cauce-relayer: payment failed', { burnTxHash: job.burnTxHash, error });
    return writeOrReload(job, { status: 'failed', error, lastError: undefined });
  };

  const noteTransient = (job: RelayJob, error: unknown) => {
    const message = errorMessage(error);
    logger.warn('cauce-relayer: transient error, will retry', {
      burnTxHash: job.burnTxHash,
      error: message,
    });
    return writeOrReload(job, { lastError: message });
  };

  // --- one step of the job state machine ---

  async function step(job: RelayJob): Promise<RelayJob> {
    switch (job.status) {
      case 'settled':
      case 'failed':
        return job;
      case 'relaying':
        if (job.settlementTxHash) return checkSettlement(job, job.settlementTxHash);
        // Another worker claimed the job and is sending; take over only if it went silent.
        if (now() - job.updatedAt < claimTimeoutMs) return job;
        return attestAndRelay(job);
      case 'attesting':
        return attestAndRelay(job);
    }
  }

  async function attestAndRelay(job: RelayJob): Promise<RelayJob> {
    let messages: IrisMessage[];
    try {
      messages = await config.iris.getMessages({
        sourceDomain: job.sourceDomain,
        transactionHash: job.burnTxHash,
      });
    } catch (error) {
      return noteTransient(job, error);
    }

    const decoded = messages.filter(
      (m): m is IrisMessage & { decoded: DecodedCctpMessage } => m.decoded !== undefined,
    );
    const payment = decoded.find((m) => isForThisDeployment(m.decoded));
    if (!payment) {
      const allDecoded = messages.length > 0 && decoded.length === messages.length;
      return allDecoded
        ? fail(job, 'The transaction contains no payment for this Cauce deployment')
        : job;
    }
    if (payment.status !== 'complete' || !payment.message || !payment.attestation) return job;

    const rejection = validate(payment.decoded);
    if (rejection) return fail(job, rejection);

    const messageHash = keccak256(payment.message);
    try {
      const used = await publicClient.readContract({
        address: settlement.messageTransmitter,
        abi: messageTransmitterV2Abi,
        functionName: 'usedNonces',
        args: [payment.decoded.nonce],
      });
      if (used !== 0n) return await settledByAnyone(job, messageHash);
    } catch (error) {
      return noteTransient(job, error);
    }

    const claimed = await write(job, {
      status: 'relaying',
      settlementTxHash: undefined,
      lastError: undefined,
    });
    if (!claimed) return (await store.get(key(job))) ?? job;

    return send(claimed, payment.message, payment.attestation, messageHash);
  }

  async function send(job: RelayJob, message: Hex, attestation: Hex, messageHash: Hash) {
    let hash: Hash;
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: settlement.relay,
        abi: cauceRelayAbi,
        functionName: 'relayPayment',
        args: [message, attestation],
      });
      hash = await walletClient.writeContract(request);
    } catch (error) {
      const reason = revertReason(error);
      if (reason === undefined) {
        // Not a revert (RPC down, nonce too low…): release the claim and retry later.
        return writeOrReload(job, { status: 'attesting', lastError: errorMessage(error) });
      }
      if (reason.includes(NONCE_USED)) return settledByAnyone(job, messageHash);
      if (reason.includes(MESSAGE_EXPIRED)) {
        return fail(job, 'The attestation expired; the message must be re-attested by Circle');
      }
      return fail(job, `CauceRelay rejected the payment: ${reason}`);
    }

    logger.info('cauce-relayer: relay transaction sent', { burnTxHash: job.burnTxHash, hash });
    return writeOrReload(job, { settlementTxHash: hash });
  }

  async function checkSettlement(job: RelayJob, hash: Hash): Promise<RelayJob> {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: hash });
      if (receipt.status === 'success') {
        logger.info('cauce-relayer: payment settled', {
          burnTxHash: job.burnTxHash,
          hash: hash,
        });
        return await writeOrReload(job, { status: 'settled', lastError: undefined });
      }
      // Reverted, most likely because someone settled it first: re-evaluate from scratch.
      return await writeOrReload(job, {
        status: 'attesting',
        settlementTxHash: undefined,
        lastError: `Relay transaction ${hash} reverted`,
      });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) return noteTransient(job, error);
    }

    // Not mined yet. If the node no longer knows the transaction at all, it was dropped.
    if (now() - job.updatedAt < claimTimeoutMs) return job;
    try {
      await publicClient.getTransaction({ hash: hash });
      return job;
    } catch (error) {
      if (!(error instanceof TransactionNotFoundError)) return noteTransient(job, error);
      return writeOrReload(job, {
        status: 'attesting',
        settlementTxHash: undefined,
        lastError: `Relay transaction ${hash} was dropped`,
      });
    }
  }

  /** The message was received on-chain (by us earlier, or anyone): find the relay transaction. */
  async function settledByAnyone(job: RelayJob, messageHash: Hash): Promise<RelayJob> {
    try {
      const latest = await publicClient.getBlockNumber();
      const floor = latest > lookback ? latest - lookback : 0n;
      for (let toBlock = latest; toBlock >= floor; toBlock -= chunk) {
        const fromBlock = toBlock - chunk + 1n > floor ? toBlock - chunk + 1n : floor;
        const [log] = await publicClient.getContractEvents({
          address: settlement.relay,
          abi: cauceRelayAbi,
          eventName: 'PaymentRelayed',
          args: { messageHash },
          fromBlock,
          toBlock,
        });
        if (log) {
          return await writeOrReload(job, {
            status: 'settled',
            settlementTxHash: log.transactionHash,
            lastError: undefined,
          });
        }
        if (fromBlock === floor) break;
      }
    } catch (error) {
      return noteTransient(job, error);
    }
    return writeOrReload(job, {
      status: 'settled',
      lastError: `Settled on-chain, but the relay transaction is older than ${lookback} blocks`,
    });
  }

  // --- validation ---

  function isForThisDeployment(message: DecodedCctpMessage): boolean {
    return (
      message.destinationDomain === settlement.domain &&
      sameBytes32(message.body.mintRecipient, addressToBytes32(settlement.vault))
    );
  }

  /** Mirrors CauceRelay's checks plus the relayer's policy, so no gas is spent on doomed calls. */
  function validate(message: DecodedCctpMessage): string | undefined {
    if (!sameBytes32(message.recipient, addressToBytes32(settlement.tokenMessenger))) {
      return 'Not a USDC burn handled by the CCTP TokenMessenger';
    }
    if (!sameBytes32(message.destinationCaller, addressToBytes32(settlement.relay))) {
      return 'The message is not reserved for this CauceRelay (destinationCaller)';
    }
    const minted = message.body.amount - message.body.feeExecuted;
    if (policy.minAmount !== undefined && minted < policy.minAmount) {
      return `Amount ${minted} is below the relayer minimum ${policy.minAmount}`;
    }
    if (policy.merchants) {
      let merchant: Address;
      try {
        merchant = decodeHookData(message.body.hookData).merchant;
      } catch {
        return 'Invalid hookData; this relayer only settles payments to its merchants';
      }
      if (!policy.merchants.some((allowed) => isAddressEqual(allowed, merchant))) {
        return `Merchant ${merchant} is not served by this relayer`;
      }
    }
    return undefined;
  }

  // --- public API ---

  function key(request: RelayRequest): string {
    return relayJobKey(request.sourceDomain, request.burnTxHash);
  }

  /** Runs one step, sharing the in-flight step between concurrent callers in this process. */
  function advance(job: RelayJob): Promise<RelayJob> {
    const k = key(job);
    const running = inflight.get(k);
    if (running) return running;
    const promise = step(job).finally(() => inflight.delete(k));
    inflight.set(k, promise);
    return promise;
  }

  async function submit(request: RelayRequest): Promise<RelayStatusResponse> {
    if (!sourceDomains.has(request.sourceDomain)) {
      throw new CauceError(
        'UNSUPPORTED_CHAIN',
        `Source domain ${request.sourceDomain} is not configured`,
        { details: { sourceDomain: request.sourceDomain } },
      );
    }
    const timestamp = now();
    const job = await store.create(key(request), {
      burnTxHash: request.burnTxHash,
      sourceDomain: request.sourceDomain,
      status: 'attesting',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 0,
    });
    return toResponse(await advance(job));
  }

  async function getStatus(request: RelayRequest): Promise<RelayStatusResponse | undefined> {
    const job = await store.get(key(request));
    return job ? toResponse(await advance(job)) : undefined;
  }

  async function settle(request: RelayRequest, opts: SettleOptions = {}) {
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS;
    const deadline = now() + (opts.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
    let status = await submit(request);
    while (status.status !== 'settled' && status.status !== 'failed' && now() < deadline) {
      await sleep(pollIntervalMs, opts.signal);
      status = (await getStatus(request)) ?? (await submit(request));
    }
    return status;
  }

  return { address: account.address, submit, getStatus, settle };
}

function toResponse(job: RelayJob): RelayStatusResponse {
  return {
    burnTxHash: job.burnTxHash,
    sourceDomain: job.sourceDomain,
    status: job.status,
    ...(job.settlementTxHash ? { settlementTxHash: job.settlementTxHash } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function sameBytes32(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The revert reason or custom error name if `error` is a contract revert, else undefined. */
function revertReason(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return undefined;
  // String reverts decode as errorName "Error"; the reason is the useful part.
  return revert.reason ?? revert.data?.errorName ?? revert.shortMessage;
}

function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CauceError('ABORTED', 'The operation was aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CauceError('ABORTED', 'The operation was aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
