# @cauce/react

React hooks and a headless checkout for [Cauce](../../README.md) payments. It is a thin layer
over `@cauce/core` and uses the wallet your app connects through [wagmi](https://wagmi.sh).

```sh
pnpm add @cauce/react @cauce/core wagmi viem @tanstack/react-query
```

Peers: React 18 or 19, wagmi 3, viem 2, TanStack Query 5. It is client-only: the build carries
`"use client"`.

## Setup

```tsx
import { createCauceConfig } from '@cauce/core';
import { CauceProvider } from '@cauce/react';
import { baseSepolia, sepolia } from 'viem/chains';

const cauceConfig = createCauceConfig({
  environment: 'testnet',
  chains: [sepolia, baseSepolia],
  relayerUrl: 'https://shop.example/api/cauce', // @cauce/server
  settlement: { vault: '0x…', relay: '0x…' },
});

// Inside your WagmiProvider + QueryClientProvider. The wagmi config must include the source
// chains and Arc (the settlement chain) for direct payments.
<CauceProvider config={cauceConfig}>{children}</CauceProvider>;
```

## Headless checkout

`<CauceCheckout>` holds all the logic of a payment form and renders nothing itself:

```tsx
import { CauceCheckout } from '@cauce/react';

<CauceCheckout
  merchant="0xMerchant…"
  orderId="ORDER-1042"
  amount={{ mode: 'variable', min: 1_000_000n }}
>
  {({ amountInput, setAmountInput, amountError, quote, steps, status, error, canPay, submit }) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input value={amountInput} onChange={(e) => setAmountInput(e.target.value)} />
      {amountError && <p role="alert">{amountError.message}</p>}
      <button disabled={!canPay}>Pay</button>
      {/* steps, status, error, quote… render as you like */}
    </form>
  )}
</CauceCheckout>;
```

For a ready-made, styled form, use `<CaucePayment />` from `@cauce/ui`.

## Hooks

- **`useCaucePayment(options?)`** returns `{ state, status, steps, route, isBusy, error, pay,
resume, reset }`.
  - Each payment uses the wallet and chain that are connected when it starts.
  - `pay()` never rejects: errors land in `state`/`error` and `onError`, including those raised
    before a payment starts (no wallet, invalid request, unsupported chain).
  - `route` is `cctp`, `direct`, `unsupported` or `disconnected`.
- **`useCaucePendingPayments()`** returns `{ pending, dismiss, refresh }`: payments burned but not
  yet settled in this browser. Finish them with `useCaucePayment().resume(pending)`, which needs
  no wallet. The list follows changes made in other tabs.
- **`useCauceQuote({ amount })`** estimates the cost on the connected chain, with Circle's current
  fee.
- **`createLocalStoragePendingStore(key?, storage?)`** is the default store of `CauceProvider`.
  It falls back to memory during SSR, and you can pass your own `PendingPaymentStore` instead.
