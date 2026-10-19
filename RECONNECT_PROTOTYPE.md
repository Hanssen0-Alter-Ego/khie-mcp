# Reconnect MCP prototype

The audited session-resume prototype is isolated in
[prototypes/reconnect-mcp](prototypes/reconnect-mcp/README.md), on branch
`feat/reconnect-mcp-docker`. The existing adapter, network-free core, recovery
evidence and history are preserved; this branch has not been merged into `main`.

## Verified test image

Linux/amd64 image, published from code commit
`2ebb4258cf679e62530437802ede058693f5294c`:

```text
ghcr.io/hanssen0-alter-ego/khie-mcp-reconnect@sha256:d4015ee3dae12b7a67674d7bcdb583d317903e4fd1d87a379356bc996761ba85
```

The [GitHub Actions run](https://github.com/Hanssen0-Alter-Ego/khie-mcp/actions/runs/39206378579)
passed the build/type check, 29 focused tests, 2 demo process tests, 2 protected
operator-file tests, and the finished-image synthetic MCP smoke. It pushed the
commit tag, verified an authenticated registry pull by digest, and read package
metadata confirming **private** visibility on 2026-10-19.

The repository and image remain private. Pulling requires an existing authorized
GHCR login with access to this package. Anonymous pulls are not enabled. No new
credential, permission grant, or visibility change was made.

After checking out this branch, run from the repository root:

```sh
cd prototypes/reconnect-mcp
export KHIE_IMAGE=ghcr.io/hanssen0-alter-ego/khie-mcp-reconnect@sha256:d4015ee3dae12b7a67674d7bcdb583d317903e4fd1d87a379356bc996761ba85
docker pull "$KHIE_IMAGE"
docker compose -f compose.demo.yaml up -d --wait
docker compose -f compose.demo.yaml exec demo node /app/dist/smoke.js /tmp/khie-mcp-demo/client.json
docker compose -f compose.demo.yaml down
```

This is the synthetic demo only: its fake signing result is not a real signature.
It uses private temporary credentials and removes them on shutdown. Always run
`down` after testing.

For a separately chosen real-wallet test, follow the
[protected read-only operator flow](prototypes/reconnect-mcp/CONTAINERS.md).
Real mobile pairing/resume, public relay behavior and hosted ChatGPT integration
remain unverified. No production wallet or transaction was used in these checks.
