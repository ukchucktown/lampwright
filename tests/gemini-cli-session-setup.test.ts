import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBuiltInSessionSetupConfigurationWriter,
  createSessionSetupScanner,
  executeSessionSetup,
  planSessionSetup,
  type InventoryCommandRunner,
  type SessionSetupConfigurationWriter,
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

describe("Gemini CLI Session setup adapter", () => {
  it("projects Skill unions, MCP-only extensions, user-wide MCP policy, and unsupported account apps", async () => {
    const fixture = await createFixture(true);
    await writeSkill(join(fixture.gemini, "skills", "review"), "review");
    await writeJson(join(fixture.gemini, "settings.json"), {
      skills: { disabled: ["review"] },
      mcpServers: {
        user: { command: "user-server", env: { TOKEN: "SECRET_SENTINEL" } },
      },
    });
    await writeJson(join(fixture.workspace, ".gemini", "settings.json"), {
      skills: { disabled: ["review"] },
      mcpServers: { workspace: { command: "workspace-server" } },
    });
    await writeExtension(fixture, "bundle", {
      mcpServers: { package: { command: "package-server" } },
    });
    await writeJson(
      join(fixture.gemini, "extensions", "extension-enablement.json"),
      { bundle: { overrides: [`!${fixture.workspace}`] } },
    );
    await writeJson(join(fixture.gemini, "mcp-server-enablement.json"), {
      user: { enabled: false },
      package: { enabled: false },
    });

    const snapshot = await fixture.scan();
    expect(fixture.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ executable: "gemini" }),
    );
    expect(snapshot.harnesses).toEqual(["gemini-cli"]);
    expect(snapshot.profiles).toEqual([
      expect.objectContaining({
        id: "gemini-cli-0.59.0",
        qualification: "qualified",
        clientSurface: "cli",
      }),
    ]);
    const skill = target(snapshot, "skill-exposure", "review");
    expect(skill.state).toMatchObject({
      policy: "disabled",
      effectiveWorkspaceState: "disabled",
    });
    expect(skill.control.availability.enable).toMatchObject({
      kind: "available",
      controlScope: { kind: "user" },
      additionalControls: [
        {
          controlScope: {
            kind: "workspace",
            workspacePath: fixture.workspace,
          },
        },
      ],
    });
    const plugin = target(snapshot, "plugin", "bundle");
    expect(plugin).toMatchObject({
      childTargetIds: [],
      state: { effectiveWorkspaceState: "disabled" },
      control: {
        availability: {
          enable: {
            kind: "available",
            controlScope: {
              kind: "workspace",
              workspacePath: fixture.workspace,
            },
          },
        },
      },
    });
    const mcp = snapshot.targets.filter(
      (candidate) => candidate.kind === "mcp-registration",
    );
    expect(mcp.map((candidate) => candidate.serverKey).sort()).toEqual([
      "package",
      "user",
      "workspace",
    ]);
    expect(target(snapshot, "mcp-registration", "user")).toMatchObject({
      state: { policy: "disabled", effectiveWorkspaceState: "disabled" },
      control: {
        availability: {
          enable: { kind: "available", controlScope: { kind: "user" } },
        },
      },
    });
    expect(target(snapshot, "mcp-registration", "package")).toMatchObject({
      owner: { kind: "plugin", pluginBoundaryId: plugin.pluginBoundaryId },
      state: { policy: "disabled", effectiveWorkspaceState: "disabled" },
      control: {
        selector: {
          policyOwner: { kind: "plugin", pluginId: "bundle" },
        },
      },
    });
    expect(snapshot.sources).toContainEqual(
      expect.objectContaining({
        source: { sourceId: "gemini-cli:account-apps", path: null },
        status: "unavailable",
        targetIds: [],
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_SENTINEL");
  });

  it("executes complete setup while preserving definitions, credentials, comments, siblings, and wider rules", async () => {
    const fixture = await createFixture(true);
    await writeSkill(join(fixture.gemini, "skills", "review"), "review");
    const userSettings = join(fixture.gemini, "settings.json");
    const workspaceSettings = join(
      fixture.workspace,
      ".gemini",
      "settings.json",
    );
    await write(
      userSettings,
      '{\n  // retain user comment\n  "skills": { "disabled": ["review", "sibling"] },\n  "mcpServers": { "standalone": { "env": { "TOKEN": "SECRET_SENTINEL" } } }\n}\n',
    );
    await write(
      workspaceSettings,
      '{\n  // retain workspace comment\n  "skills": { "disabled": ["review"] },\n  "unrelated": true\n}\n',
    );
    const manifestPath = await writeExtension(fixture, "bundle", {
      mcpServers: {
        docs: {
          command: "docs-server",
          env: { TOKEN: "SECRET_SENTINEL" },
        },
      },
    });
    const extensionPolicy = join(
      fixture.gemini,
      "extensions",
      "extension-enablement.json",
    );
    await writeJson(extensionPolicy, {
      bundle: { overrides: ["!/other/*", `!${fixture.workspace}`] },
      sibling: { overrides: ["!/keep/*"] },
    });
    const mcpPolicy = join(fixture.gemini, "mcp-server-enablement.json");
    await writeJson(mcpPolicy, {
      docs: { enabled: false },
      sibling: { enabled: false, keep: true },
    });

    const snapshot = await fixture.scan();
    const skill = target(snapshot, "skill-exposure", "review");
    const plugin = target(snapshot, "plugin", "bundle");
    const server = target(snapshot, "mcp-registration", "docs");
    const plan = planSessionSetup(snapshot, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "enable",
      harnessId: "gemini-cli",
      workspace: { path: fixture.workspace },
      targets: [targetRef(skill), targetRef(plugin), targetRef(server)],
    });
    expect(plan.blocks).toEqual([]);
    expect(plan.actions).toHaveLength(4);
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({
        kind: "control-scope",
        target: targetRef(skill),
        scope: { kind: "user" },
      }),
    );
    const report = await executeSessionSetup(
      plan,
      { grants: plan.actions.flatMap((candidate) => candidate.approvals) },
      executionOptions(fixture),
    );
    expect(report.status).toBe("succeeded");

    const userText = await readFile(userSettings, "utf8");
    const workspaceText = await readFile(workspaceSettings, "utf8");
    expect(userText).toContain("retain user comment");
    expect(userText).toContain("sibling");
    expect(userText).toContain("SECRET_SENTINEL");
    expect(userText).not.toContain('"review"');
    expect(workspaceText).toContain("retain workspace comment");
    expect(workspaceText).toContain('"unrelated": true');
    expect(workspaceText).not.toContain('"review"');

    const extensionValue = JSON.parse(await readFile(extensionPolicy, "utf8"));
    expect(extensionValue.sibling).toEqual({ overrides: ["!/keep/*"] });
    expect(extensionValue.bundle.overrides).toContain("!/other/*");
    expect(extensionValue.bundle.overrides.at(-1)).toContain(fixture.workspace);
    expect(extensionValue.bundle.overrides.at(-1)).not.toMatch(/^!/u);
    expect(JSON.parse(await readFile(mcpPolicy, "utf8"))).toEqual({
      sibling: { enabled: false, keep: true },
    });
    expect(await readFile(manifestPath, "utf8")).toContain("SECRET_SENTINEL");
  });

  it("blocks native-name collisions, reports malformed owners, and preserves partial multi-layer outcomes", async () => {
    const fixture = await createFixture(true);
    await writeSkill(join(fixture.gemini, "skills", "review"), "review");
    await writeJson(join(fixture.gemini, "settings.json"), {
      skills: { disabled: ["review"] },
      mcpServers: { collision: { command: "user" } },
    });
    const workspaceSettings = join(
      fixture.workspace,
      ".gemini",
      "settings.json",
    );
    await writeJson(workspaceSettings, {
      skills: { disabled: ["review"] },
      mcpServers: { collision: { command: "workspace" } },
    });
    await writeJson(join(fixture.gemini, "mcp-server-enablement.json"), {});
    const malformed = join(fixture.gemini, "extensions", "malformed");
    await writeJson(join(malformed, ".gemini-extension-install.json"), {
      type: "local",
      source: malformed,
    });
    await write(join(malformed, "gemini-extension.json"), "{ broken\n");

    const snapshot = await fixture.scan();
    expect(snapshot.sources).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({
          sourceId: expect.stringContaining("invalid-extension"),
        }),
        status: "invalid",
      }),
    );
    const collision = target(snapshot, "mcp-registration", "collision");
    const collisionPlan = planSessionSetup(snapshot, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "disable",
      harnessId: "gemini-cli",
      workspace: { path: fixture.workspace },
      targets: [targetRef(collision)],
    });
    expect(collisionPlan.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "selector-collision" }),
        expect.objectContaining({ kind: "unsupported-control" }),
      ]),
    );

    await rm(malformed, { recursive: true });
    const fresh = await fixture.scan();
    const skill = target(fresh, "skill-exposure", "review");
    const plan = planSessionSetup(fresh, {
      schemaVersion: 1,
      kind: "session-setup-intent",
      action: "enable",
      harnessId: "gemini-cli",
      workspace: { path: fixture.workspace },
      targets: [targetRef(skill)],
    });
    const baseWriter = createBuiltInSessionSetupConfigurationWriter(
      fixture.workspace,
    );
    const racingWriter: SessionSetupConfigurationWriter = {
      async prepare(request) {
        if (request.path === workspaceSettings)
          await writeFile(
            workspaceSettings,
            `${await readFile(workspaceSettings, "utf8")}\n// race\n`,
          );
        return baseWriter.prepare(request);
      },
      commit: (prepared) => baseWriter.commit(prepared),
      discard: (prepared) => baseWriter.discard(prepared),
    };
    const report = await executeSessionSetup(
      plan,
      { grants: plan.actions.flatMap((candidate) => candidate.approvals) },
      executionOptions(fixture, racingWriter),
    );
    expect(report.status).toBe("partial");
    expect(report.actionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "succeeded" }),
        expect.objectContaining({ status: "failed" }),
      ]),
    );
    expect(
      await readFile(join(fixture.gemini, "settings.json"), "utf8"),
    ).not.toContain('"review"');
    expect(await readFile(workspaceSettings, "utf8")).toContain('"review"');
  });

  it("joins Gemini CLI to unfiltered Session setup scans", async () => {
    const fixture = await createFixture(true);
    const snapshot = await fixture.scanAll();
    expect(snapshot.harnesses).toEqual(["codex", "claude-code", "gemini-cli"]);
    expect(snapshot.profiles.map((candidate) => candidate.harnessId)).toEqual([
      "codex",
      "claude-code",
      "gemini-cli",
    ]);
  });
});

