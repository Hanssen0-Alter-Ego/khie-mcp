import { randomUUID } from 'node:crypto';
import { KHIE_JSON_RPC_PROTOCOL, RPC_MAX_BYTES, READ_METHODS, ServiceError, boundedJson, fail } from './protocol.mjs';

/** Default executable fixture. No sockets, keys, account files or chain requests. */
export function createOfflineFixture() {
  let closed = false;
  return {
    async ready() {},
    async request({ method }) {
      if (closed) fail('SESSION_CLOSED', 'Fixture is closed');
      if (!READ_METHODS.includes(method)) fail('METHOD_DISABLED', 'Fixture supports read-only methods');
      return ({
        get_info: { name: 'Khie reconstruction fixture', fixture: true, network: 'none', signing: false },
        get_scripts: [], get_native_address: 'fixture:no-wallet-address', get_identity: 'fixture:no-wallet-identity',
      })[method];
    },
    async close() { closed = true; },
  };
}

/**
 * Borrow a transport whose pairing and provider connect approval already occurred outside MCP.
 * This adapter never pairs, connects, signs automatically, retries a write or owns private keys.
 * Host must provide close() to release its own node/relay resources exactly once.
 */
export class KhieRpcAdapter {
  constructor({ transport, providerSessionId, close = async () => {}, maxRpcBytes = RPC_MAX_BYTES }) {
    if (!transport || typeof transport.request !== 'function') fail('INVALID_TRANSPORT', 'A CCC JSON-RPC transport is required');
    if (typeof providerSessionId !== 'string' || !providerSessionId || providerSessionId.length > 128) fail('INVALID_ARGUMENT', 'An already approved provider session ID is required');
    if (!Number.isSafeInteger(maxRpcBytes) || maxRpcBytes < 1 || maxRpcBytes > RPC_MAX_BYTES) fail('INVALID_ARGUMENT', 'Invalid maximum RPC size');
    this.transport = transport; this.providerSessionId = providerSessionId; this.release = close; this.maxRpcBytes = maxRpcBytes;
    this.closed = false; this.prefix = randomUUID();
  }
  async ready({ signal }) {
    const info = await this.request({ method: 'get_info', params: [], requestId: `ready:${randomUUID()}` }, { signal });
    if (!info || info.session_id !== this.providerSessionId) fail('INVALID_SESSION', 'Provider session changed; obtain fresh wallet approval before reopening');
  }
  async #rpc(method, params, { signal }) {
    if (this.closed) fail('SESSION_CLOSED', 'Transport is closed');
    signal?.throwIfAborted();
    const id = randomUUID(); const payload = boundedJson({ jsonrpc: '2.0', id, method, params }, this.maxRpcBytes);
    const response = boundedJson(await this.transport.request(payload, { signal }), this.maxRpcBytes);
    signal?.throwIfAborted();
    if (!response || response.jsonrpc !== '2.0' || response.id !== id ||
      (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))) fail('INVALID_RESPONSE', 'Invalid or mismatched JSON-RPC response');
    if (response.error) {
      const code = response.error.code;
      if (!Number.isInteger(code) || typeof response.error.message !== 'string') fail('INVALID_RESPONSE', 'Invalid JSON-RPC error');
      // Keep upstream error code but deliberately do not echo upstream messages or data.
      throw new ServiceError(code === -32004 ? 'INVALID_SESSION' : code === -32003 ? 'USER_REJECTED' : code === -32005 ? 'DUPLICATE_REMOTE_REQUEST' : 'REMOTE_ERROR', 'Provider rejected the request', { rpcCode: code });
    }
    return response.result;
  }
  remoteRequestId(requestId) { return `${this.prefix}:${requestId}`; }
  request({ requestId, method, params }, options = {}) {
    const metadata = { request_id: this.remoteRequestId(requestId), ...(method === 'get_info' ? {} : { session_id: this.providerSessionId }) };
    return this.#rpc(method, [metadata, ...params], options);
  }
  recover({ requestId }, options = {}) {
    return this.#rpc('get_result', [{}, this.remoteRequestId(requestId)], options);
  }
  close() { if (!this.closing) { this.closed = true; this.closing = Promise.resolve().then(() => this.release()); } return this.closing; }
}

/** Optional existing-node bridge. Calling this does not create a node or initiate pairing. */
export async function borrowLibp2pAdapter({ node, peerId, providerSessionId, signal, close }) {
  const { Libp2p } = await import('@ckb-ccc/libp2p');
  return new KhieRpcAdapter({ providerSessionId, close,
    transport: new Libp2p.JsonRpcTransportLibp2p(node, peerId, {
      protocol: KHIE_JSON_RPC_PROTOCOL, maxMessageLength: RPC_MAX_BYTES, signal,
      onResponse: () => node.services.pairing.refresh(peerId),
    }),
  });
}
