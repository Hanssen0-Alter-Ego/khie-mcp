# Later integration and authorized paired test

## Intended launcher/helper boundary

An existing subprocess MCP helper can launch `node src/cli.mjs` and use stdin/stdout with the seven core tool definitions. For live mode, a **trusted local launcher**, not an MCP tool argument, selects the config file and supplies the one-use sensitive provider endpoint through inherited descriptor 3. Generic MCP launch configurations that support only command/args/env cannot safely carry the endpoint as an argument; add a reviewed local launcher capable of secure descriptor input. No helper was connected during this build.

The service is single-client stdio, not HTTP. A public/private tunnel cannot directly publish it as HTTP MCP. If required later, build a separately reviewed authenticated Streamable HTTP gateway with explicit client identity, Origin validation, session isolation, bounded framing and loopback binding. No tunnel credential, connector permission, installation, gateway or persistent access was created.

The library seam is `createHost({config, endpoint})`; `createLiveFactory` can also be passed into the existing core. `runtimeLoader` is a trusted host testing seam, never a client-controlled input. All runtime dependencies are exact-pinned. Keep the default no-config path offline.

## Minimum paired-test plan, only after explicit authorization

1. Complete independent review of this adapter revision. A fresh isolated frozen-lockfile installation already passed without disabling package checks; repeat it in the intended deployment environment.
2. Choose the intended disposable wallet/provider build and an exact relay hostname. Confirm its endpoint exposes a relay-only circuit route; WebRTC-only routes are unsupported. Approve the intended relay/provider data recipient and the read-only purpose before sharing an endpoint or initiating pairing.
3. Use the intended secure local handoff for the fresh endpoint. It is a pairing credential: do not send it to the assistant in chat, logs, repository, environment variable or command arguments. A user-operated launcher may pass it through descriptor 3.
4. First use metadata-only config. Initialize MCP/list tools without opening a session; confirm there is still no node/network activity. Explicitly open the session and inspect only metadata; record protocol success/failure without the endpoint or other secrets.
5. If account reads are separately desired, restart with a fresh endpoint and explicit `connectNetwork: ckb-testnet`. Have the user approve the connection request inside the wallet. Exercise only the documented four read methods, result retrieval, timeout recovery and close.
6. Test relay loss, startup cancellation, provider restart/unpair and old handle invalidation. Confirm peer/relay sockets close, reconnect does not reuse a consumed endpoint and no forbidden addresses are dialed.
7. Stop after establishing the read-only interoperability result. Signing, send/broadcast and production value transfers require a separate reviewed approval design and authorization; this candidate exposes none of them.

No user input is needed to finish source and fake tests. The first essential later choices are the actual approved provider build, exact relay, secure endpoint handoff/launcher and whether metadata only or wallet-approved account reads are desired. The helper's transport expectation (stdio versus HTTP) must also be confirmed before any tunnel work.
