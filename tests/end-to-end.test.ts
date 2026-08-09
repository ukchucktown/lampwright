import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createExecutionModule,
  createQuarantineModule,
  nodeQuarantineFileSystem,
  plan,
  stringifyModel,
  type ApprovalRequirement,
  type ExecutionProcessRequest,
  type ExecutionProcessRunner,
  type Installation,
  type Inventory,
  type InventoryScanner,
  type QuarantineModule,
  type RemovalPlan,
  type RemovalTarget,
} from "../src/index.js";
import { createMvpEndToEndFixture } from "./support/mvp-end-to-end-fixture.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const fixedTime = new Date("2026-08-07T12:00:00.000Z");

describe("cross-platform MVP end to end", () => {
  it("discovers overlapping ownership boundaries and keeps scan and dry-run completely read-only", async () => {
    const fixture = await createMvpEndToEndFixture(
      await createTestEnvironment(),
    );
    const before = await fixture.snapshot();

    const inventory = await fixture.createScanner(true).scan({});
    const reviewInstallations = inventory.installations.filter(
      (installation) => installation.skill.name === "review",
    );

    expect(reviewInstallations).toHaveLength(3);
    expect(
      reviewInstallations.map((installation) => installation.ownership.kind),
    ).toEqual(expect.arrayContaining(["filesystem", "manager", "plugin"]));
    expect(
      inventory.logicalSkills
        .filter((logical) => logical.skill.name === "review")
        .every((logical) => logical.installationIds.length === 1),
    ).toBe(true);
    expect(inventory.plugins).toEqual([
      expect.objectContaining({
        pluginId: "quality-suite",
        installationIds: [expect.any(String)],
        resources: [
          expect.objectContaining({
            id: "declared-root",
            location: expect.objectContaining({
              path: fixture.paths.pluginRoot,
            }),
          }),
        ],
      }),
    ]);
    expect(
      installationNamed(inventory, "project-review").protection.git.kind,
    ).toBe("protected");
    expect(installationNamed(inventory, "broken-review")).toMatchObject({
      status: "broken",
      location: {
        artifactType: {
          kind: process.platform === "win32" ? "junction" : "symbolic-link",
          broken: true,
        },
      },
    });
    expect(inventory.otherFindings).toContainEqual(
      expect.objectContaining({
        classification: "system-skill",
        skill: expect.objectContaining({ name: "runtime-review" }),
      }),
    );

    const managed = reviewInstallations.find(
      (installation) => installation.ownership.kind === "manager",
    )!;
    const dryRun = plan(inventory, {
      kind: "targets",
      targets: [targetFor(managed)],
      force: false,
      mode: "managed-first",
    });
    expect(dryRun).toMatchObject({
      blocks: [],
      actions: [
        {
          kind: "managed-removal",
          invocation: {
            kind: "direct",
            command: {
              executable: "skills",
              arguments: expect.arrayContaining(["remove", "review", "--yes"]),
            },
          },
        },
      ],
    });
    expect(dryRun.targets).not.toContainEqual(
      targetFor(installationNamed(inventory, "keep-me")),
    );

    const projectPlan = plan(inventory, {
      kind: "targets",
      targets: [targetFor(installationNamed(inventory, "project-review"))],
      force: true,
      mode: "brute-force",
    });
    expect(projectPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "git-protection", overridable: false }),
    );
    const pluginChild = reviewInstallations.find(
      (installation) => installation.ownership.kind === "plugin",
    )!;
    expect(
      plan(inventory, {
        kind: "targets",
        targets: [targetFor(pluginChild)],
        force: false,
        mode: "managed-first",
      }).blocks,
    ).toContainEqual(expect.objectContaining({ kind: "plugin-boundary" }));

    const missingManagerInventory = await fixture.createScanner(false).scan({});
    const unavailable = missingManagerInventory.installations.find(
      (installation) => installation.ownership.kind === "manager",
    )!;
    expect(unavailable.removal).toMatchObject({
      managed: {
        availability: { kind: "available" },
        invocation: {
          kind: "ephemeral-package",
          packageExecution: {
            runner: "npx",
            packageName: "skills",
            packageVersion: "1.5.22",
            mayDownload: true,
          },
        },
      },
      fallback: { kind: "available" },
    });
    const missingManagerPlan = plan(missingManagerInventory, {
      kind: "targets",
      targets: [targetFor(unavailable)],
      force: false,
      mode: "managed-first",
    });
    expect(missingManagerPlan.blocks).toEqual([]);
    expect(missingManagerPlan.warnings).toContainEqual(
      expect.objectContaining({ kind: "ephemeral-download" }),
    );

    expect(await fixture.snapshot()).toEqual(before);
    await expect(
      readFile(join(fixture.paths.unrelatedSkill, "SKILL.md"), "utf8"),
    ).resolves.toContain("keep-me");
    await expect(
      readFile(fixture.paths.pluginCollateral, "utf8"),
    ).resolves.toBe("# plugin collateral\n");
    await expect(
      readFile(join(fixture.paths.projectSkill, "SKILL.md"), "utf8"),
    ).resolves.toContain("project-review");
    await expect(lstat(fixture.paths.lampwrightState)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses the Owner lifecycle operation and preserves independent Installations", async () => {
    const fixture = await createMvpEndToEndFixture(
      await createTestEnvironment(),
    );
    const scanner = fixture.createScanner(true);
    const initial = await scanner.scan({});
    const selected = initial.installations.find(
      (installation) => installation.ownership.kind === "manager",
    )!;
    const removalPlan = plan(initial, {
      kind: "targets",
      targets: [targetFor(selected)],
      force: false,
      mode: "managed-first",
    });
    const run = vi.fn(async (request: ExecutionProcessRequest) => {
      expect(request).toMatchObject({
        command: {
          executable: "skills",
          arguments: expect.arrayContaining(["remove", "review", "--yes"]),
        },
        environment: { DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      });
      await rm(fixture.paths.managedReview, { recursive: true });
      const lock = JSON.parse(
        await readFile(fixture.paths.managerLock, "utf8"),
      ) as { skills: Record<string, unknown> };
      delete lock.skills.review;
      await writeFile(
        fixture.paths.managerLock,
        `${JSON.stringify(lock, null, 2)}\n`,
        "utf8",
      );
      return { exitCode: 0, stdout: "removed", stderr: "" };
    });
    const quarantine = quarantineFor(fixture.paths.lampwrightState);
    const execution = executionFor(
      scanner,
      quarantine,
      fixture.paths.lampwrightState,
      { run },
    );

    const report = await execution.execute(removalPlan, {
      grants: grantsFor(removalPlan),
    });

    expect(report.status).toBe("succeeded");
    expect(report.fallbackPlans).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    await expect(lstat(fixture.paths.managedReview)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(fixture.paths.unrelatedSkill, "SKILL.md"), "utf8"),
    ).resolves.toContain("keep-me");
    await expect(
      readFile(fixture.paths.pluginCollateral, "utf8"),
    ).resolves.toBe("# plugin collateral\n");
    await expect(
      readFile(join(fixture.paths.projectSkill, "SKILL.md"), "utf8"),
    ).resolves.toContain("project-review");
    expect((await scanner.scan({})).installations).not.toContainEqual(
      expect.objectContaining({
        location: expect.objectContaining({
          path: fixture.paths.managedReview,
        }),
      }),
    );
  });

  it("stops on managed failure, requires a second fallback plan, and restores Quarantine", async () => {
    const fixture = await createMvpEndToEndFixture(
      await createTestEnvironment(),
    );
    const scanner = fixture.createScanner(true);
    const initial = await scanner.scan({});
    const selected = initial.installations.find(
      (installation) => installation.ownership.kind === "manager",
    )!;
    const managedPlan = plan(initial, {
      kind: "targets",
      targets: [targetFor(selected)],
      force: false,
      mode: "managed-first",
    });
    const quarantine = quarantineFor(fixture.paths.lampwrightState);
    const execution = executionFor(
      scanner,
      quarantine,
      fixture.paths.lampwrightState,
      {
        run: vi.fn(async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "manager failed",
        })),
      },
    );

    const failed = await execution.execute(managedPlan, {
      grants: grantsFor(managedPlan),
    });

    expect(failed.status).toBe("failed");
    expect(failed.fallbackPlans).toHaveLength(1);
    expect(failed.fallbackPlans[0]?.intent.mode).toBe("brute-force");
    expect(failed.fallbackPlans[0]?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "quarantine",
          approvals: expect.arrayContaining([
            { kind: "brute-force-confirmation" },
          ]),
        }),
        expect.objectContaining({ kind: "record-cleanup" }),
      ]),
    );
    await expect(lstat(fixture.paths.managedReview)).resolves.toBeDefined();
    await expect(lstat(fixture.paths.lampwrightState)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const recovered = await execution.execute(failed.fallbackPlans[0]!, {
      grants: grantsFor(failed.fallbackPlans[0]!),
    });

    expect(recovered.status).toBe("succeeded");
    await expect(lstat(fixture.paths.managedReview)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(fixture.paths.unrelatedSkill, "SKILL.md"), "utf8"),
    ).resolves.toContain("keep-me");
    await expect(
      readFile(fixture.paths.pluginCollateral, "utf8"),
    ).resolves.toBe("# plugin collateral\n");
    await expect(
      readFile(join(fixture.paths.projectSkill, "SKILL.md"), "utf8"),
    ).resolves.toContain("project-review");

    const entries = await quarantine.list();
    expect(entries).toHaveLength(2);
    const artifact = entries.find(
      (entry) => entry.kind === "displaced-artifact",
    )!;
    const record = entries.find(
      (entry) => entry.kind === "record-cleanup-preimage",
    )!;
    expect(artifact).toMatchObject({
      kind: "displaced-artifact",
      originalLocation: { path: fixture.paths.managedReview },
    });
    await expect(quarantine.previewRestore(artifact)).resolves.toMatchObject({
      status: "would-restore",
      destination: fixture.paths.managedReview,
    });
    await expect(quarantine.restore(artifact)).resolves.toMatchObject({
      status: "restored",
      destination: fixture.paths.managedReview,
    });
    await expect(
      quarantine.restore(record, { kind: "replace-record-postimage" }),
    ).resolves.toMatchObject({
      status: "restored",
      destination: fixture.paths.managerLock,
    });
    await expect(
      readFile(join(fixture.paths.managedReview, "SKILL.md"), "utf8"),
    ).resolves.toContain("manager-owned review");
  });
});

