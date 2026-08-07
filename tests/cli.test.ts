import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

interface PackageMetadata {
  readonly version: string;
}

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executablePath = join(repositoryRoot, "dist", "cli.js");
const createTestEnvironment = createIsolatedTestEnvironmentFixture();

async function runBuiltExecutable(...arguments_: string[]): Promise<string> {
  const environment = await createTestEnvironment();

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [executablePath, ...arguments_],
    {
      cwd: environment.workspace,
      env: environment.environmentVariables,
    },
  );

  expect(stderr).toBe("");
  return stdout;
}

describe("the built skill-cleaner executable", () => {
  it("prints help and exits successfully", async () => {
    const output = await runBuiltExecutable("--help");

    expect(output).toContain("Usage:\n  skill-cleaner [options]");
    expect(output).toContain("--version");
  });

  it("prints the package version and exits successfully", async () => {
    const packageMetadata = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as PackageMetadata;

    await expect(runBuiltExecutable("--version")).resolves.toBe(
      `${packageMetadata.version}\n`,
    );
  });
});
