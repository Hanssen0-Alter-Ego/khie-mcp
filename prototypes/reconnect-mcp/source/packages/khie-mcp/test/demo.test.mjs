import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Run after building: these checks deliberately cross the process boundary.
const entry = new URL("../dist/demo.js", import.meta.url);

function startDemo(directory) {
  const child = spawn(process.execPath, [entry.pathname, directory], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, exited };
}

test("occupied demo port removes all newly acquired temporary state", async () => {
  const root = await mkdtemp(join(tmpdir(), "khie-demo-startup-test-"));
  const directory = join(root, "demo");
  const blocker = createServer();
  let demo;
  try {
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(8787, "127.0.0.1", resolve);
    });
    demo = startDemo(directory);
    const result = await demo.exited;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /demo_setup_failed/);
    assert.match(result.stdout, /temporary state removed/);
    assert.doesNotMatch(result.stdout, /clientConfigFile/);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  } finally {
    demo?.child.kill("SIGTERM");
    await demo?.exited;
    if (blocker.listening) {
      await new Promise((resolve) => blocker.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGTERM removes a running demo's credentials and closes its port", async () => {
  const root = await mkdtemp(join(tmpdir(), "khie-demo-signal-test-"));
  const directory = join(root, "demo");
  const demo = startDemo(directory);
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      demo.child.stdout.on("data", (data) => {
        output += data;
        if (output.includes("clientConfigFile")) resolve();
      });
      demo.child.once("close", () =>
        reject(new Error("Demo exited before readiness")),
      );
      demo.child.once("error", reject);
    });
    const config = await stat(join(directory, "client.json"));
    assert.equal(config.mode & 0o777, 0o600);
    demo.child.kill("SIGTERM");
    const result = await demo.exited;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /temporary state removed/);
    await assert.rejects(stat(directory), { code: "ENOENT" });
    const probe = createServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(8787, "127.0.0.1", resolve);
      });
    } finally {
      if (probe.listening) await new Promise((resolve) => probe.close(resolve));
    }
  } finally {
    demo.child.kill("SIGTERM");
    await demo.exited;
    await rm(root, { recursive: true, force: true });
  }
});