function executionFor(
  scanner: InventoryScanner,
  quarantine: QuarantineModule,
  stateRoot: string,
  processRunner: ExecutionProcessRunner,
) {
  return createExecutionModule({
    scan: () => scanner.scan({}),
    replan: plan,
    quarantine,
    processRunner,
    inspectGitProtection: async () => ({ kind: "outside-worktree" }),
    auditWriter: { write: vi.fn(async () => undefined) },
    packageTrustStore: {
      isTrusted: vi.fn(async () => false),
      trust: vi.fn(async () => undefined),
    },
    now: () => fixedTime,
    stateRoot,
    maxConcurrency: 2,
  });
}

function quarantineFor(stateRoot: string): QuarantineModule {
  let id = 0;
  const quarantine = createQuarantineModule({
    stateRoot,
    now: () => fixedTime,
    createId: () => `mvp-${String((id += 1))}`,
    fileSystem: nodeQuarantineFileSystem,
    inspectGitProtection: async () => ({ kind: "outside-worktree" }),
  });
  return quarantine;
}

function installationNamed(inventory: Inventory, name: string): Installation {
  const installation = inventory.installations.find(
    (candidate) => candidate.skill.name === name,
  );
  if (installation === undefined)
    throw new Error(`Installation not found: ${name}`);
  return installation;
}

function targetFor(installation: Installation): RemovalTarget {
  return { kind: "installation", installationId: installation.id };
}

function grantsFor(removalPlan: RemovalPlan): readonly ApprovalRequirement[] {
  const grants = removalPlan.actions.flatMap((action) => action.approvals);
  return grants.filter(
    (approval, index) =>
      grants.findIndex(
        (candidate) =>
          stringifyModel(candidate, 0) === stringifyModel(approval, 0),
      ) === index,
  );
}
