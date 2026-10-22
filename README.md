# Cauce

**Accept USDC from any chain. Settle it in one place.**

_Cauce_ is Spanish for a riverbed: the channel that gathers water from many streams and carries it
to one destination. Cauce does the same for payments. A customer pays in USDC from any chain
supported by [Circle CCTP V2](https://developers.circle.com/cctp), and the merchant receives it on a
single settlement chain ([Arc](https://www.arc.io)), credited in one vault, with one balance to
withdraw.

> **Status: Phase 1, testnet only, unaudited.** `@cauce/core` and the hardened contracts are
> ready; `@cauce/server`, `@cauce/react`, `@cauce/ui` and the demo shop are next. Do not use with
> real funds.

## How a payment flows

```
 Payer wallet (e.g. Base)                Circle                 Settlement chain (Arc)
 ────────────────────────                ──────                 ──────────────────────
 1. approve(TokenMessengerV2)
 2. depositForBurnWithHook  ──burn──▶  Iris attests
      mintRecipient     = CauceVault        │
      destinationCaller = CauceRelay        │
      hookData          = merchant,         ▼
                          orderId,     @cauce/server ──▶ CauceRelay.relayPayment
                          referral     (relayer, holds        │  checks recipient, caller,
                                        the gas key)          │  mint recipient, minted amount
                                                              ▼
                                       MessageTransmitterV2 mints USDC to CauceVault
                                                              │
                                                              ▼
                                       CauceVault.settle → merchant (and referrer) balances
```

If the payer is already on the settlement chain, the payment goes straight to
`CauceVault.pay(amount, hookData)` with no bridge.

The browser only ever signs with the payer's wallet. The relay transaction on the settlement
chain is sent by `@cauce/server` with a key that lives in a server environment variable, never in
client code or props.

## Packages

| Package                        | Status     | Purpose                                                                                                                            |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`@cauce/core`](packages/core) | ✅ Phase 1 | Framework-agnostic TypeScript (only depends on viem): config, chain presets, state machine, Iris client, hookData, payment session |
| `@cauce/server`                | 🔜 Phase 2 | Idempotent relayer: framework-agnostic HTTP handler + Next.js adapter                                                              |
| `@cauce/react`                 | 🔜 Phase 3 | Thin hooks over core (`useCaucePayment`) and a headless `<CauceCheckout>`                                                          |
| `@cauce/ui`                    | 🔜 Phase 3 | Styled `<CaucePayment />`, themable through `--cauce-*` CSS variables                                                              |
| `apps/demo-shop`               | 🔜 Phase 4 | Example Next.js store                                                                                                              |
| [`contracts/`](contracts)      | ✅ Phase 1 | `CauceVault` and `CauceRelay` (Foundry); ABIs generated into core with the wagmi CLI                                               |

## Using `@cauce/core`

```ts
import { createCauceConfig, createPaymentSession, parseUsdc } from '@cauce/core';
import { baseSepolia, sepolia } from 'viem/chains';

const config = createCauceConfig({
  environment: 'testnet',
  chains: [sepolia, baseSepolia], // where customers can pay from
  relayerUrl: 'https://shop.example/api/cauce', // your @cauce/server endpoint
  // Required until the official testnet deployment is published in the presets:
  settlement: { vault: '0x…', relay: '0x…' },
});

// walletClient / publicClient: the payer's viem clients (e.g. from wagmi).
const session = createPaymentSession(config, { walletClient, publicClient, store });
session.subscribe((state) => render(state)); // idle → approving → burning → attesting → relaying → settled

await session.pay({
  merchant: '0xMerchant…',
  orderId: 'ORDER-1042',
  amount: parseUsdc('25.00'), // what the merchant receives
});
```

- **Typed state machine.** `transition()` is a pure reducer: `idle → approving → burning →
attesting → relaying → settled` for CCTP and `idle → approving → paying → settled` for direct
  payments. Any in-flight state can fail. Invalid transitions throw instead of being ignored.
  `getPaymentSteps(state)` drives a stepper without string matching.
- **Recoverable payments.** The burn is persisted in a `PendingPaymentStore` as soon as its hash
  is known. If the tab closes, `session.resume(pending)` settles it later; the relayer endpoint is
  idempotent.
- **Fees from Circle, not constants.** `quotePayment` asks Iris for the current fast-transfer fee,
  adds a configurable buffer and computes the smallest `maxFee` that still delivers the full amount.
  It falls back to free standard transfers above `fees.maxFeeCap`.
- **Iris client** with per-request timeout, exponential backoff with jitter, `Retry-After`, and
  `AbortSignal` support.
- **One error type.** Everything throws `CauceError` with a typed `code`. Nothing logs unless you
  inject a `logger`.
- **One module with addresses.** Every address, CCTP domain and URL lives in
  [`packages/core/src/presets.ts`](packages/core/src/presets.ts), versioned with
  `CAUCE_PRESETS_VERSION`.

### hookData v1

Payment metadata travels in the CCTP `hookData` field as the canonical ABI encoding of

```solidity
(uint8 version = 1, address merchant, string orderId, uint256 campaignId, address referrer)
```

`campaignId = 0` means no referral. `orderId` is 1–128 UTF-8 bytes. `encodeHookData` and the
contract's `HookData.tryDecode` are checked against the same fixture
(`contracts/test/fixtures/hook-data.json`). If the vault cannot decode the hookData, it refunds
the payer instead of reverting.

## Contracts

- **`CauceRelay.relayPayment(message, attestation)`** is permissionless. It only accepts a CCTP V2
  message that:
  - is addressed to the local `TokenMessengerV2`, which makes it a genuine USDC burn;
  - mints to `CauceVault`;
  - reserves the relay as `destinationCaller`;
  - grows the vault's USDC balance by exactly `amount − feeExecuted`.

  Only then does it call `CauceVault.settle`.

- **`CauceVault`** credits the merchant with the amount actually minted and applies referral
  campaigns. It refunds the payer when the hookData is invalid. Settlement never transfers
  tokens: merchants, referrers and refunded payers all `withdraw()` from their balance.

| Network     | CauceVault           | CauceRelay           |
| ----------- | -------------------- | -------------------- |
| Arc Testnet | _pending deployment_ | _pending deployment_ |

Deploy with a Foundry keystore. Never put a private key in an env var or in code:

```sh
cast wallet import cauce-deployer --interactive
cd contracts && set -a && . ./.env.example && set +a
forge script script/DeployCauce.s.sol --rpc-url "$RPC_URL" --account cauce-deployer --broadcast
```

Then add the addresses to `deploymentPresets` in `presets.ts`, bump `CAUCE_PRESETS_VERSION` and
add a changeset.

## Local development

Prerequisites: Node.js ≥ 22.18 (24 LTS recommended, see `.nvmrc`), pnpm through
[Corepack](https://nodejs.org/api/corepack.html) (`corepack enable`), and
[Foundry](https://getfoundry.sh) for the contracts.

```sh
git clone --recurse-submodules <repo-url> cauce && cd cauce
corepack enable
pnpm install

pnpm build        # tsup, through Turborepo
pnpm test         # Vitest
pnpm lint         # ESLint (typescript-eslint strict, no console)
pnpm typecheck    # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
pnpm format       # Prettier

cd contracts && forge test   # Foundry tests, including regressions for the NexusPay exploits
```

After changing `contracts/src`, regenerate the ABIs consumed by core. CI fails if they drift:

```sh
pnpm --filter @cauce/core generate:abis
```

Every change to a published package needs a changeset (`pnpm changeset`). Commits follow
[Conventional Commits](https://www.conventionalcommits.org).

CI (GitHub Actions) runs lint, typecheck, test and build on Node 24. A separate `contracts` job
runs `forge fmt --check`, `forge build`, `forge test` and the ABI drift check.

### Repository layout

```
.github/workflows/ci.yml   lint · typecheck · test · build · contracts
contracts/                 Foundry project (src, test, script); forge-std + OpenZeppelin as submodules
packages/core/             @cauce/core
  src/presets.ts           every address, domain and URL (versioned)
  src/abis/generated.ts    generated with the wagmi CLI from contracts/
```

## Origins

Cauce rebuilds [NexusPay](https://github.com/rusrio/ethglobal-nexus), built at ETHGlobal HackMoney
2026, as a maintainable product. The rebuild fixes these problems from the original:

- The operator's private key was a React prop and signed the relay in the browser. It now lives
  only on the server.
- The relay contract never checked the mint recipient or the CCTP recipient. Anyone could get a
  merchant credited without paying, or with a forged generic message, and drain the vault. With
  `destinationCaller = 0`, anyone could also receive a payment without crediting the merchant.
  All three are fixed, with regression tests.
- Addresses, RPC URL, the Circle sandbox URL and the CCTP fee (`20000n`) were hardcoded. They are
  now injectable config and versioned presets.
- If the tab closed after the burn, nobody relayed the payment. Pending payments are now
  persisted and can be resumed.
- UI state was inferred by comparing strings. It is now an explicit, typed state machine with
  tests.

The original `NexusVault`/`NexusPayRelay` deployment on Arc Testnet is superseded and should not
receive payments.

## License

MIT
