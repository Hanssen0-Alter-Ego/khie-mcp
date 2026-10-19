# Publication review

The publication is a fresh source-only repository. It does not include the
original CCC Git history, private repository history, working-tree metadata,
authentication configuration, dependencies, builds, encrypted state, pairing
endpoints or generated runtime credentials.

## Checks completed

- An explicit 26-file change inventory was reconstructed against the exact public
  CCC commit in `UPSTREAM.json`; no other upstream files are changed.
- The bundled patch passed `git apply --check` and actual application to a clean
  archive. All 24 package files match the publication source; root lockfile and
  test configuration match the validated CCC working changes.
- All 21 non-documentation package files match the tested implementation bytes.
  The package Markdown documents were sanitized for publication. Container
  bind-address support is an explicit follow-up with fresh validation below.
- The bootstrap passes Node syntax checking, materializes successfully from a
  local CCC object database without copying its config/history, and refuses an
  existing destination. A corrupted-patch check refuses to create a workspace.
- The publication file inventory and source text were reviewed. Pattern checks
  for private-key PEM data, GitHub tokens, cloud access keys, JWTs, URL credentials,
  internal environment addresses and private-repository references found none.
  These checks are not a general security certification.
- The three secret-like source constants are intentionally noncredential test
  fixtures: synthetic communication/session strings in `bridge.test.ts` and a
  synthetic pairing string in `mobileEndpoint.test.ts`. No generated key, bearer
  token, actual pairing endpoint or wallet state is committed. The mobile fixture
  uses the reserved `.invalid` domain and public-format dummy peer identifiers.
- Dependency integrity hashes, public commit hashes, operation IDs and protocol
  examples are retained for reproducibility. Runtime keys/tokens are generated
  in isolated tests and removed by cleanup.

`MANIFEST.json` inventories the final source files; Git commits identify the
history. The source archive and Git bundle are generated from the fresh local
commit, not from the original CCC working directory. See the package review
record for test results and unverified mobile/public-network boundaries.

## Container publication additions

Docker and Compose files, protected operator provisioning helpers, tests, a
synthetic-only image smoke and a repository-scoped GHCR workflow were added.
The Node base is digest-pinned; actions/checkout and actions/setup-node pins were
resolved from their official repositories. The workflow uses only the existing
job token, with contents read/package write permissions, and retains no checkout
credential. No persistent access or repository policy is changed.

The audited container build context excludes operator state, secret files, Git
history and local authentication configuration. The separate offline validation
contexts contained only already-downloaded public package content/metadata and
are not part of the runtime image or published source. Docker/Compose validation
results and limitations are recorded in `CONTAINERS.md`. The final source audit
and exact-base patch application were repeated after the container additions.

## Private repository integration

On 2026-10-19 the user selected the existing private Khie MCP repository. The
audited source is added under `prototypes/reconnect-mcp` without changing any
existing file or repository visibility. Only source labels, package destination,
workflow path/branch, navigation documentation and this file inventory changed.
The runtime/test/config source and exact-base patch remain byte-identical to the
delivered archive. The original archive remains valid and is not replaced.
