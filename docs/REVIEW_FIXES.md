# Adapter review corrections in 0.2.1

Independent review reproduced three issues in the 0.2.0 source using actual pinned transport implementations and wholly fake components, without real networking:

1. The relay STOP handler creates a listener/reservation before consulting the inbound deny gate. The outbound-only wrapper now skips STOP/discovery startup, rejects listener creation and reservations, and aborts a directly invoked STOP handler. Actual pinned constructor/handler tests verify no such side effects occur.
2. WebSocket ownership ended before libp2p upgrade, so failed upgrades leaked an open socket; upstream reset used invalid close code 1006. Ownership now spans upgrade, reset uses valid close(), abort releases the socket immediately, and late upgrade results are disposed with rejection handlers attached. Tests use actual pinned WebSockets.dial and maConn with fake standards-conforming sockets.
3. Unpair/provider invalidation aborted RPC but left the independent relay retry controller running. Terminal events now initiate the same cached cleanup operation as explicit close, preserving INVALID_SESSION for later reads and cleanup failures for later close/shutdown. Tests cover request/recovery invalidation, pending startup/unpair registration, late subscription cleanup and cleanup errors.

The review also noted sweep-driven core TTL does not by itself stop an idle live connection. A separate 30-minute live-request inactivity timer now starts teardown without any later MCP message; cached result reads do not refresh it. A fake-clock regression verifies this behavior.

Fresh dependency installation passed normal policy verification. The reviewed core is unchanged. Later real read-only interoperability is still an explicit authorization-dependent validation step, not a claim made by these offline tests.
