import {
  parseExecutionReport,
  parseInstallation,
  parseInventory,
  parseLogicalSkill,
  parseNonInstallationFinding,
  parseRemovalPlan,
} from "../model/validation.js";
import type {
  ExecutionReport,
  Installation,
  Inventory,
  JsonValue,
  LogicalSkill,
  ModelId,
  NonInstallationFinding,
  PluginBoundary,
  RemovalPlan,
  SuspensionEvidence,
} from "../model/types.js";

export type FixtureValue<T> =
  T extends ModelId<string>
    ? string
    : T extends readonly (infer Item)[]
      ? readonly FixtureValue<Item>[]
      : T extends JsonValue
        ? T
        : T extends object
          ? { readonly [Key in keyof T]: FixtureValue<T[Key]> }
          : T;

export type FixtureOverrides<T> = Partial<FixtureValue<T>>;

export type InstallationFixtureOverrides = FixtureOverrides<Installation>;
export type FindingFixtureOverrides = FixtureOverrides<NonInstallationFinding>;
export type LogicalSkillFixtureOverrides = FixtureOverrides<LogicalSkill>;
export type InventoryFixtureOverrides = FixtureOverrides<Inventory>;
export type PluginBoundaryFixtureOverrides = FixtureOverrides<PluginBoundary>;
export type RemovalPlanFixtureOverrides = FixtureOverrides<RemovalPlan>;
export type ExecutionReportFixtureOverrides = FixtureOverrides<ExecutionReport>;

export function buildInstallation(
  overrides: InstallationFixtureOverrides = {},
): Installation {
  const value = {
    id: "installation-1",
    classification: "active-installation",
    status: "active",
    skill: { name: "example-skill", description: "Fixture skill" },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "canonical-target",
          canonicalPath: "/fixtures/skills/example-skill",
        },
      ],
      weakEvidence: [
        { strength: "weak", kind: "name", normalizedName: "example-skill" },
      ],
    },
    source: null,
    plugin: null,
    manager: null,
    adapterId: "fixture-adapter",
    pluginBoundaryId: null,
    agentId: "fixture-agent",
    exposedTo: ["fixture-agent"],
    harnessExposures: [
      {
        harnessId: "fixture-agent",
        status: "enabled",
        control: { kind: "unsupported", reason: "fixture harness" },
      },
    ],
    suspension: {
      kind: "available",
      artifacts: [
        {
          location: {
            path: "/fixtures/skills/example-skill",
            canonicalPath: "/fixtures/skills/example-skill",
            artifactType: { kind: "directory" },
          },
          protection: {
            git: { kind: "outside-worktree" },
            system: { kind: "none" },
            filesystem: { kind: "writable" },
          },
        },
      ],
      managerRecord: "not-applicable",
      managerMayRecreate: false,
    } as SuspensionEvidence,
    scope: { kind: "user" },
    location: {
      path: "/fixtures/skills/example-skill",
      canonicalPath: "/fixtures/skills/example-skill",
      artifactType: { kind: "directory" },
    },
    contentHash: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ownership: { kind: "filesystem", confidence: "declared" },
    protection: {
      git: { kind: "outside-worktree" },
      system: { kind: "none" },
      filesystem: { kind: "writable" },
    },
    removal: {
      managed: null,
      fallback: {
        kind: "available",
        requiresSeparateConfirmation: true,
      },
      recordCleanups: [],
    },
    tags: [],
    metadata: {},
    ...overrides,
  };
  if (overrides.harnessExposures === undefined) {
    value.harnessExposures = [...new Set(value.exposedTo)]
      .sort()
      .map((harnessId) => ({
        harnessId,
        status: "enabled" as const,
        control: { kind: "unsupported" as const, reason: "fixture harness" },
      }));
  }
  if (overrides.suspension === undefined) {
    value.suspension = (
      value.ownership.kind === "filesystem"
        ? {
            kind: "available" as const,
            artifacts: [
              { location: value.location, protection: value.protection },
            ],
            managerRecord: "not-applicable" as const,
            managerMayRecreate: false,
          }
        : {
            kind: "unavailable" as const,
            reason: "fixture ownership has no declared suspension authority",
          }
    ) as SuspensionEvidence;
  }
  return parseInstallation(value);
}

export function buildSystemSkillFinding(
  overrides: FindingFixtureOverrides = {},
): NonInstallationFinding {
  return parseNonInstallationFinding({
    id: "finding-1",
    classification: "system-skill",
    skill: { name: "runtime-skill", description: null },
    identity: { strongEvidence: [], weakEvidence: [] },
    source: null,
    plugin: null,
    manager: null,
    adapterId: "fixture-adapter",
    agentId: "fixture-agent",
    scope: { kind: "agent", agentId: "fixture-agent" },
    location: {
      path: "/fixtures/runtime/runtime-skill",
      canonicalPath: "/fixtures/runtime/runtime-skill",
      artifactType: { kind: "directory" },
    },
    contentHash: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ownership: {
      kind: "agent-runtime",
      agentId: "fixture-agent",
      confidence: "declared",
    },
    protection: {
      git: { kind: "outside-worktree" },
      system: { kind: "system-skill", agentId: "fixture-agent" },
      filesystem: { kind: "read-only", reason: "supplied by runtime" },
    },
    tags: [],
    metadata: {},
    ...overrides,
  });
}

