import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { ccc } from "@ckb-ccc/core";
import { Libp2p } from "@ckb-ccc/libp2p";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Libp2p as Libp2pNode, PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { randomUUID } from "node:crypto";
import { BridgeError, type WalletState } from "./state.js";

export const PAIRING_PROTOCOL = "/nervos-ckb/khie/pairing/0.0.1";
export const JSON_RPC_PROTOCOL = "/nervos-ckb/khie/json-rpc/0.0.1";

export type RequestMetadata = { request_id?: string; session_id?: string };
export interface WalletConnection {
  request(
    method: string,
    params: unknown[],
    metadata: RequestMetadata,
  ): Promise<unknown>;
  /** MUST close transport only; never unpair, dispose provider state, or revoke. */
  disconnectTransport(): Promise<void>;
}
export type WalletConnector = (state: WalletState) => Promise<WalletConnection>;

/** Separate server factory: the existing interactive connector cleanup is unchanged. */
export async function createBridgeNode(
  privateKey: PrivateKey,
): Promise<BridgeNode> {
  const node = await createLibp2p({
    start: false,
    privateKey,
    addresses: { listen: [] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pairing: Libp2p.pairingService(
        {
          protocol: PAIRING_PROTOCOL,
          name: "Khie MCP prototype",
          pairedPeerTimeoutMs: 30 * 60 * 1000,
        },
        () => false,
      ),
    },
  });
  try {
    await node.start();
    return node;
  } catch (error) {
    await disconnectNode(node);
    throw error;
  }
}

export type BridgeNode = Libp2pNode<{ pairing: Libp2p.PairingService }>;
export type BridgeNodeFactory = (key: PrivateKey) => Promise<BridgeNode>;

export function connectionFromNode(
  node: BridgeNode,
  walletPeerId: string,
  timeout = 12_000,
): WalletConnection {
  const transport = new Libp2p.JsonRpcTransportLibp2p(
    node,
    peerIdFromString(walletPeerId),
    {
      protocol: JSON_RPC_PROTOCOL,
      timeout,
    },
  );
  return {
    async request(method, params, metadata) {
      const id = randomUUID();
      const response = await transport.request({
        jsonrpc: "2.0",
        id,
        method,
        params: [metadata, ...params],
      });
      if (response.id !== id || response.jsonrpc !== "2.0") {
        throw new Error("Invalid RPC envelope");
      }
      if ("error" in response && response.error) {
        throw new ccc.JsonRpcError(response.error);
      }
      if (!("result" in response)) {
        throw new Error("Missing RPC result");
      }
      return response.result;
    },
    // PairingService.stop clears only this node's timers. No remote unpair.
    disconnectTransport: () => disconnectNode(node),
  };
}

export function libp2pConnector(
  factory: BridgeNodeFactory = createBridgeNode,
  timeout = 12_000,
): WalletConnector {
  return async (state) => {
    const key = privateKeyFromProtobuf(
      Buffer.from(state.communicationKey, "base64"),
    );
    const node = await factory(key);
    try {
      const peer = peerIdFromString(state.walletPeerId);
      const addresses = state.walletAddresses.map(multiaddr);
      if (
        addresses.length === 0 ||
        addresses.some(
          (address) =>
            address.getComponents().at(-1)?.value !== peer.toString(),
        )
      ) {
        throw new Error("Saved addresses must identify the pinned wallet peer");
      }
      await node.peerStore.merge(peer, { multiaddrs: addresses });
      // Actual connection is made on demand by JsonRpcTransportLibp2p.
      return connectionFromNode(node, state.walletPeerId, timeout);
    } catch (error) {
      await disconnectNode(node);
      throw error;
    }
  };
}

export async function disconnectNode(node: BridgeNode) {
  try {
    await node.stop();
    // libp2p may leave a failed startup cleanup in "stopping". A subsequent
    // stop() then returns without doing anything; it is not proof of shutdown.
    if (node.status !== "stopped") {
      throw new BridgeError("transport_cleanup_failed");
    }
  } catch {
    throw new BridgeError("transport_cleanup_failed");
  }
}
