import { ccc } from "@ckb-ccc/core";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KhieBridge, payloadFingerprint } from "./bridge.js";
import { enroll } from "./enroll.js";
import { BridgeError, type WalletState } from "./state.js";
import { FileSecureStateStore } from "./store.js";
import { createTestBridgeNode, createTestWallet } from "./testWallet.js";
import {
  createBridgeNode,
  disconnectNode,
  libp2pConnector,
  type BridgeNode,
  type WalletConnector,
} from "./transport.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) {
    await stop();
  }
});

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "khie-store-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const store = await FileSecureStateStore.open(directory, key);
  return { directory, key, store };
}

async function fixture(connector: WalletConnector) {
  const disk = await storeFixture();
  const state: WalletState = {
    version: 1,
    principal: "test-user",
    communicationKey: "synthetic-communication-secret",
    walletPeerId: "synthetic-peer",
    walletAddresses: [],
    sessionId: "synthetic-session-secret",
    networkId: "ckb-testnet",
    phase: "authorized",
    allowedMethods: ["get_identity", "sign_message"],
    operations: {},
  };
  const handle = await disk.store.create(state);
  return {
    ...disk,
    handle,
    state,
    bridge: new KhieBridge(disk.store, connector),
  };
}

describe("durable bridge semantics", () => {
  it("polls a pending operation in fresh workers without re-dispatch and caches completed results", async () => {
    const responses = [
      new Error("timeout synthetic-session-secret"),
      { status: "pending" },
      { status: "completed", result: "synthetic-result" },
    ];
    const request = vi.fn(async () => {
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    });
    const disconnectTransport = vi.fn(async () => {});
    const connector = vi.fn(async () => ({ request, disconnectTransport }));
    const f = await fixture(connector);
    expect(
      await f.bridge.request("test-user", f.handle, "op-1", "get_identity"),
    ).toEqual({ status: "unknown", reason: "transport" });
    const fresh = () =>
      FileSecureStateStore.open(f.directory, f.key).then(
        (store) => new KhieBridge(store, connector),
      );
    expect(
      await (
        await fresh()
      ).request("test-user", f.handle, "op-1", "get_identity"),
    ).toEqual({ status: "pending" });
    expect(await (await fresh()).poll("test-user", f.handle, "op-1")).toEqual({
      status: "completed",
      result: "synthetic-result",
    });
    expect(await (await fresh()).poll("test-user", f.handle, "op-1")).toEqual({
      status: "completed",
      result: "synthetic-result",
    });
    expect(request.mock.calls.map((args) => (args as unknown[])[0])).toEqual([
      "get_identity",
      "get_result",
      "get_result",
    ]);
    const calls = request.mock.calls as unknown as [
      string,
      unknown[],
      { request_id?: string },
    ][];
    expect(calls[1][1]).toEqual([calls[0][2].request_id]);
    expect(calls[2][1]).toEqual(calls[1][1]);
    expect(disconnectTransport).toHaveBeenCalledTimes(3);
    const sealed = await readFile(`${f.directory}/${f.handle}.sealed`);
    expect(sealed.includes(Buffer.from(f.state.communicationKey))).toBe(false);
    expect(sealed.includes(Buffer.from(f.state.sessionId!))).toBe(false);
  });

  it("rejects mismatched retries and protects unknown/evicted operations without resending", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "get_result") {
        throw new Error("timeout");
      }
      return { status: "not_found" };
    });
    const f = await fixture(async () => ({
      request,
      disconnectTransport: async () => {},
    }));
    const first = [{ type: "string", value: "first" }];
    await f.bridge.request(
      "test-user",
      f.handle,
      "retry",
      "sign_message",
      first,
    );
    await expect(
      f.bridge.request("test-user", f.handle, "retry", "sign_message", [
        { value: "different", type: "string" },
      ]),
    ).rejects.toMatchObject({ code: "operation_payload_mismatch" });
    for (let i = 0; i < 3; i++) {
      expect(
        await f.bridge.request(
          "test-user",
          f.handle,
          "retry",
          "sign_message",
          first,
        ),
      ).toEqual({ status: "unknown", reason: "not_found" });
    }
    expect(
      request.mock.calls.filter(([method]) => method === "sign_message"),
    ).toHaveLength(1);
    expect(payloadFingerprint("sign_message", first)).toBe(
      payloadFingerprint("sign_message", [{ value: "first", type: "string" }]),
    );
  });

  it("handles a duplicate RPC reply by polling the same ID", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "get_result") {
        throw new ccc.JsonRpcError({
          code: -32005,
          message: "secret error data",
        });
      }
      return { status: "completed", result: "already done" };
    });
    const f = await fixture(async () => ({
      request,
      disconnectTransport: async () => {},
    }));
    expect(
      await f.bridge.request(
        "test-user",
        f.handle,
        "duplicate",
        "get_identity",
      ),
    ).toEqual({ status: "completed", result: "already done" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("writes intent before connecting, keeps crash uncertainty, and rejects cross-principal access", async () => {
    const request = vi.fn(async () => ({ status: "not_found" }));
    const connector = vi.fn(async () => ({
      request,
      disconnectTransport: async () => {},
    }));
    const f = await fixture(connector);
    await f.store.withSession("test-user", f.handle, async (state, save) => {
      state.operations.crashed = {
        fingerprint: payloadFingerprint("get_identity", []),
        requestId: "pre-crash-id",
      };
      await save();
    });
    expect(
      await f.bridge.request("test-user", f.handle, "crashed", "get_identity"),
    ).toEqual({ status: "unknown", reason: "not_found" });
    expect(request).toHaveBeenCalledWith("get_result", ["pre-crash-id"], {});
    await expect(
      f.bridge.poll("other-user", f.handle, "crashed"),
    ).rejects.toMatchObject({ code: "unknown_handle" });
    await expect(
      f.bridge.poll("test-user", f.handle, "_info"),
    ).rejects.toMatchObject({ code: "invalid_operation_id" });
  });

  it("does not connect on failed durable commit and never removes journal tombstones", async () => {
    const connector = vi.fn<WalletConnector>();
    const f = await fixture(connector);
    const bridge = new KhieBridge(
      {
        create: async () => f.handle,
        withSession: async (_principal, _handle, use) =>
          use(f.state, async () => {
            throw new Error("disk full");
          }),
      },
      connector,
    );
    await expect(
      bridge.request("test-user", f.handle, "write-failure", "get_identity"),
    ).rejects.toThrow("disk full");
    expect(connector).not.toHaveBeenCalled();
    await f.store.withSession("test-user", f.handle, async (state, save) => {
      for (let i = 0; i < 1024; i++) {
        state.operations[`old${i}`] = {
          fingerprint: "old",
          requestId: String(i),
        };
      }
      await save();
    });
    await expect(
      f.bridge.request("test-user", f.handle, "new", "get_identity"),
    ).rejects.toMatchObject({ code: "operation_capacity_reached" });
  });

  it("fails closed on concurrent workers and a failed transport shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async () => ({
      request: async () => "ok",
      disconnectTransport: async () => {
        throw new Error("stop failed");
      },
    }));
    const held = f.store.withSession("test-user", f.handle, async () => {
      await gate;
    });
    // Acquire is asynchronous; wait until the callback is executing.
    await vi.waitFor(async () => {
      await expect(
        FileSecureStateStore.open(f.directory, f.key).then((other) =>
          other.withSession("test-user", f.handle, async () => {}),
        ),
      ).rejects.toMatchObject({ code: "session_busy" });
    });
    release();
    await held;
    await expect(
      f.bridge.request("test-user", f.handle, "cleanup", "get_identity"),
    ).rejects.toMatchObject({ code: "transport_cleanup_failed" });
    await expect(
      f.bridge.poll("test-user", f.handle, "cleanup"),
    ).rejects.toMatchObject({ code: "session_busy" });
  });

  it("surfaces invalid sessions without reauthorization and suppresses wallet errors", async () => {
    const request = vi.fn(async () => {
      throw new ccc.JsonRpcError({
        code: -32004,
        message: "private session details",
      });
    });
    const f = await fixture(async () => ({
      request,
      disconnectTransport: async () => {},
    }));
    expect(
      await f.bridge.request("test-user", f.handle, "expired", "get_identity"),
    ).toEqual({ status: "repair_required" });
    expect(
      await f.bridge.request("test-user", f.handle, "later", "get_identity"),
    ).toEqual({ status: "repair_required" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats unknown provider error codes as ambiguous and caches explicit user rejection", async () => {
    const request = vi.fn(async () => {
      throw new ccc.JsonRpcError({
        code: -32099,
        message: "unknown provider outcome",
      });
    });
    const f = await fixture(async () => ({
      request,
      disconnectTransport: async () => {},
    }));
    expect(
      await f.bridge.request(
        "test-user",
        f.handle,
        "ambiguous-error",
        "get_identity",
      ),
    ).toEqual({ status: "unknown", reason: "wallet_error" });
    request.mockRejectedValue(
      new ccc.JsonRpcError({ code: -32003, message: "synthetic rejection" }),
    );
    expect(
      await f.bridge.request("test-user", f.handle, "rejected", "get_identity"),
    ).toEqual({ status: "rejected", code: -32003 });
    expect(await f.bridge.poll("test-user", f.handle, "rejected")).toEqual({
      status: "rejected",
      code: -32003,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resumes pending operator authorization with its original operation ID", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "connect") {
        throw new Error("connection approval still pending");
      }
      return { status: "completed", result: null };
    });
    const connector = async () => ({
      request,
      disconnectTransport: async () => {},
    });
    const f = await fixture(connector);
    await f.store.withSession("test-user", f.handle, async (state, save) => {
      state.phase = "paired";
      await save();
    });
    expect(await f.bridge.authorize("test-user", f.handle)).toEqual({
      status: "unknown",
      reason: "transport",
    });
    const fresh = new KhieBridge(
      await FileSecureStateStore.open(f.directory, f.key),
      connector,
    );
    expect(await fresh.authorize("test-user", f.handle)).toEqual({
      status: "completed",
    });
    expect(await fresh.authorize("test-user", f.handle)).toEqual({
      status: "completed",
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "connect",
      "get_result",
    ]);
  });

  it("retains a quarantine lock if connection setup cannot clean up its node", async () => {
    const f = await fixture(async () => {
      throw new BridgeError("transport_cleanup_failed");
    });
    await expect(
      f.bridge.request("test-user", f.handle, "failed-setup", "get_identity"),
    ).rejects.toMatchObject({ code: "transport_cleanup_failed" });
    await expect(
      f.bridge.poll("test-user", f.handle, "failed-setup"),
    ).rejects.toMatchObject({ code: "session_busy" });
  });
});