async function createFixture(trusted: boolean | null) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "lampwright-gemini-setup-")),
  );
  temporary.push(root);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const gemini = join(root, "gemini");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(gemini, { recursive: true }),
  ]);
  const run = vi.fn<InventoryCommandRunner["run"]>(async () => ({
    exitCode: 1,
    stdout: "",
  }));
  const scanner = createSessionSetupScanner({
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    environment: {
      homeDirectory: home,
      workspaceDirectory: workspace,
      agentHomeDirectories: { "gemini-cli": gemini },
      geminiWorkspaceTrusted: trusted,
    },
    commandRunner: { run },
    executablePresent: async (executable) => executable === "gemini",
  });
  return {
    root,
    home,
    workspace,
    gemini,
    run,
    scan: () =>
      scanner.scanSessionSetup({
        harnessId: "gemini-cli",
        workspace: { path: workspace },
      }),
    scanAll: () => scanner.scanSessionSetup({ workspace: { path: workspace } }),
  };
}

function executionOptions(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  configurationWriter = createBuiltInSessionSetupConfigurationWriter(
    fixture.workspace,
  ),
) {
  return {
    scan: fixture.scan,
    replan: planSessionSetup,
    configurationWriter,
    processRunner: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
    inspectGitProtection: async () => ({ kind: "outside-worktree" }) as const,
    auditWriter: { write: async () => undefined },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
  };
}

async function writeExtension(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const root = join(fixture.gemini, "extensions", name);
  await writeJson(join(root, ".gemini-extension-install.json"), {
    source: root,
    type: "local",
  });
  const manifestPath = join(root, "gemini-extension.json");
  await writeJson(manifestPath, { name, version: "1.0.0", ...manifest });
  return manifestPath;
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
