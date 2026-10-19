#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reconstruct only a new workspace. Never copy working-tree changes, Git
// configuration, credential files or history from the optional local source.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let source;
if (args[0] === "--source" && args.length === 3) {
  source = resolve(args[1]);
  args.splice(0, 2);
}
if (args.length !== 1 || args[0].startsWith("-")) {
  console.error(
    "Usage: node scripts/prepare-workspace.mjs [--source LOCAL_CCC] NEW_DIRECTORY",
  );
  process.exit(1);
}

const destination = resolve(args[0]);
let scratch;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(program, commandArgs, options = {}) {
  try {
    return execFileSync(program, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      ...options,
    });
  } catch {
    // A local Git helper or transport may include sensitive details in stderr.
    // Do not print raw subprocess output; stop without retries or fallback routes.
    throw new Error(`${program} failed during workspace preparation; stopped.`);
  }
}

try {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("Node 24 or later is required.");
  }
  // lstat also rejects an existing dangling symlink at the destination.
  try {
    lstatSync(destination);
    throw new Error("The destination already exists; choose a new directory.");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!existsSync(dirname(destination))) {
    throw new Error("The destination's parent directory must already exist.");
  }

  const manifest = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8"));
  for (const item of manifest.files) {
    const path = resolve(root, item.path);
    if (!path.startsWith(root + "/") || !lstatSync(path).isFile()) {
      throw new Error("Invalid publication manifest path.");
    }
    if (digest(readFileSync(path)) !== item.sha256) {
      throw new Error("Publication checksum mismatch; workspace not created.");
    }
  }
  const upstream = JSON.parse(readFileSync(join(root, "UPSTREAM.json"), "utf8"));
  if (
    upstream.repository !== "https://github.com/ckb-devrel/ccc.git" ||
    upstream.commit !== "0abf78e5f469216e82a24de8d4051e757368af90" ||
    upstream.patch !== "patches/ccc-khie-mcp.patch"
  ) {
    throw new Error("Unexpected upstream configuration; review required.");
  }
  const patch = join(root, upstream.patch);
  if (digest(readFileSync(patch)) !== upstream.patch_sha256) {
    throw new Error("Patch checksum mismatch; workspace not created.");
  }

  scratch = mkdtempSync(join(dirname(destination), ".khie-materialize-"));
  if (!source) {
    source = join(scratch, "upstream");
    mkdirSync(source);
    run("git", ["init", "--quiet", source]);
    run(
      "git",
      ["fetch", "--quiet", "--depth=1", upstream.repository, upstream.commit],
      { cwd: source },
    );
  }
  const resolved = run("git", ["rev-parse", `${upstream.commit}^{commit}`], {
    cwd: source,
  })
    .toString("utf8")
    .trim();
  if (resolved !== upstream.commit) {
    throw new Error("The source does not contain the required upstream commit.");
  }
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const archive = run("git", ["archive", "--format=tar", upstream.commit], {
    cwd: source,
  });
  run("tar", ["-xf", "-", "-C", workspace], { input: archive });
  // The destination may be inside this publication's own Git worktree. Stop Git
  // discovery at the scratch directory so patch paths remain archive-relative.
  const applyOptions = {
    cwd: workspace,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch },
  };
  run("git", ["apply", "--check", patch], applyOptions);
  run("git", ["apply", patch], applyOptions);
  for (const item of manifest.files) {
    if (item.path.startsWith("source/")) {
      const bytes = readFileSync(join(workspace, item.path.slice("source/".length)));
      if (digest(bytes) !== item.sha256) {
        throw new Error("Applied source differs from the published source.");
      }
    }
  }
  renameSync(workspace, destination);
  console.log("Created the exact CCC workspace with the reviewed Khie MCP patch.");
  console.log("No dependencies installed and no service started. See README.md.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Preparation failed.");
  process.exitCode = 1;
} finally {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true });
  }
}
