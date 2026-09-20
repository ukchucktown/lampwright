import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBuiltInSessionSetupConfigurationWriter,
  createSessionSetupScanner,
  executeSessionSetup,
  planSessionSetup,
  type InventoryCommandRunner,
  type SessionSetupSnapshot,
  type SessionSetupTarget,
} from "../src/index.js";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("Claude Code Session setup adapter", () => {
  it("projects local Skills, disabled MCP-only Plugins, exact MCP namespaces, and unavailable accounts", async () => {
    const fixture = await createFixture();
    await writeSkill(join(fixture.claude, "skills", "review"), "review");
    await writeJson(join(fixture.claude, "settings.json"), {
      skillOverrides: { review: "on" },
      enabledPlugins: { "bundle@market": true },
    });
    await writeJson(join(fixture.workspace, ".claude", "settings.json"), {
      skillOverrides: { review: "name-only" },
    });
    await writeJson(join(fixture.workspace, ".claude", "settings.local.json"), {
      skillOverrides: { review: "off" },
      enabledPlugins: { "bundle@market": false },
    });
    const pluginRoot = join(
      fixture.claude,
      "plugins",
      "cache",
      "market",
      "bundle",
      "1.0.0",
    );
    await writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
      name: "bundle",
      version: "1.0.0",
      mcpServers: { package: { command: "package-server" } },
    });
    await writeJson(join(fixture.claude, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "bundle@market": [
          { scope: "user", installPath: pluginRoot, version: "1.0.0" },
        ],
      },
    });
    await writeJson(join(fixture.home, ".claude.json"), {
      mcpServers: {
        user: { command: "user-server", env: { TOKEN: "SECRET_SENTINEL" } },
      },
      projects: {
        [fixture.workspace]: {
          mcpServers: { local: { command: "local-server" } },
          disabledMcpServers: ["user", "plugin:bundle:package"],
          enabledMcpjsonServers: ["project"],
          disabledMcpjsonServers: [],
        },
      },
      claudeAiMcpEverConnected: ["historical-account-name"],
    });
    await writeJson(join(fixture.workspace, ".mcp.json"), {
      mcpServers: { project: { command: "project-server" } },
    });

    const snapshot = await fixture.scan();
    expect(snapshot.harnesses).toEqual(["claude-code"]);
    expect(snapshot.profiles).toEqual([
      expect.objectContaining({
        id: "claude-code-2.1.270",
        qualification: "qualified",
        clientSurface: "cli",
      }),
    ]);
    const skill = target(snapshot, "skill-exposure", "review");
    expect(skill.state).toMatchObject({
      policy: "disabled",
      effectiveWorkspaceState: "disabled",
    });
    expect(skill.control).toMatchObject({
      selector: { kind: "skill-name", name: "review" },
      availability: {
        disable: {
          kind: "available",
          controlScope: {
            kind: "workspace",
            workspacePath: fixture.workspace,
          },
          authority: {
            source: {
              path: join(fixture.workspace, ".claude", "settings.local.json"),
            },
          },
        },
      },
    });
    const plugin = target(snapshot, "plugin", "bundle@market");
    expect(plugin.state.effectiveWorkspaceState).toBe("disabled");
    expect(plugin.childTargetIds).toEqual([]);
    const mcp = snapshot.targets.filter(
      (candidate) => candidate.kind === "mcp-registration",
    );
    expect(mcp.map((candidate) => candidate.serverKey).sort()).toEqual([
      "local",
      "plugin:bundle:package",
      "project",
      "user",
    ]);
    expect(
      mcp.find((candidate) => candidate.serverKey === "user")?.state.policy,
    ).toBe("disabled");
    expect(
      mcp.find((candidate) => candidate.serverKey === "plugin:bundle:package"),
    ).toMatchObject({
      owner: { kind: "plugin", pluginBoundaryId: plugin.pluginBoundaryId },
      state: { policy: "disabled", effectiveWorkspaceState: "disabled" },
      control: {
        selector: {
          policyOwner: { kind: "plugin", pluginId: "bundle@market" },
        },
      },
    });
    expect(
      mcp.find((candidate) => candidate.serverKey === "project")?.state.policy,
    ).toBe("enabled");
    expect(
      snapshot.targets.some(
        (candidate) => candidate.name === "historical-account-name",
      ),
    ).toBe(false);
    expect(snapshot.sources).toContainEqual(
      expect.objectContaining({
        source: { sourceId: "claude-code:account-connectors", path: null },
        status: "unavailable",
        reason: expect.stringContaining("/mcp"),
        targetIds: [],
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_SENTINEL");
  });

  it("executes Skill and MCP availability without changing definitions, approval, credentials, or siblings", async () => {
    const fixture = await createFixture();
    await writeSkill(join(fixture.claude, "skills", "review"), "review");
    await writeJson(join(fixture.claude, "settings.json"), {
      skillOverrides: { review: "on", sibling: "name-only" },
    });
    await writeJson(join(fixture.workspace, ".claude", "settings.local.json"), {
      unrelated: "keep",
    });
    const statePath = join(fixture.home, ".claude.json");
    await writeJson(statePath, {
      mcpServers: {
        user: {
          command: "user-server",
          env: { TOKEN: "SECRET_SENTINEL" },
        },
        sibling: { command: "sibling-server" },
      },
      projects: {
        [fixture.workspace]: {
          disabledMcpServers: [],
          enabledMcpjsonServers: ["user"],
          disabledMcpjsonServers: ["sibling"],
          unrelated: true,
        },
      },
    });

    const run = async (action: "enable" | "disable") => {
      const snapshot = await fixture.scan();
      const skill = target(snapshot, "skill-exposure", "review");
      const server = target(snapshot, "mcp-registration", "user");
      const plan = planSessionSetup(snapshot, {
        schemaVersion: 1,
        kind: "session-setup-intent",
        action,
        harnessId: "claude-code",
        workspace: { path: fixture.workspace },
        targets: [targetRef(skill), targetRef(server)],
      });
      expect(plan.blocks).toEqual([]);
      return executeSessionSetup(
        plan,
        { grants: plan.actions.flatMap((candidate) => candidate.approvals) },
        {
          scan: fixture.scan,
          replan: planSessionSetup,
          configurationWriter: createBuiltInSessionSetupConfigurationWriter(
            fixture.workspace,
          ),
          processRunner: {
            run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          },
          inspectGitProtection: async () => ({ kind: "outside-worktree" }),
          auditWriter: { write: async () => undefined },
          now: () => new Date("2026-09-20T00:00:00.000Z"),
        },
      );
    };

    expect((await run("disable")).status).toBe("succeeded");
    expect(
      JSON.parse(
        await readFile(
          join(fixture.workspace, ".claude", "settings.local.json"),
          "utf8",
        ),
      ),
    ).toEqual({ unrelated: "keep", skillOverrides: { review: "off" } });
    const disabledState = JSON.parse(await readFile(statePath, "utf8"));
    expect(disabledState.projects[fixture.workspace]).toEqual({
      disabledMcpServers: ["user"],
      enabledMcpjsonServers: ["user"],
      disabledMcpjsonServers: ["sibling"],
      unrelated: true,
    });
    expect(disabledState.mcpServers.user.env.TOKEN).toBe("SECRET_SENTINEL");
    expect(disabledState.mcpServers.sibling).toEqual({
      command: "sibling-server",
    });

    expect((await run("enable")).status).toBe("succeeded");
    const enabledState = JSON.parse(await readFile(statePath, "utf8"));
    expect(enabledState.projects[fixture.workspace].disabledMcpServers).toEqual(
      [],
    );
    expect(enabledState.mcpServers.user.env.TOKEN).toBe("SECRET_SENTINEL");
  });

  it("blocks name and server collisions and rejects linked project preferences", async () => {
    const fixture = await createFixture();
    await writeSkill(join(fixture.root, "skills-a", "one"), "duplicate");
    await writeSkill(join(fixture.root, "skills-b", "two"), "duplicate");
    await writeJson(join(fixture.claude, "settings.json"), {});
    const statePath = join(fixture.home, ".claude.json");
    const state = {
      mcpServers: { collision: { command: "user" } },
      projects: {
        [fixture.workspace]: { disabledMcpServers: [] },
      },
    };
    await writeJson(statePath, state);
    await writeJson(join(fixture.workspace, ".mcp.json"), {
      mcpServers: { collision: { command: "project" } },
    });
    const roots = [
      root(fixture.root, "skills-a"),
      root(fixture.root, "skills-b"),
    ];
    const collisionSnapshot = await fixture.scan(roots);
    const collisionServer = target(
      collisionSnapshot,
      "mcp-registration",
      "collision",
    );
    const collisionPlan = planSessionSetup(collisionSnapshot, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "disable",
      harnessId: "claude-code",
      workspace: { path: fixture.workspace },
      targets: [targetRef(collisionServer)],
    });
    expect(collisionPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "selector-collision" }),
    );

    const realState = join(fixture.root, "real-claude-state.json");
    await writeJson(realState, state);
    await rm(statePath);
    await symlink(realState, statePath);
    const snapshot = await fixture.scan(roots);
    const duplicate = target(snapshot, "skill-exposure", "duplicate");
    const skillPlan = planSessionSetup(snapshot, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "disable",
      harnessId: "claude-code",
      workspace: { path: fixture.workspace },
      targets: [targetRef(duplicate)],
    });
    expect(skillPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "selector-collision" }),
    );
    const server = target(snapshot, "mcp-registration", "collision");
    expect(server.control.availability.disable).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("unsafe"),
    });
    const serverPlan = planSessionSetup(snapshot, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "disable",
      harnessId: "claude-code",
      workspace: { path: fixture.workspace },
      targets: [targetRef(server)],
    });
    expect(serverPlan.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unsupported-control" }),
        expect.objectContaining({ kind: "source-invalid" }),
      ]),
    );
  });

  it("reports a malformed installed-owner registry and joins Claude to unfiltered setup scans", async () => {
    const fixture = await createFixture();
    await writeJson(join(fixture.claude, "plugins", "installed_plugins.json"), {
      version: 1,
      plugins: {},
    });
    const claude = await fixture.scan();
    expect(
      claude.targets.filter((candidate) => candidate.kind === "plugin"),
    ).toEqual([]);
    expect(claude.sources).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({
          sourceId: "claude-code:installed-plugins",
        }),
        status: "invalid",
      }),
    );

    const all = await fixture.scanAll();
    expect(all.harnesses).toEqual(["codex", "claude-code"]);
    expect(all.profiles.map((candidate) => candidate.harnessId)).toEqual([
      "codex",
      "claude-code",
    ]);
  });
});

