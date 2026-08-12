import {
  link,
  lstat,
  mkdir,
  readFile,
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
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
  type PluginBoundary,
  type RemovalTarget,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-08-07T00:00:00.000Z");

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

function commandRunner(
  managerAvailable: boolean,
  managerVersion = "2.1.224",
): InventoryCommandRunner {
  return {
    async run(command) {
      if (command.executable === "claude") {
        return {
          exitCode: managerAvailable ? 0 : null,
          stdout: managerAvailable ? `${managerVersion} (Claude Code)\n` : "",
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

function scanner(
  environment: FixtureEnvironment,
  managerAvailable: boolean,
  managerVersion?: string,
) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner: commandRunner(managerAvailable, managerVersion),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSkill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`,
    "utf8",
  );
}

function claudeRoot(environment: FixtureEnvironment): string {
  return environment.agentHomeDirectories["claude-code"]!;
}

function registryPath(environment: FixtureEnvironment): string {
  return join(claudeRoot(environment), "plugins", "installed_plugins.json");
}

function userSettingsPath(environment: FixtureEnvironment): string {
  return join(claudeRoot(environment), "settings.json");
}

function pluginDataPath(environment: FixtureEnvironment): string {
  return join(
    claudeRoot(environment),
    "plugins",
    "data",
    "quality-suite-acme-marketplace",
  );
}

function installPath(
  environment: FixtureEnvironment,
  marketplace = "acme-marketplace",
  plugin = "quality-suite",
  version = "1.2.3",
): string {
  return join(
    claudeRoot(environment),
    "plugins",
    "cache",
    marketplace,
    plugin,
    version,
  );
}

async function createPluginRoot(
  path: string,
  pluginName = "quality-suite",
): Promise<void> {
  await writeJson(join(path, ".claude-plugin", "plugin.json"), {
    name: pluginName,
    version: "1.2.3",
    description: "Quality tools",
  });
  await writeSkill(join(path, "skills", "review"), "review");
  await writeSkill(join(path, "skills", "lint"), "lint");
  await writeFile(join(path, "commands.md"), "# related\n", "utf8");
  await mkdir(join(path, "commands"), { recursive: true });
  await writeFile(join(path, "commands", "audit.md"), "# audit\n", "utf8");
  await mkdir(join(path, "agents"), { recursive: true });
  await writeFile(join(path, "agents", "reviewer.md"), "# reviewer\n", "utf8");
  await writeJson(join(path, "hooks", "hooks.json"), { hooks: {} });
  await writeJson(join(path, "settings.json"), { agent: "reviewer" });
  await writeJson(join(path, ".mcp.json"), { mcpServers: {} });
}

async function createRegistry(
  environment: FixtureEnvironment,
  records: readonly Record<string, unknown>[],
  pluginKey = "quality-suite@acme-marketplace",
): Promise<void> {
  await writeJson(registryPath(environment), {
    version: 2,
    plugins: { [pluginKey]: records },
  });
}

function pluginTarget(plugin: PluginBoundary): RemovalTarget {
  return { kind: "plugin", pluginBoundaryId: plugin.id };
}

describe("Claude Code plugin adapter", () => {
  it("inventories user plugin skills and complete containing-plugin impact", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    await createPluginRoot(installed);
    await writeJson(join(installed, ".claude-plugin", "plugin.json"), {
      name: "quality-suite",
      version: "1.2.3",
      description: "Quality tools",
      skills: ["./capabilities"],
      commands: "./custom-commands",
      hooks: { hooks: {} },
      mcpServers: { fixture: { command: "fixture-server" } },
      lspServers: {
        fixture: { command: "fixture-lsp", extensionToLanguage: {} },
      },
      experimental: { monitors: [{ name: "watch", command: "watch" }] },
    });
    await writeSkill(join(installed, "capabilities", "security"), "security");
    await mkdir(join(installed, "custom-commands"), { recursive: true });
    await writeFile(
      join(installed, "custom-commands", "secure.md"),
      "# secure\n",
      "utf8",
    );
    await mkdir(pluginDataPath(environment), { recursive: true });
    await createRegistry(environment, [
      {
        scope: "user",
        installPath: installed,
        version: "1.2.3",
        installedAt: "2026-08-01T00:00:00.000Z",
        lastUpdated: "2026-08-02T00:00:00.000Z",
        gitCommitSha: "a".repeat(40),
      },
    ]);
    await writeJson(userSettingsPath(environment), {
      enabledPlugins: { "quality-suite@acme-marketplace": true },
      pluginConfigs: {
        "quality-suite@acme-marketplace": { options: { mode: "strict" } },
      },
      unrelated: { keep: true },
    });

    const inventory = await scanner(environment, true).scan({});
    expect(
      inventory.installations.map((item) => item.skill.name).sort(),
    ).toEqual(["lint", "review", "security"]);
    for (const installation of inventory.installations) {
      expect(installation).toMatchObject({
        classification: "managed-plugin-resource",
        plugin: { id: "quality-suite@acme-marketplace", version: "1.2.3" },
        adapterId: "claude-code.plugins",
        ownership: {
          kind: "plugin",
          pluginId: "quality-suite@acme-marketplace",
          independentlySelectable: false,
          confidence: "declared",
        },
        metadata: {
          "claude-code-plugin": {
            marketplace: "acme-marketplace",
            scope: "user",
            independentlySelectable: false,
          },
        },
      });
    }
    expect(inventory.plugins).toHaveLength(1);
    const plugin = inventory.plugins[0]!;
    expect(plugin.availability).toMatchObject({
      status: "enabled",
      control: {
        kind: "native",
        mechanism: "claude-enabled-plugins",
        selector: { value: "quality-suite@acme-marketplace" },
      },
    });
    expect(plugin.resources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining([
        "agents",
        "commands",
        "hooks",
        "installed-plugin-root",
        "installed-registry-record",
        "inline-hooks",
        "inline-lsp-servers",
        "inline-mcp-servers",
        "inline-monitors",
        "mcp-servers",
        "manifest-commands",
        "scope-settings-record",
        "settings",
        "persistent-data",
        "user-plugin-config-record",
      ]),
    );
    expect(plugin.removal).toMatchObject({
      managed: {
        availability: { kind: "available" },
        externalId: plugin.pluginId,
        invocation: {
          kind: "direct",
          command: {
            executable: "claude",
            arguments: [
              "plugin",
              "uninstall",
              "quality-suite@acme-marketplace",
              "--scope",
              "user",
              "--yes",
            ],
          },
          workingDirectory: { kind: "isolated-temporary" },
        },
      },
      fallback: { kind: "available" },
      primaryArtifactPresent: false,
      recordCleanups: [{}, {}, {}],
    });

    const childPlan = plan(inventory, {
      kind: "targets",
      targets: [
        {
          kind: "installation",
          installationId: inventory.installations[0]!.id,
        },
      ],
      force: false,
      mode: "managed-first",
    });
    expect(childPlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "plugin-boundary",
        pluginId: "quality-suite@acme-marketplace",
        alternative: pluginTarget(plugin),
        overridable: false,
      }),
    );
    expect(childPlan.warnings).toContainEqual(
      expect.objectContaining({
        kind: "plugin-impact",
        target: {
          kind: "installation",
          installationId: inventory.installations[0]!.id,
        },
        affectedResources: expect.arrayContaining([
          "agent:agents",
          "command:commands",
          "hook:inline-hooks",
          "configuration:inline-mcp-servers",
          "skill:lint:" + join(installed, "skills", "lint"),
          "skill:review:" + join(installed, "skills", "review"),
          "skill:security:" + join(installed, "capabilities", "security"),
        ]),
      }),
    );

    expect(() =>
      plan(inventory, {
        kind: "all",
        includePlugins: false,
        force: false,
        mode: "managed-first",
      }),
    ).toThrow("does not select any removable targets");

    const pluginPlan = plan(inventory, {
      kind: "targets",
      targets: [pluginTarget(plugin)],
      force: false,
      mode: "managed-first",
    });
    expect(pluginPlan.actions).toEqual([
      expect.objectContaining({
        kind: "managed-removal",
        target: pluginTarget(plugin),
      }),
    ]);
    expect(pluginPlan.verificationChecks).toContainEqual(
      expect.objectContaining({
        kind: "path-absent",
        path: pluginDataPath(environment),
      }),
    );
    expect(pluginPlan.warnings).toContainEqual(
      expect.objectContaining({
        kind: "plugin-impact",
        target: pluginTarget(plugin),
        affectedResources: expect.arrayContaining([
          "agent:agents",
          "command:commands",
          "hook:hooks",
        ]),
      }),
    );
  });

  it("executes qualified user uninstall and verifies registry state while preserving orphan cache", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    const unrelated = join(
      environment.homeDirectory,
      ".agents",
      "skills",
      "review",
    );
    await createPluginRoot(installed);
    await writeSkill(unrelated, "review");
    await createRegistry(environment, [
      { scope: "user", installPath: installed, version: "1.2.3" },
    ]);
    await writeJson(userSettingsPath(environment), {
      enabledPlugins: {
        "quality-suite@acme-marketplace": true,
        "unrelated@other-marketplace": true,
      },
      pluginConfigs: {
        "quality-suite@acme-marketplace": { options: { mode: "strict" } },
        "unrelated@other-marketplace": { options: { keep: true } },
      },
    });
    const inventoryScanner = scanner(environment, true);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [pluginTarget(plugin)],
      force: false,
      mode: "managed-first",
    });
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toMatchObject({
        command: {
          executable: "claude",
          arguments: [
            "plugin",
            "uninstall",
            "quality-suite@acme-marketplace",
            "--scope",
            "user",
            "--yes",
          ],
        },
        environment: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      });
      expect(request.cwd).toBeTypeOf("string");
      const registry = JSON.parse(
        await readFile(registryPath(environment), "utf8"),
      ) as {
        plugins: Record<string, unknown>;
      };
      delete registry.plugins["quality-suite@acme-marketplace"];
      await writeJson(registryPath(environment), registry);
      const settings = JSON.parse(
        await readFile(userSettingsPath(environment), "utf8"),
      ) as {
        enabledPlugins: Record<string, unknown>;
        pluginConfigs: Record<string, unknown>;
      };
      delete settings.enabledPlugins["quality-suite@acme-marketplace"];
      delete settings.pluginConfigs["quality-suite@acme-marketplace"];
      await writeJson(userSettingsPath(environment), settings);
      return { exitCode: 0, stdout: "uninstalled", stderr: "" };
    });
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (fresh, intent) => plan(fresh, intent),
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
      packageTrustStore: {
        isTrusted: vi.fn(async () => false),
        trust: vi.fn(async () => undefined),
      },
      now: () => fixedTime,
      stateRoot: join(environment.stateDirectory, "lampwright"),
    });

    const report = await execution.execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report).toMatchObject({
      status: "succeeded",
      targetResults: [{ status: "removed" }],
      fallbackPlans: [],
    });
    expect(run).toHaveBeenCalledOnce();
    await expect(
      readFile(join(installed, "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("review");
    await expect(
      readFile(join(unrelated, "SKILL.md"), "utf8"),
    ).resolves.toContain("review");
    const finalInventory = await inventoryScanner.scan({});
    expect(finalInventory.plugins).toEqual([]);
    expect(finalInventory.installations).toEqual([
      expect.objectContaining({
        ownership: { kind: "filesystem", confidence: "inferred" },
        location: expect.objectContaining({ path: unrelated }),
      }),
    ]);
    expect(finalInventory.otherFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "cache-or-vendor-artifact",
          location: expect.objectContaining({
            path: join(installed, "skills", "review"),
          }),
        }),
      ]),
    );
  });

  it("uses project cwd and keeps same-name user and local scope records separate", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const projectInstall = installPath(
      environment,
      "acme-marketplace",
      "project-tools",
      "2.0.0",
    );
    const localInstall = installPath(
      environment,
      "acme-marketplace",
      "local-tools",
      "3.0.0",
    );
    await createPluginRoot(projectInstall, "project-tools");
    await createPluginRoot(localInstall, "local-tools");
    await writeJson(registryPath(environment), {
      version: 2,
      plugins: {
        "project-tools@acme-marketplace": [
          {
            scope: "project",
            projectPath: environment.workspaceDirectory,
            installPath: projectInstall,
            version: "2.0.0",
          },
          {
            scope: "project",
            projectPath: join(fixture.temporary, "other-project"),
            installPath: projectInstall,
            version: "2.0.0",
          },
        ],
        "local-tools@acme-marketplace": [
          {
            scope: "local",
            projectPath: environment.workspaceDirectory,
            installPath: localInstall,
            version: "3.0.0",
          },
        ],
      },
    });
    await writeJson(
      join(environment.workspaceDirectory, ".claude", "settings.json"),
      { enabledPlugins: { "project-tools@acme-marketplace": true } },
    );
    await writeJson(
      join(environment.workspaceDirectory, ".claude", "settings.local.json"),
      { enabledPlugins: { "local-tools@acme-marketplace": true } },
    );

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.plugins).toHaveLength(2);
    const invocations = inventory.plugins.map(
      (plugin) => plugin.removal.managed?.invocation,
    );
    expect(invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "direct",
          command: expect.objectContaining({
            arguments: expect.arrayContaining(["--scope", "project"]),
          }),
          workingDirectory: {
            kind: "exact",
            path: environment.workspaceDirectory,
          },
        }),
        expect.objectContaining({
          kind: "direct",
          command: expect.objectContaining({
            arguments: expect.arrayContaining(["--scope", "local"]),
          }),
          workingDirectory: {
            kind: "exact",
            path: environment.workspaceDirectory,
          },
        }),
      ]),
    );
    expect(
      inventory.installations.filter(
        (installation) => installation.skill.name === "review",
      ),
    ).toHaveLength(2);
    expect(inventory.logicalSkills).toHaveLength(4);
  });

  it("keeps source-only project plugins and orphan caches outside Installation", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(environment.workspaceDirectory, "source-only");
    const orphan = installPath(
      environment,
      "old-marketplace",
      "orphaned",
      "0.1.0",
    );
    await createPluginRoot(orphan, "orphaned");
    const marketplaceRoot = join(
      claudeRoot(environment),
      "plugins",
      "marketplaces",
      "team-catalog",
    );
    const marketplacePlugin = join(
      marketplaceRoot,
      "plugins",
      "catalog-source",
    );
    await createPluginRoot(marketplacePlugin, "catalog-source");
    const outsideMarketplaceSource = join(
      fixture.temporary,
      "outside-marketplace-source",
    );
    const linkedMarketplaceSource = join(
      marketplaceRoot,
      "plugins",
      "linked-source",
    );
    await createPluginRoot(outsideMarketplaceSource, "linked-source");
    await symlink(
      outsideMarketplaceSource,
      linkedMarketplaceSource,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeJson(
      join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
      {
        name: "team-catalog",
        plugins: [
          { name: "catalog-source", source: "./plugins/catalog-source" },
          { name: "linked-source", source: "./plugins/linked-source" },
        ],
      },
    );

    const inventory = await scanner(environment, false).scan({});
    expect(inventory.installations).toEqual([]);
    expect(inventory.plugins).toEqual([]);
    expect(inventory.otherFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "source-artifact",
          location: expect.objectContaining({
            path: join(environment.workspaceDirectory, "skills", "review"),
          }),
        }),
        expect.objectContaining({
          classification: "cache-or-vendor-artifact",
          location: expect.objectContaining({
            path: join(orphan, "skills", "review"),
          }),
        }),
        expect.objectContaining({
          classification: "source-artifact",
          source: { id: "catalog-source@team-catalog", url: null },
          location: expect.objectContaining({
            path: join(marketplacePlugin, "skills", "review"),
          }),
        }),
      ]),
    );
    expect(
      inventory.otherFindings.some((finding) =>
        finding.location.path.startsWith(outsideMarketplaceSource),
      ),
    ).toBe(false);
  });

  it("offers declarative fallback only when the Claude lifecycle is absent", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    await createPluginRoot(installed);
    await createRegistry(environment, [
      { scope: "user", installPath: installed, version: "1.2.3" },
    ]);

    const inventory = await scanner(environment, false).scan({});
    const plugin = inventory.plugins[0]!;
    expect(plugin.removal).toMatchObject({
      managed: {
        availability: {
          kind: "unavailable",
          reason: "the Claude Code executable is not available",
        },
      },
      fallback: { kind: "available", requiresSeparateConfirmation: true },
    });
    const fallback = plan(inventory, {
      kind: "targets",
      targets: [pluginTarget(plugin)],
      force: false,
      mode: "brute-force",
    });
    expect(
      fallback.actions.every((action) =>
        action.approvals.some(
          (approval) => approval.kind === "brute-force-confirmation",
        ),
      ),
    ).toBe(true);
    expect(fallback.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "record-cleanup",
    ]);

    const legacyInventory = await scanner(environment, true, "2.1.211").scan(
      {},
    );
    expect(legacyInventory.plugins[0]?.removal.managed).toMatchObject({
      availability: {
        kind: "unavailable",
        reason:
          "Claude Code 2.1.212 or newer is required for exact marketplace-qualified uninstall",
      },
    });
  });

  it("does not trust a hard-linked installed-plugin registry for removal authority", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    await createPluginRoot(installed);
    await createRegistry(environment, [
      { scope: "user", installPath: installed, version: "1.2.3" },
    ]);
    await link(
      registryPath(environment),
      join(claudeRoot(environment), "plugins", "registry-alias.json"),
    );

    const inventory = await scanner(environment, true).scan({});
    expect(inventory.installations).toEqual([]);
    expect(inventory.plugins).toEqual([]);
    expect(inventory.otherFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "cache-or-vendor-artifact",
          location: expect.objectContaining({
            path: join(installed, "skills", "review"),
          }),
        }),
      ]),
    );
  });

  it("fails closed for unsafe scope settings and duplicate scope records", async () => {
    const unsafeFixture = await createTestEnvironment();
    const unsafeEnvironment = scanEnvironment(unsafeFixture);
    const unsafeInstall = installPath(unsafeEnvironment);
    await createPluginRoot(unsafeInstall);
    await createRegistry(unsafeEnvironment, [
      { scope: "user", installPath: unsafeInstall, version: "1.2.3" },
    ]);
    await writeJson(userSettingsPath(unsafeEnvironment), {
      enabledPlugins: { "quality-suite@acme-marketplace": true },
    });
    await link(
      userSettingsPath(unsafeEnvironment),
      join(claudeRoot(unsafeEnvironment), "settings-alias.json"),
    );

    const unsafeInventory = await scanner(unsafeEnvironment, true).scan({});
    expect(unsafeInventory.plugins[0]?.removal).toMatchObject({
      managed: {
        availability: {
          kind: "unavailable",
          reason:
            "the Claude plugin scope settings are invalid or unsafe to read",
        },
      },
      fallback: {
        kind: "unavailable",
        reason:
          "the Claude plugin scope settings are invalid or unsafe to read",
      },
      recordCleanups: [],
    });

    const duplicateFixture = await createTestEnvironment();
    const duplicateEnvironment = scanEnvironment(duplicateFixture);
    const duplicateInstall = installPath(duplicateEnvironment);
    await createPluginRoot(duplicateInstall);
    const duplicateRecord = {
      scope: "user",
      installPath: duplicateInstall,
      version: "1.2.3",
    };
    await createRegistry(duplicateEnvironment, [
      duplicateRecord,
      duplicateRecord,
    ]);

    const duplicateInventory = await scanner(duplicateEnvironment, true).scan(
      {},
    );
    expect(duplicateInventory.plugins).toHaveLength(1);
    expect(duplicateInventory.plugins[0]?.removal).toMatchObject({
      managed: {
        availability: {
          kind: "unavailable",
          reason:
            "duplicate Claude plugin registry records identify the same scope",
        },
      },
      fallback: { kind: "unavailable" },
    });
  });

  it("offers a separate quarantined fallback after managed failure and preserves unrelated settings", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    await createPluginRoot(installed);
    await createRegistry(environment, [
      { scope: "user", installPath: installed, version: "1.2.3" },
    ]);
    await writeJson(userSettingsPath(environment), {
      enabledPlugins: {
        "quality-suite@acme-marketplace": true,
        "keep@other": true,
      },
      pluginConfigs: {
        "quality-suite@acme-marketplace": { options: { remove: true } },
        "keep@other": { options: { keep: true } },
      },
      future: { keep: true },
    });
    const inventoryScanner = scanner(environment, true);
    const initial = await inventoryScanner.scan({});
    const target = pluginTarget(initial.plugins[0]!);
    const managedPlan = plan(initial, {
      kind: "targets",
      targets: [target],
      force: false,
      mode: "managed-first",
    });
    let quarantineId = 0;
    const execution = createExecutionModule({
      scan: () => inventoryScanner.scan({}),
      replan: (fresh, intent) => plan(fresh, intent),
      quarantine: createQuarantineModule({
        stateRoot: join(environment.stateDirectory, "lampwright"),
        now: () => fixedTime,
        createId: () => `claude-${String((quarantineId += 1))}`,
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
      stateRoot: join(environment.stateDirectory, "lampwright"),
      maxConcurrency: 1,
    });

    const failed = await execution.execute(managedPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(failed.status).toBe("failed");
    expect(failed.fallbackPlans).toHaveLength(1);
    const fallback = failed.fallbackPlans[0]!;
    expect(fallback.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "record-cleanup",
      "record-cleanup",
    ]);
    expect(
      fallback.actions
        .filter((action) => action.kind === "record-cleanup")
        .flatMap((action) =>
          action.records.map((record) => record.recordPointer),
        ),
    ).toEqual(
      expect.arrayContaining([
        "/plugins/quality-suite@acme-marketplace/0",
        "/enabledPlugins/quality-suite@acme-marketplace",
        "/pluginConfigs/quality-suite@acme-marketplace",
      ]),
    );
    const recovered = await execution.execute(fallback, {
      grants: [{ kind: "confirmation" }, { kind: "brute-force-confirmation" }],
    });
    expect(recovered.status).toBe("succeeded");
    await expect(lstat(installed)).rejects.toMatchObject({ code: "ENOENT" });
    const settings = JSON.parse(
      await readFile(userSettingsPath(environment), "utf8"),
    ) as {
      enabledPlugins: Record<string, unknown>;
      pluginConfigs: Record<string, unknown>;
      future: unknown;
    };
    expect(settings).toEqual({
      enabledPlugins: { "keep@other": true },
      pluginConfigs: { "keep@other": { options: { keep: true } } },
      future: { keep: true },
    });
  });

  it("classifies an internal linked skill without following an external source tree", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    await writeJson(join(installed, ".claude-plugin", "plugin.json"), {
      name: "quality-suite",
      version: "1.2.3",
    });
    const internal = join(installed, "shared", "linked-skill");
    const linkPath = join(installed, "skills", "linked-skill");
    await writeSkill(internal, "linked-skill");
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(
      internal,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await createRegistry(environment, [
      { scope: "user", installPath: installed, version: "1.2.3" },
    ]);

    const inventory = await scanner(environment, false).scan({});
    expect(inventory.installations).toEqual([
      expect.objectContaining({
        skill: { name: "linked-skill", description: "linked-skill fixture" },
        location: expect.objectContaining({
          path: linkPath,
          artifactType: expect.objectContaining({
            kind: process.platform === "win32" ? "junction" : "symbolic-link",
            broken: false,
          }),
        }),
      }),
    ]);
  });

  it("keeps an out-of-root linked source Skill out of active plugin installations", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = installPath(environment);
    await writeJson(join(installed, ".claude-plugin", "plugin.json"), {
      name: "quality-suite",
      version: "1.2.3",
    });
    const sourceSkill = join(fixture.temporary, "source-repository", "review");
    const linkPath = join(installed, "skills", "review");
    await writeSkill(sourceSkill, "source-review");
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(
      sourceSkill,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await createRegistry(environment, [
      { scope: "user", installPath: installed, version: "1.2.3" },
    ]);

    const inventory = await scanner(environment, false).scan({});
    expect(inventory.installations).toEqual([]);
    expect(inventory.plugins[0]?.installationIds).toEqual([]);
    expect(inventory.otherFindings).toContainEqual(
      expect.objectContaining({
        classification: "source-artifact",
        skill: { name: "review", description: null },
        location: expect.objectContaining({
          path: linkPath,
          canonicalPath: expect.any(String),
        }),
      }),
    );
    expect(inventory.otherFindings[0]?.location.canonicalPath).not.toBe(
      linkPath,
    );
  });
});
