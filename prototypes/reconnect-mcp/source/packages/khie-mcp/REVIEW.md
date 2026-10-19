# Validation and review record

Validated on Node 24.19.0 with pnpm 11.8.0 against CCC commit
`0abf78e5f469216e82a24de8d4051e757368af90`. The publication source preserves the
tested runtime, test and configuration bytes; only documentation was edited to
remove environment-specific paths and network configuration. No real wallet,
asset key, transaction or production signing was used.

## Changes

All application code is in the new private npm package `packages/khie-mcp`.
Root changes add its test project and lockfile entries (171 lockfile additions,
no removals). Existing dependency resolutions are preserved. No existing CCC
core, connector, libp2p or mobile implementation is modified.

- `state.ts` / `store.ts`: principal-scoped handles, durable journal contract,
  encrypted local store, serialization and cleanup-failure quarantine.
- `transport.ts` / `bridge.ts`: communication identity injection, session resume,
  transport-only stop, write-ahead operation IDs, payload matching and poll-only
  retries after uncertainty.
- `enroll.ts` / `cli.ts`: operator-only pairing and authorization from protected
  files. No credential-bearing MCP tool.
- `server.ts`: two authenticated MCP tools over bounded stateless Streamable HTTP.
- `testWallet.ts` / `demo.ts` / `smoke.ts`: isolated synthetic wallet and separate
  HTTP client using real libp2p/CCC/MCP implementations.
- `readProbe.ts`: local-only operator client, explicit operation IDs, read methods
  and polling only; no automatic retries or signing.

## Commands and results

The commands below use portable `pnpm` spelling. Validation invoked the exact
pnpm 11.8.0 JavaScript entrypoint from a temporary tool directory; this did not
change package scripts or flags.

```sh
pnpm --filter @ckb-ccc/core --filter @ckb-ccc/libp2p build
pnpm --filter @ckb-ccc/khie-mcp run build
pnpm --filter @ckb-ccc/khie-mcp run lint
pnpm --filter @ckb-ccc/khie-mcp test
pnpm --filter @ckb-ccc/khie-mcp run test:demo
pnpm exec vitest run packages/libp2p/src packages/core/src/signer/jsonRpc
```

- Dependency builds, package build and type check passed.
- Original focused suite: **20 passed**, two files, 15.07 seconds.
- Built-demo child processes: **2 passed**, 3.33 seconds; occupied-port startup
  failure and SIGTERM both clean temporary state and release the listener.
- Existing libp2p and signer JSON-RPC regressions: **54 passed**, eight files,
  3.15 seconds. The entire monorepo suite was not run.
- Frozen install with pnpm 11.8.0 passed; install scripts were disabled and
  repository release-age checks retained. No native WebRTC dependency is needed.
- Prettier, focused curly-brace style check and `git diff --check` passed.
  This is not a claim of running all repository ESLint rules.

The later read-probe and mobile endpoint additions were checked with:

```sh
pnpm --filter @ckb-ccc/khie-mcp build
pnpm --filter @ckb-ccc/khie-mcp exec vitest run --config vitest.config.mts src/mobileEndpoint.test.ts src/readProbe.test.ts
pnpm --filter @ckb-ccc/khie-mcp exec vitest run --config vitest.config.mts src/readProbe.test.ts
```

A test mock type was corrected after the initial build. The combined test run
passed all **3 mobile endpoint tests** and **4 of 5 read-probe tests**. The failing
fixture intended unsafe file mode 0644, but the environment umask made it safe
0600. Explicitly setting the fixture mode fixed it; the read-probe rerun passed
**5 of 5**. Final build passed. This is **8 new passing tests across those runs**,
not a claim of one final 28-test full-suite run. The earlier passing suites and
smoke were not repeated unchanged. Temporary test directories and listeners were
cleaned up.

## Coverage and independent review

Real loopback WebSocket/Noise/Yamux peers and the CCC provider exercise restored
caller identity, changed-key denial, resume without reauthorization, transport
shutdown without unpair, explicit revoke, disconnected expiry, wallet state loss,
and pending/completed polling across fresh bridge/store/node instances. Isolated
journal tests cover matching/mismatching retries, ambiguous not_found, write-ahead
failure, crash uncertainty, retained locks, setup polling and principal isolation.
MCP server tests use the real SDK over HTTP with a mock bridge. Mobile fixtures
exercise the actual CCC endpoint decoder and mocked enrollment; they do not
execute React Native or connect to a mobile device.

A separately authorized independent reviewer found two cleanup defects and
confirmed both fixes: failed libp2p startup can leave status `stopping`, so cleanup
now requires final `stopped` or keeps the session lock quarantined; occupied-port
demo startup now awaits binding and always cleans acquired temporary resources.
The reviewer independently reran the lifecycle regression (1 passed) and demo
checks (2 passed), with no additional substantive defect in those fixes.

The separate-process smoke used `demo` and `smoke` exactly as documented in the
README. It passed actual MCP initialization, listing, authentication, request,
identical retry, mismatch rejection and pending/completed polling through the
bridge and real libp2p transport to the synthetic wallet. Cleanup reported one
authorization and one fake signing action, then removed state and credentials.

The tests do not establish power-loss durability, distributed fencing, production
security, real-device compatibility, public relay behavior, public HTTPS or a
host application's connector integration. See `MOBILE_READINESS.md` for the
inspected mobile source and remaining operator-led device checks.

## Container follow-up

Added explicit HTTP bind validation (`listenHost.ts`) with loopback as the CLI
default and an operator-selected IPv4 wildcard only for containers. The demo
uses the same validation. Existing bearer, Host and Origin guards are unchanged.
The new unit test passed locally, and the final container build passed the full
focused suite: **29 tests in 5 files, 14.44 seconds**. Dependency builds, package
build and type check passed in that build; demo child-process checks passed
**2 tests, 1.94 seconds**.

Docker packaging, Compose files, operator helpers and their **2 passing tests**
are supplied in the publication repository. The primary Docker build stopped on
npm registry DNS (`EAI_AGAIN`). A documented offline variant reused cached pnpm,
package content and release-age metadata without disabling policies or changing
network settings, then executed the same build/test/runtime stages. Production
installation retains the frozen workspace graph instead of legacy deploy range
resolution. See the publication container guide for runtime validation results
and image publication status. No real wallet or production signing was used.
