import { Libp2p } from "@ckb-ccc/libp2p";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { enroll } from "./enroll.js";
import { FileSecureStateStore } from "./store.js";
import type { BridgeNode, BridgeNodeFactory } from "./transport.js";

// Wire shape from Hanssen0/khie-mobile at ad1cf891e43ff93a7ec3b5538d357b449dd45f9e,
// App.tsx + src/khie/pairingEndpointCodec.ts. Independently encoded with Node zlib;
// this is a compatibility fixture, not a React Native/device execution claim.
const walletId = "12D3KooWJZQ7ypYJ6LHVYbNcKZX7HxV5pnPHJHvJ7zH2Bf6WmDKm";
const relayId = "12D3KooWQwLwBK3EaCaJQNL9KBUvPi9Vh3gZqPfLQVi7aZpHkF3S";
const relayPrefix = `/dns4/relay.example.invalid/tcp/443/wss/p2p/${relayId}/p2p-circuit`;
const addresses = [
  `${relayPrefix}/webrtc/p2p/${walletId}`,
  `${relayPrefix}/p2p/${walletId}`,
];
const testSecret = "synthetic-mobile-pairing-credential";

function mobileWireEndpoint(role = "provider") {
  const frames = addresses.map((value) => {
    const bytes = multiaddr(value).bytes;
    let length = bytes.byteLength;
    const prefix = [];
    do {
      const next = length & 0x7f;
      length >>>= 7;
      prefix.push(next | (length ? 0x80 : 0));
    } while (length);
    return Buffer.concat([Buffer.from(prefix), bytes]);
  });
  const encoded = deflateSync(Buffer.concat(frames)).toString("base64url");
  return `https://app.ckbccc.com/khie#?${new URLSearchParams({ role, addresses: encoded, secret: testSecret })}`;
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it("decodes the current mobile provider URL with mixed WebRTC and circuit addresses", async () => {
  const target = await Libp2p.decodePairingEndpoint(
    mobileWireEndpoint(),
    "provider",
  );
  expect(target.addresses.map(String)).toEqual(addresses);
  expect(target.secret).toBe(testSecret);
});

it("enrolls the mobile wire shape through the operator boundary and persists only resume state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "khie-mobile-wire-test-"));
  directories.push(directory);
  const store = await FileSecureStateStore.open(
    join(directory, "state"),
    randomBytes(32),
  );
  let callerPeerId = "";
  const pair = vi.fn(async (_target: Libp2p.PairingTarget) =>
    peerIdFromString(walletId),
  );
  let status = "started";
  const stop = vi.fn(async () => {
    status = "stopped";
  });
  const node = {
    services: { pairing: { pair } },
    stop,
    get status() {
      return status;
    },
  } as unknown as BridgeNode;
  const factory: BridgeNodeFactory = async (key) => {
    callerPeerId = peerIdFromPrivateKey(key).toString();
    return node;
  };
  const handle = await enroll(
    store,
    "operator-test",
    mobileWireEndpoint(),
    "ckb-testnet",
    ["get_identity"],
    factory,
  );
  expect(pair).toHaveBeenCalledTimes(1);
  expect(pair.mock.calls[0]?.[0]).toMatchObject({ secret: testSecret });
  expect(stop).toHaveBeenCalledTimes(1);
  await store.withSession("operator-test", handle, async (state) => {
    expect(state.walletPeerId).toBe(walletId);
    expect(state.walletAddresses).toEqual(addresses);
    expect(state.phase).toBe("paired");
    expect(
      peerIdFromPrivateKey(
        privateKeyFromProtobuf(Buffer.from(state.communicationKey, "base64")),
      ).toString(),
    ).toBe(callerPeerId);
    expect(JSON.stringify(state)).not.toContain(testSecret);
    expect(JSON.stringify(state)).not.toContain("app.ckbccc.com");
  });
});

it("rejects connector QR and incomplete provider endpoints before creating state or a node", async () => {
  const store = { create: vi.fn(), withSession: vi.fn() };
  const factory = vi.fn();
  for (const endpoint of [
    mobileWireEndpoint("connector"),
    "https://app.ckbccc.com/khie#?role=provider",
  ]) {
    await expect(
      enroll(
        store,
        "operator-test",
        endpoint,
        "ckb-testnet",
        ["get_identity"],
        factory,
      ),
    ).rejects.toBeInstanceOf(Libp2p.PairingEndpointError);
  }
  expect(store.create).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
});
