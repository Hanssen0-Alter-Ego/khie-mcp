import { outboundOnlyCircuitRelay } from './relay.mjs';
import { abortSafeWebSockets } from './websocket.mjs';
import { KHIE_PAIRING_PROTOCOL, KHIE_JSON_RPC_PROTOCOL, RPC_MAX_BYTES } from '../core/src/protocol.mjs';

function silentLogger() {
  const log = () => {}; log.error = log; log.trace = log; log.enabled = false; log.newScope = () => log;
  return { forComponent: () => log };
}
/** Lazy imports only. Live creation/start happens exclusively inside createNode/start below. */
export async function productionRuntime() {
  const [{ createLibp2p }, { noise }, { yamux }, { circuitRelayTransport }, { identify, identifyPush }, { webSockets }, { Libp2p }] = await Promise.all([
    import('libp2p'), import('@chainsafe/libp2p-noise'), import('@chainsafe/libp2p-yamux'), import('@libp2p/circuit-relay-v2'),
    import('@libp2p/identify'), import('@libp2p/websockets'), import('@ckb-ccc/libp2p'),
  ]);
  return runtimeFromLibraries({ createLibp2p, noise, yamux, circuitRelayTransport, identify, identifyPush, webSockets, Libp2p });
}

/** Pure assembly seam for offline configuration tests; injected constructors are trusted host code. */
export function runtimeFromLibraries({ createLibp2p, noise, yamux, circuitRelayTransport, identify, identifyPush, webSockets, Libp2p }) {
  return {
    createNode: async ({ policy }) => createLibp2p({
      start: false, addresses: { listen: [] }, logger: silentLogger(), connectionGater: policy,
      peerStore: { maxAddressAge: 30 * 60_000 },
      connectionManager: { maxConnections: 4, maxParallelDials: 2, maxDialQueueLength: 8, maxPeerAddrsToDial: 4,
        dialTimeout: 10_000, addressDialTimeout: 5_000, connectionCloseTimeout: 1_000,
        inboundUpgradeTimeout: 5_000, inboundStreamProtocolNegotiationTimeout: 5_000,
        outboundStreamProtocolNegotiationTimeout: 5_000, maxIncomingPendingConnections: 1, resolvers: {} },
      transports: [abortSafeWebSockets(webSockets, { maxBufferedAmount: RPC_MAX_BYTES }), outboundOnlyCircuitRelay(circuitRelayTransport)],
      connectionEncrypters: [noise()], streamMuxers: [yamux()],
      services: { identify: identify(), identifyPush: identifyPush(),
        pairing: Libp2p.pairingService({ name: 'Khie MCP read-only connector', protocol: KHIE_PAIRING_PROTOCOL,
          pairedPeerTimeoutMs: 30 * 60_000 }, () => false) },
    }),
    createRelay: (node, address) => new Libp2p.RelayConnectionController(node, [address]),
    createTransport: (node, peerId, { signal, requestTimeoutMs }) => new Libp2p.JsonRpcTransportLibp2p(node, peerId, {
      protocol: KHIE_JSON_RPC_PROTOCOL, maxMessageLength: RPC_MAX_BYTES, timeout: requestTimeoutMs, signal,
      onResponse: () => node.services.pairing.refresh(peerId),
    }),
  };
}
