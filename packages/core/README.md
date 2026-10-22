# @cauce/core

Framework-agnostic core of [Cauce](../../README.md): accept USDC from any Circle CCTP V2 chain and
settle it in one vault. It depends only on [viem](https://viem.sh) and holds no keys.

```sh
pnpm add @cauce/core viem
```

It provides:

- `createCauceConfig` for chains, environment (`testnet` / `mainnet`), relayer URL and fee policy;
- `createPaymentSession` to run a payment with the payer's viem clients and observe it through a
  typed state machine;
- `createIrisClient` for Circle's attestation API, with timeouts, retries and backoff;
- `encodeHookData` / `decodeHookData` and `decodeCctpMessage`;
- `quotePayment`, `parseUsdc` and `formatUsdc`;
- `createRelayerClient`, the HTTP contract shared with `@cauce/server`.

See the [repository README](../../README.md) for the full picture.
