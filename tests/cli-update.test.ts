import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import { formatCliOutput, runCli } from "../src/cli.js";
import type {
  Inventory,
  ManagedUpdateEvidence,
  UpdateIntent,
  UpdatePlan,
  UpdateReport,
  UpdateTarget,
} from "../src/index.js";
import { parseUpdateReport } from "../src/index.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
} from "../src/testing/index.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adapterHash = "a".repeat(64);

function selectorInventory(): Inventory {
  const installation = buildInstallation();
  return buildInventory({
    installations: [installation],
    logicalSkills: [
      buildLogicalSkill({
        identity: installation.identity,
        installationIds: [installation.id],
      }),
    ],
    groups: [
      {
        id: "group-1",
        label: "Fixture Group",
        tier: "declared",
        evidence: {
          tier: "declared",
          kind: "manager-source",
          managerId: "fixture-manager",
          sourceId: "fixture-source",
        },
        scope: { kind: "user" },
        installationIds: [installation.id],
      },
    ],
    plugins: [buildPluginBoundary()],
  });
}

function updatePlan(
  inventory: Inventory,
  target: UpdateTarget,
  overrides: Partial<UpdatePlan> = {},
): UpdatePlan {
  return {
    schemaVersion: 1,
    id: "update-plan-1",
    inventoryId: inventory.id,
    createdAt: inventory.scannedAt,
    intent: { target, force: false },
    targets: [target],
    actions: [],
    blocks: [],
    warnings: [],
    verificationChecks: [],
    ...overrides,
  };
}

function managedInventory(ephemeral = true): Inventory {
  const operation: ManagedUpdateEvidence = {
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
    invocation: ephemeral
      ? {
          kind: "ephemeral-package",
          packageExecution: {
            runner: "npx",
            packageName: "@fixture/manager",
            packageVersion: "1.2.3",
            adapterHash,
            mayDownload: true,
          },
          packageArguments: ["update", "fixture-lock-key", "--yes"],
          workingDirectory: { kind: "isolated-temporary" },
        }
      : {
          kind: "direct",
          command: {
            executable: "fixture-manager",
            arguments: ["update", "fixture-lock-key", "--yes"],
          },
          workingDirectory: {
            kind: "exact",
            path: "/fixtures/workspace",
          },
        },
    source: { id: "fixture-source", url: "https://example.test/source" },
    ref: "main",
    scope: { kind: "workspace", workspacePath: "/fixtures/workspace" },
    currentRevision: [
      {
        kind: "owner-value",
        path: "/fixtures/manager.json",
        format: "json",
        recordPointer: "/skills/fixture/revision",
        value: 1,
      },
    ],
    ownerRecordDigest: { algorithm: "sha256", digest: "b".repeat(64) },
    effects: [
      {
        kind: "mutation-root",
        path: "/fixtures/skills/installation-1",
        exists: true,
        protection: {
          git: { kind: "outside-worktree" },
          system: { kind: "none" },
          filesystem: { kind: "writable" },
        },
      },
      {
        kind: "configuration-path",
        path: "/fixtures/manager.json",
        exists: true,
        protection: {
          git: { kind: "outside-worktree" },
          system: { kind: "none" },
          filesystem: { kind: "writable" },
        },
      },
    ],
    network: { kind: "required", reason: "Owner fetches recorded source" },
    packageDownload: ephemeral
      ? {
          kind: "possible",
          packageName: "@fixture/manager",
          packageVersion: "1.2.3",
        }
      : { kind: "none" },
    localChanges: {
      kind: "unavailable",
      reason: "fixture cannot compare local content",
    },
    verifications: [
      {
        kind: "revision-manifest-value",
        path: "/fixtures/manager.json",
        format: "json",
        recordPointer: "/skills/fixture/revision",
        value: 1,
      },
    ],
  };
  return buildInventory({
    installations: [
      buildInstallation({
        source: operation.source,
        manager: { id: "fixture-manager" },
        adapterId: "fixture-adapter",
        scope: operation.scope,
        ownership: operation.owner,
        location: {
          path: "/fixtures/skills/installation-1",
          canonicalPath: "/fixtures/skills/installation-1",
          artifactType: { kind: "directory" },
        },
        update: { kind: "managed", operation },
      }),
    ],
  });
}

