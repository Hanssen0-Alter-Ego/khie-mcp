# Mobile readiness and network checks

Inspected on 2026-10-18 using the permitted read-only GitHub connector. Public
`Hanssen0/khie-mobile` default branch `dev` resolved to
[`ad1cf891e43ff93a7ec3b5538d357b449dd45f9e`](https://github.com/Hanssen0/khie-mobile/commit/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e).
The important files were also fetched at that immutable SHA and matched the
initial branch reads. No mobile files or repository permissions were changed.

## Confirmed pairing flow

- [KhieScreen.tsx, lines 85–90](https://github.com/Hanssen0/khie-mobile/blob/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e/src/ui/KhieScreen.tsx#L85)
  contains both connector scanning/pasting and a provider QR with a copy action.
  The provider export is shown while unpaired, below the divider. Developer mode
  only controls raw text/debug display; copying is available without it.
- [KhieProviderSession.ts, line 430](https://github.com/Hanssen0/khie-mobile/blob/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e/src/khie/KhieProviderSession.ts#L430)
  encodes the node's addresses and current pairing secret with role `provider`.
  [App.tsx, line 163](https://github.com/Hanssen0/khie-mobile/blob/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e/App.tsx#L163)
  supplies the base `https://app.ckbccc.com/khie`. The actual format is
  `https://app.ckbccc.com/khie#?role=provider&addresses=...&secret=...`.
- [App.tsx, line 698](https://github.com/Hanssen0/khie-mobile/blob/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e/App.tsx#L698)
  enables pairing while the unpaired Khie/scanner screen is open. Leaving it
  disables pairing. The wallet must remain foregrounded for this MVP test.
- [App.tsx, line 1254](https://github.com/Hanssen0/khie-mobile/blob/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e/App.tsx#L1254)
  deliberately keeps the provider owner alive beyond each transport request.
  Unpair invalidates that owner. The
  [RPC guard](https://github.com/Hanssen0/khie-mobile/blob/ad1cf891e43ff93a7ec3b5538d357b449dd45f9e/src/khie/KhieProviderSession.ts#L548)
  checks the caller's paired and selected PeerID. These behaviors fit restored
  bridge identity and session resume; device acceptance is still outstanding.

No incoming connector QR implementation is needed. The complete provider QR/link
is a one-time credential, even though its relay addresses and PeerIDs are public.
Transfer it only through the operator's protected channel into a 0600 file inside
a 0700 directory; never send it through chat or MCP. Remove that temporary file
after successful enrollment. If pairing acknowledgement is lost, inspect/revoke
the incomplete pairing before enrolling again. Do not discard uncertain journals.

The bridge does not fetch the HTTPS URL. It decodes the fragment, then initiates
outbound WebSocket/Noise/Yamux connections through a saved circuit-relay address.
It has no libp2p listener or public HTTP requirement. Mobile must have a live relay
reservation and advertise at least one supported circuit/WebSocket route; a
WebRTC-only route is insufficient. The existing 30-minute disconnected expiry,
process-scoped mobile authorization and stale-address limitations still apply.

## Read-only local client

`src/readProbe.ts` initializes the real MCP SDK, discovers tools, performs one
read or result poll, and closes its client. It never generates an operation ID,
automatically retries, or requests signing. Requests allow only `get_identity`,
`get_native_address`, and `get_scripts`. Every invocation needs an explicit ID;
reuse it for the same intent. Unknown/not_found is never a reason to create a new
ID for an uncertain operation.

The operator creates `client.json` with mode 0600 in an owner-only directory:

```json
{
  "endpoint": "http://127.0.0.1:8787/mcp",
  "handle": "OPERATOR_PROVISIONED_UUID",
  "token": "OPERATOR_INSERTS_TOKEN_LOCALLY"
}
```

The token must be the server's configured token, supplied privately. The client
accepts only loopback `http://127.0.0.1:<port>/mcp`, rejects URL credentials,
queries and fragments, reads the protected file without following a symlink,
and suppresses raw setup/SDK/transport exceptions. Wallet identity/address
results are printed for operator comparison; no synthetic result is assumed.

Once network access and a protected provisioning channel are available:

1. Use a user-created unfunded testnet wallet and keep its unpaired Khie screen
   open until its provider QR appears. Copy that endpoint privately.
2. Follow README operator configuration with read-only methods. Run
   `node packages/khie-mcp/dist/cli.js enroll /private/endpoint`; approve the
   connection in the wallet. For delayed authorization, use the printed handle
   with `cli.js authorize HANDLE`, preserving the existing setup operation.
3. Start `cli.js serve` with the same protected `KHIE_CONFIG_FILE`, then run:

   ```sh
   pnpm --filter @ckb-ccc/khie-mcp read-probe /private/client.json request mobile-read-001 get_identity
   pnpm --filter @ckb-ccc/khie-mcp read-probe /private/client.json poll mobile-read-001
   ```

4. Restart only the bridge server using the same store/key. Issue a new harmless
   read with `mobile-read-002` and confirm no new wallet authorization and the
   same caller identity. A cached retry alone cannot prove reconnection.
5. Repeat `mobile-read-001` unchanged, then request `get_native_address` under
   that same ID to verify mismatch rejection. Use a new ID for a separately
   intended address read. Revoke the test pair in the wallet and check a new
   uncached read fails without silent reauthorization.

Do not run `smoke.js` against mobile: it is intentionally synthetic-only and
includes a synthetic signing operation. The local probe has no signing path.

## Network readiness observed during validation

The development environment's system DNS returned `EAI_AGAIN` for both the
public relay and a control hostname. Its configured HTTP proxy rejected CONNECT
to `relay.ckbccc.com:443` with HTTP 403 before the wallet protocol was reached.
A separately authorized synthetic-only tunnel prerequisite to `free.pinggy.io`
failed at DNS resolution, before host-key exchange or forwarding. A previously
attempted tunnel-binary release lookup was denied with HTTP 403 and was stopped.
No route was bypassed, and no public MCP URL, tunnel, or production deployment
was created. These are environment observations, not a claim that those public
services are unavailable.

A device test needs permitted DNS and outbound WSS connectivity to the wallet's
live relay. The installed libp2p transport uses `new WebSocket(uri)` and this
package provides no HTTP-proxy adapter. A public MCP tunnel does not repair the
wallet relay connection. The operator may run this local prototype on a computer
with permitted network access.

Any separately authorized public test should use the synthetic demo, retain its
application bearer authentication, verify any SSH host key through a trusted
source, and preserve the exact Host allowlist. No host-level ChatGPT connector
authentication compatibility or public HTTPS result is claimed.

## Validation scope

The new mobile wire tests independently encode the inspected length-prefixed,
zlib/base64url address format using Node zlib, then exercise the actual CCC decoder
and operator enrollment with an isolated node mock. They cover the mobile URL
shape, mixed WebRTC/circuit addresses, saved caller identity, omission of the
one-time endpoint secret from resume state, and role rejection before state/node
creation. They do not execute React Native or claim a real relay connection.

Read-probe tests use actual MCP SDK HTTP initialization/discovery against an
isolated mock bridge, checking one-call reads, stable-ID polling, signing denial,
protected file permissions, local-only destinations and error redaction. Existing
passing suites and the synthetic end-to-end smoke were not repeated unchanged.
Real mobile pairing/resume, actual relay behavior, pending mobile operations,
expiry/restart, public HTTPS and host connector compatibility remain untested.
