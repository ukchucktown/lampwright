import {
  access,
  mkdir,
  readdir,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createInventoryScanner,
  InventoryScanError,
  plan,
  stringifyModel,
  type DiscoveryRoot,
  type InventoryCommand,
  type InventoryCommandRunner,
  type Installation,
  type InventoryScanEnvironment,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-02-03T04:05:06.000Z");
const unavailableCommandRunner: InventoryCommandRunner = {
  async run() {
    return { exitCode: null, stdout: "" };
  },
};

function createScanner(
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner = unavailableCommandRunner,
) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner,
  });
}

function unusedDefaultEnvironment(
  environment: Awaited<ReturnType<typeof createTestEnvironment>>,
): InventoryScanEnvironment {
  return {
    homeDirectory: join(environment.home, "unused-default-home"),
    workspaceDirectory: join(environment.workspace, "unused-default-workspace"),
  };
}

function createGitCommandRunner(
  worktreeRoot: string,
  ignoredPaths: readonly string[] = [],
  observedCommands: InventoryCommand[] = [],
): InventoryCommandRunner {
  return {
    async run(command) {
      observedCommands.push(command);
      if (
        command.executable !== "git" ||
        command.arguments[0] !== "-C" ||
        command.arguments[1] === undefined
      ) {
        return { exitCode: null, stdout: "" };
      }
      if (
        command.arguments.length === 4 &&
        command.arguments[2] === "rev-parse" &&
        command.arguments[3] === "--show-toplevel"
      ) {
        return { exitCode: 0, stdout: `${worktreeRoot}\n` };
      }
      if (
        command.arguments.length !== 6 ||
        command.arguments[2] !== "check-ignore" ||
        command.arguments[3] !== "--quiet" ||
        command.arguments[4] !== "--"
      ) {
        return { exitCode: null, stdout: "" };
      }
      const candidatePath = command.arguments.at(-1);
      return {
        exitCode:
          candidatePath !== undefined && ignoredPaths.includes(candidatePath)
            ? 0
            : 1,
        stdout: "",
      };
    },
  };
}

async function createSkill(
  directoryPath: string,
  options: {
    readonly name: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly body?: string;
  },
): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
  const tags = options.tags ?? [];
  const content = [
    "---",
    `name: ${options.name}`,
    ...(options.description === undefined
      ? []
      : [`description: ${options.description}`]),
    ...(tags.length === 0 ? [] : ["tags:", ...tags.map((tag) => `  - ${tag}`)]),
    "---",
    options.body ?? `# ${options.name}`,
    "",
  ].join("\n");
  const skillFilePath = join(directoryPath, "SKILL.md");
  await writeFile(skillFilePath, content, "utf8");
  await utimes(skillFilePath, fixedTime, fixedTime);
}

async function createDirectoryLink(
  targetPath: string,
  linkPath: string,
): Promise<void> {
  await symlink(
    targetPath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function installationByName(
  installations: readonly Installation[],
  name: string,
): Installation {
  const installation = installations.find((item) => item.skill.name === name);
  if (installation === undefined) {
    throw new Error(`installation not found: ${name}`);
  }
  return installation;
}

async function snapshotDirectory(directoryPath: string): Promise<string[]> {
  const snapshot: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      const pathFromRoot = relative(directoryPath, entryPath)
        .split(sep)
        .join("/");
      if (entry.isDirectory()) {
        snapshot.push(`directory:${pathFromRoot}`);
        await visit(entryPath);
      } else {
        snapshot.push(
          `file:${pathFromRoot}:${await readFile(entryPath, "utf8")}`,
        );
      }
    }
  }

  await visit(directoryPath);
  return snapshot;
}

