import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  createInventoryScanner,
  createQuarantineModule,
  nodeQuarantineFileSystem,
  plan,
  planUpdate,
  type ExecutionProcessRequest,
  type ExecutionProcessRunner,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-08-21T00:00:00.000Z");
const pluginId = "quality-suite@acme-marketplace";

interface FixtureEnvironment extends InventoryScanEnvironment {
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly agentHomeDirectories: Readonly<Record<string, string>>;
}

function scanEnvironment(environment: {
  readonly home: string;
  readonly workspace: string;
  readonly config: string;
  readonly state: string;
  readonly temporary: string;
}): FixtureEnvironment {
  return {
    homeDirectory: environment.home,
    workspaceDirectory: environment.workspace,
    configDirectory: environment.config,
    stateDirectory: environment.state,
    nodeVersion: "22.20.0",
    agentHomeDirectories: {
      "claude-code": join(environment.temporary, "claude"),
    },
  };
}

function claudeRoot(environment: FixtureEnvironment): string {
  return environment.agentHomeDirectories["claude-code"]!;
}

function registryPath(environment: FixtureEnvironment): string {
  return join(claudeRoot(environment), "plugins", "installed_plugins.json");
}

function knownMarketplacesPath(environment: FixtureEnvironment): string {
  return join(claudeRoot(environment), "plugins", "known_marketplaces.json");
}

function marketplaceRoot(environment: FixtureEnvironment): string {
  return join(
    claudeRoot(environment),
    "plugins",
    "marketplaces",
    "acme-marketplace",
  );
}

function cacheVersionPath(
  environment: FixtureEnvironment,
  version = "1.2.3",
): string {
  return join(
    claudeRoot(environment),
    "plugins",
    "cache",
    "acme-marketplace",
    "quality-suite",
    version,
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writePlugin(path: string, version = "1.2.3"): Promise<void> {
  await writeJson(join(path, ".claude-plugin", "plugin.json"), {
    name: "quality-suite",
    version,
    description: "Quality tools",
  });
  await mkdir(join(path, "skills", "review"), { recursive: true });
  await writeFile(
    join(path, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n",
    "utf8",
  );
  await mkdir(join(path, "commands"), { recursive: true });
  await writeFile(join(path, "commands", "audit.md"), "# Audit\n", "utf8");
}

function commandRunner(managerAvailable = true): InventoryCommandRunner {
  return {
    async run(command) {
      if (command.executable === "claude")
        return managerAvailable
          ? { exitCode: 0, stdout: "2.1.224 (Claude Code)\n" }
          : { exitCode: null, stdout: "" };
      if (command.executable === "fsutil")
        return {
          exitCode: 0,
          stdout: "Reparse Tag Value : 0xa0000003\r\n",
        };
      return { exitCode: 1, stdout: "" };
    },
  };
}

async function createManagedFixture(
  environment: FixtureEnvironment,
  scope: "user" | "project" | "local" = "user",
) {
  const installed = cacheVersionPath(environment);
  const marketplace = marketplaceRoot(environment);
  await writePlugin(installed);
  await writeJson(registryPath(environment), {
    version: 2,
    plugins: {
      [pluginId]: [
        {
          scope,
          installPath: installed,
          version: "1.2.3",
          gitCommitSha: "a".repeat(40),
          ...(scope === "user"
            ? {}
            : { projectPath: environment.workspaceDirectory }),
        },
      ],
    },
  });
  await writeJson(knownMarketplacesPath(environment), {
    "acme-marketplace": {
      source: {
        source: "github",
        repo: "acme/plugin-marketplace",
        ref: "stable",
      },
      installLocation: marketplace,
      lastUpdated: "2026-08-20T00:00:00.000Z",
    },
  });
  await writeJson(join(marketplace, ".claude-plugin", "marketplace.json"), {
    name: "acme-marketplace",
    plugins: [
      {
        name: "quality-suite",
        source: {
          source: "github",
          repo: "acme/quality-suite",
          ref: "release",
        },
      },
    ],
  });
  const settingsPath =
    scope === "user"
      ? join(claudeRoot(environment), "settings.json")
      : join(
          environment.workspaceDirectory,
          ".claude",
          scope === "local" ? "settings.local.json" : "settings.json",
        );
  await writeJson(settingsPath, {
    enabledPlugins: { [pluginId]: true },
  });
  return { installed, marketplace };
}

function scanner(environment: FixtureEnvironment, managerAvailable = true) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner: commandRunner(managerAvailable),
  });
}

