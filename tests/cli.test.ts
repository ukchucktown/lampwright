import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import { formatCliOutput, runCli } from "../src/cli.js";
import type {
  ApprovalRequirement,
  ExecutionReport,
  Inventory,
} from "../src/model/types.js";
import type {
  QuarantineEntry,
  QuarantineModule,
} from "../src/quarantine/types.js";
import {
  buildExecutionReport,
  buildInstallation,
  buildInventory,
  buildPluginBoundary,
} from "../src/testing/index.js";

import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";
import type { IsolatedTestEnvironment } from "./support/isolated-test-environment.js";

interface PackageMetadata {
  readonly version: string;
}

interface ExecutableResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executablePath = join(repositoryRoot, "dist", "cli.js");
const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const adapterHash = "a".repeat(64);

async function runBuiltExecutable(...arguments_: string[]): Promise<string> {
  const environment = await createTestEnvironment();
  const result = await runBuiltExecutableIn(environment, ...arguments_);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

async function runBuiltExecutableIn(
  environment: IsolatedTestEnvironment,
  ...arguments_: string[]
): Promise<ExecutableResult> {
  return runBuiltExecutableWith(
    environment,
    environment.environmentVariables,
    ...arguments_,
  );
}

async function runBuiltExecutableWith(
  environment: IsolatedTestEnvironment,
  environmentVariables: NodeJS.ProcessEnv,
  ...arguments_: string[]
): Promise<ExecutableResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [executablePath, ...arguments_],
      {
        cwd: environment.workspace,
        env: {
          ...environmentVariables,
          PATH: environment.temporary,
          Path: environment.temporary,
        },
      },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return {
        exitCode: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
    throw error;
  }
}

async function writeSideEffectingGeminiExecutable(
  environment: IsolatedTestEnvironment,
): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(
      join(environment.temporary, "gemini.cmd"),
      '@echo invoked>"%USERPROFILE%\\manager-invoked"\r\n@echo 1.0.0\r\n',
      "utf8",
    );
    return;
  }
  const executable = join(environment.temporary, "gemini");
  await writeFile(
    executable,
    '#!/bin/sh\nprintf invoked > "$HOME/manager-invoked"\nprintf "1.0.0\\n"\n',
    "utf8",
  );
  await chmod(executable, 0o755);
}

function successfulReport(plan: {
  readonly id: string;
  readonly inventoryId: string;
}): ExecutionReport {
  return buildExecutionReport({
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: plan.inventoryId,
  });
}

function entry(): QuarantineEntry {
  const path = join(repositoryRoot, "fixtures", "quarantined-skill");
  return {
    schemaVersion: 1,
    id: "entry-1" as never,
    kind: "displaced-artifact",
    createdAt: "2026-01-01T00:00:00.000Z",
    removedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-31T00:00:00.000Z",
    originalLocation: {
      path,
      canonicalPath: path,
      artifactType: { kind: "directory" },
    },
    integrity: { algorithm: "sha256", digest: "b".repeat(64) },
    provenance: {
      actionId: "action-1" as never,
      targets: [
        { kind: "installation", installationId: "installation-1" as never },
      ],
      affectedInstallationIds: ["installation-1" as never],
      subjects: [
        {
          installationIds: ["installation-1" as never],
          ownership: { kind: "filesystem", confidence: "declared" },
          adapterId: "fixture-adapter",
          source: null,
          plugin: null,
          manager: null,
        },
      ],
    },
    restoration: { mode: null, modifiedAt: null },
  };
}

