import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDisabledStorageModule,
  createExecutionModule,
  createInventoryScanner,
  plan,
  planAvailability,
  type AvailabilityPlan,
  type DiscoveryRoot,
  type ExecutionModuleOptions,
  type Inventory,
  type InventoryCommandRunner,
  type InventoryScanEnvironment,
} from "../src/index.js";
import { nodeArtifactFileSystem } from "../src/filesystem/artifact-filesystem.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
  buildSystemSkillFinding,
} from "../src/testing/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const environmentFixture = createIsolatedTestEnvironmentFixture();
const noCommands: InventoryCommandRunner = {
  async run() {
    return { exitCode: 1, stdout: "" };
  },
};

async function createSkill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\n---\n# ${name}\n`,
  );
}

function scan(
  environment: InventoryScanEnvironment,
  roots: readonly DiscoveryRoot[],
): Promise<Inventory> {
  return createInventoryScanner({
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    environment,
    commandRunner: noCommands,
  }).scan({ roots });
}

function execution(
  stateRoot: string,
  scanLive: () => Promise<Inventory>,
  audit: unknown[],
  overrides: Partial<ExecutionModuleOptions> = {},
) {
  let disabledId = 1;
  const disabledStorage = createDisabledStorageModule({
    stateRoot,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    createId: () => `disabled-${disabledId++}`,
    fileSystem: nodeArtifactFileSystem,
    inspectGitProtection: async () => ({ kind: "outside-worktree" }),
  });
  return {
    disabledStorage,
    module: createExecutionModule({
      scan: scanLive,
      replan: (inventory, intent) => plan(inventory, intent),
      quarantine: {
        quarantine: async () => ({ status: "already-absent", path: "/unused" }),
      } as never,
      processRunner: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: { async write() {} },
      packageTrustStore: {
        async isTrusted() {
          return false;
        },
        async trust() {},
      },
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      stateRoot,
      disabledStorage,
      replanAvailability: planAvailability,
      availabilityAuditWriter: {
        async write(record) {
          audit.push(record);
        },
      },
      ...overrides,
    }),
  };
}

async function nativeFixture(
  harness: "codex" | "claude-code" | "gemini-cli",
  names: readonly string[],
) {
  const environment = await environmentFixture();
  const root = join(environment.temporary, `${harness}-skills`);
  for (const name of names) await createSkill(join(root, name), name);
  const agentHome = join(
    environment.home,
    `.${harness === "claude-code" ? "claude" : harness === "gemini-cli" ? "gemini" : "codex"}`,
  );
  await mkdir(agentHome, { recursive: true });
  const config = join(
    agentHome,
    harness === "codex" ? "config.toml" : "settings.json",
  );
  if (harness === "codex")
    await writeFile(
      config,
      '# keep codex comment\r\n[terminal]\r\nlabel = "unchanged"\r\n',
    );
  else if (harness === "claude-code")
    await writeFile(
      config,
      '{\n  "unrelated": "keep",\n  "skillOverrides": {}\n}\n',
    );
  else
    await writeFile(
      config,
      '{\n  // keep gemini comment\n  "unrelated": true,\n  "skills": { "disabled": [] },\n}\n',
    );
  const scanEnvironment: InventoryScanEnvironment = {
    homeDirectory: environment.home,
    workspaceDirectory: environment.workspace,
    agentHomeDirectories: { [harness]: agentHome },
    ...(harness === "gemini-cli" ? { geminiWorkspaceTrusted: false } : {}),
  };
  const roots: readonly DiscoveryRoot[] = [
    { kind: "user", path: root, agentId: harness, adapterId: null },
  ];
  return {
    environment,
    root,
    config,
    scanLive: () => scan(scanEnvironment, roots),
  };
}

async function nativeWorkspaceFixture(
  harness: "codex" | "claude-code" | "gemini-cli",
) {
  const environment = await environmentFixture();
  const root = join(environment.workspace, `${harness}-skills`);
  await createSkill(join(root, "workspace-review"), "workspace-review");
  const workspaceConfigDirectory = join(
    environment.workspace,
    harness === "claude-code" ? ".claude" : ".gemini",
  );
  const agentHome =
    harness === "codex"
      ? join(environment.home, ".codex")
      : join(environment.temporary, "missing-parent", `.${harness}`);
  let config: string;
  if (harness === "codex") {
    await mkdir(agentHome, { recursive: true });
    config = join(agentHome, "config.toml");
    await writeFile(
      config,
      '# workspace fixture\n[terminal]\nlabel = "keep"\n',
    );
  } else {
    await mkdir(workspaceConfigDirectory, { recursive: true });
    config = join(
      workspaceConfigDirectory,
      harness === "claude-code" ? "settings.local.json" : "settings.json",
    );
    await writeFile(
      config,
      harness === "claude-code"
        ? '{\n  "unrelated": "keep",\n  "skillOverrides": {}\n}\n'
        : '{\n  // workspace fixture\n  "unrelated": true,\n  "skills": { "disabled": [] }\n}\n',
    );
  }
  const scanEnvironment: InventoryScanEnvironment = {
    homeDirectory: environment.home,
    workspaceDirectory: environment.workspace,
    agentHomeDirectories: { [harness]: agentHome },
    ...(harness === "gemini-cli" ? { geminiWorkspaceTrusted: true } : {}),
  };
  const roots: readonly DiscoveryRoot[] = [
    {
      kind: "workspace",
      path: root,
      agentId: harness,
      workspacePath: environment.workspace,
      adapterId: null,
    },
  ];
  return {
    environment,
    config,
    scanLive: () => scan(scanEnvironment, roots),
  };
}

