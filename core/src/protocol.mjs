export const KHIE_PAIRING_PROTOCOL = '/nervos-ckb/khie/pairing/0.0.1';
export const KHIE_JSON_RPC_PROTOCOL = '/nervos-ckb/khie/json-rpc/0.0.1';
export const RPC_MAX_BYTES = 1024 * 1024;
export const READ_METHODS = Object.freeze(['get_info', 'get_scripts', 'get_native_address', 'get_identity']);
export const APPROVAL_METHODS = Object.freeze(['sign_message', 'sign_transaction']);
export class ServiceError extends Error {
  constructor(code, message, details) { super(message); this.name = 'ServiceError'; this.code = code; this.details = details; }
}
export function fail(code, message, details) { throw new ServiceError(code, message, details); }
export function jsonBytes(value) {
  try { const json = JSON.stringify(value); if (json === undefined) throw Error(); return Buffer.byteLength(json); }
  catch { fail('INVALID_ARGUMENT', 'A serializable JSON value is required'); }
}
export function boundedJson(value, max = RPC_MAX_BYTES) {
  if (jsonBytes(value) > max) fail('RPC_TOO_LARGE', `JSON payload exceeds ${max} bytes`);
  return JSON.parse(JSON.stringify(value));
}
export function key(value, name = 'identifier') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) fail('INVALID_ARGUMENT', `Invalid ${name}`);
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function errorRecord(error) {
  if (error instanceof ServiceError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  if (error?.name === 'TimeoutError') return { code: 'TIMEOUT', message: 'Transport timed out; the remote outcome may be unknown' };
  if (error?.name === 'AbortError') return { code: 'ABORTED', message: 'Operation was aborted' };
  // Do not reflect arbitrary upstream messages: they may contain pairing secrets or other private data.
  return { code: 'TRANSPORT_ERROR', message: 'Transport operation failed' };
}
