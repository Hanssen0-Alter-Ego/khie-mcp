import { createHash, randomUUID } from 'node:crypto';
import { APPROVAL_METHODS, READ_METHODS, RPC_MAX_BYTES, ServiceError, boundedJson, canonical, errorRecord, fail, jsonBytes, key } from './protocol.mjs';

const defaults = Object.freeze({ maxSessions: 8, maxRequestsPerSession: 128, maxConcurrent: 4,
  resultTtlMs: 120_000, sessionTtlMs: 1_800_000, requestTimeoutMs: 30_000, readyTimeoutMs: 10_000,
  closeTimeoutMs: 2_000, maxRpcBytes: RPC_MAX_BYTES, maxRetainedBytesPerSession: 8 * 1024 * 1024 });

/** One instance is one trusted host/stdio client. Handles are NOT multi-tenant authentication. */
export class KhieService {
  #sessions = new Map(); #queue = []; #active = 0; #recovering = 0; #state = 'running'; #shutdown;
  constructor({ transportFactory, approve, enableSigning = false, now = Date.now, ...limits } = {}) {
    this.limits = { ...defaults, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!(name in defaults) || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) fail('INVALID_ARGUMENT', `Invalid limit: ${name}`);
    }
    if (enableSigning && typeof approve !== 'function') fail('INVALID_ARGUMENT', 'Signing requires a trusted per-action approval callback');
    if (typeof transportFactory !== 'function') fail('INVALID_ARGUMENT', 'A transport factory is required');
    this.factory = transportFactory; this.approve = approve; this.enableSigning = enableSigning; this.now = now;
    this.epoch = randomUUID();
  }
  capabilities() { return { name: 'khie-mcp-rebuilt', reconstruction: true, state: this.#state,
    readMethods: [...READ_METHODS], signingEnabled: this.enableSigning, sendingEnabled: false,
    persistence: 'memory-only', limits: { ...this.limits } }; }
  #admit() { if (this.#state !== 'running') fail('SHUTTING_DOWN', 'New work is no longer accepted'); }
  #session(id) { key(id, 'session handle'); const s = this.#sessions.get(id); if (!s) fail('INVALID_SESSION', 'Unknown or expired session'); return s; }
  #touch(s) { s.touched = this.now(); }
  #snapshot(s) { return { sessionId: s.id, state: s.state, ...(s.error ? { error: s.error } : {}), createdAt: s.created,
    expiresAt: s.state === 'closed' ? s.cleanupState === 'pending' ? null : Math.max(s.closedAt, s.cleanupFinishedAt ?? s.closedAt) + this.limits.resultTtlMs : s.touched + this.limits.sessionTtlMs,
    ...(s.cleanupState ? { cleanupState: s.cleanupState } : {}), ...(s.cleanupError ? { cleanupError: s.cleanupError } : {}) }; }
  open() {
    this.#admit(); this.sweep();
    if (this.#sessions.size >= this.limits.maxSessions) fail('SESSION_QUOTA', 'Session quota reached; closed handles expire after the result retention period');
    const id = `${this.epoch}:${randomUUID()}`, controller = new AbortController();
    const s = { id, state: 'starting', controller, created: this.now(), touched: this.now(), records: new Map(),
      accepted: new Map(), queue: [], busy: false, retainedBytes: 0, adapter: undefined, close: undefined, disposing: new WeakSet(), factoryPending: false, initializing: true, cleanupPending: false };
    this.#sessions.set(id, s);
    // Reserve a handle before asynchronous initialization. Close/shutdown can invalidate it immediately.
    s.ready = this.#initialize(s);
    return this.#snapshot(s);
  }
  async #initialize(s) {
    try {
      const adapter = await this.#bounded(s.controller.signal, this.limits.readyTimeoutMs, async signal => {
        s.factoryPending = true;
        let value;
        try { value = await this.factory({ sessionId: s.id, signal }); }
        finally { s.factoryPending = false; this.#cleanupState(s); }
        if (!value || typeof value.request !== 'function' || typeof value.close !== 'function') {
          if (value && typeof value.close === 'function') await this.#dispose(s, value);
          fail('INVALID_TRANSPORT', 'Transport must implement request and close');
        }
        s.adapter = value;
        if (signal.aborted || s.state !== 'starting') { await this.#dispose(s, value); signal.throwIfAborted(); fail('SESSION_CLOSED', 'Session closed during initialization'); }
        await value.ready?.({ signal });
        return value;
      });
      if (s.state === 'starting' && !s.controller.signal.aborted) { s.adapter = adapter; s.state = 'ready'; }
    } catch (error) {
      if (s.state === 'starting') { s.state = 'failed'; s.error = errorRecord(error); s.controller.abort(error); await this.#dispose(s, s.adapter); }
    } finally { s.initializing = false; this.#cleanupState(s); }
  }
  status(id) { this.sweep(); return this.#snapshot(this.#session(id)); }
  async ready(id) { const s = this.#session(id); await s.ready; return this.#snapshot(s); }
  request({ sessionId, requestId, method, params = [] }) {
    this.#admit(); this.sweep(); const s = this.#session(sessionId); key(requestId, 'request ID');
    if (s.state !== 'ready') fail(s.state === 'closed' ? 'SESSION_CLOSED' : 'NOT_READY', 'Session is not ready', s.error);
    if (!READ_METHODS.includes(method) && !(this.enableSigning && APPROVAL_METHODS.includes(method))) fail('METHOD_DISABLED', 'Method is not enabled');
    if (!Array.isArray(params)) fail('INVALID_ARGUMENT', 'params must be an array');
    if (READ_METHODS.includes(method) && params.length !== 0) fail('INVALID_ARGUMENT', 'Read methods accept no parameters');
    if (APPROVAL_METHODS.includes(method) && params.length !== 1) fail('INVALID_ARGUMENT', 'Signing methods accept exactly one parameter');
    const copy = boundedJson(params, this.limits.maxRpcBytes);
    boundedJson({ jsonrpc: '2.0', id: requestId, method, params: [{ request_id: requestId, session_id: s.id }, ...copy] }, this.limits.maxRpcBytes);
    const digest = createHash('sha256').update(canonical({ method, params: copy })).digest('hex');
    const previous = s.accepted.get(requestId);
    if (previous) {
      if (previous !== digest) fail('REQUEST_ID_CONFLICT', 'Request ID was already used for different arguments');
      this.#touch(s); return this.result({ sessionId, requestId });
    }
    if (s.accepted.size >= this.limits.maxRequestsPerSession) fail('REQUEST_QUOTA', 'Session lifetime request quota reached; open a new session');
    const bytes = jsonBytes(copy) + 1024;
    if (s.retainedBytes + bytes > this.limits.maxRetainedBytesPerSession) fail('MEMORY_QUOTA', 'Session retained payload quota reached');
    const r = { id: requestId, method, params: copy, digest, state: 'queued', createdAt: this.now(), settled: false, bytes };
    s.retainedBytes += bytes;
    s.accepted.set(requestId, digest); s.records.set(requestId, r); s.queue.push(r); this.#touch(s);
    if (!s.busy && !this.#queue.includes(s)) this.#queue.push(s);
    queueMicrotask(() => this.#pump());
    return this.#record(r);
  }
  #record(r) {
    return boundedJson({ requestId: r.id, status: r.state, createdAt: r.createdAt,
      ...(r.finishedAt === undefined ? {} : { finishedAt: r.finishedAt, expiresAt: r.finishedAt + this.limits.resultTtlMs }),
      ...(r.state === 'completed' ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}), ...(r.recovered ? { recovered: true } : {}), ...(r.recoveryStatus ? { recovery: r.recoveryStatus } : {}) }, this.limits.maxRpcBytes + 4096);
  }
  result({ sessionId, requestId }) {
    this.sweep(); const s = this.#session(sessionId); key(requestId, 'request ID');
    // Recovery is independent of admission/concurrency quotas and never executes a request.
    const r = s.records.get(requestId);
    if (!r) return { requestId, status: s.accepted.has(requestId) ? 'expired' : 'not_found' };
    return this.#record(r);
  }
  beginRecovery(args) {
    // MCP remains responsive while the bounded background read waits on a provider.
    const local = this.result(args);
    const s = this.#session(args.sessionId), r = s.records.get(args.requestId);
    if (!r || r.state !== 'timed_out' || s.state !== 'ready' || this.#state !== 'running') return local;
    void this.recover(args).catch(() => { /* Expiry can invalidate the handle during recovery. */ });
    return this.result(args);
  }
  async recover({ sessionId, requestId }) {
    const local = this.result({ sessionId, requestId });
    const s = this.#session(sessionId), r = s.records.get(requestId);
    if (!r || r.state !== 'timed_out' || s.state !== 'ready' || this.#state !== 'running') return local;
    if (r.recovery) return r.recovery;
    if (typeof s.adapter.recover !== 'function') { r.recoveryStatus = { status: 'unsupported' }; return this.#record(r); }
    // A separate recovery budget prevents a saturated execution queue from starving result lookup.
    if (s.recovering || this.#recovering >= this.limits.maxConcurrent) { r.recoveryStatus = { status: 'busy' }; return this.#record(r); }
    s.recovering = true; this.#recovering++; r.recoveryStatus = { status: 'running' };
    r.recovery = (async () => {
      try {
        const remote = boundedJson(await this.#bounded(s.controller.signal, this.limits.requestTimeoutMs,
          signal => s.adapter.recover({ requestId }, { signal })), this.limits.maxRpcBytes);
        this.sweep(); // Time and ownership may change across every awaited provider read.
        if (this.#sessions.get(sessionId) !== s || s.records.get(requestId) !== r || s.state !== 'ready') return this.result({ sessionId, requestId });
        if (remote?.status === 'completed' && Object.hasOwn(remote, 'result')) {
          const result = boundedJson(remote.result, this.limits.maxRpcBytes);
          this.#resize(s, r, jsonBytes(result) + 1024);
          r.state = 'completed'; r.result = result;
          r.error = undefined; r.finishedAt = this.now(); r.recovered = true; r.recoveryStatus = undefined;
          return this.#record(r);
        }
        if (remote?.status !== 'pending' && remote?.status !== 'not_found') fail('INVALID_RESPONSE', 'Invalid provider recovery response');
        r.recoveryStatus = { status: remote.status };
        return this.#record(r);
      } catch (error) {
        const current = this.result({ sessionId, requestId }); // Sweeps expiry on errors/abort too.
        if (this.#sessions.get(sessionId) !== s || s.records.get(requestId) !== r) return current;
        r.recoveryStatus = { status: 'failed', error: errorRecord(error) };
        return this.#record(r);
      } finally { this.#recovering--; s.recovering = false; r.recovery = undefined; }
    })();
    return r.recovery;
  }
  #pump() {
    if (this.#state !== 'running') return;
    let examined = this.#queue.length;
    while (this.#active < this.limits.maxConcurrent && this.#queue.length && examined-- > 0) {
      const s = this.#queue.shift();
      if (s.state !== 'ready' || s.queue.length === 0) continue;
      if (s.busy) { this.#queue.push(s); continue; }
      const r = s.queue.shift(); s.busy = true; this.#active++;
      // Requeue only after completion, behind other sessions, providing round-robin fairness.
      void this.#run(s, r).finally(() => {
        this.#active--; s.busy = false;
        if (s.state === 'ready' && s.queue.length && !this.#queue.includes(s)) this.#queue.push(s);
        this.#pump();
      });
    }
  }
  async #run(s, r) {
    try {
      const value = await this.#bounded(s.controller.signal, this.limits.requestTimeoutMs, async signal => {
        signal.throwIfAborted();
        if (APPROVAL_METHODS.includes(r.method)) {
          r.state = 'awaiting_approval';
          const approved = await this.approve(Object.freeze({ sessionId: s.id, requestId: r.id, method: r.method,
            params: boundedJson(r.params), digest: r.digest }), { signal });
          signal.throwIfAborted();
          if (approved !== true) fail('USER_REJECTED', 'The user did not approve this action');
        }
        signal.throwIfAborted();
        if (this.#state !== 'running' || s.state !== 'ready') fail('SESSION_CLOSED', 'Session is no longer active');
        r.state = 'running';
        const result = await s.adapter.request({ requestId: r.id, method: r.method, params: r.params }, { signal });
        signal.throwIfAborted();
        return boundedJson(result, this.limits.maxRpcBytes);
      });
      this.#finish(s, r, 'completed', value);
    } catch (error) {
      const e = errorRecord(error);
      this.#finish(s, r, e.code === 'TIMEOUT' ? 'timed_out' : e.code === 'SESSION_CLOSED' || e.code === 'ABORTED' ? 'cancelled' : 'failed', undefined, e);
    }
  }
  #resize(s, r, bytes) {
    if (s.retainedBytes - r.bytes + bytes > this.limits.maxRetainedBytesPerSession) fail('MEMORY_QUOTA', 'Session retained payload quota reached');
    s.retainedBytes += bytes - r.bytes; r.bytes = bytes;
  }
  #finish(s, r, state, value, error) {
    if (r.settled) return;
    this.#resize(s, r, 1024 + (value === undefined ? 0 : jsonBytes(value)));
    r.settled = true; r.state = state; r.finishedAt = this.now(); r.params = undefined;
    if (value !== undefined) r.result = value;
    if (error) r.error = error;
  }
  async #bounded(parent, ms, work) {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
    const timer = setTimeout(() => controller.abort(new ServiceError('TIMEOUT', 'Operation timed out; remote outcome may be unknown')), ms);
    let rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, { once: true }); if (controller.signal.aborted) rejectAbort(); });
    // Promise.race attaches rejection handlers to both branches, including late non-cooperative adapters.
    const operation = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); });
    try { return await Promise.race([operation, interrupted]); }
    finally { clearTimeout(timer); parent.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort); }
  }
  #cleanupState(s) {
    if (s.state !== 'closed' && s.state !== 'failed') return;
    const state = s.factoryPending || s.initializing || s.cleanupPending ? 'pending' : s.cleanupError ? 'failed' : 'completed';
    if (state !== 'pending' && s.cleanupState !== state) s.cleanupFinishedAt = this.now();
    s.cleanupState = state;
  }
  async #dispose(s, adapter) {
    if (!adapter || s.disposing.has(adapter)) { this.#cleanupState(s); return; }
    s.disposing.add(adapter); s.cleanupPending = true; this.#cleanupState(s);
    try { await this.#bounded(new AbortController().signal, this.limits.closeTimeoutMs, () => adapter.close()); }
    catch (error) { s.cleanupError = errorRecord(error); }
    finally { s.cleanupPending = false; this.#cleanupState(s); }
  }
  close(id) {
    const s = this.#session(id);
    if (s.close) return s.close.then(() => this.#snapshot(s));
    s.state = 'closed'; s.closedAt = this.now(); this.#cleanupState(s);
    s.controller.abort(new ServiceError('SESSION_CLOSED', 'Session was closed; an already dispatched remote operation may still have completed'));
    for (const r of s.records.values()) if (!r.settled) this.#finish(s, r, 'cancelled', undefined, errorRecord(s.controller.signal.reason));
    s.queue = []; this.#queue = this.#queue.filter(v => v !== s);
    s.close = this.#dispose(s, s.adapter).then(() => this.#snapshot(s));
    return s.close;
  }
  #shutdownSnapshot() {
    const sessions = [...this.#sessions.values()];
    return { state: this.#state, sessionsClosed: sessions.filter(s => s.state === 'closed').length,
      pendingCleanup: sessions.filter(s => s.cleanupState === 'pending').length,
      cleanupErrors: sessions.filter(s => s.cleanupError).map(s => ({ sessionId: s.id, ...s.cleanupError })) };
  }
  shutdown() {
    if (this.#state === 'stopped') return Promise.resolve(this.#shutdownSnapshot());
    if (this.#shutdown) return this.#shutdown;
    this.#state = 'shutting_down'; // Synchronous admission barrier, before any awaited cleanup.
    this.#shutdown = Promise.all([...this.#sessions.keys()].map(id => this.close(id))).then(() => {
      this.#state = 'stopped'; return this.#shutdownSnapshot();
    });
    return this.#shutdown;
  }
  sweep() {
    const now = this.now();
    for (const [id, s] of this.#sessions) {
      if (s.state !== 'closed' && now - s.touched >= this.limits.sessionTtlMs) void this.close(id);
      for (const [rid, r] of s.records) if (r.settled && now - r.finishedAt >= this.limits.resultTtlMs) { s.records.delete(rid); s.retainedBytes -= r.bytes; }
      if (s.state === 'closed' && s.cleanupState !== 'pending' && now - Math.max(s.closedAt, s.cleanupFinishedAt ?? s.closedAt) >= this.limits.resultTtlMs) this.#sessions.delete(id);
    }
  }
}