async function createFixture() {
  const rootPath = await realpath(
    await mkdtemp(join(tmpdir(), "lampwright-claude-setup-")),
  );
  temporary.push(rootPath);
  const home = join(rootPath, "home");
  const workspace = join(rootPath, "workspace");
  const claude = join(rootPath, "claude");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(claude, { recursive: true }),
  ]);
  const runner: InventoryCommandRunner = {
    run: async (command) =>
      command.executable === "claude"
        ? { exitCode: 0, stdout: "2.1.270 (Claude Code)\n" }
        : { exitCode: 1, stdout: "" },
  };
  const scanner = createSessionSetupScanner({
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    environment: {
      homeDirectory: home,
      workspaceDirectory: workspace,
      agentHomeDirectories: { "claude-code": claude },
    },
    commandRunner: runner,
  });
  const defaultRoots = [root(claude, "skills")];
  return {
    root: rootPath,
    home,
    workspace,
    claude,
    scan: (roots = defaultRoots) =>
      scanner.scanSessionSetup({
        harnessId: "claude-code",
        workspace: { path: workspace },
        roots,
      }),
    scanAll: () =>
      scanner.scanSessionSetup({
        workspace: { path: workspace },
        roots: defaultRoots,
      }),
  };
}

function root(path: string, name: string) {
  return {
    kind: "agent" as const,
    path: join(path, name),
    agentId: "claude-code",
    adapterId: null,
  };
}