export function buildNonInstallationFinding(
  overrides: FindingFixtureOverrides = {},
): NonInstallationFinding {
  return parseNonInstallationFinding({
    id: "finding-1",
    classification: "source-artifact",
    skill: { name: "source-skill", description: "Fixture source artifact" },
    identity: {
      strongEvidence: [],
      weakEvidence: [
        { strength: "weak", kind: "name", normalizedName: "source-skill" },
      ],
    },
    source: { id: "fixture-source", url: null },
    plugin: null,
    manager: null,
    adapterId: "fixture-adapter",
    agentId: null,
    scope: null,
    location: {
      path: "/fixtures/source/source-skill",
      canonicalPath: "/fixtures/source/source-skill",
      artifactType: { kind: "directory" },
    },
    contentHash: null,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ownership: { kind: "filesystem", confidence: "inferred" },
    protection: {
      git: { kind: "outside-worktree" },
      system: { kind: "none" },
      filesystem: { kind: "writable" },
    },
    tags: [],
    metadata: {},
    ...overrides,
  });
}

export function buildLogicalSkill(
  overrides: LogicalSkillFixtureOverrides = {},
): LogicalSkill {
  return parseLogicalSkill({
    id: "logical-skill-1",
    skill: { name: "example-skill", description: "Fixture skill" },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "canonical-target",
          canonicalPath: "/fixtures/skills/example-skill",
        },
      ],
      weakEvidence: [
        { strength: "weak", kind: "name", normalizedName: "example-skill" },
      ],
    },
    installationIds: ["installation-1"],
    groupId: null,
    spansGroups: false,
    ...overrides,
  });
}

export function buildPluginBoundary(
  overrides: PluginBoundaryFixtureOverrides = {},
): PluginBoundary {
  return parseInventory({
    schemaVersion: 1,
    id: "plugin-boundary-fixture-inventory",
    scannedAt: "2026-01-01T00:00:00.000Z",
    installations: [],
    otherFindings: [],
    logicalSkills: [],
    identityHints: [],
    groups: [],
    plugins: [
      {
        id: "fixture-plugin",
        pluginId: "fixture-plugin",
        version: "1.0.0",
        adapterId: "fixture-adapter",
        exposedTo: ["fixture-agent"],
        ownership: {
          kind: "plugin",
          pluginId: "fixture-plugin",
          independentlySelectable: false,
          confidence: "declared",
        },
        runtimeDefault: false,
        installationIds: [],
        resources: [],
        removal: {
          managed: {
            adapterId: "fixture-adapter",
            operationId: "remove-plugin",
            availability: { kind: "available" },
            trust: { kind: "trusted" },
            externalId: "fixture-plugin",
            invocation: {
              kind: "direct",
              command: {
                executable: "fixture-manager",
                arguments: ["remove", "fixture-plugin"],
              },
            },
            effects: [],
            verifications: [],
          },
          fallback: {
            kind: "unavailable",
            reason: "plugin collateral requires managed removal",
          },
          recordCleanups: [],
        },
        ...overrides,
      },
    ],
    dependencies: [],
  }).plugins[0] as PluginBoundary;
}

export function buildInventory(
  overrides: InventoryFixtureOverrides = {},
): Inventory {
  return parseInventory({
    schemaVersion: 1,
    id: "inventory-1",
    scannedAt: "2026-01-01T00:00:00.000Z",
    installations: [buildInstallation()],
    otherFindings: [],
    logicalSkills: [],
    identityHints: [],
    groups: [],
    plugins: [],
    dependencies: [],
    ...overrides,
  });
}

export function buildRemovalPlan(
  overrides: RemovalPlanFixtureOverrides = {},
): RemovalPlan {
  const targets = overrides.targets ?? [
    { kind: "installation" as const, installationId: "installation-1" },
  ];
  return parseRemovalPlan({
    schemaVersion: 1,
    id: "removal-plan-1",
    inventoryId: "inventory-1",
    createdAt: "2026-01-01T00:01:00.000Z",
    intent:
      overrides.intent ??
      ({
        kind: "targets",
        targets,
        force: false,
        mode: "managed-first",
      } as const),
    targets,
    actions: [],
    blocks: [],
    warnings: [],
    verificationChecks: [],
    ...overrides,
  });
}

export function buildExecutionReport(
  overrides: ExecutionReportFixtureOverrides = {},
): ExecutionReport {
  return parseExecutionReport({
    schemaVersion: 1,
    planId: "removal-plan-1",
    inventoryId: "inventory-1",
    finalInventoryId: "inventory-1",
    rescanError: null,
    startedAt: "2026-01-01T00:02:00.000Z",
    completedAt: "2026-01-01T00:03:00.000Z",
    status: "succeeded",
    actionResults: [],
    targetResults: [],
    verificationResults: [],
    fallbackPlans: [],
    ...overrides,
  });
}
