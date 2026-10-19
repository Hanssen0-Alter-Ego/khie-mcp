# Local container testing

The container runs as UID/GID 1000 by default. Compose keeps its root filesystem
read-only, drops Linux capabilities, prevents privilege escalation, limits
resources and publishes port 8787 only on **127.0.0.1**. It does not mount a Docker
socket or create a wallet. Linux/amd64 is the initial supported image target;
ARM64/native Apple Silicon builds have not been validated. Docker Desktop on ARM
may emulate amd64, with no performance guarantee.

## Build from source

Use Node 24 and Git/tar to reconstruct the pinned CCC source, then Docker Engine
with BuildKit and Compose v2:

```sh
node scripts/prepare-workspace.mjs ./ccc-workspace
docker build --platform linux/amd64 --build-arg VCS_REF="$(git rev-parse HEAD)" -t khie-mcp-resume-prototype:local .
node scripts/container-smoke.mjs khie-mcp-resume-prototype:local
```

If the exact CCC commit is already available locally, add
`--source /path/to/ccc` before the destination in the first command. The generated
directory must not exist. Never substitute a working-tree copy containing local
credentials. `.dockerignore` permits only the reconstructed core/libp2p/prototype
packages and required manifests; runtime credentials and Git history are excluded.

The Dockerfile pins the official Node 24.19.0 Debian bookworm-slim image by digest,
pnpm 11.8.0, and the frozen workspace lockfile. It runs builds, type checking,
all package tests and child-process checks before producing a non-root runtime
with production dependencies. No apt packages or native WebRTC modules are added.
Source/dependency versions are pinned; no claim of bit-for-bit image determinism
or a vulnerability-free base is made. Upstream licenses/package manifests remain
in the dependency tree, with prototype/base provenance under `/app/provenance`.

Run these commands from `prototypes/reconnect-mcp`. The repository-root workflow
`.github/workflows/reconnect-container.yaml` is limited to private repository
`Hanssen0-Alter-Ego/khie-mcp`, branch `feat/reconnect-mcp-docker`. It uses immutable action SHAs and the job's ephemeral
`GITHUB_TOKEN` with only `contents: read` and `packages: write`; no PAT or new
persistent credential is needed. This follows the [GitHub Packages workflow](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images). It publishes only after build/tests/container
smoke pass. The workflow creates a commit-specific image tag; it does not overwrite an
existing mutable alias:

- `ghcr.io/hanssen0-alter-ego/khie-mcp-reconnect:sha-COMMIT_SHA`

Use the verified digest from the successful Actions summary for repeatable runs:

```sh
# Replace VERIFIED_DIGEST with the actual published sha256 value, never a guess.
export KHIE_IMAGE=ghcr.io/hanssen0-alter-ego/khie-mcp-reconnect@sha256:VERIFIED_DIGEST
docker pull "$KHIE_IMAGE"
```

This repository stays private, and the workflow does not change package
visibility. Use an existing authorized GHCR login for a private image; no
anonymous pull is promised. Publication is complete only after the workflow
confirms an authenticated pull by digest and package visibility is inspected. If existing repository/token policy denies workflow
or package publication, stop; this workflow does not change policy or credentials.

## Synthetic demo — no wallet or provisioning needed

With the local image built, or `KHIE_IMAGE` set to a verified published digest:

```sh
docker compose -f compose.demo.yaml up -d --wait
docker compose -f compose.demo.yaml exec demo node /app/dist/smoke.js /tmp/khie-mcp-demo/client.json
docker compose -f compose.demo.yaml down
```

The SDK smoke deliberately uses a fake 25-second signing action and an invalid
signature. **Do not use it against a real wallet.** The demo's token, communication
keys and state exist only in private files on tmpfs. It stops and removes those
files after five minutes or SIGTERM; Compose does not restart it. No credential
is supplied as a model argument, URL, environment value or command-line value.
Do not copy or print `client.json` into chat or logs.

`container-smoke.mjs` independently checks missing-configuration refusal,
non-root execution, host-loopback publication and HTTP 401 without a token. It
then runs the real SDK/HTTP/bridge/libp2p synthetic smoke inside the container and
checks graceful cleanup. It removes its container even after failure.

## Real wallet — separate, read-only operator flow

Actual device pairing/resume and public relay behavior are still unverified.
Use your own unfunded testnet wallet only after reviewing the implementation.
The prototype has no asset signing key. Keep Khie foregrounded, online and
reachable; perform all secret transfer locally, never through chat or MCP.

