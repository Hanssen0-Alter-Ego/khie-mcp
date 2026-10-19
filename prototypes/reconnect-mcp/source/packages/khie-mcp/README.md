# Khie MCP prototype

Experimental Node.js prototype for local review. The npm package remains
`private: true` to prevent accidental registry publication. The user owns and runs Khie; the bridge
never creates a wallet or holds its asset signing key. The worker restores its
**own libp2p communication private key**, pinned wallet PeerID/addresses, and
existing JSON-RPC session from a server-side store for each operation. It dials
on demand, requests or polls once, and calls `node.stop()` to close transport.
It does not call connector `close()`, signer `disconnect()`, or pairing `unpair()`.
Existing CCC connector revoke semantics are unchanged.

## Run locally

From the repository root, with Node 24 and the repository's pnpm 11.8.0:

```sh
pnpm --filter @ckb-ccc/khie-mcp... --filter . install --frozen-lockfile
pnpm --filter @ckb-ccc/core --filter @ckb-ccc/libp2p build
pnpm --filter @ckb-ccc/khie-mcp build
pnpm --filter @ckb-ccc/khie-mcp test
pnpm --filter @ckb-ccc/khie-mcp test:demo
```

Two-terminal smoke test, using a synthetic wallet on loopback WebSockets. No
wallet asset keys, real signing, chain clients, or transactions are used:

```sh
# Terminal 1; the directory must not exist
pnpm --filter @ckb-ccc/khie-mcp demo /tmp/khie-mcp-demo

# Terminal 2; credentials are read from a 0600 file, never CLI values
pnpm --filter @ckb-ccc/khie-mcp smoke /tmp/khie-mcp-demo/client.json
```

The independent SDK client performs MCP initialize, tools/list, an authorized
request, identical retry, mismatched retry, and pending/completed polling. The
synthetic signing operation deliberately takes 25 seconds. The server binds
`127.0.0.1:8787`, stops after five minutes or SIGINT/SIGTERM, and deletes its
temporary state and client credential file. Stop it after testing.
The `test:demo` checks use the built demo in separate child processes and need
loopback port 8787 available. They verify startup-failure and SIGTERM cleanup.

## Operator-only enrollment

Use a separate trusted provisioning channel, never tool arguments or chat, for
the wallet's `provider` pairing endpoint. Keep the wallet online. Before using a
real wallet, review this code and verify mobile compatibility; only the synthetic
provider and protocol fixtures have been tested here.

Create an owner-only directory outside the repository with:

- A random 32-byte AES key encoded as base64 in `store-key` (0600).
- An independent, random bearer token with at least 256 bits of entropy in
  `http-token` (0600).
- A `config.json` (0600), with the following non-secret settings and file paths.

```json
{
  "principal": "operator-assigned-user-id",
  "storeDirectory": "/absolute/private/khie/state",
  "storeKeyFile": "/absolute/private/khie/store-key",
  "tokenFile": "/absolute/private/khie/http-token",
  "allowedHosts": ["127.0.0.1:8787", "localhost:8787"],
  "port": 8787,
  "listenHost": "127.0.0.1",
  "networkId": "ckb-testnet",
  "allowedMethods": ["get_identity", "get_native_address", "get_scripts"]
}
```

Save the wallet's endpoint in an owner-only file, then:

```sh
export KHIE_CONFIG_FILE=/absolute/private/khie/config.json
node packages/khie-mcp/dist/cli.js enroll /absolute/private/khie/endpoint
# Approve connection in the user's wallet. Keep the printed opaque handle.
# If setup returns unknown/pending, poll the SAME setup operation:
node packages/khie-mcp/dist/cli.js authorize HANDLE
node packages/khie-mcp/dist/cli.js serve
```

Enrollment generates only a communication identity, pairs using the protected
endpoint, then durably records `get_info` and `connect` IDs. Setup may require
multiple `authorize` invocations while the user reviews the wallet prompt.
There is no model-facing pairing/authorization tool. If pairing itself fails
(including a lost pairing acknowledgement), inspect/revoke the incomplete pair
in the wallet before a new enrollment; do not assume it failed on both sides.

Requests are read-only by default. An operator can opt a handle into
`sign_message` at enrollment; the wallet still confirms the message. This does
not expose transaction preparation, signing, broadcast, arbitrary RPC, or wallet
creation. The synthetic demo enables `sign_message` only to test a pending
operation; its result is not a real signature.

The HTTP CLI defaults to loopback. Containers may explicitly set
`listenHost` to `0.0.0.0` while publishing only on the host loopback interface;
no other bind value is accepted. The synthetic demo accepts the same explicit
choice through `KHIE_LISTEN_HOST`. Authentication and Host checks stay enabled.

## MCP contract

`POST /mcp` uses stateless Streamable HTTP with JSON responses. Supply the bearer
token in the HTTP `Authorization` header through the client credential channel.
Each HTTP request creates a fresh MCP server/transport; wallet state is external
to that lifecycle. The prototype supports one authenticated principal per server.
Handles are scoped to that principal and are not authentication credentials.
All browser Origins are rejected, Host is allowlisted, bodies are bounded to
64 KiB, and only eight HTTP requests may be active. GET/SSE and DELETE return 405.
This is a bounded prototype, not an OAuth implementation or a verified ChatGPT
connector integration.

Example tool arguments (all identifiers below are non-secret placeholders):

