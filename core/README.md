# Khie MCP reconstruction candidate

This is a **new, isolated implementation**, dated 2026-10-17. It is not a recovered copy of the missing assistant-generated MCP archive. Its seven tool schemas and regression tests are new. No claim is made that the original six schemas or original 72 tests have been recovered.

## What works

- Newline-delimited stdio MCP, protocol negotiation (`2025-11-25` only), tools/list and tools/call.
- In-memory session creation, initialization status, close and shutdown with synchronous admission barriers.
- Immutable argument snapshots, canonical request deduplication, conflict detection and retained result retrieval.
- Per-session fair scheduling, lifetime request quotas, retained-payload budgets and lazy TTL expiry.
- Timeout classification, observed late promise rejections, bounded cleanup and cancelled pending approvals.
- CCC JSON-RPC metadata adapter and explicit `get_result` recovery after an uncertain timeout.
- Tests against the real pinned CCC provider implementation with a fake signer. No real wallet is involved.

## Safe default

The CLI runs **offline fixture data only**. `get_info` identifies the fixture explicitly; identities and addresses are labelled `fixture:` and are not usable accounts. The CLI has no network, wallet, pairing, signing, transaction-sending or auto-approval flags. It does not read keys, seed phrases, account files, environment credentials or pairing codes.

`src/adapter.mjs` includes a library-only boundary for an already-paired, already-approved provider transport. Merely importing or constructing it does not create a libp2p node or connect a wallet. This boundary is for later reviewed integration; live wallet/relay/tunnel interoperability is unverified.

## Run and verify

