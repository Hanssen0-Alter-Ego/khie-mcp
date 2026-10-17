import { ServiceError, RPC_MAX_BYTES, boundedJson, errorRecord } from './protocol.mjs';

const string = { type: 'string', minLength: 1, maxLength: 128 };
function schema(properties = {}, required = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const session = { sessionId: string }, request = { ...session, requestId: string };
export const TOOLS = Object.freeze([
  { name: 'khie_capabilities', description: 'Read service policy, limits and reconstruction status.', inputSchema: schema(), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'khie_session_open', description: 'Create an ephemeral session. Default CLI uses an offline public fixture only.', inputSchema: schema(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'khie_session_status', description: 'Read initialization state and sanitized ready errors.', inputSchema: schema(session, ['sessionId']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'khie_request', description: 'Submit a read-only Khie request with a caller-supplied idempotency key. Poll khie_result. Signing and sending are disabled on this MCP surface.', inputSchema: schema({ ...request, method: { enum: ['get_info', 'get_scripts', 'get_native_address', 'get_identity'] }, params: { type: 'array', maxItems: 0 } }, ['sessionId', 'requestId', 'method']), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'khie_result', description: 'Retrieve a request result without rerunning it, including after session close until TTL expiry. Set recover to start a nonblocking timed-out provider result query; poll this tool for its outcome without repeating the operation.', inputSchema: schema({ ...request, recover: { type: 'boolean' } }, ['sessionId', 'requestId']), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'khie_session_close', description: 'Close a session, cancel queued approvals and retain bounded results temporarily.', inputSchema: schema(session, ['sessionId']), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'khie_shutdown', description: 'Stop admitting work and close all sessions. Cached result reads remain available until process exit.', inputSchema: schema(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
]);
const supportedVersions = ['2025-11-25'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateArgs(tool, args) {
  if (!object(args)) throw new ServiceError('INVALID_ARGUMENT', 'Tool arguments must be an object');
  for (const k of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, k)) throw new ServiceError('INVALID_ARGUMENT', `Unexpected argument: ${k}`);
  for (const k of tool.inputSchema.required) if (!Object.hasOwn(args, k)) throw new ServiceError('INVALID_ARGUMENT', `Missing argument: ${k}`);
  for (const [k, value] of Object.entries(args)) {
    const s = tool.inputSchema.properties[k];
    if (s.type === 'string' && (typeof value !== 'string' || value.length < s.minLength || value.length > s.maxLength)) throw new ServiceError('INVALID_ARGUMENT', `Invalid argument: ${k}`);
    if (s.type === 'array' && (!Array.isArray(value) || value.length > s.maxItems)) throw new ServiceError('INVALID_ARGUMENT', `Invalid argument: ${k}`);
    if (s.type === 'boolean' && typeof value !== 'boolean') throw new ServiceError('INVALID_ARGUMENT', `Invalid argument: ${k}`);
    if (s.enum && !s.enum.includes(value)) throw new ServiceError('METHOD_DISABLED', 'This MCP tool exposes read-only methods only');
  }
}
export class McpHandler {
  constructor(service) { this.service = service; this.phase = 'new'; }
  async handle(message) {
    const id = message?.id;
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const error = (code, text) => ({ jsonrpc: '2.0', id: typeof id === 'string' || Number.isSafeInteger(id) ? id : null, error: { code, message: text } });
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && !(typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id))) ||
      (message.params !== undefined && !object(message.params))) return error(-32600, 'Invalid Request');
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/initialized' && this.phase === 'initializing') this.phase = 'ready';
      return undefined;
    }
    if (message.method === 'initialize') {
      if (this.phase !== 'new') return error(-32600, 'Already initialized');
      if (!object(message.params?.capabilities) || !object(message.params?.clientInfo) || typeof message.params?.protocolVersion !== 'string' ||
        typeof message.params.clientInfo.name !== 'string' || typeof message.params.clientInfo.version !== 'string') return error(-32602, 'Invalid initialize parameters');
      this.phase = 'initializing';
      return reply({ protocolVersion: supportedVersions.includes(message.params.protocolVersion) ? message.params.protocolVersion : supportedVersions[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'khie-mcp-rebuilt', version: '0.1.0-reconstruction' },
        instructions: 'Offline fixture by default. This is a new reconstruction, not recovered original source. No signing, sending or pairing tools are exposed.' });
    }
    if (message.method === 'ping') return reply({});
    if (this.phase !== 'ready') return error(-32002, 'Initialization is not complete');
    if (message.method === 'tools/list') return reply({ tools: TOOLS });
    if (message.method !== 'tools/call') return error(-32601, 'Method not found');
    const tool = TOOLS.find(t => t.name === message.params?.name);
    if (!tool) return error(-32602, 'Unknown tool');
    try {
      const args = message.params.arguments === undefined ? {} : message.params.arguments; validateArgs(tool, args);
      const value = await this.call(tool.name, args);
      const structuredContent = boundedJson(value, RPC_MAX_BYTES + 4096);
      return reply({ content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
    } catch (cause) {
      const structuredContent = { error: errorRecord(cause) };
      return reply({ isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent });
    }
  }
  call(name, args) {
    switch (name) {
      case 'khie_capabilities': return this.service.capabilities();
      case 'khie_session_open': return this.service.open();
      case 'khie_session_status': return this.service.status(args.sessionId);
      case 'khie_request': return this.service.request(args);
      case 'khie_result': return args.recover ? this.service.beginRecovery(args) : this.service.result(args);
      case 'khie_session_close': return this.service.close(args.sessionId);
      case 'khie_shutdown': return this.service.shutdown();
    }
  }
}

/** Bounded newline framing. Oversized lines are discarded through newline without buffering them. */
export async function runStdio({ input, output, handler, maxLineBytes = RPC_MAX_BYTES }) {
  let parts = [], length = 0, discarding = false;
  const outputError = error => input.destroy(error);
  output.on('error', outputError);
  const write = async message => {
    if (!message) return;
    const line = JSON.stringify(message) + '\n';
    // Tool results include both structured and text content; reserve exact dual encoding bound.
    if (Buffer.byteLength(line) > 3 * maxLineBytes + 16384) throw new Error('Output frame exceeds bounded size');
    await new Promise((resolve, reject) => output.write(line, error => error ? reject(error) : resolve()));
  };
  const parse = async line => {
    if (!line.length) return;
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    await write(await handler.handle(message));
  };
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
        const segment = bytes.subarray(offset, end);
        if (!discarding && length + segment.length > maxLineBytes) {
          discarding = true; parts = []; length = 0;
          await write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message exceeds size limit' } });
        }
        if (!discarding) { parts.push(segment); length += segment.length; }
        if (newline < 0) break;
        if (!discarding) await parse(Buffer.concat(parts, length));
        parts = []; length = 0; discarding = false; offset = newline + 1;
      }
    }
    // MCP frames require newline: report an incomplete final frame instead of executing it.
    if (length && !discarding) await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Incomplete final frame' } });
  } finally { await handler.service.shutdown(); output.removeListener('error', outputError); }
}
