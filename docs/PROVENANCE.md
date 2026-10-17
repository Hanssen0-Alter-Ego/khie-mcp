# Provenance and dependency evidence

This separate candidate was implemented on 2026-10-17. It includes the unchanged reviewed core and a new opt-in transport adapter. It is not the missing original service and does not claim historical tests were restored.

## Source basis

Public CCC commit `02631e902c8a52af1824443661ae87dfb914a96d`:
- [Khie connector session](https://github.com/ckb-devrel/ccc/blob/02631e902c8a52af1824443661ae87dfb914a96d/packages/connector/src/scenes/khie/session.ts)
- [Khie connector node](https://github.com/ckb-devrel/ccc/blob/02631e902c8a52af1824443661ae87dfb914a96d/packages/connector/src/scenes/khie/node.ts)

Read-only inspection of the accessible wallet's `KhieProviderSession.ts`, `protocol.ts`, and pairing codec established provider role, relay route and protocol compatibility. Installed exact-pinned source was inspected for CCC pairing, relay retries, JSON-RPC framing, metadata/session conventions, error codes and request-result recovery. No private wallet source was copied wholesale; no original archive was accessed.

Additional installed source examined:
- `@ckb-ccc/libp2p@0.3.2`: pairingEndpoint.ts, pairingService.ts, relayConnection.ts, jsonRpcTransport.ts.
- `@ckb-ccc/core@1.23.0`: signer/jsonRpc/handler.ts and related protocol code.
- `libp2p@3.3.12`: connection gater, dial queue/resolvers and upgrader.
- `@libp2p/circuit-relay-v2@4.2.14`: outgoing route construction, relay transport/server gate semantics.
- `@libp2p/websockets@10.1.22`: WSS dialing and pre-upgrade socket lifetime.

The pinned WebSocket package omits socket close on aborted opening and failed upgrade; its reset routine also uses invalid WebSocket close code 1006. The candidate retains ownership through the entire dial/upgrade, substitutes valid reset close semantics, and disposes late upgrade results. Tests exercise the actual pinned WebSocket transport and maConn implementation with standards-conforming fake sockets and fake upgraders, covering failures, cancellation and late resolution/rejection.

The pinned circuit relay transport's incoming STOP path can start a listener/reservation before its denial gate. `relay.mjs` preserves its outgoing dial implementation while suppressing stock STOP/discovery startup, blocking reservations/listeners and terminating any directly invoked STOP handler. Tests instantiate the actual pinned relay transport with fake components, verify no handlers/topologies/listeners/reservations are registered, and invoke its wrapped STOP entrypoint. No node, key or network socket is created by these tests.

Both wrappers use internal seams in exact-pinned packages and fail closed on detected API-shape changes. Dependency upgrades require independent transport review and fresh integration validation.

## Pinned dependency graph

Nine exact direct dependencies are declared. The root lockfile retains the 153 reachable package/snapshot entries from the existing wallet's pinned graph with registry integrity hashes. Local `node_modules` consists only of development symlinks to the already installed matching dependencies; it is not part of the candidate or manifest.

After the initial installation pause was lifted, a fresh isolated `pnpm install --frozen-lockfile --ignore-scripts` completed successfully with a 512 MiB Node heap cap and concurrency 1. pnpm verified all 153 entries against its normal supply-chain policies and materialized 134 cached packages with zero package tarball downloads. The full offline suite passed using that installation. No lifecycle install scripts ran and no supply-chain or TLS check was disabled. This is separate from the core's earlier 116-entry install check and is not a full security audit.

The production modules were successfully imported without constructing a libp2p node. Tests use public synthetic pairing strings, inert peer IDs, fake nodes/transports and fake wallets. There are no real keys, mnemonics, addresses, balances, signatures, transaction broadcasts, relay sessions or private tunnels in the fixtures.
