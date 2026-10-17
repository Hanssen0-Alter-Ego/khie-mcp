# Later integration boundary

## MCP client or existing helper

The current candidate can be exercised by an MCP client launching:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/khie-mcp-rebuilt/src/cli.mjs"]
}
```

This runs the offline fixture. The client must complete initialize → notifications/initialized → tools/list. Use session_open → poll session_status → request → result → session_close. EOF or a termination signal closes the process. The scripts do not emit banners or logs on stdout.

Previously recovered tunnel/client helper scripts are transport helpers, not this service's missing source. They must consume this new tool contract, not assume six historical tool names. They may launch and connect to this process only through their existing authorized local subprocess/stdin/stdout boundary. No helper has been changed or connected as part of this build.

A tunnel cannot directly publish stdio as an HTTP MCP service. If a helper expects HTTP, add a separately reviewed Streamable HTTP gateway with authenticated client identity, Origin validation, session isolation, bounded framing, correct HTTP protocol negotiation and loopback binding by default. Do not expose this raw single-client service to a public URL. This candidate creates no tunnel, connector permission, OAuth grant, API key or persistent access.

## Borrowing an already authorized Khie connection

The library boundary is:

```js
const adapter = new KhieRpcAdapter({
  transport,                 // existing CCC JsonRpcTransport
  providerSessionId,         // current approved provider session
  close: releaseOwnedResources
});
const service = new KhieService({ transportFactory: () => adapter });
```

Create one distinct adapter per service session. Never reuse one adapter across sessions. The factory receives `{ sessionId, signal }`; it must honor the abort signal and stop resources if initialization races close. `close` must release exactly the resources owned by that session and should be idempotent. Late initialization is disposed, and cleanup failures are reported.

For an existing node/peer, `borrowLibp2pAdapter({ node, peerId, providerSessionId, signal, close })` constructs the pinned CCC transport with the Khie JSON-RPC protocol and 1 MiB message bound. It does not create the node, pair a wallet or perform `connect`. `ready()` reads get_info and verifies the provider session has not changed. Provider `connect` approval must already have occurred through a separately authorized human wallet flow.

No code here takes a secret from the CLI, creates a wallet key, displays a pairing secret, calls a real wallet, signs or sends an actual transaction. When adding live pairing, keep pairing secrets out of logs, URLs outside the intended pairing channel, tool schemas and test fixtures. Do not treat model-supplied approval flags as user confirmation.

## Minimum next validation

1. Independent static review of lifecycle, request retention, recovery and approval races.
2. Test this new stdio schema against the intended MCP client or existing helper using offline fixture data.
3. Add a network-disabled in-memory libp2p stream fixture, then separately authorized disposable test-environment pairing if needed.
4. Verify Node/WebRTC transport support, relay reconnection, provider change and unpair handling before live use.
5. Design and review the trusted approval UI before any signing capability is exposed; transaction broadcast remains a human-controlled action.
6. Only after authorization, decide where to commit/publish the candidate and whether a separately authenticated gateway is wanted.
