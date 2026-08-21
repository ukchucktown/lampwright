import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import {
  createExecutionModule,
  createInventoryScanner,
  createQuarantineModule,
  nodeQuarantineFileSystem,
  plan,
  planUpdate,
  type ExecutionProcessRequest,
  type ExecutionProcessRunner,
  type Installation,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
} from "../src/index.js";
import { scanVercelSkills } from "../src/inventory/vercel-skills.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-08-21T00:00:00.000Z");

interface FixtureEnvironment extends InventoryScanEnvironment {
  readonly stateDirectory: string;
  readonly configDirectory: string;
}

function scanEnvironment(environment: {
  readonly home: string;
  readonly workspace: string;
  readonly config: string;
  readonly state: string;
}): FixtureEnvironment {
  return {
    homeDirectory: environment.home,
    workspaceDirectory: environment.workspace,
    configDirectory: environment.config,
    stateDirectory: environment.state,
    nodeVersion: "22.20.0",
  };
}

function commandRunner(
  managerAvailable: boolean,
  worktreeRoot: string | null = null,
): InventoryCommandRunner {
  return {
    async run(command) {
      if (command.executable === "skills")
        return {
          exitCode: managerAvailable ? 0 : null,
          stdout: managerAvailable ? "1.5.22\n" : "",
        };
      if (
        command.executable === "git" &&
        worktreeRoot !== null &&
        command.arguments[2] === "rev-parse"
      )
        return { exitCode: 0, stdout: `${worktreeRoot}\n` };
      if (
        command.executable === "git" &&
        worktreeRoot !== null &&
        command.arguments[2] === "check-ignore"
      )
        return { exitCode: 1, stdout: "" };
      if (command.executable === "fsutil")
        return {
          exitCode: 0,
          stdout: "Reparse Tag Value : 0xa0000003\r\n",
        };
      return { exitCode: 1, stdout: "" };
    },
  };
}

function scanner(
  environment: FixtureEnvironment,
  managerAvailable: boolean,
  worktreeRoot: string | null = null,
) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner: commandRunner(managerAvailable, worktreeRoot),
  });
}

