# Khie MCP resume prototype

Experimental bridge for a **user-owned Khie wallet**. An AI client calls two MCP
tools using an opaque handle. Each operation restores the bridge's libp2p
communication identity and the existing wallet authorization session, connects
on demand, requests or polls once, then closes only the transport. The bridge
does not own a wallet or hold an asset signing key.

This is source for review, with no deployed service or verified ChatGPT connector.
It uses the official MCP SDK and the existing CCC libp2p/JSON-RPC implementation.
Read methods are enabled by default. Operator opt-in message signing still needs
wallet confirmation; no transaction or broadcast tool is exposed.

This copy is isolated in the existing private `Hanssen0-Alter-Ego/khie-mcp`
repository on `feat/reconnect-mcp-docker`. Run the commands below from
`prototypes/reconnect-mcp`. Existing implementations and history are preserved.
See `INTEGRATION.json` for the audited source provenance.

## Docker quick start

See [CONTAINERS.md](CONTAINERS.md) for Docker/Compose build instructions, the
synthetic demo, protected persistent operator mounts, read-only enrollment and
the repository-root `.github/workflows/reconnect-container.yaml` workflow. The initial image target is Linux/amd64.

## Reconstruct and run

This package depends on the CCC workspace. It is supplied as readable source plus
an exact-base patch, rather than an independently installable npm package.
Prerequisites: Node 24, Git, tar and pnpm 11.8.0. From this repository:

```sh
node scripts/prepare-workspace.mjs ./ccc-workspace
cd ccc-workspace
pnpm --filter @ckb-ccc/khie-mcp... --filter . install --frozen-lockfile --ignore-scripts
pnpm --filter @ckb-ccc/core --filter @ckb-ccc/libp2p build
pnpm --filter @ckb-ccc/khie-mcp build
pnpm --filter @ckb-ccc/khie-mcp test
pnpm --filter @ckb-ccc/khie-mcp test:demo
```

The bootstrap fetches only public CCC commit
`0abf78e5f469216e82a24de8d4051e757368af90`, verifies the bundled patch digest,
extracts that commit and applies the patch. It never overwrites an existing
destination, installs dependencies or starts a service. For offline preparation
from a local CCC checkout containing that commit:

```sh
node scripts/prepare-workspace.mjs --source /path/to/ccc ./ccc-workspace
```

The generated workspace contains upstream source at that exact commit and this
prototype; it has no copied Git history or authentication configuration. It is
excluded from this repository. Keep upstream instructions and notices intact.

For a synthetic-only, two-terminal test inside the generated workspace:

```sh
# Terminal 1; this temporary directory must not exist
pnpm --filter @ckb-ccc/khie-mcp demo /tmp/khie-mcp-demo
# Terminal 2
pnpm --filter @ckb-ccc/khie-mcp smoke /tmp/khie-mcp-demo/client.json
```

The demo uses loopback peers and an invalid synthetic signature, generates
short-lived credentials locally, stops after five minutes, and deletes its state.
The smoke command is **only for this synthetic demo**, never a real mobile wallet.
See the [package guide](source/packages/khie-mcp/README.md) for protected operator
enrollment, MCP arguments, state-store contract and configuration. Start with the
[read-only device checklist](source/packages/khie-mcp/MOBILE_READINESS.md) if you
separately choose to test your own wallet.

## Request safety and boundaries

- The communication key, authorization session and result journal stay in an
  external secure store. MCP arguments/results do not carry those secrets.
- A durable request ID and canonical payload hash are saved before network use.
  Same-ID retries poll or return a stored result; changed payloads are rejected.
  Timeout and wallet-evicted `not_found` are uncertain, never proof of nonexecution.
- `node.stop()` closes transport. Explicit wallet unpair/revoke semantics remain
  unchanged. The prototype never silently reauthorizes or replays into a new pair.
- The local encrypted file store serializes one handle on one host. Multi-host
  deployment needs a secure transactional store with fencing. Crash/cleanup locks
  require operator inspection; journal history must not be rolled back or discarded.
- The wallet must stay online and reachable. The existing 30-minute disconnected
  expiry and in-memory state loss on wallet restart may require explicit re-pairing.
  Persistent wallet authorization and background wake are outside this MVP.
- Saved relay addresses can become stale even while authorization is valid. This
  adapter supports WebSocket/circuit relay, without WebRTC, discovery or address
  refresh. A public HTTP tunnel does not solve wallet relay reachability.
- HTTP supports one principal, a bearer token, an exact Host allowlist and bounded
  stateless Streamable HTTP requests. This is not OAuth or production hardening.

## Validation status

The Docker build passed dependency/package builds, type checking and the full
**29-test** focused suite, plus **2** demo process checks. **2** operator-file
checks passed outside the image. Earlier CCC regressions passed **54** tests,
and the separate-process synthetic MCP-to-libp2p smoke passed. The entire
monorepo suite was not run. See the container guide for the distinction between
the DNS-blocked standard build and the validated offline-cache build. The final
non-root image smoke and protected operator Compose startup/restart checks also
passed. No public GHCR image has been published yet.

[Validation details](source/packages/khie-mcp/REVIEW.md) distinguish mocks, real
loopback peers and process tests. Actual mobile pairing/resume, public relay
connections, public HTTPS, power-loss durability, distributed workers and host
connector compatibility remain unverified. The development environment's DNS and
proxy restrictions blocked public-network validation; no bypass or deployment was
performed.

## Contents and provenance

- `source/packages/khie-mcp/`: readable new package, tests and operator docs.
- `patches/ccc-khie-mcp.patch`: all 26 changes, including the workspace lockfile and
  test-project registration, against the immutable CCC base in `UPSTREAM.json`.
- `scripts/prepare-workspace.mjs`: materializes that exact review workspace.
- `MANIFEST.json`: SHA-256 inventory of publication files (excluding itself).

Runtime, test and configuration source matches the locally validated prototype.
Publication docs omit internal environment addresses, tool paths and private
repository information. Only explicitly synthetic fixture strings are included;
there are no generated tokens, encrypted wallet state or user credentials.

See [NOTICE.md](NOTICE.md) for CCC attribution and license declarations. New
contributions are MIT licensed. This repository is an independent prototype and
has not been merged into CCC or the Khie mobile application.