describe("Inventory scan", () => {
  it("uses a semantic Inventory ID that ignores scan time and changes with protection evidence", async () => {
    const environment = await createTestEnvironment();
    const rootPath = join(environment.home, ".agents", "skills");
    const skillPath = join(rootPath, "stable");
    await createSkill(skillPath, { name: "stable" });
    const request = {
      roots: [
        {
          kind: "user" as const,
          path: rootPath,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    };
    const scanEnvironment = unusedDefaultEnvironment(environment);

    const first = await createInventoryScanner({
      now: () => fixedTime,
      environment: scanEnvironment,
      commandRunner: unavailableCommandRunner,
    }).scan(request);
    const later = await createInventoryScanner({
      now: () => new Date("2026-02-04T04:05:06.000Z"),
      environment: scanEnvironment,
      commandRunner: unavailableCommandRunner,
    }).scan(request);
    const protectedInventory = await createInventoryScanner({
      now: () => new Date("2026-02-05T04:05:06.000Z"),
      environment: scanEnvironment,
      commandRunner: createGitCommandRunner(environment.home),
    }).scan(request);

    expect(later.scannedAt).not.toBe(first.scannedAt);
    expect(later.id).toBe(first.id);
    expect(protectedInventory.id).not.toBe(first.id);
    expect(protectedInventory.installations[0]?.protection.git.kind).toBe(
      "protected",
    );
  });

  it("classifies bounded user, agent, workspace, plugin, and inspection roots", async () => {
    const environment = await createTestEnvironment();
    const userRoot = join(environment.home, ".agents", "skills");
    const agentRoot = join(environment.home, ".fixture-agent", "skills");
    const workspaceRoot = join(environment.workspace, ".agents", "skills");
    const pluginRoot = join(environment.home, ".plugins", "fixture", "skills");
    const sourceRoot = join(environment.workspace, "skill-sources");
    const cacheRoot = join(environment.cache, "skill-cache");
    const systemRoot = join(
      environment.home,
      ".fixture-agent",
      "system-skills",
    );
    const unknownRoot = join(environment.temporary, "unknown-skills");

    await Promise.all([
      createSkill(join(userRoot, "nested", "alpha"), {
        name: "alpha",
        description: "User skill",
        tags: ["second", "first"],
      }),
      createSkill(join(agentRoot, "beta"), { name: "beta" }),
      createSkill(join(workspaceRoot, "project"), { name: "project" }),
      createSkill(join(pluginRoot, "plugin-skill"), { name: "plugin-skill" }),
      createSkill(join(sourceRoot, "source-skill"), { name: "source-skill" }),
      createSkill(join(cacheRoot, "cached-skill"), { name: "cached-skill" }),
      createSkill(join(systemRoot, "runtime-skill"), { name: "runtime-skill" }),
      createSkill(join(unknownRoot, "mystery"), { name: "mystery" }),
    ]);

    const roots: DiscoveryRoot[] = [
      { kind: "user", path: userRoot, agentId: "fixture", adapterId: null },
      { kind: "agent", path: agentRoot, agentId: "fixture", adapterId: null },
      {
        kind: "workspace",
        path: workspaceRoot,
        workspacePath: environment.workspace,
        agentId: "fixture",
        adapterId: null,
      },
      {
        kind: "plugin",
        path: pluginRoot,
        agentId: "fixture",
        scope: { kind: "user" },
        plugin: { id: "fixture-plugin", version: "1.0.0" },
        independentlySelectable: false,
        adapterId: "fixture-plugin-adapter",
      },
      {
        kind: "source",
        path: sourceRoot,
        agentId: null,
        scope: null,
        source: { id: "fixture-source", url: "https://example.com/source" },
        adapterId: null,
      },
      {
        kind: "cache-or-vendor",
        path: cacheRoot,
        agentId: null,
        scope: null,
        adapterId: null,
      },
      { kind: "system", path: systemRoot, agentId: "fixture", adapterId: null },
      {
        kind: "unknown",
        path: unknownRoot,
        agentId: null,
        scope: null,
        adapterId: null,
      },
    ];

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({ roots });

    expect(
      inventory.installations.map((item) => item.skill.name).sort(),
    ).toEqual(["alpha", "beta", "plugin-skill", "project"]);
    expect(
      inventory.otherFindings.map((item) => [
        item.skill.name,
        item.classification,
      ]),
    ).toEqual([
      ["cached-skill", "cache-or-vendor-artifact"],
      ["runtime-skill", "system-skill"],
      ["mystery", "unknown"],
      ["source-skill", "source-artifact"],
    ]);

    const alpha = installationByName(inventory.installations, "alpha");
    expect(alpha.skill.description).toBe("User skill");
    expect(alpha.tags).toEqual(["first", "second"]);
    expect(alpha.contentHash).toMatch(/^[a-f\d]{64}$/);
    expect(alpha.scope).toEqual({ kind: "user" });

    const project = installationByName(inventory.installations, "project");
    expect(project.classification).toBe("standalone-project-skill");
    expect(project.scope).toEqual({
      kind: "workspace",
      workspacePath: environment.workspace,
    });

    const plugin = installationByName(inventory.installations, "plugin-skill");
    expect(plugin.classification).toBe("managed-plugin-resource");
    expect(plugin.ownership).toEqual({
      kind: "plugin",
      pluginId: "fixture-plugin",
      independentlySelectable: false,
      confidence: "declared",
    });

    const source = inventory.otherFindings.find(
      (item) => item.classification === "source-artifact",
    );
    expect(source?.source).toEqual({
      id: "fixture-source",
      url: "https://example.com/source",
    });
    expect(source?.contentHash).toMatch(/^[a-f\d]{64}$/);

    const system = inventory.otherFindings.find(
      (item) => item.classification === "system-skill",
    );
    expect(system?.protection.system).toEqual({
      kind: "system-skill",
      agentId: "fixture",
    });
  });

  it("keeps identical external Plugin IDs in distinct physical boundaries", async () => {
    const environment = await createTestEnvironment();
    const userPluginRoot = join(environment.home, "plugins", "shared");
    const workspacePluginRoot = join(
      environment.workspace,
      ".plugins",
      "shared",
    );
    await Promise.all([
      createSkill(join(userPluginRoot, "skills", "user-child"), {
        name: "user-child",
      }),
      createSkill(join(workspacePluginRoot, "skills", "workspace-child"), {
        name: "workspace-child",
      }),
    ]);

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: userPluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "shared-plugin", version: "1.0.0" },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
        {
          kind: "plugin",
          path: workspacePluginRoot,
          agentId: "fixture",
          scope: {
            kind: "workspace",
            workspacePath: environment.workspace,
          },
          plugin: { id: "shared-plugin", version: "1.0.0" },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });

    expect(inventory.plugins).toHaveLength(2);
    expect(inventory.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "shared-plugin",
      "shared-plugin",
    ]);
    expect(new Set(inventory.plugins.map((plugin) => plugin.id)).size).toBe(2);
    expect(
      new Set(
        inventory.installations.map(
          (installation) => installation.pluginBoundaryId,
        ),
      ).size,
    ).toBe(2);
  });

  it("materializes the declared Plugin root so fallback quarantines all collateral atomically", async () => {
    const environment = await createTestEnvironment();
    const pluginRoot = join(environment.home, "plugins", "complete-plugin");
    const skillPath = join(pluginRoot, "skills", "plugin-child");
    const hookPath = join(pluginRoot, "hooks", "pre-run.js");
    const linkedTarget = join(environment.workspace, "linked-plugin-child");
    await createSkill(skillPath, { name: "plugin-child" });
    await createSkill(linkedTarget, { name: "linked-plugin-child" });
    await createDirectoryLink(linkedTarget, join(pluginRoot, "linked-child"));
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(hookPath, "export default function preRun() {}\n", "utf8");

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: pluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "complete-plugin", version: "1.0.0" },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });
    const boundary = inventory.plugins[0]!;

    expect(boundary.resources).toContainEqual(
      expect.objectContaining({
        kind: "other",
        id: "declared-root",
        location: expect.objectContaining({ path: pluginRoot }),
      }),
    );

    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    const quarantineActions = removalPlan.actions.filter(
      (action) => action.kind === "quarantine",
    );

    expect(quarantineActions).toHaveLength(1);
    expect(quarantineActions[0]).toMatchObject({
      location: {
        path: pluginRoot,
        artifactType: { kind: "directory" },
      },
      affectedInstallationIds: inventory.installations
        .map((installation) => installation.id)
        .sort(),
    });
    expect(removalPlan.verificationChecks).toContainEqual(
      expect.objectContaining({ kind: "path-absent", path: pluginRoot }),
    );
  });

  it("retains an existing Plugin boundary even when it contains no Skills", async () => {
    const environment = await createTestEnvironment();
    const pluginRoot = join(environment.home, "plugins", "empty-plugin");
    await mkdir(pluginRoot, { recursive: true });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: pluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "empty-plugin", version: null },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });

    expect(inventory.installations).toEqual([]);
    expect(inventory.plugins).toHaveLength(1);
    expect(inventory.plugins[0]).toMatchObject({
      pluginId: "empty-plugin",
      installationIds: [],
      resources: [
        {
          id: "declared-root",
          location: { path: pluginRoot },
        },
      ],
    });
    const boundary = inventory.plugins[0]!;
    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    expect(removalPlan.actions).toMatchObject([
      {
        kind: "quarantine",
        location: { path: pluginRoot },
        affectedInstallationIds: [],
      },
    ]);
  });

  it("uses the writable parent as permission evidence for a broken Plugin root link", async () => {
    const environment = await createTestEnvironment();
    const pluginParent = join(environment.home, "plugins");
    const pluginRoot = join(pluginParent, "broken-plugin");
    await mkdir(pluginParent, { recursive: true });
    await createDirectoryLink(
      join(environment.workspace, "missing-plugin-target"),
      pluginRoot,
    );

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "plugin",
          path: pluginRoot,
          agentId: "fixture",
          scope: { kind: "user" },
          plugin: { id: "broken-plugin", version: null },
          independentlySelectable: false,
          adapterId: "fixture-plugin-adapter",
        },
      ],
    });
    const boundary = inventory.plugins[0]!;
    const rootResource = boundary.resources.find(
      (resource) => resource.id === "declared-root",
    )!;

    expect(rootResource.location?.artifactType).toMatchObject({
      broken: true,
    });
    expect(rootResource.protection?.filesystem).toEqual({ kind: "writable" });
    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    expect(removalPlan.blocks).toEqual([]);
    expect(removalPlan.actions).toMatchObject([
      { kind: "quarantine", location: { path: pluginRoot } },
    ]);
  });

  it("recognizes links, junctions, broken links, strong groups, and weak hints", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, "linked-skills");
    const target = join(environment.workspace, "linked-source");
    await mkdir(root, { recursive: true });
    await createSkill(target, { name: "linked-skill", body: "same target" });
    await createDirectoryLink(target, join(root, "linked-one"));
    await createDirectoryLink(target, join(root, "linked-two"));
    await createDirectoryLink(
      join(environment.workspace, "missing-target"),
      join(root, "broken-skill"),
    );
    await createSkill(join(root, "copy-one"), {
      name: "copied-skill",
      body: "identical copy",
    });
    await createSkill(join(root, "copy-two"), {
      name: "copied-skill",
      body: "identical copy",
    });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        { kind: "user", path: root, agentId: "fixture", adapterId: null },
      ],
    });
    const linkedOne = installationByName(
      inventory.installations,
      "linked-skill",
    );
    const linkedInstallations = inventory.installations.filter(
      (item) => item.skill.name === "linked-skill",
    );
    expect(linkedInstallations).toHaveLength(2);
    expect(linkedOne.location.artifactType.kind).toBe(
      process.platform === "win32" ? "junction" : "symbolic-link",
    );
    expect(linkedInstallations[0]?.location.canonicalPath).toBe(
      linkedInstallations[1]?.location.canonicalPath,
    );
    expect(
      inventory.logicalSkills.some(
        (logicalSkill) => logicalSkill.installationIds.length === 2,
      ),
    ).toBe(true);

    const copies = inventory.installations.filter(
      (item) => item.skill.name === "copied-skill",
    );
    expect(copies).toHaveLength(2);
    expect(copies[0]?.contentHash).toBe(copies[1]?.contentHash);
    expect(
      inventory.logicalSkills.some((logicalSkill) =>
        copies.every((copy) => logicalSkill.installationIds.includes(copy.id)),
      ),
    ).toBe(false);
    expect(
      inventory.identityHints.some(
        (hint) =>
          hint.evidence.kind === "content-hash" &&
          copies.every((copy) => hint.installationIds.includes(copy.id)),
      ),
    ).toBe(true);

    const broken = inventory.installations.find(
      (item) => item.location.path === join(root, "broken-skill"),
    );
    expect(broken?.status).toBe("broken");
    expect(broken?.location.canonicalPath).toBeNull();
    expect(broken?.location.artifactType).toMatchObject({
      kind: process.platform === "win32" ? "junction" : "symbolic-link",
      broken: true,
    });
  });

  it("marks every non-ignored worktree skill as protected", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.workspace, ".agents", "skills");
    await createSkill(join(root, "protected-skill"), {
      name: "protected-skill",
    });
    await createSkill(join(root, "ignored-skill"), { name: "ignored-skill" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
      createGitCommandRunner(environment.workspace, [
        ".agents/skills/ignored-skill",
      ]),
    ).scan({
      roots: [
        {
          kind: "workspace",
          path: root,
          workspacePath: environment.workspace,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    });

    expect(
      installationByName(inventory.installations, "protected-skill").protection
        .git,
    ).toEqual({ kind: "protected", worktreeRoot: environment.workspace });
    expect(
      installationByName(inventory.installations, "ignored-skill").protection
        .git,
    ).toEqual({ kind: "ignored", worktreeRoot: environment.workspace });
  });

  it("protects a Skill directory that is itself a worktree root", async () => {
    const environment = await createTestEnvironment();
    const worktreeRoot = join(environment.workspace, "skill-worktree");
    const observedCommands: InventoryCommand[] = [];
    await createSkill(worktreeRoot, { name: "worktree-skill" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
      createGitCommandRunner(worktreeRoot, [], observedCommands),
    ).scan({
      roots: [
        {
          kind: "workspace",
          path: worktreeRoot,
          workspacePath: worktreeRoot,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    });

    expect(inventory.installations[0]?.protection.git).toEqual({
      kind: "protected",
      worktreeRoot,
    });
    expect(observedCommands).toEqual([
      {
        executable: "git",
        arguments: ["-C", worktreeRoot, "rev-parse", "--show-toplevel"],
      },
      {
        executable: "git",
        arguments: ["-C", worktreeRoot, "check-ignore", "--quiet", "--", "."],
      },
    ]);
  });

  it("keeps malformed skill metadata visible as unresolved", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, "invalid-skills");
    const skillPath = join(root, "fallback-name");
    await mkdir(skillPath, { recursive: true });
    await writeFile(
      join(skillPath, "SKILL.md"),
      "---\nname: [unterminated\n---\n# still a skill\n",
      "utf8",
    );

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        { kind: "user", path: root, agentId: "fixture", adapterId: null },
      ],
    });

    expect(inventory.installations).toHaveLength(1);
    expect(inventory.installations[0]).toMatchObject({
      status: "unresolved",
      skill: { name: "fallback-name", description: null },
      metadata: { generic: { frontmatter: "invalid" } },
    });
  });

  it("resolves bounded generic user and current-workspace roots", async () => {
    const environment = await createTestEnvironment();
    await createSkill(
      join(environment.home, ".agents", "skills", "user-default"),
      { name: "user-default" },
    );
    await createSkill(
      join(environment.workspace, ".agents", "skills", "workspace-default"),
      { name: "workspace-default" },
    );

    const inventory = await createScanner({
      homeDirectory: environment.home,
      workspaceDirectory: environment.workspace,
    }).scan({});

    expect(
      inventory.installations.map((installation) => [
        installation.skill.name,
        installation.classification,
      ]),
    ).toEqual([
      ["user-default", "active-installation"],
      ["workspace-default", "standalone-project-skill"],
    ]);
  });

  it("does not traverse through a linked discovery root", async () => {
    const environment = await createTestEnvironment();
    const targetRoot = join(environment.home, "outside-linked-root");
    const linkedRoot = join(environment.home, "linked-root");
    await createSkill(join(targetRoot, "nested", "escaped"), {
      name: "escaped",
    });
    await createDirectoryLink(targetRoot, linkedRoot);

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [
        {
          kind: "user",
          path: linkedRoot,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    });

    expect(inventory.installations).toEqual([]);
  });

  it("deduplicates case aliases according to filesystem identity", async () => {
    const environment = await createTestEnvironment();
    const root = join(environment.home, "CaseSkills");
    const alias = join(environment.home, "caseskills");
    await createSkill(join(root, "only-once"), { name: "only-once" });

    const inventory = await createScanner(
      unusedDefaultEnvironment(environment),
    ).scan({
      roots: [root, alias].map((path) => ({
        kind: "user" as const,
        path,
        agentId: "fixture",
        adapterId: null,
      })),
    });

    expect(inventory.installations).toHaveLength(1);
    expect(inventory.installations[0]?.skill.name).toBe("only-once");
  });

  it("is deterministic, bounded to requested roots, and zero-footprint", async () => {
    const environment = await createTestEnvironment();
    const knownRoot = join(environment.home, "known-skills");
    const outsideRoot = join(environment.home, "not-requested");
    await createSkill(join(knownRoot, "included"), { name: "included" });
    await createSkill(join(outsideRoot, "excluded"), { name: "excluded" });
    const protectedDirectories = [
      environment.config,
      environment.state,
      environment.cache,
      environment.temporary,
    ];
    const before = await Promise.all(
      protectedDirectories.map(snapshotDirectory),
    );
    const scanner = createScanner(unusedDefaultEnvironment(environment));
    const request = {
      roots: [
        {
          kind: "user" as const,
          path: knownRoot,
          agentId: "fixture",
          adapterId: null,
        },
      ],
    };

    const first = await scanner.scan(request);
    const second = await scanner.scan(request);

    expect(stringifyModel(first)).toBe(stringifyModel(second));
    expect(first.installations.map((item) => item.skill.name)).toEqual([
      "included",
    ]);
    expect(stringifyModel(first)).not.toContain(outsideRoot);
    await expect(
      access(join(environment.state, "skill-cleaner")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      Promise.all(protectedDirectories.map(snapshotDirectory)),
    ).resolves.toEqual(before);
  });

  it("rejects ambiguous or unbounded root declarations", async () => {
    const environment = await createTestEnvironment();
    const scanner = createScanner(unusedDefaultEnvironment(environment));
    const sourceRoot = join(environment.workspace, "source-root");
    const nestedSourceRoot = join(sourceRoot, "nested-source");
    await createSkill(nestedSourceRoot, { name: "nested-source" });

    await expect(
      scanner.scan({
        roots: [
          {
            kind: "user",
            path: "relative-skills",
            agentId: "fixture",
            adapterId: null,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InventoryScanError);

    await expect(
      scanner.scan({
        roots: [
          {
            kind: "workspace",
            path: environment.home,
            workspacePath: environment.workspace,
            agentId: "fixture",
            adapterId: null,
          },
        ],
      }),
    ).rejects.toThrow(/outside its workspace/);

    await expect(
      scanner.scan({
        roots: [sourceRoot, nestedSourceRoot].map((path) => ({
          kind: "source" as const,
          path,
          agentId: null,
          scope: null,
          source: { id: "same-source", url: null },
          adapterId: null,
        })),
      }),
    ).rejects.toThrow(/overlapping discovery roots/);

    await expect(
      createInventoryScanner({
        now: () => new Date(Number.NaN),
        environment: unusedDefaultEnvironment(environment),
        commandRunner: unavailableCommandRunner,
      }).scan({ roots: [] }),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message: "inventory scanner clock returned an invalid date",
    });

    await expect(
      createInventoryScanner({
        now: () => fixedTime,
        environment: {
          ...unusedDefaultEnvironment(environment),
          stateDirectory: "relative-state",
        },
        commandRunner: unavailableCommandRunner,
      }).scan({ roots: [] }),
    ).rejects.toMatchObject({
      code: "invalid-request",
      message:
        "inventory scanner requires absolute configured environment directories",
    });
  });
});
