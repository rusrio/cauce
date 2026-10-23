# @cauce/server

The Cauce relayer. It settles CCTP V2 payments on the settlement chain by calling
`CauceRelay.relayPayment` with a key that lives **only** in a server environment variable.

```sh
pnpm add @cauce/server @cauce/core viem
```

## Next.js (App Router)

```ts
// lib/cauce.ts (server only)
import { createCauceConfig } from '@cauce/core';
import { createCauceRelayer, relayerAccountFromEnv } from '@cauce/server';
import { baseSepolia, sepolia } from 'viem/chains';

export const config = createCauceConfig({
  environment: 'testnet',
  chains: [sepolia, baseSepolia],
  relayerUrl: `${process.env.APP_URL}/api/cauce`,
  settlement: { vault: '0x…', relay: '0x…' }, // until the deployment preset ships
});

export const relayer = createCauceRelayer({
  config,
  account: relayerAccountFromEnv(), // reads CAUCE_RELAYER_PRIVATE_KEY
  policy: { merchants: [process.env.MERCHANT_ADDRESS as `0x${string}`] },
});
```

```ts
// app/api/cauce/[...cauce]/route.ts
import { after } from 'next/server';
import { createCauceRouteHandlers } from '@cauce/server/next';
import { relayer } from '@/lib/cauce';

export const runtime = 'nodejs';
export const { GET, POST, OPTIONS } = createCauceRouteHandlers(relayer, {
  waitUntil: (task) => after(task),
});
```

The relayer account pays gas on the settlement chain. On Arc, gas is paid in USDC, so fund the
account from the [Circle faucet](https://faucet.circle.com) on testnet.

## Any other framework

`createRelayHandler(relayer)` returns a standard `(request: Request) => Promise<Response>`. It
works as is in Hono, Bun, Deno and Cloudflare Workers, and in Node through any Fetch adapter
(e.g. `@hono/node-server`). Routes match on the end of the path, so you can mount it under any
prefix:

| Route                                   | Body                           | Response                       |
| --------------------------------------- | ------------------------------ | ------------------------------ |
| `POST …/relay`                          | `{ burnTxHash, sourceDomain }` | `RelayStatusResponse`          |
| `GET …/relay/:sourceDomain/:burnTxHash` | —                              | `RelayStatusResponse` or `404` |

`RelayStatusResponse` is `{ burnTxHash, sourceDomain, status, settlementTxHash?, error? }`, where
`status` is one of `attesting | relaying | settled | failed`. The same contract is implemented by
`createRelayerClient` in `@cauce/core`.

## How it works

- **Driven by polling, serverless-friendly.** No request blocks while Circle attests. Every POST
  or GET advances the payment one step: ask Iris, validate, simulate and send `relayPayment`,
  then check the receipt. The client polls until the payment settles. With `waitUntil`, the
  relayer keeps settling in the background after the response is sent. In a long-running worker,
  call `relayer.settle(request)`.
- **Idempotent.** Each payment is a job keyed by `(sourceDomain, burnTxHash)`. Three layers
  prevent double sends:
  - concurrent requests in one process share the same in-flight step;
  - instances that share a `RelayJobStore` coordinate through compare-and-set;
  - on-chain, MessageTransmitter nonces make a second relay impossible.

  If someone else settles the payment first, the relayer finds that transaction instead of
  sending another one.

- **No gas spent on payments it must not relay.** Before sending, it checks the same things
  `CauceRelay` checks (TokenMessenger recipient, vault as mint recipient, the relay as
  `destinationCaller`), applies its `policy` (allowed merchants, minimum amount) and simulates
  the call.
- **Transient vs terminal.** If Iris or the RPC is unreachable, the job is not failed: the error
  is recorded in `lastError` and the job retries on the next poll. A dropped transaction, or a
  claim abandoned by a crashed instance, is retried after `claimTimeoutMs`. Only deterministic
  outcomes become `failed`: a contract revert, an expired attestation, or a message that is not
  for this deployment.

### Running more than one instance

The default store lives in memory, which is fine for a single instance. With several instances
(serverless functions scale out), implement `RelayJobStore` on a shared database. Its
`compareAndSet` must be atomic, for example `UPDATE … WHERE version = $expected` in SQL, or
`WATCH`/`MULTI` in Redis.

## Security

- The key is read from `CAUCE_RELAYER_PRIVATE_KEY` (configurable). Public variable prefixes such
  as `NEXT_PUBLIC_` and `VITE_` are refused, and the key is never echoed in errors.
- Bundlers that target the browser resolve this package to a module that throws, so it cannot
  end up in client code by accident.
- Unexpected errors return a generic 500 and never leak RPC URLs or stack traces.
- Use a dedicated relayer key holding only enough native gas. It cannot move vault funds:
  `CauceRelay` is permissionless and the relayer only pays gas.
