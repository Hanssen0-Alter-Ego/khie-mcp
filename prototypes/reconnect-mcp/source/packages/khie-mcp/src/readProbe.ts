import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readSecretFile } from "./cli.js";
import { BridgeError, validateOperationId } from "./state.js";

const configSchema = z
  .object({
    endpoint: z.string().url(),
    handle: z.string().uuid(),
    token: z.string().min(32),
  })
  .strict();
const readMethods = ["get_identity", "get_native_address", "get_scripts"];

/** Operator-only, one-call local probe. Never generates IDs or retries a request. */
export async function runReadProbe(
  configPath: string,
  mode: string,
  operationId: string,
  method?: string,
) {
  validateOperationId(operationId);
  if (
    (mode !== "request" && mode !== "poll") ||
    (mode === "request" && !readMethods.includes(method ?? "")) ||
    (mode === "poll" && method !== undefined)
  ) {
    throw new BridgeError("invalid_probe_arguments");
  }
  let client: Client | undefined;
  try {
    const config = configSchema.parse(
      JSON.parse(await readSecretFile(configPath)),
    );
    const url = new URL(config.endpoint);
    // This mobile readiness client is deliberately local. The synthetic smoke
    // client remains the separate entry point for approved public tunnel tests.
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/mcp" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid local endpoint");
    }
    client = new Client({ name: "khie-read-only-probe", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    if (client.getServerVersion()?.name !== "khie-mcp-prototype") {
      throw new Error("Unexpected server");
    }
    const names = (await client.listTools()).tools.map(({ name }) => name);
    if (!names.includes("khie_request") || !names.includes("khie_get_result")) {
      throw new Error("Missing tools");
    }
    const result = await client.callTool({
      name: mode === "poll" ? "khie_get_result" : "khie_request",
      arguments: {
        handle: config.handle,
        operation_id: operationId,
        ...(mode === "request" ? { method, params: [] } : {}),
      },
    });
    const content = result.content as { type: string; text?: string }[];
    if (
      content.length !== 1 ||
      content[0].type !== "text" ||
      !content[0].text
    ) {
      throw new Error("Invalid response");
    }
    return JSON.parse(content[0].text) as unknown;
  } catch {
    // SDK, config and transport errors can echo Authorization or provisioning data.
    throw new BridgeError("read_probe_failed");
  } finally {
    await client?.close().catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [config, mode, operationId, method, ...extra] = process.argv.slice(2);
  if (!config || !mode || !operationId || extra.length) {
    console.error("use_read_probe_CONFIG_request_ID_METHOD_or_CONFIG_poll_ID");
    process.exitCode = 1;
  } else {
    void runReadProbe(config, mode, operationId, method).then(
      (outcome) => console.log(JSON.stringify(outcome)),
      () => {
        console.error("read_probe_failed");
        process.exitCode = 1;
      },
    );
  }
}
