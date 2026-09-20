import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCodexSessionSetupConfigurationEditor,
  createCodexSessionSetupConfigurationWriter,
  createSessionSetupScanner,
  executeSessionSetup,
  planSessionSetup,
  type InventoryCommandRunner,
} from "../src/index.js";
import type { SessionSetupConfigurationRequest } from "../src/session-setup/types.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("Codex Session setup Inventory", () => {
  it("edits only the matching ordered Skill table", () => {
    const selector = {
      kind: "skill-path" as const,
      id: "skill:one",
      path: "/skills/one",
      authority: "exact-target" as const,
      governedTargetIds: ["one"] as const,
    };
    const request: SessionSetupConfigurationRequest = {
      path: "/fixture/config.toml",
      format: "toml",
      exists: true,
      expectedPreimage: null,
      selectors: [selector],
      mutations: [
        {
          kind: "configuration",
          authority: {
            kind: "configuration",
            source: { sourceId: "fixture", path: "/fixture/config.toml" },
            layerSourceId: "fixture",
            layerCanonicalPath: "/fixture/config.toml",
          },
          selectorId: selector.id,
          policy: "disabled",
        },
      ],
    };
    const edited = createCodexSessionSetupConfigurationEditor().edit(
      '# keep\r\n[[skills.config]]\r\npath = "/skills/two"\r\nenabled = true\r\n\r\n[[skills.config]]\r\npath = "/skills/one"\r\nenabled = true # target\r\n',
      request,
    );
    expect(edited).toContain('path = "/skills/two"\r\nenabled = true');
    expect(edited).toContain(
      'path = "/skills/one"\r\nenabled = false # target',
    );
  });

  it("uses installed owner evidence and projects standalone, Plugin, MCP, and shared App policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const pluginRoot = join(
      codex,
      "plugins",
      "cache",
      "market",
      "bundle",
      "1.0.0",
    );
    await skill(join(codex, "skills", "standalone"), "standalone");
    await write(
      join(codex, "config.toml"),
      '[mcp_servers.local]\ncommand = "local"\nenabled = true\n\n[apps.connector]\nenabled = false\n',
    );
    await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
      name: "bundle",
      version: "1.0.0",
      mcpServers: { package: { command: "package" } },
      apps: "./.app.json",
    });
    await writeJson(join(pluginRoot, ".app.json"), {
      apps: {
        left: { id: "connector" },
        right: { id: "connector" },
      },
    });
    const runner: InventoryCommandRunner = {
      run: async (command) =>
        command.executable === "codex"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                installed: [
                  {
                    pluginId: "bundle@market",
                    name: "bundle",
                    marketplaceName: "market",
                    version: "1.0.0",
                    installed: true,
                    enabled: true,
                    source: {
                      source: "git",
                      url: "https://example.test/bundle",
                    },
                    installPolicy: "AVAILABLE",
                    authPolicy: "ON_USE",
                  },
                ],
                available: [],
              }),
            }
          : { exitCode: 1, stdout: "" },
    };
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: runner,
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
      roots: [
        {
          kind: "agent",
          path: join(codex, "skills"),
          agentId: "codex",
          adapterId: null,
        },
      ],
    });
    expect(snapshot.targets.map((target) => target.kind).sort()).toEqual([
      "app-binding",
      "app-binding",
      "mcp-registration",
      "mcp-registration",
      "plugin",
      "skill-exposure",
    ]);
    expect(
      snapshot.targets
        .filter((target) => target.kind === "app-binding")
        .every(
          (target) => target.control.selector.governedTargetIds.length === 2,
        ),
    ).toBe(true);
    expect(
      snapshot.targets.find((target) => target.kind === "plugin")?.owner,
    ).toEqual(expect.objectContaining({ kind: "plugin" }));
    expect(
      snapshot.sources.filter((source) =>
        source.source.sourceId.includes("plugin-descriptor"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "app-binding",
          status: "success",
          reason: null,
          source: expect.objectContaining({
            path: join(pluginRoot, ".app.json"),
          }),
        }),
      ]),
    );
  });

  it("reports malformed installed-owner declarations instead of inventing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const pluginRoot = join(
      codex,
      "plugins",
      "cache",
      "market",
      "broken",
      "1.0.0",
    );
    await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
      name: "broken",
      version: "1.0.0",
      mcpServers: { invalid: "not-a-server" },
    });
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: "broken@market",
                name: "broken",
                marketplaceName: "market",
                version: "1.0.0",
                installed: true,
                enabled: true,
                source: { source: "git", url: "https://example.test/broken" },
                installPolicy: "AVAILABLE",
                authPolicy: "ON_USE",
              },
            ],
            available: [],
          }),
        }),
      },
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
    });
    expect(
      snapshot.targets.filter((target) => target.kind === "mcp-registration"),
    ).toEqual([]);
    expect(snapshot.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mcp-registration",
          status: "invalid",
          reason: expect.stringContaining("invalid declaration"),
        }),
      ]),
    );
  });

  it("does not turn cache-only Plugin material into setup targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    await writeJson(
      join(
        codex,
        "plugins",
        "cache",
        "market",
        "orphan",
        "1.0.0",
        ".codex-plugin",
        "plugin.json",
      ),
      {
        name: "orphan",
        version: "1.0.0",
        mcpServers: { hidden: { command: "hidden" } },
      },
    );
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async (command) =>
          command.executable === "codex"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({ installed: [], available: [] }),
              }
            : { exitCode: 0, stdout: "" },
      },
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
    });
    expect(snapshot.targets).toEqual([]);
    expect(
      snapshot.sources.some(
        (source) =>
          source.status === "success" && source.targetIds.length === 0,
      ),
    ).toBe(true);
  });

  it("reports the single installed-owner query as success, unavailable, or invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    for (const [label, result, status] of [
      [
        "zero",
        {
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
        },
        "success",
      ],
      ["missing", { exitCode: 1, stdout: "" }, "unavailable"],
      ["invalid", { exitCode: 0, stdout: "not json" }, "invalid"],
    ] as const) {
      let calls = 0;
      const scanner = createSessionSetupScanner({
        now: () => new Date("2026-09-20T00:00:00.000Z"),
        environment: {
          homeDirectory: home,
          workspaceDirectory: workspace,
          agentHomeDirectories: { codex },
        },
        commandRunner: { run: async () => ((calls += 1), result) },
      });
      const snapshot = await scanner.scanSessionSetup({
        workspace: { path: workspace },
      });
      expect(calls, label).toBe(1);
      expect(snapshot.sources).toContainEqual(
        expect.objectContaining({
          source: { sourceId: "codex:installed-owner", path: null },
          kind: "plugin",
          status,
          targetIds: [],
        }),
      );
    }
  });

  it("keeps linked, hard-linked, and duplicate-key descriptors non-actionable", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const pluginRoot = join(
      codex,
      "plugins",
      "cache",
      "market",
      "safe",
      "1.0.0",
    );
    await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
      name: "safe",
      version: "1.0.0",
    });
    const descriptor = join(pluginRoot, ".mcp.json");
    const external = join(root, "external.json");
    const installed = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        installed: [
          {
            pluginId: "safe@market",
            name: "safe",
            marketplaceName: "market",
            version: "1.0.0",
            installed: true,
            enabled: true,
            source: { source: "git", url: "https://example.test/safe" },
            installPolicy: "AVAILABLE",
            authPolicy: "ON_USE",
          },
        ],
        available: [],
      }),
    });
    for (const [label, setup] of [
      [
        "hard link",
        async () => {
          await write(external, '{"server":{"command":"safe"}}\n');
          await link(external, descriptor);
        },
      ],
      [
        "duplicate key",
        async () => {
          await write(
            descriptor,
            '{"server":{"command":"first"},"server":{"command":"second"}}\n',
          );
        },
      ],
      ...(process.platform === "win32"
        ? []
        : ([
            [
              "symbolic link",
              async () => {
                await write(external, '{"server":{"command":"safe"}}\n');
                await symlink(external, descriptor, "file");
              },
            ],
          ] as const)),
    ] as const) {
      await rm(descriptor, { force: true });
      await setup();
      const scanner = createSessionSetupScanner({
        now: () => new Date("2026-09-20T00:00:00.000Z"),
        environment: {
          homeDirectory: home,
          workspaceDirectory: workspace,
          agentHomeDirectories: { codex },
        },
        commandRunner: { run: async () => installed() },
      });
      const snapshot = await scanner.scanSessionSetup({
        workspace: { path: workspace },
      });
      expect(
        snapshot.targets.filter((target) => target.kind === "mcp-registration"),
        label,
      ).toEqual([]);
      expect(snapshot.sources).toContainEqual(
        expect.objectContaining({
          kind: "mcp-registration",
          status: label === "duplicate key" ? "invalid" : "incomplete",
        }),
      );
    }
  });

  it("discovers inline, referenced, default, and overlay declarations without merging colliding owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const plugin = (name: string) =>
      join(codex, "plugins", "cache", "market", name, "1.0.0");
    await writeJson(join(plugin("inline"), ".codex-plugin", "plugin.json"), {
      name: "inline",
      version: "1.0.0",
      mcpServers: { same: { command: "inline" } },
    });
    await writeJson(
      join(plugin("referenced"), ".codex-plugin", "plugin.json"),
      {
        name: "referenced",
        version: "1.0.0",
        apps: "./apps.json",
        mcpServers: "./servers.json",
      },
    );
    await writeJson(join(plugin("referenced"), "apps.json"), {
      apps: {
        same: { id: "shared" },
        requiredOne: { id: "required-one", required: true },
        requiredTwo: { id: "required-two", required: true },
      },
    });
    await writeJson(join(plugin("referenced"), "servers.json"), {
      same: { command: "default" },
    });
    await writeJson(join(plugin("default"), ".codex-plugin", "plugin.json"), {
      name: "default",
      version: "1.0.0",
    });
    await writeJson(join(plugin("default"), ".mcp.json"), {
      same: { command: "default" },
    });
    await writeJson(join(plugin("overlay"), "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "overlay",
      version: "1.0.0",
    });
    await writeJson(join(plugin("overlay"), ".codex-plugin", "plugin.json"), {
      apps: "./overlay-apps.json",
      mcpServers: { same: { command: "overlay" } },
    });
    await writeJson(join(plugin("overlay"), "overlay-apps.json"), {
      apps: { same: { id: "shared" } },
    });
    await write(
      join(codex, "config.toml"),
      '[plugins."overlay@market"]\nenabled = false\n',
    );
    const entries = ["default", "inline", "referenced", "overlay"].map(
      (name) => ({
        pluginId: `${name}@market`,
        name,
        marketplaceName: "market",
        version: "1.0.0",
        installed: true,
        enabled: name !== "overlay",
        source: { source: "git", url: `https://example.test/${name}` },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
      }),
    );
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: entries, available: [] }),
        }),
      },
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
    });
    const mcps = snapshot.targets.filter(
      (target) => target.kind === "mcp-registration",
    );
    const pluginBoundary = (pluginId: string) => {
      const target = snapshot.targets.find(
        (item) =>
          item.kind === "plugin" && item.pluginId === `${pluginId}@market`,
      );
      if (!target || target.kind !== "plugin")
        throw new Error("expected the installed Plugin boundary");
      return target.pluginBoundaryId;
    };
    expect(
      snapshot.targets.find(
        (target) =>
          target.kind === "plugin" && target.pluginId === "overlay@market",
      )?.state.effectiveWorkspaceState,
    ).toBe("disabled");
    expect(mcps.filter((target) => target.name === "same")).toHaveLength(4);
    expect(
      new Set(
        mcps
          .filter((target) => target.name === "same")
          .map((target) =>
            target.owner.kind === "plugin"
              ? target.owner.pluginBoundaryId
              : null,
          ),
      ).size,
    ).toBe(4);
    expect(
      mcps.find(
        (target) =>
          target.owner.kind === "plugin" &&
          target.owner.pluginBoundaryId === pluginBoundary("overlay"),
      )?.state.effectiveWorkspaceState,
    ).toBe("disabled");
    const shared = snapshot.targets.filter(
      (target) =>
        target.kind === "app-binding" && target.connectorId === "shared",
    );
    expect(shared).toHaveLength(2);
    expect(
      shared.every(
        (target) => target.control.selector.governedTargetIds.length === 2,
      ),
    ).toBe(true);
    const referencedMcp = mcps.find(
      (target) =>
        target.owner.kind === "plugin" &&
        target.owner.pluginBoundaryId === pluginBoundary("referenced"),
    )!;
    expect(
      snapshot.dependencies.filter(
        (dependency) => dependency.dependent.targetId === referencedMcp.id,
      ),
    ).toHaveLength(2);
  });

  it("keeps a missing installed-owner descriptor non-actionable", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const pluginRoot = join(
      codex,
      "plugins",
      "cache",
      "market",
      "missing",
      "1.0.0",
    );
    await writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
      name: "missing",
      version: "1.0.0",
      apps: "./absent.json",
    });
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: "missing@market",
                name: "missing",
                marketplaceName: "market",
                version: "1.0.0",
                installed: true,
                enabled: true,
                source: { source: "git", url: "https://example.test/missing" },
                installPolicy: "AVAILABLE",
                authPolicy: "ON_USE",
              },
            ],
            available: [],
          }),
        }),
      },
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
    });
    expect(snapshot.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mcp-registration",
          status: "invalid",
        }),
      ]),
    );
    expect(
      snapshot.targets.filter((target) => target.kind === "app-binding"),
    ).toEqual([]);
  });

  it("rejects invalid app-only declarations without suppressing an independent MCP-only owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    const plugin = (name: string) =>
      join(codex, "plugins", "cache", "market", name, "1.0.0");
    await writeJson(join(plugin("apps"), ".codex-plugin", "plugin.json"), {
      name: "apps",
      version: "1.0.0",
      apps: "./apps.json",
    });
    await writeJson(join(plugin("apps"), "apps.json"), {
      apps: { unsafe: { id: "connector", extra: true } },
    });
    await writeJson(join(plugin("mcp"), ".codex-plugin", "plugin.json"), {
      name: "mcp",
      version: "1.0.0",
      mcpServers: "./servers.json",
    });
    await writeJson(join(plugin("mcp"), "servers.json"), {
      only: { command: "server" },
    });
    const entries = ["apps", "mcp"].map((name) => ({
      pluginId: `${name}@market`,
      name,
      marketplaceName: "market",
      version: "1.0.0",
      installed: true,
      enabled: true,
      source: { source: "git", url: `https://example.test/${name}` },
      installPolicy: "AVAILABLE",
      authPolicy: "ON_USE",
    }));
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: entries, available: [] }),
        }),
      },
    });
    const snapshot = await scanner.scanSessionSetup({
      workspace: { path: workspace },
    });
    expect(
      snapshot.targets.filter((target) => target.kind === "app-binding"),
    ).toEqual([]);
    expect(
      snapshot.targets.filter(
        (target) =>
          target.kind === "mcp-registration" && target.name === "only",
      ),
    ).toHaveLength(1);
    expect(snapshot.sources).toContainEqual(
      expect.objectContaining({ kind: "app-binding", status: "invalid" }),
    );
  });

  it("prefers a trusted workspace MCP policy and executes both native directions", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    await write(
      join(codex, "config.toml"),
      '[mcp_servers.shared]\ncommand = "user"\nenabled = true\n# SECRET_SENTINEL\n',
    );
    const projectPath = join(workspace, ".codex", "config.toml");
    await write(
      projectPath,
      '# workspace comment\n[mcp_servers.shared]\ncommand = "project"\nenabled = true\n',
    );
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
        }),
      },
    });
    const scan = () =>
      scanner.scanSessionSetup({
        workspace: { path: workspace },
        workspaceTrusted: true,
      });
    const initial = await scan();
    const project = initial.targets.find(
      (target) =>
        target.kind === "mcp-registration" &&
        target.definitionScope.kind === "workspace",
    );
    expect(project).toBeDefined();
    expect(project?.control.availability.disable).toMatchObject({
      kind: "available",
      controlScope: { kind: "workspace", workspacePath: workspace },
    });
    const run = async (action: "enable" | "disable") => {
      const current = await scan();
      const target = current.targets.find((item) => item.id === project!.id)!;
      if (target.kind !== "mcp-registration")
        throw new Error(
          "expected the selected target to remain an MCP registration",
        );
      const plan = planSessionSetup(current, {
        schemaVersion: 1,
        kind: "session-setup-intent",
        action,
        harnessId: "codex",
        workspace: { path: workspace },
        targets: [
          {
            kind: "mcp-registration",
            targetId: target.id,
            declarationSourceId: target.declarationSource.sourceId,
            serverKey: target.serverKey,
          },
        ],
      });
      expect(plan.blocks).toEqual([]);
      return executeSessionSetup(
        plan,
        { grants: plan.actions.flatMap((item) => item.approvals) },
        {
          scan,
          replan: planSessionSetup,
          configurationWriter: createCodexSessionSetupConfigurationWriter(),
          processRunner: {
            run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          },
          inspectGitProtection: async () => ({ kind: "outside-worktree" }),
          auditWriter: { write: async () => undefined },
          now: () => new Date("2026-09-20T00:00:00.000Z"),
        },
      );
    };
    const disabled = await run("disable");
    expect(disabled.actionResults).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);
    expect(disabled.status).toBe("succeeded");
    expect(await readFile(projectPath, "utf8")).toContain("enabled = false");
    expect(await readFile(join(codex, "config.toml"), "utf8")).toContain(
      "SECRET_SENTINEL",
    );
    expect((await run("enable")).status).toBe("succeeded");
    expect(await readFile(projectPath, "utf8")).toContain("enabled = true");
  });

  it("keeps layered MCP evidence and blocks unknown or untrusted project policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const codex = join(root, "codex");
    await write(
      join(codex, "config.toml"),
      "[mcp_servers.shared]\nenabled = true\n",
    );
    await write(
      join(workspace, ".codex", "config.toml"),
      "[mcp_servers.shared]\nenabled = false\n",
    );
    const scanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async (command) =>
          command.executable === "codex"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({ installed: [], available: [] }),
              }
            : { exitCode: 0, stdout: "" },
      },
    });
    const trusted = await scanner.scanSessionSetup({
      workspace: { path: workspace },
      workspaceTrusted: true,
    });
    const trustedTargets = trusted.targets.filter(
      (item) => item.kind === "mcp-registration",
    );
    expect(trustedTargets).toHaveLength(2);
    expect(new Set(trustedTargets.map((item) => item.id)).size).toBe(2);
    expect(
      trustedTargets.map((item) => item.definitionScope.kind).sort(),
    ).toEqual(["user", "workspace"]);
    expect(
      trustedTargets.every(
        (item) => item.state.effectiveWorkspaceState === "disabled",
      ),
    ).toBe(true);
    expect(
      trustedTargets.every(
        (item) =>
          new Set(item.control.layers.map((layer) => layer.source.path))
            .size === 2,
      ),
    ).toBe(true);
    for (const trust of [false, null] as const) {
      const snapshot = await scanner.scanSessionSetup({
        workspace: { path: workspace },
        workspaceTrusted: trust,
      });
      const target = snapshot.targets.find(
        (item) => item.kind === "mcp-registration",
      )!;
      expect(target.control.layers).toHaveLength(2);
      expect(target.control.layers.map((layer) => layer.applies)).toEqual([
        true,
        trust === false ? false : "unresolved",
      ]);
      const plan = planSessionSetup(snapshot, {
        schemaVersion: 1,
        kind: "session-setup-intent",
        action: "disable",
        harnessId: "codex",
        workspace: { path: workspace },
        targets: [
          {
            kind: "mcp-registration",
            targetId: target.id,
            declarationSourceId: target.declarationSource.sourceId,
            serverKey: target.serverKey,
          },
        ],
      });
      if (trust === false) {
        expect(plan.blocks).toEqual([]);
        expect(plan.actions).toHaveLength(1);
        expect(plan.actions[0]?.approvals).toContainEqual({
          kind: "scope-disclosure",
          scope: { kind: "user" },
          required: true,
        });
      } else {
        expect(plan.actions).toEqual([]);
        expect(
          plan.blocks.some((block) => block.kind === "unsupported-control"),
        ).toBe(true);
      }
    }

    await mkdir(join(workspace, ".git"), { recursive: true });
    const protectedScanner = createSessionSetupScanner({
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      environment: {
        homeDirectory: home,
        workspaceDirectory: workspace,
        agentHomeDirectories: { codex },
      },
      commandRunner: {
        run: async (command) =>
          command.executable === "codex"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({ installed: [], available: [] }),
              }
            : { exitCode: 1, stdout: "" },
      },
    });
    const protectedSnapshot = await protectedScanner.scanSessionSetup({
      workspace: { path: workspace },
      workspaceTrusted: true,
    });
    const protectedTarget = protectedSnapshot.targets.find(
      (item) =>
        item.kind === "mcp-registration" &&
        item.definitionScope.kind === "user",
    )!;
    if (protectedTarget.kind !== "mcp-registration")
      throw new Error("expected the user MCP declaration");
    const protectedPlan = planSessionSetup(protectedSnapshot, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "disable",
      harnessId: "codex",
      workspace: { path: workspace },
      targets: [
        {
          kind: "mcp-registration",
          targetId: protectedTarget.id,
          declarationSourceId: protectedTarget.declarationSource.sourceId,
          serverKey: protectedTarget.serverKey,
        },
      ],
    });
    expect(protectedPlan.blocks.map((block) => block.kind)).toContain(
      "protected",
    );
  });

  it("falls back to user MCP policy when an empty trusted project layer is protected or unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-codex-setup-"));
    temporary.push(root);
    const home = join(root, "home");
    const codex = join(root, "codex");
    await write(
      join(codex, "config.toml"),
      "[mcp_servers.user]\nenabled = true\n",
    );
    for (const [label, setup] of [
      [
        "protected",
        async (workspace: string) =>
          mkdir(join(workspace, ".git"), { recursive: true }),
      ],
      [
        "unsafe",
        async (workspace: string) => {
          const source = join(root, "unsafe-project.toml");
          await write(source, "# no MCP declaration\n");
          await mkdir(join(workspace, ".codex"), { recursive: true });
          await link(source, join(workspace, ".codex", "config.toml"));
        },
      ],
    ] as const) {
      const workspace = join(root, label);
      const scanner = createSessionSetupScanner({
        now: () => new Date("2026-09-20T00:00:00.000Z"),
        environment: {
          homeDirectory: home,
          workspaceDirectory: workspace,
          agentHomeDirectories: { codex },
        },
        commandRunner: {
          run: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ installed: [], available: [] }),
          }),
        },
      });
      await setup(workspace);
      const snapshot = await scanner.scanSessionSetup({
        workspace: { path: workspace },
        workspaceTrusted: true,
      });
      const target = snapshot.targets.find(
        (item) => item.kind === "mcp-registration",
      )!;
      if (target.kind !== "mcp-registration")
        throw new Error("expected the user MCP declaration");
      const plan = planSessionSetup(snapshot, {
        schemaVersion: 1,
        kind: "session-setup-intent",
        action: "disable",
        harnessId: "codex",
        workspace: { path: workspace },
        targets: [
          {
            kind: "mcp-registration",
            targetId: target.id,
            declarationSourceId: target.declarationSource.sourceId,
            serverKey: target.serverKey,
          },
        ],
      });
      expect(plan.blocks, label).toEqual([]);
      expect(plan.actions[0]?.approvals, label).toContainEqual({
        kind: "scope-disclosure",
        scope: { kind: "user" },
        required: true,
      });
    }
  });
});

async function write(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await write(path, `${JSON.stringify(value)}\n`);
}
async function skill(path: string, name: string): Promise<void> {
  await write(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}
