import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  createFileExecutionAuditWriter,
  createFilePackageTrustStore,
  stringifyModel,
  type DeclarativeDocumentFormat,
  type ExecutionModuleOptions,
  type ManagedRemovalAction,
  type QuarantineModule,
  type QuarantineResult,
  type RemovalPlan,
  type RemovalActionId,
  type RemovalTarget,
  type QuarantineAction,
  type VerificationCheckId,
} from "../src/index.js";
import { buildInventory, buildRemovalPlan } from "../src/testing/index.js";
import { verifyRecordAbsent } from "../src/execution/records.js";

function quarantineFixture(): QuarantineModule {
  return {
    list: vi.fn(async () => []),
    quarantine: vi.fn(async (request) => ({
      status: "already-absent" as const,
      path: request.location.path,
    })),
    restore: vi.fn(async (entry) => ({
      status: "blocked" as const,
      entryId: entry.id,
      reason: "entry-not-found" as const,
      path: entry.originalLocation.path,
    })),
    purge: vi.fn(async () => ({
      purgedAt: "2026-01-01T00:00:00.000Z",
      entries: [],
    })),
  };
}

function harness(
  overrides: Partial<ExecutionModuleOptions> = {},
): ExecutionModuleOptions {
  const inventory = buildInventory();
  const removalPlan = buildRemovalPlan();
  return {
    scan: vi.fn(async () => inventory),
    replan: vi.fn(() => removalPlan),
    quarantine: quarantineFixture(),
    processRunner: { run: vi.fn() },
    inspectGitProtection: vi.fn(async () => ({
      kind: "outside-worktree" as const,
    })),
    auditWriter: { write: vi.fn() },
    packageTrustStore: {
      isTrusted: vi.fn(async () => false),
      trust: vi.fn(async () => undefined),
    },
    now: () => new Date("2026-01-01T00:02:00.000Z"),
    stateRoot: "/fixtures/state",
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

const recordDocuments: readonly [DeclarativeDocumentFormat, string][] = [
  [
    "json",
    `${JSON.stringify({ skills: { "0": { version: 1 }, keep: true } }, null, 2)}\n`,
  ],
  [
    "jsonc",
    '{\n  // manager records\n  "skills": {\n    "0": { "version": 1 },\n    "keep": true,\n  },\n}\n',
  ],
  ["yaml", "skills:\n  '0':\n    version: 1\n  keep: true\n"],
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function managedAction(
  id: string,
  target: RemovalTarget,
  overrides: Partial<ManagedRemovalAction> = {},
): ManagedRemovalAction {
  return {
    id: id as ManagedRemovalAction["id"],
    kind: "managed-removal",
    target,
    affectedInstallationIds:
      target.kind === "installation" ? [target.installationId] : [],
    dependsOn: [],
    approvals: [{ kind: "confirmation" }],
    owner: {
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    },
    adapterId: "fixture-adapter",
    operationId: `remove-${id}`,
    invocation: {
      kind: "direct",
      command: { executable: "fixture-manager", arguments: ["remove", id] },
    },
    fallback: { kind: "available", requiresSeparateConfirmation: true },
    effects: [],
    verifications: [],
    ...overrides,
  };
}

function installationTarget(
  id: string,
): Extract<RemovalTarget, { kind: "installation" }> {
  return {
    kind: "installation",
    installationId: id as Extract<
      RemovalTarget,
      { kind: "installation" }
    >["installationId"],
  };
}

function planWithActions(
  targets: readonly RemovalTarget[],
  actions: readonly ManagedRemovalAction[],
  overrides: Parameters<typeof buildRemovalPlan>[0] = {},
): RemovalPlan {
  return buildRemovalPlan({
    targets,
    intent: { kind: "targets", targets, force: false, mode: "managed-first" },
    actions,
    ...overrides,
  });
}

describe("Execution", () => {
  it("fresh-scans and leaves persistent audit state untouched when no action runs", async () => {
    const options = harness();
    const report = await createExecutionModule(options).execute(
      buildRemovalPlan(),
      { grants: [] },
    );

    expect(options.scan).toHaveBeenCalledTimes(2);
    expect(options.replan).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      status: "succeeded",
      inventoryId: "inventory-1",
      finalInventoryId: "inventory-1",
      actionResults: [],
      targetResults: [{ status: "unchanged", actionIds: [] }],
      fallbackPlans: [],
    });
    expect(options.auditWriter.write).not.toHaveBeenCalled();
  });

  it("blocks a forged or stale plan before approvals or mutation are consulted", async () => {
    const supplied = buildRemovalPlan();
    const options = harness({
      replan: vi.fn(() => buildRemovalPlan({ id: "fresh-plan" })),
    });

    const report = await createExecutionModule(options).execute(supplied, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("blocked");
    expect(report.targetResults[0]).toMatchObject({ status: "blocked" });
    expect(options.processRunner.run).not.toHaveBeenCalled();
    expect(options.auditWriter.write).not.toHaveBeenCalled();
    expect(options.scan).toHaveBeenCalledOnce();
  });

  it("passes direct Owner commands as structured no-shell requests and audits mutation", async () => {
    const target = installationTarget("installation-1");
    const removalPlan = planWithActions(
      [target],
      [managedAction("action-1", target)],
    );
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const options = harness({
      replan: vi.fn(() => removalPlan),
      processRunner: { run },
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(run).toHaveBeenCalledWith({
      command: {
        executable: "fixture-manager",
        arguments: ["remove", "action-1"],
      },
    });
    expect(report).toMatchObject({
      status: "succeeded",
      actionResults: [{ status: "succeeded" }],
      targetResults: [{ status: "removed" }],
    });
    expect(options.auditWriter.write).toHaveBeenCalledOnce();
  });

  it("returns and audits unresolved outcomes when the post-mutation rescan fails", async () => {
    const target = installationTarget("installation-1");
    const action = managedAction("action-rescan", target);
    const removalPlan = planWithActions([target], [action]);
    const inventory = buildInventory();
    const scan = vi
      .fn<() => Promise<ReturnType<typeof buildInventory>>>()
      .mockResolvedValueOnce(inventory)
      .mockRejectedValueOnce(new Error("scanner unavailable"));
    const options = harness({
      scan,
      replan: vi.fn(() => removalPlan),
      processRunner: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report).toMatchObject({
      status: "partial",
      finalInventoryId: null,
      rescanError: { code: "final-rescan-failed" },
      targetResults: [{ status: "partially-removed" }],
    });
    expect(options.auditWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ report }),
    );
  });

  it("does not run an action-owned verification command when that action was not approved", async () => {
    const target = installationTarget("installation-1");
    const verification = {
      kind: "command-succeeds" as const,
      command: { executable: "fixture-manager", arguments: ["verify"] },
      successExitCodes: [0],
    };
    const action = managedAction("action-unapproved", target, {
      verifications: [verification],
    });
    const removalPlan = planWithActions([target], [action], {
      verificationChecks: [
        {
          id: "command-check" as VerificationCheckId,
          actionId: action.id,
          ...verification,
        },
      ],
    });
    const options = harness({ replan: vi.fn(() => removalPlan) });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [],
    });

    expect(options.processRunner.run).not.toHaveBeenCalled();
    expect(report.status).toBe("blocked");
    expect(report.verificationResults).toEqual([
      {
        checkId: "command-check",
        status: "skipped",
        reason: "owning action did not complete successfully",
      },
    ]);
  });

  it("uses exact trusted npx packages from isolated cleaner state", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-cleaner-execution-"));
    temporaryDirectories.push(root);
    const target = installationTarget("installation-1");
    const action = managedAction("action-ephemeral", target, {
      approvals: [
        { kind: "confirmation" },
        {
          kind: "package-trust",
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          adapterHash: "a".repeat(64),
        },
      ],
      invocation: {
        kind: "ephemeral-package",
        packageExecution: {
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          adapterHash: "a".repeat(64),
          mayDownload: true,
        },
        packageArguments: ["remove", "skill"],
      },
    });
    const removalPlan = planWithActions([target], [action]);
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const trust = vi.fn(async () => true);
    const options = harness({
      replan: vi.fn(() => removalPlan),
      processRunner: { run },
      packageTrustStore: {
        isTrusted: trust,
        trust: vi.fn(async () => undefined),
      },
      stateRoot: root,
    });

    await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(trust).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "fixture-manager",
        packageVersion: "1.2.3",
      }),
    );
    expect(run).toHaveBeenCalledWith({
      command: {
        executable: "npx",
        arguments: ["--yes", "fixture-manager@1.2.3", "remove", "skill"],
      },
      cwd: expect.stringContaining("skill-cleaner-execution-"),
      environment: expect.objectContaining({
        npm_config_cache: join(root, "execution", "v1", "npm-cache"),
        npm_config_global: "false",
      }),
    });
  });

  it("does not let force stand in for exact package trust", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-cleaner-untrusted-"));
    temporaryDirectories.push(root);
    const target = installationTarget("installation-1");
    const packageTrust = {
      kind: "package-trust" as const,
      runner: "npx" as const,
      packageName: "fixture-manager",
      packageVersion: "1.2.3",
      adapterHash: "b".repeat(64),
    };
    const action = managedAction("action-untrusted", target, {
      approvals: [
        { kind: "confirmation" },
        packageTrust,
        { kind: "force-override", safeguards: ["dependency"] },
      ],
      invocation: {
        kind: "ephemeral-package",
        packageExecution: {
          runner: packageTrust.runner,
          packageName: packageTrust.packageName,
          packageVersion: packageTrust.packageVersion,
          adapterHash: packageTrust.adapterHash,
          mayDownload: true,
        },
        packageArguments: ["remove", "skill"],
      },
    });
    const removalPlan = planWithActions([target], [action]);
    const options = harness({
      replan: vi.fn(() => removalPlan),
      stateRoot: root,
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [
        { kind: "confirmation" },
        { kind: "force-override", safeguards: ["dependency"] },
      ],
    });

    expect(report.status).toBe("blocked");
    expect(report.actionResults[0]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("package-trust"),
    });
    expect(options.packageTrustStore.trust).not.toHaveBeenCalled();
    expect(options.processRunner.run).not.toHaveBeenCalled();
  });

  it("blocks a newly Git-protected effect immediately before Owner invocation", async () => {
    const target = installationTarget("installation-1");
    const action = managedAction("action-protected", target, {
      effects: [
        {
          kind: "remove-path",
          path: "/fixtures/protected",
          protection: {
            git: { kind: "ignored", worktreeRoot: "/fixtures" },
            system: { kind: "none" },
            filesystem: { kind: "writable" },
          },
        },
      ],
    });
    const removalPlan = planWithActions([target], [action]);
    const options = harness({
      replan: vi.fn(() => removalPlan),
      inspectGitProtection: vi.fn(async () => ({
        kind: "protected" as const,
        worktreeRoot: "/fixtures",
      })),
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("blocked");
    expect(report.actionResults[0]).toMatchObject({ status: "skipped" });
    expect(options.processRunner.run).not.toHaveBeenCalled();
  });

  it("executes an explicitly approved overridable safeguard without reporting it blocked", async () => {
    const target = installationTarget("installation-1");
    const action = managedAction("action-forced", target, {
      approvals: [
        { kind: "confirmation" },
        { kind: "force-override", safeguards: ["ambiguity"] },
      ],
    });
    const removalPlan = planWithActions([target], [action], {
      blocks: [
        {
          kind: "ambiguous-ownership",
          target,
          reason: "fixture ambiguity",
          overridable: true,
        },
      ],
    });
    const options = harness({
      replan: vi.fn(() => removalPlan),
      processRunner: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [
        { kind: "confirmation" },
        { kind: "force-override", safeguards: ["ambiguity"] },
      ],
    });

    expect(report.status).toBe("succeeded");
    expect(report.targetResults[0]).toMatchObject({ status: "removed" });
  });

  it("reports a target partially removed when one sibling succeeds and another becomes protected", async () => {
    const target = installationTarget("installation-1");
    const succeeded = managedAction("action-sibling-success", target);
    const protectedAction = managedAction("action-sibling-protected", target, {
      effects: [
        {
          kind: "remove-path",
          path: "/fixtures/newly-protected",
          protection: {
            git: { kind: "ignored", worktreeRoot: "/fixtures" },
            system: { kind: "none" },
            filesystem: { kind: "writable" },
          },
        },
      ],
    });
    const removalPlan = planWithActions([target], [succeeded, protectedAction]);
    const options = harness({
      replan: vi.fn(() => removalPlan),
      inspectGitProtection: vi.fn(async (path) =>
        path === "/fixtures/newly-protected"
          ? { kind: "protected" as const, worktreeRoot: "/fixtures" }
          : { kind: "outside-worktree" as const },
      ),
      processRunner: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("partial");
    expect(report.actionResults.map((result) => result.status)).toEqual([
      "succeeded",
      "skipped",
    ]);
    expect(report.targetResults[0]).toMatchObject({
      status: "partially-removed",
    });
  });

  it("stops dependents after failure while concurrent independent actions continue", async () => {
    const targets = ["a", "b", "c"].map((id) =>
      installationTarget(`installation-${id}`),
    );
    const actions = [
      managedAction("action-a", targets[0]!),
      managedAction("action-b", targets[1]!, {
        dependsOn: ["action-a" as ManagedRemovalAction["id"]],
      }),
      managedAction("action-c", targets[2]!),
    ];
    const removalPlan = planWithActions(targets, actions);
    const fallback = buildRemovalPlan({
      id: "fallback-plan",
      inventoryId: "inventory-1",
      targets: [targets[0]!],
      intent: {
        kind: "targets",
        targets: [targets[0]!],
        force: false,
        mode: "brute-force",
      },
      actions: [
        {
          id: "fallback-action",
          kind: "quarantine",
          target: targets[0]!,
          affectedInstallationIds: [targets[0]!.installationId],
          dependsOn: [],
          approvals: [
            { kind: "confirmation" },
            { kind: "brute-force-confirmation" },
          ],
          location: {
            path: "/fixtures/skills/a",
            canonicalPath: "/fixtures/skills/a",
            artifactType: { kind: "directory" },
          },
        },
      ],
    });
    let active = 0;
    let maximumActive = 0;
    const run = vi.fn(
      async (request: { command: { arguments: readonly string[] } }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          exitCode: request.command.arguments.at(-1) === "action-a" ? 1 : 0,
          stdout: "",
          stderr: "",
        };
      },
    );
    const replan = vi.fn((_inventory, intent) =>
      intent.mode === "brute-force" ? fallback : removalPlan,
    );
    const options = harness({
      replan,
      processRunner: { run },
      maxConcurrency: 2,
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(maximumActive).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report.actionResults.map((result) => result.status)).toEqual([
      "failed",
      "blocked",
      "succeeded",
    ]);
    expect(report.targetResults.map((result) => result.status)).toEqual([
      "failed",
      "blocked",
      "removed",
    ]);
    expect(report.status).toBe("partial");
    expect(report.fallbackPlans).toHaveLength(1);
    expect(report.fallbackPlans[0]?.intent.mode).toBe("brute-force");
    expect(options.quarantine.quarantine).not.toHaveBeenCalled();
  });

  it("passes the exact approved artifact and Inventory provenance to Quarantine", async () => {
    const target = installationTarget("installation-1");
    const action: QuarantineAction = {
      id: "quarantine-action" as QuarantineAction["id"],
      kind: "quarantine",
      target,
      affectedInstallationIds: [target.installationId],
      dependsOn: [],
      approvals: [{ kind: "brute-force-confirmation" }],
      location: {
        path: "/fixtures/skills/example-skill",
        canonicalPath: "/fixtures/skills/example-skill",
        artifactType: { kind: "directory" },
      },
    };
    const removalPlan = buildRemovalPlan({
      targets: [target],
      intent: {
        kind: "targets",
        targets: [target],
        force: false,
        mode: "brute-force",
      },
      actions: [action],
    });
    const quarantine = quarantineFixture();
    vi.mocked(quarantine.quarantine).mockResolvedValue({
      status: "quarantined",
      entry: { id: "quarantine-entry" },
    } as unknown as QuarantineResult);
    const options = harness({
      replan: vi.fn(() => removalPlan),
      quarantine,
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "brute-force-confirmation" }],
    });

    expect(quarantine.quarantine).toHaveBeenCalledWith({
      kind: "displaced-artifact",
      location: action.location,
      provenance: {
        actionId: action.id,
        targets: [target],
        affectedInstallationIds: [target.installationId],
        subjects: [
          expect.objectContaining({
            installationIds: [target.installationId],
            ownership: { kind: "filesystem", confidence: "declared" },
          }),
        ],
      },
    });
    expect(report.actionResults[0]).toMatchObject({ status: "succeeded" });
  });

  it("marks a successful mutation unresolved when the final Inventory still exposes its target", async () => {
    const target = installationTarget("installation-1");
    const action = managedAction("action-unverified", target);
    const removalPlan = planWithActions([target], [action], {
      verificationChecks: [
        {
          id: "target-check" as VerificationCheckId,
          kind: "target-unavailable",
          target,
        },
      ],
    });
    const fallback = buildRemovalPlan({
      id: "verification-fallback",
      targets: [target],
      intent: {
        kind: "targets",
        targets: [target],
        force: false,
        mode: "brute-force",
      },
      actions: [
        {
          id: "verification-fallback-action",
          kind: "quarantine",
          target,
          affectedInstallationIds: [target.installationId],
          dependsOn: [],
          approvals: [
            { kind: "confirmation" },
            { kind: "brute-force-confirmation" },
          ],
          location: {
            path: "/fixtures/skills/example-skill",
            canonicalPath: "/fixtures/skills/example-skill",
            artifactType: { kind: "directory" },
          },
        },
      ],
    });
    const options = harness({
      replan: vi.fn((_inventory, intent) =>
        intent.mode === "brute-force" ? fallback : removalPlan,
      ),
      processRunner: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    });

    const report = await createExecutionModule(options).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });

    expect(report.status).toBe("partial");
    expect(report.verificationResults[0]).toMatchObject({ status: "failed" });
    expect(report.targetResults[0]).toMatchObject({
      status: "partially-removed",
      reason: "final verification failed",
    });
    expect(report.fallbackPlans).toHaveLength(1);
  });

  it.each(recordDocuments)(
    "captures a %s record preimage before exact declarative cleanup",
    async (format, content) => {
      const root = await mkdtemp(join(tmpdir(), "skill-cleaner-record-"));
      temporaryDirectories.push(root);
      const recordPath = join(root, "manager.json");
      await writeFile(recordPath, content);
      const target = installationTarget("installation-1");
      const fileDigest = createHash("sha256").update(content).digest("hex");
      const recordDigest = createHash("sha256")
        .update(stringifyModel({ version: 1 }, 0))
        .digest("hex");
      const action = {
        id: "record-action" as const,
        kind: "record-cleanup" as const,
        affectedTargets: [target],
        affectedInstallationIds: [target.installationId],
        dependsOn: [],
        approvals: [{ kind: "brute-force-confirmation" as const }],
        location: {
          path: recordPath,
          canonicalPath: recordPath,
          artifactType: { kind: "file" as const },
        },
        adapterId: "fixture-adapter",
        format,
        expectedFileHash: { algorithm: "sha256" as const, digest: fileDigest },
        protection: {
          git: { kind: "outside-worktree" as const },
          system: { kind: "none" as const },
          filesystem: { kind: "writable" as const },
        },
        records: [
          {
            recordPointer: "/skills/0",
            expectedRecordHash: {
              algorithm: "sha256" as const,
              digest: recordDigest,
            },
          },
        ],
      };
      const removalPlan = buildRemovalPlan({
        targets: [target],
        intent: {
          kind: "targets",
          targets: [target],
          force: false,
          mode: "brute-force",
        },
        actions: [action],
        verificationChecks: [
          {
            id: "record-check" as VerificationCheckId,
            kind: "record-absent",
            actionId: action.id as RemovalActionId,
            path: recordPath,
            format,
            recordPointer: "/skills/0",
            expectedRecordHash: {
              algorithm: "sha256",
              digest: recordDigest,
            },
          },
        ],
      });
      const captured: unknown[] = [];
      const quarantine = quarantineFixture();
      vi.mocked(quarantine.quarantine).mockImplementation(async (request) => {
        captured.push(request);
        return {
          status: "quarantined",
          entry: { id: "record-entry" },
        } as unknown as QuarantineResult;
      });
      const options = harness({
        replan: vi.fn(() => removalPlan),
        quarantine,
        stateRoot: root,
      });

      const report = await createExecutionModule(options).execute(removalPlan, {
        grants: [{ kind: "brute-force-confirmation" }],
      });

      expect(captured).toEqual([
        expect.objectContaining({
          kind: "record-cleanup-preimage",
          expectedPreimageHash: { algorithm: "sha256", digest: fileDigest },
        }),
      ]);
      const postimage = await readFile(recordPath, "utf8");
      expect(postimage).not.toContain("version");
      expect(postimage).toContain("keep");
      expect(report).toMatchObject({
        status: "succeeded",
        actionResults: [{ status: "succeeded" }],
        verificationResults: [{ status: "passed" }],
      });
    },
  );

  it.each([
    ["json", '{"items":["first","second","keep"]}\n'],
    [
      "jsonc",
      '{\n  // ordered entries\n  "items": ["first", "second", "keep"],\n}\n',
    ],
    ["yaml", "items:\n  - first\n  - second\n  - keep\n"],
  ] as const)(
    "removes approved %s array records without index-shift collateral",
    async (format, content) => {
      const root = await mkdtemp(join(tmpdir(), "skill-cleaner-array-"));
      temporaryDirectories.push(root);
      const recordPath = join(root, `manager.${format}`);
      await writeFile(recordPath, content);
      const target = installationTarget("installation-1");
      const fileDigest = createHash("sha256").update(content).digest("hex");
      const actionId = "array-record-action" as RemovalActionId;
      const records = [
        { pointer: "/items/0", value: "first" },
        { pointer: "/items/1", value: "second" },
      ].map(({ pointer, value }) => ({
        recordPointer: pointer,
        expectedRecordHash: {
          algorithm: "sha256" as const,
          digest: createHash("sha256")
            .update(stringifyModel(value, 0))
            .digest("hex"),
        },
      }));
      const action = {
        id: actionId,
        kind: "record-cleanup" as const,
        affectedTargets: [target],
        affectedInstallationIds: [target.installationId],
        dependsOn: [],
        approvals: [{ kind: "brute-force-confirmation" as const }],
        location: {
          path: recordPath,
          canonicalPath: recordPath,
          artifactType: { kind: "file" as const },
        },
        adapterId: "fixture-adapter",
        format,
        expectedFileHash: { algorithm: "sha256" as const, digest: fileDigest },
        protection: {
          git: { kind: "outside-worktree" as const },
          system: { kind: "none" as const },
          filesystem: { kind: "writable" as const },
        },
        records,
      };
      const removalPlan = buildRemovalPlan({
        targets: [target],
        intent: {
          kind: "targets",
          targets: [target],
          force: false,
          mode: "brute-force",
        },
        actions: [action],
        verificationChecks: records.map((record, index) => ({
          id: `array-check-${index}` as VerificationCheckId,
          kind: "record-absent" as const,
          actionId,
          path: recordPath,
          format,
          recordPointer: record.recordPointer,
          expectedRecordHash: record.expectedRecordHash,
        })),
      });
      const quarantine = quarantineFixture();
      vi.mocked(quarantine.quarantine).mockResolvedValue({
        status: "quarantined",
        entry: { id: "array-entry" },
      } as unknown as QuarantineResult);
      const options = harness({
        replan: vi.fn(() => removalPlan),
        quarantine,
        stateRoot: root,
      });

      const report = await createExecutionModule(options).execute(removalPlan, {
        grants: [{ kind: "brute-force-confirmation" }],
      });

      const postimage = await readFile(recordPath, "utf8");
      expect(postimage).not.toContain("first");
      expect(postimage).not.toContain("second");
      expect(postimage).toContain("keep");
      expect(
        report.verificationResults.every((item) => item.status === "passed"),
      ).toBe(true);
    },
  );

  it("does not treat a changed object record as absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-cleaner-record-check-"));
    temporaryDirectories.push(root);
    const recordPath = join(root, "manager.json");
    await writeFile(recordPath, '{"skills":{"0":{"version":2}}}\n');

    await expect(
      verifyRecordAbsent({
        id: "changed-object-check" as VerificationCheckId,
        kind: "record-absent",
        actionId: "record-action" as RemovalActionId,
        path: recordPath,
        format: "json",
        recordPointer: "/skills/0",
        expectedRecordHash: {
          algorithm: "sha256",
          digest: createHash("sha256")
            .update(stringifyModel({ version: 1 }, 0))
            .digest("hex"),
        },
      }),
    ).resolves.toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a record document link without following its target",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "skill-cleaner-link-record-"));
      temporaryDirectories.push(root);
      const targetPath = join(root, "target.json");
      const recordPath = join(root, "manager.json");
      const content = '{"skills":{"remove":true}}\n';
      await writeFile(targetPath, content);
      await symlink(targetPath, recordPath);
      const target = installationTarget("installation-1");
      const actionId = "linked-record-action" as RemovalActionId;
      const removalPlan = buildRemovalPlan({
        targets: [target],
        intent: {
          kind: "targets",
          targets: [target],
          force: false,
          mode: "brute-force",
        },
        actions: [
          {
            id: actionId,
            kind: "record-cleanup",
            affectedTargets: [target],
            affectedInstallationIds: [target.installationId],
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: {
              path: recordPath,
              canonicalPath: targetPath,
              artifactType: { kind: "file" },
            },
            adapterId: "fixture-adapter",
            format: "json",
            expectedFileHash: {
              algorithm: "sha256",
              digest: createHash("sha256").update(content).digest("hex"),
            },
            protection: {
              git: { kind: "outside-worktree" },
              system: { kind: "none" },
              filesystem: { kind: "writable" },
            },
            records: [
              {
                recordPointer: "/skills/remove",
                expectedRecordHash: {
                  algorithm: "sha256",
                  digest: createHash("sha256").update("true").digest("hex"),
                },
              },
            ],
          },
        ],
      });
      const options = harness({
        replan: vi.fn(() => removalPlan),
        stateRoot: root,
      });

      const report = await createExecutionModule(options).execute(removalPlan, {
        grants: [{ kind: "brute-force-confirmation" }],
      });

      expect(report.actionResults[0]).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("regular file") },
      });
      expect(await readFile(targetPath, "utf8")).toBe(content);
      expect(options.quarantine.quarantine).not.toHaveBeenCalled();
    },
  );

  it("creates audit and trust state only when their mutating operations run", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-cleaner-state-"));
    temporaryDirectories.push(root);
    const stateRoot = join(root, "state");
    const options = harness({
      replan: vi.fn(() => buildRemovalPlan()),
      stateRoot,
      auditWriter: createFileExecutionAuditWriter(stateRoot),
      packageTrustStore: createFilePackageTrustStore(stateRoot),
    });

    await createExecutionModule(options).execute(buildRemovalPlan(), {
      grants: [],
    });

    await expect(
      readFile(join(stateRoot, "audit", "v1")),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/ENOENT|EISDIR/),
    });

    const requirement = {
      runner: "npx" as const,
      packageName: "fixture-manager",
      packageVersion: "1.2.3",
      adapterHash: "c".repeat(64),
    };
    expect(await options.packageTrustStore.isTrusted(requirement)).toBe(false);
    await expect(readdir(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await options.packageTrustStore.trust(requirement);
    expect(await options.packageTrustStore.isTrusted(requirement)).toBe(true);

    const target = installationTarget("installation-1");
    const action = managedAction("audited-action", target);
    const removalPlan = planWithActions([target], [action]);
    const mutatingOptions = harness({
      replan: vi.fn(() => removalPlan),
      stateRoot,
      auditWriter: createFileExecutionAuditWriter(stateRoot),
      packageTrustStore: options.packageTrustStore,
      processRunner: {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    });
    await createExecutionModule(mutatingOptions).execute(removalPlan, {
      grants: [{ kind: "confirmation" }],
    });
    const auditDirectory = join(stateRoot, "audit", "v1");
    const auditFiles = await readdir(auditDirectory);
    expect(auditFiles).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(auditDirectory, auditFiles[0]!), "utf8")),
    ).toMatchObject({
      plan: { id: removalPlan.id },
      approvals: { grants: [{ kind: "confirmation" }] },
      report: { actionResults: [{ status: "succeeded" }] },
    });
  });
});
