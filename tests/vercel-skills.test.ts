import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  createInventoryScanner,
  createQuarantineModule,
  nodeQuarantineFileSystem,
  plan,
  type ExecutionProcessRequest,
  type Installation,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
  type RemovalTarget,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-08-06T00:00:00.000Z");

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

function commandRunner(managerAvailable: boolean): InventoryCommandRunner {
  return {
    async run(command) {
      if (command.executable === "skills") {
        return {
          exitCode: managerAvailable ? 0 : null,
          stdout: managerAvailable ? "1.5.22\n" : "",
        };
      }
      if (command.executable === "fsutil") {
        return {
          exitCode: 0,
          stdout: "Reparse Tag Value : 0xa0000003\r\n",
        };
      }
      return { exitCode: 1, stdout: "" };
    },
  };
}

function scanner(environment: FixtureEnvironment, managerAvailable: boolean) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner: commandRunner(managerAvailable),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSkill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), skillContents(name), "utf8");
}

function skillContents(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`;
}

function vercelSkillCopyHash(name: string): string {
  return createHash("sha256")
    .update("SKILL.md")
    .update(skillContents(name))
    .digest("hex");
}

async function createDirectoryLink(
  target: string,
  path: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(
    target,
    path,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function globalLockPath(environment: FixtureEnvironment): string {
  return join(environment.stateDirectory, "skills", ".skill-lock.json");
}

function projectLockPath(environment: FixtureEnvironment): string {
  return join(environment.workspaceDirectory, "skills-lock.json");
}

function globalCanonicalPath(
  environment: FixtureEnvironment,
  skillName: string,
): string {
  return join(environment.homeDirectory, ".agents", "skills", skillName);
}

function targetFor(installation: Installation): RemovalTarget {
  return { kind: "installation", installationId: installation.id };
}

describe("Vercel skills adapter", () => {
  it("reconciles a global lock entry with its canonical directory and agent link", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const canonical = globalCanonicalPath(environment, "review-tools");
    const claudeLink = join(
      environment.homeDirectory,
      ".claude",
      "skills",
      "review-tools",
    );
    await writeSkill(canonical, "review-tools");
    await createDirectoryLink(canonical, claudeLink);
    await writeJson(globalLockPath(environment), {
      version: 3,
      dismissed: { update: true },
      skills: {
        "review-tools": {
          source: "acme/review-tools",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/review-tools.git",
          skillPath: "skills/review-tools",
          pluginName: "quality-suite",
          ref: "main",
          futureField: { preserved: true },
        },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations).toHaveLength(1);
    const installation = inventory.installations[0]!;
    expect(installation).toMatchObject({
      status: "active",
      source: {
        id: "acme/review-tools",
        url: "https://github.com/acme/review-tools.git",
      },
      manager: { id: "vercel-skills" },
      adapterId: "vercel.skills",
      location: { path: canonical, artifactType: { kind: "directory" } },
      metadata: {
        "vercel-skills": {
          lockFormat: "global",
          lockVersion: 3,
          lockKey: "review-tools",
          sanitizedName: "review-tools",
          sourceType: "github",
          pluginName: "quality-suite",
          skillPath: "skills/review-tools",
          agents: ["claude-code", "universal"],
          installMode: "link",
          stale: false,
        },
      },
    });
    expect(installation.identity.strongEvidence).toContainEqual({
      strength: "strong",
      kind: "source",
      sourceId: "acme/review-tools",
      skillPath: "skills/review-tools",
    });
    expect(installation.removal.supplementalArtifacts).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({
          path: claudeLink,
          artifactType: expect.objectContaining({
            kind: process.platform === "win32" ? "junction" : "symbolic-link",
          }),
        }),
      }),
    ]);
    expect(installation.removal.managed).toMatchObject({
      availability: { kind: "available" },
      invocation: {
        kind: "direct",
        command: {
          executable: "skills",
          arguments: expect.arrayContaining([
            "remove",
            "review-tools",
            "--global",
            "--agent",
            "universal",
            "--yes",
          ]),
        },
        workingDirectory: { kind: "isolated-temporary" },
      },
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: "remove-path", path: canonical }),
        expect.objectContaining({ kind: "remove-path", path: claudeLink }),
        expect.objectContaining({
          kind: "modify-path",
          path: globalLockPath(environment),
        }),
      ]),
    });
    const globalArguments =
      installation.removal.managed?.invocation.kind === "direct"
        ? installation.removal.managed.invocation.command.arguments
        : [];
    expect(globalArguments).not.toContain("eve");
    expect(globalArguments).not.toContain("promptscript");
  });

  it("discovers copied project installs and pins direct removal to the project cwd", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const copied = join(
      environment.workspaceDirectory,
      ".claude",
      "skills",
      "project-helper",
    );
    await writeSkill(copied, "project-helper");
    await writeJson(projectLockPath(environment), {
      version: 1,
      skills: {
        "project-helper": {
          source: "acme/project-skills",
          sourceType: "github",
          sourceUrl: "https://github.com/acme/project-skills.git",
          skillPath: "project-helper",
          computedHash: vercelSkillCopyHash("project-helper"),
        },
      },
      futureTopLevel: true,
    });

    const inventory = await scanner(environment, true).scan({});
    const installation = inventory.installations[0]!;
    expect(installation).toMatchObject({
      status: "active",
      location: { path: copied, artifactType: { kind: "directory" } },
      scope: {
        kind: "workspace",
        workspacePath: environment.workspaceDirectory,
      },
      metadata: {
        "vercel-skills": {
          lockFormat: "project",
          installMode: "copy",
          stale: false,
        },
      },
      removal: {
        managed: {
          invocation: {
            kind: "direct",
            command: {
              executable: "skills",
              arguments: ["remove", "project-helper", "--yes"],
            },
            workingDirectory: {
              kind: "exact",
              path: environment.workspaceDirectory,
            },
          },
        },
      },
    });
  });

  it("matches legacy OpenClaw and home-config paths when XDG config differs", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const openClaw = join(
      environment.homeDirectory,
      ".clawdbot",
      "skills",
      "legacy-claw",
    );
    const crush = join(
      environment.homeDirectory,
      ".config",
      "crush",
      "skills",
      "crush-skill",
    );
    const kimchi = join(
      environment.homeDirectory,
      ".config",
      "kimchi",
      "harness",
      "skills",
      "kimchi-skill",
    );
    await Promise.all([
      writeSkill(openClaw, "legacy-claw"),
      writeSkill(crush, "crush-skill"),
      writeSkill(kimchi, "kimchi-skill"),
    ]);
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        "legacy-claw": { source: "acme/claw", skillPath: "legacy" },
        "crush-skill": { source: "acme/crush", skillPath: "crush" },
        "kimchi-skill": { source: "acme/kimchi", skillPath: "kimchi" },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    const paths = inventory.installations.map((item) => item.location.path);
    expect(paths).toEqual(expect.arrayContaining([openClaw, crush, kimchi]));
    expect(paths).not.toContain(
      join(environment.configDirectory, "crush", "skills", "crush-skill"),
    );
  });

  it("keeps canonical skills visible but non-removable when a lock is malformed or hard-linked", async () => {
    const malformedFixture = await createTestEnvironment();
    const malformedEnvironment = scanEnvironment(malformedFixture);
    const malformedSkill = join(
      malformedEnvironment.workspaceDirectory,
      ".agents",
      "skills",
      "unsafe-record",
    );
    await writeSkill(malformedSkill, "unsafe-record");
    await writeFile(
      projectLockPath(malformedEnvironment),
      '{"version":1,"skills":{"unsafe-record":{},"unsafe-record":{"source":"other"}}}\n',
      "utf8",
    );

    const malformedInventory = await scanner(malformedEnvironment, true).scan(
      {},
    );
    expect(malformedInventory.installations).toEqual([
      expect.objectContaining({
        status: "unresolved",
        location: expect.objectContaining({ path: malformedSkill }),
        ownership: { kind: "unknown", confidence: "unknown" },
        removal: expect.objectContaining({
          managed: null,
          fallback: expect.objectContaining({ kind: "unavailable" }),
        }),
      }),
    ]);

    const linkedFixture = await createTestEnvironment();
    const linkedEnvironment = scanEnvironment(linkedFixture);
    const linkedSkill = join(
      linkedEnvironment.workspaceDirectory,
      ".agents",
      "skills",
      "linked-lock",
    );
    const originalLock = join(linkedFixture.temporary, "original-lock.json");
    await writeSkill(linkedSkill, "linked-lock");
    await writeJson(originalLock, {
      version: 1,
      skills: { "linked-lock": { source: "acme/linked" } },
    });
    await link(originalLock, projectLockPath(linkedEnvironment));

    const linkedInventory = await scanner(linkedEnvironment, true).scan({});
    expect(linkedInventory.installations).toEqual([
      expect.objectContaining({
        status: "unresolved",
        location: expect.objectContaining({ path: linkedSkill }),
        removal: expect.objectContaining({
          managed: null,
          fallback: expect.objectContaining({ kind: "unavailable" }),
        }),
      }),
    ]);
  });

  it("keeps stale records visible and selects only safe manager availability", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        stale: { source: "acme/stale", skillPath: "stale" },
      },
    });
    await writeJson(projectLockPath(environment), {
      version: 1,
      skills: {
        local: { source: "acme/local", skillPath: "local" },
      },
    });

    const inventory = await scanner(environment, false).scan({});
    const global = inventory.installations.find(
      (item) => item.scope.kind === "user",
    )!;
    const project = inventory.installations.find(
      (item) => item.scope.kind === "workspace",
    )!;
    expect(global).toMatchObject({
      status: "broken",
      metadata: { "vercel-skills": { stale: true } },
      removal: {
        primaryArtifactPresent: false,
        managed: {
          availability: { kind: "available" },
          invocation: {
            kind: "ephemeral-package",
            packageExecution: {
              runner: "npx",
              packageName: "skills",
              packageVersion: "1.5.22",
              mayDownload: true,
            },
            packageArguments: expect.arrayContaining([
              "remove",
              "stale",
              "--global",
              "--agent",
              "universal",
              "--yes",
            ]),
          },
        },
      },
    });
    const ephemeralPlan = plan(inventory, {
      kind: "targets",
      targets: [targetFor(global)],
      force: false,
      mode: "managed-first",
    });
    expect(ephemeralPlan.actions).toEqual([
      expect.objectContaining({
        kind: "managed-removal",
        approvals: expect.arrayContaining([
          expect.objectContaining({
            kind: "package-trust",
            runner: "npx",
            packageName: "skills",
            packageVersion: "1.5.22",
          }),
        ]),
      }),
    ]);
    expect(project.removal.managed).toMatchObject({
      availability: {
        kind: "unavailable",
        reason: "project removal requires an installed skills manager",
      },
      invocation: {
        kind: "direct",
        command: {
          executable: "skills",
          arguments: ["remove", "local", "--yes"],
        },
        workingDirectory: {
          kind: "exact",
          path: environment.workspaceDirectory,
        },
      },
    });
    const projectFallback = plan(inventory, {
      kind: "targets",
      targets: [targetFor(project)],
      force: false,
      mode: "brute-force",
    });
    expect(projectFallback.actions.map((action) => action.kind)).toEqual([
      "record-cleanup",
    ]);

    const olderNodeEnvironment = { ...environment, nodeVersion: "20.19.0" };
    const olderNodeInventory = await scanner(olderNodeEnvironment, false).scan(
      {},
    );
    const olderGlobal = olderNodeInventory.installations.find(
      (item) => item.scope.kind === "user",
    )!;
    expect(olderGlobal.removal.managed!.availability).toEqual({
      kind: "unavailable",
      reason: "skills@1.5.22 requires Node.js 22.20 or newer",
    });

    const legacyFixture = await createTestEnvironment();
    const legacyEnvironment = scanEnvironment(legacyFixture);
    await writeJson(globalLockPath(legacyEnvironment), {
      version: 2,
      skills: {
        legacy: { source: "acme/legacy", skillPath: "legacy" },
      },
    });
    const legacyInventory = await scanner(legacyEnvironment, true).scan({});
    expect(legacyInventory.installations[0]?.removal).toMatchObject({
      primaryArtifactPresent: false,
      managed: {
        availability: {
          kind: "unavailable",
          reason: "global lock version 2 is not supported by skills@1.5.22",
        },
      },
      fallback: { kind: "available" },
    });
  });

  it("blocks ambiguous sanitized lock keys instead of targeting the wrong record", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        "A B": { source: "acme/one", skillPath: "one" },
        "a-b": { source: "acme/two", skillPath: "two" },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations).toHaveLength(2);
    for (const installation of inventory.installations) {
      expect(installation.status).toBe("unresolved");
      expect(installation.removal.managed!.availability.kind).toBe(
        "unavailable",
      );
      expect(installation.removal.fallback.kind).toBe("unavailable");
      expect(installation.removal.recordCleanups).toEqual([]);
    }
  });

  it("never passes an option-shaped lock key to the native remove parser", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeSkill(globalCanonicalPath(environment, "all"), "all");
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        "--all": { source: "acme/options", skillPath: "all" },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    const installation = inventory.installations[0]!;
    expect(installation.removal.managed).toMatchObject({
      availability: {
        kind: "unavailable",
        reason: "Vercel skill key would be parsed as a command option",
      },
      invocation: {
        kind: "direct",
        command: expect.objectContaining({
          arguments: expect.not.arrayContaining(["--all"]),
        }),
      },
    });
    expect(installation.removal.fallback.kind).toBe("available");
    expect(installation.removal.recordCleanups).toHaveLength(1);
  });

  it("does not claim an agent link that points outside the canonical manager path", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const unrelated = join(fixture.temporary, "unrelated-skill");
    const misleadingLink = join(
      environment.homeDirectory,
      ".claude",
      "skills",
      "expected-skill",
    );
    await writeSkill(unrelated, "unrelated-skill");
    await createDirectoryLink(unrelated, misleadingLink);
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        "expected-skill": {
          source: "acme/expected",
          skillPath: "expected-skill",
        },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations).toEqual([
      expect.objectContaining({
        status: "unresolved",
        skill: { name: "expected-skill", description: null },
        contentHash: null,
        removal: expect.objectContaining({
          managed: expect.objectContaining({
            availability: expect.objectContaining({ kind: "unavailable" }),
          }),
          fallback: expect.objectContaining({ kind: "unavailable" }),
          recordCleanups: [],
        }),
      }),
    ]);
  });

  it("blocks a project copy that no longer matches its lock hash", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const copied = join(
      environment.workspaceDirectory,
      ".claude",
      "skills",
      "changed-copy",
    );
    await writeSkill(copied, "changed-copy");
    await writeJson(projectLockPath(environment), {
      version: 1,
      skills: {
        "changed-copy": {
          source: "acme/changed-copy",
          sourceType: "github",
          skillPath: "changed-copy",
          computedHash: "a".repeat(64),
        },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations).toEqual([
      expect.objectContaining({
        status: "unresolved",
        contentHash: null,
        removal: expect.objectContaining({
          managed: expect.objectContaining({
            availability: expect.objectContaining({ kind: "unavailable" }),
          }),
          fallback: expect.objectContaining({ kind: "unavailable" }),
        }),
      }),
    ]);
  });

  it("exposes safe source and plugin batch groups without merging Skill identities", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    for (const name of ["lint", "review", "unrelated"]) {
      await writeSkill(globalCanonicalPath(environment, name), name);
    }
    await writeJson(globalLockPath(environment), {
      version: 3,
      skills: {
        lint: {
          source: "acme/quality",
          pluginName: "quality-suite",
          skillPath: "lint",
        },
        review: {
          source: "acme/quality",
          pluginName: "quality-suite",
          skillPath: "review",
        },
        unrelated: {
          source: "other/quality",
          pluginName: "quality-suite",
          skillPath: "unrelated",
        },
      },
    });

    const inventory = await scanner(environment, true).scan({});
    const metadata = (installation: Installation) =>
      installation.metadata["vercel-skills"] as Record<string, unknown>;
    const lint = inventory.installations.find(
      (item) => item.skill.name === "lint",
    )!;
    const review = inventory.installations.find(
      (item) => item.skill.name === "review",
    )!;
    const unrelated = inventory.installations.find(
      (item) => item.skill.name === "unrelated",
    )!;
    expect(metadata(lint).sourceGroupId).toBe(metadata(review).sourceGroupId);
    expect(metadata(lint).pluginGroupId).toBe(metadata(review).pluginGroupId);
    expect(metadata(unrelated).sourceGroupId).not.toBe(
      metadata(lint).sourceGroupId,
    );
    expect(metadata(unrelated).pluginGroupId).not.toBe(
      metadata(lint).pluginGroupId,
    );
    expect(inventory.logicalSkills).toHaveLength(3);

    const groupedPlan = plan(inventory, {
      kind: "targets",
      targets: [targetFor(lint), targetFor(review)],
      force: false,
      mode: "managed-first",
    });
    const managedActions = groupedPlan.actions.filter(
      (action) => action.kind === "managed-removal",
    );
    expect(managedActions).toHaveLength(2);
    const commandArguments = managedActions.flatMap((action) =>
      action.invocation.kind === "direct"
        ? action.invocation.command.arguments
        : action.invocation.packageArguments,
    );
    expect(commandArguments).toEqual(
      expect.arrayContaining(["lint", "review"]),
    );
    expect(commandArguments).not.toContain("unrelated");
    expect(groupedPlan.targets).toEqual(
      expect.arrayContaining([targetFor(lint), targetFor(review)]),
    );
    expect(groupedPlan.targets).not.toContainEqual(targetFor(unrelated));
  });

  it("executes native removal with exact effects and preserves unrelated source records", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const selectedPath = globalCanonicalPath(environment, "selected");
    const selectedPeerPath = globalCanonicalPath(environment, "selected-peer");
    const unrelatedPath = globalCanonicalPath(environment, "unrelated");
    const lockPath = globalLockPath(environment);
    await writeSkill(selectedPath, "selected");
    await writeSkill(selectedPeerPath, "selected-peer");
    await writeSkill(unrelatedPath, "unrelated");
    await writeFile(
      join(environment.workspaceDirectory, "promptscript.yaml"),
      "version: 1\n",
      "utf8",
    );
    await writeJson(lockPath, {
      version: 3,
      dismissed: { keep: true },
      skills: {
        selected: {
          source: "acme/selected-source",
          skillPath: "selected",
        },
        "selected-peer": {
          source: "acme/selected-source",
          skillPath: "selected-peer",
        },
        unrelated: {
          source: "other/source",
          skillPath: "unrelated",
          futureField: "keep-me",
        },
      },
    });
    const inventoryScanner = scanner(environment, true);
    const initial = await inventoryScanner.scan({});
    const selected = initial.installations.find(
      (item) => item.skill.name === "selected",
    )!;
    const selectedPeer = initial.installations.find(
      (item) => item.skill.name === "selected-peer",
    )!;
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [targetFor(selected), targetFor(selectedPeer)],
      force: false,
      mode: "managed-first",
    });
    let activeOwnerProcesses = 0;
    let maximumActiveOwnerProcesses = 0;
    const isolatedWorkingDirectories: string[] = [];
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      activeOwnerProcesses += 1;
      maximumActiveOwnerProcesses = Math.max(
        maximumActiveOwnerProcesses,
        activeOwnerProcesses,
      );
      const externalId = request.command.arguments[1];
      expect(["selected", "selected-peer"]).toContain(externalId);
      expect(request.cwd).not.toBe(environment.workspaceDirectory);
      expect(request.cwd).toBeTypeOf("string");
      isolatedWorkingDirectories.push(request.cwd!);
      await expect(
        lstat(join(request.cwd!, "promptscript.yaml")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(request).toMatchObject({
        command: {
          executable: "skills",
          arguments: expect.arrayContaining([
            "remove",
            externalId,
            "--global",
            "--agent",
            "universal",
            "--yes",
          ]),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rm(externalId === "selected" ? selectedPath : selectedPeerPath, {
        recursive: true,
        force: true,
      });
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
        skills: Record<string, unknown>;
      };
      delete lock.skills[externalId!];
      await writeJson(lockPath, lock);
      activeOwnerProcesses -= 1;
      return { exitCode: 0, stdout: "removed", stderr: "" };
    });
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (fresh, intent) => plan(fresh, intent),
      quarantine: createQuarantineModule({
        stateRoot: join(environment.stateDirectory, "cleaner"),
        now: () => fixedTime,
        createId: () => "native-unused",
        fileSystem: nodeQuarantineFileSystem,
        inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      }),
      processRunner: { run },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: { write: vi.fn(async () => undefined) },
      packageTrustStore: {
        isTrusted: vi.fn(async () => false),
        trust: vi.fn(async () => undefined),
      },
      now: () => fixedTime,
      stateRoot: join(environment.stateDirectory, "cleaner"),
    });

    const report = await execution.execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("succeeded");
    expect(report.targetResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: targetFor(selected),
          status: "removed",
        }),
        expect.objectContaining({
          target: targetFor(selectedPeer),
          status: "removed",
        }),
      ]),
    );
    expect(report.fallbackPlans).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maximumActiveOwnerProcesses).toBe(1);
    for (const cwd of isolatedWorkingDirectories) {
      await expect(lstat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const remainingLock = JSON.parse(await readFile(lockPath, "utf8")) as {
      dismissed: unknown;
      skills: Record<string, unknown>;
    };
    expect(remainingLock.dismissed).toEqual({ keep: true });
    expect(remainingLock.skills).toEqual({
      unrelated: {
        source: "other/source",
        skillPath: "unrelated",
        futureField: "keep-me",
      },
    });
    await expect(
      readFile(join(unrelatedPath, "SKILL.md"), "utf8"),
    ).resolves.toContain("unrelated");
  });

  it("offers and executes a separately confirmed declarative fallback after native failure", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const canonical = globalCanonicalPath(environment, "fallback-skill");
    const linked = join(
      environment.homeDirectory,
      ".claude",
      "skills",
      "fallback-skill",
    );
    const unrelated = globalCanonicalPath(environment, "keep-skill");
    const lockPath = globalLockPath(environment);
    await writeSkill(canonical, "fallback-skill");
    await createDirectoryLink(canonical, linked);
    await writeSkill(unrelated, "keep-skill");
    await writeJson(lockPath, {
      version: 3,
      skills: {
        "fallback-skill": {
          source: "acme/fallback",
          skillPath: "fallback-skill",
        },
        "keep-skill": { source: "other/source", skillPath: "keep-skill" },
      },
    });
    const inventoryScanner = scanner(environment, true);
    const initial = await inventoryScanner.scan({});
    const selected = initial.installations.find(
      (item) => item.skill.name === "fallback-skill",
    )!;
    const managedPlan = plan(initial, {
      kind: "targets",
      targets: [targetFor(selected)],
      force: false,
      mode: "managed-first",
    });
    let quarantineId = 0;
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (fresh, intent) => plan(fresh, intent),
      quarantine: createQuarantineModule({
        stateRoot: join(environment.stateDirectory, "cleaner"),
        now: () => fixedTime,
        createId: () => `fallback-${String((quarantineId += 1))}`,
        fileSystem: nodeQuarantineFileSystem,
        inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      }),
      processRunner: {
        run: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "failed" })),
      },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: { write: vi.fn(async () => undefined) },
      packageTrustStore: {
        isTrusted: vi.fn(async () => false),
        trust: vi.fn(async () => undefined),
      },
      now: () => fixedTime,
      stateRoot: join(environment.stateDirectory, "cleaner"),
      maxConcurrency: 1,
    });

    const failed = await execution.execute(managedPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(failed.status).toBe("failed");
    expect(failed.fallbackPlans).toHaveLength(1);
    const fallback = failed.fallbackPlans[0]!;
    expect(fallback.intent.mode).toBe("brute-force");
    expect(fallback.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "quarantine",
      "record-cleanup",
    ]);
    expect(
      fallback.actions.every((action) =>
        action.approvals.some(
          (approval) => approval.kind === "brute-force-confirmation",
        ),
      ),
    ).toBe(true);

    const recovered = await execution.execute(fallback, {
      grants: [{ kind: "confirmation" }, { kind: "brute-force-confirmation" }],
    });
    expect(recovered.status).toBe("succeeded");
    await expect(
      readFile(join(unrelated, "SKILL.md"), "utf8"),
    ).resolves.toContain("keep-skill");
    const remainingLock = JSON.parse(await readFile(lockPath, "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(Object.keys(remainingLock.skills)).toEqual(["keep-skill"]);
  });
});