function target<K extends SessionSetupTarget["kind"]>(
  snapshot: SessionSetupSnapshot,
  kind: K,
  name: string,
): Extract<SessionSetupTarget, { kind: K }> {
  const found = snapshot.targets.find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );
  if (!found || found.kind !== kind)
    throw new Error(`missing ${kind} target '${name}'`);
  return found as Extract<SessionSetupTarget, { kind: K }>;
}

function targetRef(target: SessionSetupTarget) {
  switch (target.kind) {
    case "skill-exposure":
      return {
        kind: target.kind,
        targetId: target.id,
        installationId: target.installationId,
      } as const;
    case "plugin":
      return {
        kind: target.kind,
        targetId: target.id,
        pluginBoundaryId: target.pluginBoundaryId,
      } as const;
    case "mcp-registration":
      return {
        kind: target.kind,
        targetId: target.id,
        declarationSourceId: target.declarationSource.sourceId,
        serverKey: target.serverKey,
      } as const;
    case "app-binding":
      return {
        kind: target.kind,
        targetId: target.id,
        declarationSourceId: target.declarationSource.sourceId,
        alias: target.alias,
        connectorId: target.connectorId,
      } as const;
  }
}

async function write(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSkill(path: string, name: string): Promise<void> {
  await write(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`,
  );
}
