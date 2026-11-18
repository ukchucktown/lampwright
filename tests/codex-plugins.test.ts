import {
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  createInventoryScanner,
  createQuarantineModule,
  nodeQuarantineFileSystem,
  plan,
  type ExecutionProcessRequest,
  type InventoryCommand,
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
      codex: join(environment.temporary, "codex-home"),
    },
  };
}

function codexHome(environment: FixtureEnvironment): string {
  return environment.agentHomeDirectories.codex!;
}

function cacheBase(
  environment: FixtureEnvironment,
  marketplace = "acme-marketplace",
  plugin = "quality-suite",
): string {
  return join(codexHome(environment), "plugins", "cache", marketplace, plugin);
}

function activeRoot(
  environment: FixtureEnvironment,
  version = "1.2.3",
): string {
  return join(cacheBase(environment), version);
}

function dataPath(environment: FixtureEnvironment): string {
  return join(
    codexHome(environment),
    "plugins",
    "data",
    "quality-suite-acme-marketplace",
  );
}

function configPath(environment: FixtureEnvironment): string {
  return join(codexHome(environment), "config.toml");
}

const pluginTable =
  '[plugins."quality-suite@acme-marketplace"]\nenabled = true\n';

/** A `[marketplaces.<name>]` table as Codex records it in `config.toml`. */
function marketplaceTable(
  sourceType: "local" | "git",
  source: string,
  name = "acme-marketplace",
): string {
  return `[marketplaces.${name}]\nsource_type = ${JSON.stringify(sourceType)}\nsource = ${JSON.stringify(source)}\n`;
}

async function writeConfig(
  environment: FixtureEnvironment,
  text = pluginTable,
): Promise<void> {
  await mkdir(codexHome(environment), { recursive: true });
  await writeFile(configPath(environment), text, "utf8");
}

function agentDataPath(
  environment: FixtureEnvironment,
  plugin = "quality-suite",
  marketplace = "acme-marketplace",
): string {
  const namespace = createHash("sha256")
    .update(marketplace)
    .update("\0")
    .update(plugin)
    .digest("hex")
    .slice(0, 32);
  return join(
    codexHome(environment),
    "plugins",
    "data",
    "agent-plugins",
    namespace,
  );
}

