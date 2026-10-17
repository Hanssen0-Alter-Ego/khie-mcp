# Offline validation

Command: `node --experimental-test-coverage --test --test-concurrency=1 core/test/*.test.mjs test/*.test.mjs`.

- 141/141 tests passed, comprising the unchanged core's 76 tests plus 65 adapter/config/input/runtime/fake integration regressions.
- Recorded aggregate coverage: 99.48% lines, 91.94% branches, 96.63% functions. Full output is in test-run.txt.
- Production package imports were verified. Node construction/configuration was executed only with fake node constructor functions. Actual pinned WebSocket and relay transport constructors/handlers were exercised using fake components and EventTarget-based sockets; no real node or socket was constructed. Coverage does **not** establish real networking interoperability.
- Preserved core manifest verification passed; its manifest hash remains `29c1aa1f17fe321b57ab692cacbf1a8e77aaba0a68b1d2fa386e6daa3af56b2b`.
- A lightweight consistency check found 153 lockfile packages/snapshots, all nine direct installed versions matching package.json and importer specifiers, and SHA-512 integrity fields present. A subsequent fresh isolated frozen-lockfile install passed normal supply-chain verification and the complete offline suite. This is not a full security audit.

The new tests cover explicit enablement, unknown config rejection, exact relay allowlist, route/identity filtering, metadata-before-connect ordering, user-declined connect, read-method restrictions, one-use endpoints, unpair/provider replacement, non-retransmitting recovery, fake pending wallet-approval cancellation, late-created/late-started node disposal, relay retry cancellation, cleanup errors, CLI mode/schema secrecy, bounded regular-file/pipe input, idle input timeout, and SIGINT/SIGTERM.

Review regressions additionally cover inbound STOP side effects, failed/aborted upgrades, standards-valid reset close, late upgrade disposal/rejection, automatic terminal cleanup from request and recovery, startup/unpair races, an independent live idle deadline, and all four read methods through the real CCC provider with a fake signer.

No test constructs a production libp2p node, opens a real WebSocket/relay connection, enters a wallet credential, signs a message/transaction or sends a chain transaction.

Remaining: independent re-review of adapter fixes; explicitly authorized real read-only pairing and intended MCP helper interoperability. HTTP/tunnel deployment and signing are outside this candidate.
