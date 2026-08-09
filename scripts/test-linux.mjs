#!/usr/bin/env node
// Runs the suite in a copied Linux container workspace. Host node_modules and
// build output never enter the copy, and every Docker call is an argument array.

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

export function linuxContainerCommands(version, stagedWorktree, containerId) {
  return {
    create: [
      "create",
      "--workdir",
      "/app",
      `node:${version}`,
      "node",
      "scripts/test-linux.mjs",
      "--container",
    ],
    copy: ["cp", `${stagedWorktree}${sep}.`, `${containerId}:/app`],
    start: ["start", "--attach", containerId],
    remove: ["rm", "--force", containerId],
  };
}

export function copiedWorktreeFilter(repositoryRoot, source) {
  const path = relative(repositoryRoot, source);
  if (path === "") return true;
  const first = path.split(sep)[0];
  return first !== "node_modules" && first !== "dist" && first !== ".git";
}

export async function runLinuxTests(
  versions,
  {
    repositoryRoot = process.cwd(),
    run = spawnSync,
    output = process.stdout,
  } = {},
) {
  let failed = false;
  for (const version of versions) {
    output.write(`\n=== node:${version} on linux ===\n`);
    const temporary = await mkdtemp(join(tmpdir(), "skill-cleaner-linux-"));
    const staged = join(temporary, basename(repositoryRoot));
    let containerId = null;
    try {
      await cp(repositoryRoot, staged, {
        recursive: true,
        filter: (source) => copiedWorktreeFilter(repositoryRoot, source),
      });
      const provisional = linuxContainerCommands(version, staged, "pending");
      const created = run("docker", provisional.create, {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "inherit"],
      });
      containerId = created.status === 0 ? created.stdout.trim() : null;
      if (containerId === null || containerId === "") {
        failed = true;
        continue;
      }
      const commands = linuxContainerCommands(version, staged, containerId);
      const copied = run("docker", commands.copy, { stdio: "inherit" });
      if (copied.status !== 0) {
        failed = true;
        continue;
      }
      const started = run("docker", commands.start, { stdio: "inherit" });
      if (started.status !== 0) failed = true;
    } finally {
      if (containerId !== null && containerId !== "")
        run(
          "docker",
          linuxContainerCommands(version, staged, containerId).remove,
          { stdio: "ignore" },
        );
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}

export function runContainerSuite(run = spawnSync) {
  for (const arguments_ of [["ci", "--silent"], ["test"]]) {
    const result = run("npm", arguments_, { stdio: "inherit" });
    if (result.status !== 0) return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "--container") process.exitCode = runContainerSuite();
  else {
    const versions = process.argv.length > 2 ? process.argv.slice(2) : ["22"];
    process.exitCode = await runLinuxTests(versions);
  }
}
