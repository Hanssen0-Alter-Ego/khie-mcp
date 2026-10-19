#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const [directory, handle] = process.argv.slice(2);
try {
  if (
    !directory ||
    !isAbsolute(directory) ||
    !/^[a-f0-9-]{36}$/i.test(handle ?? "")
  ) {
    throw new Error("Invalid arguments");
  }
  const tokenFile = await open(
    join(directory, "secrets/http-token"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let token;
  try {
    const stat = await tokenFile.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("Unsafe credential file");
    }
    token = (await tokenFile.readFile("utf8")).trim();
    if (token.length < 32) throw new Error("Missing token");
  } finally {
    await tokenFile.close();
  }
  const client = await open(
    join(directory, "secrets/client.json"),
    "wx",
    0o600,
  );
  try {
    await client.writeFile(
      JSON.stringify({ endpoint: "http://127.0.0.1:8787/mcp", handle, token }) +
        "\n",
    );
  } finally {
    await client.close();
  }
  console.log(
    "Wrote protected read-only client configuration; no credential printed.",
  );
} catch {
  console.error(
    "Could not write client configuration; inspect paths, owner/mode and existing file.",
  );
  process.exitCode = 1;
}
