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
  RemovalPlan,
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
export type RemovalPlanFixtureOverrides = FixtureOverrides<RemovalPlan>;
export type ExecutionReportFixtureOverrides = FixtureOverrides<ExecutionReport>;

export function buildInstallation(
  overrides: InstallationFixtureOverrides = {},
): Installation {
  return parseInstallation({
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
    agentId: "fixture-agent",
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
    tags: [],
    metadata: {},
    ...overrides,
  });
}

export function buildSystemSkillFinding(
  overrides: FindingFixtureOverrides = {},
): NonInstallationFinding {
  return parseNonInstallationFinding({
    id: "finding-1",
    classification: "system-skill",
    skill: { name: "runtime-skill", description: null },
    identity: { strongEvidence: [], weakEvidence: [] },
    agentId: "fixture-agent",
    scope: { kind: "agent", agentId: "fixture-agent" },
    location: {
      path: "/fixtures/runtime/runtime-skill",
      canonicalPath: "/fixtures/runtime/runtime-skill",
      artifactType: { kind: "directory" },
    },
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
    agentId: null,
    scope: null,
    location: {
      path: "/fixtures/source/source-skill",
      canonicalPath: "/fixtures/source/source-skill",
      artifactType: { kind: "directory" },
    },
    ownership: { kind: "filesystem", confidence: "inferred" },
    protection: {
      git: { kind: "outside-worktree" },
      system: { kind: "none" },
      filesystem: { kind: "writable" },
    },
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
    ...overrides,
  });
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
    dependencies: [],
    ...overrides,
  });
}

export function buildRemovalPlan(
  overrides: RemovalPlanFixtureOverrides = {},
): RemovalPlan {
  return parseRemovalPlan({
    schemaVersion: 1,
    id: "removal-plan-1",
    inventoryId: "inventory-1",
    createdAt: "2026-01-01T00:01:00.000Z",
    targets: [{ kind: "installation", installationId: "installation-1" }],
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
    startedAt: "2026-01-01T00:02:00.000Z",
    completedAt: "2026-01-01T00:03:00.000Z",
    status: "succeeded",
    actionResults: [],
    targetResults: [],
    verificationResults: [],
    ...overrides,
  });
}
