#!/usr/bin/env node
import { KhieService } from './service.mjs';
import { createOfflineFixture } from './adapter.mjs';
import { McpHandler, runStdio } from './mcp.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('Usage: node src/cli.mjs\nThis candidate runs offline fixtures only. No live-wallet or network flags exist.\n');
  process.exitCode = 2;
} else {
  const service = new KhieService({ transportFactory: createOfflineFixture });
  let intentionalShutdown = false;
  const shutdown = () => { intentionalShutdown = true; void service.shutdown().finally(() => process.stdin.destroy()); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try { await runStdio({ input: process.stdin, output: process.stdout, handler: new McpHandler(service) }); }
  catch { if (!intentionalShutdown) { process.stderr.write('Khie MCP transport terminated.\n'); process.exitCode = 1; } }
  finally { process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown); }
}
