import { describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  parseUpdatePlan,
  parseUpdateReport,
  planUpdate,
  stringifyModel,
  type ExecutionModuleOptions,
  type Installation,
  type Inventory,
  type ManagedUpdateEvidence,
  type QuarantineModule,
  type UpdatePlan,
  type UpdateReport,
} from "../src/index.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
} from "../src/testing/index.js";

const protection = {
  git: { kind: "outside-worktree" as const },
  system: { kind: "none" as const },
  filesystem: { kind: "writable" as const },
};

function operation(
  version: number,
  installationName = "example-skill",
): ManagedUpdateEvidence {
  return {
    adapterId: "fixture-adapter",
    operationId: "update",
    availability: { kind: "available" },
    trust: { kind: "trusted" },
    owner: {
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    },
    externalId: "fixture-lock-key",
    invocation: {
      kind: "direct",
      command: {
        executable: "fixture-manager",
        arguments: ["update", "fixture-lock-key"],
      },
      workingDirectory: { kind: "exact", path: "/fixtures/workspace" },
    },
    source: { id: "fixture-source", url: "https://example.test/source" },
    ref: "main",
    scope: { kind: "workspace", workspacePath: "/fixtures/workspace" },
    currentRevision: [
      {
        kind: "owner-value",
        path: "/fixtures/manager.json",
        format: "json",
        recordPointer: "/skills/fixture/version",
        value: version,
      },
    ],
    ownerRecordDigest: { algorithm: "sha256", digest: "a".repeat(64) },
    effects: [
      {
        kind: "mutation-root",
        path: `/fixtures/skills/${installationName}`,
        exists: true,
        protection,
      },
      {
        kind: "configuration-path",
        path: "/fixtures/manager.json",
        exists: true,
        protection,
      },
    ],
    network: { kind: "required", reason: "Owner fetches the recorded source" },
    packageDownload: { kind: "none" },
    localChanges: { kind: "unavailable", reason: "fixture has no comparison" },
    verifications: [
      {
        kind: "revision-manifest-value",
        path: "/fixtures/manager.json",
        format: "json",
        recordPointer: "/skills/fixture/version",
        value: version,
      },
    ],
  };
}

function installation(
  id = "installation-1",
  version = 1,
  overrides: Parameters<typeof buildInstallation>[0] = {},
): Installation {
  return buildInstallation({
    id,
    skill: { name: id, description: null },
    source: { id: "fixture-source", url: "https://example.test/source" },
    manager: { id: "fixture-manager" },
    adapterId: "fixture-adapter",
    ownership: {
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    },
    scope: { kind: "workspace", workspacePath: "/fixtures/workspace" },
    location: {
      path: `/fixtures/skills/${id}`,
      canonicalPath: `/fixtures/skills/${id}`,
      artifactType: { kind: "directory" },
    },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "source",
          sourceId: "fixture-source",
          skillPath: id,
        },
      ],
      weakEvidence: [{ strength: "weak", kind: "name", normalizedName: id }],
    },
    update: { kind: "managed", operation: operation(version, id) },
    ...overrides,
  });
}

function inventory(
  item: Installation,
  id = "inventory-before",
  overrides: Parameters<typeof buildInventory>[0] = {},
): Inventory {
  return buildInventory({
    id,
    installations: [item],
    logicalSkills: [],
    groups: [],
    plugins: [],
    ...overrides,
  });
}

function intent(item: Installation) {
  return {
    target: { kind: "installation" as const, installationId: item.id },
    force: false,
  };
}

function quarantine(): QuarantineModule {
  return {
    list: vi.fn(async () => []),
    listOperations: vi.fn(async () => []),
    quarantine: vi.fn(),
    previewRestore: vi.fn(),
    restore: vi.fn(),
    previewPurge: vi.fn(),
    purge: vi.fn(),
    previewRestoreOperation: vi.fn(),
    restoreOperation: vi.fn(),
    previewPurgeOperation: vi.fn(),
    purgeOperation: vi.fn(),
  };
}

