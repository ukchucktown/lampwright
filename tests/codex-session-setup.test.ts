import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
        }),
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
        expect.objectContaining({ kind: "mcp-registration", status: "invalid" }),
      ]),
    );
    expect(
      snapshot.targets.filter((target) => target.kind === "app-binding"),
    ).toEqual([]);
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
          inspectGitProtection: async () => ({ kind: "unprotected" }),
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
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
        }),
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
      expect(plan.actions).toEqual([]);
      expect(
        plan.blocks.some((block) => block.kind === "unsupported-control"),
      ).toBe(true);
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
