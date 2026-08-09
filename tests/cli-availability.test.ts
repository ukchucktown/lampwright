import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import { formatCliOutput, runCli } from "../src/cli.js";
import {
  createDisabledStorageModule,
  createInventoryScanner,
  parseAvailabilityReport,
  planAvailability,
  type AvailabilityPlan,
  type AvailabilityReport,
  type DisabledEntry,
  type DiscoveryRoot,
  type Inventory,
  type InventoryCommandRunner,
} from "../src/index.js";
import { nodeArtifactFileSystem } from "../src/filesystem/artifact-filesystem.js";
import { buildInstallation, buildInventory } from "../src/testing/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const environmentFixture = createIsolatedTestEnvironmentFixture();
const noCommands: InventoryCommandRunner = {
  async run() {
    return { exitCode: 1, stdout: "" };
  },
};

async function codexInventory(disabled: boolean): Promise<Inventory> {
  const environment = await environmentFixture();
  const root = join(environment.temporary, "skills");
  const skill = join(root, "review");
  const skillDocument = join(skill, "SKILL.md");
  const codexHome = join(environment.home, ".codex");
  await mkdir(skill, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(skillDocument, "---\nname: review\n---\n# Review\n");
  await writeFile(
    join(codexHome, "config.toml"),
    disabled
      ? `[[skills.config]]\npath = ${JSON.stringify(skillDocument)}\nenabled = false\n`
      : "# enabled\n",
  );
  const roots: readonly DiscoveryRoot[] = [
    { kind: "user", path: root, agentId: "codex", adapterId: null },
  ];
  return createInventoryScanner({
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    environment: {
      homeDirectory: environment.home,
      workspaceDirectory: environment.workspace,
      agentHomeDirectories: { codex: codexHome },
    },
    commandRunner: noCommands,
  }).scan({ roots });
}

function disabledEntry(
  installation = buildInstallation(),
  id = "disabled-1",
): DisabledEntry {
  return {
    schemaVersion: 1,
    id: id as DisabledEntry["id"],
    suspendedAt: "2026-08-08T12:00:00.000Z",
    originalLocation: installation.location,
    integrity: { algorithm: "sha256", digest: "a".repeat(64) },
    skillIdentity: installation.identity,
    installationIds: [installation.id],
    ownership: installation.ownership,
    harnessExposures: installation.harnessExposures,
    operation: { id: "availability-operation", displayNames: ["review"] },
    restoration: { mode: null, modifiedAt: null },
  };
}

function successfulAvailabilityReport(
  availabilityPlan: AvailabilityPlan,
  entryId = "disabled-1",
): AvailabilityReport {
  const completedAt = "2026-08-08T12:01:00.000Z";
  return parseAvailabilityReport({
    schemaVersion: 1,
    planId: availabilityPlan.id,
    inventoryId: availabilityPlan.inventoryId,
    finalInventoryId: availabilityPlan.inventoryId,
    rescanError: null,
    startedAt: completedAt,
    completedAt,
    status: "succeeded",
    actionResults: availabilityPlan.actions.map((action) => ({
      actionId: action.id,
      status: "succeeded",
      startedAt: completedAt,
      completedAt,
      details:
        action.kind === "suspended-disable"
          ? { entryId, path: action.request.location.path }
          : action.kind === "suspended-enable"
            ? {
                entryId: action.entry.id,
                destination: action.entry.originalLocation.path,
              }
            : {
                path: action.mutations[0].path,
                affectedExposures: action.effects.length,
              },
    })),
    targetResults: availabilityPlan.targets.map((target) => ({
      target,
      status:
        availabilityPlan.intent.operation === "disable"
          ? "disabled"
          : "enabled",
      actionIds: availabilityPlan.actions
        .filter((action) =>
          action.targets.some(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(target),
          ),
        )
        .map((action) => action.id),
      reason: null,
    })),
    verificationResults: availabilityPlan.verificationChecks.map((check) => ({
      checkId: check.id,
      status: "passed",
      details: {},
    })),
  });
}

describe("Availability CLI", () => {
  it("documents the Availability command and selector matrices in help", async () => {
    const output = await runCli(["--help"]);
    expect(output.exitCode).toBe(0);
    expect(output.output).toContain(
      "skill-cleaner disable <selector...> [--dry-run] [--yes] [--force]",
    );
    expect(output.output).toContain(
      "skill-cleaner enable <selector...> [--dry-run] [--yes] [--json]",
    );
    expect(output.output).toContain("Enable only:  disabled-entry:<entry-id>");
  });

  it("runs native Disable and Enable only through injected scan/list/plan/execute interfaces", async () => {
    for (const operation of ["disable", "enable"] as const) {
      const inventory = await codexInventory(operation === "enable");
      const scan = vi.fn(async () => inventory);
      const listDisabled = vi.fn(async () => []);
      const planner = vi.fn(planAvailability);
      const executeAvailability = vi.fn(async (availabilityPlan) =>
        successfulAvailabilityReport(availabilityPlan),
      );
      const output = await runCli(
        [
          operation,
          `installation:${inventory.installations[0]!.id}`,
          "--yes",
          "--adapter",
          "/fixtures/availability.jsonc",
        ],
        { scan, listDisabled, planAvailability: planner, executeAvailability },
      );

      expect(output).toMatchObject({
        exitCode: 0,
        output: {
          kind: "availability-report",
          operation,
          disabledEntryIds: [],
          report: { status: "succeeded" },
        },
      });
      expect(scan).toHaveBeenCalledWith(["/fixtures/availability.jsonc"]);
      expect(listDisabled).toHaveBeenCalledOnce();
      expect(planner).toHaveBeenCalledOnce();
      expect(planner.mock.calls[0]![2].targets).toEqual([
        {
          kind: "installation",
          installationId: inventory.installations[0]!.id,
        },
      ]);
      expect(planner.mock.results[0]!.value.actions).toMatchObject([
        { kind: "native-control" },
      ]);
      expect(executeAvailability).toHaveBeenCalledOnce();
    }
  });

  it("returns a stable Disabled entry selector from suspend and resolves it for Enable", async () => {
    const installation = buildInstallation();
    const inventory = buildInventory({ installations: [installation] });
    const scan = vi.fn(async () => inventory);
    const listDisabled = vi.fn(async () => [] as readonly DisabledEntry[]);
    const executeAvailability = vi.fn(async (availabilityPlan) =>
      successfulAvailabilityReport(availabilityPlan, "disabled-stable"),
    );
    const disabled = await runCli(
      ["disable", `installation:${installation.id}`, "--yes", "--json"],
      {
        scan,
        listDisabled,
        planAvailability,
        executeAvailability,
      },
    );
    expect(disabled).toMatchObject({
      exitCode: 0,
      output: {
        kind: "availability-report",
        operation: "disable",
        disabledEntryIds: ["disabled-stable"],
      },
    });
    expect(formatCliOutput(disabled.output, true)).toContain(
      '"disabled-stable"',
    );
    expect(formatCliOutput(disabled.output, false)).toContain(
      "disabled-entry:disabled-stable",
    );

    const entry = disabledEntry(installation, "disabled-stable");
    const emptyInventory = buildInventory({
      installations: [],
      logicalSkills: [],
    });
    const enableExecutor = vi.fn(async (availabilityPlan) =>
      successfulAvailabilityReport(availabilityPlan),
    );
    const enabled = await runCli(
      ["enable", "disabled-entry:disabled-stable", "--yes"],
      {
        scan: async () => emptyInventory,
        listDisabled: async () => [entry],
        planAvailability,
        executeAvailability: enableExecutor,
      },
    );
    expect(enabled).toMatchObject({
      exitCode: 0,
      output: { kind: "availability-report", operation: "enable" },
    });
    expect(enableExecutor.mock.calls[0]![0]).toMatchObject({
      intent: {
        targets: [{ kind: "installation", installationId: installation.id }],
      },
      actions: [{ kind: "suspended-enable", entry: { id: "disabled-stable" } }],
    });
  });

  it("keeps dry-run and blocked Availability commands zero-mutation", async () => {
    const writable = buildInventory();
    const executeAvailability = vi.fn();
    const environment = await environmentFixture();
    const stateRoot = join(environment.state, "availability-cli");
    const disabledStorage = createDisabledStorageModule({
      stateRoot,
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      createId: () => "unused",
      fileSystem: nodeArtifactFileSystem,
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
    });
    const listDisabled = vi.fn(() => disabledStorage.list());
    const dry = await runCli(
      ["disable", "installation:installation-1", "--dry-run", "--yes"],
      {
        scan: async () => writable,
        listDisabled,
        planAvailability,
        executeAvailability,
      },
    );
    expect(dry).toMatchObject({
      exitCode: 0,
      output: { kind: "availability-plan", plan: { actions: [{}] } },
    });
    await expect(
      access(join(stateRoot, "disabled-storage")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const protectedInventory = buildInventory({
      installations: [
        buildInstallation({
          protection: {
            git: { kind: "outside-worktree" },
            system: { kind: "none" },
            filesystem: { kind: "read-only", reason: "fixture protected" },
          },
        }),
      ],
    });
    const blocked = await runCli(
      ["disable", "installation:installation-1", "--yes", "--force"],
      {
        scan: async () => protectedInventory,
        listDisabled,
        planAvailability,
        executeAvailability,
      },
    );
    expect(blocked).toMatchObject({
      exitCode: 3,
      output: {
        kind: "availability-plan",
        plan: { actions: [], blocks: [{ overridable: false }] },
      },
    });
    expect(executeAvailability).not.toHaveBeenCalled();
    await expect(
      access(join(stateRoot, "disabled-storage")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const root = join(environment.temporary, "colliding-skills");
    const claudeHome = join(environment.home, ".claude");
    await mkdir(join(root, "one"), { recursive: true });
    await mkdir(join(root, "two"), { recursive: true });
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      join(root, "one", "SKILL.md"),
      "---\nname: collision\n---\n# One\n",
    );
    await writeFile(
      join(root, "two", "SKILL.md"),
      "---\nname: collision\n---\n# Two\n",
    );
    await writeFile(join(claudeHome, "settings.json"), "{}\n");
    const collisionInventory = await createInventoryScanner({
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      environment: {
        homeDirectory: environment.home,
        workspaceDirectory: environment.workspace,
        agentHomeDirectories: { "claude-code": claudeHome },
      },
      commandRunner: noCommands,
    }).scan({
      roots: [
        {
          kind: "user",
          path: root,
          agentId: "claude-code",
          adapterId: null,
        },
      ],
    });
    const collision = await runCli(
      [
        "disable",
        `installation:${collisionInventory.installations[0]!.id}`,
        "--yes",
        "--force",
      ],
      {
        scan: async () => collisionInventory,
        listDisabled,
        planAvailability,
        executeAvailability,
      },
    );
    expect(collision).toMatchObject({
      exitCode: 3,
      output: {
        kind: "availability-plan",
        plan: {
          actions: [],
          blocks: [{ kind: "name-collision", overridable: false }],
        },
      },
    });
    expect(executeAvailability).not.toHaveBeenCalled();
    await expect(
      access(join(stateRoot, "disabled-storage")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(listDisabled).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid Availability options and selectors with stable usage statuses", async () => {
    const inventory = buildInventory();
    const dependencies = {
      scan: async () => inventory,
      listDisabled: async () => [] as readonly DisabledEntry[],
      planAvailability,
    };
    for (const argv of [
      ["disable"],
      ["enable", "installation:installation-1", "--force"],
      ["disable", "installation:installation-1", "--all"],
      ["disable", "installation:installation-1", "--include-plugins"],
      ["disable", "installation:installation-1", "--brute-force"],
      [
        "disable",
        "installation:installation-1",
        "--trust-package",
        `npx:fixture@1.2.3:${"a".repeat(64)}`,
      ],
      ["disable", "disabled-entry:disabled-1"],
      ["disable", "source:fixture-source"],
      ["enable", "name:review"],
    ])
      await expect(runCli(argv, dependencies)).resolves.toMatchObject({
        exitCode: 2,
        output: { kind: "error", code: "invalid-usage" },
      });
    await expect(
      runCli(["enable", "disabled-entry:missing"], dependencies),
    ).resolves.toMatchObject({
      exitCode: 3,
      output: { kind: "error", code: "target-not-found" },
    });
    await expect(
      runCli(["enable", "installation:installation-1"], dependencies),
    ).resolves.toMatchObject({
      exitCode: 3,
      output: { kind: "error", code: "target-not-found" },
    });
  });

  it("maps confirmation, partial, failed, and stale-blocked outcomes to stable exit codes", async () => {
    const inventory = buildInventory();
    const dependencies = {
      scan: async () => inventory,
      listDisabled: async () => [] as readonly DisabledEntry[],
      planAvailability,
    };
    await expect(
      runCli(["disable", "installation:installation-1"], dependencies),
    ).resolves.toMatchObject({
      exitCode: 3,
      output: { kind: "confirmation-required", operation: "disable" },
    });
    for (const [status, exitCode] of [
      ["partial", 1],
      ["failed", 1],
      ["blocked", 3],
    ] as const) {
      const output = await runCli(
        ["disable", "installation:installation-1", "--yes"],
        {
          ...dependencies,
          executeAvailability: async (availabilityPlan) => ({
            ...successfulAvailabilityReport(availabilityPlan),
            status,
          }),
        },
      );
      expect(output).toMatchObject({
        exitCode,
        output: { kind: "availability-report", report: { status } },
      });
    }
  });

  it("validates deterministic Availability plan, confirmation, and report envelopes", async () => {
    const schema = JSON.parse(
      await readFile(
        join(repositoryRoot, "schemas", "cli-v1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
      schema,
    );
    const inventory = buildInventory();
    const dependencies = {
      scan: async () => inventory,
      listDisabled: async () => [] as readonly DisabledEntry[],
      planAvailability,
    };
    const plan = await runCli(
      ["disable", "installation:installation-1", "--dry-run"],
      dependencies,
    );
    const confirmation = await runCli(
      ["disable", "installation:installation-1"],
      dependencies,
    );
    const report = await runCli(
      ["disable", "installation:installation-1", "--yes"],
      {
        ...dependencies,
        executeAvailability: async (availabilityPlan) =>
          successfulAvailabilityReport(availabilityPlan),
      },
    );
    for (const output of [plan.output, confirmation.output, report.output])
      expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
    const json = formatCliOutput(plan.output, true);
    expect(formatCliOutput(plan.output, true)).toBe(json);
    expect(json).toContain('"kind": "availability-plan"');
  });
});
