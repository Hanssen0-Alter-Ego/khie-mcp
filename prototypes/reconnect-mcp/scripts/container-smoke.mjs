#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2];
if (!image || image.startsWith("-")) {
  throw new Error("Supply the locally built image name.");
}
const name = `khie-synthetic-${randomUUID()}`;
const missingConfigName = `${name}-missing-config`;
const flags = [
  "--read-only",
  "--user",
  "1000:1000",
  "--init",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
  "--pids-limit",
  "128",
  "--memory",
  "512m",
];
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  });
let created = false;
try {
  const unconfigured = spawnSync(
    "docker",
    ["run", "--rm", "--name", missingConfigName, ...flags, image],
    {
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  assert.equal(
    unconfigured.status,
    1,
    "Missing protected configuration must fail closed",
  );
  assert.match(
    unconfigured.stderr,
    /operator_action_failed|missing_config_file/,
  );
  docker([
    "run",
    "--detach",
    "--name",
    name,
    ...flags,
    "--publish",
    "127.0.0.1::8787",
    image,
    "demo",
    "/tmp/khie-mcp-demo",
  ]);
  created = true;
  let ready = false;
  for (let attempts = 0; attempts < 60; attempts++) {
    const probe = spawnSync(
      "docker",
      [
        "exec",
        name,
        "node",
        "-e",
        "require('node:fs').accessSync('/tmp/khie-mcp-demo/client.json')",
      ],
      { stdio: "ignore", timeout: 5000 },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    if (
      docker(["inspect", "--format", "{{.State.Running}}", name]).trim() !==
      "true"
    ) {
      break;
    }
    await delay(500);
  }
  assert(ready, "Synthetic demo must become ready");
  assert.notEqual(
    docker(["exec", name, "node", "-p", "process.getuid()"]).trim(),
    "0",
  );
  const mapping = docker(["port", name, "8787/tcp"]).trim();
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  // Node fetch rewrites Host to the random published port. Use node:http to
  // supply the demo's exact allowed Host, retaining its production Host guard.
  const unauthorized = await new Promise((resolve, reject) => {
    const req = request(
      `http://${mapping}/mcp`,
      {
        method: "POST",
        headers: { Host: "127.0.0.1:8787" },
        timeout: 5000,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    req.once("error", reject);
    req.once("timeout", () =>
      req.destroy(new Error("Local HTTP probe timed out")),
    );
    req.end();
  });
  assert.equal(unauthorized, 401);
  const output = docker([
    "exec",
    name,
    "node",
    "/app/dist/smoke.js",
    "/tmp/khie-mcp-demo/client.json",
  ]);
  process.stdout.write(output);
  docker(["stop", "--time", "45", name]);
  const status = JSON.parse(
    docker(["inspect", "--format", "{{json .State}}", name]),
  );
  assert.equal(status.ExitCode, 0);
  const logs = docker(["logs", name]);
  assert.match(logs, /temporary state removed/);
  assert.match(logs, /"authorizations":1/);
  assert.match(logs, /"syntheticSignatures":1/);
  console.log(
    "Container smoke passed: non-root, fail-closed config, loopback port, 401, SDK and loopback libp2p and cleanup.",
  );
} finally {
  spawnSync("docker", ["rm", "--force", missingConfigName], {
    stdio: "ignore",
    timeout: 30_000,
  });
  if (created) {
    spawnSync("docker", ["rm", "--force", name], {
      stdio: "ignore",
      timeout: 30_000,
    });
  }
}
