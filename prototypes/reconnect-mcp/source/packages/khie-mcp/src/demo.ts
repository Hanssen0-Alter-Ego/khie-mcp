import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KhieBridge } from "./bridge.js";
import { enroll } from "./enroll.js";
import { httpListenHost } from "./listenHost.js";
import { createHttpServer } from "./server.js";
import { FileSecureStateStore } from "./store.js";
import { createTestBridgeNode, createTestWallet } from "./testWallet.js";
import { libp2pConnector } from "./transport.js";

async function main() {
  const directory = resolve(process.argv[2] ?? "/tmp/khie-mcp-demo");
  // Refuse to overwrite or later delete a preexisting directory.
  await mkdir(directory, { mode: 0o700 });
  let wallet: Awaited<ReturnType<typeof createTestWallet>> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    controller.abort();
    finish();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, stop);
  }
  const checkRunning = () => controller.signal.throwIfAborted();

  try {
    const key = randomBytes(32);
    const token = randomBytes(32).toString("base64url");
    const store = await FileSecureStateStore.open(`${directory}/state`, key);
    checkRunning();
    wallet = await createTestWallet({ signDelayMs: 25_000 });
    checkRunning();
    const handle = await enroll(
      store,
      "isolated-demo",
      wallet.endpoint,
      "ckb-testnet",
      ["get_identity", "sign_message"],
      createTestBridgeNode,
    );
    checkRunning();
    const bridge = new KhieBridge(store, libp2pConnector(createTestBridgeNode));
    const authorized = await bridge.authorize("isolated-demo", handle);
    checkRunning();
    if (authorized.status !== "completed") {
      throw new Error("Demo authorization failed");
    }
    server = createHttpServer(bridge, {
      principal: "isolated-demo",
      bearerToken: token,
      allowedHosts: ["127.0.0.1:8787", "localhost:8787"],
    });
    // Await errors such as EADDRINUSE inside the resource-cleanup scope.
    await new Promise<void>((resolve, reject) => {
      const listening = () => {
        server!.off("error", reject);
        resolve();
      };
      server!.once("error", reject);
      server!.listen(
        8787,
        httpListenHost(process.env.KHIE_LISTEN_HOST),
        listening,
      );
    });
    checkRunning();
    await writeFile(
      `${directory}/client.json`,
      JSON.stringify({ handle, token, endpoint: "http://127.0.0.1:8787/mcp" }),
      { mode: 0o600 },
    );
    checkRunning();
    console.log(
      JSON.stringify({
        demo: "synthetic wallet only",
        clientConfigFile: `${directory}/client.json`,
        lifetime: "five minutes or until SIGINT/SIGTERM",
      }),
    );
    timer = setTimeout(stop, 5 * 60_000);
    await stopped;
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.off(signal, stop);
    }
    try {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
          server!.closeAllConnections();
        });
      }
    } finally {
      try {
        await wallet?.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    console.log(
      JSON.stringify({
        demo: "stopped",
        authorizations: wallet?.stats.authorizations ?? 0,
        syntheticSignatures: wallet?.stats.signatures ?? 0,
        cleanup: "temporary state removed",
      }),
    );
  }
}

// Exit only after cleanup: the provider's existing result-cache timers otherwise
// keep a demo process alive. Raw errors may contain private provisioning data.
void main().then(
  () => process.exit(0),
  () => {
    console.error("demo_setup_failed");
    process.exit(1);
  },
);