function report(
  plan: UpdatePlan,
  targetStatus: UpdateReport["targetResults"][0]["status"],
): UpdateReport {
  const status =
    targetStatus === "updated" || targetStatus === "unchanged"
      ? "succeeded"
      : targetStatus === "partially-updated"
        ? "partial"
        : targetStatus === "blocked"
          ? "blocked"
          : "failed";
  return {
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: plan.inventoryId,
    rescanError: null,
    startedAt: "2026-08-21T12:00:00.000Z",
    completedAt: "2026-08-21T12:01:00.000Z",
    status,
    actionResults: plan.actions.map((action) => ({
      actionId: action.id,
      status: "succeeded" as const,
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:01:00.000Z",
      details: {},
    })),
    targetResults: [
      {
        target: plan.intent.target,
        status: targetStatus,
        actionIds: plan.actions.map((action) => action.id),
        reason:
          targetStatus === "updated" || targetStatus === "unchanged"
            ? null
            : "fixture outcome",
      },
    ],
    verificationResults: plan.verificationChecks.map((check) => ({
      checkId: check.id,
      status: "passed" as const,
      changed: targetStatus === "updated",
      details: {},
    })),
  };
}

function mixedSuccessfulReport(plan: UpdatePlan): UpdateReport {
  const actionIds = Array.from(
    { length: 25 },
    (_, index) => `update-action-${String(index + 1)}`,
  );
  return parseUpdateReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: plan.inventoryId,
    rescanError: null,
    startedAt: "2026-08-21T12:00:00.000Z",
    completedAt: "2026-08-21T12:01:00.000Z",
    status: "succeeded",
    actionResults: actionIds.map((actionId) => ({
      actionId,
      status: "succeeded",
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:01:00.000Z",
      details: {},
    })),
    targetResults: [
      {
        target: plan.intent.target,
        status: "updated",
        actionIds,
        reason: null,
      },
    ],
    verificationResults: actionIds.map((_, index) => ({
      checkId: `update-check-${String(index + 1)}`,
      status: "passed",
      changed: index < 24,
      details: {},
    })),
  });
}

