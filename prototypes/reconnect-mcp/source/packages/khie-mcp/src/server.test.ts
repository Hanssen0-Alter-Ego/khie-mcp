import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import type { KhieBridge } from "./bridge.js";
import { createHttpServer } from "./server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

async function fixture() {
  const token = randomBytes(32).toString("base64url");
  const bridge = {
    request: vi.fn(async () => ({
      status: "completed",
      result: "test-result",
    })),
    poll: vi.fn(async () => ({ status: "pending" })),
  };
  const hosts: string[] = ["placeholder"];
  const server = createHttpServer(bridge as unknown as KhieBridge, {
    principal: "test-principal",
    bearerToken: token,
    allowedHosts: hosts,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = new URL(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  );
  hosts.push(url.host);
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return { token, bridge, url };
}

it("initializes an independent SDK client and lists/calls the two bounded tools", async () => {
  const f = await fixture();
  const client = new Client({
    name: "independent-test-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(f.url, {
    requestInit: { headers: { Authorization: `Bearer ${f.token}` } },
  });
  await client.connect(transport);
  cleanup.push(() => client.close());
  expect(client.getServerVersion()?.name).toBe("khie-mcp-prototype");
  expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
    "khie_request",
    "khie_get_result",
  ]);
  const handle = randomUUID();
  const result = await client.callTool({
    name: "khie_request",
    arguments: { handle, operation_id: "read-1", method: "get_identity" },
  });
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({ status: "completed", result: "test-result" }),
    },
  ]);
  expect(f.bridge.request).toHaveBeenCalledWith(
    "test-principal",
    handle,
    "read-1",
    "get_identity",
    [],
  );
  expect(
    await client.callTool({
      name: "khie_get_result",
      arguments: { handle, operation_id: "read-1" },
    }),
  ).toMatchObject({ content: [{ text: '{"status":"pending"}' }] });
  const forbidden = await client.callTool({
    name: "khie_request",
    arguments: {
      handle,
      operation_id: "forbidden",
      method: "send_transaction",
      session_id: "must-not-accept",
    },
  });
  expect(forbidden.isError).toBe(true);
  expect(f.bridge.request).toHaveBeenCalledTimes(1);
});

it("requires authentication and rejects browser origins, bad hosts, and non-POST transport", async () => {
  const f = await fixture();
  expect((await fetch(f.url)).status).toBe(401);
  const headers = { Authorization: `Bearer ${f.token}` };
  expect((await fetch(f.url, { headers })).status).toBe(405);
  expect(
    (
      await fetch(f.url, {
        headers: { ...headers, Origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
  // fetch normalizes Host; use a raw HTTP client for the rebinding check.
  const badHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = request(
        f.url,
        { headers: { ...headers, Host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  expect(badHostStatus).toBe(403);
  expect((await fetch(new URL("/wallet-rpc", f.url), { headers })).status).toBe(
    404,
  );
  expect(f.bridge.request).not.toHaveBeenCalled();
});

it("does not expose raw adapter errors through MCP", async () => {
  const f = await fixture();
  f.bridge.request.mockRejectedValue(
    new Error("private communication key and session data"),
  );
  const client = new Client({ name: "error-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(f.url, {
      requestInit: { headers: { Authorization: `Bearer ${f.token}` } },
    }),
  );
  cleanup.push(() => client.close());
  const result = await client.callTool({
    name: "khie_request",
    arguments: {
      handle: randomUUID(),
      operation_id: "error",
      method: "get_identity",
    },
  });
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: '{"error":"bridge_unavailable"}' }],
  });
});
