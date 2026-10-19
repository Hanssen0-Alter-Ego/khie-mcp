import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import type { KhieBridge } from "./bridge.js";
import { BridgeError, METHODS } from "./state.js";

export type ServerConfig = {
  /** One principal/token per prototype server. Handles are not credentials. */
  principal: string;
  bearerToken: string;
  allowedHosts: string[];
};

export function createMcpServer(bridge: KhieBridge, principal: string) {
  const server = new McpServer({
    name: "khie-mcp-prototype",
    version: "0.0.0",
  });
  const identifiers = {
    handle: z
      .string()
      .uuid()
      .describe("Opaque operator-provisioned wallet handle"),
    operation_id: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
      .describe(
        "Reuse for retries of the same intent; never change to bypass an unknown outcome",
      ),
  };
  server.registerTool(
    "khie_request",
    {
      description:
        "Request from the user's online Khie wallet. Wallet approvals remain in the wallet. Reuse operation_id for retries; unknown never means not executed. Transactions are not supported.",
      inputSchema: z
        .object({
          ...identifiers,
          method: z.enum(METHODS),
          params: z
            .array(
              z.discriminatedUnion("type", [
                z
                  .object({ type: z.literal("string"), value: z.string() })
                  .strict(),
                z
                  .object({
                    type: z.literal("bytes"),
                    value: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
                  })
                  .strict(),
              ]),
            )
            .max(1)
            .default([]),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ handle, operation_id, method, params }) =>
      toolResult(() =>
        bridge.request(principal, handle, operation_id, method, params),
      ),
  );
  server.registerTool(
    "khie_get_result",
    {
      description:
        "Poll a previously recorded operation. Pending may need wallet confirmation. An unknown/not_found outcome may have executed and must not be automatically submitted again.",
      inputSchema: z.object(identifiers).strict(),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ handle, operation_id }) =>
      toolResult(() => bridge.poll(principal, handle, operation_id)),
  );
  return server;
}

async function toolResult(run: () => Promise<unknown>) {
  try {
    const result = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (error) {
    // Do not forward wallet, transport, file, SDK, or credential error messages.
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error:
              error instanceof BridgeError ? error.code : "bridge_unavailable",
          }),
        },
      ],
    };
  }
}

/** Stateless Streamable HTTP, JSON responses (no SSE needed by quick tunnels). */
export function createHttpServer(bridge: KhieBridge, config: ServerConfig) {
  if (
    config.bearerToken.length < 32 ||
    !config.principal ||
    !config.allowedHosts.length
  ) {
    throw new BridgeError("invalid_server_config");
  }
  const expected = hash(config.bearerToken);
  let active = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (
      !config.allowedHosts.includes(request.headers.host ?? "") ||
      request.headers.origin !== undefined
    ) {
      response.writeHead(403).end();
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      !request.headers.authorization?.startsWith("Bearer ") ||
      !timingSafeEqual(expected, hash(token))
    ) {
      response.writeHead(401).end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      response.writeHead(415).end();
      return;
    }
    if (active >= 8) {
      response.writeHead(429).end();
      return;
    }
    active++;
    let mcp: McpServer | undefined;
    try {
      const body = await readBody(request);
      mcp = createMcpServer(bridge, config.principal);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) {
        response.writeHead(400).end();
      }
    } finally {
      await mcp?.close();
      active--;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 64 * 1024) {
      throw new Error("Body too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}