function options(
  before: Inventory,
  final: Inventory,
  plan: UpdatePlan,
  processRunner = {
    run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  },
): ExecutionModuleOptions {
  let scans = 0;
  return {
    scan: vi.fn(async () => (scans++ === 0 ? before : final)),
    replan: vi.fn(),
    replanUpdate: vi.fn((value, updateIntent) =>
      planUpdate(value, updateIntent),
    ),
    quarantine: quarantine(),
    processRunner,
    inspectGitProtection: vi.fn(async () => ({
      kind: "outside-worktree" as const,
    })),
    auditWriter: { write: vi.fn() },
    updateAuditWriter: { write: vi.fn() },
    packageTrustStore: {
      isTrusted: vi.fn(async () => false),
      trust: vi.fn(async () => undefined),
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    stateRoot: "/fixtures/state",
  };
}

describe("targeted Update planning", () => {
  it("produces a deterministic complete plan from Inventory only", () => {
    const item = installation();
    const value = inventory(item);
    const first = planUpdate(value, intent(item));
    const second = planUpdate(value, intent(item));

    expect(stringifyModel(first)).toBe(stringifyModel(second));
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]).toMatchObject({
      kind: "managed-update",
      operation: { operationId: "update" },
      approvals: [{ kind: "confirmation" }],
    });
    expect(first.warnings.map((warning) => warning.kind)).toEqual([
      "network-access",
      "local-change-unavailable",
    ]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("blocks a complete Logical Skill when one member is unsupported", () => {
    const first = installation("one");
    const second = installation("two", 1, {
      identity: first.identity,
      update: { kind: "unsupported", reason: "no Owner operation" },
    });
    const logical = buildLogicalSkill({
      id: "logical",
      identity: first.identity,
      installationIds: [first.id, second.id],
    });
    const value = buildInventory({
      installations: [first, second],
      logicalSkills: [logical],
    });
    const planned = planUpdate(value, {
      target: { kind: "logical-skill", logicalSkillId: logical.id },
      force: true,
    });

    expect(planned.actions).toEqual([]);
    expect(planned.blocks).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-update",
        overridable: false,
      }),
    );
  });

  it("does not let force override Git protection or local changes", () => {
    const changed = operation(1, "protected");
    const item = installation("protected", 1, {
      update: {
        kind: "managed",
        operation: {
          ...changed,
          localChanges: {
            kind: "changed",
            path: "/fixtures/skills/example-skill",
            expectedDigest: { algorithm: "sha256", digest: "b".repeat(64) },
            actualDigest: { algorithm: "sha256", digest: "c".repeat(64) },
          },
          effects: changed.effects.map((effect) => ({
            ...effect,
            protection: {
              ...effect.protection,
              git: { kind: "protected", worktreeRoot: "/fixtures" },
            },
          })),
        },
      },
    });
    const planned = planUpdate(inventory(item), {
      ...intent(item),
      force: true,
    });
    expect(planned.actions).toEqual([]);
    expect(planned.blocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining(["git-protection", "local-changes"]),
    );
  });

  it("blocks protected selected content even when effects claim writable paths", () => {
    const item = installation("protected-target", 1, {
      protection: {
        git: { kind: "protected", worktreeRoot: "/fixtures" },
        system: { kind: "none" },
        filesystem: { kind: "writable" },
      },
    });
    const planned = planUpdate(inventory(item), intent(item));
    expect(planned.actions).toEqual([]);
    expect(planned.blocks).toContainEqual(
      expect.objectContaining({
        kind: "git-protection",
        path: item.location.path,
      }),
    );
  });

  it("blocks read-only selected content even when effects claim writable paths", () => {
    const item = installation("read-only-target", 1, {
      protection: {
        git: { kind: "outside-worktree" },
        system: { kind: "none" },
        filesystem: { kind: "read-only", reason: "fixture permission" },
      },
    });
    const planned = planUpdate(inventory(item), intent(item));
    expect(planned.actions).toEqual([]);
    expect(planned.blocks).toContainEqual(
      expect.objectContaining({
        kind: "filesystem-permission",
        path: item.location.path,
      }),
    );
  });

  it("blocks incomplete roots and roots that contain an unselected boundary", () => {
    const selected = installation("selected");
    const nested = installation("nested", 1, {
      location: {
        path: "/fixtures/skills/selected/nested",
        canonicalPath: "/fixtures/skills/selected/nested",
        artifactType: { kind: "directory" },
      },
    });
    const collision = planUpdate(
      buildInventory({
        installations: [selected, nested],
        logicalSkills: [],
      }),
      intent(selected),
    );
    expect(collision.blocks).toContainEqual(
      expect.objectContaining({ kind: "independent-boundary" }),
    );

    const uncovered = installation("uncovered", 1, {
      location: {
        path: "/fixtures/elsewhere/uncovered",
        canonicalPath: "/fixtures/elsewhere/uncovered",
        artifactType: { kind: "directory" },
      },
    });
    const incomplete = planUpdate(inventory(uncovered), intent(uncovered));
    expect(incomplete.blocks).toContainEqual(
      expect.objectContaining({ kind: "incomplete-authority" }),
    );
  });
});