function executionModule(
  environment: FixtureEnvironment,
  inventoryScanner: ReturnType<typeof scanner>,
  run: ExecutionProcessRunner["run"],
) {
  return createExecutionModule({
    scan: () => inventoryScanner.scan({}),
    replan: (inventory, intent) => plan(inventory, intent),
    replanUpdate: (inventory, intent) => planUpdate(inventory, intent),
    quarantine: createQuarantineModule({
      stateRoot: join(environment.stateDirectory, "lampwright"),
      now: () => fixedTime,
      createId: () => "unused",
      fileSystem: nodeQuarantineFileSystem,
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
    }),
    processRunner: { run },
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("Claude Code Plugin Managed Update", () => {
  it("plans an exact qualified user Update from corroborated marketplace evidence", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const { installed } = await createManagedFixture(environment);
    await writeJson(join(claudeRoot(environment), "settings.json"), {
      enabledPlugins: { [pluginId]: true },
      pluginConfigs: { [pluginId]: { apiToken: "must-not-be-disclosed" } },
    });

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const plan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(plan.blocks).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      affectedInstallationIds: plugin.installationIds,
      operation: {
        adapterId: "claude-code.plugins",
        operationId: "update-user-plugin",
        availability: { kind: "available" },
        trust: { kind: "trusted" },
        owner: plugin.ownership,
        externalId: pluginId,
        invocation: {
          kind: "direct",
          command: {
            executable: "claude",
            arguments: [
              "plugin",
              "update",
              pluginId,
              "--scope",
              "user",
              "--yes",
            ],
          },
          workingDirectory: { kind: "isolated-temporary" },
        },
        source: {
          id: "github:acme/quality-suite",
          url: "https://github.com/acme/quality-suite",
        },
        ref: "release",
        scope: { kind: "user" },
        network: {
          kind: "required",
          reason: expect.stringContaining("Plugin source"),
        },
        packageDownload: { kind: "none" },
        localChanges: { kind: "unavailable" },
      },
    });
    expect(plan.actions[0]!.operation.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mutation-root",
          path: dirname(installed),
          exists: true,
        }),
        expect.objectContaining({
          kind: "configuration-path",
          path: registryPath(environment),
          exists: true,
        }),
      ]),
    );
    expect(
      plan.actions[0]!.operation.effects.some((effect) =>
        effect.path.endsWith("settings.json"),
      ),
    ).toBe(false);
    expect(
      plan.actions[0]!.operation.effects.some(
        (effect) =>
          effect.path === knownMarketplacesPath(environment) ||
          effect.path.startsWith(marketplaceRoot(environment)),
      ),
    ).toBe(false);
    expect(plan.actions[0]!.operation.currentRevision).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "owner-value",
          path: registryPath(environment),
          recordPointer: "/plugins/quality-suite@acme-marketplace/0/version",
          value: "1.2.3",
        }),
      ]),
    );
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({ kind: "network-access" }),
    );
    expect(plan.actions[0]!.selectedPlugin?.settingsRecords).toEqual([
      expect.objectContaining({
        recordPointer: `/enabledPlugins/${pluginId.replace("/", "~1")}`,
        present: true,
        digest: { algorithm: "sha256", digest: expect.any(String) },
      }),
      expect.objectContaining({
        recordPointer: `/pluginConfigs/${pluginId.replace("/", "~1")}`,
        present: true,
        digest: { algorithm: "sha256", digest: expect.any(String) },
      }),
    ]);
    expect(JSON.stringify(plan)).not.toContain("must-not-be-disclosed");
  });

  it.each(["project", "local"] as const)(
    "plans exact qualified %s Update in the selected workspace",
    async (scope) => {
      const fixture = await createTestEnvironment();
      const environment = scanEnvironment(fixture);
      await createManagedFixture(environment, scope);

      const inventory = await scanner(environment).scan({});
      const plugin = inventory.plugins[0]!;
      const plan = planUpdate(inventory, {
        target: { kind: "plugin", pluginBoundaryId: plugin.id },
        force: false,
      });

      expect(plan.blocks).toEqual([]);
      expect(plan.actions[0]!.operation).toMatchObject({
        operationId: `update-${scope}-plugin`,
        invocation: {
          kind: "direct",
          command: {
            executable: "claude",
            arguments: [
              "plugin",
              "update",
              pluginId,
              "--scope",
              scope,
              "--yes",
            ],
          },
          workingDirectory: {
            kind: "exact",
            path: environment.workspaceDirectory,
          },
        },
        scope: {
          kind: "workspace",
          workspacePath: environment.workspaceDirectory,
        },
      });
    },
  );

  it("verifies a new version root and reports version and owned-resource changes", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    const finalRoot = cacheVersionPath(environment, "2.0.0");
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toMatchObject({
        command: {
          executable: "claude",
          arguments: ["plugin", "update", pluginId, "--scope", "user", "--yes"],
        },
        environment: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      });
      expect(request.cwd).toBeTypeOf("string");
      await writePlugin(finalRoot, "2.0.0");
      await rm(join(finalRoot, "commands"), { recursive: true });
      await mkdir(join(finalRoot, "agents"), { recursive: true });
      await writeFile(join(finalRoot, "agents", "reviewer.md"), "# Reviewer\n");
      await mkdir(join(finalRoot, "skills", "lint"), { recursive: true });
      await writeFile(
        join(finalRoot, "skills", "lint", "SKILL.md"),
        "---\nname: lint\ndescription: Lint code\n---\n",
      );
      const registry = JSON.parse(
        await readFile(registryPath(environment), "utf8"),
      ) as {
        plugins: Record<string, Array<Record<string, unknown>>>;
      };
      registry.plugins[pluginId]![0] = {
        ...registry.plugins[pluginId]![0],
        installPath: finalRoot,
        version: "2.0.0",
        gitCommitSha: "b".repeat(40),
      };
      await writeJson(registryPath(environment), registry);
      return { exitCode: 0, stdout: "updated", stderr: "" };
    });
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (inventory, intent) => plan(inventory, intent),
      replanUpdate: (inventory, intent) => planUpdate(inventory, intent),
      quarantine: createQuarantineModule({
        stateRoot: join(environment.stateDirectory, "lampwright"),
        now: () => fixedTime,
        createId: () => "unused",
        fileSystem: nodeQuarantineFileSystem,
        inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      }),
      processRunner: { run },
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

    const report = await execution.executeUpdate(updatePlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report).toMatchObject({
      status: "succeeded",
      targetResults: [{ status: "updated" }],
      verificationResults: [
        {
          status: "passed",
          changed: true,
          details: {
            revisionChanged: true,
            versionBefore: "1.2.3",
            versionAfter: "2.0.0",
            addedResources: expect.stringContaining("skill:skills/lint"),
            removedResources: expect.stringContaining("command:commands"),
          },
        },
      ],
    });
    expect((await inventoryScanner.scan({})).plugins[0]!.id).toBe(plugin.id);
    expect(run).toHaveBeenCalledOnce();
  });

  it("blocks stale registry and cached-manifest version disagreement", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const { installed } = await createManagedFixture(environment);
    await writeJson(join(installed, ".claude-plugin", "plugin.json"), {
      name: "quality-suite",
      version: "9.9.9",
    });

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const plan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(plan.actions).toEqual([]);
    expect(plan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("version"),
      }),
    );
  });

  it("blocks a cached manifest name that differs from the registry Plugin name", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const { installed } = await createManagedFixture(environment);
    await writeJson(join(installed, ".claude-plugin", "plugin.json"), {
      name: "different-plugin",
      version: "1.2.3",
    });

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.actions).toEqual([]);
    expect(updatePlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("manifest name"),
      }),
    );
  });

  it("withholds execution when the Claude Owner is unavailable", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);

    const inventory = await scanner(environment, false).scan({});
    const plugin = inventory.plugins[0]!;
    const plan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(plan.actions).toEqual([]);
    expect(plan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "operation-unavailable",
        reason: "the Claude Code executable is not available",
      }),
    );
  });

  it.each([
    {
      label: "Plugin command source",
      mutate: async (environment: FixtureEnvironment) => {
        await writeJson(
          join(
            marketplaceRoot(environment),
            ".claude-plugin",
            "marketplace.json",
          ),
          {
            name: "acme-marketplace",
            plugins: [
              {
                name: "quality-suite",
                source: {
                  source: "command",
                  command: "node ./materialize.mjs --output /tmp/external",
                },
              },
            ],
          },
        );
      },
      expected: "node ./materialize.mjs --output /tmp/external",
    },
    {
      label: "marketplace command source",
      mutate: async (environment: FixtureEnvironment) => {
        const known = await readJson(knownMarketplacesPath(environment));
        known["acme-marketplace"] = {
          source: {
            source: "command",
            command: "powershell -File materialize.ps1",
          },
          installLocation: marketplaceRoot(environment),
        };
        await writeJson(knownMarketplacesPath(environment), known);
      },
      expected: "powershell -File materialize.ps1",
    },
  ])("blocks a $label and discloses its exact command", async (value) => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);
    await value.mutate(environment);

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const plan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(plan.actions).toEqual([]);
    expect(plan.blocks[0]).toMatchObject({
      kind: "unresolved-update",
      reason: expect.stringContaining(value.expected),
    });
  });

  it("blocks declared Plugin dependencies and unsafe local URL sources", async () => {
    const dependencyFixture = await createTestEnvironment();
    const dependencyEnvironment = scanEnvironment(dependencyFixture);
    await createManagedFixture(dependencyEnvironment);
    const dependencyManifestPath = join(
      marketplaceRoot(dependencyEnvironment),
      ".claude-plugin",
      "marketplace.json",
    );
    const dependencyManifest = await readJson(dependencyManifestPath);
    const dependencyPlugins = dependencyManifest.plugins as Array<
      Record<string, unknown>
    >;
    dependencyPlugins[0]!.dependencies = { "other@acme-marketplace": "^1" };
    await writeJson(dependencyManifestPath, dependencyManifest);

    const dependencyInventory = await scanner(dependencyEnvironment).scan({});
    const dependencyPlugin = dependencyInventory.plugins[0]!;
    expect(
      planUpdate(dependencyInventory, {
        target: {
          kind: "plugin",
          pluginBoundaryId: dependencyPlugin.id,
        },
        force: false,
      }).blocks,
    ).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("unselected Plugin boundary"),
      }),
    );

    const unsafeFixture = await createTestEnvironment();
    const unsafeEnvironment = scanEnvironment(unsafeFixture);
    await createManagedFixture(unsafeEnvironment);
    const unsafeManifestPath = join(
      marketplaceRoot(unsafeEnvironment),
      ".claude-plugin",
      "marketplace.json",
    );
    const unsafeManifest = await readJson(unsafeManifestPath);
    const unsafePlugins = unsafeManifest.plugins as Array<
      Record<string, unknown>
    >;
    unsafePlugins[0]!.source = {
      source: "url",
      url: "file:///tmp/local-plugin",
    };
    await writeJson(unsafeManifestPath, unsafeManifest);

    const unsafeInventory = await scanner(unsafeEnvironment).scan({});
    const unsafePlugin = unsafeInventory.plugins[0]!;
    expect(
      planUpdate(unsafeInventory, {
        target: { kind: "plugin", pluginBoundaryId: unsafePlugin.id },
        force: false,
      }).blocks,
    ).toContainEqual(expect.objectContaining({ kind: "unresolved-update" }));

    const localFixture = await createTestEnvironment();
    const localEnvironment = scanEnvironment(localFixture);
    await createManagedFixture(localEnvironment);
    const localKnown = await readJson(knownMarketplacesPath(localEnvironment));
    localKnown["acme-marketplace"] = {
      source: {
        source: "directory",
        path: join(localFixture.temporary, "local-marketplace-source"),
      },
      installLocation: marketplaceRoot(localEnvironment),
    };
    await writeJson(knownMarketplacesPath(localEnvironment), localKnown);
    await mkdir(
      join(marketplaceRoot(localEnvironment), "plugins", "quality-suite"),
      { recursive: true },
    );
    await writeJson(
      join(
        marketplaceRoot(localEnvironment),
        ".claude-plugin",
        "marketplace.json",
      ),
      {
        name: "acme-marketplace",
        plugins: [{ name: "quality-suite", source: "./plugins/quality-suite" }],
      },
    );
    const localInventory = await scanner(localEnvironment).scan({});
    expect(
      planUpdate(localInventory, {
        target: {
          kind: "plugin",
          pluginBoundaryId: localInventory.plugins[0]!.id,
        },
        force: false,
      }).blocks,
    ).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("local Claude marketplace"),
      }),
    );
  });

  it.each([
    {
      source: "./plugins/quality-suite",
      expected: {
        source: {
          id: "github:acme/plugin-marketplace:plugins/quality-suite",
          url: "https://github.com/acme/plugin-marketplace",
        },
        ref: "stable",
      },
    },
    {
      source: {
        source: "url",
        url: "https://git.example.test/acme/quality-suite.git",
        ref: "release",
      },
      expected: {
        source: {
          id: "url:https://git.example.test/acme/quality-suite.git",
          url: "https://git.example.test/acme/quality-suite.git",
        },
        ref: "release",
      },
    },
    {
      source: {
        source: "git-subdir",
        url: "https://git.example.test/acme/tools.git",
        path: "plugins/quality-suite",
        sha: "c".repeat(40),
      },
      expected: {
        source: {
          id: "git-subdir:https://git.example.test/acme/tools.git:plugins/quality-suite",
          url: "https://git.example.test/acme/tools.git",
        },
        ref: "c".repeat(40),
      },
    },
    {
      source: {
        source: "npm",
        package: "@acme/quality-suite",
        version: "2.0.0",
      },
      expected: {
        source: { id: "npm:@acme/quality-suite", url: null },
        ref: "2.0.0",
      },
    },
    {
      source: {
        source: "archive",
        url: "https://artifacts.example.test/quality-suite.zip",
        sha256: "d".repeat(64),
      },
      expected: {
        source: {
          id: "archive:https://artifacts.example.test/quality-suite.zip",
          url: "https://artifacts.example.test/quality-suite.zip",
        },
        ref: "d".repeat(64),
      },
    },
  ])("normalizes a documented Plugin source", async ({ source, expected }) => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);
    if (typeof source === "string")
      await mkdir(
        join(marketplaceRoot(environment), "plugins", "quality-suite"),
        { recursive: true },
      );
    await writeJson(
      join(marketplaceRoot(environment), ".claude-plugin", "marketplace.json"),
      {
        name: "acme-marketplace",
        plugins: [{ name: "quality-suite", source }],
      },
    );

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const plan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(plan.blocks).toEqual([]);
    expect(plan.actions[0]!.operation).toMatchObject(expected);
  });

  it.each([
    { package: "file:../quality-suite", version: "2.0.0" },
    { package: "../quality-suite", version: "2.0.0" },
    { package: "https://example.test/quality-suite.tgz", version: "2.0.0" },
    { package: "@acme/quality-suite", version: "file:../quality-suite" },
    { package: "@acme/quality-suite", version: "../quality-suite" },
    {
      package: "@acme/quality-suite",
      version: "https://example.test/quality-suite.tgz",
    },
  ])("blocks unsafe npm source %#", async (source) => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);
    await writeJson(
      join(marketplaceRoot(environment), ".claude-plugin", "marketplace.json"),
      {
        name: "acme-marketplace",
        plugins: [
          { name: "quality-suite", source: { source: "npm", ...source } },
        ],
      },
    );

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.actions).toEqual([]);
    expect(updatePlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("malformed"),
      }),
    );
  });

  it("blocks a relative Plugin source that links outside its marketplace", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);
    const external = join(fixture.temporary, "external-plugin-source");
    const sourcePath = join(
      marketplaceRoot(environment),
      "plugins",
      "quality-suite",
    );
    await mkdir(external, { recursive: true });
    await mkdir(dirname(sourcePath), { recursive: true });
    await symlink(
      external,
      sourcePath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeJson(
      join(marketplaceRoot(environment), ".claude-plugin", "marketplace.json"),
      {
        name: "acme-marketplace",
        plugins: [{ name: "quality-suite", source: "./plugins/quality-suite" }],
      },
    );

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.actions).toEqual([]);
    expect(updatePlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("linked"),
      }),
    );
  });

  it("blocks managed, ambiguous, malformed, protected, and linked marketplace state", async () => {
    const managedFixture = await createTestEnvironment();
    const managedEnvironment = scanEnvironment(managedFixture);
    await createManagedFixture(managedEnvironment);
    const managedRegistry = await readJson(registryPath(managedEnvironment));
    const managedPlugins = managedRegistry.plugins as Record<
      string,
      Array<Record<string, unknown>>
    >;
    managedPlugins[pluginId]![0]!.scope = "managed";
    await writeJson(registryPath(managedEnvironment), managedRegistry);
    const managedInventory = await scanner(managedEnvironment).scan({});
    expect(
      planUpdate(managedInventory, {
        target: {
          kind: "plugin",
          pluginBoundaryId: managedInventory.plugins[0]!.id,
        },
        force: false,
      }).actions,
    ).toEqual([]);

    const ambiguousFixture = await createTestEnvironment();
    const ambiguousEnvironment = scanEnvironment(ambiguousFixture);
    await createManagedFixture(ambiguousEnvironment);
    const ambiguousRegistry = await readJson(
      registryPath(ambiguousEnvironment),
    );
    const ambiguousPlugins = ambiguousRegistry.plugins as Record<
      string,
      Array<Record<string, unknown>>
    >;
    ambiguousPlugins[pluginId]!.push({
      scope: "project",
      projectPath: ambiguousEnvironment.workspaceDirectory,
      installPath: cacheVersionPath(ambiguousEnvironment),
      version: "1.2.3",
    });
    await writeJson(registryPath(ambiguousEnvironment), ambiguousRegistry);
    const ambiguousInventory = await scanner(ambiguousEnvironment).scan({});
    expect(ambiguousInventory.plugins).toHaveLength(2);
    for (const plugin of ambiguousInventory.plugins)
      expect(
        planUpdate(ambiguousInventory, {
          target: { kind: "plugin", pluginBoundaryId: plugin.id },
          force: false,
        }).blocks,
      ).toContainEqual(expect.objectContaining({ kind: "unresolved-update" }));

    const malformedFixture = await createTestEnvironment();
    const malformedEnvironment = scanEnvironment(malformedFixture);
    await createManagedFixture(malformedEnvironment);
    const malformedKnown = await readJson(
      knownMarketplacesPath(malformedEnvironment),
    );
    malformedKnown["acme-marketplace"] = {
      source: { source: "github", repo: "acme/plugin-marketplace" },
      installLocation: join(malformedFixture.temporary, "wrong-marketplace"),
    };
    await writeJson(
      knownMarketplacesPath(malformedEnvironment),
      malformedKnown,
    );
    const malformedInventory = await scanner(malformedEnvironment).scan({});
    expect(
      planUpdate(malformedInventory, {
        target: {
          kind: "plugin",
          pluginBoundaryId: malformedInventory.plugins[0]!.id,
        },
        force: false,
      }).actions,
    ).toEqual([]);

    const protectedFixture = await createTestEnvironment();
    const protectedEnvironment = scanEnvironment(protectedFixture);
    await createManagedFixture(protectedEnvironment);
    await mkdir(join(claudeRoot(protectedEnvironment), ".git"));
    const protectedInventory = await scanner(protectedEnvironment).scan({});
    const protectedPlan = planUpdate(protectedInventory, {
      target: {
        kind: "plugin",
        pluginBoundaryId: protectedInventory.plugins[0]!.id,
      },
      force: false,
    });
    expect(protectedPlan.actions).toEqual([]);
    expect(protectedPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "git-protection" }),
    );

    const linkedFixture = await createTestEnvironment();
    const linkedEnvironment = scanEnvironment(linkedFixture);
    await createManagedFixture(linkedEnvironment);
    const externalMarketplace = join(
      linkedFixture.temporary,
      "external-marketplace",
    );
    await rm(marketplaceRoot(linkedEnvironment), { recursive: true });
    await mkdir(externalMarketplace, { recursive: true });
    await symlink(
      externalMarketplace,
      marketplaceRoot(linkedEnvironment),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedInventory = await scanner(linkedEnvironment).scan({});
    const linkedPlan = planUpdate(linkedInventory, {
      target: {
        kind: "plugin",
        pluginBoundaryId: linkedInventory.plugins[0]!.id,
      },
      force: false,
    });
    expect(linkedPlan.actions).toEqual([]);
    expect(linkedPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "unresolved-update" }),
    );
  });

  it("preserves Native Disable through a successful unchanged Update", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createManagedFixture(environment);
    await writeJson(join(claudeRoot(environment), "settings.json"), {
      enabledPlugins: { [pluginId]: false },
    });
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    expect(plugin.availability.status).toBe("disabled");
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    expect(updatePlan.actions[0]!.availabilityExpectation.pluginStatus).toBe(
      "disabled",
    );
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: "already current",
      stderr: "",
    }));
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (inventory, intent) => plan(inventory, intent),
      replanUpdate: (inventory, intent) => planUpdate(inventory, intent),
      quarantine: createQuarantineModule({
        stateRoot: join(environment.stateDirectory, "lampwright"),
        now: () => fixedTime,
        createId: () => "unused",
        fileSystem: nodeQuarantineFileSystem,
        inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      }),
      processRunner: { run },
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

    const report = await execution.executeUpdate(updatePlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report).toMatchObject({
      status: "succeeded",
      targetResults: [{ status: "unchanged" }],
      verificationResults: [{ status: "passed", changed: false }],
    });
    expect(
      (await inventoryScanner.scan({})).plugins[0]!.availability.status,
    ).toBe("disabled");
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["hash-change", "absent-to-present"] as const)(
    "fails verification when a selected Plugin settings record has a %s",
    async (change) => {
      const fixture = await createTestEnvironment();
      const environment = scanEnvironment(fixture);
      await createManagedFixture(environment);
      await writeJson(join(claudeRoot(environment), "settings.json"), {
        enabledPlugins: { [pluginId]: true },
        ...(change === "hash-change"
          ? { pluginConfigs: { [pluginId]: { mode: "before" } } }
          : {}),
      });
      const inventoryScanner = scanner(environment);
      const initial = await inventoryScanner.scan({});
      const plugin = initial.plugins[0]!;
      const updatePlan = planUpdate(initial, {
        target: { kind: "plugin", pluginBoundaryId: plugin.id },
        force: false,
      });
      const run = vi.fn(async () => {
        await writeJson(join(claudeRoot(environment), "settings.json"), {
          enabledPlugins: { [pluginId]: true },
          pluginConfigs: { [pluginId]: { mode: "after" } },
        });
        return { exitCode: 0, stdout: "updated", stderr: "" };
      });

      const report = await executionModule(
        environment,
        inventoryScanner,
        run,
      ).executeUpdate(updatePlan, {
        grants: [{ kind: "confirmation" }],
      });

      expect(report.targetResults).toEqual([
        expect.objectContaining({ status: "unresolved" }),
      ]);
      expect(report.verificationResults).toEqual([
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({
            message: "the selected Plugin settings records changed",
          }),
        }),
      ]);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("allows an owned Skill to disappear and reports its removed resource", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const { installed } = await createManagedFixture(environment);
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    const run = vi.fn(async () => {
      await rm(join(installed, "skills", "review"), { recursive: true });
      return { exitCode: 0, stdout: "updated", stderr: "" };
    });

    const report = await executionModule(
      environment,
      inventoryScanner,
      run,
    ).executeUpdate(updatePlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report).toMatchObject({
      status: "succeeded",
      targetResults: [{ status: "updated" }],
      verificationResults: [
        {
          status: "passed",
          changed: true,
          details: {
            removedResources: expect.stringContaining("skill:skills/review"),
          },
        },
      ],
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports Owner failure without fallback or automatic rollback", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const { installed } = await createManagedFixture(environment);
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "network failed",
    }));
    const audit = vi.fn(async () => undefined);
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (inventory, intent) => plan(inventory, intent),
      replanUpdate: (inventory, intent) => planUpdate(inventory, intent),
      quarantine: createQuarantineModule({
        stateRoot: join(environment.stateDirectory, "lampwright"),
        now: () => fixedTime,
        createId: () => "unused",
        fileSystem: nodeQuarantineFileSystem,
        inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      }),
      processRunner: { run },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: { write: vi.fn(async () => undefined) },
      updateAuditWriter: { write: audit },
      packageTrustStore: {
        isTrusted: vi.fn(async () => false),
        trust: vi.fn(async () => undefined),
      },
      now: () => fixedTime,
      stateRoot: join(environment.stateDirectory, "lampwright"),
    });

    const report = await execution.executeUpdate(updatePlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report).toMatchObject({
      status: "failed",
      actionResults: [{ status: "failed" }],
      targetResults: [{ status: "failed" }],
      verificationResults: [{ status: "skipped" }],
    });
    expect("fallbackPlans" in report).toBe(false);
    await expect(
      readFile(join(installed, "skills", "review", "SKILL.md")),
    ).resolves.toBeTruthy();
    expect((await inventoryScanner.scan({})).plugins[0]!.version).toBe("1.2.3");
    expect(run).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
  });
});