Node 24+ is required. Direct dependencies are exactly `@ckb-ccc/core@1.23.0` and `@ckb-ccc/libp2p@0.3.2`; `pnpm-lock.yaml` pins the transitive dependency graph. The package manager is pinned to pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile --ignore-scripts
node src/cli.mjs
node --test test/*.test.mjs
node --experimental-test-coverage --test test/*.test.mjs
```

The offline CLI and core tests use only Node built-ins; the adapter and CCC interoperability tests require the pinned dependencies. No build step is required. All stdout is reserved for MCP JSON messages. Diagnostics use stderr. Close stdin to finish the process, or send SIGINT/SIGTERM.

`docs/test-run.txt` contains the current full test and coverage output. `docs/SHA256SUMS` identifies candidate source, tests, schema and lockfile. This is an unpublished local candidate, not a release or a remote repository commit.

## Tool contract

All arguments are JSON objects with `additionalProperties: false`. IDs are 1–128 characters using letters, digits, underscore, hyphen, period or colon.

| Tool | Arguments | Result |
| --- | --- | --- |
| `khie_capabilities` | `{}` | Policy, limits and reconstruction marker |
| `khie_session_open` | `{}` | New handle and `starting` status |
| `khie_session_status` | `sessionId` | `starting`, `ready`, `failed` or `closed`, sanitized readiness error |
| `khie_request` | `sessionId`, `requestId`, `method`, optional empty `params` | Queued/cached request record |
| `khie_result` | `sessionId`, `requestId`, optional boolean `recover` | Cached state; optionally starts a nonblocking timed-out provider query |
| `khie_session_close` | `sessionId` | Closed status and any bounded cleanup error |
| `khie_shutdown` | `{}` | Admission disabled, sessions closed, cleanup errors |

The only methods accepted by MCP are `get_info`, `get_scripts`, `get_native_address` and `get_identity`, each with zero application parameters. Tool execution failures use MCP `isError: true` plus a structured error. RPC framing/protocol failures use JSON-RPC errors.

Machine-readable schemas are in `docs/tools.json`. Poll session status until ready before requesting. `khie_request` returns immediately; poll `khie_result` for `completed`, `failed`, `timed_out` or `cancelled`. Reuse the same request ID only with exactly the same method and JSON arguments. Canonicalization ignores object-key order.

### Recovery semantics

A local timeout does **not** prove that the remote action failed. No operation is automatically retransmitted. `khie_result` with `recover: true` starts a nonblocking upstream CCC `get_result` query using the original remote request ID, only for an existing timed-out request on a still-active session. The tool immediately returns a tracked recovery state (`running`, `busy` or `unsupported`); poll without `recover` to inspect it. After a remote `pending` response, a later explicit `recover: true` starts another bounded read. Remote `pending` and `not_found` preserve the uncertain `timed_out` state. A completed recovered result is labelled `recovered: true`.

Cached result retrieval does not enter the execution queue and remains available after close/shutdown while the process remains alive. Remote recovery has a separate concurrency budget and no new execution authority. Closing a session may not undo an operation already dispatched remotely.

### Bounded state and expiry

Default limits:

- 8 retained sessions, including recently closed handles
- 128 lifetime request IDs per session; IDs are retained as dedup tombstones until session removal
- 4 simultaneous executions, at most 1 per session; round-robin waiting sessions
- 4 simultaneous recovery reads, at most 1 per session
- 1 MiB per serialized RPC payload/result and input line
- 8 MiB retained serialized request/result payload budget per session (plus bounded bookkeeping); no eviction of earlier results to admit later work
- 120-second completed-result retention; 120-second closed-handle retention after close or cleanup completion, whichever is later; pending cleanup has no fixed expiry until it settles
- 30-minute session inactivity expiry, measured from opening/latest new or deduplicated request
- 30-second operation deadline, 10-second ready deadline, 2-second cleanup deadline

TTL expiry is lazy and checked on service access or explicit `sweep()`. Hosts that need physical cleanup while completely idle should invoke `sweep()` on a lifecycle-owned timer. Total retained state remains quota-bounded while idle. Results disappear at TTL even if a client did not retrieve them. Expired requests cannot be rerun under the same ID; open a new session for genuinely new work. Process restart discards every handle, cache entry and approval.

## Signing safety boundary

Signing is not exposed by this MCP surface. The internal service can be instantiated by a trusted application with `enableSigning: true` and a required `approve(action, { signal })` callback for testing a future approval UI. That callback must obtain a fresh, explicit human decision for each exact action/digest and return literal `true`. A model-generated boolean, blanket approval callback or approval parameter from the MCP client is not an approval UI. Repeated identical request IDs do not prompt or execute again. Pending approval is aborted on close/shutdown; a late approval cannot dispatch an action.

The only internal gated methods are `sign_message` and `sign_transaction`. No `send_transaction` method is implemented. Broadcasting/transferring funds would require a separately reviewed, human-controlled flow and remains outside this candidate. The test suite exercises fake signatures only.

## Limitations before production use

1. The missing original service is not restored. New schemas may not match previous clients.
2. Default CLI is a safe fixture demonstration, not a live Khie wallet connection.
3. Actual libp2p/WebRTC, relay reconnection, mobile wallet pairing and private tunnel operation have not been exercised here.
4. The stdio MCP subset is implemented directly from the cited specification; external MCP client conformance testing is still needed. There is no HTTP server, OAuth, multi-tenant authentication, prompts, resources, subscriptions or durable storage.
5. An adapter ignoring abort can complete remotely after timeout/close. Local state cannot reverse remote actions. Cleanup deadlines report failures rather than promise that an uncooperative resource was stopped. Closed sessions expose `cleanupState` (`pending`, `completed`, `failed`) and any `cleanupError`; repeat close/shutdown/status reads reflect late factory cleanup. Shutdown reports `pendingCleanup` and fresh cleanup errors instead of claiming unfinished cleanup succeeded.
6. Upstream result cache retention is independent of this service's TTL; recovery cannot guarantee an outcome once either cache expires.
7. Independent review is required before any live-wallet integration or publication.

See `docs/PROVENANCE.md` and `docs/INTEGRATION.md` for source evidence and the next integration boundary.