describe("Update CLI", () => {
  it("documents one-target Update and rejects bulk and removal-only options", async () => {
    const help = await runCli(["--help"]);
    expect(help.output).toContain(
      "lampwright update <selector> [--dry-run] [--yes] [--json]",
    );
    const scan = vi.fn(async () => buildInventory());

    for (const argv of [
      ["update"],
      ["update", "installation:one", "installation:two"],
      ["update", "installation:one", "--all"],
      ["update", "installation:one", "--force"],
      ["update", "installation:one", "--brute-force"],
      ["update", "installation:one", "--include-plugins"],
    ])
      await expect(runCli(argv, { scan })).resolves.toMatchObject({
        exitCode: 2,
        output: { kind: "error", code: "invalid-usage" },
      });
    expect(scan).not.toHaveBeenCalled();
  });

  it("resolves exactly one Installation, Logical Skill, Group, or Plugin selector through Planning", async () => {
    const inventory = selectorInventory();
    const planner = vi.fn(
      (value: Inventory, intent: UpdateIntent): UpdatePlan =>
        updatePlan(value, intent.target),
    );
    const cases = [
      [
        "installation:installation-1",
        { kind: "installation", installationId: "installation-1" },
      ],
      [
        "logical-skill:logical-skill-1",
        { kind: "logical-skill", logicalSkillId: "logical-skill-1" },
      ],
      ["group:group-1", { kind: "source-group", groupId: "group-1" }],
      [
        "plugin:fixture-plugin",
        { kind: "plugin", pluginBoundaryId: "fixture-plugin" },
      ],
    ] as const;
    for (const [selector, target] of cases) {
      const output = await runCli(["update", selector, "--dry-run"], {
        scan: async () => inventory,
        planUpdate: planner,
      });
      expect(output).toMatchObject({
        exitCode: 0,
        output: { kind: "update-plan", plan: { intent: { target } } },
      });
    }
    expect(planner).toHaveBeenCalledTimes(4);
    for (const call of planner.mock.calls)
      expect(call[1]).toMatchObject({ force: false });
  });

  it("rejects unsupported and missing Update selectors without executing", async () => {
    const inventory = selectorInventory();
    const executeUpdate = vi.fn();
    const dependencies = {
      scan: async () => inventory,
      planUpdate: (value: Inventory, intent: UpdateIntent) =>
        updatePlan(value, intent.target),
      executeUpdate,
    };
    for (const selector of [
      "source:fixture-source",
      "disabled-entry:disabled-1",
      "name:example-skill",
      "malformed",
    ])
      await expect(
        runCli(["update", selector, "--yes"], dependencies),
      ).resolves.toMatchObject({
        exitCode: 2,
        output: { kind: "error", code: "invalid-usage" },
      });
    await expect(
      runCli(["update", "installation:missing", "--yes"], dependencies),
    ).resolves.toMatchObject({
      exitCode: 3,
      output: { kind: "error", code: "target-not-found" },
    });
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("returns a deterministic zero-mutation plan and a complete human review", async () => {
    const inventory = managedInventory();
    const executeUpdate = vi.fn();
    const output = await runCli(
      ["update", "installation:installation-1", "--dry-run", "--yes"],
      { scan: async () => inventory, executeUpdate },
    );
    expect(output).toMatchObject({
      exitCode: 0,
      output: {
        schemaVersion: 1,
        kind: "update-plan",
        plan: { actions: [{ kind: "managed-update" }] },
      },
    });
    expect(executeUpdate).not.toHaveBeenCalled();

    const first = formatCliOutput(output.output, true);
    expect(formatCliOutput(output.output, true)).toBe(first);
    expect(first).toMatchSnapshot("managed Update plan JSON");
    const human = formatCliOutput(output.output, false);
    for (const expected of [
      "Update Plan: Installation installation-1",
      "Owner: Manager fixture-manager",
      "external selector fixture-lock-key",
      "Owner invocation: npx @fixture/manager@1.2.3 update fixture-lock-key --yes",
      "fixture-source (https://example.test/source)",
      "ref main",
      "workspace Scope /fixtures/workspace",
      "Current local evidence",
      "/fixtures/skills/installation-1",
      "Network: required",
      "Ephemeral package: @fixture/manager@1.2.3 may download or use a cache",
      "Adapter trust: trusted",
      "Package trust: --trust-package npx:@fixture/manager@1.2.3:",
      "Verification after execution",
      "Automatic rollback: unavailable",
    ])
      expect(human).toContain(expected);
    expect(human.toLowerCase()).not.toContain("up-to-date");
  });

  it("requires confirmation, forwards exact trust grants, and envelopes the report", async () => {
    const inventory = managedInventory();
    const executeUpdate = vi.fn(
      async (
        plan: UpdatePlan,
        approvals: readonly unknown[],
      ): Promise<UpdateReport> => {
        void approvals;
        return report(plan, "updated");
      },
    );
    const dependencies = { scan: async () => inventory, executeUpdate };
    const confirmation = await runCli(
      ["update", "installation:installation-1"],
      dependencies,
    );
    expect(confirmation).toMatchObject({
      exitCode: 3,
      output: {
        kind: "confirmation-required",
        operation: "update",
      },
    });
    expect(executeUpdate).not.toHaveBeenCalled();

    const missingTrust = await runCli(
      ["update", "installation:installation-1", "--yes"],
      dependencies,
    );
    expect(missingTrust).toMatchObject({
      exitCode: 3,
      output: {
        kind: "confirmation-required",
        operation: "update",
      },
    });
    expect(executeUpdate).not.toHaveBeenCalled();

    const executed = await runCli(
      [
        "update",
        "installation:installation-1",
        "--yes",
        "--trust-package",
        `npx:@fixture/manager@1.2.3:${adapterHash}`,
      ],
      dependencies,
    );
    expect(executed).toMatchObject({
      exitCode: 0,
      output: {
        schemaVersion: 1,
        kind: "update-report",
        report: { targetResults: [{ status: "updated" }] },
      },
    });
    expect(executeUpdate.mock.calls[0]![0]).toMatchObject({
      targets: [{ kind: "installation" }],
    });
    expect(executeUpdate.mock.calls[0]![1]).toEqual([
      { kind: "confirmation" },
      {
        kind: "package-trust",
        runner: "npx",
        packageName: "@fixture/manager",
        packageVersion: "1.2.3",
        adapterHash,
      },
    ]);
    expect(formatCliOutput(executed.output, true)).toMatchSnapshot(
      "updated Update report JSON",
    );
  });

  it.each([
    ["updated", 0],
    ["unchanged", 0],
    ["partially-updated", 1],
    ["blocked", 3],
    ["failed", 1],
    ["unresolved", 1],
  ] as const)(
    "maps the %s Update outcome to exit code %i",
    async (targetStatus, exitCode) => {
      const inventory = managedInventory(false);
      const output = await runCli(
        ["update", "installation:installation-1", "--yes"],
        {
          scan: async () => inventory,
          executeUpdate: async (plan) => report(plan, targetStatus),
        },
      );
      expect(output.exitCode).toBe(exitCode);
      expect(output.output).toMatchObject({
        kind: "update-report",
        report: { targetResults: [{ status: targetStatus }] },
      });
      const human = formatCliOutput(output.output, false);
      expect(human).toContain(
        `Target Installation installation-1: ${targetStatus}`,
      );
      expect(human.toLowerCase()).not.toContain("up-to-date");
    },
  );

  it("reports updated and unchanged Installation counts for a successful mixed Update", async () => {
    const inventory = managedInventory(false);
    const output = await runCli(
      ["update", "installation:installation-1", "--yes"],
      {
        scan: async () => inventory,
        executeUpdate: async (plan) => mixedSuccessfulReport(plan),
      },
    );

    expect(output).toMatchObject({
      exitCode: 0,
      output: {
        schemaVersion: 1,
        kind: "update-report",
        report: {
          schemaVersion: 1,
          targetResults: [{ status: "updated" }],
          actionResults: expect.arrayContaining([
            expect.objectContaining({ actionId: "update-action-25" }),
          ]),
          verificationResults: expect.arrayContaining([
            expect.objectContaining({
              checkId: "update-check-25",
              changed: false,
            }),
          ]),
        },
      },
    });
    const mixedReport = (output.output as { report: UpdateReport }).report;
    expect(mixedReport.actionResults).toHaveLength(25);
    expect(mixedReport.verificationResults).toHaveLength(25);
    expect(formatCliOutput(output.output, false)).toMatchInlineSnapshot(`
      "Update succeeded.
      Target Installation installation-1: updated.
      24 updated, 1 unchanged.
      Verification: 25/25 check(s) passed.
      "
    `);
  });

  it("keeps blocked plans zero-mutation and validates every Update envelope against CLI v1", async () => {
    const inventory = managedInventory(false);
    const executeUpdate = vi.fn();
    const blockedPlan = await runCli(
      ["update", "installation:installation-1", "--yes"],
      {
        scan: async () => inventory,
        planUpdate: (value, intent) =>
          updatePlan(value, intent.target, {
            blocks: [
              {
                kind: "adapter-trust",
                target: intent.target,
                installationId: value.installations[0]!.id,
                path: null,
                reason: "Adapter authority is not trusted",
                overridable: false,
              },
            ],
          }),
        executeUpdate,
      },
    );
    expect(blockedPlan).toMatchObject({
      exitCode: 3,
      output: { kind: "update-plan", plan: { actions: [], blocks: [{}] } },
    });
    expect(executeUpdate).not.toHaveBeenCalled();

    const confirmation = await runCli(
      ["update", "installation:installation-1"],
      { scan: async () => inventory },
    );
    const reportOutput = await runCli(
      ["update", "installation:installation-1", "--yes"],
      {
        scan: async () => inventory,
        executeUpdate: async (plan) => report(plan, "unchanged"),
      },
    );
    const schema = JSON.parse(
      await readFile(
        join(repositoryRoot, "schemas", "cli-v1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      schema,
    );
    for (const output of [
      blockedPlan.output,
      confirmation.output,
      reportOutput.output,
    ])
      expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
  });
});
