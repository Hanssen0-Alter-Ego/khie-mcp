# Khie MCP opt-in transport candidate

Version `0.2.1-reconstruction`. This is new source derived from accessible public CCC protocol code, not a recovered original service. The reviewed, network-free `0.1.0` core is preserved unchanged under `core/`. Its seven-tool schema remains the MCP contract; no historical six-tool schema is claimed.

## What is implemented

- Default `node src/cli.mjs` runs public offline fixtures with **no networking**.
- Explicit trusted-host configuration enables one live, read-only CCC/libp2p pairing attempt through one exact allowlisted secure WebSocket circuit relay.
- A fresh provider endpoint is read privately on file descriptor 3. It never appears in tool arguments, environment variables, command arguments, logs, or generated fixtures.
- `khie_session_open` then starts the configured node, relay and pairing. It first reads `get_info` metadata. Merely initializing MCP or listing tools does not create a node or connect.
- Optional host `connectNetwork` requests the wallet's own connection approval after metadata. Without that setting, account reads return `CONNECT_REQUIRED` and no `connect` request is sent.
- Allowed read methods: `get_info`, `get_scripts`, `get_native_address`, `get_identity`. Signing, preparation, broadcasting and caller-directed `connect` are unavailable, including through this adapter's library API.
- One session/one endpoint attempt per process; close, failure or unpair requires a process restart with a fresh endpoint. Automatic endpoint reuse and write retries are not implemented.

**Validation status:** offline unit/fake integration tests pass. Actual production package entrypoints were imported, but no real libp2p node, wallet pairing, relay connection or chain operation was performed. This is source-complete for a separately approved read-only paired test, not evidence that real network interoperability has succeeded.

## Install and run

Requires Node 24+ (including native WebSocket) and pnpm 11.25.0. Dependencies are exact-pinned with a lockfile.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run test:coverage
node src/cli.mjs
```

The expanded adapter lockfile was selected from the existing pinned wallet graph. A fresh isolated `--frozen-lockfile --ignore-scripts` install passed pnpm's normal supply-chain policies for all 153 entries with concurrency 1 and a 512 MiB heap cap. It materialized 134 packages from the existing verified content-addressed cache, with zero package tarball downloads. The complete offline suite also passed against that clean installation; this is not a security-audit guarantee.

For a later approved live test, a trusted local launcher must provide:

```sh
node src/cli.mjs --live-config /absolute/path/to/trusted-config.json 3</secure/local/provider-endpoint-input
```

The endpoint input is sensitive: obtain it through the intended secure local wallet handoff, never paste it into chat, commit it, put it in a shell argument/environment variable, or upload it. The example names an input only; this build creates no credential or endpoint file. A launcher may instead pass an inherited pipe as descriptor 3. Descriptor 3 closes after one bounded read; idle input times out in 10 seconds. Config is at most 16 KiB, endpoint input at most 32 KiB.

Example **metadata-only** configuration (choose and approve your actual relay before use):

```json
{
  "enabled": true,
  "relayAddress": "/dns4/relay.ckbccc.com/tcp/443/wss",
  "relayAllowlist": ["/dns4/relay.ckbccc.com/tcp/443/wss"],
  "readyTimeoutMs": 30000,
  "requestTimeoutMs": 10000
}
```

Adding `"connectNetwork": "ckb-testnet"` explicitly asks the provider to obtain wallet approval for account reads. `ckb-mainnet` is also recognized but was not exercised. There is no signing-enable field. Unknown configuration keys are rejected. The MCP client cannot change this configuration. See [the JSON schema](docs/live-config.schema.json).

## MCP sequence

Initialize with protocol `2025-11-25`, send `notifications/initialized`, then `tools/list`. Call `khie_capabilities` to distinguish offline/live mode. Open one session, poll status until ready, enqueue a read with a unique request ID, then retrieve its result. Recovery starts nonblocking with `khie_result` and `recover: true`; poll the cached result. Close the session or shut down. See [the preserved tool definitions](core/docs/tools.json) and [core README](core/README.md) for arguments, quotas and timeout semantics.

## Network and lifecycle boundaries

- No listening address, HTTP server, public tunnel, OAuth grant, persistent credential storage is created by this source. A later explicitly started libp2p node necessarily has its ephemeral peer identity and the pinned pairing library's ephemeral local state; this has not been started during development.
- Only DNS-based WSS port 443 relay addresses are accepted. No IP literals, insecure WebSockets, arbitrary ports, DNSADDR, direct provider dials, WebRTC or address upgrades are allowed. Endpoint peer/relay identities and all later dial routes are pinned.
- This is an exact hostname/multiaddr allowlist, **not DNS-to-IP pinning**. The approved relay's DNS and TLS infrastructure remain trusted. Deployments needing private-IP/SSRF isolation must enforce egress at a separately approved host/network boundary before live use; this build changes no network settings.
- The adapter supports provider endpoints containing a normal relay-only route. WebRTC-only endpoints fail closed. An approved wallet build may need to offer a compatible relay route; one is never fabricated.
- RPC request/response framing is limited to 1 MiB. Core session/result TTLs, request quotas, deduplication, cancellation and cleanup reporting remain intact. Startup/request timeouts are bounded. Relay retries stop during close; a late-created node is disposed. Provider replacement or unpair immediately starts node/relay cleanup and aborts further reads without reconnecting. The adapter independently closes after 30 minutes without a live provider request/recovery; cached-result polling does not extend this network lifetime. Core record/session expiry is separately sweep-driven.
- `websocket.mjs` owns sockets through upgrade failure/cancellation and replaces invalid reset close code 1006 with valid close semantics. `relay.mjs` permits only outbound circuit dialing, suppressing inbound STOP registration, discovery, reservations and listener creation. These wrappers use narrow extension seams in exact-pinned transport packages; upstream changes must be re-reviewed; see [provenance](docs/PROVENANCE.md).

## Remaining integration work

See [later paired-test and helper integration](docs/INTEGRATION.md). A source export is separate from authorization to launch a live pairing, set up a tunnel, upload/publish a repository, or expose an HTTP gateway. No such actions occurred.