```json
{
  "name": "khie_request",
  "arguments": {
    "handle": "OPERATOR_PROVISIONED_UUID",
    "operation_id": "user-intent-001",
    "method": "get_identity",
    "params": []
  }
}
```

Poll with `khie_get_result` and the same `handle` and `operation_id`. Operation
IDs must match `[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}`. Internal setup IDs cannot be
queried through MCP. For messages, `params` contains one `{ "type": "string",
"value": "..." }` or `{ "type": "bytes", "value": "0x..." }` object.

| Outcome                   | Meaning / next action                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `completed`               | Durable returned result; identical retries use the saved result.                     |
| `pending`                 | Wallet still processing/awaiting approval; poll the same operation.                  |
| `unknown`, `transport`    | No reliable reply, possibly already executed; poll only.                             |
| `unknown`, `not_found`    | Never seen **or evicted** by the wallet; do not resubmit automatically.              |
| `unknown`, `wallet_error` | Ambiguous provider error, including unpaired-peer rejection; inspect wallet/pairing. |
| `repair_required`         | Invalid/expired session or authorization state; explicit operator intervention.      |
| `rejected`                | Wallet returned a terminal protocol rejection; code only, raw messages suppressed.   |

A changed payload under an existing ID is rejected before dialing. A request ID
and SHA-256 hash of canonical method/params are saved **before** any dial/send.
Later workers only call `get_result` with that saved ID. Duplicate-request replies
also trigger polling. A crash even just before sending deliberately sacrifices
liveness: `not_found` cannot prove whether execution occurred. Creating a new ID
is a new user intent, not a safe retry. This is not an exactly-once protocol.

Completed results and rejection records are kept locally even if the wallet
evicts its results. There is a hard limit of 1,024 operations per handle with no
automatic eviction of tombstones. Do not restore an older state-store backup or
discard the journal to retry uncertain work. No operation is migrated or replayed
automatically into a newly paired wallet session.

## State-store and deployment boundary

`SecureStateStore` in `src/state.ts` is the explicit integration boundary. A remote
implementation must encrypt secrets/results with a managed key service, enforce
principal access, durably commit before resolving `save`, and serialize a handle
across workers. Use a shared transactional store with fencing when scaling beyond
a single host. Never place communication keys, session IDs, endpoint secrets,
bearer tokens, raw wallet errors, or state blobs in model inputs/results/logs.

`FileSecureStateStore` is a local POSIX demonstration: AES-256-GCM, handle-bound
authenticated data, atomic replace plus file/directory fsync, directory mode 0700,
file mode 0600, and exclusive per-handle lock directories. Workers can be
recreated against the same external directory/key. There is no automatic stale
lock recovery: after a process crash or failed transport cleanup the handle stays
busy. An operator must prove the prior worker/node stopped before removing its
lock. The journal must remain intact. This adapter is not a multi-host store;
secret provisioning, key rotation, access auditing, and backup rollback protection
are deployment responsibilities, not completed features of this prototype.

## Availability and mobile boundary

- The wallet must stay online and reachable. No background wake/push is added.
- Khie pairing can expire after 30 minutes disconnected. Wallet/provider restart
  can lose its in-memory pairing/session/results. Both can require explicit
  re-pairing and new authorization; the bridge never silently reauthorizes.
- Existing generic `ServerError` for an unpaired peer is indistinguishable from
  other provider failures by code alone. It is returned as an unknown outcome,
  with operator inspection required; error-message matching is deliberately avoided.
- Only saved WebSocket/relay addresses are used, pinned to the wallet PeerID.
  Stale relay reservations, relay PeerID changes, wallet migration, or a
  WebRTC-only address can prevent reconnection despite a valid authorization.
  This Node adapter intentionally omits WebRTC/native dependencies. No discovery,
  automatic relay-address refresh, or relay availability guarantee is provided.
  A trusted operator may update addresses in a store adapter only after verifying
  they refer to the same wallet. The model cannot supply dial targets.
- The public mobile `dev` source was inspected at commit
  `ad1cf891e43ff93a7ec3b5538d357b449dd45f9e`. Its Khie screen exports a provider QR
  and copyable endpoint, compatible with this operator-only enrollment direction.
  Its provider owner outlives individual RPC transports. No incoming connector QR
  flow or mobile change is necessary based on that source. This is source evidence,
  not a real-device result; see [mobile readiness](MOBILE_READINESS.md) for the
  exact UI, read-only client, validation scope, and current network blockers.
- If explicit revocation is desired, use the wallet's existing unpair controls.
  Neither temporary transport shutdown nor deleting a local handle revokes the
  remote authorization. Existing CCC revoke methods have not been redefined.

## Public testing status

No public MCP endpoint is deployed. Real mobile pairing, public relay connectivity,
public HTTPS, and host-level ChatGPT connector compatibility remain untested.
The development environment could not resolve the relay; its configured HTTP
proxy rejected the relay CONNECT with 403. A bounded synthetic-only SSH tunnel
prerequisite also stopped at DNS resolution. No tunnel or public URL was created.
See [mobile readiness](MOBILE_READINESS.md) for the scope and prerequisites.

The `smoke` command is synthetic-only. Never point it at a real mobile wallet;
it includes a fake signing operation. The `read-probe` command is limited to
loopback and read methods for a separately authorized operator-led device test.
