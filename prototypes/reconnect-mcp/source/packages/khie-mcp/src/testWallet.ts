// Isolated test fixture. No asset keys, chain calls, signing, or broadcast.
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { ccc } from "@ckb-ccc/core";
import { Libp2p } from "@ckb-ccc/libp2p";
import { identify } from "@libp2p/identify";
import type {
  Libp2p as Libp2pNode,
  PeerId,
  PrivateKey,
} from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import {
  createBridgeNode,
  JSON_RPC_PROTOCOL,
  PAIRING_PROTOCOL,
  type BridgeNode,
} from "./transport.js";

export async function createTestBridgeNode(
  privateKey: PrivateKey,
): Promise<BridgeNode> {
  return createBridgeNode(privateKey);
}

type TestWallet = {
  node: Libp2pNode<{ pairing: Libp2p.PairingService }>;
  stats: {
    authorizations: number;
    signatures: number;
    unpairs: number;
    peers: string[];
    methods: string[];
  };
  endpoint: string;
  selectedPeer: PeerId | undefined;
  releaseSignature(): void;
  restartSession(): Promise<void>;
  stop(): Promise<void>;
};

export async function createTestWallet(
  options: { pairedPeerTimeoutMs?: number; signDelayMs?: number } = {},
): Promise<TestWallet> {
  const stats = {
    authorizations: 0,
    signatures: 0,
    unpairs: 0,
    peers: [] as string[],
    methods: [] as string[],
  };
  let releaseSignature: (() => void) | undefined;
  let signatureTimer: ReturnType<typeof setTimeout> | undefined;
  const signer = {
    client: { addressPrefix: "ckt" },
    type: ccc.SignerType.CKB,
    signType: ccc.SignerSignType.CkbSecp256k1,
    getIdentity: async () => "synthetic-wallet-identity",
    getInternalAddress: async () => "synthetic-wallet-address",
    getAddressObjs: async () => [],
    signMessageRaw: async () => {
      stats.signatures++;
      await new Promise<void>((resolve) => {
        releaseSignature = resolve;
        if (options.signDelayMs !== undefined) {
          signatureTimer = setTimeout(resolve, options.signDelayMs);
        }
      });
      return "synthetic-signature-not-valid-on-any-chain";
    },
  } as unknown as ccc.Signer;
  const createSession = () =>
    ccc.SignerJsonRpcProviderSession.open({
      getSigner: () => signer,
      connect: async () => signer,
      confirmRequest: async (request) => {
        if (request.method === "connect") {
          stats.authorizations++;
        }
        return true;
      },
    });
  let session = createSession();
  let selectedPeer: PeerId | undefined;
  const node = await createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pairing: Libp2p.pairingService(
        {
          protocol: PAIRING_PROTOCOL,
          pairedPeerTimeoutMs: options.pairedPeerTimeoutMs ?? 30 * 60 * 1000,
        },
        () => !selectedPeer,
      ),
      jsonRpc: Libp2p.jsonRpcService(
        { protocol: JSON_RPC_PROTOCOL },
        (request) => {
          // Matches the CCC provider's caller-PeerID guard and generic error code.
          if (
            !node.services.pairing.isPaired(request.peerId) ||
            !selectedPeer?.equals(request.peerId)
          ) {
            throw new ccc.JsonRpcError({
              code: ccc.SignerJsonRpcErrorCode.ServerError,
              message: "Peer is not paired for Khie access",
            });
          }
          node.services.pairing.refresh(request.peerId);
          stats.peers.push(request.peerId.toString());
          stats.methods.push(request.payload.method);
          // Deliberately do not abort wallet execution when only a stream closes.
          return session.value.handle(request.payload);
        },
      ),
    },
  });
  node.services.pairing.onPaired((peer) => {
    selectedPeer = peer;
  });
  node.services.pairing.onUnpaired(() => {
    stats.unpairs++;
    void session.dispose();
  });
  const endpoint = await Libp2p.encodePairingEndpoint(
    "khie-wallet://app/connect",
    node.getMultiaddrs(),
    node.services.pairing.secret,
    "provider",
  );
  return {
    node,
    stats,
    endpoint,
    get selectedPeer() {
      return selectedPeer;
    },
    releaseSignature() {
      clearTimeout(signatureTimer);
      releaseSignature?.();
    },
    async restartSession() {
      await session.dispose();
      session = createSession();
    },
    async stop() {
      clearTimeout(signatureTimer);
      releaseSignature?.();
      await session.dispose();
      await node.stop();
    },
  };
}