1. As a non-root operator, create fresh files **outside this checkout**. The parent
   directory must already exist. The helper generates only a store-encryption key
   and HTTP token, never a wallet or asset key:

   ```sh
   mkdir -p "$HOME/.local/share"
   export KHIE_PRIVATE_DIR="$HOME/.local/share/khie-mcp"
   export KHIE_UID="$(id -u)" KHIE_GID="$(id -g)"
   node scripts/init-operator.mjs "$KHIE_PRIVATE_DIR"
   ```

   Directories are 0700 and files 0600. Compose bind-mounts `secrets/` read-only
   and `state/` read/write, without auto-creating missing host paths. Numeric
   ownership must match `KHIE_UID:KHIE_GID`; the application refuses unsafe file
   ownership/mode or missing auth. Rootless/user-namespace Docker mappings must
   preserve that ownership; do not loosen permissions to work around a mismatch.
   This uses protected bind mounts because local Compose secret files do not
   guarantee portable UID/mode remapping. No secret appears in Compose or ENV. See the [Compose secret model](https://docs.docker.com/compose/how-tos/use-secrets/) for file-mount behavior.

2. Privately copy Khie's unpaired **provider** endpoint into
   `$KHIE_PRIVATE_DIR/secrets/endpoint` with mode 0600. The full endpoint contains
   a one-time pairing credential. Enroll through the trusted local CLI:

   ```sh
   docker compose run --rm bridge enroll /run/khie/endpoint
   # If pending, preserve the printed non-secret HANDLE and poll setup:
   docker compose run --rm bridge authorize HANDLE
   ```

   Approve connection in the wallet. If pairing acknowledgement is uncertain,
   inspect/revoke the incomplete pair before any new enrollment. Do not discard
   the request journal. Remove the endpoint file after successful setup.

3. Build protected local client settings from that handle, then start the server:

   ```sh
   node scripts/write-read-client.mjs "$KHIE_PRIVATE_DIR" HANDLE
   docker compose up -d --wait bridge
   docker compose exec bridge node /app/dist/readProbe.js /run/khie/client.json request mobile-read-001 get_identity
   docker compose exec bridge node /app/dist/readProbe.js /run/khie/client.json poll mobile-read-001
   ```

   `HANDLE` is the actual opaque UUID printed during enrollment. The config
   permits only `get_identity`, `get_native_address` and `get_scripts`. Its explicit
   `listenHost: 0.0.0.0` is for the container network; host publication remains
   loopback and HTTP bearer/Host/Origin checks remain enabled. Outside a container,
   omit `listenHost` to retain the CLI's loopback default.

4. Restart only the bridge with `docker compose restart bridge`, preserving all
   mounted state/key files, then request `mobile-read-002 get_identity` to test an
   uncached read without new authorization. Reuse existing IDs only for identical
   intents. A timeout or `not_found` is never proof the action did not execute.
   Stop with `docker compose down`; this retains operator state and secrets.

The state directory contains encrypted identity, session and durable request
records. Keep its encryption key safe and stable across container replacements;
do not generate a new key for an existing store or roll back its journal. Locks
left by a crash or failed transport cleanup require proving the previous worker
stopped before operator recovery. Do not automatically delete locks or restart
uncertain work under new IDs. This is a single-host adapter, not a distributed
state service.

The container needs permitted DNS and outbound WSS to the wallet's saved relay.
No background wake, wallet persistence, proxy adapter, relay discovery/address
refresh or WebRTC is included. Pairing may expire after 30 minutes disconnected;
wallet restart or stale relay addresses can require explicit repair/re-pairing.
A public MCP tunnel does not repair the wallet-to-relay path. Revoke through the
wallet's unpair controls; removing local files is not remote revocation.

## Local build validation boundary

The standard Dockerfile's first npm request failed with `EAI_AGAIN` for the npm
registry in the restricted build network. No DNS/proxy bypass was used. The
validation-only `container/Dockerfile.offline` substitutes the already cached
pnpm package, package store and release-age metadata, preserves frozen installs
and policy checks, and executes the same builds/tests/runtime stages. Those cache
directories are build-only inputs, not publication artifacts or image contents.

To reproduce that variant where equivalent public-package caches exist:

```sh
docker build --platform linux/amd64 -f container/Dockerfile.offline \
  --build-context pnpm_tool=/path/to/pnpm/package \
  --build-context pnpm_store=/path/to/pnpm/store \
  --build-context pnpm_metadata=/path/to/xdg/cache \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  -t khie-mcp-resume-prototype:local .
```

Never supply home directories, registry credentials or unrelated private files
as cache contexts. The regular CI build uses this prototype directory's Dockerfile with permitted
registry connectivity. Local offline validation alone does not establish GHCR
publication or public-network wallet compatibility.

## Results for this local validation

Docker Engine 28.4.0, Compose 2.40.3, Buildx 0.31.0; Linux/amd64, Node 24.19.0.
The offline-cache image build **passed**, including all **29** focused tests,
**2** demo process checks, dependency/package builds and type checking. The
operator helper tests passed **2** tests. The primary online build did not finish
because registry DNS failed; it is not reported as a successful build.

`node scripts/container-smoke.mjs khie-mcp-resume-prototype:local` **passed**:
missing config fails closed, runtime UID is nonzero, host publication is loopback,
unauthenticated HTTP returns 401, and real SDK initialize/list/request/retry/
mismatch/pending/completed calls work against the synthetic libp2p wallet.
Graceful stop reported one authorization and one fake signing action, then removed
state/credentials. TypeScript and Vitest are absent from the runtime package's
node_modules. No production wallet or real signature was involved.

The operator Compose service also **passed** startup/health, owner/mode checks on
protected bind mounts, non-root execution, state-marker persistence across a
restart, and complete test-resource cleanup. No wallet was enrolled/contacted.
Both Compose configurations parse successfully.

Local image ID (configuration digest, **not** a registry/pull digest):
`sha256:d1cab9c3fc20a53a60cdfacac70b1a1b68716a41be4bddbdf630f6980eae9a88`.
It is tagged locally as `khie-mcp-resume-prototype:local`; no GHCR tag/digest or
successful Actions run is claimed until this private repository's workflow
completes and the result is verified. The tested runtime code matches the publication; subsequent
documentation edits do not change those tested code bytes.
