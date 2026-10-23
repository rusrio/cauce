---
'@cauce/core': patch
---

`iris.retry` accepts a partial override of the default retry options, and `CaucePaymentSession`
members are typed as function properties so they can be destructured or passed to
`useSyncExternalStore` safely.
