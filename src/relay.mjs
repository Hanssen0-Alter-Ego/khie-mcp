import { ServiceError, fail } from '../core/src/protocol.mjs';

/** Keep only outbound dialing from exact-pinned circuit-relay-v2 4.2.14. */
export function outboundOnlyCircuitRelay(circuitRelayTransport) {
  const factory = circuitRelayTransport();
  return components => {
    const transport = factory(components);
    if (typeof transport.onStop !== 'function' || typeof transport.dial !== 'function' || !transport.reservationStore)
      fail('INCOMPATIBLE_RUNTIME', 'Pinned circuit relay transport API changed');
    const dial = transport.dial.bind(transport);
    let controller = new AbortController(), started = false;
    const disabled = () => fail('INBOUND_DISABLED', 'Inbound relay listeners and reservations are disabled');
    // Stock start registers STOP and discovery. STOP can listen/reserve before applying gates.
    transport.start = async () => { if (started) return; controller = new AbortController(); started = true; };
    transport.stop = async () => { controller.abort(); started = false; };
    transport.isStarted = () => started;
    transport.onStop = async stream => { try { stream.abort(new ServiceError('INBOUND_DISABLED', 'Inbound relay streams are disabled')); } catch {} };
    transport.listenFilter = () => [];
    transport.createListener = disabled;
    transport.reservationStore.addRelay = async () => disabled();
    transport.dial = (address, options = {}) => {
      if (!started) fail('NOT_READY', 'Outbound relay transport is not started');
      const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
      signal.throwIfAborted();
      return dial(address, { ...options, signal });
    };
    return transport;
  };
}
