# Review corrections, 2026-10-17

The initial 64-test reconstruction candidate was reviewed before publication. The following issues were reproduced and corrected:

1. A blocking remote result lookup held the sequential stdio reader until the remote timeout. MCP recovery now starts a bounded background lookup and returns a tracked state immediately. A saturation regression covers two hung recoveries, a third returning busy, and responsive close, ping, cached result and shutdown requests. The direct library `recover()` method remains awaitable for host applications; the MCP layer calls `beginRecovery()`.
2. Closing while the transport factory was unresolved returned a stale clean snapshot and hid later cleanup failure. Session status now exposes pending/completed/failed cleanup. Repeated close and shutdown reads refresh cleanup errors. Unresolved initialization remains counted against the session quota rather than disappearing at retention expiry. Once late cleanup settles, the closed handle is retained for a fresh bounded interval so late cleanup errors can be observed even if the original close deadline passed.
3. Recovery could revive a result whose TTL elapsed while waiting for the provider. Both success and error paths now sweep and revalidate session ownership, record identity and expiry after awaiting the provider. Tests cover success, rejection and concurrent close/expiry.
4. Explicit null tool arguments were incorrectly treated as an empty object. Null now fails schema validation without creating a session.
5. The old 2025-03-26 MCP version was advertised without its required batch support. This implementation now advertises only 2025-11-25. Unsupported requested versions negotiate that supported version; clients decide whether to continue.

6. Intentional SIGINT/SIGTERM shutdown destroyed stdin and was incorrectly reported as a transport failure. The CLI now distinguishes requested shutdown from unexpected transport failure. Subprocess tests verify both signals after a successful ping exit cleanly with no error diagnostic.

These are new regression tests for this reconstruction. They are not a recovered historical suite. No live wallet, key material, relay, private tunnel or remote deployment was used.