function quarantineFixture(entries: readonly QuarantineEntry[] = [entry()]): {
  readonly module: QuarantineModule;
  readonly restore: ReturnType<typeof vi.fn>;
  readonly purge: ReturnType<typeof vi.fn>;
  readonly previewRestore: ReturnType<typeof vi.fn>;
  readonly previewPurge: ReturnType<typeof vi.fn>;
} {
  const previewRestore = vi.fn(async (selected: QuarantineEntry) => ({
    schemaVersion: 1 as const,
    status: "would-restore" as const,
    entryId: selected.id,
    destination: selected.originalLocation.path,
  }));
  const previewPurge = vi.fn(async () => ({
    schemaVersion: 1 as const,
    entries: entries.map((selected) => ({
      entryId: selected.id,
      status: "would-purge" as const,
    })),
  }));
  const restore = vi.fn(async (selected: QuarantineEntry) => ({
    status: "restored" as const,
    entryId: selected.id,
    destination: selected.originalLocation.path,
    restoredAt: "2026-01-02T00:00:00.000Z",
  }));
  const purge = vi.fn(async () => ({
    purgedAt: "2026-01-02T00:00:00.000Z",
    entries: entries.map((selected) => ({
      entryId: selected.id,
      status: "purged" as const,
    })),
  }));
  return {
    restore,
    purge,
    previewRestore,
    previewPurge,
    module: {
      list: vi.fn(async () => entries),
      listOperations: vi.fn(async () => []),
      quarantine: vi.fn(),
      restore,
      previewRestore,
      purge,
      previewPurge,
      previewRestoreOperation: vi.fn(),
      restoreOperation: vi.fn(),
      previewPurgeOperation: vi.fn(),
      purgeOperation: vi.fn(),
    },
  };
}

function ephemeralInventory(): Inventory {
  const installation = buildInstallation({
    manager: { id: "fixture-manager" },
    ownership: {
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    },
    removal: {
      managed: {
        adapterId: "fixture-adapter",
        operationId: "remove",
        availability: { kind: "available" },
        trust: { kind: "trusted" },
        externalId: "fixture-skill",
        invocation: {
          kind: "ephemeral-package",
          packageExecution: {
            runner: "npx",
            packageName: "@fixture/manager",
            packageVersion: "1.2.3",
            adapterHash,
            mayDownload: true,
          },
          packageArguments: ["remove", "fixture-skill"],
        },
        effects: [],
        verifications: [],
      },
      fallback: {
        kind: "available",
        requiresSeparateConfirmation: true,
      },
      recordCleanups: [],
    },
  });
  return buildInventory({ installations: [installation] });
}

