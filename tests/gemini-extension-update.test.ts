import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  createInventoryScanner,
  createQuarantineModule,
  nodeQuarantineFileSystem,
  plan,
  planUpdate,
  type ExecutionProcessRunner,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
} from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const execFileAsync = promisify(execFile);
const fixedTime = new Date("2026-08-21T00:00:00.000Z");
const extensionName = "quality-tools";

interface FixtureEnvironment extends InventoryScanEnvironment {
  readonly stateDirectory: string;
}

function scanEnvironment(environment: {
  readonly home: string;
  readonly workspace: string;
  readonly state: string;
}): FixtureEnvironment {
  return {
    homeDirectory: environment.home,
    workspaceDirectory: environment.workspace,
    stateDirectory: environment.state,
  };
}

function geminiHome(environment: FixtureEnvironment): string {
  return join(environment.homeDirectory, ".gemini");
}

function managementRoot(environment: FixtureEnvironment): string {
  return join(geminiHome(environment), "extensions", extensionName);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeExtension(
  environment: FixtureEnvironment,
  version = "1.0.0",
  type: "git" | "local" | "link" | "github-release" = "local",
): Promise<void> {
  const root = managementRoot(environment);
  const source = join(environment.homeDirectory, "extension-source");
  await writeJson(join(root, ".gemini-extension-install.json"), {
    source,
    type,
    autoUpdate: false,
    allowPreRelease: false,
  });
  await writeJson(join(root, "gemini-extension.json"), {
    name: extensionName,
    version,
  });
  await mkdir(join(root, "skills", "review"), { recursive: true });
  await writeFile(
    join(root, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\n",
    "utf8",
  );
  await writeJson(
    join(geminiHome(environment), "extensions", "extension-enablement.json"),
    { [extensionName]: { overrides: [`!${environment.workspaceDirectory}`] } },
  );
}

function commandRunner(): InventoryCommandRunner {
  return {
    async run() {
      return { exitCode: 1, stdout: "" };
    },
  };
}

function realCommandRunner(): InventoryCommandRunner {
  return {
    async run(command) {
      try {
        const result = await execFileAsync(
          command.executable,
          command.arguments,
          {
            encoding: "utf8",
            windowsHide: true,
          },
        );
        return { exitCode: 0, stdout: result.stdout };
      } catch (error: unknown) {
        const failure = error as {
          readonly code?: unknown;
          readonly stdout?: unknown;
        };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        };
      }
    },
  };
}

function scanner(
  environment: FixtureEnvironment,
  runner: InventoryCommandRunner = commandRunner(),
) {
  return createInventoryScanner({
    now: () => fixedTime,
    environment,
    commandRunner: runner,
    executablePresent: async (executable) => executable === "gemini",
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

describe("Gemini extension Managed Update", () => {
  it("plans the exact selected extension operation from offline evidence", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment);

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins.find(
      (candidate) => candidate.pluginId === extensionName,
    )!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.blocks).toEqual([]);
    expect(updatePlan.actions).toHaveLength(1);
    expect(updatePlan.actions[0]).toMatchObject({
      operation: {
        adapterId: "gemini-cli",
        operationId: "update-extension",
        externalId: extensionName,
        invocation: {
          kind: "direct",
          command: {
            executable: "gemini",
            arguments: ["extensions", "update", extensionName],
          },
          workingDirectory: { kind: "isolated-temporary" },
        },
        source: {
          id: expect.stringContaining("local"),
          url: null,
        },
        ref: null,
        scope: { kind: "user" },
        network: { kind: "none" },
        packageDownload: { kind: "none" },
        localChanges: { kind: "unavailable" },
      },
      selectedPlugin: {
        policy: {
          kind: "gemini-extension",
          installType: "local",
          autoUpdate: false,
          allowPreRelease: false,
        },
      },
    });
    expect(updatePlan.actions[0]!.operation.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mutation-root",
          path: managementRoot(environment),
          exists: true,
        }),
        ...[
          join(
            geminiHome(environment),
            "extensions",
            "extension-enablement.json",
          ),
          join(geminiHome(environment), "extension_integrity.json"),
          join(geminiHome(environment), "extension_integrity.json.tmp"),
          join(geminiHome(environment), "integrity.key"),
        ].map((path) =>
          expect.objectContaining({ kind: "configuration-path", path }),
        ),
      ]),
    );
    const effectsByPath = new Map(
      updatePlan.actions[0]!.operation.effects.map((effect) => [
        effect.path,
        effect,
      ]),
    );
    expect(
      effectsByPath.get(
        join(
          geminiHome(environment),
          "extensions",
          "extension-enablement.json",
        ),
      ),
    ).toMatchObject({ exists: true });
    for (const path of [
      join(geminiHome(environment), "extension_integrity.json"),
      join(geminiHome(environment), "extension_integrity.json.tmp"),
      join(geminiHome(environment), "integrity.key"),
    ])
      expect(effectsByPath.get(path)).toMatchObject({
        exists: false,
        protection: { filesystem: { kind: "writable" } },
      });
    expect(
      updatePlan.actions[0]!.operation.effects.some((effect) =>
        effect.path.includes("extension-source"),
      ),
    ).toBe(false);
    expect(plugin.availability.status).toBe("disabled");
    expect(updatePlan.actions[0]!.selectedPlugin?.settingsRecords).toEqual([
      expect.objectContaining({
        recordPointer: `/${extensionName}`,
        present: true,
        digest: { algorithm: "sha256", digest: expect.any(String) },
      }),
    ]);
  });

  it("reports version and resource changes while Native Disable stays effective", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment);
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins.find(
      (candidate) => candidate.pluginId === extensionName,
    )!;
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    const run = vi.fn(async () => {
      await writeJson(
        join(managementRoot(environment), "gemini-extension.json"),
        {
          name: extensionName,
          version: "2.0.0",
        },
      );
      await rm(join(managementRoot(environment), "skills", "review"), {
        recursive: true,
      });
      await mkdir(join(managementRoot(environment), "commands"), {
        recursive: true,
      });
      await writeFile(
        join(managementRoot(environment), "commands", "audit.toml"),
        'description = "Audit"\n',
        "utf8",
      );
      return { exitCode: 0, stdout: "updated", stderr: "" };
    });

    const report = await executionModule(
      environment,
      inventoryScanner,
      run,
    ).executeUpdate(updatePlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          executable: "gemini",
          arguments: ["extensions", "update", extensionName],
        },
        cwd: expect.any(String),
      }),
    );
    expect(report).toMatchObject({
      status: "succeeded",
      targetResults: [{ status: "updated" }],
      verificationResults: [
        {
          status: "passed",
          changed: true,
          details: {
            versionBefore: "1.0.0",
            versionAfter: "2.0.0",
            addedResources: expect.stringContaining("command:commands"),
            removedResources: expect.stringContaining("skill:skills/review"),
          },
        },
      ],
    });
    const finalPlugin = (await inventoryScanner.scan({})).plugins.find(
      (candidate) => candidate.pluginId === extensionName,
    )!;
    expect(finalPlugin.id).toBe(plugin.id);
    expect(finalPlugin.availability.status).toBe("disabled");
  });

  it("materializes Git HEAD and blocks proven dirty content", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment, "1.0.0", "git");
    await writeJson(
      join(managementRoot(environment), ".gemini-extension-install.json"),
      {
        source: "https://git.example.test/acme/quality-tools.git",
        type: "git",
        ref: "stable",
      },
    );
    const head = "a".repeat(40);
    const gitRunner = (dirty: boolean): InventoryCommandRunner => ({
      async run(command) {
        if (
          command.executable === "git" &&
          command.arguments.slice(-2).join(" ") === "rev-parse HEAD"
        )
          return { exitCode: 0, stdout: `${head}\n` };
        if (
          command.executable === "git" &&
          command.arguments.includes("--porcelain=v1")
        )
          return {
            exitCode: 0,
            stdout: dirty ? " M gemini-extension.json\n" : "",
          };
        return { exitCode: 1, stdout: "" };
      },
    });

    const cleanInventory = await scanner(environment, gitRunner(false)).scan(
      {},
    );
    const cleanPlugin = cleanInventory.plugins[0]!;
    const cleanPlan = planUpdate(cleanInventory, {
      target: { kind: "plugin", pluginBoundaryId: cleanPlugin.id },
      force: false,
    });
    expect(cleanPlan.blocks).toEqual([]);
    expect(cleanPlan.actions[0]!.operation).toMatchObject({
      source: {
        id: expect.stringContaining("git:"),
        url: "https://git.example.test/acme/quality-tools.git",
      },
      ref: "stable",
      localChanges: { kind: "unchanged", path: managementRoot(environment) },
      network: { kind: "required" },
    });
    expect(cleanPlan.actions[0]!.operation.currentRevision).toContainEqual(
      expect.objectContaining({
        kind: "content-hash",
        path: managementRoot(environment),
      }),
    );

    const dirtyInventory = await scanner(environment, gitRunner(true)).scan({});
    const dirtyPlugin = dirtyInventory.plugins[0]!;
    const dirtyPlan = planUpdate(dirtyInventory, {
      target: { kind: "plugin", pluginBoundaryId: dirtyPlugin.id },
      force: false,
    });
    expect(dirtyPlan.actions).toEqual([]);
    expect(dirtyPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "local-changes" }),
    );
  });

  it("excludes only Owner metadata from a real Git worktree status", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment, "1.0.0", "git");
    const root = managementRoot(environment);
    const metadataPath = join(root, ".gemini-extension-install.json");
    await rm(metadataPath);
    await execFileAsync("git", ["init", root]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Lampwright Test",
      "-c",
      "user.email=lampwright@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await writeJson(metadataPath, {
      source: "git@github.com:acme/quality-tools.git",
      type: "git",
      ref: "stable",
    });
    const system = realCommandRunner();
    const run = vi.fn(system.run.bind(system));

    const cleanInventory = await scanner(environment, { run }).scan({});
    const cleanPlugin = cleanInventory.plugins.find(
      (candidate) => candidate.pluginId === extensionName,
    )!;
    expect(cleanPlugin.update).toMatchObject({
      kind: "managed",
      operation: { localChanges: { kind: "unchanged" } },
    });
    expect(run).toHaveBeenCalledWith({
      executable: "git",
      arguments: [
        "-C",
        root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude,top).gemini-extension-install.json",
      ],
    });

    await writeFile(join(root, "unrelated.txt"), "local change\n", "utf8");
    const dirtyInventory = await scanner(environment, system).scan({});
    expect(
      dirtyInventory.plugins.find(
        (candidate) => candidate.pluginId === extensionName,
      )!.update,
    ).toMatchObject({
      kind: "managed",
      operation: { localChanges: { kind: "changed" } },
    });
  });

  it.each([
    "git@github.com:acme/quality-tools.git",
    "sso://git.corp.example/acme/quality-tools",
    "github:acme/quality-tools",
    "gitlab:acme/tools/quality-tools",
  ])("accepts recorded Git source syntax %s", async (source) => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment, "1.0.0", "git");
    await writeJson(
      join(managementRoot(environment), ".gemini-extension-install.json"),
      { source, type: "git", ref: "stable" },
    );
    const head = "b".repeat(40);
    const runner: InventoryCommandRunner = {
      async run(command) {
        if (command.arguments.slice(-2).join(" ") === "rev-parse HEAD")
          return { exitCode: 0, stdout: `${head}\n` };
        if (command.arguments.includes("--porcelain=v1"))
          return { exitCode: 0, stdout: "" };
        return { exitCode: 1, stdout: "" };
      },
    };

    const inventory = await scanner(environment, runner).scan({});
    const plugin = inventory.plugins[0]!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.blocks).toEqual([]);
    expect(updatePlan.actions[0]!.operation).toMatchObject({
      source: { id: `gemini-extension:git:${source}` },
      ref: "stable",
    });
  });

  it("uses a GitHub release tag as revision evidence", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment, "1.0.0", "github-release");
    await writeJson(
      join(managementRoot(environment), ".gemini-extension-install.json"),
      {
        source: "acme/quality-tools",
        type: "github-release",
        releaseTag: "v1.0.0",
        autoUpdate: true,
        allowPreRelease: false,
      },
    );

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.blocks).toEqual([]);
    expect(updatePlan.actions[0]!.operation).toMatchObject({
      source: {
        id: "gemini-extension:github-release:acme/quality-tools",
        url: "https://github.com/acme/quality-tools",
      },
      network: { kind: "required" },
    });
    expect(updatePlan.actions[0]!.operation.currentRevision).toContainEqual({
      kind: "owner-value",
      path: join(managementRoot(environment), ".gemini-extension-install.json"),
      format: "json",
      recordPointer: "/releaseTag",
      value: "v1.0.0",
    });
  });

  it("blocks linked, migrated, malformed, and unsafe source state", async () => {
    const linkedFixture = await createTestEnvironment();
    const linkedEnvironment = scanEnvironment(linkedFixture);
    const linkedSource = join(linkedFixture.temporary, "linked-source");
    await writeJson(
      join(managementRoot(linkedEnvironment), ".gemini-extension-install.json"),
      { source: linkedSource, type: "link" },
    );
    await writeJson(join(linkedSource, "gemini-extension.json"), {
      name: extensionName,
      version: "1.0.0",
    });
    const linkedInventory = await scanner(linkedEnvironment).scan({});
    const linkedPlugin = linkedInventory.plugins[0]!;
    expect(
      planUpdate(linkedInventory, {
        target: { kind: "plugin", pluginBoundaryId: linkedPlugin.id },
        force: false,
      }).blocks,
    ).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("linked"),
      }),
    );
    expect(
      linkedPlugin.removal.managed?.effects.some((effect) =>
        effect.path.startsWith(linkedSource),
      ),
    ).toBe(false);

    const migratedFixture = await createTestEnvironment();
    const migratedEnvironment = scanEnvironment(migratedFixture);
    await writeExtension(migratedEnvironment);
    await writeJson(
      join(managementRoot(migratedEnvironment), "gemini-extension.json"),
      {
        name: extensionName,
        version: "1.0.0",
        migratedTo: "replacement",
      },
    );
    const migratedInventory = await scanner(migratedEnvironment).scan({});
    const migratedPlugin = migratedInventory.plugins[0]!;
    expect(
      planUpdate(migratedInventory, {
        target: { kind: "plugin", pluginBoundaryId: migratedPlugin.id },
        force: false,
      }).blocks,
    ).toContainEqual(
      expect.objectContaining({
        kind: "unresolved-update",
        reason: expect.stringContaining("migrated"),
      }),
    );

    const malformedFixture = await createTestEnvironment();
    const malformedEnvironment = scanEnvironment(malformedFixture);
    await writeExtension(malformedEnvironment);
    await writeJson(
      join(managementRoot(malformedEnvironment), "gemini-extension.json"),
      {
        name: extensionName,
        version: "1.0.0",
        contextFileName: "../outside.md",
      },
    );
    expect((await scanner(malformedEnvironment).scan({})).plugins).toEqual([]);

    const unsafeSourceFixture = await createTestEnvironment();
    const unsafeSourceEnvironment = scanEnvironment(unsafeSourceFixture);
    await writeExtension(unsafeSourceEnvironment);
    await writeJson(
      join(
        managementRoot(unsafeSourceEnvironment),
        ".gemini-extension-install.json",
      ),
      { source: "../relative-source", type: "local" },
    );
    const unsafeInventory = await scanner(unsafeSourceEnvironment).scan({});
    const unsafePlugin = unsafeInventory.plugins[0]!;
    expect(
      planUpdate(unsafeInventory, {
        target: { kind: "plugin", pluginBoundaryId: unsafePlugin.id },
        force: false,
      }).blocks,
    ).toContainEqual(expect.objectContaining({ kind: "unresolved-update" }));

    const duplicateFixture = await createTestEnvironment();
    const duplicateEnvironment = scanEnvironment(duplicateFixture);
    const duplicateRoot = managementRoot(duplicateEnvironment);
    await mkdir(duplicateRoot, { recursive: true });
    await writeFile(
      join(duplicateRoot, ".gemini-extension-install.json"),
      `{"source":"first","source":"second","type":"local"}\n`,
      "utf8",
    );
    await writeJson(join(duplicateRoot, "gemini-extension.json"), {
      name: extensionName,
      version: "1.0.0",
    });
    expect((await scanner(duplicateEnvironment).scan({})).plugins).toEqual([]);
  });

  it.each([
    "file:///tmp/quality-tools",
    "ftp://example.test/quality-tools.git",
    "data:text/plain,quality-tools",
    "unknown:acme/quality-tools",
  ])("blocks unsupported Git source scheme %s", async (source) => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment, "1.0.0", "git");
    await writeJson(
      join(managementRoot(environment), ".gemini-extension-install.json"),
      { source, type: "git", ref: "stable" },
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        if (command.arguments.slice(-2).join(" ") === "rev-parse HEAD")
          return { exitCode: 0, stdout: `${"c".repeat(40)}\n` };
        if (command.arguments.includes("--porcelain=v1"))
          return { exitCode: 0, stdout: "" };
        return { exitCode: 1, stdout: "" };
      },
    };

    const inventory = await scanner(environment, runner).scan({});
    const plugin = inventory.plugins[0]!;
    expect(
      planUpdate(inventory, {
        target: { kind: "plugin", pluginBoundaryId: plugin.id },
        force: false,
      }).blocks,
    ).toContainEqual(expect.objectContaining({ kind: "unresolved-update" }));
  });

  it.each(["ref", "releaseTag"] as const)(
    "fails closed on an empty optional install %s",
    async (field) => {
      const fixture = await createTestEnvironment();
      const environment = scanEnvironment(fixture);
      await writeExtension(environment);
      await writeJson(
        join(managementRoot(environment), ".gemini-extension-install.json"),
        {
          source: join(environment.homeDirectory, "extension-source"),
          type: "local",
          [field]: "",
        },
      );

      await expect(scanner(environment).scan({})).resolves.toMatchObject({
        plugins: [],
      });
    },
  );

  it("blocks a protected management root and exact configuration effect", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment);
    await mkdir(join(geminiHome(environment), ".git"));

    const inventory = await scanner(environment).scan({});
    const plugin = inventory.plugins[0]!;
    const updatePlan = planUpdate(inventory, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });

    expect(updatePlan.actions).toEqual([]);
    expect(updatePlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "git-protection" }),
    );
  });

  it("fails verification when the Gemini extension policy changes", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment);
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    const run = vi.fn(async () => {
      await writeJson(
        join(managementRoot(environment), ".gemini-extension-install.json"),
        {
          source: join(environment.homeDirectory, "extension-source"),
          type: "local",
          autoUpdate: true,
          allowPreRelease: false,
        },
      );
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
          message: "the selected Plugin Update policy changed",
        }),
      }),
    ]);
  });

  it("fails verification when enablement changes without changing effective status", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment);
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const plugin = initial.plugins[0]!;
    const updatePlan = planUpdate(initial, {
      target: { kind: "plugin", pluginBoundaryId: plugin.id },
      force: false,
    });
    const run = vi.fn(async () => {
      await writeJson(
        join(
          geminiHome(environment),
          "extensions",
          "extension-enablement.json",
        ),
        {
          [extensionName]: {
            overrides: [
              "!/unrelated/workspace",
              `!${environment.workspaceDirectory}`,
            ],
          },
        },
      );
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
  });

  it("keeps standalone Skills unsupported and never falls back after Owner failure", async () => {
    const fixture = await createTestEnvironment();
    const environment = scanEnvironment(fixture);
    await writeExtension(environment);
    const standalone = join(geminiHome(environment), "skills", "standalone");
    await mkdir(standalone, { recursive: true });
    await writeFile(
      join(standalone, "SKILL.md"),
      "---\nname: standalone\ndescription: Standalone\n---\n",
      "utf8",
    );
    const inventoryScanner = scanner(environment);
    const initial = await inventoryScanner.scan({});
    const installation = initial.installations.find(
      (candidate) => candidate.location.path === standalone,
    )!;
    expect(
      planUpdate(initial, {
        target: { kind: "installation", installationId: installation.id },
        force: false,
      }).blocks,
    ).toContainEqual(expect.objectContaining({ kind: "unsupported-update" }));

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
    const report = await executionModule(
      environment,
      inventoryScanner,
      run,
    ).executeUpdate(updatePlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report).toMatchObject({
      status: "failed",
      actionResults: [{ status: "failed" }],
      targetResults: [{ status: "failed" }],
      verificationResults: [{ status: "skipped" }],
    });
    expect("fallbackPlans" in report).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