describe("Availability Planning and Execution", () => {
  for (const harness of ["codex", "claude-code", "gemini-cli"] as const) {
    it(`disables and enables ${harness} through exact native configuration evidence`, async () => {
      const fixture = await nativeFixture(harness, ["review"]);
      const audit: unknown[] = [];
      const initial = await fixture.scanLive();
      const target = {
        kind: "installation" as const,
        installationId: initial.installations[0]!.id,
      };
      const disabledPlan = planAvailability(initial, [], {
        operation: "disable",
        targets: [target],
        force: false,
      });
      expect(disabledPlan.actions).toHaveLength(1);
      const runner = execution(
        join(fixture.environment.state, "skill-cleaner"),
        fixture.scanLive,
        audit,
      );
      const disabled = await runner.module.executeAvailability(disabledPlan, {
        grants: [{ kind: "confirmation" }],
      });
      expect(disabled.status).toBe("succeeded");
      expect(disabled.targetResults[0]!.status).toBe("disabled");
      expect(
        (await fixture.scanLive()).installations[0]!.harnessExposures[0]!
          .status,
      ).toBe("disabled");

      const disabledInventory = await fixture.scanLive();
      const enabledPlan = planAvailability(disabledInventory, [], {
        operation: "enable",
        targets: [target],
        force: false,
      });
      const enabled = await runner.module.executeAvailability(enabledPlan, {
        grants: [{ kind: "confirmation" }],
      });
      expect(enabled.status).toBe("succeeded");
      expect(enabled.targetResults[0]!.status).toBe("enabled");
      expect(
        (await fixture.scanLive()).installations[0]!.harnessExposures[0]!
          .status,
      ).toBe("enabled");
      const config = await readFile(fixture.config, "utf8");
      expect(config).toContain(harness === "codex" ? "unchanged" : "unrelated");
      if (harness !== "claude-code") expect(config).toContain("comment");
      if (harness === "codex") expect(config).not.toMatch(/[^\r]\n/);
      expect(audit).toHaveLength(2);
    });

    it(`groups two ${harness} Skill changes into one shared-preimage document action`, async () => {
      const fixture = await nativeFixture(harness, ["one", "two"]);
      const inventory = await fixture.scanLive();
      const targets = inventory.installations.map((installation) => ({
        kind: "installation" as const,
        installationId: installation.id,
      }));
      const availabilityPlan = planAvailability(inventory, [], {
        operation: "disable",
        targets,
        force: false,
      });
      expect(availabilityPlan.actions).toHaveLength(1);
      expect(availabilityPlan.actions[0]).toMatchObject({
        kind: "native-control",
        affectedInstallationIds: expect.arrayContaining(
          inventory.installations.map((installation) => installation.id),
        ),
        effects: expect.arrayContaining([
          expect.objectContaining({ harnessId: harness }),
          expect.objectContaining({ harnessId: harness }),
        ]),
      });
      const audit: unknown[] = [];
      const runner = execution(
        join(fixture.environment.state, "skill-cleaner"),
        fixture.scanLive,
        audit,
      );
      const report = await runner.module.executeAvailability(availabilityPlan, {
        grants: [{ kind: "confirmation" }],
      });
      expect(report.status).toBe("succeeded");
      expect(
        (await fixture.scanLive()).installations.map(
          (installation) => installation.harnessExposures[0]!.status,
        ),
      ).toEqual(["disabled", "disabled"]);
    });
  }

  it("plans one complete suspension for a Vercel-managed primary and two supplemental artifacts", async () => {
    const environment = await environmentFixture();
    const paths = ["a-primary", "b-claude-copy", "c-gemini-copy"].map((name) =>
      join(environment.temporary, "vercel-managed", name),
    );
    const writableProtection = {
      git: { kind: "outside-worktree" as const },
      system: { kind: "none" as const },
      filesystem: { kind: "writable" as const },
    };
    const installation = buildInstallation({
      id: "vercel-managed-three-paths",
      skill: { name: "review-suite", description: null },
      manager: { id: "vercel-skills" },
      adapterId: "vercel.skills",
      agentId: "vercel-skills",
      exposedTo: ["claude-code", "codex", "gemini-cli"],
      harnessExposures: ["claude-code", "codex", "gemini-cli"].map(
        (harnessId) => ({
          harnessId,
          status: "enabled" as const,
          control: {
            kind: "unsupported" as const,
            reason: "Vercel placed this artifact outside native control",
          },
        }),
      ),
      location: {
        path: paths[0]!,
        canonicalPath: paths[0]!,
        artifactType: { kind: "directory" },
      },
      ownership: {
        kind: "manager",
        managerId: "vercel-skills",
        confidence: "declared",
      },
      protection: writableProtection,
      suspension: {
        kind: "available",
        artifacts: paths.map((path) => ({
          location: {
            path,
            canonicalPath: path,
            artifactType: { kind: "directory" as const },
          },
          protection: writableProtection,
        })),
        managerRecord: "preserved",
        managerMayRecreate: true,
      },
      removal: {
        managed: null,
        fallback: {
          kind: "available",
          requiresSeparateConfirmation: true,
        },
        primaryArtifactPresent: true,
        supplementalArtifacts: paths.slice(1).map((path) => ({
          location: {
            path,
            canonicalPath: path,
            artifactType: { kind: "directory" as const },
          },
          protection: writableProtection,
        })),
        recordCleanups: [],
      },
    });

    const availabilityPlan = planAvailability(
      buildInventory({ installations: [installation] }),
      [],
      {
        operation: "disable",
        targets: [{ kind: "installation", installationId: installation.id }],
        force: false,
      },
    );

    expect(availabilityPlan.blocks).toEqual([]);
    expect(availabilityPlan.actions).toHaveLength(1);
    expect(availabilityPlan.actions[0]).toMatchObject({
      kind: "suspended-disable",
      installationId: installation.id,
      affectedInstallationIds: [installation.id],
    });
    const action = availabilityPlan.actions[0];
    if (
      action?.kind !== "suspended-disable" ||
      !("artifacts" in action.request)
    )
      throw new TypeError("expected one multi-artifact suspension action");
    expect(
      action.request.artifacts.map((artifact) => artifact.location.path),
    ).toEqual(paths);
  });

  it("disables and enables a complete Vercel-managed set while preserving Manager state", async () => {
    const environment = await environmentFixture();
    const paths = ["a-primary", "b-claude-copy", "c-gemini-copy"].map((name) =>
      join(environment.temporary, "vercel-round-trip", name),
    );
    const managerRecord = join(
      environment.temporary,
      "vercel-round-trip",
      "manager-record.json",
    );
    await mkdir(join(environment.temporary, "vercel-round-trip"), {
      recursive: true,
    });
    await Promise.all(
      paths.map((path, index) => writeFile(path, `artifact-${index}`)),
    );
    await writeFile(managerRecord, '{"installed":true}\n');
    const protection = {
      git: { kind: "outside-worktree" as const },
      system: { kind: "none" as const },
      filesystem: { kind: "writable" as const },
    };
    const artifacts = paths.map((path) => ({
      location: {
        path,
        canonicalPath: path,
        artifactType: { kind: "file" as const },
      },
      protection,
    }));
    const installation = buildInstallation({
      id: "vercel-round-trip",
      skill: { name: "managed-review", description: null },
      manager: { id: "vercel-skills" },
      adapterId: "vercel.skills",
      agentId: "vercel-skills",
      exposedTo: ["codex"],
      harnessExposures: [
        {
          harnessId: "codex",
          status: "enabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
      ],
      location: artifacts[0]!.location,
      ownership: {
        kind: "manager",
        managerId: "vercel-skills",
        confidence: "declared",
      },
      protection,
      suspension: {
        kind: "available",
        artifacts,
        managerRecord: "preserved",
        managerMayRecreate: true,
      },
      removal: {
        managed: null,
        fallback: {
          kind: "available",
          requiresSeparateConfirmation: true,
        },
        primaryArtifactPresent: true,
        supplementalArtifacts: artifacts.slice(1),
        recordCleanups: [],
      },
    });
    const scanLive = async () => {
      const present = await Promise.all(
        paths.map((path) =>
          access(path).then(
            () => true,
            () => false,
          ),
        ),
      );
      return buildInventory({
        installations: present.every(Boolean) ? [installation] : [],
      });
    };
    const target = {
      kind: "installation" as const,
      installationId: installation.id,
    };
    const audit: unknown[] = [];
    const runner = execution(
      join(environment.state, "vercel-round-trip"),
      scanLive,
      audit,
    );
    const disablePlan = planAvailability(await scanLive(), [], {
      operation: "disable",
      targets: [target],
      force: false,
    });
    await expect(
      runner.module.executeAvailability(disablePlan, {
        grants: [{ kind: "confirmation" }],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const entries = await runner.disabledStorage.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.schemaVersion).toBe(2);
    await expect(readFile(managerRecord, "utf8")).resolves.toBe(
      '{"installed":true}\n',
    );
    const enablePlan = planAvailability(await scanLive(), entries, {
      operation: "enable",
      targets: [target],
      force: false,
    });
    await expect(
      runner.module.executeAvailability(enablePlan, {
        grants: [{ kind: "confirmation" }],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    for (let index = 0; index < paths.length; index += 1)
      await expect(readFile(paths[index]!, "utf8")).resolves.toBe(
        `artifact-${index}`,
      );
    await expect(readFile(managerRecord, "utf8")).resolves.toBe(
      '{"installed":true}\n',
    );
    await expect(runner.disabledStorage.list()).resolves.toEqual([]);
    expect(audit).toHaveLength(2);
  });

  it("reports and audits a final Availability rescan failure without claiming verification", async () => {
    const fixture = await nativeFixture("codex", ["rescan-review"]);
    const inventory = await fixture.scanLive();
    const target = {
      kind: "installation" as const,
      installationId: inventory.installations[0]!.id,
    };
    const availabilityPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: [target],
      force: false,
    });
    let scans = 0;
    const audit: unknown[] = [];
    const runner = execution(
      join(fixture.environment.state, "skill-cleaner"),
      fixture.scanLive,
      audit,
      {
        scan: async () => {
          scans += 1;
          if (scans === 1) return fixture.scanLive();
          throw new Error("injected final rescan failure");
        },
      },
    );
    const report = await runner.module.executeAvailability(availabilityPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("partial");
    expect(report.finalInventoryId).toBeNull();
    expect(report.rescanError).toMatchObject({ code: "final-rescan-failed" });
    expect(report.verificationResults).toEqual([]);
    expect(report.actionResults).toMatchObject([{ status: "succeeded" }]);
    expect(report.targetResults).toMatchObject([{ status: "partial" }]);
    expect(await readFile(fixture.config, "utf8")).toContain("enabled = false");
    expect(audit).toHaveLength(1);
  });

  for (const harness of ["codex", "claude-code", "gemini-cli"] as const) {
    it(`round-trips a workspace ${harness} Skill through its applicable native layer`, async () => {
      const fixture = await nativeWorkspaceFixture(harness);
      const audit: unknown[] = [];
      const initial = await fixture.scanLive();
      const installation = initial.installations[0]!;
      expect(installation.scope).toMatchObject({ kind: "workspace" });
      const target = {
        kind: "installation" as const,
        installationId: installation.id,
      };
      const preimage = await readFile(fixture.config, "utf8");
      const disabledPlan = planAvailability(initial, [], {
        operation: "disable",
        targets: [target],
        force: false,
      });
      expect(disabledPlan.blocks).toEqual([]);
      expect(disabledPlan.actions).toHaveLength(1);
      await expect(readFile(fixture.config, "utf8")).resolves.toBe(preimage);
      await expect(
        access(join(fixture.environment.state, "skill-cleaner")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const action = disabledPlan.actions[0]!;
      if (action.kind !== "native-control")
        throw new Error("expected native control");
      expect(
        action.mutations.map((mutation) => mutation.documentScope),
      ).toEqual([
        harness === "codex"
          ? "user"
          : harness === "claude-code"
            ? "local-workspace"
            : "workspace",
      ]);
      const runner = execution(
        join(fixture.environment.state, "skill-cleaner"),
        fixture.scanLive,
        audit,
      );
      const disabled = await runner.module.executeAvailability(disabledPlan, {
        grants: [{ kind: "confirmation" }],
      });
      expect(disabled.status).toBe("succeeded");
      expect(
        (await fixture.scanLive()).installations[0]!.harnessExposures[0]!
          .status,
      ).toBe("disabled");
      const changed = await readFile(fixture.config, "utf8");
      expect(changed).toContain(
        harness === "codex"
          ? "workspace fixture"
          : harness === "claude-code"
            ? '"unrelated": "keep"'
            : "workspace fixture",
      );
      const enablePlan = planAvailability(await fixture.scanLive(), [], {
        operation: "enable",
        targets: [target],
        force: false,
      });
      const enabled = await runner.module.executeAvailability(enablePlan, {
        grants: [{ kind: "confirmation" }],
      });
      expect(enabled.status).toBe("succeeded");
      expect(
        (await fixture.scanLive()).installations[0]!.harnessExposures[0]!
          .status,
      ).toBe("enabled");
      await expect(runner.disabledStorage.list()).resolves.toEqual([]);
      expect(audit).toHaveLength(2);
    });
  }

  it("suspends and enables one unsupported standalone filesystem Skill only through Disabled Storage", async () => {
    const environment = await environmentFixture();
    const root = join(environment.temporary, "unsupported-skills");
    const source = join(root, "review");
    await createSkill(source, "review");
    const roots: readonly DiscoveryRoot[] = [
      { kind: "user", path: root, agentId: "fixture-harness", adapterId: null },
    ];
    const scanLive = () =>
      scan(
        {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
        },
        roots,
      );
    const initial = await scanLive();
    const target = {
      kind: "installation" as const,
      installationId: initial.installations[0]!.id,
    };
    const disabledPlan = planAvailability(initial, [], {
      operation: "disable",
      targets: [target],
      force: false,
    });
    expect(disabledPlan.actions).toMatchObject([{ kind: "suspended-disable" }]);
    const audit: unknown[] = [];
    const runner = execution(
      join(environment.state, "skill-cleaner"),
      scanLive,
      audit,
    );
    const disabled = await runner.module.executeAvailability(disabledPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(disabled.status).toBe("succeeded");
    const entries = await runner.disabledStorage.list();
    expect(entries).toHaveLength(1);
    expect((await scanLive()).installations).toHaveLength(0);

    const enablePlan = planAvailability(await scanLive(), entries, {
      operation: "enable",
      targets: [target],
      force: false,
    });
    expect(enablePlan.actions).toMatchObject([{ kind: "suspended-enable" }]);
    const enabled = await runner.module.executeAvailability(enablePlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(enabled.status).toBe("succeeded");
    expect(await runner.disabledStorage.list()).toEqual([]);
    expect(
      (await scanLive()).installations[0]!.harnessExposures[0]!.status,
    ).toBe("enabled");
  });

  it("force cannot act when a Disabled entry path is reoccupied, duplicated, or disabled again", async () => {
    const environment = await environmentFixture();
    const root = join(environment.temporary, "reoccupied-skills");
    const source = join(root, "review");
    await createSkill(source, "review");
    const roots: readonly DiscoveryRoot[] = [
      { kind: "user", path: root, agentId: "fixture-harness", adapterId: null },
    ];
    const scanLive = () =>
      scan(
        {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
        },
        roots,
      );
    const initial = await scanLive();
    const originalId = initial.installations[0]!.id;
    const audit: unknown[] = [];
    const runner = execution(
      join(environment.state, "skill-cleaner"),
      scanLive,
      audit,
    );
    const suspendPlan = planAvailability(initial, [], {
      operation: "disable",
      targets: [{ kind: "installation", installationId: originalId }],
      force: false,
    });
    expect(
      await runner.module.executeAvailability(suspendPlan, {
        grants: [{ kind: "confirmation" }],
      }),
    ).toMatchObject({ status: "succeeded" });
    const entries = await runner.disabledStorage.list();
    expect(entries).toHaveLength(1);
    audit.length = 0;

    await createSkill(source, "replacement");
    const replacementBefore = await readFile(join(source, "SKILL.md"), "utf8");
    const occupiedInventory = await scanLive();
    const enablePlan = planAvailability(occupiedInventory, entries, {
      operation: "enable",
      targets: [{ kind: "installation", installationId: originalId }],
      force: true,
    });
    expect(enablePlan.actions).toEqual([]);
    expect(enablePlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "configuration-unsafe",
        overridable: false,
        reason: expect.stringContaining("live Installation occupies"),
      }),
    );
    expect(
      await runner.module.executeAvailability(enablePlan, {
        grants: [{ kind: "confirmation" }],
      }),
    ).toMatchObject({ status: "blocked" });

    const replacementId = occupiedInventory.installations[0]!.id;
    const disableAgain = planAvailability(occupiedInventory, entries, {
      operation: "disable",
      targets: [{ kind: "installation", installationId: replacementId }],
      force: true,
    });
    expect(disableAgain.actions).toEqual([]);
    expect(disableAgain.blocks).toContainEqual(
      expect.objectContaining({
        kind: "configuration-unsafe",
        overridable: false,
        reason: expect.stringContaining("already exists"),
      }),
    );
    expect(
      await runner.module.executeAvailability(disableAgain, {
        grants: [{ kind: "confirmation" }],
      }),
    ).toMatchObject({ status: "blocked" });
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(
      replacementBefore,
    );
    expect(await runner.disabledStorage.list()).toEqual(entries);
    expect(audit).toEqual([]);

    const differentCanonicalOccupant = buildInstallation({
      id: "different-canonical-occupant",
      location: {
        path:
          entries[0]!.schemaVersion === 1
            ? entries[0]!.originalLocation.path
            : entries[0]!.artifacts[0]!.originalLocation.path,
        canonicalPath: join(environment.temporary, "different-target"),
        artifactType:
          entries[0]!.schemaVersion === 1
            ? entries[0]!.originalLocation.artifactType
            : entries[0]!.artifacts[0]!.originalLocation.artifactType,
      },
    });
    const pathAliasPlan = planAvailability(
      buildInventory({ installations: [differentCanonicalOccupant] }),
      entries,
      {
        operation: "enable",
        targets: [{ kind: "installation", installationId: originalId }],
        force: true,
      },
    );
    expect(pathAliasPlan.actions).toEqual([]);
    expect(pathAliasPlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "configuration-unsafe",
        reason: expect.stringContaining("live Installation occupies"),
        overridable: false,
      }),
    );

    const duplicate = { ...entries[0]!, id: "disabled-duplicate" as never };
    const duplicatePlan = planAvailability(
      buildInventory({
        installations: [],
        otherFindings: [],
        logicalSkills: [],
        identityHints: [],
        groups: [],
        plugins: [],
        dependencies: [],
      }),
      [entries[0]!, duplicate],
      {
        operation: "enable",
        targets: [{ kind: "installation", installationId: originalId }],
        force: true,
      },
    );
    expect(duplicatePlan.actions).toEqual([]);
    expect(duplicatePlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "configuration-unsafe",
        reason: expect.stringContaining("another Disabled Storage entry"),
        overridable: false,
      }),
    );
  });

  it("reports one multi-harness Installation successful only after every exposure changes", async () => {
    const environment = await environmentFixture();
    const root = join(environment.temporary, "shared-skill");
    await createSkill(join(root, "shared"), "shared");
    const codexHome = join(environment.home, ".codex");
    const geminiHome = join(environment.home, ".gemini");
    await mkdir(codexHome, { recursive: true });
    await mkdir(geminiHome, { recursive: true });
    await writeFile(join(codexHome, "config.toml"), "# codex shared\n");
    await writeFile(
      join(geminiHome, "settings.json"),
      '{ // gemini shared\n "skills": { "disabled": [] }\n}\n',
    );
    const scanLive = async (): Promise<Inventory> => {
      const codex = await scan(
        {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
          agentHomeDirectories: { codex: codexHome },
        },
        [{ kind: "user", path: root, agentId: "codex", adapterId: null }],
      );
      const gemini = await scan(
        {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
          agentHomeDirectories: { "gemini-cli": geminiHome },
          geminiWorkspaceTrusted: false,
        },
        [
          {
            kind: "user",
            path: root,
            agentId: "gemini-cli",
            adapterId: null,
          },
        ],
      );
      return {
        ...codex,
        id: `${codex.id}-${gemini.id}` as Inventory["id"],
        installations: [
          {
            ...codex.installations[0]!,
            exposedTo: ["codex", "gemini-cli"],
            harnessExposures: [
              ...codex.installations[0]!.harnessExposures,
              ...gemini.installations[0]!.harnessExposures,
            ],
          },
        ],
      };
    };
    const inventory = await scanLive();
    expect(inventory.installations).toHaveLength(1);
    expect(inventory.installations[0]!.harnessExposures).toHaveLength(2);
    const availabilityPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: [
        {
          kind: "installation",
          installationId: inventory.installations[0]!.id,
        },
      ],
      force: false,
    });
    expect(availabilityPlan.actions).toHaveLength(2);
    expect(availabilityPlan.verificationChecks).toHaveLength(2);
    const audit: unknown[] = [];
    const runner = execution(
      join(environment.state, "skill-cleaner"),
      scanLive,
      audit,
    );
    const report = await runner.module.executeAvailability(availabilityPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("succeeded");
    expect(report.targetResults).toMatchObject([{ status: "disabled" }]);
    expect(
      (await scanLive()).installations[0]!.harnessExposures.map(
        (exposure) => exposure.status,
      ),
    ).toEqual(["disabled", "disabled"]);

    const disabledInventory = await scanLive();
    const enablePlan = planAvailability(disabledInventory, [], {
      operation: "enable",
      targets: [
        {
          kind: "installation",
          installationId: disabledInventory.installations[0]!.id,
        },
      ],
      force: false,
    });
    let scans = 0;
    const racingScan = async () => {
      const current = await scanLive();
      scans += 1;
      if (scans === 1)
        await writeFile(
          join(codexHome, "config.toml"),
          `${await readFile(join(codexHome, "config.toml"), "utf8")}# raced codex\n`,
        );
      return current;
    };
    const partialRunner = execution(
      join(environment.state, "skill-cleaner-partial"),
      scanLive,
      audit,
      { scan: racingScan },
    );
    const partial = await partialRunner.module.executeAvailability(enablePlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(partial.status).toBe("partial");
    expect(partial.targetResults).toMatchObject([{ status: "partial" }]);
    expect(partial.actionResults.map((result) => result.status).sort()).toEqual(
      ["failed", "succeeded"],
    );
    expect(
      (await scanLive()).installations[0]!.harnessExposures.map(
        (exposure) => exposure.status,
      ),
    ).toEqual(["disabled", "enabled"]);
  });

  it("rejects stale and forged plans before mutation or audit", async () => {
    const fixture = await nativeFixture("codex", ["review"]);
    const inventory = await fixture.scanLive();
    const target = {
      kind: "installation" as const,
      installationId: inventory.installations[0]!.id,
    };
    const availabilityPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: [target],
      force: false,
    });
    const external = join(fixture.environment.workspace, "external.toml");
    await writeFile(external, "external = true\n");
    const forged = structuredClone(availabilityPlan) as AvailabilityPlan;
    (
      forged.actions[0] as unknown as { mutations: Array<{ path: string }> }
    ).mutations[0]!.path = external;
    const audit: unknown[] = [];
    const runner = execution(
      join(fixture.environment.state, "skill-cleaner"),
      fixture.scanLive,
      audit,
    );
    const forgedReport = await runner.module.executeAvailability(forged, {
      grants: [{ kind: "confirmation" }],
    });
    expect(forgedReport.status).toBe("blocked");
    await expect(readFile(external, "utf8")).resolves.toBe("external = true\n");
    expect(audit).toEqual([]);

    await writeFile(
      fixture.config,
      '# changed after planning\n[terminal]\nlabel = "new"\n',
    );
    const stale = await runner.module.executeAvailability(availabilityPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(stale.status).toBe("blocked");
    expect(await readFile(fixture.config, "utf8")).toContain(
      "changed after planning",
    );
    expect(audit).toEqual([]);
  });

  it("normalizes contained targets and blocks colliding name controls without mutation", async () => {
    const fixture = await nativeFixture("claude-code", ["same", "same-copy"]);
    const firstPath = join(fixture.root, "same", "SKILL.md");
    const secondPath = join(fixture.root, "same-copy", "SKILL.md");
    await writeFile(firstPath, "---\nname: collision\n---\n# first\n");
    await writeFile(secondPath, "---\nname: collision\n---\n# second\n");
    const inventory = await fixture.scanLive();
    const first = inventory.installations.find(
      (installation) =>
        installation.location.path === join(fixture.root, "same"),
    )!;
    const collisionPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: [{ kind: "installation", installationId: first.id }],
      force: true,
    });
    expect(collisionPlan.actions).toEqual([]);
    expect(collisionPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "name-collision", overridable: false }),
    );
    const before = await readFile(fixture.config, "utf8");
    const audit: unknown[] = [];
    const runner = execution(
      join(fixture.environment.state, "skill-cleaner"),
      fixture.scanLive,
      audit,
    );
    const report = await runner.module.executeAvailability(collisionPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("blocked");
    expect(await readFile(fixture.config, "utf8")).toBe(before);
    expect(audit).toEqual([]);

    const logical = buildLogicalSkill({
      id: "logical-contained",
      installationIds: [first.id],
      identity: first.identity,
      skill: first.skill,
    });
    const contained = planAvailability(
      buildInventory({
        ...inventory,
        logicalSkills: [logical],
      }),
      [],
      {
        operation: "disable",
        targets: [
          { kind: "installation", installationId: first.id },
          { kind: "logical-skill", logicalSkillId: logical.id },
        ],
        force: false,
      },
    );
    expect(contained.targets).toEqual([
      { kind: "logical-skill", logicalSkillId: logical.id },
    ]);
  });

  it("blocks name controls colliding with unsupported Plugin and System Skills even with force", async () => {
    const fixture = await nativeFixture("claude-code", ["selected"]);
    await writeFile(
      join(fixture.root, "selected", "SKILL.md"),
      "---\nname: collision\n---\n# selected\n",
    );
    const scanned = await fixture.scanLive();
    const selected = scanned.installations[0]!;
    const managedRemoval = {
      managed: {
        adapterId: "fixture-adapter",
        operationId: "remove",
        availability: { kind: "available" as const },
        trust: { kind: "trusted" as const },
        externalId: "owned-skill",
        invocation: {
          kind: "direct" as const,
          command: {
            executable: "fixture-manager",
            arguments: ["remove", "owned-skill"],
          },
        },
        effects: [],
        verifications: [],
      },
      fallback: {
        kind: "available" as const,
        requiresSeparateConfirmation: true as const,
      },
      recordCleanups: [],
    };
    const plugin = buildInstallation({
      id: "plugin-collision",
      classification: "managed-plugin-resource",
      skill: { name: "collision", description: null },
      plugin: { id: "fixture-plugin", version: "1.0.0" },
      pluginBoundaryId: "fixture-plugin",
      agentId: "claude-code",
      exposedTo: ["claude-code"],
      ownership: {
        kind: "plugin",
        pluginId: "fixture-plugin",
        independentlySelectable: false,
        confidence: "declared",
      },
      removal: managedRemoval,
      location: {
        path: "/fixtures/plugin-collision",
        canonicalPath: "/fixtures/plugin-collision",
        artifactType: { kind: "directory" },
      },
    });
    const boundary = {
      ...buildPluginBoundary(),
      exposedTo: ["claude-code"],
      installationIds: [plugin.id],
    };
    const system = buildSystemSkillFinding({
      id: "system-collision",
      skill: { name: "collision", description: null },
      agentId: "claude-code",
      scope: { kind: "agent", agentId: "claude-code" },
      ownership: {
        kind: "agent-runtime",
        agentId: "claude-code",
        confidence: "declared",
      },
      protection: {
        git: { kind: "outside-worktree" },
        system: { kind: "system-skill", agentId: "claude-code" },
        filesystem: { kind: "read-only", reason: "runtime content" },
      },
    });
    for (const collisionInventory of [
      buildInventory({
        ...scanned,
        installations: [selected, plugin],
        plugins: [boundary],
      }),
      buildInventory({ ...scanned, otherFindings: [system] }),
    ]) {
      const availabilityPlan = planAvailability(collisionInventory, [], {
        operation: "disable",
        targets: [{ kind: "installation", installationId: selected.id }],
        force: true,
      });
      expect(availabilityPlan.actions).toEqual([]);
      expect(availabilityPlan.blocks).toContainEqual(
        expect.objectContaining({ kind: "name-collision", overridable: false }),
      );
    }
  });

  it("blocks hard dependencies by default and force never bypasses ownership or System protection", () => {
    const required = buildInstallation({
      id: "required",
      skill: { name: "required", description: null },
      location: {
        path: "/fixtures/required",
        canonicalPath: "/fixtures/required",
        artifactType: { kind: "directory" },
      },
    });
    const dependent = buildInstallation({
      id: "dependent",
      skill: { name: "dependent", description: null },
      location: {
        path: "/fixtures/dependent",
        canonicalPath: "/fixtures/dependent",
        artifactType: { kind: "directory" },
      },
    });
    const dependency = {
      kind: "hard" as const,
      dependentInstallationId: dependent.id,
      target: { kind: "installation" as const, installationId: required.id },
      source: { kind: "adapter" as const, adapterId: "fixture-adapter" },
      reason: "dependent requires required",
    };
    const inventory = buildInventory({
      installations: [required, dependent],
      dependencies: [dependency],
    });
    const target = {
      kind: "installation" as const,
      installationId: required.id,
    };
    const blocked = planAvailability(inventory, [], {
      operation: "disable",
      targets: [target],
      force: false,
    });
    expect(blocked.actions).toEqual([]);
    expect(blocked.blocks).toContainEqual(
      expect.objectContaining({ kind: "hard-dependency", overridable: true }),
    );
    const forced = planAvailability(inventory, [], {
      operation: "disable",
      targets: [target],
      force: true,
    });
    expect(forced.actions[0]?.approvals).toContainEqual({
      kind: "force-override",
      safeguards: ["dependency"],
    });
    const cycleInventory = buildInventory({
      installations: [required, dependent],
      dependencies: [
        dependency,
        {
          ...dependency,
          dependentInstallationId: required.id,
          target: {
            kind: "installation",
            installationId: dependent.id,
          },
        },
      ],
    });
    const cycleIntent = {
      operation: "disable" as const,
      targets: [
        { kind: "installation" as const, installationId: required.id },
        { kind: "installation" as const, installationId: dependent.id },
      ],
    };
    expect(
      planAvailability(cycleInventory, [], {
        ...cycleIntent,
        force: false,
      }).actions,
    ).toEqual([]);
    const forcedCycle = planAvailability(cycleInventory, [], {
      ...cycleIntent,
      force: true,
    });
    expect(forcedCycle.actions).toHaveLength(2);
    expect(forcedCycle.actions[1]?.dependsOn).toEqual([
      forcedCycle.actions[0]?.id,
    ]);

    const managedRemoval = {
      managed: {
        adapterId: "fixture-adapter",
        operationId: "remove",
        availability: { kind: "available" as const },
        trust: { kind: "trusted" as const },
        externalId: "owned-skill",
        invocation: {
          kind: "direct" as const,
          command: {
            executable: "fixture-manager",
            arguments: ["remove", "owned-skill"],
          },
        },
        effects: [],
        verifications: [],
      },
      fallback: {
        kind: "available" as const,
        requiresSeparateConfirmation: true as const,
      },
      recordCleanups: [],
    };
    const pluginOwned = buildInstallation({
      id: "plugin-owned",
      classification: "managed-plugin-resource",
      plugin: { id: "fixture-plugin", version: "1.0.0" },
      pluginBoundaryId: "fixture-plugin",
      ownership: {
        kind: "plugin",
        pluginId: "fixture-plugin",
        independentlySelectable: false,
        confidence: "declared",
      },
      removal: managedRemoval,
    });
    const managerOwned = buildInstallation({
      id: "manager-owned",
      manager: { id: "manager" },
      ownership: {
        kind: "manager",
        managerId: "manager",
        confidence: "declared",
      },
      removal: managedRemoval,
    });
    for (const protectedInstallation of [pluginOwned, managerOwned]) {
      const absolute = planAvailability(
        buildInventory({
          installations: [protectedInstallation],
          plugins:
            protectedInstallation.id === pluginOwned.id
              ? [
                  {
                    ...buildPluginBoundary(),
                    installationIds: [pluginOwned.id],
                  },
                ]
              : [],
        }),
        [],
        {
          operation: "disable",
          targets: [
            {
              kind: "installation",
              installationId: protectedInstallation.id,
            },
          ],
          force: true,
        },
      );
      expect(absolute.actions).toEqual([]);
      expect(absolute.blocks.some((block) => !block.overridable)).toBe(true);
    }

    const system = buildSystemSkillFinding({ id: "system-owned" });
    expect(() =>
      planAvailability(
        buildInventory({ installations: [], otherFindings: [system] }),
        [],
        {
          operation: "disable",
          targets: [
            { kind: "installation", installationId: system.id as never },
          ],
          force: true,
        },
      ),
    ).toThrow(/Installation not found/);
  });

  it("fails a protected live mutation without touching configuration or creating audit state", async () => {
    const fixture = await nativeFixture("codex", ["review"]);
    const inventory = await fixture.scanLive();
    const availabilityPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: [
        {
          kind: "installation",
          installationId: inventory.installations[0]!.id,
        },
      ],
      force: false,
    });
    const before = await readFile(fixture.config, "utf8");
    const audit: unknown[] = [];
    const runner = execution(
      join(fixture.environment.state, "skill-cleaner"),
      fixture.scanLive,
      audit,
      {
        inspectGitProtection: async () => ({
          kind: "protected",
          worktreeRoot: fixture.environment.workspace,
        }),
      },
    );
    const report = await runner.module.executeAvailability(availabilityPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("failed");
    expect(await readFile(fixture.config, "utf8")).toBe(before);
    expect(audit).toEqual([]);
  });

  it("detects a post-replan preimage race before writing or auditing", async () => {
    const fixture = await nativeFixture("codex", ["review"]);
    const inventory = await fixture.scanLive();
    const availabilityPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: [
        {
          kind: "installation",
          installationId: inventory.installations[0]!.id,
        },
      ],
      force: false,
    });
    let scans = 0;
    const racingScan = async () => {
      const current = await fixture.scanLive();
      scans += 1;
      if (scans === 1)
        await writeFile(
          fixture.config,
          `${await readFile(fixture.config, "utf8")}# raced after scan\n`,
        );
      return current;
    };
    const audit: unknown[] = [];
    const runner = execution(
      join(fixture.environment.state, "skill-cleaner"),
      fixture.scanLive,
      audit,
      { scan: racingScan },
    );

    const report = await runner.module.executeAvailability(availabilityPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("failed");
    expect(report.actionResults[0]).toMatchObject({
      status: "failed",
      error: { code: "native-control-failed" },
    });
    expect(await readFile(fixture.config, "utf8")).toContain(
      "raced after scan",
    );
    expect(await readFile(fixture.config, "utf8")).not.toContain(
      "[[skills.config]]",
    );
    expect(audit).toEqual([]);
  });

  it("blocks a dependent branch after failure while continuing an independent document", async () => {
    const environment = await environmentFixture();
    const codexRoot = join(environment.temporary, "codex-partial");
    const geminiRoot = join(environment.temporary, "gemini-partial");
    const claudeRoot = join(environment.temporary, "claude-dependent");
    await createSkill(join(codexRoot, "codex-skill"), "codex-skill");
    await createSkill(join(geminiRoot, "gemini-skill"), "gemini-skill");
    await createSkill(join(claudeRoot, "claude-skill"), "claude-skill");
    const codexHome = join(environment.home, ".codex");
    const geminiHome = join(environment.home, ".gemini");
    const claudeHome = join(environment.home, ".claude");
    await mkdir(codexHome, { recursive: true });
    await mkdir(geminiHome, { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    const codexConfig = join(codexHome, "config.toml");
    const geminiConfig = join(geminiHome, "settings.json");
    const claudeConfig = join(claudeHome, "settings.json");
    await writeFile(codexConfig, "# codex\n");
    await writeFile(
      geminiConfig,
      '{ // gemini\n "skills": { "disabled": [] }\n}\n',
    );
    await writeFile(claudeConfig, '{ "skillOverrides": {} }\n');
    const roots: readonly DiscoveryRoot[] = [
      { kind: "user", path: codexRoot, agentId: "codex", adapterId: null },
      {
        kind: "user",
        path: geminiRoot,
        agentId: "gemini-cli",
        adapterId: null,
      },
      {
        kind: "user",
        path: claudeRoot,
        agentId: "claude-code",
        adapterId: null,
      },
    ];
    const scanBase = () =>
      scan(
        {
          homeDirectory: environment.home,
          workspaceDirectory: environment.workspace,
          agentHomeDirectories: {
            codex: codexHome,
            "gemini-cli": geminiHome,
            "claude-code": claudeHome,
          },
          geminiWorkspaceTrusted: false,
        },
        roots,
      );
    const scanLive = async (): Promise<Inventory> => {
      const current = await scanBase();
      const codex = current.installations.find(
        (installation) => installation.agentId === "codex",
      )!;
      const claude = current.installations.find(
        (installation) => installation.agentId === "claude-code",
      )!;
      return {
        ...current,
        dependencies: [
          {
            kind: "hard",
            dependentInstallationId: codex.id,
            target: {
              kind: "installation",
              installationId: claude.id,
            },
            source: { kind: "adapter", adapterId: "fixture-adapter" },
            reason: "Codex skill depends on Claude skill",
          },
        ],
      };
    };
    const inventory = await scanLive();
    const availabilityPlan = planAvailability(inventory, [], {
      operation: "disable",
      targets: inventory.installations.map((installation) => ({
        kind: "installation",
        installationId: installation.id,
      })),
      force: false,
    });
    expect(availabilityPlan.actions).toHaveLength(3);
    const codexAction = availabilityPlan.actions.find(
      (action) =>
        action.kind === "native-control" &&
        action.effects.some((effect) => effect.harnessId === "codex"),
    )!;
    const claudeAction = availabilityPlan.actions.find(
      (action) =>
        action.kind === "native-control" &&
        action.effects.some((effect) => effect.harnessId === "claude-code"),
    )!;
    expect(claudeAction.dependsOn).toContain(codexAction.id);
    let scans = 0;
    const racingScan = async () => {
      const current = await scanLive();
      scans += 1;
      if (scans === 1) await writeFile(codexConfig, "# raced codex\n");
      return current;
    };
    const audit: unknown[] = [];
    const runner = execution(
      join(environment.state, "skill-cleaner"),
      scanLive,
      audit,
      { scan: racingScan },
    );
    const report = await runner.module.executeAvailability(availabilityPlan, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("partial");
    expect(report.actionResults.map((result) => result.status).sort()).toEqual([
      "blocked",
      "failed",
      "succeeded",
    ]);
    expect(await readFile(codexConfig, "utf8")).toBe("# raced codex\n");
    expect(await readFile(claudeConfig, "utf8")).toBe(
      '{ "skillOverrides": {} }\n',
    );
    expect(await readFile(geminiConfig, "utf8")).toContain("gemini-skill");
    expect(audit).toHaveLength(1);
  });
});
