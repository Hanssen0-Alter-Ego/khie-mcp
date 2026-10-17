import { Libp2p } from '@ckb-ccc/libp2p';
import { multiaddr } from '@multiformats/multiaddr';
import { fail } from '../core/src/protocol.mjs';

export const MAX_ENDPOINT_BYTES = 32 * 1024;
const fields = new Set(['enabled', 'relayAddress', 'relayAllowlist', 'connectNetwork', 'readyTimeoutMs', 'requestTimeoutMs']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function relay(value) {
  if (typeof value !== 'string' || value.length > 300) fail('INVALID_CONFIG', 'Invalid relay address');
  const match = /^\/dns[46]\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/tcp\/443\/wss$/.exec(value);
  if (!match || !match[1].includes('.') || match[1].split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /(?:^|\.)(?:localhost|local|internal|lan|invalid|test)$/.test(match[1]) || /^\d+(?:\.\d+)+$/.test(match[1])) fail('INVALID_CONFIG', 'Relays must be explicit secure DNS WebSocket addresses on port 443');
  try { if (multiaddr(value).toString() !== value) throw Error(); } catch { fail('INVALID_CONFIG', 'Invalid relay address'); }
  return value;
}
export function validateConfig(config) {
  if (!isObject(config) || !Object.hasOwn(config, 'enabled') || config.enabled !== true) fail('NETWORK_DISABLED', 'Live networking requires explicit trusted-host configuration');
  for (const field of Object.keys(config)) if (!fields.has(field)) fail('INVALID_CONFIG', 'Unknown live configuration field');
  if (!Array.isArray(config.relayAllowlist) || config.relayAllowlist.length < 1 || config.relayAllowlist.length > 4) fail('INVALID_CONFIG', 'Provide one to four exact relay allowlist entries');
  const relayAllowlist = [...new Set(config.relayAllowlist.map(relay))];
  const relayAddress = relay(config.relayAddress);
  if (!relayAllowlist.includes(relayAddress)) fail('RELAY_DENIED', 'Selected relay is not in the trusted allowlist');
  if (config.connectNetwork !== undefined && !['ckb-testnet', 'ckb-mainnet'].includes(config.connectNetwork)) fail('INVALID_CONFIG', 'Unsupported connect network');
  const readyTimeoutMs = config.readyTimeoutMs ?? 30_000, requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
  for (const value of [readyTimeoutMs, requestTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1000 || value > 60_000) fail('INVALID_CONFIG', 'Timeout must be between 1000 and 60000 milliseconds');
  return Object.freeze({ enabled: true, relayAddress, relayAllowlist: Object.freeze(relayAllowlist),
    ...(config.connectNetwork ? { connectNetwork: config.connectNetwork } : {}), readyTimeoutMs, requestTimeoutMs });
}

/** Decodes locally only. No URL is fetched and no peer/node/credential is created. */
export async function prepareLiveConfig(config, endpoint) {
  const checked = validateConfig(config);
  if (typeof endpoint !== 'string' || !endpoint || Buffer.byteLength(endpoint) > MAX_ENDPOINT_BYTES) fail('INVALID_ENDPOINT', 'Provider endpoint exceeds the permitted size or is missing');
  let target;
  try {
    const url = new URL(endpoint);
    if (!['https:', 'khie-wallet:'].includes(url.protocol) || url.username || url.password) throw Error();
    target = await Libp2p.decodePairingEndpoint(endpoint, 'provider');
    if (Buffer.byteLength(target.secret) > 256) throw Error();
  } catch { fail('INVALID_ENDPOINT', 'Invalid provider endpoint; details are not logged'); }
  const accepted = [], peers = new Set(), relays = new Map();
  for (const address of target.addresses) {
    const c = address.getComponents();
    if (c.length !== 6 || !['dns4', 'dns6'].includes(c[0].name) || c[1].name !== 'tcp' || c[1].value !== '443' ||
      c[2].name !== 'wss' || c[3].name !== 'p2p' || c[4].name !== 'p2p-circuit' || c[5].name !== 'p2p') continue;
    const base = `/${c[0].name}/${c[0].value}/tcp/443/wss`;
    // Every forwarded address is constrained to the explicitly selected relay.
    if (base !== checked.relayAddress || !checked.relayAllowlist.includes(base)) continue;
    if (c[3].value === c[5].value) fail('INVALID_ENDPOINT', 'Provider and relay identities must differ');
    const pinnedRelay = `${base}/p2p/${c[3].value}`;
    relays.set(pinnedRelay, c[3].value); peers.add(c[5].value); accepted.push(address);
  }
  if (!accepted.length) fail('NO_ALLOWED_ROUTE', 'Endpoint has no allowed relay-only route; direct and WebRTC routes are disabled');
  if (peers.size !== 1 || relays.size !== 1) fail('INVALID_ENDPOINT', 'Endpoint must identify exactly one provider and one selected relay');
  const addresses = [...new Map(accepted.map(a => [a.toString(), a])).values()];
  const providerPeerId = [...peers][0], [relayAddress, relayPeerId] = [...relays][0];
  const guardedTarget = { addresses: Object.freeze(addresses) };
  Object.defineProperty(guardedTarget, 'secret', { value: target.secret, enumerable: false });
  return Object.freeze({ config: checked, providerPeerId, relayPeerId, relayAddress,
    target: Object.freeze(guardedTarget),
    ignoredAddressCount: target.addresses.length - addresses.length });
}

/** Guard both initial and subsequently learned routes; no direct connection upgrades. */
export function connectionPolicy(prepared) {
  const allowed = new Set([prepared.relayAddress, ...prepared.target.addresses.map(String)]);
  const peerAllowed = peer => [prepared.relayPeerId, prepared.providerPeerId].includes(peer?.toString());
  const addressAllowed = address => { try { return allowed.has(address.toString()); } catch { return false; } };
  return Object.freeze({
    denyDialPeer: peer => !peerAllowed(peer),
    denyDialMultiaddr: address => !addressAllowed(address),
    denyOutboundConnection: (peer, connection) => !peerAllowed(peer) || !addressAllowed(connection.remoteAddr),
    denyInboundConnection: () => true, // no listening socket is configured
    denyInboundEncryptedConnection: peer => !peerAllowed(peer),
    denyOutboundEncryptedConnection: peer => !peerAllowed(peer),
    denyInboundUpgradedConnection: peer => !peerAllowed(peer),
    denyOutboundUpgradedConnection: peer => !peerAllowed(peer),
    denyInboundRelayReservation: () => true,
    denyOutboundRelayedConnection: () => true,
    denyInboundRelayedConnection: () => true, // this connector originates all wallet RPC streams
    filterMultiaddrForPeer: (peer, address) => {
      if (!peerAllowed(peer)) return false;
      try {
        const c = address.getComponents();
        return addressAllowed(c.at(-1)?.name === 'p2p' ? address : address.encapsulate(`/p2p/${peer.toString()}`));
      } catch { return false; }
    },
  });
}
