#!/usr/bin/env node
import { runStdio } from '../core/src/mcp.mjs';
import { createHost } from './host.mjs';
import { readConfigFile, readEndpointFd } from './input.mjs';

let host, intentionalShutdown = false;
const shutdown = () => { intentionalShutdown = true; void host?.service.shutdown().finally(() => process.stdin.destroy()); };
try {
  const args = process.argv.slice(2);
  if (!args.length) host = await createHost();
  else if (args.length === 2 && args[0] === '--live-config') {
    const config = await readConfigFile(args[1]);
    const endpoint = await readEndpointFd();
    host = await createHost({ config, endpoint });
  } else throw new Error('Invalid invocation');
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  await runStdio({ input: process.stdin, output: process.stdout, handler: host.handler });
} catch {
  if (!intentionalShutdown) { process.stderr.write('Khie MCP could not start or its transport terminated. Configuration and endpoint details are not logged.\n'); process.exitCode = 1; }
} finally {
  process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown);
  await host?.service.shutdown();
}
