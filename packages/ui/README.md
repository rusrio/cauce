# @cauce/ui

`<CaucePayment />`: a complete, accessible, themable payment form for [Cauce](../../README.md),
built on `<CauceCheckout>` from `@cauce/react`.

```sh
pnpm add @cauce/ui @cauce/react @cauce/core wagmi viem @tanstack/react-query
```

```tsx
import '@cauce/ui/styles.css';
import { CaucePayment } from '@cauce/ui';
import { ConnectButton } from '@rainbow-me/rainbowkit';

<CaucePayment
  merchant="0xMerchant…"
  orderId="ORDER-1042"
  amount={{ mode: 'fixed', value: 25_000_000n }} // 25 USDC, or { mode: 'variable', min, max }
  connectButton={<ConnectButton />}
  onSettled={(state) => console.log('paid', state.settlementTxHash)}
  onClose={() => setOpen(false)}
/>;
```

It must render inside `CauceProvider` (see `@cauce/react`). What it covers:

- **The whole payment:**
  - amount entry and validation;
  - Circle fee and total;
  - stepper (Approve → Transfer → Settle);
  - status messages;
  - receipt link on the settlement chain explorer;
  - retry, and finishing a payment that was burned but not settled, including one left
    unfinished in an earlier visit.
- **Accessibility:**
  - status announced through an `aria-live` region;
  - errors with `role="alert"`;
  - the stepper is an ordered list with `aria-current`;
  - steps use shapes (✓, !) as well as color;
  - visible focus;
  - honours `prefers-reduced-motion`.
- **Theming:** no inline styles; everything is driven by CSS variables on `.cauce-payment`.
  Light and dark follow `prefers-color-scheme`, or force one with `theme="dark"`.

  ```css
  .cauce-payment {
    --cauce-color-accent: #7c3aed;
    --cauce-radius: 8px;
    --cauce-font-family: 'Inter', sans-serif;
  }
  ```

  Available variables: `--cauce-font-family`, `--cauce-font-size`, `--cauce-radius`,
  `--cauce-radius-control`, `--cauce-spacing`, `--cauce-max-width`, `--cauce-color-bg`,
  `--cauce-color-surface`, `--cauce-color-fg`, `--cauce-color-muted`, `--cauce-color-border`,
  `--cauce-color-accent`, `--cauce-color-accent-fg`, `--cauce-color-success`,
  `--cauce-color-danger`, `--cauce-color-focus`, `--cauce-shadow`.

- **Translations:** override any text with `labels` (see `defaultLabels`):

  ```tsx
  <CaucePayment labels={{ title: 'Pagar con USDC', pay: (a) => (a ? `Pagar ${a} USDC` : 'Pagar') }} … />
  ```
