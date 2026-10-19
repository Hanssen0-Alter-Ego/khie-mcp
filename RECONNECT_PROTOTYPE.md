# Reconnect MCP prototype

The existing opt-in adapter, network-free core, recovery evidence and history
remain unchanged. The user-owned-wallet session-resume prototype is isolated in
[prototypes/reconnect-mcp](prototypes/reconnect-mcp/README.md) on branch
`feat/reconnect-mcp-docker`; this branch is not merged into `main`.

Start with its [container guide](prototypes/reconnect-mcp/CONTAINERS.md). It has
separate synthetic-demo and protected read-only operator flows. Its runtime code
is the audited source delivered on 2026-10-18; packaging metadata/workflow paths
are adapted for this established private repository.

The repository remains private. The scoped image workflow uses only the existing
job token and does not change repository/package visibility, grants or persistent
credentials. GHCR publication, registry digest and package visibility must be
verified from the run before claiming a pullable image. No anonymous image access
is promised. Real mobile, public relay and hosted ChatGPT integration remain
unverified; local container/synthetic-wallet checks are documented separately.
