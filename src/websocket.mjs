import { fail } from '../core/src/protocol.mjs';

/** Pinned @libp2p/websockets 10.1.22 extension seam. Own the socket until transport upgrade. */
export function abortSafeWebSockets(webSockets, options, WebSocketCtor = globalThis.WebSocket) {
  const factory = webSockets(options);
  return components => {
    const transport = factory(components);
    if (typeof transport._connect !== 'function') fail('INCOMPATIBLE_RUNTIME', 'Pinned WebSocket transport API changed');
    if (typeof transport.dial !== 'function') fail('INCOMPATIBLE_RUNTIME', 'Pinned WebSocket dial API changed');
    const ownership = Symbol('private socket ownership');
    const dial = transport.dial.bind(transport);
    transport._connect = async (address, dialOptions) => {
      const socket = await connectWebSocket(address, dialOptions, WebSocketCtor);
      dialOptions?.[ownership]?.(socket);
      return socket;
    };
    transport.dial = async (address, options = {}) => {
      let socket, connection, socketClosed = false;
      const closeSocket = () => { if (!socket || socketClosed) return; socketClosed = true; try { socket.close(); } catch {} };
      const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
      const upgrader = Object.create(options.upgrader ?? null);
      upgrader.upgradeOutbound = async (maConn, upgradeOptions) => {
        connection = maConn;
        if (typeof maConn.sendReset !== 'function') fail('INCOMPATIBLE_RUNTIME', 'Pinned WebSocket reset API changed');
        // Upstream sends invalid WebSocket close code 1006, which native WebSocket rejects.
        maConn.sendReset = closeSocket;
        const operation = Promise.resolve().then(() => { signal.throwIfAborted(); return options.upgrader.upgradeOutbound(maConn, upgradeOptions); });
        return await new Promise((resolve, reject) => {
          let settled = false;
          const aborted = () => { if (settled) return; settled = true; closeSocket(); reject(signal.reason); };
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
          operation.then(value => {
            signal.removeEventListener('abort', aborted);
            if (!settled) { settled = true; resolve(value); return; }
            // Dispose an upgrade that ignored cancellation and returned a connection late.
            try { Promise.resolve(value?.close()).catch(() => {}); } catch {}
          }, error => { signal.removeEventListener('abort', aborted); if (!settled) { settled = true; reject(error); } });
        });
      };
      try {
        const result = await dial(address, { ...options, signal, upgrader, [ownership]: value => { socket = value; } });
        if (signal.aborted) { try { Promise.resolve(result?.close()).catch(() => {}); } catch {} signal.throwIfAborted(); }
        return result;
      } catch (error) {
        try { connection?.abort(error); } catch {}
        closeSocket(); throw error;
      }
    };
    return transport;
  };
}

export async function connectWebSocket(address, { signal } = {}, WebSocketCtor = globalThis.WebSocket) {
  signal?.throwIfAborted();
  const c = address.getComponents();
  if (c.length !== 4 || !['dns4','dns6'].includes(c[0].name) || !/^[a-z0-9.-]+$/.test(c[0].value) ||
    c[1].name !== 'tcp' || c[1].value !== '443' || c[2].name !== 'wss' || c[3].name !== 'p2p')
    fail('RELAY_DENIED', 'Only a pinned secure relay WebSocket is supported');
  let socket;
  try {
    socket = new WebSocketCtor(`wss://${c[0].value}/`);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed);
        error ? reject(error) : resolve();
      };
      const opened = () => finish();
      const failed = () => finish(new Error('Relay WebSocket failed before opening'));
      const aborted = () => finish(signal.reason ?? new Error('Relay dial aborted'));
      const timer = setTimeout(() => finish(new Error('Relay WebSocket timed out')), 10_000);
      socket.addEventListener('open', opened); socket.addEventListener('error', failed); socket.addEventListener('close', failed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
    return socket;
  } catch (error) {
    // Upstream's aborted pre-upgrade path omits this close. Do not leave an unowned dial alive.
    try { socket?.close(); } catch { /* Preserve the original sanitized error classification. */ }
    throw error;
  }
}
