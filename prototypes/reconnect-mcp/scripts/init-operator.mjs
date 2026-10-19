#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2];
const checkout = fileURLToPath(new URL("..", import.meta.url));
try {
  if (!directory || !isAbsolute(directory)) {
    throw new Error(
      "Supply a new absolute private directory outside this checkout.",
    );
  }
  const inside = relative(checkout, resolve(directory));
  if (!inside.startsWith("..") && !isAbsolute(inside)) {
    throw new Error("Private state must be outside this checkout.");
  }
  if (process.getuid?.() === 0) {
    throw new Error(
      "Run provisioning as the non-root operator who owns the files.",
    );
  }
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "secrets"), { mode: 0o700 });
  await mkdir(join(directory, "state"), { mode: 0o700 });
  const save = (name, content) =>
    writeFile(join(directory, "secrets", name), content, {
      mode: 0o600,
      flag: "wx",
    });
  await save("store-key", randomBytes(32).toString("base64") + "\n");
  await save("http-token", randomBytes(32).toString("base64url") + "\n");
  await save(
    "config.json",
    JSON.stringify(
      {
        principal: "local-operator",
        storeDirectory: "/var/lib/khie",
        storeKeyFile: "/run/khie/store-key",
        tokenFile: "/run/khie/http-token",
        allowedHosts: ["127.0.0.1:8787", "localhost:8787"],
        port: 8787,
        listenHost: "0.0.0.0",
        networkId: "ckb-testnet",
        allowedMethods: ["get_identity", "get_native_address", "get_scripts"],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Created protected local configuration, key/token files and empty state.",
  );
  console.log(
    "No wallet created, paired or contacted. Keep all files private.",
  );
} catch {
  console.error(
    "Provisioning failed; inspect the directory before retrying. No secrets printed.",
  );
  process.exitCode = 1;
}
