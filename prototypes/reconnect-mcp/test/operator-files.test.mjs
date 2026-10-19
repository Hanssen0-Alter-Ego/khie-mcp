import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const initialize = new URL("../scripts/init-operator.mjs", import.meta.url);
const client = new URL("../scripts/write-read-client.mjs", import.meta.url);
const run = (script, ...args) =>
  spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8" });

test("operator provisioning protects secrets and refuses to rotate an existing store key", async () => {
  const root = await mkdtemp(join(tmpdir(), "khie-container-operator-"));
  const directory = join(root, "private");
  try {
    const result = run(initialize, directory);
    assert.equal(result.status, 0);
    for (const path of [
      directory,
      join(directory, "secrets"),
      join(directory, "state"),
    ]) {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    }
    for (const name of ["config.json", "store-key", "http-token"]) {
      assert.equal(
        (await stat(join(directory, "secrets", name))).mode & 0o777,
        0o600,
      );
    }
    const key = await readFile(join(directory, "secrets/store-key"), "utf8");
    const token = await readFile(join(directory, "secrets/http-token"), "utf8");
    assert.equal(Buffer.from(key.trim(), "base64").length, 32);
    assert.equal(Buffer.from(token.trim(), "base64url").length, 32);
    assert(
      !result.stdout.includes(key.trim()) &&
        !result.stdout.includes(token.trim()),
    );
    const config = JSON.parse(
      await readFile(join(directory, "secrets/config.json"), "utf8"),
    );
    assert.deepEqual(config.allowedMethods, [
      "get_identity",
      "get_native_address",
      "get_scripts",
    ]);
    assert.equal(config.listenHost, "0.0.0.0");
    assert.equal(run(initialize, directory).status, 1);
    assert.equal(
      await readFile(join(directory, "secrets/store-key"), "utf8"),
      key,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client provisioning refuses unsafe token permissions and never overwrites credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "khie-container-client-"));
  const directory = join(root, "private");
  const handle = randomUUID();
  try {
    assert.equal(run(initialize, directory).status, 0);
    const tokenPath = join(directory, "secrets/http-token");
    await chmod(tokenPath, 0o644);
    assert.equal(run(client, directory, handle).status, 1);
    await assert.rejects(stat(join(directory, "secrets/client.json")), {
      code: "ENOENT",
    });
    await chmod(tokenPath, 0o600);
    const result = run(client, directory, handle);
    assert.equal(result.status, 0);
    const path = join(directory, "secrets/client.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.handle, handle);
    assert.equal(config.endpoint, "http://127.0.0.1:8787/mcp");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert(!result.stdout.includes(config.token));
    assert.equal(run(client, directory, randomUUID()).status, 1);
    assert.equal(JSON.parse(await readFile(path, "utf8")).handle, handle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