function commandRunner(
  input: {
    readonly commandSpy?: (command: InventoryCommand) => void;
  } = {},
): InventoryCommandRunner {
  return {
    async run(command) {
      input.commandSpy?.(command);
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
  runner: InventoryCommandRunner,
) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner: runner,
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

async function createPluginRoot(
  root: string,
  manifest: Record<string, unknown> = {
    name: "quality-suite",
    version: "1.2.3",
  },
): Promise<void> {
  await writeJson(join(root, ".codex-plugin", "plugin.json"), manifest);
  await writeSkill(join(root, "skills", "review"), "review");
}

function pluginTarget(plugin: PluginBoundary): RemovalTarget {
  return { kind: "plugin", pluginBoundaryId: plugin.id };
}

describe("Codex plugin adapter", () => {
  it("inventories plugin children, complete collateral, and same-name standalone state", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    const stale = activeRoot(environment, "1.1.0");
    const standalone = join(codexHome(environment), "skills", "review");
    await createPluginRoot(installed, {
      name: "quality-suite",
      version: "1.2.3",
      skills: ["./capabilities"],
      commands: "./custom-commands",
      hooks: { hooks: {} },
      mcpServers: { fixture: { command: "fixture-server" } },
      apps: "./app.json",
      interface: {
        logo: "./assets/logo.png",
        screenshots: ["./assets/screenshot.png"],
      },
    });
    await writeSkill(join(installed, "capabilities", "review"), "review");
    await writeSkill(
      join(installed, ".codex-plugin", "migrated-command-skills", "audit"),
      "audit",
    );
    await mkdir(join(installed, "custom-commands"), { recursive: true });
    await writeFile(
      join(installed, "custom-commands", "audit.md"),
      "# audit\n",
    );
    await writeJson(join(installed, "app.json"), { apps: {} });
    await mkdir(join(installed, "assets"), { recursive: true });
    await writeFile(join(installed, "assets", "logo.png"), "logo");
    await writeFile(join(installed, "assets", "screenshot.png"), "shot");
    await createPluginRoot(stale);
    await writeSkill(standalone, "review");
    await mkdir(dataPath(environment), { recursive: true });
    await mkdir(codexHome(environment), { recursive: true });
    await writeFile(
      configPath(environment),
      '[plugins."quality-suite@acme-marketplace"]\nenabled = true\n',
    );
    const seenCommands: InventoryCommand[] = [];
    const runner = commandRunner({
      commandSpy: (command) => seenCommands.push(command),
    });

    const inventory = await scanner(environment, runner).scan({});
    expect(inventory.plugins[0]?.availability).toMatchObject({
      status: "enabled",
      control: {
        kind: "native",
        mechanism: "codex-plugin-enabled",
        selector: { value: "quality-suite@acme-marketplace" },
      },
    });
    expect(
      seenCommands.filter((command) => command.executable === "codex"),
    ).toEqual([]);
    expect(
      inventory.installations.map((installation) => [
        installation.skill.name,
        installation.classification,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["audit", "managed-plugin-resource"],
        ["review", "managed-plugin-resource"],
        ["review", "active-installation"],
      ]),
    );
    const pluginInstallations = inventory.installations.filter(
      (installation) => installation.adapterId === "codex.plugins",
    );
    expect(pluginInstallations).toHaveLength(2);
    expect(pluginInstallations[0]).toMatchObject({
      plugin: { id: "quality-suite@acme-marketplace", version: "1.2.3" },
      ownership: {
        kind: "plugin",
        independentlySelectable: false,
        confidence: "declared",
      },
      scope: { kind: "user" },
      metadata: {
        "codex-plugin": {
          marketplace: "acme-marketplace",
          independentlySelectable: false,
        },
      },
    });
    const plugin = inventory.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    expect(plugin.resources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining([
        "active-plugin-root",
        "plugin-cache-all-versions",
        "plugin-manifest",
        "manifest-commands",
        "inline-hooks",
        "inline-mcp-servers",
        "manifest-apps",
        "interface-logo",
        "interface-screenshot",
        "migrated-command-skills",
        "persistent-data-retained",
        "stale-cache-version:1.1.0",
      ]),
    );
    expect(plugin.removal).toMatchObject({
      managed: {
        availability: { kind: "available" },
        externalId: "quality-suite@acme-marketplace",
        invocation: {
          kind: "direct",
          command: {
            executable: "codex",
            arguments: [
              "plugin",
              "remove",
              "quality-suite@acme-marketplace",
              "--json",
            ],
          },
          workingDirectory: { kind: "isolated-temporary" },
        },
        effects: [
          { kind: "remove-path", path: cacheBase(environment) },
          { kind: "modify-path", path: configPath(environment) },
        ],
      },
      fallback: { kind: "unavailable" },
    });

    const child = pluginInstallations.find(
      (installation) => installation.skill.name === "review",
    )!;
    const childPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: child.id }],
      force: false,
      mode: "managed-first",
    });
    expect(childPlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "plugin-boundary",
        pluginId: plugin.pluginId,
        alternative: pluginTarget(plugin),
        overridable: false,
      }),
    );
    expect(childPlan.warnings).toContainEqual(
      expect.objectContaining({
        kind: "plugin-impact",
        affectedResources: expect.arrayContaining([
          "other:plugin-cache-all-versions",
          "other:stale-cache-version:1.1.0",
          `skill:audit:${join(installed, ".codex-plugin", "migrated-command-skills", "audit")}`,
          `skill:review:${join(installed, "capabilities", "review")}`,
        ]),
      }),
    );

    const ordinaryAll = plan(inventory, {
      kind: "all",
      includePlugins: false,
      force: false,
      mode: "managed-first",
    });
    expect(ordinaryAll.targets).toEqual([
      expect.objectContaining({ kind: "logical-skill" }),
    ]);
    expect(ordinaryAll.targets).not.toContainEqual(pluginTarget(plugin));

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
        path: cacheBase(environment),
      }),
    );
    expect(pluginPlan.verificationChecks).not.toContainEqual(
      expect.objectContaining({
        kind: "path-absent",
        path: dataPath(environment),
      }),
    );

    const standaloneInstallation = inventory.installations.find(
      (installation) => installation.location.path === standalone,
    )!;
    const standalonePlan = plan(inventory, {
      kind: "targets",
      targets: [
        { kind: "installation", installationId: standaloneInstallation.id },
      ],
      force: false,
      mode: "managed-first",
    });
    expect(standalonePlan.actions).toEqual([
      expect.objectContaining({
        kind: "quarantine",
        target: {
          kind: "installation",
          installationId: standaloneInstallation.id,
        },
      }),
    ]);
    expect(standalonePlan.actions).not.toContainEqual(
      expect.objectContaining({ target: pluginTarget(plugin) }),
    );
    expect(standalonePlan.verificationChecks).not.toContainEqual(
      expect.objectContaining({ path: cacheBase(environment) }),
    );
  });

  it("executes supported removal and verifies plugin and standalone states independently", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    const standalone = join(codexHome(environment), "skills", "review");
    await createPluginRoot(installed);
    await writeSkill(standalone, "review");
    await mkdir(dataPath(environment), { recursive: true });
    await writeConfig(environment);
    const inventoryScanner = scanner(environment, commandRunner());
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [pluginTarget(plugin)],
      force: false,
      mode: "managed-first",
    });
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toMatchObject({
        command: {
          executable: "codex",
          arguments: [
            "plugin",
            "remove",
            "quality-suite@acme-marketplace",
            "--json",
          ],
        },
        environment: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      });
      expect(request.cwd).toBeTypeOf("string");
      await rm(cacheBase(environment), { recursive: true });
      await writeFile(configPath(environment), "[plugins]\n# removed\n");
      return { exitCode: 0, stdout: "{}", stderr: "" };
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
    await expect(lstat(cacheBase(environment))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(dataPath(environment))).resolves.toBeDefined();
    await expect(
      readFile(join(standalone, "SKILL.md"), "utf8"),
    ).resolves.toContain("review");
    const finalInventory = await inventoryScanner.scan({});
    expect(
      finalInventory.plugins.filter(
        (boundary) => boundary.adapterId === "codex.plugins",
      ),
    ).toEqual([]);
    expect(finalInventory.installations).toContainEqual(
      expect.objectContaining({
        location: expect.objectContaining({ path: standalone }),
        ownership: { kind: "filesystem", confidence: "inferred" },
      }),
    );
  });

  it("stops on managed failure without synthesizing cache fallback", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    await writeConfig(environment);
    const inventoryScanner = scanner(environment, commandRunner());
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [pluginTarget(plugin)],
      force: false,
      mode: "managed-first",
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
      processRunner: {
        run: vi.fn(async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "owner failed",
        })),
      },
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
      status: "failed",
      targetResults: [{ status: "failed" }],
      fallbackPlans: [],
    });
    await expect(lstat(cacheBase(environment))).resolves.toBeDefined();
    await expect(readFile(configPath(environment), "utf8")).resolves.toBe(
      pluginTable,
    );
  });

  it.each([
    ["an absent configuration", null],
    ["no Plugin table", "[plugins]\n"],
    ["invalid TOML", "[plugins\n"],
    ["a Plugin value that is not a table", "plugins = true\n"],
    [
      "a Plugin table for another marketplace",
      '[plugins."quality-suite@other-marketplace"]\nenabled = true\n',
    ],
    [
      "an unsafe Plugin table name",
      '[plugins."../quality-suite@acme-marketplace"]\nenabled = true\n',
    ],
    [
      "an enabled value that is not a boolean",
      '[plugins."quality-suite@acme-marketplace"]\nenabled = "yes"\n',
    ],
  ])("keeps cache evidence non-removable for %s", async (_label, config) => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    if (config !== null) await writeConfig(environment, config);
    const inventory = await scanner(environment, commandRunner()).scan({});

    expect(
      inventory.plugins.filter(
        (plugin) => plugin.adapterId === "codex.plugins",
      ),
    ).toEqual([]);
    expect(
      inventory.installations.filter(
        (installation) => installation.adapterId === "codex.plugins",
      ),
    ).toEqual([]);
    expect(inventory.otherFindings).toContainEqual(
      expect.objectContaining({
        classification: "cache-or-vendor-artifact",
        adapterId: "codex.plugins",
        location: expect.objectContaining({ path: activeRoot(environment) }),
        metadata: {
          "codex-plugin": expect.objectContaining({ removalAuthority: false }),
        },
      }),
    );
  });

  it("does not report a Plugin table that has no cache directory", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeConfig(environment);
    await mkdir(cacheBase(environment), { recursive: true });
    await writeFile(join(cacheBase(environment), "1.2.3"), "not a directory");

    const inventory = await scanner(environment, commandRunner()).scan({});

    expect(inventory.plugins).toEqual([]);
    expect(inventory.installations).toEqual([]);
  });

  it("leaves a remote plugin cache with no Plugin table outside every plan", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    const remoteRoot = join(
      cacheBase(environment, "openai-curated-remote", "gmail"),
      "0.1.10",
    );
    await createPluginRoot(remoteRoot, { name: "gmail", version: "0.1.10" });
    await writeConfig(environment);

    const inventory = await scanner(environment, commandRunner()).scan({});

    expect(inventory.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "quality-suite@acme-marketplace",
    ]);
    expect(
      inventory.installations.filter((installation) =>
        installation.location.path.startsWith(remoteRoot),
      ),
    ).toEqual([]);
    expect(inventory.otherFindings).toContainEqual(
      expect.objectContaining({
        classification: "cache-or-vendor-artifact",
        location: expect.objectContaining({ path: remoteRoot }),
        metadata: {
          "codex-plugin": expect.objectContaining({ removalAuthority: false }),
        },
      }),
    );
    expect(
      plan(inventory, {
        kind: "all",
        includePlugins: true,
        force: false,
        mode: "managed-first",
      }).targets,
    ).toEqual([pluginTarget(inventory.plugins[0]!)]);
  });

  it.each([
    [["1.2.3"], "1.2.3"],
    [["1.2.3", "1.2.10", "1.10.0"], "1.10.0"],
    [["1.0.0", "1.0.0-beta"], "1.0.0"],
    [["1.0.0-beta", "1.0.0-alpha"], "1.0.0-beta"],
    [["0.1.13-77c10e110b37", "0.1.13"], "0.1.13"],
    [["26.1111.21308", "26.1112.11011"], "26.1112.11011"],
    [["1.0.0", "local", "2.0.0"], "local"],
    [["2.0", "10.0.0"], "2.0"],
    [["abc", "1.0.0"], "abc"],
  ])(
    "selects the active version of %j as Codex does",
    async (versions, active) => {
      const fixture = await createTestEnvironment();
      const environment = scanEnvironment(fixture);
      for (const version of versions) {
        await createPluginRoot(activeRoot(environment, version));
      }
      await writeFile(join(cacheBase(environment), "9.9.9"), "not a directory");
      await symlink(
        activeRoot(environment, versions[0]),
        join(cacheBase(environment), "latest"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeConfig(environment);

      const inventory = await scanner(environment, commandRunner()).scan({});

      expect(inventory.plugins[0]?.version).toBe(active);
    },
  );

  it("reads the enabled state from the Plugin table", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    await writeConfig(
      environment,
      '[plugins."quality-suite@acme-marketplace"]\nenabled = false\n',
    );
    const disabled = await scanner(environment, commandRunner()).scan({});
    expect(disabled.plugins[0]?.availability.status).toBe("disabled");

    await writeConfig(
      environment,
      '[plugins."quality-suite@acme-marketplace"]\n',
    );
    const defaulted = await scanner(environment, commandRunner()).scan({});
    expect(defaulted.plugins[0]?.availability.status).toBe("enabled");
  });

  it("reports no Plugin when the configuration is linked or hard-linked", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    const configTarget = join(fixture.temporary, "config-target.toml");
    await writeFile(configTarget, pluginTable);
    await symlink(configTarget, configPath(environment), "file");
    const linked = await scanner(environment, commandRunner()).scan({});

    await rm(configPath(environment));
    await link(configTarget, configPath(environment));
    const hardLinked = await scanner(environment, commandRunner()).scan({});

    for (const inventory of [linked, hardLinked]) {
      expect(inventory.plugins).toEqual([]);
      expect(
        inventory.installations.filter(
          (installation) => installation.adapterId === "codex.plugins",
        ),
      ).toEqual([]);
      expect(inventory.otherFindings).toContainEqual(
        expect.objectContaining({
          classification: "cache-or-vendor-artifact",
          location: expect.objectContaining({ path: activeRoot(environment) }),
          metadata: {
            "codex-plugin": expect.objectContaining({
              removalAuthority: false,
              state: "invalid-configuration",
            }),
          },
        }),
      );
    }
  });

  it("accepts dotted Codex plugin names without widening cache traversal", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const root = activeRoot(environment, "1.2.3").replace(
      "quality-suite",
      "quality.suite",
    );
    await createPluginRoot(root, { name: "quality.suite", version: "1.2.3" });
    const entry = { pluginId: "quality.suite@acme-marketplace" };
    await writeConfig(
      environment,
      '[plugins."quality.suite@acme-marketplace"]\nenabled = true\n',
    );
    const inventory = await scanner(environment, commandRunner()).scan({});
    const plugin = inventory.plugins.find(
      (boundary) => boundary.pluginId === entry.pluginId,
    )!;
    expect(plugin.installationIds).toHaveLength(1);
    expect(
      plan(inventory, {
        kind: "targets",
        targets: [pluginTarget(plugin)],
        force: false,
        mode: "managed-first",
      }).actions,
    ).toContainEqual(
      expect.objectContaining({
        kind: "managed-removal",
        target: pluginTarget(plugin),
      }),
    );
  });

  it("recursively inventories legacy Skills while keeping Agent Plugins direct", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    await createPluginRoot(installed);
    await writeSkill(
      join(installed, "skills", "nested", "review"),
      "nested-review",
    );
    await writeConfig(environment);

    const inventory = await scanner(environment, commandRunner()).scan({});
    expect(inventory.installations).toContainEqual(
      expect.objectContaining({
        classification: "managed-plugin-resource",
        location: expect.objectContaining({
          path: join(installed, "skills", "nested", "review"),
        }),
      }),
    );
  });

  it("uses Agent Plugins v1 manifests, defaults, and Codex overlay collateral", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    await writeJson(join(installed, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "quality-suite",
      version: "1.2.3",
      description: "portable plugin",
    });
    await writeJson(join(installed, ".codex-plugin", "plugin.json"), {
      apps: "./app.json",
      hooks: "./hooks.json",
      interface: { logo: "./assets/logo.png" },
    });
    await writeSkill(join(installed, "skills", "review"), "review");
    await writeSkill(join(installed, "skills", "nested", "ignored"), "ignored");
    await writeFile(join(installed, "mcp.json"), "{}\n");
    await writeFile(join(installed, "app.json"), "{}\n");
    await writeFile(join(installed, "hooks.json"), "{}\n");
    await mkdir(join(installed, "assets"), { recursive: true });
    await writeFile(join(installed, "assets", "logo.png"), "logo");
    await mkdir(join(installed, "commands"), { recursive: true });
    await writeFile(join(installed, "commands", "legacy.md"), "# legacy\n");
    await writeFile(join(installed, ".app.json"), "{}\n");
    await writeSkill(
      join(installed, ".codex-plugin", "migrated-command-skills", "legacy"),
      "legacy",
    );
    await mkdir(agentDataPath(environment), { recursive: true });
    await writeConfig(environment);

    const inventory = await scanner(environment, commandRunner()).scan({});
    const plugin = inventory.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    expect(plugin.installationIds).toHaveLength(1);
    expect(inventory.installations).toContainEqual(
      expect.objectContaining({
        location: expect.objectContaining({
          path: join(installed, "skills", "review"),
        }),
      }),
    );
    expect(inventory.installations).not.toContainEqual(
      expect.objectContaining({
        location: expect.objectContaining({
          path: join(installed, "skills", "nested", "ignored"),
        }),
      }),
    );
    expect(plugin.resources.map((resource) => resource.id)).toEqual(
      expect.arrayContaining([
        "plugin-manifest",
        "codex-plugin-overlay",
        "mcp-servers",
        "manifest-apps",
        "manifest-hooks",
        "interface-logo",
        "persistent-data-retained",
      ]),
    );
    expect(plugin.resources).toContainEqual(
      expect.objectContaining({
        id: "persistent-data-retained",
        location: expect.objectContaining({ path: agentDataPath(environment) }),
      }),
    );
    expect(plugin.resources.map((resource) => resource.id)).not.toEqual(
      expect.arrayContaining(["commands", "apps", "migrated-command-skills"]),
    );
  });

  it("fails closed for an unstable root manifest instead of falling through to legacy", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    await createPluginRoot(installed);
    const rootManifestSource = join(fixture.temporary, "unrelated-plugin.json");
    await writeJson(rootManifestSource, { package: "unrelated" });
    await link(rootManifestSource, join(installed, "plugin.json"));
    await writeConfig(environment);

    const inventory = await scanner(environment, commandRunner()).scan({});
    const plugin = inventory.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    expect(plugin.installationIds).toEqual([]);
    expect(plugin.removal.managed?.availability).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("manifest"),
    });
  });

  it("requires a supported manifest and validates Agent Plugin names", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    await writeSkill(join(installed, "skills", "review"), "review");
    await writeConfig(environment);

    const missingManifest = await scanner(environment, commandRunner()).scan(
      {},
    );
    expect(
      missingManifest.plugins.find(
        (boundary) => boundary.adapterId === "codex.plugins",
      )?.removal.managed?.availability,
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("manifest"),
    });
    expect(
      missingManifest.installations.filter(
        (installation) => installation.adapterId === "codex.plugins",
      ),
    ).toEqual([]);

    await writeJson(join(installed, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "Invalid_Name",
    });
    const invalidAgentName = await scanner(environment, commandRunner()).scan(
      {},
    );
    expect(
      invalidAgentName.plugins.find(
        (boundary) => boundary.adapterId === "codex.plugins",
      )?.removal.managed?.availability,
    ).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("manifest"),
    });
  });

  it("demotes external skill links and local source trees without following them as active", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    await createPluginRoot(installed, {
      name: "quality-suite",
      version: "1.2.3",
      skills: ["./capabilities"],
    });
    const outsideSkill = join(fixture.temporary, "outside", "review");
    await writeSkill(outsideSkill, "external-review");
    await mkdir(join(installed, "capabilities"), { recursive: true });
    const linkedSkill = join(installed, "capabilities", "review");
    await symlink(
      outsideSkill,
      linkedSkill,
      process.platform === "win32" ? "junction" : "dir",
    );
    const marketplaceRoot = join(fixture.temporary, "marketplace-source");
    const sourceRoot = join(marketplaceRoot, "plugins", "quality-suite");
    await createPluginRoot(sourceRoot);
    await writeJson(
      join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
      {
        name: "acme-marketplace",
        plugins: [
          {
            name: "quality-suite",
            source: { source: "local", path: "./plugins/quality-suite" },
          },
        ],
      },
    );
    await writeConfig(
      environment,
      pluginTable + marketplaceTable("local", marketplaceRoot),
    );

    const inventory = await scanner(environment, commandRunner()).scan({});
    expect(
      inventory.installations.some(
        (installation) => installation.location.path === linkedSkill,
      ),
    ).toBe(false);
    expect(inventory.otherFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "source-artifact",
          location: expect.objectContaining({ path: linkedSkill }),
        }),
        expect.objectContaining({
          classification: "source-artifact",
          location: expect.objectContaining({
            path: join(sourceRoot, "skills", "review"),
          }),
        }),
      ]),
    );
    expect(
      inventory.plugins.find(
        (boundary) => boundary.adapterId === "codex.plugins",
      )?.removal.managed?.availability,
    ).toEqual({ kind: "available" });
  });

  it("finds the source tree of a Git marketplace in the Codex clone, and ignores a source that escapes it", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    const clone = join(
      codexHome(environment),
      ".tmp",
      "marketplaces",
      "acme-marketplace",
    );
    await createPluginRoot(clone);
    const manifest = join(clone, ".claude-plugin", "marketplace.json");
    await writeJson(manifest, {
      name: "acme-marketplace",
      plugins: [{ name: "quality-suite", source: "./" }],
    });
    await writeConfig(
      environment,
      pluginTable +
        marketplaceTable("git", "https://example.invalid/plugins.git"),
    );
    const sourceSkill = expect.objectContaining({
      classification: "source-artifact",
      location: expect.objectContaining({
        path: join(clone, "skills", "review"),
      }),
    });

    const inside = await scanner(environment, commandRunner()).scan({});
    expect(inside.otherFindings).toContainEqual(sourceSkill);

    await writeJson(manifest, {
      name: "acme-marketplace",
      plugins: [{ name: "quality-suite", source: "../acme-marketplace/.." }],
    });
    const escaping = await scanner(environment, commandRunner()).scan({});
    expect(escaping.plugins).toHaveLength(1);
    expect(escaping.otherFindings).not.toContainEqual(sourceSkill);
  });

  it("keeps broken Codex standalone links independent and blocks linked cache escapes", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const pluginRoot = activeRoot(environment);
    const outsidePlugin = join(fixture.temporary, "outside-plugin");
    await createPluginRoot(outsidePlugin);
    await mkdir(dirname(pluginRoot), { recursive: true });
    await symlink(
      outsidePlugin,
      pluginRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const brokenStandalone = join(codexHome(environment), "skills", "stale");
    await mkdir(dirname(brokenStandalone), { recursive: true });
    await symlink(
      join(fixture.temporary, "missing-skill"),
      brokenStandalone,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeConfig(environment);

    const inventory = await scanner(environment, commandRunner()).scan({});
    expect(inventory.installations).toContainEqual(
      expect.objectContaining({
        status: "broken",
        location: expect.objectContaining({ path: brokenStandalone }),
        adapterId: null,
        pluginBoundaryId: null,
      }),
    );
    const plugin = inventory.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    expect(plugin.installationIds).toEqual([]);
    expect(plugin.removal.managed?.availability).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("linked"),
    });
    expect(plugin.removal.fallback).toMatchObject({ kind: "unavailable" });
  });

  it("rejects escaping manifest paths and preserves supported manifest precedence", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    const installed = activeRoot(environment);
    await writeJson(join(installed, ".codex-plugin", "plugin.json"), {
      name: "quality-suite",
      version: "1.2.3",
      skills: ["../outside"],
    });
    await writeJson(join(installed, ".claude-plugin", "plugin.json"), {
      name: "ignored-lower-precedence",
      version: "1.2.3",
    });
    await writeConfig(environment);
    const inventory = await scanner(environment, commandRunner()).scan({});
    const plugin = inventory.plugins.find(
      (boundary) => boundary.adapterId === "codex.plugins",
    )!;
    expect(plugin.installationIds).toEqual([]);
    expect(plugin.removal.managed?.availability).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("manifest"),
    });
  });

  it("flags a Plugin from a runtime-managed marketplace without withholding removal", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    await writeConfig(
      environment,
      pluginTable +
        marketplaceTable(
          "local",
          join(
            fixture.home,
            ".cache",
            "codex-runtimes",
            "codex-primary-runtime",
            "plugins",
            "acme-marketplace",
          ),
        ),
    );
    const runner = commandRunner();

    const inventory = await scanner(environment, runner).scan({});

    expect(inventory.plugins).toHaveLength(1);
    expect(inventory.plugins[0]).toMatchObject({
      pluginId: "quality-suite@acme-marketplace",
      runtimeDefault: true,
    });
    expect(inventory.plugins[0]?.removal.managed?.availability).toEqual({
      kind: "available",
    });
  });

  it("flags a Plugin staged in the runtime's bundled marketplace directory", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    await writeConfig(
      environment,
      pluginTable +
        marketplaceTable(
          "local",
          join(
            codexHome(environment),
            ".tmp",
            "bundled-marketplaces",
            "acme-marketplace",
          ),
        ),
    );
    const runner = commandRunner();

    const inventory = await scanner(environment, runner).scan({});

    expect(inventory.plugins[0]?.runtimeDefault).toBe(true);
  });

  it("never flags a user marketplace, including one whose name collides or reports no source", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await createPluginRoot(activeRoot(environment));
    const marketplaceTables = [
      marketplaceTable("local", join(fixture.home, "my-marketplaces")),
      marketplaceTable(
        "local",
        join(fixture.home, ".cache", "codex-runtimes-sibling"),
      ),
      marketplaceTable("git", "https://example.invalid/plugins.git"),
      "",
    ];

    for (const table of marketplaceTables) {
      await writeConfig(environment, pluginTable + table);

      const inventory = await scanner(environment, commandRunner()).scan({});

      expect(inventory.plugins).toHaveLength(1);
      expect(inventory.plugins[0]?.runtimeDefault).toBe(false);
    }
  });
});
