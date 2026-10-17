import { KhieRpcAdapter } from '../core/src/adapter.mjs';
import { READ_METHODS, ServiceError, fail } from '../core/src/protocol.mjs';
import { connectionPolicy, prepareLiveConfig } from './policy.mjs';
import { productionRuntime } from './runtime.mjs';

export const LIVE_IDLE_TIMEOUT_MS = 30 * 60_000;

/** A fresh one-use endpoint is required for each new pairing attempt. */
export async function createLiveFactory({ config, endpoint, runtimeLoader = productionRuntime }) {
  const prepared = await prepareLiveConfig(config, endpoint);
  let claimed = false;
  return {
    limits: { maxSessions: 1, readyTimeoutMs: prepared.config.readyTimeoutMs, requestTimeoutMs: prepared.config.requestTimeoutMs },
    transportFactory: () => {
      if (claimed) fail('ENDPOINT_CONSUMED', 'This pairing endpoint was already used; restart with a fresh provider endpoint');
      claimed = true;
      return new LiveReadonlyTransport(prepared, runtimeLoader);
    },
  };
}

class LiveReadonlyTransport {
  constructor(prepared, runtimeLoader) {
    this.prepared = prepared; this.runtimeLoader = runtimeLoader; this.controller = new AbortController();
    this.node = undefined; this.relay = undefined; this.inner = undefined; this.unpaired = undefined;
    this.closed = false; this.connected = false; this.startup = undefined; this.closing = undefined;
  }
  ready({ signal }) {
    if (!this.startup) {
      const combined = AbortSignal.any([signal, this.controller.signal]);
      this.startup = this.#start(combined);
    }
    return this.startup;
  }
  async #start(signal) {
    signal.throwIfAborted();
    const runtime = await this.runtimeLoader(); signal.throwIfAborted();
    this.node = await runtime.createNode({ policy: connectionPolicy(this.prepared) });
    signal.throwIfAborted();
    this.nodeStarting = true;
    try { await this.node.start(); } finally { this.nodeStarting = false; }
    signal.throwIfAborted();
    this.relay = runtime.createRelay(this.node, this.prepared.relayAddress);
    await this.relay.connect(); signal.throwIfAborted();
    const peerId = await this.node.services.pairing.pair(this.prepared.target, { signal }); signal.throwIfAborted();
    if (peerId.toString() !== this.prepared.providerPeerId) fail('PEER_MISMATCH', 'Pairing returned an unexpected provider identity');
    const providerPeerId = this.prepared.providerPeerId;
    this.unpaired = this.node.services.pairing.onUnpaired(peer => {
      if (!this.closed && peer.toString() === providerPeerId) this.#invalidate(new ServiceError('INVALID_SESSION', 'Provider unpaired; fresh pairing is required'));
    });
    const transport = runtime.createTransport(this.node, peerId, { signal: this.controller.signal, requestTimeoutMs: this.prepared.config.requestTimeoutMs });
    // Read public signer metadata before asking the provider to approve a network connection.
    const metadataReader = new KhieRpcAdapter({ transport, providerSessionId: 'metadata-only-uninitialized' });
    const info = await metadataReader.request({ requestId: 'initial-metadata', method: 'get_info', params: [] }, { signal });
    if (!info || typeof info.session_id !== 'string' || !info.session_id || info.session_id.length > 128) fail('INVALID_RESPONSE', 'Provider metadata did not contain a valid session');
    this.providerSessionId = info.session_id;
    this.inner = new KhieRpcAdapter({ transport, providerSessionId: info.session_id });
    signal.throwIfAborted();
    if (this.prepared.config.connectNetwork) {
      const connected = await this.inner.request({ requestId: 'explicit-network-connect', method: 'connect', params: [this.prepared.config.connectNetwork] }, { signal });
      if (connected !== null) fail('INVALID_RESPONSE', 'Unexpected provider connect result');
      signal.throwIfAborted(); this.connected = true;
    }
    this.#touch();
  }
  #touch() {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.#invalidate(new ServiceError('INVALID_SESSION', 'Live session idle deadline reached; fresh pairing is required')), LIVE_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }
  #invalidate(error) {
    this.terminalError ??= error; this.controller.abort(this.terminalError);
    // A terminal provider event must also stop the relay's independent retry loop.
    void this.close().catch(() => {}); // Explicit close/shutdown still receives the cached cleanup failure.
  }
  #signal(signal) { return AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]); }
  async request(request, { signal } = {}) {
    if (!READ_METHODS.includes(request.method)) fail('METHOD_DISABLED', 'Live adapter supports read-only methods only');
    if (this.terminalError) throw this.terminalError;
    if (this.closed || !this.inner) fail('NOT_READY', 'Live provider is not ready');
    if (request.method !== 'get_info' && !this.connected) fail('CONNECT_REQUIRED', 'Start a new explicitly configured connection to request wallet approval for account reads');
    const combined = this.#signal(signal); combined.throwIfAborted(); this.#touch();
    let result;
    try { result = await this.inner.request(request, { signal: combined }); }
    catch (error) { if (error?.code === 'INVALID_SESSION') this.#invalidate(error); throw error; }
    combined.throwIfAborted();
    if (request.method === 'get_info' && result?.session_id !== this.providerSessionId) {
      const error = new ServiceError('INVALID_SESSION', 'Provider session changed; fresh wallet pairing is required');
      this.#invalidate(error); throw error;
    }
    this.#touch(); return result;
  }
  async recover(request, { signal } = {}) {
    if (this.terminalError) throw this.terminalError;
    if (this.closed || !this.inner) fail('NOT_READY', 'Live provider is not ready');
    const combined = this.#signal(signal); combined.throwIfAborted(); this.#touch();
    try { const result = await this.inner.recover(request, { signal: combined }); this.#touch(); return result; }
    catch (error) { if (error?.code === 'INVALID_SESSION') this.#invalidate(error); throw error; }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; clearTimeout(this.idleTimer); this.idleTimer = undefined; this.controller.abort(new ServiceError('SESSION_CLOSED', 'Live session closed'));
    this.closing = (async () => {
      const errors = [], firstNode = this.node, firstRelay = this.relay, firstUnpaired = this.unpaired, nodeWasStarting = this.nodeStarting;
      try { firstUnpaired?.(); } catch (error) { errors.push(error); }
      const stop = async resource => { try { await resource?.stop(); } catch (error) { errors.push(error); } };
      // Stop existing retry loops before waiting for startup, otherwise relay.connect could deadlock.
      await Promise.all([stop(firstRelay), stop(firstNode)]);
      // Core bounds this wait and exposes cleanup failure if a constructor ignores abort.
      try { await this.startup; } catch { /* Still release resources returned after cancellation. */ }
      if (this.unpaired !== firstUnpaired) { try { this.unpaired?.(); } catch (error) { errors.push(error); } }
      if (this.relay !== firstRelay) await stop(this.relay);
      if (this.node !== firstNode || nodeWasStarting) await stop(this.node);
      try { await this.inner?.close(); } catch (error) { errors.push(error); }
      this.prepared = undefined;
      if (errors.length) fail('CLEANUP_FAILED', 'One or more live transport resources failed to stop');
    })();
    return this.closing;
  }
}
