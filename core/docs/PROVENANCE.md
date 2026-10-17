# Provenance and reconstruction scope

This repository was newly implemented in its own directory on 2026-10-17. The missing original archive was unavailable; it was not used, recovered or reconstructed byte-for-byte. No other working tree was modified, and no remote branch, PR, release or package was published.

## Public pinned source examined

CCC commit: `02631e902c8a52af1824443661ae87dfb914a96d`.

- [Connector Khie session](https://github.com/ckb-devrel/ccc/blob/02631e902c8a52af1824443661ae87dfb914a96d/packages/connector/src/scenes/khie/session.ts): selected-peer ownership, pairing role, transport construction and close semantics.
- [Connector Khie node](https://github.com/ckb-devrel/ccc/blob/02631e902c8a52af1824443661ae87dfb914a96d/packages/connector/src/scenes/khie/node.ts): protocol strings, lifecycle and node ownership.
- Installed `@ckb-ccc/libp2p@0.3.2` source: `jsonRpcTransport.ts`, `jsonRpcService.ts`, `pairingEndpoint.ts`. This established 1 MiB framing, transport timeout/abort behavior and pairing endpoint bounds.
- Installed `@ckb-ccc/core@1.23.0` source: `signer/jsonRpc/handler.ts`, `signer.ts`, `transformers.ts`, `network.ts`. This established `request_id`/`session_id`, `get_info`, `connect`, error codes, `get_result` and signer message/transaction conventions.
- The accessible Khie wallet source was inspected read-only for `KhieProviderSession.ts`, `protocol.ts` and `pairingEndpointCodec.ts`. It was not copied wholesale into this candidate.

## MCP specification examined

- [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Initialization and lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [Tool schemas and errors](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## Dependency evidence

The initial dependency graph was selected from the accessible wallet's already pinned lockfile and reduced to the two declared direct dependencies and their reachable transitive snapshots. `pnpm install --frozen-lockfile --ignore-scripts` completed successfully after fetching missing registry metadata at a reduced concurrency. The package manager reported that the 116-entry lockfile passed its supply-chain policies. No lifecycle install scripts were run and no verification checks were disabled.

Earlier offline metadata checks could not complete; one high-concurrency metadata fetch exited 137. These were resolved by a normal checked install with concurrency 1. This is an installation check, not a full security audit or vulnerability-free claim.

New source/test files use Node built-ins plus the exact CCC packages above. Test fixtures have no real keys, mnemonics, wallet addresses, balances, transaction broadcasts or remote tunnels.
