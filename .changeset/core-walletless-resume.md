---
'@cauce/core': minor
---

`createPaymentSession` no longer requires wallet clients to resume a pending payment: `walletClient`
and `publicClient` are optional, and `pay()` fails with the new `WALLET_NOT_CONNECTED` error code
when they are missing.
