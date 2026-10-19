import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { KhieBridge } from "./bridge.js";
import { runReadProbe } from "./readProbe.js";
import { createHttpServer } from "./server.js";
import type { Outcome } from "./state.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "khie-read-probe-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const token = randomBytes(32).toString("base64url");
  const handle = randomUUID();
  const bridge = {
    request: vi.fn(async (): Promise<Outcome> => ({
      status: "completed",
      result: "arbitrary-test-identity",
    })),
    poll: vi.fn(async (): Promise<Outcome> => ({ status: "pending" })),
  };
  const hosts = ["placeholder"];
  const server = createHttpServer(bridge as unknown as KhieBridge, {
    principal: "read-probe-test",
    bearerToken: token,
    allowedHosts: hosts,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  hosts.push(new URL(endpoint).host);
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const file = join(directory, "client.json");
  const config = { handle, token, endpoint };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return { bridge, handle, file, config };
}

it("uses real MCP initialization and discovery for one read, preserving the supplied ID", async () => {
  const f = await fixture();
  expect(
    await runReadProbe(f.file, "request", "mobile-read-001", "get_identity"),
  ).toEqual({
    status: "completed",
    result: "arbitrary-test-identity",
  });
  expect(f.bridge.request).toHaveBeenCalledExactlyOnceWith(
    "read-probe-test",
    f.handle,
    "mobile-read-001",
    "get_identity",
    [],
  );
  expect(f.bridge.poll).not.toHaveBeenCalled();
});

it("polls in a fresh SDK client without sending another wallet request", async () => {
  const f = await fixture();
  expect(await runReadProbe(f.file, "poll", "pending-read-001")).toEqual({
    status: "pending",
  });
  f.bridge.poll.mockResolvedValueOnce({
    status: "unknown",
    reason: "not_found",
  });
  expect(await runReadProbe(f.file, "poll", "pending-read-001")).toEqual({
    status: "unknown",
    reason: "not_found",
  });
  expect(f.bridge.request).not.toHaveBeenCalled();
  expect(f.bridge.poll).toHaveBeenNthCalledWith(
    1,
    "read-probe-test",
    f.handle,
    "pending-read-001",
  );
  expect(f.bridge.poll).toHaveBeenNthCalledWith(
    2,
    "read-probe-test",
    f.handle,
    "pending-read-001",
  );
});

it("rejects signing, transaction methods and invalid IDs before opening the credential file", async () => {
  for (const method of ["sign_message", "send_transaction", "connect"]) {
    await expect(
      runReadProbe("missing", "request", "read-001", method),
    ).rejects.toMatchObject({ code: "invalid_probe_arguments" });
  }
  await expect(
    runReadProbe("missing", "poll", "_connect"),
  ).rejects.toMatchObject({ code: "invalid_operation_id" });
  await expect(
    runReadProbe("missing", "poll", "read-001", "get_identity"),
  ).rejects.toMatchObject({ code: "invalid_probe_arguments" });
});

it("fails closed on nonlocal credential destinations and unsafe file permissions", async () => {
  const f = await fixture();
  await writeFile(
    f.file,
    JSON.stringify({ ...f.config, endpoint: "https://example.invalid/mcp" }),
  );
  await expect(
    runReadProbe(f.file, "request", "read-001", "get_identity"),
  ).rejects.toMatchObject({ code: "read_probe_failed" });
  const unsafe = `${f.file}.unsafe`;
  await writeFile(unsafe, JSON.stringify(f.config), { mode: 0o644 });
  // A restrictive process umask may remove these bits during creation.
  await chmod(unsafe, 0o644);
  await expect(
    runReadProbe(unsafe, "request", "read-001", "get_identity"),
  ).rejects.toMatchObject({ code: "read_probe_failed" });
  expect(f.bridge.request).not.toHaveBeenCalled();
});

it("suppresses authentication and raw adapter errors", async () => {
  const f = await fixture();
  await writeFile(
    f.file,
    JSON.stringify({
      ...f.config,
      token: randomBytes(32).toString("base64url"),
    }),
  );
  await expect(
    runReadProbe(f.file, "request", "read-001", "get_identity"),
  ).rejects.toThrow(/^read_probe_failed$/);
  await writeFile(f.file, JSON.stringify(f.config));
  f.bridge.request.mockRejectedValueOnce(
    new Error(`private-token:${f.config.token}`),
  );
  expect(
    await runReadProbe(f.file, "request", "read-001", "get_identity"),
  ).toEqual({ error: "bridge_unavailable" });
});
