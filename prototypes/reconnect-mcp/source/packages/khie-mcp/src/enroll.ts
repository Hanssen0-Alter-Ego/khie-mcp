import { Libp2p } from "@ckb-ccc/libp2p";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import type { Method, SecureStateStore, WalletState } from "./state.js";
import {
  createBridgeNode,
  disconnectNode,
  type BridgeNodeFactory,
} from "./transport.js";

/** Server-side provisioning only. Endpoint contains a secret; never pass via MCP. */
export async function enroll(
  store: SecureStateStore,
  principal: string,
  endpoint: string,
  networkId: string,
  allowedMethods: Method[] = [
    "get_identity",
    "get_native_address",
    "get_scripts",
  ],
  factory: BridgeNodeFactory = createBridgeNode,
) {
  const target = await Libp2p.decodePairingEndpoint(endpoint, "provider");
  const key = await generateKeyPair("Ed25519");
  const state: WalletState = {
    version: 1,
    principal,
    communicationKey: Buffer.from(privateKeyToProtobuf(key)).toString("base64"),
    walletPeerId: "",
    walletAddresses: target.addresses.map(String),
    networkId,
    phase: "pairing",
    allowedMethods,
    operations: {},
  };
  const handle = await store.create(state);
  await store.withSession(principal, handle, async (saved, save) => {
    const node = await factory(key);
    try {
      const peer = await node.services.pairing.pair(target, {
        signal: AbortSignal.timeout(15_000),
      });
      saved.walletPeerId = peer.toString();
      saved.phase = "paired";
      await save();
    } finally {
      await disconnectNode(node);
    }
  });
  return handle;
}
