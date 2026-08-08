#!/usr/bin/env node
// Runs the suite on Linux in a container, for the platforms hosted CI covers
// when it is available. Copies the worktree in rather than mounting it, so the
// host's platform-specific node_modules are never replaced by Linux builds.

import { spawnSync } from "node:child_process";
import process from "node:process";

const versions =
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["22"];
const script =
  "cp -r /src/. /app && rm -rf node_modules dist && npm ci --silent && npm test";

let failed = false;
for (const version of versions) {
  process.stdout.write(`\n=== node:${version} on linux ===\n`);
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${process.cwd()}:/src:ro`,
      "-w",
      "/app",
      `node:${version}`,
      "bash",
      "-c",
      script,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