function skillContents(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n\n${marker}\n`;
}

async function writeSkill(
  path: string,
  name: string,
  marker = "v1",
): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), skillContents(name, marker), "utf8");
}

function projectCopyHash(name: string, marker = "v1"): string {
  return createHash("sha256")
    .update("SKILL.md")
    .update(skillContents(name, marker))
    .digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function snapshotTree(
  root: string,
  segments: readonly string[] = [],
): Promise<readonly string[]> {
  const directory = join(root, ...segments);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const childSegments = [...segments, entry.name];
    const relativePath = childSegments.join("/");
    const path = join(root, ...childSegments);
    if (entry.isSymbolicLink()) {
      snapshot.push(`link:${relativePath}:${await readlink(path)}`);
    } else if (entry.isDirectory()) {
      snapshot.push(`directory:${relativePath}`);
      snapshot.push(...(await snapshotTree(root, childSegments)));
    } else {
      snapshot.push(
        `file:${relativePath}:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`,
      );
    }
  }
  return snapshot;
}

function globalLockPath(environment: FixtureEnvironment): string {
  return join(environment.stateDirectory, "skills", ".skill-lock.json");
}

function projectLockPath(environment: FixtureEnvironment): string {
  return join(environment.workspaceDirectory, "skills-lock.json");
}

function globalSkillPath(
  environment: FixtureEnvironment,
  name: string,
): string {
  return join(environment.homeDirectory, ".agents", "skills", name);
}

function projectSkillPath(
  environment: FixtureEnvironment,
  name: string,
): string {
  return join(environment.workspaceDirectory, ".agents", "skills", name);
}

function updateIntent(installation: Installation) {
  return {
    target: {
      kind: "installation" as const,
      installationId: installation.id,
    },
    force: false,
  };
}

function execution(
  inventoryScanner: ReturnType<typeof scanner>,
  environment: FixtureEnvironment,
  processRunner: ExecutionProcessRunner,
) {
  return createExecutionModule({
    scan: () => inventoryScanner.scan({}),
    replan: (inventory, intent) => plan(inventory, intent),
    replanUpdate: (inventory, intent) => planUpdate(inventory, intent),
    quarantine: createQuarantineModule({
      stateRoot: join(environment.stateDirectory, "lampwright"),
      now: () => fixedTime,
      createId: () => "unused-update-quarantine",
      fileSystem: nodeQuarantineFileSystem,
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
    }),
    processRunner,
    inspectGitProtection: async () => ({ kind: "outside-worktree" }),
    auditWriter: { write: vi.fn(async () => undefined) },
    updateAuditWriter: { write: vi.fn(async () => undefined) },
    packageTrustStore: {
      isTrusted: vi.fn(async () => false),
      trust: vi.fn(async () => undefined),
    },
    now: () => fixedTime,
    stateRoot: join(environment.stateDirectory, "lampwright"),
  });
}

async function globalFixture(managerAvailable: boolean, name = "review-tools") {
  const fixture = await createTestEnvironment();
  const environment = scanEnvironment(fixture);
  const skillPath = globalSkillPath(environment, name);
  const lockPath = globalLockPath(environment);
  await writeSkill(skillPath, name);
  await writeJson(lockPath, {
    version: 3,
    skills: {
      [name]: {
        source: "acme/review-tools",
        sourceType: "github",
        sourceUrl: "https://github.com/acme/review-tools.git",
        skillPath: `skills/${name}/SKILL.md`,
        skillFolderHash: "old-source-tree",
        ref: "main",
      },
    },
  });
  const inventoryScanner = scanner(environment, managerAvailable);
  const inventory = await inventoryScanner.scan({});
  return {
    environment,
    inventoryScanner,
    inventory,
    installation: inventory.installations[0]!,
    lockPath,
    skillPath,
  };
}

describe("Vercel Managed Update evidence", () => {
  it("keeps scan, Planning, and CLI dry-run at zero footprint without an Owner request", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const name = "dry-run-skill";
    await writeSkill(globalSkillPath(environment, name), name);
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        [name]: {
          source: "acme/dry-run-skill",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/dry-run-skill.git",
          skillPath: `skills/${name}/SKILL.md`,
          skillFolderHash: "source-tree-v1",
        },
      },
    });
    const localCommands = commandRunner(true);
    const run = vi.fn((command) => localCommands.run(command));
    const inventoryScanner = createInventoryScanner({
      now: () => fixedTime,
      environment,
      commandRunner: { run },
    });
    const beforeScan = await snapshotTree(fixture.root);
    const initial = await inventoryScanner.scan({});
    expect(await snapshotTree(fixture.root)).toEqual(beforeScan);
    const before = await snapshotTree(fixture.root);

    const output = await runCli(
      [
        "update",
        `installation:${initial.installations[0]!.id}`,
        "--dry-run",
        "--json",
      ],
      { scan: () => inventoryScanner.scan({}) },
    );

    expect(output).toMatchObject({
      exitCode: 0,
      output: { kind: "update-plan", plan: { actions: [{}] } },
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);
    expect(run).not.toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.arrayContaining(["update"]),
      }),
    );
  });

  it("plans one global direct Update with exact argv and complete local evidence", async () => {
    const value = await globalFixture(true);
    const operation =
      value.installation.update.kind === "managed"
        ? value.installation.update.operation
        : null;
    expect(operation).toMatchObject({
      operationId: "update-global-skill",
      externalId: "review-tools",
      source: {
        id: "acme/review-tools",
        url: "https://github.com/acme/review-tools.git",
      },
      ref: "main",
      scope: { kind: "user" },
      owner: {
        kind: "manager",
        managerId: "vercel-skills",
        confidence: "declared",
      },
      invocation: {
        kind: "direct",
        command: {
          executable: "skills",
          arguments: ["update", "review-tools", "--global", "--yes"],
        },
        workingDirectory: { kind: "isolated-temporary" },
      },
      localChanges: { kind: "unavailable" },
    });
    expect(operation?.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mutation-root",
          path: value.skillPath,
          exists: true,
        }),
        expect.objectContaining({
          kind: "configuration-path",
          path: value.lockPath,
          exists: true,
        }),
        expect.objectContaining({
          kind: "mutation-root",
          path: join(
            value.environment.homeDirectory,
            "agent",
            "skills",
            "review-tools",
          ),
          exists: false,
        }),
      ]),
    );
    expect(operation?.verifications).not.toContainEqual(
      expect.objectContaining({
        kind: "path-present",
        path: join(
          value.environment.homeDirectory,
          "agent",
          "skills",
          "review-tools",
        ),
      }),
    );
    expect(operation?.currentRevision).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "owner-value",
          recordPointer: "/skills/review-tools/skillFolderHash",
          value: "old-source-tree",
        }),
        expect.objectContaining({
          kind: "content-hash",
          path: value.skillPath,
        }),
      ]),
    );

    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    expect(planned.blocks).toEqual([]);
    expect(planned.actions).toHaveLength(1);
    expect(planned.warnings.map((warning) => warning.kind)).toEqual([
      "network-access",
      "local-change-unavailable",
    ]);
  });

  it("plans project Update in the exact workspace and proves unchanged content", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const name = "project-helper";
    const skillPath = projectSkillPath(environment, name);
    const lockPath = projectLockPath(environment);
    await writeSkill(skillPath, name);
    await writeJson(lockPath, {
      version: 1,
      skills: {
        [name]: {
          source: "acme/project-skills",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/project-skills.git",
          skillPath: `skills/${name}/SKILL.md`,
          computedHash: projectCopyHash(name),
          ref: "release",
          subagents: ["reviewer"],
        },
      },
    });

    const inventoryScanner = scanner(environment, true);
    const inventory = await inventoryScanner.scan({});
    const installation = inventory.installations[0]!;
    expect(installation.update).toMatchObject({
      kind: "managed",
      operation: {
        invocation: {
          kind: "direct",
          command: {
            executable: "skills",
            arguments: ["update", name, "--project", "--yes"],
          },
          workingDirectory: {
            kind: "exact",
            path: environment.workspaceDirectory,
          },
        },
        localChanges: { kind: "unchanged", path: skillPath },
        currentRevision: expect.arrayContaining([
          expect.objectContaining({
            kind: "owner-value",
            recordPointer: `/skills/${name}/computedHash`,
          }),
        ]),
      },
    });
    if (installation.update.kind !== "managed")
      throw new Error("expected project Update evidence");
    const absentSubagent = join(
      environment.workspaceDirectory,
      "agent",
      "subagents",
      "reviewer",
      "skills",
      name,
    );
    expect(installation.update.operation.effects).toContainEqual(
      expect.objectContaining({
        kind: "mutation-root",
        path: absentSubagent,
        exists: false,
      }),
    );
    expect(installation.update.operation.verifications).not.toContainEqual(
      expect.objectContaining({
        kind: "path-present",
        path: absentSubagent,
      }),
    );
    const planned = planUpdate(inventory, updateIntent(installation));
    expect(planned.blocks).toEqual([]);
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toEqual({
        command: {
          executable: "skills",
          arguments: ["update", name, "--project", "--yes"],
        },
        cwd: environment.workspaceDirectory,
        environment: {
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
        },
      });
      await writeSkill(skillPath, name, "v2");
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        skills: Record<string, Record<string, unknown>>;
      };
      lock.skills[name]!.computedHash = projectCopyHash(name, "v2");
      await writeJson(lockPath, lock);
      return { exitCode: 0, stdout: "updated", stderr: "" };
    });
    const report = await execution(inventoryScanner, environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(report.targetResults[0].status).toBe("updated");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("withholds authority from a well-known record with a malformed source URL", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const name = "well-known-skill";
    await writeSkill(globalSkillPath(environment, name), name);
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        [name]: {
          source: "skills.example.test",
          sourceType: "well-known",
          sourceBaseUrl: "not a URL",
          skillPath: name,
          wellKnownDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    });
    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations[0]!.update).toEqual({
      kind: "unresolved",
      reason: "the global well-known source is missing its update URL",
    });

    const nodeModulesName = "package-skill";
    await writeSkill(
      globalSkillPath(environment, nodeModulesName),
      nodeModulesName,
    );
    const lock = JSON.parse(
      await readFile(globalLockPath(environment), "utf8"),
    ) as { skills: Record<string, Record<string, unknown>> };
    lock.skills[nodeModulesName] = {
      source: "fixture-package",
      sourceType: "node_modules",
      skillPath: nodeModulesName,
      skillFolderHash: "synthetic-source-tree",
    };
    await writeJson(globalLockPath(environment), lock);
    const rescanned = await scanner(environment, true).scan({});
    expect(
      rescanned.installations.find(
        (installation) => installation.skill.name === nodeModulesName,
      )?.update,
    ).toEqual({
      kind: "unresolved",
      reason:
        "Vercel node_modules sources do not have a supported in-place Update",
    });
  });

  it("uses only the exact pinned global npx envelope when skills is absent", async () => {
    const value = await globalFixture(false);
    expect(value.installation.update).toMatchObject({
      kind: "managed",
      operation: {
        availability: { kind: "available" },
        invocation: {
          kind: "ephemeral-package",
          packageExecution: {
            runner: "npx",
            packageName: "skills",
            packageVersion: "1.5.22",
            mayDownload: true,
            adapterHash: expect.stringMatching(/^[a-f\d]{64}$/),
          },
          packageArguments: ["update", "review-tools", "--global", "--yes"],
          workingDirectory: { kind: "isolated-temporary" },
        },
        packageDownload: {
          kind: "possible",
          packageName: "skills",
          packageVersion: "1.5.22",
        },
      },
    });
    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    expect(planned.actions[0]?.approvals).toEqual([
      { kind: "confirmation" },
      expect.objectContaining({
        kind: "package-trust",
        runner: "npx",
        packageName: "skills",
        packageVersion: "1.5.22",
      }),
    ]);

    const projectFixture = await createTestEnvironment();
    const projectEnvironment = scanEnvironment(projectFixture);
    const name = "project-only";
    await writeSkill(projectSkillPath(projectEnvironment, name), name);
    await writeJson(projectLockPath(projectEnvironment), {
      version: 1,
      skills: {
        [name]: {
          source: "acme/project-only",
          sourceType: "github",
          skillPath: name,
          computedHash: projectCopyHash(name),
        },
      },
    });
    const projectInventory = await scanner(projectEnvironment, false).scan({});
    const projectUpdate = projectInventory.installations[0]!.update;
    expect(projectUpdate).toMatchObject({
      kind: "managed",
      operation: {
        availability: {
          kind: "unavailable",
          reason: "project Update requires an installed skills manager",
        },
        invocation: { kind: "direct" },
      },
    });
    expect(
      planUpdate(
        projectInventory,
        updateIntent(projectInventory.installations[0]!),
      ).actions,
    ).toEqual([]);
  });

  it("executes the approved global npx command with exact trust and argv", async () => {
    const value = await globalFixture(false);
    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toEqual({
        command: {
          executable: "npx",
          arguments: [
            "--yes",
            "skills@1.5.22",
            "update",
            "review-tools",
            "--global",
            "--yes",
          ],
        },
        cwd: expect.stringContaining("lampwright-execution-"),
        environment: {
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
          npm_config_cache: join(
            value.environment.stateDirectory,
            "lampwright",
            "execution",
            "v1",
            "npm-cache",
          ),
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
          npm_config_global: "false",
          npm_config_save: "false",
          npm_config_package_lock: "false",
        },
      });
      return { exitCode: 0, stdout: "unchanged", stderr: "" };
    });
    const report = await execution(value.inventoryScanner, value.environment, {
      run,
    }).executeUpdate(planned, {
      grants: planned.actions[0]!.approvals,
    });
    expect(report.targetResults[0].status).toBe("unchanged");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("Vercel Managed Update execution", () => {
  it("reports unresolved when changed project content keeps a stale computedHash", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const name = "stale-project-revision";
    const skillPath = projectSkillPath(environment, name);
    const lockPath = projectLockPath(environment);
    await writeSkill(skillPath, name);
    await writeJson(lockPath, {
      version: 1,
      skills: {
        [name]: {
          source: "acme/stale-project-revision",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/stale-project-revision.git",
          skillPath: name,
          computedHash: projectCopyHash(name),
        },
      },
    });
    const inventoryScanner = scanner(environment, true);
    const inventory = await inventoryScanner.scan({});
    const planned = planUpdate(
      inventory,
      updateIntent(inventory.installations[0]!),
    );
    const run = vi.fn(async () => {
      await writeSkill(skillPath, name, "v2");
      return { exitCode: 0, stdout: "updated", stderr: "" };
    });
    const report = await execution(inventoryScanner, environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.targetResults[0].status).toBe("unresolved");
    expect(report.verificationResults).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          message: "final content does not match the Owner's recorded revision",
        }),
      }),
    );
  });

  it("reports updated after the Manager changes content and the lock revision", async () => {
    const value = await globalFixture(true);
    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    let isolatedDirectory: string | undefined;
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toEqual({
        command: {
          executable: "skills",
          arguments: ["update", "review-tools", "--global", "--yes"],
        },
        cwd: expect.stringContaining("lampwright-owner-"),
        environment: {
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
        },
      });
      expect(request.cwd).not.toBe(value.environment.workspaceDirectory);
      isolatedDirectory = request.cwd;
      await writeSkill(value.skillPath, "review-tools", "v2");
      const lock = JSON.parse(await readFile(value.lockPath, "utf8")) as {
        skills: Record<string, Record<string, unknown>>;
      };
      lock.skills["review-tools"]!.skillFolderHash = "new-source-tree";
      await writeJson(value.lockPath, lock);
      return { exitCode: 0, stdout: "updated", stderr: "" };
    });

    const report = await execution(value.inventoryScanner, value.environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(report.status).toBe("succeeded");
    expect(report.targetResults[0].status).toBe("updated");
    expect(run).toHaveBeenCalledTimes(1);
    expect(isolatedDirectory).toBeTypeOf("string");
    await expect(lstat(isolatedDirectory!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports unchanged without claiming the remote source is current", async () => {
    const value = await globalFixture(true);
    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: "nothing changed",
      stderr: "",
    }));
    const report = await execution(value.inventoryScanner, value.environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(report.status).toBe("succeeded");
    expect(report.targetResults[0]).toMatchObject({
      status: "unchanged",
      reason: null,
    });
  });

  it("reports a failed Manager command without any fallback mutation", async () => {
    const value = await globalFixture(true);
    const beforeSkill = await readFile(
      join(value.skillPath, "SKILL.md"),
      "utf8",
    );
    const beforeLock = await readFile(value.lockPath, "utf8");
    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "owner failed",
    }));
    const report = await execution(value.inventoryScanner, value.environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(report.status).toBe("failed");
    expect(report.targetResults[0].status).toBe("failed");
    await expect(
      readFile(join(value.skillPath, "SKILL.md"), "utf8"),
    ).resolves.toBe(beforeSkill);
    await expect(readFile(value.lockPath, "utf8")).resolves.toBe(beforeLock);
  });

  it("rejects a stale plan before process execution and leaves the target untouched", async () => {
    const value = await globalFixture(true);
    const planned = planUpdate(
      value.inventory,
      updateIntent(value.installation),
    );
    const lock = JSON.parse(await readFile(value.lockPath, "utf8")) as {
      skills: Record<string, Record<string, unknown>>;
    };
    lock.skills["review-tools"]!.ref = "changed-after-review";
    await writeJson(value.lockPath, lock);
    const beforeSkill = await readFile(
      join(value.skillPath, "SKILL.md"),
      "utf8",
    );
    const run = vi.fn();
    const report = await execution(value.inventoryScanner, value.environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(report.status).toBe("blocked");
    expect(report.targetResults[0].status).toBe("blocked");
    expect(run).not.toHaveBeenCalled();
    await expect(
      readFile(join(value.skillPath, "SKILL.md"), "utf8"),
    ).resolves.toBe(beforeSkill);
  });
});

describe("Vercel Update safety blocks", () => {
  it("withholds Update authority from an unexpected external link or junction", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const name = "external-topology";
    const external = join(fixture.temporary, "external-topology-target");
    const linked = projectSkillPath(environment, name);
    await writeSkill(external, name);
    await mkdir(dirname(linked), { recursive: true });
    await symlink(
      external,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeJson(projectLockPath(environment), {
      version: 1,
      skills: {
        [name]: {
          source: "acme/external-topology",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/external-topology.git",
          skillPath: name,
          computedHash: projectCopyHash(name),
        },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations[0]).toMatchObject({
      status: "unresolved",
      location: {
        path: linked,
        artifactType: {
          kind: process.platform === "win32" ? "junction" : "symbolic-link",
        },
      },
      update: {
        kind: "unresolved",
        reason: expect.stringContaining("unexpected Vercel-managed link"),
      },
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not traverse an unexpected external project link for Update evidence",
    async () => {
      const fixture = await createTestEnvironment();
      const environment = scanEnvironment(fixture);
      const name = "external-link";
      const external = join(fixture.temporary, "external-target");
      const linked = join(
        environment.workspaceDirectory,
        ".claude",
        "skills",
        name,
      );
      await writeSkill(external, name);
      await mkdir(dirname(linked), { recursive: true });
      await symlink(external, linked, "dir");
      await writeJson(projectLockPath(environment), {
        version: 1,
        skills: {
          [name]: {
            source: "acme/external-link",
            sourceType: "github",
            skillPath: name,
            computedHash: projectCopyHash(name),
          },
        },
      });
      await chmod(external, 0o000);
      try {
        const result = await scanVercelSkills(environment, commandRunner(true));
        expect(result.installations[0]).toMatchObject({
          status: "unresolved",
          update: {
            kind: "unresolved",
            reason: expect.stringContaining("unexpected Vercel-managed link"),
          },
        });
      } finally {
        await chmod(external, 0o700);
      }
    },
  );

  it("blocks collisions, stale records, unsupported locks, and protected project artifacts", async () => {
    const collisionFixture = await createTestEnvironment();
    const collisionEnvironment = scanEnvironment(collisionFixture);
    await writeSkill(globalSkillPath(collisionEnvironment, "a-b"), "a-b");
    await writeJson(globalLockPath(collisionEnvironment), {
      version: 3,
      skills: {
        "A B": {
          source: "acme/one",
          sourceType: "github",
          skillPath: "one",
          skillFolderHash: "one-tree",
        },
        "a-b": {
          source: "acme/two",
          sourceType: "github",
          skillPath: "two",
          skillFolderHash: "two-tree",
        },
      },
    });
    const collisionScanner = scanner(collisionEnvironment, true);
    const collisionInventory = await collisionScanner.scan({});
    const collisionRun = vi.fn();
    for (const installation of collisionInventory.installations) {
      const planned = planUpdate(
        collisionInventory,
        updateIntent(installation),
      );
      expect(planned.actions).toEqual([]);
      expect(planned.blocks).toContainEqual(
        expect.objectContaining({ kind: "unresolved-update" }),
      );
      const report = await execution(collisionScanner, collisionEnvironment, {
        run: collisionRun,
      }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
      expect(report.status).toBe("blocked");
    }
    expect(collisionRun).not.toHaveBeenCalled();

    const staleFixture = await createTestEnvironment();
    const staleEnvironment = scanEnvironment(staleFixture);
    await writeJson(globalLockPath(staleEnvironment), {
      version: 3,
      skills: {
        stale: {
          source: "acme/stale",
          sourceType: "github",
          skillPath: "stale",
          skillFolderHash: "stale-tree",
        },
      },
    });
    const staleScanner = scanner(staleEnvironment, true);
    const staleInventory = await staleScanner.scan({});
    expect(staleInventory.installations[0]!.update.kind).toBe("unresolved");
    const stalePlan = planUpdate(
      staleInventory,
      updateIntent(staleInventory.installations[0]!),
    );
    const staleRun = vi.fn();
    const staleReport = await execution(staleScanner, staleEnvironment, {
      run: staleRun,
    }).executeUpdate(stalePlan, { grants: [{ kind: "confirmation" }] });
    expect(staleReport.status).toBe("blocked");
    expect(staleRun).not.toHaveBeenCalled();

    const legacyFixture = await createTestEnvironment();
    const legacyEnvironment = scanEnvironment(legacyFixture);
    await writeSkill(globalSkillPath(legacyEnvironment, "legacy"), "legacy");
    await writeJson(globalLockPath(legacyEnvironment), {
      version: 2,
      skills: {
        legacy: {
          source: "acme/legacy",
          sourceType: "github",
          skillPath: "legacy",
          skillFolderHash: "legacy-tree",
        },
      },
    });
    const legacyInventory = await scanner(legacyEnvironment, true).scan({});
    expect(
      planUpdate(
        legacyInventory,
        updateIntent(legacyInventory.installations[0]!),
      ).blocks,
    ).toContainEqual(
      expect.objectContaining({ kind: "operation-unavailable" }),
    );

    const protectedFixture = await createTestEnvironment();
    const protectedEnvironment = scanEnvironment(protectedFixture);
    const protectedName = "protected-project";
    await writeSkill(
      projectSkillPath(protectedEnvironment, protectedName),
      protectedName,
    );
    await writeJson(projectLockPath(protectedEnvironment), {
      version: 1,
      skills: {
        [protectedName]: {
          source: "acme/protected",
          sourceType: "github",
          skillPath: protectedName,
          computedHash: projectCopyHash(protectedName),
        },
      },
    });
    const protectedScanner = scanner(
      protectedEnvironment,
      true,
      protectedEnvironment.workspaceDirectory,
    );
    const protectedInventory = await protectedScanner.scan({});
    const protectedPlan = planUpdate(
      protectedInventory,
      updateIntent(protectedInventory.installations[0]!),
    );
    expect(protectedPlan.actions).toEqual([]);
    expect(protectedPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "git-protection" }),
    );
    const protectedRun = vi.fn();
    const protectedReport = await execution(
      protectedScanner,
      protectedEnvironment,
      { run: protectedRun },
    ).executeUpdate(protectedPlan, { grants: [{ kind: "confirmation" }] });
    expect(protectedReport.status).toBe("blocked");
    expect(protectedRun).not.toHaveBeenCalled();
  });

  it("does not invoke the Owner when project content has proven local changes", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const name = "locally-changed";
    const skillPath = projectSkillPath(environment, name);
    const lockPath = projectLockPath(environment);
    await writeSkill(skillPath, name);
    await writeJson(lockPath, {
      version: 1,
      skills: {
        [name]: {
          source: "acme/changed",
          sourceType: "github",
          skillPath: name,
          computedHash: "a".repeat(64),
        },
      },
    });
    const inventoryScanner = scanner(environment, true);
    const inventory = await inventoryScanner.scan({});
    const planned = planUpdate(
      inventory,
      updateIntent(inventory.installations[0]!),
    );
    expect(planned.blocks).toContainEqual(
      expect.objectContaining({ kind: "local-changes", path: skillPath }),
    );
    const beforeSkill = await readFile(join(skillPath, "SKILL.md"), "utf8");
    const beforeLock = await readFile(lockPath, "utf8");
    const run = vi.fn();
    const report = await execution(inventoryScanner, environment, {
      run,
    }).executeUpdate(planned, { grants: [{ kind: "confirmation" }] });
    expect(report.status).toBe("blocked");
    expect(run).not.toHaveBeenCalled();
    await expect(readFile(join(skillPath, "SKILL.md"), "utf8")).resolves.toBe(
      beforeSkill,
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe(beforeLock);
  });
});
