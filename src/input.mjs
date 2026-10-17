import { open } from 'node:fs/promises';
import { createReadStream, fstatSync, constants } from 'node:fs';
import { Socket } from 'node:net';
import { MAX_ENDPOINT_BYTES, validateConfig } from './policy.mjs';
import { fail } from '../core/src/protocol.mjs';

export async function readConfigFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) fail('INVALID_CONFIG', 'Configuration must be a regular JSON file');
    const buffer = Buffer.alloc(16_385); let bytes = 0;
    while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    if (bytes > 16_384) fail('INVALID_CONFIG', 'Configuration exceeds 16 KiB');
    return validateConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))));
  } catch { fail('INVALID_CONFIG', 'Cannot read a valid trusted live configuration'); }
  finally { await handle?.close(); }
}

export async function readEndpointFd(fd = 3, timeoutMs = 10_000) {
  if (fd !== 3) fail('INVALID_ENDPOINT', 'Endpoint input must use dedicated file descriptor 3');
  const chunks = []; let length = 0, input, timer;
  try {
    // A pipe/socket must use nonblocking reads so timeout can close an idle sender.
    input = fstatSync(fd).isFile()
      ? createReadStream(null, { fd, autoClose: true, highWaterMark: 4096, end: MAX_ENDPOINT_BYTES })
      : new Socket({ fd, readable: true, writable: false });
    timer = setTimeout(() => input.destroy(new Error('Endpoint input timeout')), timeoutMs);
    for await (const chunk of input) {
      length += chunk.length;
      if (length > MAX_ENDPOINT_BYTES) fail('INVALID_ENDPOINT', 'Provider endpoint input is too large');
      chunks.push(chunk);
    }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
    if (!value || /[\r\n]/.test(value)) fail('INVALID_ENDPOINT', 'Provider endpoint must be one line');
    return value;
  } catch { fail('INVALID_ENDPOINT', 'Cannot read the private provider endpoint from file descriptor 3'); }
  finally { clearTimeout(timer); input?.destroy(); chunks.forEach(chunk => chunk.fill(0)); }
}
