import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { KhieBridge } from "./bridge.js";
import { enroll } from "./enroll.js";
import { httpListenHost } from "./listenHost.js";
import { createHttpServer } from "./server.js";
import { BridgeError, type Method } from "./state.js";
import { FileSecureStateStore } from "./store.js";
import { libp2pConnector } from "./transport.js";

export async function readSecretFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new BridgeError("unsafe_secret_file");
    }
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
}

async function main() {
  const configFile = process.env.KHIE_CONFIG_FILE;
  if (!configFile) {
    throw new BridgeError("missing_config_file");
  }
  const config = JSON.parse(await readSecretFile(configFile)) as {
    principal: string;
    storeDirectory: string;
    storeKeyFile: string;
    tokenFile: string;
    allowedHosts: string[];
    port?: number;
    listenHost?: string;
    networkId?: string;
    allowedMethods?: Method[];
  };
  const store = await FileSecureStateStore.open(
    config.storeDirectory,
    Buffer.from(await readSecretFile(config.storeKeyFile), "base64"),
  );
  const bridge = new KhieBridge(store, libp2pConnector());
  const [command, argument] = process.argv.slice(2);
  if (command === "enroll") {
    if (!argument) {
      throw new BridgeError("missing_endpoint_file");
    }
    const handle = await enroll(
      store,
      config.principal,
      await readSecretFile(argument),
      config.networkId ?? "ckb-testnet",
      config.allowedMethods,
    );
    // Print the non-secret handle before approval so setup can be resumed.
    console.log(JSON.stringify({ handle }));
    console.log(
      JSON.stringify(await bridge.authorize(config.principal, handle)),
    );
  } else if (command === "authorize") {
    console.log(
      JSON.stringify(await bridge.authorize(config.principal, argument)),
    );
  } else if (command === "serve") {
    const server = createHttpServer(bridge, {
      ...config,
      bearerToken: await readSecretFile(config.tokenFile),
    });
    server.listen(config.port ?? 8787, httpListenHost(config.listenHost), () =>
      console.log("Khie MCP HTTP listener ready"),
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        server.close();
      });
    }
  } else {
    throw new BridgeError("use_enroll_authorize_or_serve");
  }
}

// No raw errors: provisioning errors may contain endpoint or identity material.
if (process.argv[1]?.endsWith("/cli.js")) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof BridgeError ? error.code : "operator_action_failed",
    );
    process.exitCode = 1;
  });
}