describe("the non-interactive CLI", () => {
  it("resolves source selectors through Planning and returns the complete dry-run plan without execution", async () => {
    const inventory = buildInventory({
      installations: [
        buildInstallation({ source: { id: "fixture-source", url: null } }),
      ],
    });
    const execute = vi.fn();

    const result = await runCli(
      ["remove", "source:fixture-source", "--dry-run"],
      { scan: async () => inventory, execute },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: 1,
      kind: "removal-plan",
      plan: {
        targets: [{ kind: "installation", installationId: "installation-1" }],
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes force and explicit Plugin inclusion unchanged to the planner", async () => {
    const inventory = buildInventory({ plugins: [buildPluginBoundary()] });

    const result = await runCli(
      ["remove", "--all", "--include-plugins", "--force", "--dry-run"],
      { scan: async () => inventory },
    );

    expect(result.output).toMatchObject({
      kind: "removal-plan",
      plan: {
        intent: {
          kind: "all",
          includePlugins: true,
          force: true,
          mode: "managed-first",
        },
        targets: expect.arrayContaining([
          { kind: "plugin", pluginBoundaryId: "fixture-plugin" },
        ]),
      },
    });
  });

  it("requires explicit package trust in addition to --yes and accepts scoped exact package grants", async () => {
    const inventory = ephemeralInventory();
    const calls: (readonly ApprovalRequirement[])[] = [];
    const execute = vi.fn(
      async (plan, approvals: readonly ApprovalRequirement[]) => {
        calls.push(approvals);
        return successfulReport(plan);
      },
    );

    await runCli(["remove", "installation:installation-1", "--yes"], {
      scan: async () => inventory,
      execute,
    });
    await runCli(
      [
        "remove",
        "installation:installation-1",
        "--yes",
        "--trust-package",
        `npx:@fixture/manager@1.2.3:${adapterHash}`,
      ],
      { scan: async () => inventory, execute },
    );

    expect(calls[0]).toEqual([{ kind: "confirmation" }]);
    expect(calls[1]).toEqual([
      { kind: "confirmation" },
      {
        kind: "package-trust",
        runner: "npx",
        packageName: "@fixture/manager",
        packageVersion: "1.2.3",
        adapterHash,
      },
    ]);
  });

  it("previews every Quarantine mutation and does not call mutating methods during dry runs", async () => {
    const fixture = quarantineFixture();

    const restore = await runCli(["restore", "entry-1", "--dry-run"], {
      quarantine: fixture.module,
    });
    const purge = await runCli(["purge", "entry-1", "--dry-run"], {
      quarantine: fixture.module,
    });

    expect(restore).toMatchObject({
      exitCode: 0,
      output: {
        kind: "quarantine-plan",
        command: "restore",
        missingEntryIds: [],
        preview: { status: "would-restore" },
      },
    });
    expect(purge).toMatchObject({
      exitCode: 0,
      output: {
        kind: "quarantine-plan",
        command: "purge",
        missingEntryIds: [],
        preview: { entries: [{ status: "would-purge" }] },
      },
    });
    expect(fixture.previewRestore).toHaveBeenCalledOnce();
    expect(fixture.previewPurge).toHaveBeenCalledOnce();
    expect(fixture.restore).not.toHaveBeenCalled();
    expect(fixture.purge).not.toHaveBeenCalled();
  });

  it("does not let --yes bypass a blocked Quarantine preview", async () => {
    const fixture = quarantineFixture();
    fixture.previewRestore.mockResolvedValue({
      schemaVersion: 1,
      status: "blocked",
      entryId: "entry-1",
      reason: "git-protected",
      path: entry().originalLocation.path,
    });

    const result = await runCli(["restore", "entry-1", "--yes"], {
      quarantine: fixture.module,
    });

    expect(result).toMatchObject({
      exitCode: 3,
      output: {
        kind: "quarantine-plan",
        preview: { status: "blocked", reason: "git-protected" },
      },
    });
    expect(fixture.restore).not.toHaveBeenCalled();
  });

  it("uses stable, documented exit statuses for usage, confirmation, blocks, and execution failures", async () => {
    const inventory = buildInventory();
    const fixture = quarantineFixture([]);

    await expect(
      runCli(["remove", "--include-plugins"]),
    ).resolves.toMatchObject({ exitCode: 2, output: { kind: "error" } });
    await expect(
      runCli(["remove", "unknown:installation-1", "--dry-run"], {
        scan: async () => inventory,
      }),
    ).resolves.toMatchObject({ exitCode: 2, output: { kind: "error" } });
    await expect(
      runCli(["remove", "installation:missing", "--dry-run"], {
        scan: async () => inventory,
      }),
    ).resolves.toMatchObject({ exitCode: 3, output: { kind: "error" } });
    await expect(
      runCli(["remove", "installation:installation-1"], {
        scan: async () => inventory,
      }),
    ).resolves.toMatchObject({
      exitCode: 3,
      output: { kind: "confirmation-required" },
    });
    await expect(
      runCli(["restore", "missing", "--dry-run"], {
        quarantine: fixture.module,
      }),
    ).resolves.toMatchObject({
      exitCode: 3,
      output: { kind: "quarantine-plan", missingEntryIds: ["missing"] },
    });
    await expect(
      runCli(
        ["remove", "installation:installation-1", "--brute-force", "--yes"],
        {
          scan: async () => inventory,
          execute: async (plan) =>
            buildExecutionReport({
              planId: plan.id,
              inventoryId: plan.inventoryId,
              finalInventoryId: plan.inventoryId,
              status: "failed",
              actionResults: [
                {
                  actionId: plan.actions[0]!.id,
                  startedAt: "2026-01-01T00:02:00.000Z",
                  completedAt: "2026-01-01T00:03:00.000Z",
                  status: "failed",
                  error: {
                    code: "fixture-failed",
                    message: "fixture failed",
                    details: {},
                  },
                },
              ],
            }),
        },
      ),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("rejects command-specific options that would otherwise be ignored", async () => {
    await expect(
      runCli(["scan", "--trust-package", `npx:fixture@1.2.3:${adapterHash}`]),
    ).resolves.toMatchObject({ exitCode: 2 });
    await expect(
      runCli([
        "restore",
        "entry-1",
        "--trust-adapter",
        `fixture:${adapterHash}`,
      ]),
    ).resolves.toMatchObject({ exitCode: 2 });
    await expect(runCli(["--version", "extra"])).resolves.toMatchObject({
      exitCode: 2,
    });
  });

  it("validates every public output family against the published v1 schema", async () => {
    const schema = JSON.parse(
      await readFile(
        join(repositoryRoot, "schemas", "cli-v1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      schema,
    );
    const inventory = buildInventory();
    const fixture = quarantineFixture();
    const execute = async (plan: {
      readonly id: string;
      readonly inventoryId: string;
    }): Promise<ExecutionReport> => successfulReport(plan);
    const outputs = await Promise.all([
      runCli(["scan"], { scan: async () => inventory }),
      runCli(["remove", "installation:installation-1", "--dry-run"], {
        scan: async () => inventory,
      }),
      runCli(["remove", "installation:installation-1"], {
        scan: async () => inventory,
      }),
      runCli(
        ["remove", "installation:installation-1", "--brute-force", "--yes"],
        { scan: async () => inventory, execute },
      ),
      runCli(["restore", "entry-1", "--dry-run"], {
        quarantine: fixture.module,
      }),
      runCli(["purge", "entry-1"], { quarantine: fixture.module }),
      runCli(["restore", "entry-1", "--yes"], {
        quarantine: fixture.module,
      }),
      runCli(["purge", "entry-1", "--yes"], {
        quarantine: fixture.module,
      }),
      runCli(["unknown"]),
    ]);
    outputs.push({
      exitCode: 3,
      output: {
        schemaVersion: 1,
        kind: "trust-required",
        requirements: [
          {
            adapterId: "fixture.command",
            contentHash: adapterHash,
            path: join(repositoryRoot, "fixture.jsonc"),
          },
        ],
      },
    });

    for (const { output } of outputs) {
      expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("snapshot-tests deterministic JSON and renders actionable human blocks", async () => {
    const missing = await runCli(["restore", "missing", "--dry-run"], {
      quarantine: quarantineFixture([]).module,
    });
    const json = formatCliOutput(missing.output, true);

    expect(json).toMatchInlineSnapshot(`
      "{
        "command": "restore",
        "entries": [],
        "kind": "quarantine-plan",
        "missingEntryIds": [
          "missing"
        ],
        "preview": null,
        "schemaVersion": 1
      }
      "
    `);
    expect(formatCliOutput(missing.output, true)).toBe(json);

    const protectedInventory = buildInventory({
      installations: [
        buildInstallation({
          protection: {
            git: { kind: "protected", worktreeRoot: repositoryRoot },
            system: { kind: "none" },
            filesystem: { kind: "writable" },
          },
        }),
      ],
    });
    const blocked = await runCli(
      ["remove", "installation:installation-1", "--dry-run"],
      { scan: async () => protectedInventory },
    );
    const human = formatCliOutput(blocked.output, false);
    const execute = vi.fn();
    const forced = await runCli(
      ["remove", "installation:installation-1", "--force", "--yes"],
      { scan: async () => protectedInventory, execute },
    );

    expect(human).toContain("git-protection");
    expect(human).toContain("not overridable");
    expect(human).toContain("Resolve the blocks");
    expect(forced.exitCode).toBe(3);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not let --yes grant local adapter trust and keeps scan trust read-only", async () => {
    const environment = await createTestEnvironment();
    const adapterPath = join(environment.temporary, "command.jsonc");
    const definition = {
      schemaVersion: 1,
      id: "fixture.command",
      name: "Fixture command adapter",
      platforms: ["darwin", "linux", "win32"],
      actions: [
        {
          id: "remove",
          kind: "managed",
          ownerKind: "manager",
          operationId: "remove",
          command: {
            default: { executable: "fixture-manager", arguments: [] },
          },
        },
      ],
    };
    const content = `${JSON.stringify(definition, null, 2)}\n`;
    const contentHash = createHash("sha256").update(content).digest("hex");
    await writeFile(adapterPath, content, "utf8");
    const before = await readdir(environment.state);

    const required = await runBuiltExecutableIn(
      environment,
      "remove",
      "--all",
      "--yes",
      "--adapter",
      adapterPath,
      "--json",
    );

    expect(required.exitCode).toBe(3);
    expect(required.stderr).toBe("");
    expect(JSON.parse(required.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: "trust-required",
      requirements: [
        { adapterId: "fixture.command", contentHash, path: adapterPath },
      ],
    });
    expect(await readdir(environment.state)).toEqual(before);

    const scan = await runBuiltExecutableIn(
      environment,
      "scan",
      "--adapter",
      adapterPath,
      "--trust-adapter",
      `fixture.command:${contentHash}`,
      "--json",
    );

    expect(scan.exitCode).toBe(0);
    expect(JSON.parse(scan.stdout)).toMatchObject({ schemaVersion: 1 });
    expect(await readdir(environment.state)).toEqual(before);
  });
});

describe("the built lampwright executable", () => {
  it("detects Gemini without invoking it during a read-only scan", async () => {
    const environment = await createTestEnvironment();
    const skillRoot = join(
      environment.home,
      ".gemini",
      "skills",
      "review-tools",
    );
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: review-tools\ndescription: Review changes\n---\n",
      "utf8",
    );
    await writeSideEffectingGeminiExecutable(environment);

    const result = await runBuiltExecutableWith(
      environment,
      {
        ...environment.environmentVariables,
        ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {}),
      },
      "scan",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    const inventory = JSON.parse(result.stdout) as Inventory;
    expect(
      inventory.installations.find(
        (candidate) => candidate.location.path === skillRoot,
      )?.removal.managed,
    ).toMatchObject({ availability: { kind: "available" } });
    expect(await readdir(environment.home)).toEqual([".gemini"]);
  });

  it("reads the Vercel global lock from the home-relative location when XDG_STATE_HOME is unset", async () => {
    const environment = await createTestEnvironment();
    const canonical = join(
      environment.home,
      ".agents",
      "skills",
      "review-tools",
    );
    await mkdir(canonical, { recursive: true });
    await writeFile(
      join(canonical, "SKILL.md"),
      "---\nname: review-tools\ndescription: Review changes\n---\n",
      "utf8",
    );
    await writeFile(
      join(environment.home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          "review-tools": {
            source: "acme/review-tools",
            sourceType: "github",
            sourceUrl: "https://github.com/acme/review-tools.git",
            skillPath: "skills/review-tools",
          },
        },
      }),
      "utf8",
    );

    const withoutStateHome = { ...environment.environmentVariables };
    delete withoutStateHome.XDG_STATE_HOME;
    const result = await runBuiltExecutableWith(
      environment,
      withoutStateHome,
      "scan",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    const inventory = JSON.parse(result.stdout) as Inventory;
    const installation = inventory.installations.find(
      (candidate) => candidate.location.path === canonical,
    );
    expect(installation).toMatchObject({
      manager: { id: "vercel-skills" },
      adapterId: "vercel.skills",
      source: {
        id: "acme/review-tools",
        url: "https://github.com/acme/review-tools.git",
      },
      ownership: { kind: "manager", managerId: "vercel-skills" },
    });
    expect(await readdir(environment.state)).toEqual([]);
  });

  it("prints help and exits successfully", async () => {
    const output = await runBuiltExecutable("--help");

    expect(output).toContain("Usage:\n  lampwright\n  lampwright scan");
    expect(output).toContain("--trust-adapter");
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

  it.skipIf(process.platform === "win32")(
    "runs through the symlink created for a package executable",
    async () => {
      const environment = await createTestEnvironment();
      const packageExecutable = join(
        environment.temporary,
        "lampwright-package-bin",
      );
      await symlink(executablePath, packageExecutable, "file");
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        packageExecutable,
        "--version",
      ]);
      const packageMetadata = JSON.parse(
        await readFile(join(repositoryRoot, "package.json"), "utf8"),
      ) as PackageMetadata;

      expect(stderr).toBe("");
      expect(stdout).toBe(`${packageMetadata.version}\n`);
    },
  );
});