describe("isolated libp2p wallet", () => {
  it("quarantines a real node after failed startup cleanup leaves it stopping", async () => {
    const key = await generateKeyPair("Ed25519");
    const probe = await createBridgeNode(key);
    await disconnectNode(probe);
    // Inject lifecycle faults into the installed libp2p class, without replacing
    // its start/stop state machine. This internal access is test-only.
    type FaultNode = BridgeNode & {
      components: { components: Record<string, unknown> };
    };
    const prototype = Object.getPrototypeOf(probe) as {
      start(this: FaultNode): Promise<void>;
    };
    const originalStart = prototype.start;
    let failedNode: FaultNode | undefined;
    const spy = vi.spyOn(prototype, "start").mockImplementation(async function (
      this: FaultNode,
    ) {
      failedNode = this;
      this.components.components.khieTestFailure = {
        start() {},
        stop() {},
        afterStart() {
          throw new Error("synthetic startup failure");
        },
        beforeStop() {
          throw new Error("synthetic cleanup failure");
        },
      };
      await originalStart.call(this);
    });
    try {
      const f = await fixture(libp2pConnector());
      await f.store.withSession("test-user", f.handle, async (state, save) => {
        state.communicationKey = Buffer.from(
          privateKeyToProtobuf(key),
        ).toString("base64");
        await save();
      });
      await expect(
        f.bridge.request(
          "test-user",
          f.handle,
          "startup-failure",
          "get_identity",
        ),
      ).rejects.toMatchObject({ code: "transport_cleanup_failed" });
      expect(failedNode?.status).toBe("stopping");
      await expect(
        f.bridge.poll("test-user", f.handle, "startup-failure"),
      ).rejects.toMatchObject({ code: "session_busy" });
    } finally {
      spy.mockRestore();
      if (failedNode) {
        delete failedNode.components.components.khieTestFailure;
        // Repair this isolated fault-injected test node solely to release test
        // resources. Production code never resets lifecycle status or retries it.
        failedNode.status = "started";
        await disconnectNode(failedNode);
      }
    }
  });

  it("restores the communication PeerID in the production factory", async () => {
    const key = await generateKeyPair("Ed25519");
    const first = await createBridgeNode(key);
    const peer = first.peerId.toString();
    await first.stop();
    const { privateKeyFromProtobuf } = await import("@libp2p/crypto/keys");
    const restored = await createBridgeNode(
      privateKeyFromProtobuf(privateKeyToProtobuf(key)),
    );
    try {
      expect(restored.peerId.toString()).toBe(peer);
    } finally {
      await restored.stop();
    }
    const different = await createBridgeNode(await generateKeyPair("Ed25519"));
    try {
      expect(different.peerId.toString()).not.toBe(peer);
    } finally {
      await different.stop();
    }
  });

  async function paired(options: Parameters<typeof createTestWallet>[0] = {}) {
    const f = await storeFixture();
    const wallet = await createTestWallet(options);
    cleanup.push(() => wallet.stop());
    const handle = await enroll(
      f.store,
      "test-user",
      wallet.endpoint,
      "ckb-testnet",
      ["get_identity", "sign_message"],
      createTestBridgeNode,
    );
    const bridge = new KhieBridge(
      f.store,
      libp2pConnector(createTestBridgeNode),
    );
    expect(await bridge.authorize("test-user", handle)).toEqual({
      status: "completed",
    });
    return { ...f, wallet, handle, bridge };
  }

  it("resumes across nodes without reauthorization, preserves pairing on disconnect, rejects a changed caller key", async () => {
    const f = await paired();
    for (const id of ["one", "two"]) {
      const worker = new KhieBridge(
        await FileSecureStateStore.open(f.directory, f.key),
        libp2pConnector(createTestBridgeNode),
      );
      expect(
        await worker.request("test-user", f.handle, id, "get_identity"),
      ).toEqual({ status: "completed", result: "synthetic-wallet-identity" });
    }
    expect(f.wallet.stats.authorizations).toBe(1);
    expect(f.wallet.stats.unpairs).toBe(0);
    expect(new Set(f.wallet.stats.peers).size).toBe(1);
    expect(
      f.wallet.node.services.pairing.isPaired(f.wallet.selectedPeer!),
    ).toBe(true);
    await f.store.withSession("test-user", f.handle, async (state, save) => {
      state.communicationKey = Buffer.from(
        privateKeyToProtobuf(await generateKeyPair("Ed25519")),
      ).toString("base64");
      await save();
    });
    // An unauthorized peer can receive an RPC error or have its stream closed.
    expect(
      await f.bridge.request(
        "test-user",
        f.handle,
        "wrong-peer",
        "get_identity",
      ),
    ).toMatchObject({ status: "unknown" });
    expect(f.wallet.stats.authorizations).toBe(1);
    expect(
      f.wallet.stats.methods.filter((method) => method === "get_identity"),
    ).toHaveLength(2);
  });

  it("polls pending signing across worker instances without producing a second signature", async () => {
    const f = await paired();
    const first = new KhieBridge(
      f.store,
      libp2pConnector(createTestBridgeNode, 400),
    );
    expect(
      await first.request(
        "test-user",
        f.handle,
        "pending-sign",
        "sign_message",
        [{ type: "string", value: "isolated test only" }],
      ),
    ).toEqual({ status: "unknown", reason: "transport" });
    const next = new KhieBridge(
      await FileSecureStateStore.open(f.directory, f.key),
      libp2pConnector(createTestBridgeNode),
    );
    expect(await next.poll("test-user", f.handle, "pending-sign")).toEqual({
      status: "pending",
    });
    f.wallet.releaseSignature();
    expect(
      await new KhieBridge(f.store, libp2pConnector(createTestBridgeNode)).poll(
        "test-user",
        f.handle,
        "pending-sign",
      ),
    ).toEqual({
      status: "completed",
      result: "synthetic-signature-not-valid-on-any-chain",
    });
    expect(f.wallet.stats.signatures).toBe(1);
    expect(f.wallet.stats.authorizations).toBe(1);
    expect(f.wallet.stats.unpairs).toBe(0);
  });

  it("does not reconnect authorization after wallet state loss", async () => {
    const f = await paired();
    await f.wallet.restartSession();
    expect(
      await f.bridge.request("test-user", f.handle, "restart", "get_identity"),
    ).toEqual({ status: "repair_required" });
    expect(f.wallet.stats.authorizations).toBe(1);
  });

  it("rejects explicitly revoked pairing", async () => {
    const f = await paired();
    await f.wallet.node.services.pairing.unpair(f.wallet.selectedPeer!);
    expect(f.wallet.stats.unpairs).toBe(1);
    expect(
      await f.bridge.request("test-user", f.handle, "revoked", "get_identity"),
    ).toEqual({ status: "unknown", reason: "wallet_error" });
    expect(f.wallet.stats.authorizations).toBe(1);
  });

  it("rejects expired disconnected pairing", async () => {
    const f = await paired({ pairedPeerTimeoutMs: 1500 });
    await vi.waitFor(
      () => {
        expect(f.wallet.stats.unpairs).toBe(1);
      },
      { timeout: 5000 },
    );
    expect(
      await f.bridge.request("test-user", f.handle, "expired", "get_identity"),
    ).toEqual({ status: "unknown", reason: "wallet_error" });
    expect(f.wallet.stats.authorizations).toBe(1);
  });
});
