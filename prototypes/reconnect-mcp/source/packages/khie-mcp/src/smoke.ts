import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readSecretFile } from "./cli.js";

async function main() {
  const config = JSON.parse(await readSecretFile(process.argv[2])) as {
    handle: string;
    token: string;
    endpoint: string;
  };
  const endpoint = new URL(process.argv[3] ?? config.endpoint);
  assert(endpoint.protocol === "https:" || endpoint.hostname === "127.0.0.1");
  const unauthorized = await fetch(endpoint);
  assert.equal(unauthorized.status, 401);
  const client = new Client({
    name: "khie-independent-smoke",
    version: "0.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "khie-mcp-prototype");
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["khie_request", "khie_get_result"],
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: { handle: config.handle, ...args },
      });
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0].text) as {
        status?: string;
        reason?: string;
        result?: unknown;
        error?: string;
      };
    };
    const operation_id = randomUUID();
    const first = await call("khie_request", {
      operation_id,
      method: "get_identity",
    });
    assert.deepEqual(first, {
      status: "completed",
      result: "synthetic-wallet-identity",
    });
    assert.deepEqual(
      await call("khie_request", { operation_id, method: "get_identity" }),
      first,
    );
    const signingId = randomUUID();
    const initial = await call("khie_request", {
      operation_id: signingId,
      method: "sign_message",
      params: [{ type: "string", value: "synthetic smoke test only" }],
    });
    assert.equal(initial.status, "unknown");
    const mismatch = await call("khie_request", {
      operation_id: signingId,
      method: "sign_message",
      params: [{ type: "string", value: "different request" }],
    });
    assert.equal(mismatch.error, "operation_payload_mismatch");
    const pending = await call("khie_get_result", { operation_id: signingId });
    assert.equal(pending.status, "pending");
    const completed = await call("khie_get_result", {
      operation_id: signingId,
    });
    assert.deepEqual(completed, {
      status: "completed",
      result: "synthetic-signature-not-valid-on-any-chain",
    });
    console.log(
      JSON.stringify({
        initialize: "passed",
        tools: "passed",
        authentication: "passed",
        requestAndRetry: "passed",
        mismatchedPayload: "passed",
        pendingThenCompleted: "passed",
        wallet: "synthetic loopback peer",
        hostConnectorIntegration: "not tested",
      }),
    );
  } finally {
    await client.close();
  }
}

void main().catch(() => {
  console.error(
    "smoke_failed (credentials and raw transport errors suppressed)",
  );
  process.exitCode = 1;
});