describe("managed Update execution", () => {
  it("reports updated only after the final revision changes", async () => {
    const beforeItem = installation();
    const before = inventory(beforeItem);
    const planned = planUpdate(before, intent(beforeItem));
    const final = inventory(
      installation("installation-1", 2),
      "inventory-final",
    );
    const config = options(before, final, planned);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.targetResults[0].status).toBe("updated");
    expect(report.status).toBe("succeeded");
    expect(config.processRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: {
          executable: "fixture-manager",
          arguments: ["update", "fixture-lock-key"],
        },
      }),
    );
    expect(config.updateAuditWriter?.write).toHaveBeenCalledOnce();

    const missingChecks = structuredClone(report) as UpdateReport;
    (
      missingChecks as unknown as { verificationResults: unknown[] }
    ).verificationResults = [];
    expect(() => parseUpdateReport(missingChecks)).toThrow(
      /target result differs/,
    );

    const skippedAction = structuredClone(report) as UpdateReport;
    (
      skippedAction as unknown as {
        actionResults: unknown[];
      }
    ).actionResults = [
      {
        actionId: report.actionResults[0]!.actionId,
        status: "skipped",
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        reason: "approval missing",
      },
    ];
    expect(() => parseUpdateReport(skippedAction)).toThrow(
      /verification ran without a successful action/,
    );
  });

  it("reports unchanged without claiming up-to-date", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const config = options(before, before, planned);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.targetResults[0]).toMatchObject({
      status: "unchanged",
      reason: null,
    });
    expect(stringifyModel(report)).not.toContain("up-to-date");
  });

  it("rejects a forged command through fresh replan without mutation or audit", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const forged = structuredClone(planned) as UpdatePlan;
    (
      forged.actions[0]!.operation.invocation as unknown as {
        command: { executable: string; arguments: string[] };
      }
    ).command.executable = "forged-manager";
    const supplied = parseUpdatePlan(forged);
    const config = options(before, before, planned);
    const report = await createExecutionModule(config).executeUpdate(supplied, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("blocked");
    expect(config.processRunner.run).not.toHaveBeenCalled();
    expect(config.updateAuditWriter?.write).not.toHaveBeenCalled();
  });

  it("rejects forged effects through fresh replan without mutation or audit", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const forged = structuredClone(planned) as UpdatePlan;
    (
      forged.actions[0]!.operation.effects as unknown as {
        path: string;
      }[]
    )[0]!.path = "/fixtures/unreviewed-effect";
    const supplied = parseUpdatePlan(forged);
    const config = options(before, before, planned);
    const report = await createExecutionModule(config).executeUpdate(supplied, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("blocked");
    expect(config.processRunner.run).not.toHaveBeenCalled();
    expect(config.updateAuditWriter?.write).not.toHaveBeenCalled();
  });

  it("rejects an Adapter trust change during the fresh replan", async () => {
    const reviewedItem = installation();
    const reviewed = inventory(reviewedItem);
    const planned = planUpdate(reviewed, intent(reviewedItem));
    const freshOperation = operation(1, "installation-1");
    const freshItem = installation("installation-1", 1, {
      update: {
        kind: "managed",
        operation: {
          ...freshOperation,
          trust: {
            kind: "blocked",
            adapterId: freshOperation.adapterId,
            contentHash: "d".repeat(64),
          },
        },
      },
    });
    const fresh = inventory(freshItem, "inventory-fresh");
    const config = options(fresh, fresh, planned);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("blocked");
    expect(config.processRunner.run).not.toHaveBeenCalled();
    expect(config.updateAuditWriter?.write).not.toHaveBeenCalled();
  });

  it("fails closed when exact package trust cannot be persisted", async () => {
    const update = operation(1, "installation-1");
    const packageTrust = {
      runner: "npx" as const,
      packageName: "fixture-manager",
      packageVersion: "1.2.3",
      adapterHash: "e".repeat(64),
    };
    const item = installation("installation-1", 1, {
      update: {
        kind: "managed",
        operation: {
          ...update,
          invocation: {
            kind: "ephemeral-package",
            packageExecution: { ...packageTrust, mayDownload: true },
            packageArguments: ["update", "fixture-lock-key"],
            workingDirectory: { kind: "isolated-temporary" },
          },
          packageDownload: {
            kind: "possible",
            packageName: packageTrust.packageName,
            packageVersion: packageTrust.packageVersion,
          },
        },
      },
    });
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const trust = vi.fn(async () => {
      throw new Error("trust record changed during approval");
    });
    const config: ExecutionModuleOptions = {
      ...options(before, before, planned),
      packageTrustStore: {
        isTrusted: vi.fn(async () => false),
        trust,
      },
    };
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: planned.actions[0]!.approvals,
    });

    expect(report.targetResults[0].status).toBe("failed");
    expect(trust).toHaveBeenCalledWith(packageTrust);
    expect(config.processRunner.run).not.toHaveBeenCalled();
    expect(config.updateAuditWriter?.write).not.toHaveBeenCalled();
  });

  it("blocks an effect that becomes Git-protected before Owner invocation", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const config: ExecutionModuleOptions = {
      ...options(before, before, planned),
      inspectGitProtection: vi.fn(async () => ({
        kind: "protected" as const,
        worktreeRoot: "/fixtures",
      })),
    };
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.targetResults[0].status).toBe("blocked");
    expect(report.actionResults[0]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("became Git-protected"),
    });
    expect(config.processRunner.run).not.toHaveBeenCalled();
    expect(config.updateAuditWriter?.write).not.toHaveBeenCalled();
  });

  it("reports an interrupted Owner process as failed and never updated", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const runner = {
      run: vi.fn(async () => {
        throw new Error("Owner process interrupted");
      }),
    };
    const config = options(before, before, planned, runner);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("failed");
    expect(report.targetResults[0].status).toBe("failed");
    expect(report.targetResults[0].status).not.toBe("updated");
    expect(config.updateAuditWriter?.write).toHaveBeenCalledOnce();
  });

  it("returns a blocked report when fresh replanning cannot resolve the target", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const config: ExecutionModuleOptions = {
      ...options(before, before, planned),
      replanUpdate: vi.fn(() => {
        throw new Error("target disappeared");
      }),
    };
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.status).toBe("blocked");
    expect(config.processRunner.run).not.toHaveBeenCalled();
    expect(config.updateAuditWriter?.write).not.toHaveBeenCalled();
    expect(config.scan).toHaveBeenCalledTimes(1);
  });

  it("does not claim a verified Update after final scan failure", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const scan = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValueOnce(before)
      .mockRejectedValueOnce(new Error("scan failed"));
    const config: ExecutionModuleOptions = {
      ...options(before, before, planned),
      scan,
    };
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.targetResults[0].status).toBe("unresolved");
    expect(report.verificationResults).toEqual([]);
    expect(report.rescanError?.code).toBe("final-rescan-failed");
    expect(config.updateAuditWriter?.write).toHaveBeenCalledOnce();
  });

  it("fails verification when a prior Native Disable is not preserved", async () => {
    const disabled = installation("installation-1", 1, {
      harnessExposures: [
        {
          harnessId: "fixture-agent",
          status: "disabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
      ],
    });
    const before = inventory(disabled);
    const planned = planUpdate(before, intent(disabled));
    const final = inventory(
      installation("installation-1", 2),
      "inventory-final",
    );
    const config = options(before, final, planned);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.targetResults[0].status).toBe("unresolved");
    expect(report.verificationResults[0]?.status).toBe("failed");
  });

  it("fails verification when a non-Plugin target gains a Harness Exposure", async () => {
    const item = installation();
    const before = inventory(item);
    const planned = planUpdate(before, intent(item));
    const finalItem = installation("installation-1", 2, {
      exposedTo: ["fixture-agent", "new-harness"],
      harnessExposures: [
        {
          harnessId: "fixture-agent",
          status: "enabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
        {
          harnessId: "new-harness",
          status: "enabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
      ],
    });
    const config = options(
      before,
      inventory(finalItem, "inventory-final"),
      planned,
    );
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.targetResults[0].status).toBe("unresolved");
    expect(report.verificationResults[0]).toMatchObject({
      status: "failed",
      error: { message: "the Harness Exposure set changed" },
    });
  });

  it("does not exempt a cloned boundary that shares strong identity", async () => {
    const selected = installation();
    const logicalBefore = buildLogicalSkill({
      id: "logical",
      identity: selected.identity,
      installationIds: [selected.id],
    });
    const before = buildInventory({
      id: "inventory-before",
      installations: [selected],
      logicalSkills: [logicalBefore],
    });
    const planned = planUpdate(before, intent(selected));
    const updated = installation("installation-1", 2);
    const clone = installation("clone", 1, {
      skill: selected.skill,
      identity: selected.identity,
      location: {
        path: "/fixtures/skills/installation-1/clone",
        canonicalPath: "/fixtures/skills/installation-1/clone",
        artifactType: { kind: "directory" },
      },
    });
    const logicalFinal = buildLogicalSkill({
      id: "logical",
      identity: selected.identity,
      installationIds: [updated.id, clone.id],
    });
    const final = buildInventory({
      id: "inventory-final",
      installations: [updated, clone],
      logicalSkills: [logicalFinal],
    });
    const config = options(before, final, planned);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.targetResults[0].status).toBe("unresolved");
    expect(report.verificationResults[0]).toMatchObject({
      status: "failed",
      error: {
        message:
          "the Update created an independent Installation inside a declared effect",
      },
    });
  });

  it("fails when the selected Installation moves outside the approved root", async () => {
    const selected = installation();
    const before = inventory(selected);
    const planned = planUpdate(before, intent(selected));
    const moved = installation("installation-1", 1, {
      location: {
        path: "/fixtures/moved/installation-1",
        canonicalPath: "/fixtures/moved/installation-1",
        artifactType: { kind: "directory" },
      },
    });
    const config = options(
      before,
      inventory(moved, "inventory-final"),
      planned,
    );
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.targetResults[0].status).toBe("unresolved");
    expect(report.verificationResults[0]).toMatchObject({
      status: "failed",
      error: {
        message: "the selected Installation lifecycle boundary changed",
      },
    });
  });

  it("detects a new Plugin through its child Installation location", async () => {
    const selected = installation();
    const before = inventory(selected);
    const planned = planUpdate(before, intent(selected));
    const child = buildInstallation({
      id: "plugin-child",
      classification: "managed-plugin-resource",
      skill: { name: "plugin-child", description: null },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "plugin",
            pluginId: "new-plugin",
            skillId: "plugin-child",
          },
        ],
        weakEvidence: [],
      },
      plugin: { id: "new-plugin", version: "1.0.0" },
      pluginBoundaryId: "new-plugin",
      ownership: {
        kind: "plugin",
        pluginId: "new-plugin",
        independentlySelectable: false,
        confidence: "declared",
      },
      location: {
        path: "/fixtures/skills/installation-1/plugin-child",
        canonicalPath: "/fixtures/skills/installation-1/plugin-child",
        artifactType: { kind: "directory" },
      },
    });
    const plugin = {
      ...buildPluginBoundary({
        id: "new-plugin",
        pluginId: "new-plugin",
        ownership: child.ownership as Extract<
          typeof child.ownership,
          { kind: "plugin" }
        >,
        resources: [],
      }),
      installationIds: [child.id],
    };
    const final = buildInventory({
      id: "inventory-final",
      installations: [installation("installation-1", 2), child],
      logicalSkills: [],
      plugins: [plugin],
    });
    const config = options(before, final, planned);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });
    expect(report.verificationResults[0]).toMatchObject({
      status: "failed",
      error: {
        message:
          "the Update created an independent Plugin inside a declared effect",
      },
    });
  });

  it("continues an independent action and blocks a failed dependency branch", async () => {
    const sharedIdentity = installation("shared").identity;
    const withSelector = (id: string, version = 1): ManagedUpdateEvidence => {
      const value = operation(version, id);
      return {
        ...value,
        externalId: id,
        invocation: {
          kind: "direct",
          command: {
            executable: "fixture-manager",
            arguments: ["update", id],
          },
          workingDirectory: { kind: "exact", path: "/fixtures/workspace" },
        },
      };
    };
    const first = installation("first", 1, {
      identity: sharedIdentity,
      update: { kind: "managed", operation: withSelector("first") },
    });
    const second = installation("second", 1, {
      identity: sharedIdentity,
      update: { kind: "managed", operation: withSelector("second") },
    });
    const independent = installation("independent", 1, {
      identity: sharedIdentity,
      update: { kind: "managed", operation: withSelector("independent") },
    });
    const logical = buildLogicalSkill({
      id: "logical",
      identity: sharedIdentity,
      installationIds: [first.id, second.id, independent.id],
    });
    const before = buildInventory({
      id: "inventory-before",
      installations: [first, second, independent],
      logicalSkills: [logical],
      dependencies: [
        {
          kind: "hard",
          dependentInstallationId: first.id,
          target: { kind: "installation", installationId: second.id },
          source: { kind: "adapter", adapterId: "fixture-adapter" },
          reason: "first requires second",
        },
      ],
    });
    const planned = planUpdate(before, {
      target: { kind: "logical-skill", logicalSkillId: logical.id },
      force: false,
    });
    const runner = {
      run: vi.fn(
        async (request: { command: { arguments: readonly string[] } }) => ({
          exitCode: request.command.arguments.includes("second") ? 1 : 0,
          stdout: "",
          stderr: "",
        }),
      ),
    };
    const finalInstallations = [
      installation("first", 1, {
        identity: sharedIdentity,
        update: { kind: "managed", operation: withSelector("first") },
      }),
      installation("second", 1, {
        identity: sharedIdentity,
        update: { kind: "managed", operation: withSelector("second") },
      }),
      installation("independent", 2, {
        identity: sharedIdentity,
        update: {
          kind: "managed",
          operation: withSelector("independent", 2),
        },
      }),
    ];
    const final = buildInventory({
      id: "inventory-final",
      installations: finalInstallations,
      logicalSkills: [
        buildLogicalSkill({
          id: logical.id,
          identity: sharedIdentity,
          installationIds: finalInstallations.map((item) => item.id),
        }),
      ],
    });
    const config = options(before, final, planned, runner);
    const report = await createExecutionModule(config).executeUpdate(planned, {
      grants: [{ kind: "confirmation" }],
    });

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(
      runner.run.mock.calls.map(([request]) =>
        request.command.arguments.at(-1),
      ),
    ).toEqual(expect.arrayContaining(["second", "independent"]));
    expect(
      report.actionResults.find((result) => {
        const action = planned.actions.find(
          (item) => item.id === result.actionId,
        );
        return action?.operation.externalId === "first";
      })?.status,
    ).toBe("blocked");
    expect(report.status).toBe("partial");
    expect(report.targetResults[0]).toMatchObject({
      status: "partially-updated",
      reason: "only some Update actions were verified",
    });
  });
});
