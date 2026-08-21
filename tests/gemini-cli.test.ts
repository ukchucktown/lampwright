import {
  link,
  lstat,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createInventoryScanner as createInventoryScannerModule,
  createExecutionModule,
  plan,
  type InventoryCommandRunner,
  type InventoryScannerOptions,
  type QuarantineModule,
} from "../src/index.js";
import {
  geminiExtensionUninstallArguments,
  geminiSkillUninstallArguments,
} from "../src/adapter/built-ins.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const fixture = createIsolatedTestEnvironmentFixture();

function createInventoryScanner(options: InventoryScannerOptions) {
  return createInventoryScannerModule({
    executablePresent: async (executable) => executable === "gemini",
    ...options,
  });
}

async function skill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
}

describe("Gemini CLI adapter", () => {
  it("deduplicates coincident home and workspace roots through Inventory", async () => {
    const environment = await fixture();
    const path = join(environment.home, ".gemini", "skills", "native");
    await skill(path, "native");
    await writeFile(
      join(environment.home, ".gemini", "settings.json"),
      JSON.stringify({ skills: { disabled: ["native"] } }),
      "utf8",
    );

    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.home,
      },
      commandRunner: {
        async run(command) {
          return command.executable === "gemini"
            ? { exitCode: 0, stdout: "1" }
            : { exitCode: 1, stdout: "" };
        },
      },
    }).scan({});

    const installations = inventory.installations.filter(
      (item) => item.agentId === "gemini-cli",
    );
    expect(installations).toHaveLength(1);
    expect(installations[0]!.scope).toMatchObject({
      kind: "workspace",
      workspacePath: environment.home,
    });
    const exposure = installations[0]!.harnessExposures.find(
      (item) => item.harnessId === "gemini-cli",
    )!;
    expect(exposure.status).toBe("disabled");
    expect(exposure.control).toMatchObject({
      kind: "native",
      mechanism: "gemini-disabled-skills",
      writableLayerPaths: [join(environment.home, ".gemini", "settings.json")],
    });
    expect(
      exposure.control.kind === "native" ? exposure.control.layers : [],
    ).toHaveLength(1);
    expect(
      exposure.control.kind === "native"
        ? exposure.control.layers[0]?.documentScope
        : null,
    ).toBe("user");
    expect(
      exposure.control.kind === "native"
        ? exposure.control.layers[0]?.applies
        : null,
    ).toBe(true);
  });

  it("checks executable presence without invoking Gemini during Inventory", async () => {
    const environment = await fixture();
    const path = join(environment.home, ".gemini", "skills", "native");
    await skill(path, "native");
    const marker = join(environment.home, "manager-invoked");
    const run = vi.fn(async (command) => {
      if (command.executable === "gemini") {
        await writeFile(marker, "invoked", "utf8");
        return { exitCode: 0, stdout: "1" };
      }
      return { exitCode: 1, stdout: "" };
    });
    const executablePresent = vi.fn(async () => true);

    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: { run },
      executablePresent,
    }).scan({});

    expect(executablePresent).toHaveBeenCalledWith("gemini");
    expect(run).not.toHaveBeenCalledWith(
      expect.objectContaining({ executable: "gemini" }),
    );
    expect(await readdir(environment.home)).toEqual([".gemini"]);
    expect(
      inventory.installations.find(
        (installation) => installation.location.path === path,
      )?.removal.managed,
    ).toMatchObject({ availability: { kind: "available" } });
  });

  it("does not traverse linked native skills roots and fails closed on unsafe extension paths", async () => {
    const environment = await fixture();
    const external = join(environment.temporary, "external");
    await skill(join(external, "skills", "outside"), "outside");
    await mkdir(join(environment.home, ".gemini"), { recursive: true });
    await symlink(
      join(external, "skills"),
      join(environment.home, ".gemini", "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const mismatch = join(environment.home, ".gemini", "extensions", "entry");
    await skill(join(mismatch, "skills", "child"), "child");
    await writeFile(
      join(mismatch, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(mismatch, "gemini-extension.json"),
      JSON.stringify({ name: "other", version: "1" }),
    );
    const copied = join(environment.home, ".gemini", "extensions", "copied");
    await mkdir(copied, { recursive: true });
    await symlink(
      join(external, "skills"),
      join(copied, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      join(copied, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(copied, "gemini-extension.json"),
      JSON.stringify({ name: "copied", version: "1" }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    expect(
      inventory.installations.some(
        (item) => item.skill.name === "outside" && item.plugin === null,
      ),
    ).toBe(false);
    expect(inventory.plugins.some((item) => item.pluginId === "other")).toBe(
      false,
    );
    const boundary = inventory.plugins.find(
      (item) => item.pluginId === "copied",
    )!;
    expect(boundary.removal.fallback).toMatchObject({ kind: "unavailable" });
    expect(
      boundary.removal.managed?.effects.every(
        (effect) => !effect.path.startsWith(external),
      ),
    ).toBe(true);
  });

  it("treats an invalid enablement document as empty", async () => {
    const environment = await fixture();
    const root = join(environment.home, ".gemini", "extensions", "valid");
    await skill(join(root, "skills", "child"), "child");
    await writeFile(
      join(root, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(root, "gemini-extension.json"),
      JSON.stringify({ name: "valid", version: "1" }),
    );
    await writeFile(
      join(
        environment.home,
        ".gemini",
        "extensions",
        "extension-enablement.json",
      ),
      JSON.stringify({ valid: { overrides: [] }, broken: { overrides: [1] } }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const boundary = inventory.plugins.find(
      (item) => item.pluginId === "valid",
    )!;
    expect(boundary.availability).toMatchObject({
      status: "unresolved",
      control: {
        kind: "native",
        mechanism: "gemini-extension-enablement",
      },
    });
    expect(
      inventory.installations.find((item) => item.plugin?.id === "valid")
        ?.metadata["gemini-cli"],
    ).toMatchObject({ extensionEnabled: true });
    expect(boundary.resources.some((item) => item.id === "enablement")).toBe(
      false,
    );
    expect(
      boundary.removal.managed?.effects.some(
        (effect) => effect.kind === "modify-path",
      ),
    ).toBe(false);
  });

  it("fails closed for duplicate native names while preserving exact brute fallback", async () => {
    const environment = await fixture();
    const first = join(environment.home, ".gemini", "skills", "first");
    const second = join(environment.home, ".gemini", "skills", "second");
    await skill(first, "duplicate");
    await skill(second, "duplicate");
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const records = inventory.installations.filter(
      (item) => item.skill.name === "duplicate",
    );
    expect(records).toHaveLength(2);
    expect(
      records
        .filter(
          (item) =>
            (item.metadata["gemini-cli"] as { effective?: boolean }).effective,
        )
        .map((item) => item.location.path),
    ).toEqual([second]);
    expect(
      records.every(
        (item) => item.removal.managed?.availability.kind === "unavailable",
      ),
    ).toBe(true);
    const brute = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: records[0]!.id }],
      force: false,
      mode: "brute-force",
    });
    expect(brute.actions).toEqual([
      expect.objectContaining({
        kind: "quarantine",
        location: expect.objectContaining({ path: records[0]!.location.path }),
      }),
    ]);
  });

  it("fails closed when two installed extensions share a manifest name", async () => {
    const environment = await fixture();
    for (const entry of ["one", "two"]) {
      const root = join(environment.home, ".gemini", "extensions", entry);
      await skill(join(root, "skills", entry), entry);
      await writeFile(
        join(root, ".gemini-extension-install.json"),
        JSON.stringify({ source: "x", type: "git" }),
      );
      await writeFile(
        join(root, "gemini-extension.json"),
        JSON.stringify({ name: "duplicate", version: "1" }),
      );
    }
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const boundaries = inventory.plugins.filter(
      (item) => item.pluginId === "duplicate",
    );
    expect(boundaries).toHaveLength(0);
    expect(
      boundaries.every(
        (item) => item.removal.managed?.availability.kind === "unavailable",
      ),
    ).toBe(true);
    expect(
      inventory.installations
        .filter((item) => item.plugin?.id === "duplicate")
        .every(
          (item) =>
            (item.metadata["gemini-cli"] as { effective?: boolean })
              .effective === false,
        ),
    ).toBe(true);
  });

  it("executes user link removal without touching source or same-named counterparts", async () => {
    const environment = await fixture();
    const source = join(environment.temporary, "source");
    const userLink = join(environment.home, ".gemini", "skills", "same");
    const workspace = join(environment.workspace, ".gemini", "skills", "same");
    const extension = join(
      environment.home,
      ".gemini",
      "extensions",
      "extension",
    );
    await skill(source, "same");
    await mkdir(join(environment.home, ".gemini", "skills"), {
      recursive: true,
    });
    await symlink(
      source,
      userLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await skill(workspace, "same");
    await skill(join(extension, "skills", "same"), "same");
    await writeFile(
      join(extension, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(extension, "gemini-extension.json"),
      JSON.stringify({ name: "extension", version: "1" }),
    );
    const commandRunner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const scanner = createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner,
    });
    const initial = await scanner.scan({});
    const user = initial.installations.find(
      (item) => item.location.path === userLink,
    )!;
    const workspaceRecord = initial.installations.find(
      (item) => item.location.path === workspace,
    )!;
    expect(user.location.artifactType.kind).toMatch(/symbolic-link|junction/);
    expect(user.metadata["gemini-cli"]).toMatchObject({
      link: user.location.artifactType.kind,
    });
    expect(workspaceRecord.metadata["gemini-cli"]).toMatchObject({
      link: "copy",
    });
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: user.id }],
      force: false,
      mode: "managed-first",
    });
    const processRunner = {
      run: vi.fn(async () => {
        await rm(userLink, { recursive: true, force: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    };
    const quarantine: QuarantineModule = {
      list: vi.fn(async () => []),
      listOperations: vi.fn(async () => []),
      quarantine: vi.fn(),
      restore: vi.fn(),
      previewRestore: vi.fn(),
      purge: vi.fn(),
      previewPurge: vi.fn(),
      previewRestoreOperation: vi.fn(),
      restoreOperation: vi.fn(),
      previewPurgeOperation: vi.fn(),
      purgeOperation: vi.fn(),
    };
    const report = await createExecutionModule({
      scan: () => scanner.scan({}),
      replan: plan,
      quarantine,
      processRunner,
      inspectGitProtection: async () => ({ kind: "outside-worktree" as const }),
      auditWriter: { write: async () => undefined },
      packageTrustStore: {
        isTrusted: async () => false,
        trust: async () => undefined,
      },
      now: () => new Date(0),
      stateRoot: environment.state,
    }).execute(removalPlan, { grants: [{ kind: "confirmation" }] });
    expect(processRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          executable: "gemini",
          arguments: ["skills", "uninstall", "same", "--scope", "user"],
        }),
      }),
    );
    expect(report.status).toBe("succeeded");
    await expect(lstat(userLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(source)).resolves.toBeDefined();
    await expect(lstat(workspace)).resolves.toBeDefined();
    await expect(
      lstat(join(extension, "skills", "same")),
    ).resolves.toBeDefined();
  });

  it("reports a failed native uninstall and offers a separate brute-force fallback", async () => {
    const environment = await fixture();
    const path = join(environment.home, ".gemini", "skills", "native");
    await skill(path, "native");
    const commandRunner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const scanner = createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner,
    });
    const initial = await scanner.scan({});
    const installation = initial.installations.find(
      (item) => item.location.path === path,
    )!;
    const target = {
      kind: "installation" as const,
      installationId: installation.id,
    };
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [target],
      force: false,
      mode: "managed-first",
    });
    const quarantine: QuarantineModule = {
      list: vi.fn(async () => []),
      listOperations: vi.fn(async () => []),
      quarantine: vi.fn(),
      restore: vi.fn(),
      previewRestore: vi.fn(),
      purge: vi.fn(),
      previewPurge: vi.fn(),
      previewRestoreOperation: vi.fn(),
      restoreOperation: vi.fn(),
      previewPurgeOperation: vi.fn(),
      purgeOperation: vi.fn(),
    };
    const processRunner = {
      run: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "failed" })),
    };
    const report = await createExecutionModule({
      scan: () => scanner.scan({}),
      replan: plan,
      quarantine,
      processRunner,
      inspectGitProtection: async () => ({ kind: "outside-worktree" as const }),
      auditWriter: { write: async () => undefined },
      packageTrustStore: {
        isTrusted: async () => false,
        trust: async () => undefined,
      },
      now: () => new Date(0),
      stateRoot: environment.state,
    }).execute(removalPlan, { grants: [{ kind: "confirmation" }] });
    expect(processRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          executable: "gemini",
          arguments: ["skills", "uninstall", "native", "--scope", "user"],
        }),
      }),
    );
    expect(report.actionResults).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
    );
    await expect(lstat(path)).resolves.toBeDefined();
    expect(quarantine.quarantine).not.toHaveBeenCalled();
    expect(report.fallbackPlans[0]).toMatchObject({
      intent: { mode: "brute-force", targets: [target] },
    });
  });

  it("plans scoped native removal without crossing workspace or extension counterparts", async () => {
    const environment = await fixture();
    const home = join(environment.home, ".gemini");
    await skill(join(home, "skills", "user"), "same");
    await skill(
      join(environment.workspace, ".agents", "skills", "workspace"),
      "same",
    );
    await skill(
      join(environment.workspace, ".gemini", "skills", "native-workspace"),
      "native",
    );
    const extension = join(home, "extensions", "extension");
    await skill(join(extension, "skills", "child"), "same");
    await writeFile(
      join(extension, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(extension, "gemini-extension.json"),
      JSON.stringify({ name: "extension", version: "1" }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const user = inventory.installations.find((item) =>
      item.location.path.endsWith(join("skills", "user")),
    )!;
    const workspace = inventory.installations.find((item) =>
      item.location.path.endsWith(join("skills", "native-workspace")),
    )!;
    const userPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: user.id }],
      mode: "managed-first",
      force: false,
    });
    expect(userPlan.actions).toHaveLength(1);
    expect(userPlan.actions[0]).toMatchObject({
      kind: "managed-removal",
      invocation: {
        kind: "direct",
        command: {
          arguments: ["skills", "uninstall", "same", "--scope", "user"],
        },
        workingDirectory: { kind: "isolated-temporary" },
      },
    });
    expect(JSON.stringify(userPlan.actions[0])).not.toContain(
      environment.workspace,
    );
    const workspacePlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: workspace.id }],
      mode: "managed-first",
      force: false,
    });
    expect(workspacePlan.actions[0]).toMatchObject({
      invocation: {
        command: {
          arguments: ["skills", "uninstall", "native", "--scope", "workspace"],
        },
        workingDirectory: { kind: "exact", path: environment.workspace },
      },
    });
    const withoutPlugins = plan(inventory, {
      kind: "all",
      includePlugins: false,
      force: false,
      mode: "managed-first",
    });
    const withPlugins = plan(inventory, {
      kind: "all",
      includePlugins: true,
      force: false,
      mode: "managed-first",
    });
    expect(
      withoutPlugins.targets.some((target) => target.kind === "plugin"),
    ).toBe(false);
    expect(
      withoutPlugins.actions.some((action) =>
        JSON.stringify(action).includes('extensions","uninstall'),
      ),
    ).toBe(false);
    expect(withPlugins.targets).toEqual(
      expect.arrayContaining([
        {
          kind: "plugin",
          pluginBoundaryId: inventory.plugins.find(
            (item) => item.pluginId === "extension",
          )!.id,
        },
      ]),
    );
    expect(
      withPlugins.actions.some((action) =>
        JSON.stringify(action).includes('extensions","uninstall","extension'),
      ),
    ).toBe(true);
  });

  it("offers only separately confirmed quarantine fallback when Gemini is unavailable", async () => {
    const environment = await fixture();
    const path = join(environment.home, ".gemini", "skills", "native");
    await skill(path, "native");
    const extensionRoot = join(
      environment.home,
      ".gemini",
      "extensions",
      "extension",
    );
    await skill(join(extensionRoot, "skills", "child"), "child");
    await writeFile(
      join(extensionRoot, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(extensionRoot, "gemini-extension.json"),
      JSON.stringify({ name: "extension", version: "1" }),
    );
    const runner: InventoryCommandRunner = {
      async run() {
        return { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
      executablePresent: async () => false,
    }).scan({});
    const installation = inventory.installations.find(
      (item) => item.location.path === path,
    )!;
    expect(installation.removal.managed?.availability).toEqual({
      kind: "unavailable",
      reason: "the Gemini CLI executable is not available",
    });
    expect(
      inventory.plugins.find((plugin) => plugin.pluginId === "extension")
        ?.removal.managed?.availability,
    ).toEqual({
      kind: "unavailable",
      reason: "the Gemini CLI executable is not available",
    });
    const managed = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: installation.id }],
      force: false,
      mode: "managed-first",
    });
    expect(managed.actions).toHaveLength(0);
    expect(managed.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "managed-removal-unavailable",
          fallback: { kind: "available", requiresSeparateConfirmation: true },
        }),
      ]),
    );
    const brute = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: installation.id }],
      force: false,
      mode: "brute-force",
    });
    expect(brute.actions).toEqual([
      expect.objectContaining({
        kind: "quarantine",
        location: expect.objectContaining({ path }),
      }),
    ]);
    expect(brute.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unreconciled-owner-state" }),
      ]),
    );
  });

  it("blocks extension children and plans explicit extension boundaries", async () => {
    const environment = await fixture();
    const root = join(environment.home, ".gemini", "extensions", "extension");
    await skill(join(root, "skills", "child"), "child");
    await writeFile(
      join(root, ".gemini-extension-install.json"),
      JSON.stringify({ source: "x", type: "git" }),
    );
    await writeFile(
      join(root, "gemini-extension.json"),
      JSON.stringify({ name: "extension", version: "1" }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const child = inventory.installations.find(
      (item) => item.plugin?.id === "extension",
    )!;
    const boundary = inventory.plugins.find(
      (item) => item.pluginId === "extension",
    )!;
    const childPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "installation", installationId: child.id }],
      mode: "managed-first",
      force: false,
    });
    expect(childPlan.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin-boundary",
          overridable: false,
        }),
      ]),
    );
    expect(childPlan.actions).toHaveLength(0);
    const pluginPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      mode: "managed-first",
      force: false,
    });
    expect(pluginPlan.actions).toHaveLength(1);
    expect(pluginPlan.actions[0]).toMatchObject({
      kind: "managed-removal",
      invocation: {
        command: { arguments: ["extensions", "uninstall", "extension"] },
      },
    });
  });

  it("preserves linked extension source and limits managed effects to management state", async () => {
    const environment = await fixture();
    const home = join(environment.home, ".gemini");
    const source = join(environment.temporary, "linked-source");
    const management = join(home, "extensions", "linked-extension");
    await skill(join(source, "skills", "child"), "child");
    await mkdir(join(source, "contexts"), { recursive: true });
    await writeFile(join(source, "contexts", "context.md"), "context");
    await writeFile(
      join(source, "gemini-extension.json"),
      JSON.stringify({
        name: "linked-extension",
        version: "1",
        contextFileName: "contexts/context.md",
      }),
    );
    await mkdir(management, { recursive: true });
    await writeFile(join(management, ".env"), "MANAGED=1");
    await writeFile(
      join(management, ".gemini-extension-install.json"),
      JSON.stringify({ type: "link", source }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const scan = () =>
      createInventoryScanner({
        now: () => new Date(0),
        environment: {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
        },
        commandRunner: runner,
      }).scan({});
    let inventory = await scan();
    let boundary = inventory.plugins.find(
      (item) => item.pluginId === "linked-extension",
    )!;
    const resource = (id: string) =>
      boundary.resources.find((item) => item.id === id)?.location?.path;
    expect(resource("environment")).toBe(join(management, ".env"));
    expect(resource("install-metadata")).toBe(
      join(management, ".gemini-extension-install.json"),
    );
    expect(resource("manifest")).toBe(join(source, "gemini-extension.json"));
    expect(resource("skills")).toBe(join(source, "skills"));
    expect(resource("context:contexts/context.md")).toBe(
      join(source, "contexts", "context.md"),
    );
    expect(boundary.removal.fallback).toMatchObject({ kind: "unavailable" });
    expect(boundary.resources.some((item) => item.id === "enablement")).toBe(
      false,
    );
    expect(
      boundary.removal.managed?.effects.some(
        (effect) => effect.kind === "modify-path",
      ),
    ).toBe(false);
    expect(
      boundary.removal.managed?.effects.every(
        (effect) => !effect.path.startsWith(source),
      ),
    ).toBe(true);
    expect(
      boundary.removal.managed?.verifications.every(
        (check) => !("path" in check) || !check.path.startsWith(source),
      ),
    ).toBe(true);
    expect(
      inventory.installations.find(
        (item) => item.plugin?.id === "linked-extension",
      )?.metadata["gemini-cli"],
    ).toMatchObject({ extensionType: "link", extensionSource: source });
    await writeFile(
      join(home, "extensions", "extension-enablement.json"),
      JSON.stringify({ "linked-extension": { overrides: [] } }),
    );
    inventory = await scan();
    boundary = inventory.plugins.find(
      (item) => item.pluginId === "linked-extension",
    )!;
    expect(boundary.availability).toMatchObject({
      status: "enabled",
      control: {
        kind: "native",
        mechanism: "gemini-extension-enablement",
      },
    });
    expect(
      boundary.removal.managed?.effects.filter(
        (effect) => effect.kind === "modify-path",
      ),
    ).toHaveLength(1);
    const symlinkRoot = join(home, "extensions", "symlinked");
    await symlink(management, symlinkRoot, "dir");
    inventory = await scan();
    expect(
      inventory.plugins.filter((item) => item.pluginId === "linked-extension"),
    ).toHaveLength(1);
  });

  it("defers a shared Gemini artifact to Vercel lock ownership", async () => {
    const environment = await fixture();
    const gemini = join(environment.home, ".gemini", "skills", "shared");
    await skill(gemini, "shared");
    const alias = join(environment.home, ".agents", "skills", "shared");
    await mkdir(join(environment.home, ".agents", "skills"), {
      recursive: true,
    });
    await symlink(
      gemini,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(environment.state, "skills"), { recursive: true });
    await writeFile(
      join(environment.state, "skills", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          shared: {
            source: "acme/shared",
            sourceType: "github",
            sourceUrl: "https://example.invalid/shared",
            skillPath: "skills/shared",
          },
        },
      }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        if (command.executable === "gemini")
          return { exitCode: 0, stdout: "1" };
        return { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
        stateDirectory: environment.state,
      },
      commandRunner: runner,
    }).scan({});
    const shared = inventory.installations.filter(
      (item) => item.skill.name === "shared",
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      adapterId: "vercel.skills",
      manager: { id: "vercel-skills" },
    });
  });

  it("rejects invalid extension evidence without managed authority", async () => {
    const cases: readonly [
      string,
      unknown,
      unknown,
      "install" | "manifest" | null,
    ][] = [
      ["strict-json", "{/* comment */}", { name: "valid", version: "1" }, null],
      [
        "trailing",
        { source: "x", type: "git" },
        '{"name":"valid","version":"1",}',
        null,
      ],
      [
        "bad-name",
        { source: "x", type: "git" },
        { name: "bad_name", version: "1" },
        null,
      ],
      [
        "empty-source",
        { source: "", type: "git" },
        { name: "valid", version: "1" },
        null,
      ],
      [
        "bad-install-options",
        { source: "x", type: "git", ref: 1, autoUpdate: "yes" },
        { name: "valid", version: "1" },
        null,
      ],
      [
        "bad-manifest-options",
        { source: "x", type: "git" },
        {
          name: "valid",
          version: "1",
          description: 1,
          excludeTools: [1],
          migratedTo: 2,
        },
        null,
      ],
      [
        "bad-context",
        { source: "x", type: "git" },
        { name: "valid", version: "1", contextFileName: "/outside" },
        null,
      ],
      [
        "hard-install",
        { source: "x", type: "git" },
        { name: "valid", version: "1" },
        "install",
      ],
      [
        "hard-manifest",
        { source: "x", type: "git" },
        { name: "valid", version: "1" },
        "manifest",
      ],
    ];
    for (const [label, install, manifest, hard] of cases) {
      const environment = await fixture();
      const root = join(environment.home, ".gemini", "extensions", label);
      await mkdir(root, { recursive: true });
      const installPath = join(root, ".gemini-extension-install.json");
      const manifestPath = join(root, "gemini-extension.json");
      const installBytes =
        typeof install === "string" ? install : JSON.stringify(install);
      const manifestBytes =
        typeof manifest === "string" ? manifest : JSON.stringify(manifest);
      if (hard === "install") {
        const source = join(root, "install-copy");
        await writeFile(source, installBytes);
        await link(source, installPath);
      } else await writeFile(installPath, installBytes);
      if (hard === "manifest") {
        const source = join(root, "manifest-copy");
        await writeFile(source, manifestBytes);
        await link(source, manifestPath);
      } else await writeFile(manifestPath, manifestBytes);
      const runner: InventoryCommandRunner = {
        async run() {
          return { exitCode: 0, stdout: "1" };
        },
      };
      const inventory = await createInventoryScanner({
        now: () => new Date(0),
        environment: {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
        },
        commandRunner: runner,
      }).scan({});
      expect(inventory.plugins.some((item) => item.pluginId === "valid")).toBe(
        false,
      );
      expect(
        inventory.installations.some((item) => item.plugin?.id === "valid"),
      ).toBe(false);
    }
  });

  it("inventories copied extension metadata and complete collateral", async () => {
    const environment = await fixture();
    const root = join(
      environment.home,
      ".gemini",
      "extensions",
      "copied-extension",
    );
    await skill(join(root, "skills", "first"), "first");
    await skill(join(root, "skills", "second"), "second");
    await mkdir(join(root, "commands"), { recursive: true });
    await mkdir(join(root, "agents"), { recursive: true });
    await mkdir(join(root, "policies"), { recursive: true });
    await mkdir(join(root, "contexts"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(join(root, "hooks", "hooks.json"), "{}");
    await writeFile(join(root, ".env"), "X=1");
    await writeFile(join(root, "contexts", "one.md"), "one");
    await writeFile(join(root, "contexts", "two.md"), "two");
    await writeFile(
      join(root, ".gemini-extension-install.json"),
      JSON.stringify({
        source: "https://example.invalid/copied",
        type: "git",
        ref: "main",
        releaseTag: "v1",
        autoUpdate: true,
        allowPreRelease: false,
      }),
    );
    await writeFile(
      join(root, "gemini-extension.json"),
      JSON.stringify({
        name: "copied-extension",
        version: "1.2.3",
        description: "copied",
        contextFileName: ["contexts/one.md", "contexts/two.md"],
        mcpServers: {},
        settings: {},
        themes: {},
        plan: {},
        excludeTools: ["x"],
        migratedTo: "next",
      }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const plugin = inventory.plugins.find(
      (item) => item.pluginId === "copied-extension",
    );
    expect(plugin).toMatchObject({
      version: "1.2.3",
      ownership: { kind: "plugin", independentlySelectable: false },
      removal: {
        managed: {
          invocation: {
            command: {
              executable: "gemini",
              arguments: ["extensions", "uninstall", "copied-extension"],
            },
          },
        },
      },
    });
    expect(plugin?.resources.map((item) => item.id).sort()).toEqual(
      [
        "agents",
        "commands",
        "context:contexts/one.md",
        "context:contexts/two.md",
        "environment",
        "hooks",
        "install-metadata",
        "management-root",
        "manifest",
        "manifest:mcpServers",
        "manifest:plan",
        "manifest:settings",
        "manifest:themes",
        "policies",
        "skills",
      ].sort(),
    );
    expect(
      plugin?.resources.some((item) =>
        item.location?.path.endsWith("GEMINI.md"),
      ),
    ).toBe(false);
    const children = inventory.installations.filter(
      (item) => item.pluginBoundaryId === plugin?.id,
    );
    expect(children).toHaveLength(2);
    expect(
      children.every((item) =>
        item.identity.strongEvidence.some(
          (evidence) =>
            evidence.kind === "plugin" &&
            evidence.pluginId === "copied-extension",
        ),
      ),
    ).toBe(true);
    expect(children[0]?.metadata["gemini-cli"]).toMatchObject({
      extensionType: "git",
      manifest: {
        description: "copied",
        hasMcpServers: true,
        hasSettings: true,
        hasThemes: true,
        hasPlan: true,
      },
      install: {
        ref: "main",
        releaseTag: "v1",
        autoUpdate: true,
        allowPreRelease: false,
      },
    });
  });

  it("applies enablement precedence without hiding disabled skills", async () => {
    const environment = await fixture();
    const extension = join(
      environment.home,
      ".gemini",
      "extensions",
      "disabled-extension",
    );
    await skill(join(extension, "skills", "same"), "same");
    await skill(
      join(environment.workspace, ".gemini", "skills", "standalone"),
      "same",
    );
    await writeFile(
      join(extension, ".gemini-extension-install.json"),
      JSON.stringify({
        source: "https://example.invalid/disabled",
        type: "git",
      }),
    );
    await writeFile(
      join(extension, "gemini-extension.json"),
      JSON.stringify({ name: "disabled-extension", version: "1" }),
    );
    await writeFile(
      join(
        environment.home,
        ".gemini",
        "extensions",
        "extension-enablement.json",
      ),
      JSON.stringify({
        "disabled-extension": {
          overrides: ["!/*", "/*", `!${environment.workspace}`],
        },
      }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const child = inventory.installations.find(
      (item) => item.plugin?.id === "disabled-extension",
    );
    const standalone = inventory.installations.find(
      (item) => item.plugin === null && item.skill.name === "same",
    );
    expect(child?.metadata["gemini-cli"]).toMatchObject({
      extensionEnabled: false,
      effective: false,
    });
    expect(standalone?.metadata["gemini-cli"]).toMatchObject({
      effective: true,
    });
    const boundary = inventory.plugins.find(
      (item) => item.pluginId === "disabled-extension",
    );
    expect(boundary?.resources.some((item) => item.id === "enablement")).toBe(
      true,
    );
    expect(
      boundary?.removal.managed?.effects.some(
        (effect) => effect.kind === "modify-path",
      ),
    ).toBe(true);
  });

  it("discovers alias-only user and workspace roots", async () => {
    const environment = await fixture();
    await skill(join(environment.home, ".agents", "skills", "user"), "user");
    await skill(
      join(environment.workspace, ".agents", "skills", "workspace"),
      "workspace",
    );
    const runner: InventoryCommandRunner = {
      async run() {
        return { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    expect(
      inventory.installations
        .filter((item) => item.agentId === "gemini-cli")
        .map((item) => item.scope.kind)
        .sort(),
    ).toEqual(["user", "workspace"]);
  });

  it("keeps Windows-style values as structured arguments", () => {
    const name = "C:\\work\\skill & no-shell";
    expect(geminiSkillUninstallArguments("workspace", name)).toEqual([
      "skills",
      "uninstall",
      name,
      "--scope",
      "workspace",
    ]);
    expect(geminiExtensionUninstallArguments(name)).toEqual([
      "extensions",
      "uninstall",
      name,
    ]);
  });

  it("keeps all precedence copies and scopes native user removal", async () => {
    const environment = await fixture();
    const home = join(environment.home, ".gemini");
    await skill(join(home, "skills", "one"), "same");
    await skill(join(environment.home, ".agents", "skills", "two"), "same");
    await skill(
      join(environment.workspace, ".gemini", "skills", "three"),
      "same",
    );
    await skill(
      join(environment.workspace, ".agents", "skills", "four"),
      "same",
    );
    await writeFile(
      join(home, "settings.json"),
      '{ // jsonc\n "skills": { "disabled": ["SAME"] },\n}',
    );
    const commands: unknown[] = [];
    const runner: InventoryCommandRunner = {
      async run(command) {
        commands.push(command);
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    const gemini = inventory.installations.filter(
      (item) => item.agentId === "gemini-cli",
    );
    expect(gemini).toHaveLength(4);
    expect(
      gemini.filter(
        (item) =>
          (item.metadata["gemini-cli"] as { effective?: boolean }).effective ===
          true,
      ),
    ).toHaveLength(1);
    // Gemini's disabled-name membership is deliberately case-sensitive.
    expect(
      gemini.every(
        (item) =>
          (item.metadata["gemini-cli"] as { disabled?: boolean }).disabled ===
          false,
      ),
    ).toBe(true);
    expect(
      gemini.find((item) =>
        item.location.path.endsWith(join(".gemini", "skills", "one")),
      )?.removal.managed?.invocation,
    ).toMatchObject({
      kind: "direct",
      command: {
        executable: "gemini",
        arguments: ["skills", "uninstall", "same", "--scope", "user"],
      },
    });
  });

  it("models extension skills as plugin-owned and preserves linked source fallback", async () => {
    const environment = await fixture();
    const home = join(environment.home, ".gemini");
    const source = join(environment.temporary, "extension-source");
    await skill(join(source, "skills", "extension-skill"), "extension-skill");
    await writeFile(
      join(source, "gemini-extension.json"),
      '{"name":"example","version":"1.0.0"}',
    );
    const management = join(home, "extensions", "example");
    await mkdir(management, { recursive: true });
    await writeFile(
      join(management, ".gemini-extension-install.json"),
      JSON.stringify({ type: "link", source }),
    );
    const runner: InventoryCommandRunner = {
      async run(command) {
        return command.executable === "gemini"
          ? { exitCode: 0, stdout: "1" }
          : { exitCode: 1, stdout: "" };
      },
    };
    const inventory = await createInventoryScanner({
      now: () => new Date(0),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
      },
      commandRunner: runner,
    }).scan({});
    expect(
      inventory.installations.find(
        (item) => item.skill.name === "extension-skill",
      )?.ownership,
    ).toMatchObject({ kind: "plugin", independentlySelectable: false });
    expect(inventory.plugins[0]?.removal.fallback).toMatchObject({
      kind: "unavailable",
    });
  });
});
