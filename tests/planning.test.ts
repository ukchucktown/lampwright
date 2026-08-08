import { describe, expect, it } from "vitest";

import {
  PlanningError,
  plan,
  resolveTargetSelectors,
  stringifyModel,
  type HardDependency,
  type Installation,
  type Inventory,
  type PluginBoundary,
  type RemovalEvidence,
  type RemovalTarget,
  type Scope,
} from "../src/index.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildSystemSkillFinding,
} from "../src/testing/index.js";

const availableFallback = {
  kind: "available" as const,
  requiresSeparateConfirmation: true as const,
};

const fixtureFileHash = {
  algorithm: "sha256" as const,
  digest: "a".repeat(64),
};

const fixtureRecordHash = {
  algorithm: "sha256" as const,
  digest: "b".repeat(64),
};

function managerRemoval(
  overrides: Partial<RemovalEvidence> = {},
): RemovalEvidence {
  return {
    managed: {
      adapterId: "fixture-adapter",
      operationId: "remove",
      availability: { kind: "available" },
      trust: { kind: "trusted" },
      externalId: "external-skill",
      invocation: {
        kind: "direct",
        command: {
          executable: "fixture-manager",
          arguments: ["remove", "external-skill"],
        },
      },
      effects: [],
      verifications: [],
    },
    fallback: availableFallback,
    recordCleanups: [],
    ...overrides,
  };
}

function managerInstallation(
  id: string,
  overrides: Parameters<typeof buildInstallation>[0] = {},
): Installation {
  return buildInstallation({
    id,
    skill: { name: id, description: null },
    manager: { id: "fixture-manager" },
    ownership: {
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    },
    removal: managerRemoval(),
    location: {
      path: `/fixtures/skills/${id}`,
      canonicalPath: `/fixtures/skills/${id}`,
      artifactType: { kind: "directory" },
    },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "canonical-target",
          canonicalPath: `/fixtures/skills/${id}`,
        },
      ],
      weakEvidence: [{ strength: "weak", kind: "name", normalizedName: id }],
    },
    ...overrides,
  });
}

function pluginInstallation(
  id: string,
  pluginId: string,
  independentlySelectable: boolean,
  overrides: Parameters<typeof buildInstallation>[0] = {},
): Installation {
  return buildInstallation({
    id,
    classification: "managed-plugin-resource",
    skill: { name: id, description: null },
    plugin: { id: pluginId, version: "1.0.0" },
    pluginBoundaryId: `${pluginId}-boundary`,
    ownership: {
      kind: "plugin",
      pluginId,
      independentlySelectable,
      confidence: "declared",
    },
    location: {
      path: `/fixtures/plugins/${pluginId}/${id}`,
      canonicalPath: `/fixtures/plugins/${pluginId}/${id}`,
      artifactType: { kind: "directory" },
    },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "plugin",
          pluginId,
          skillId: id,
        },
      ],
      weakEvidence: [{ strength: "weak", kind: "name", normalizedName: id }],
    },
    removal: managerRemoval(),
    ...overrides,
  });
}

function pluginBoundary(
  pluginId: string,
  installations: readonly Installation[],
  independentlySelectable: boolean,
  overrides: Partial<PluginBoundary> = {},
): PluginBoundary {
  return {
    id: installations[0]?.pluginBoundaryId ?? `${pluginId}-boundary`,
    pluginId,
    version: "1.0.0",
    adapterId: "fixture-adapter",
    exposedTo: ["fixture-agent"],
    runtimeDefault: false,
    ownership: {
      kind: "plugin",
      pluginId,
      independentlySelectable,
      confidence: "declared",
    },
    installationIds: installations.map((installation) => installation.id),
    resources: [],
    removal: managerRemoval({
      managed: {
        adapterId: "fixture-adapter",
        operationId: "remove-plugin",
        availability: { kind: "available" },
        trust: { kind: "trusted" },
        externalId: pluginId,
        invocation: {
          kind: "direct",
          command: {
            executable: "fixture-manager",
            arguments: ["remove-plugin", pluginId],
          },
        },
        effects: [],
        verifications: [],
      },
    }),
    ...overrides,
  };
}

function inventoryWith(
  installations: readonly Installation[],
  overrides: Parameters<typeof buildInventory>[0] = {},
): Inventory {
  return buildInventory({
    installations,
    logicalSkills: [],
    plugins: [],
    ...overrides,
  });
}

function target(installationId: string): RemovalTarget {
  return { kind: "installation", installationId } as RemovalTarget;
}

function dependency(
  dependentInstallationId: string,
  targetInstallationId: string,
): HardDependency {
  return {
    kind: "hard",
    dependentInstallationId,
    target: target(targetInstallationId),
    source: { kind: "adapter", adapterId: "fixture-adapter" },
    reason: `${dependentInstallationId} requires ${targetInstallationId}`,
  } as HardDependency;
}

describe("pure removal planner", () => {
  it("produces a deterministic brute-force plan for a filesystem installation", () => {
    const inventory = buildInventory();
    const intent = {
      kind: "targets" as const,
      targets: [target("installation-1")] as const,
      force: false,
      mode: "managed-first" as const,
    };

    const first = plan(inventory, intent);
    const second = plan(inventory, intent);

    expect(stringifyModel(first)).toBe(stringifyModel(second));
    expect(first.createdAt).toBe(inventory.scannedAt);
    expect(first.actions).toMatchObject([
      {
        kind: "quarantine",
        affectedInstallationIds: ["installation-1"],
        approvals: [
          { kind: "confirmation" },
          { kind: "brute-force-confirmation" },
        ],
      },
    ]);
    expect(first.verificationChecks.map((check) => check.kind)).toEqual([
      "path-absent",
      "target-unavailable",
    ]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("canonicalizes caller target order in the plan identity", () => {
    const first = buildInstallation({ id: "ordered-a" });
    const second = buildInstallation({ id: "ordered-b" });
    const inventory = inventoryWith([first, second]);
    const forward = plan(inventory, {
      kind: "targets",
      targets: [target(first.id), target(second.id)],
      force: false,
      mode: "managed-first",
    });
    const reverse = plan(inventory, {
      kind: "targets",
      targets: [target(second.id), target(first.id)],
      force: false,
      mode: "managed-first",
    });

    expect(reverse.id).toBe(forward.id);
    expect(stringifyModel(reverse)).toBe(stringifyModel(forward));
    expect(forward.intent).toEqual({
      kind: "targets",
      targets: [target(first.id), target(second.id)],
      force: false,
      mode: "managed-first",
    });
  });

  it("supports different safe methods across one heterogeneous Logical Skill", () => {
    const evidence = {
      strength: "strong" as const,
      kind: "package" as const,
      packageId: "shared-package",
    };
    const managed = managerInstallation("heterogeneous-managed", {
      identity: { strongEvidence: [evidence], weakEvidence: [] },
    });
    const filesystem = buildInstallation({
      id: "heterogeneous-filesystem",
      identity: { strongEvidence: [evidence], weakEvidence: [] },
    });
    const logical = buildLogicalSkill({
      id: "heterogeneous-logical",
      identity: { strongEvidence: [evidence], weakEvidence: [] },
      installationIds: [managed.id, filesystem.id],
    });
    const removalPlan = plan(
      inventoryWith([managed, filesystem], {
        logicalSkills: [logical],
      }),
      {
        kind: "targets",
        targets: [{ kind: "logical-skill", logicalSkillId: logical.id }],
        force: false,
        mode: "managed-first",
      },
    );

    expect(
      removalPlan.actions
        .map((action) => [action.kind, action.affectedInstallationIds[0]])
        .sort((left, right) => String(left[1]).localeCompare(String(right[1]))),
    ).toEqual([
      ["quarantine", filesystem.id],
      ["managed-removal", managed.id],
    ]);
  });

  it("resolves only strong logical members and removes shared links by physical path", () => {
    const sharedEvidence = {
      strength: "strong" as const,
      kind: "canonical-target" as const,
      canonicalPath: "/fixtures/source/shared",
    };
    const first = buildInstallation({
      id: "link-a",
      location: {
        path: "/fixtures/links/a",
        canonicalPath: sharedEvidence.canonicalPath,
        artifactType: {
          kind: "symbolic-link",
          target: sharedEvidence.canonicalPath,
          broken: false,
        },
      },
      identity: {
        strongEvidence: [sharedEvidence],
        weakEvidence: [
          { strength: "weak", kind: "name", normalizedName: "shared" },
        ],
      },
    });
    const second = buildInstallation({
      id: "link-b",
      location: {
        path: "/fixtures/links/b",
        canonicalPath: sharedEvidence.canonicalPath,
        artifactType: {
          kind: "symbolic-link",
          target: sharedEvidence.canonicalPath,
          broken: false,
        },
      },
      identity: first.identity,
    });
    const weakConflict = buildInstallation({
      id: "weak-conflict",
      location: {
        path: "/fixtures/other/shared",
        canonicalPath: "/fixtures/other/shared",
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: "/fixtures/other/shared",
          },
        ],
        weakEvidence: first.identity.weakEvidence,
      },
    });
    const logical = buildLogicalSkill({
      id: "logical-shared",
      identity: { strongEvidence: [sharedEvidence], weakEvidence: [] },
      installationIds: [first.id, second.id],
    });
    const inventory = inventoryWith([first, second, weakConflict], {
      logicalSkills: [logical],
      identityHints: [
        {
          evidence: first.identity.weakEvidence[0]!,
          installationIds: [first.id, second.id, weakConflict.id],
        },
      ],
    });

    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "logical-skill", logicalSkillId: logical.id }],
      force: false,
      mode: "managed-first",
    });

    expect(
      removalPlan.actions.flatMap((action) =>
        action.kind === "quarantine" ? [action.location.path] : [],
      ),
    ).toEqual(["/fixtures/links/a", "/fixtures/links/b"]);
    expect(stringifyModel(removalPlan)).not.toContain("weak-conflict");
  });

  it("keeps plugin boundaries out of ordinary remove-all and expands explicit inclusion", () => {
    const ordinary = buildInstallation({ id: "ordinary" });
    const child = pluginInstallation("plugin-child", "plugin-a", false);
    const boundary = pluginBoundary("plugin-a", [child], false, {
      resources: [
        {
          kind: "agent",
          id: "reviewer",
          location: null,
          protection: null,
          cleanupId: null,
        },
        {
          kind: "command",
          id: "clean",
          location: null,
          protection: null,
          cleanupId: null,
        },
        {
          kind: "hook",
          id: "pre-run",
          location: null,
          protection: null,
          cleanupId: null,
        },
        {
          kind: "configuration",
          id: "settings",
          location: null,
          protection: null,
          cleanupId: null,
        },
      ],
    });
    const inventory = inventoryWith([ordinary, child], {
      plugins: [boundary],
    });

    const ordinaryAll = plan(inventory, {
      kind: "all",
      includePlugins: false,
      force: false,
      mode: "managed-first",
    });
    expect(ordinaryAll.targets).toEqual([target("ordinary")]);
    expect(stringifyModel(ordinaryAll)).not.toContain("plugin-a");

    const withPlugins = plan(inventory, {
      kind: "all",
      includePlugins: true,
      force: false,
      mode: "managed-first",
    });
    expect(withPlugins.targets).toEqual([
      target("ordinary"),
      { kind: "plugin", pluginBoundaryId: "plugin-a-boundary" },
    ]);
    expect(withPlugins.actions.map((action) => action.kind).sort()).toEqual([
      "managed-removal",
      "quarantine",
    ]);
    expect(
      withPlugins.warnings.find((warning) => warning.kind === "plugin-impact"),
    ).toMatchObject({
      affectedResources: expect.arrayContaining([
        "agent:reviewer",
        "command:clean",
        "hook:pre-run",
        "configuration:settings",
      ]),
    });

    const runtimeInventory = inventoryWith([ordinary, child], {
      plugins: [{ ...boundary, runtimeDefault: true }],
    });
    const runtimeAll = plan(runtimeInventory, {
      kind: "all",
      includePlugins: true,
      force: false,
      mode: "managed-first",
    });
    expect(runtimeAll.targets).toEqual([target("ordinary")]);

    const namedRuntimePlugin = plan(runtimeInventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: "plugin-a-boundary" }],
      force: false,
      mode: "managed-first",
    });
    expect(namedRuntimePlugin.actions).toEqual([]);
    expect(namedRuntimePlugin.blocks).toContainEqual({
      kind: "runtime-default-plugin",
      target: { kind: "plugin", pluginBoundaryId: "plugin-a-boundary" },
      pluginId: "plugin-a",
      exposedTo: ["fixture-agent"],
      overridable: false,
    });

    const forcedRuntimePlugin = plan(runtimeInventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: "plugin-a-boundary" }],
      force: true,
      mode: "managed-first",
    });
    expect(forcedRuntimePlugin.actions).toEqual([]);
  });

  it("resolves Plugin targets by physical boundary rather than external ID", () => {
    const userChild = buildInstallation({
      ...pluginInstallation("user-child", "shared-plugin", false),
      pluginBoundaryId: "shared-user-boundary",
    });
    const workspaceChild = buildInstallation({
      ...pluginInstallation("workspace-child", "shared-plugin", false),
      pluginBoundaryId: "shared-workspace-boundary",
    });
    const userBoundary = pluginBoundary("shared-plugin", [userChild], false);
    const workspaceBoundary = pluginBoundary(
      "shared-plugin",
      [workspaceChild],
      false,
    );
    const removalPlan = plan(
      inventoryWith([userChild, workspaceChild], {
        plugins: [userBoundary, workspaceBoundary],
      }),
      {
        kind: "targets",
        targets: [{ kind: "plugin", pluginBoundaryId: workspaceBoundary.id }],
        force: false,
        mode: "managed-first",
      },
    );

    expect(removalPlan.actions).toHaveLength(1);
    expect(removalPlan.actions[0]?.affectedInstallationIds).toEqual([
      workspaceChild.id,
    ]);
    expect(stringifyModel(removalPlan)).not.toContain(userChild.id);
  });

  it("allows selectable plugin children but never forces a nonselectable child boundary", () => {
    const selectable = pluginInstallation("selectable", "plugin-a", true);
    const selectableInventory = inventoryWith([selectable], {
      plugins: [pluginBoundary("plugin-a", [selectable], true)],
    });
    expect(
      plan(selectableInventory, {
        kind: "targets",
        targets: [target(selectable.id)],
        force: false,
        mode: "managed-first",
      }).actions,
    ).toHaveLength(1);
    expect(
      plan(selectableInventory, {
        kind: "all",
        includePlugins: false,
        force: false,
        mode: "managed-first",
      }).targets,
    ).toEqual([target(selectable.id)]);

    const fixed = pluginInstallation("fixed", "plugin-b", false);
    const ordinary = buildInstallation({ id: "ordinary-alongside-plugin" });
    const fixedInventory = inventoryWith([fixed, ordinary], {
      plugins: [pluginBoundary("plugin-b", [fixed], false)],
    });
    expect(
      plan(fixedInventory, {
        kind: "all",
        includePlugins: false,
        force: false,
        mode: "managed-first",
      }).targets,
    ).toEqual([target(ordinary.id)]);
    const blocked = plan(fixedInventory, {
      kind: "targets",
      targets: [target(fixed.id)],
      force: true,
      mode: "brute-force",
    });
    expect(blocked.actions).toEqual([]);
    expect(blocked.blocks).toContainEqual({
      kind: "plugin-boundary",
      target: target(fixed.id),
      pluginId: "plugin-b",
      alternative: {
        kind: "plugin",
        pluginBoundaryId: "plugin-b-boundary",
      },
      overridable: false,
    });
  });

  it("quarantines every path-backed Plugin collateral resource in brute mode", () => {
    const child = pluginInstallation("plugin-child", "plugin-paths", false);
    const writable = buildInstallation().protection;
    const boundary = pluginBoundary("plugin-paths", [child], false, {
      resources: [
        {
          kind: "hook",
          id: "pre-run",
          location: {
            path: "/fixtures/plugins/plugin-paths/hooks/pre-run.js",
            canonicalPath: "/fixtures/plugins/plugin-paths/hooks/pre-run.js",
            artifactType: { kind: "file" },
          },
          protection: writable,
          cleanupId: null,
        },
        {
          kind: "configuration",
          id: "settings",
          location: {
            path: "/fixtures/plugins/plugin-paths/settings.json",
            canonicalPath: "/fixtures/plugins/plugin-paths/settings.json",
            artifactType: { kind: "file" },
          },
          protection: writable,
          cleanupId: null,
        },
      ],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [],
      },
    });
    const removalPlan = plan(inventoryWith([child], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });
    const quarantines = removalPlan.actions.filter(
      (action) => action.kind === "quarantine",
    );

    expect(quarantines.map((action) => action.location.path)).toEqual([
      "/fixtures/plugins/plugin-paths/hooks/pre-run.js",
      child.location.path,
      "/fixtures/plugins/plugin-paths/settings.json",
    ]);
    expect(
      quarantines
        .filter((action) => action.location.artifactType.kind === "file")
        .every((action) => action.affectedInstallationIds.length === 0),
    ).toBe(true);
    expect(removalPlan.warnings).toContainEqual({
      kind: "unreconciled-owner-state",
      target: { kind: "plugin", pluginBoundaryId: boundary.id },
      owner: boundary.ownership,
      reason: "brute-force removal has no declarative owner-record cleanup",
    });
  });

  it("blocks brute Plugin fallback when collateral has no filesystem representation", () => {
    const child = pluginInstallation("plugin-child", "plugin-record", false);
    const boundary = pluginBoundary("plugin-record", [child], false, {
      resources: [
        {
          kind: "command",
          id: "in-manifest-only",
          location: null,
          protection: null,
          cleanupId: null,
        },
      ],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [],
      },
    });
    const removalPlan = plan(inventoryWith([child], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: true,
      mode: "brute-force",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.verificationChecks).toEqual([]);
    expect(removalPlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "managed-removal-unavailable",
        overridable: false,
      }),
    );
  });

  it("permits pathless Plugin collateral only when it names its exact cleanup", () => {
    const child = pluginInstallation("plugin-child", "plugin-record", false);
    const cleanup = {
      id: "cleanup-plugin-command",
      location: {
        path: "/fixtures/plugins/plugin-record/manifest.json",
        canonicalPath: "/fixtures/plugins/plugin-record/manifest.json",
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: "/commands/clean",
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    };
    const boundary = pluginBoundary("plugin-record", [child], false, {
      resources: [
        {
          kind: "command",
          id: "clean",
          location: null,
          protection: null,
          cleanupId: cleanup.id,
        },
      ],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [cleanup],
      },
    });

    const removalPlan = plan(inventoryWith([child], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });

    expect(removalPlan.blocks).toEqual([]);
    expect(removalPlan.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "record-cleanup",
    ]);
    expect(removalPlan.actions[1]).toMatchObject({
      affectedTargets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      records: [
        {
          recordPointer: cleanup.recordPointer,
          expectedRecordHash: cleanup.expectedRecordHash,
        },
      ],
    });
  });

  it("blocks Plugin quarantine when its root contains the planned cleanup document", () => {
    const rootPath = "/fixtures/plugins/contained-cleanup";
    const cleanup = {
      id: "cleanup-contained-command",
      location: {
        path: `${rootPath}/manifest.json`,
        canonicalPath: `${rootPath}/manifest.json`,
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: "/commands/clean",
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    };
    const boundary = pluginBoundary("contained-cleanup", [], false, {
      resources: [
        {
          kind: "other",
          id: "declared-root",
          location: {
            path: rootPath,
            canonicalPath: rootPath,
            artifactType: { kind: "directory" },
          },
          protection: buildInstallation().protection,
          cleanupId: null,
        },
        {
          kind: "command",
          id: "clean",
          location: null,
          protection: null,
          cleanupId: cleanup.id,
        },
      ],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [cleanup],
      },
    });

    const removalPlan = plan(inventoryWith([], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: true,
      mode: "brute-force",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.verificationChecks).toEqual([]);
    expect(removalPlan.blocks).toContainEqual({
      kind: "cleanup-conflict",
      target: { kind: "plugin", pluginBoundaryId: boundary.id },
      path: cleanup.location.path,
      reason: "quarantine path contains a planned record-cleanup document",
      overridable: false,
    });
  });

  it("blocks a cleanup whose canonical physical path is inside a quarantined directory", () => {
    const cleanup = {
      id: "cleanup-directory-alias",
      location: {
        path: "/fixtures/state/manifest-alias.json",
        canonicalPath: "/fixtures/physical-plugin/manifest.json",
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: "/commands/clean",
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    };
    const boundary = pluginBoundary("directory-alias", [], false, {
      resources: [
        {
          kind: "other",
          id: "declared-root",
          location: {
            path: "/fixtures/aliases/plugin",
            canonicalPath: "/fixtures/physical-plugin",
            artifactType: { kind: "directory" },
          },
          protection: buildInstallation().protection,
          cleanupId: null,
        },
        {
          kind: "command",
          id: "clean",
          location: null,
          protection: null,
          cleanupId: cleanup.id,
        },
      ],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [cleanup],
      },
    });

    const removalPlan = plan(inventoryWith([], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.blocks).toContainEqual(
      expect.objectContaining({
        kind: "cleanup-conflict",
        path: cleanup.location.path,
      }),
    );
  });

  it("does not treat a quarantined link as covering its canonical target", () => {
    const physicalRoot = "/fixtures/physical-plugin";
    const cleanup = {
      id: "cleanup-link-target",
      location: {
        path: `${physicalRoot}/manifest.json`,
        canonicalPath: `${physicalRoot}/manifest.json`,
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: "/commands/clean",
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    };
    const boundary = pluginBoundary("link-alias", [], false, {
      resources: [
        {
          kind: "other",
          id: "declared-root",
          location: {
            path: "/fixtures/aliases/plugin-link",
            canonicalPath: physicalRoot,
            artifactType: {
              kind: "symbolic-link",
              target: physicalRoot,
              broken: false,
            },
          },
          protection: buildInstallation().protection,
          cleanupId: null,
        },
        {
          kind: "command",
          id: "clean",
          location: null,
          protection: null,
          cleanupId: cleanup.id,
        },
      ],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [cleanup],
      },
    });

    const removalPlan = plan(inventoryWith([], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });

    expect(removalPlan.blocks).toEqual([]);
    expect(removalPlan.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "record-cleanup",
    ]);
  });

  it("allows a Plugin boundary and selectable child as alternate owners of one selector", () => {
    const cleanup = {
      id: "cleanup-plugin-domain",
      location: {
        path: "/fixtures/plugin-state/manifest.json",
        canonicalPath: "/fixtures/plugin-state/manifest.json",
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: "/skills/shared-child",
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    };
    const child = pluginInstallation("shared-child", "alternate-plugin", true, {
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [cleanup],
      },
    });
    const boundaryCleanup = {
      ...cleanup,
      id: "cleanup-plugin-domain-boundary",
    };
    const boundary = pluginBoundary("alternate-plugin", [child], true, {
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [boundaryCleanup],
      },
    });
    const inventory = inventoryWith([child], { plugins: [boundary] });

    const childPlan = plan(inventory, {
      kind: "targets",
      targets: [target(child.id)],
      force: false,
      mode: "brute-force",
    });
    const boundaryPlan = plan(inventory, {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: false,
      mode: "brute-force",
    });

    expect(childPlan.blocks).toEqual([]);
    expect(boundaryPlan.blocks).toEqual([]);
    expect(
      childPlan.actions.find((action) => action.kind === "record-cleanup"),
    ).toMatchObject({ affectedTargets: [target(child.id)] });
    expect(
      boundaryPlan.actions.find((action) => action.kind === "record-cleanup"),
    ).toMatchObject({
      affectedTargets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
    });
  });

  it("blocks a Plugin fallback that has no concrete removal effects", () => {
    const boundary = pluginBoundary("empty-plugin", [], false, {
      resources: [],
      removal: {
        managed: null,
        fallback: availableFallback,
        recordCleanups: [],
      },
    });

    const removalPlan = plan(inventoryWith([], { plugins: [boundary] }), {
      kind: "targets",
      targets: [{ kind: "plugin", pluginBoundaryId: boundary.id }],
      force: true,
      mode: "brute-force",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.verificationChecks).toEqual([]);
    expect(removalPlan.blocks).toEqual([
      {
        kind: "managed-removal-unavailable",
        target: { kind: "plugin", pluginBoundaryId: boundary.id },
        reason: "plugin fallback has no concrete removal effects",
        fallback: {
          kind: "unavailable",
          reason: "plugin fallback has no concrete removal effects",
        },
        overridable: false,
      },
    ]);
  });

  it("blocks incoming hard dependencies by default and permits only explicit force", () => {
    const requested = buildInstallation({ id: "required" });
    const dependent = buildInstallation({ id: "dependent" });
    const inventory = inventoryWith([requested, dependent], {
      dependencies: [dependency(dependent.id, requested.id)],
    });

    const blocked = plan(inventory, {
      kind: "targets",
      targets: [target(requested.id)],
      force: false,
      mode: "managed-first",
    });
    expect(blocked.actions).toEqual([]);
    expect(blocked.blocks[0]).toMatchObject({
      kind: "hard-dependency",
      overridable: true,
    });

    const forced = plan(inventory, {
      kind: "targets",
      targets: [target(requested.id)],
      force: true,
      mode: "managed-first",
    });
    expect(forced.actions).toHaveLength(1);
    expect(forced.actions[0]?.approvals).toContainEqual({
      kind: "force-override",
      safeguards: ["dependency"],
    });
  });

  it("orders selected dependents before their hard-dependency targets", () => {
    const required = buildInstallation({ id: "required" });
    const dependent = buildInstallation({ id: "dependent" });
    const inventory = inventoryWith([required, dependent], {
      dependencies: [dependency(dependent.id, required.id)],
    });

    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [target(required.id), target(dependent.id)],
      force: false,
      mode: "managed-first",
    });

    expect(
      removalPlan.actions.map((action) => action.affectedInstallationIds),
    ).toEqual([[dependent.id], [required.id]]);
    expect(removalPlan.actions[1]?.dependsOn).toEqual([
      removalPlan.actions[0]?.id,
    ]);
  });

  it("blocks dependency cycles deterministically and breaks them only with force", () => {
    const first = buildInstallation({ id: "cycle-a" });
    const second = buildInstallation({ id: "cycle-b" });
    const inventory = inventoryWith([first, second], {
      dependencies: [
        dependency(second.id, first.id),
        dependency(first.id, second.id),
      ],
    });
    const baseIntent = {
      kind: "targets" as const,
      targets: [target(first.id), target(second.id)] as const,
      mode: "managed-first" as const,
    };

    const blocked = plan(inventory, { ...baseIntent, force: false });
    expect(blocked.actions).toEqual([]);
    expect(
      blocked.blocks.filter((block) => block.kind === "hard-dependency"),
    ).toHaveLength(2);

    const forced = plan(inventory, { ...baseIntent, force: true });
    expect(forced.actions).toHaveLength(2);
    expect(
      forced.actions.every((action) =>
        action.approvals.some((approval) => approval.kind === "force-override"),
      ),
    ).toBe(true);
    expect(forced.actions[1]?.dependsOn).toContain(forced.actions[0]?.id);
    expect(stringifyModel(forced)).toBe(
      stringifyModel(plan(inventory, { ...baseIntent, force: true })),
    );
  });

  it("serializes forced cyclic brute-force cleanups without retaining back-edges", () => {
    const cleanupFor = (id: string) => ({
      id: `cleanup-${id}`,
      location: {
        path: `/fixtures/manager/${id}.json`,
        canonicalPath: `/fixtures/manager/${id}.json`,
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: `/skills/${id}`,
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    });
    const first = managerInstallation("cleanup-cycle-a", {
      removal: managerRemoval({ recordCleanups: [cleanupFor("cycle-a")] }),
    });
    const second = managerInstallation("cleanup-cycle-b", {
      removal: managerRemoval({ recordCleanups: [cleanupFor("cycle-b")] }),
    });
    const inventory = inventoryWith([first, second], {
      dependencies: [
        dependency(second.id, first.id),
        dependency(first.id, second.id),
      ],
    });

    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [target(first.id), target(second.id)],
      force: true,
      mode: "brute-force",
    });

    expect(removalPlan.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "record-cleanup",
      "quarantine",
      "record-cleanup",
    ]);
    removalPlan.actions.slice(1).forEach((action, index) => {
      expect(action.dependsOn).toContain(removalPlan.actions[index]?.id);
    });
  });

  it("preserves acyclic ordering before and after a force-broken SCC", () => {
    const upstream = buildInstallation({ id: "scc-upstream" });
    const first = buildInstallation({ id: "scc-a" });
    const second = buildInstallation({ id: "scc-b" });
    const downstream = buildInstallation({ id: "scc-downstream" });
    const inventory = inventoryWith([upstream, first, second, downstream], {
      dependencies: [
        dependency(upstream.id, first.id),
        dependency(second.id, first.id),
        dependency(first.id, second.id),
        dependency(first.id, downstream.id),
      ],
    });
    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [
        target(downstream.id),
        target(second.id),
        target(upstream.id),
        target(first.id),
      ],
      force: true,
      mode: "managed-first",
    });
    const actionByInstallationId = new Map(
      removalPlan.actions.map((action, index) => [
        action.affectedInstallationIds[0],
        { action, index },
      ]),
    );
    const upstreamAction = actionByInstallationId.get(upstream.id)!;
    const firstAction = actionByInstallationId.get(first.id)!;
    const secondAction = actionByInstallationId.get(second.id)!;
    const downstreamAction = actionByInstallationId.get(downstream.id)!;

    expect(upstreamAction.index).toBeLessThan(firstAction.index);
    expect(upstreamAction.index).toBeLessThan(secondAction.index);
    expect(downstreamAction.index).toBeGreaterThan(firstAction.index);
    expect(downstreamAction.index).toBeGreaterThan(secondAction.index);
    expect(firstAction.action.dependsOn).toContain(upstreamAction.action.id);
    expect(secondAction.action.dependsOn).toContain(firstAction.action.id);
    expect(downstreamAction.action.dependsOn).toContain(firstAction.action.id);
    expect(downstreamAction.action.dependsOn).toContain(secondAction.action.id);
  });

  it("reports soft references without blocking actions", () => {
    const installation = buildInstallation();
    const finding = buildSystemSkillFinding();
    const inventory = inventoryWith([installation], {
      dependencies: [
        {
          kind: "soft",
          referringRecord: {
            kind: "finding",
            findingId: finding.id,
          },
          target: target(installation.id),
          evidence: "mentioned by a runtime note",
        },
      ],
      otherFindings: [finding],
    });
    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [target(installation.id)],
      force: false,
      mode: "managed-first",
    });

    expect(removalPlan.actions).toHaveLength(1);
    expect(removalPlan.blocks).toEqual([]);
    expect(removalPlan.warnings).toMatchObject([{ kind: "soft-reference" }]);
  });

  it.each([
    [
      "Git",
      {
        git: { kind: "protected" as const, worktreeRoot: "/fixtures/project" },
        system: { kind: "none" as const },
        filesystem: { kind: "writable" as const },
      },
      "git-protection",
    ],
    [
      "filesystem",
      {
        git: { kind: "outside-worktree" as const },
        system: { kind: "none" as const },
        filesystem: { kind: "read-only" as const, reason: "no permission" },
      },
      "filesystem-permission",
    ],
  ])("never lets force override %s protection", (_label, protection, kind) => {
    const installation = buildInstallation({ protection });
    const removalPlan = plan(inventoryWith([installation]), {
      kind: "targets",
      targets: [target(installation.id)],
      force: true,
      mode: "brute-force",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.blocks).toContainEqual(
      expect.objectContaining({ kind, overridable: false }),
    );
  });

  it("keeps System Skills outside remove-all targets and actions", () => {
    const system = buildSystemSkillFinding();
    const ordinary = buildInstallation();
    const removalPlan = plan(
      inventoryWith([ordinary], { otherFindings: [system] }),
      {
        kind: "all",
        includePlugins: false,
        force: true,
        mode: "brute-force",
      },
    );

    expect(stringifyModel(removalPlan)).not.toContain(system.id);
    expect(removalPlan.actions).toHaveLength(1);
    expect(removalPlan.intent).toEqual({
      kind: "all",
      includePlugins: false,
      force: true,
      mode: "brute-force",
    });
  });

  it("keeps managed removal and a separately requested fallback in separate plans", () => {
    const managed = managerInstallation("managed", {
      removal: managerRemoval({
        recordCleanups: [
          {
            id: "cleanup-managed",
            location: {
              path: "/fixtures/manager/records.json",
              canonicalPath: "/fixtures/manager/records.json",
              artifactType: { kind: "file" },
            },
            adapterId: "fixture-adapter",
            format: "json",
            recordPointer: "/skills/managed",
            expectedFileHash: fixtureFileHash,
            expectedRecordHash: fixtureRecordHash,
            protection: {
              git: { kind: "outside-worktree" },
              system: { kind: "none" },
              filesystem: { kind: "writable" },
            },
          },
          {
            id: "cleanup-managed-secondary",
            location: {
              path: "/fixtures/manager/records.json",
              canonicalPath: "/fixtures/manager/records.json",
              artifactType: { kind: "file" },
            },
            adapterId: "fixture-adapter",
            format: "json",
            recordPointer: "/skills/managed-secondary",
            expectedFileHash: fixtureFileHash,
            expectedRecordHash: {
              algorithm: "sha256",
              digest: "c".repeat(64),
            },
            protection: {
              git: { kind: "outside-worktree" },
              system: { kind: "none" },
              filesystem: { kind: "writable" },
            },
          },
        ],
      }),
    });
    const inventory = inventoryWith([managed]);

    const preferred = plan(inventory, {
      kind: "targets",
      targets: [target(managed.id)],
      force: false,
      mode: "managed-first",
    });
    expect(preferred.actions.map((action) => action.kind)).toEqual([
      "managed-removal",
    ]);

    const fallback = plan(inventory, {
      kind: "targets",
      targets: [target(managed.id)],
      force: false,
      mode: "brute-force",
    });
    expect(fallback.actions.map((action) => action.kind)).toEqual([
      "quarantine",
      "record-cleanup",
    ]);
    expect(fallback.actions[1]?.dependsOn).toContain(fallback.actions[0]?.id);
    expect(fallback.actions[1]).toMatchObject({
      kind: "record-cleanup",
      affectedTargets: [target(managed.id)],
      location: {
        path: "/fixtures/manager/records.json",
        canonicalPath: "/fixtures/manager/records.json",
        artifactType: { kind: "file" },
      },
      format: "json",
      expectedFileHash: fixtureFileHash,
      records: [
        {
          recordPointer: "/skills/managed",
          expectedRecordHash: fixtureRecordHash,
        },
        {
          recordPointer: "/skills/managed-secondary",
          expectedRecordHash: {
            algorithm: "sha256",
            digest: "c".repeat(64),
          },
        },
      ],
      protection: {
        git: { kind: "outside-worktree" },
        system: { kind: "none" },
        filesystem: { kind: "writable" },
      },
    });
    expect(fallback.verificationChecks).toContainEqual(
      expect.objectContaining({
        kind: "record-absent",
        path: "/fixtures/manager/records.json",
        format: "json",
        recordPointer: "/skills/managed",
      }),
    );
    expect(fallback.verificationChecks).toContainEqual(
      expect.objectContaining({
        kind: "record-absent",
        recordPointer: "/skills/managed-secondary",
      }),
    );
    expect(
      fallback.actions.every((action) =>
        action.approvals.some(
          (approval) => approval.kind === "brute-force-confirmation",
        ),
      ),
    ).toBe(true);
  });

  it("coalesces one physical owner record into one atomic cross-target cleanup", () => {
    const firstCleanup = {
      id: "cleanup-global-a",
      location: {
        path: "C:\\State\\records.json",
        canonicalPath: "C:\\State\\records.json",
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: "/skills/a",
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: fixtureRecordHash,
      protection: buildInstallation().protection,
    };
    const secondCleanup = {
      ...firstCleanup,
      id: "cleanup-global-b",
      location: {
        ...firstCleanup.location,
        path: "c:\\state\\RECORDS.json",
        canonicalPath: "c:\\state\\RECORDS.json",
      },
      recordPointer: "/skills/b",
      expectedRecordHash: {
        algorithm: "sha256" as const,
        digest: "c".repeat(64),
      },
    };
    const first = managerInstallation("global-a", {
      removal: managerRemoval({ recordCleanups: [firstCleanup] }),
    });
    const second = managerInstallation("global-b", {
      removal: managerRemoval({ recordCleanups: [secondCleanup] }),
    });

    const removalPlan = plan(inventoryWith([second, first]), {
      kind: "targets",
      targets: [target(second.id), target(first.id)],
      force: false,
      mode: "brute-force",
    });
    const cleanupActions = removalPlan.actions.filter(
      (action) => action.kind === "record-cleanup",
    );
    const quarantineActions = removalPlan.actions.filter(
      (action) => action.kind === "quarantine",
    );

    expect(cleanupActions).toHaveLength(1);
    expect(cleanupActions[0]).toMatchObject({
      affectedTargets: [target(first.id), target(second.id)],
      affectedInstallationIds: [first.id, second.id],
      records: [
        {
          recordPointer: firstCleanup.recordPointer,
          expectedRecordHash: firstCleanup.expectedRecordHash,
        },
        {
          recordPointer: secondCleanup.recordPointer,
          expectedRecordHash: secondCleanup.expectedRecordHash,
        },
      ],
    });
    expect(cleanupActions[0]?.approvals).toEqual(
      expect.arrayContaining([
        { kind: "confirmation" },
        { kind: "brute-force-confirmation" },
      ]),
    );
    expect(cleanupActions[0]?.dependsOn).toEqual(
      expect.arrayContaining(quarantineActions.map((action) => action.id)),
    );
  });

  it("blocks a shared cleanup document that would erase a dependency failure boundary", () => {
    const cleanupFor = (id: string) => ({
      id: `cleanup-shared-${id}`,
      location: {
        path: "/fixtures/manager/shared-records.json",
        canonicalPath: "/fixtures/manager/shared-records.json",
        artifactType: { kind: "file" as const },
      },
      adapterId: "fixture-adapter",
      format: "json" as const,
      recordPointer: `/skills/${id}`,
      expectedFileHash: fixtureFileHash,
      expectedRecordHash: {
        algorithm: "sha256" as const,
        digest: id === "dependent" ? "b".repeat(64) : "c".repeat(64),
      },
      protection: buildInstallation().protection,
    });
    const dependent = managerInstallation("shared-dependent", {
      removal: managerRemoval({
        recordCleanups: [cleanupFor("dependent")],
      }),
    });
    const required = managerInstallation("shared-required", {
      removal: managerRemoval({ recordCleanups: [cleanupFor("required")] }),
    });
    const inventory = inventoryWith([dependent, required], {
      dependencies: [dependency(dependent.id, required.id)],
    });

    const removalPlan = plan(inventory, {
      kind: "targets",
      targets: [target(dependent.id), target(required.id)],
      force: true,
      mode: "brute-force",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.verificationChecks).toEqual([]);
    expect(
      removalPlan.blocks.filter((block) => block.kind === "cleanup-conflict"),
    ).toEqual([
      {
        kind: "cleanup-conflict",
        target: target(dependent.id),
        path: "/fixtures/manager/shared-records.json",
        reason:
          "shared record cleanup cannot preserve hard-dependency failure boundaries",
        overridable: false,
      },
      {
        kind: "cleanup-conflict",
        target: target(required.id),
        path: "/fixtures/manager/shared-records.json",
        reason:
          "shared record cleanup cannot preserve hard-dependency failure boundaries",
        overridable: false,
      },
    ]);
  });

  it("blocks unavailable managed removal until brute force is separately requested", () => {
    const installation = managerInstallation("manager-missing", {
      removal: managerRemoval({
        managed: {
          adapterId: "fixture-adapter",
          operationId: "remove",
          availability: { kind: "unavailable", reason: "manager missing" },
          trust: { kind: "trusted" },
          externalId: "manager-missing",
          invocation: {
            kind: "direct",
            command: {
              executable: "fixture-manager",
              arguments: ["remove", "manager-missing"],
            },
          },
          effects: [],
          verifications: [],
        },
      }),
    });
    const inventory = inventoryWith([installation]);

    const preferred = plan(inventory, {
      kind: "targets",
      targets: [target(installation.id)],
      force: true,
      mode: "managed-first",
    });
    expect(preferred.actions).toEqual([]);
    expect(preferred.blocks).toContainEqual(
      expect.objectContaining({
        kind: "managed-removal-unavailable",
        overridable: false,
      }),
    );
    expect(
      plan(inventory, {
        kind: "targets",
        targets: [target(installation.id)],
        force: false,
        mode: "brute-force",
      }).actions.map((action) => action.kind),
    ).toEqual(["quarantine"]);
  });

  it("treats ambiguity as forceable without weakening adapter trust", () => {
    const ambiguous = buildInstallation({
      id: "ambiguous",
      ownership: { kind: "unknown", confidence: "unknown" },
    });
    const blockedTrust = managerInstallation("untrusted", {
      removal: managerRemoval({
        managed: {
          adapterId: "fixture-adapter",
          operationId: "remove",
          availability: { kind: "available" },
          trust: {
            kind: "blocked",
            adapterId: "fixture-adapter",
            contentHash: "changed-adapter-hash",
          },
          externalId: "untrusted",
          invocation: {
            kind: "direct",
            command: {
              executable: "fixture-manager",
              arguments: ["remove", "untrusted"],
            },
          },
          effects: [],
          verifications: [],
        },
      }),
    });

    const ambiguityPlan = plan(inventoryWith([ambiguous]), {
      kind: "targets",
      targets: [target(ambiguous.id)],
      force: true,
      mode: "managed-first",
    });
    expect(ambiguityPlan.actions).toHaveLength(1);
    expect(ambiguityPlan.actions[0]?.approvals).toContainEqual({
      kind: "force-override",
      safeguards: ["ambiguity"],
    });

    const trustPlan = plan(inventoryWith([blockedTrust]), {
      kind: "targets",
      targets: [target(blockedTrust.id)],
      force: true,
      mode: "managed-first",
    });
    expect(trustPlan.actions).toEqual([]);
    expect(trustPlan.blocks).toContainEqual(
      expect.objectContaining({ kind: "adapter-trust", overridable: false }),
    );
  });

  it("surfaces exact ephemeral package trust, download, and owner verification", () => {
    const installation = managerInstallation("ephemeral", {
      removal: managerRemoval({
        managed: {
          adapterId: "fixture-adapter",
          operationId: "remove",
          availability: { kind: "available" },
          trust: { kind: "trusted" },
          invocation: {
            kind: "ephemeral-package",
            packageExecution: {
              runner: "npx",
              packageName: "fixture-manager",
              packageVersion: "1.2.3",
              adapterHash: "adapter-hash",
              mayDownload: true,
            },
            packageArguments: ["remove", "ephemeral-external"],
          },
          externalId: "ephemeral-external",
          effects: [],
          verifications: [
            {
              kind: "owner-state-absent",
              externalId: "ephemeral-external",
            },
          ],
        },
      }),
    });
    const removalPlan = plan(inventoryWith([installation]), {
      kind: "targets",
      targets: [target(installation.id)],
      force: false,
      mode: "managed-first",
    });

    expect(removalPlan.actions[0]?.approvals).toContainEqual({
      kind: "package-trust",
      runner: "npx",
      packageName: "fixture-manager",
      packageVersion: "1.2.3",
      adapterHash: "adapter-hash",
    });
    expect(removalPlan.warnings).toContainEqual(
      expect.objectContaining({ kind: "ephemeral-download" }),
    );
    expect(removalPlan.actions[0]).toMatchObject({
      kind: "managed-removal",
      invocation: {
        kind: "ephemeral-package",
        packageExecution: {
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
        },
        packageArguments: ["remove", "ephemeral-external"],
      },
    });
    expect(removalPlan.verificationChecks).toContainEqual(
      expect.objectContaining({
        kind: "owner-state-absent",
        externalId: "ephemeral-external",
      }),
    );
  });

  it("discloses managed effects and verifies only removed paths", () => {
    const writable = buildInstallation().protection;
    const installation = managerInstallation("managed-effects", {
      removal: managerRemoval({
        managed: {
          adapterId: "fixture-adapter",
          operationId: "remove",
          availability: { kind: "available" },
          trust: { kind: "trusted" },
          externalId: "managed-effects",
          invocation: {
            kind: "direct",
            command: {
              executable: "fixture-manager",
              arguments: ["remove", "managed-effects"],
            },
          },
          effects: [
            {
              kind: "remove-path",
              path: "/fixtures/managed/removed",
              protection: writable,
            },
            {
              kind: "modify-path",
              path: "/fixtures/managed/modified",
              protection: writable,
            },
          ],
          verifications: [
            {
              kind: "record-absent",
              path: "/fixtures/manager/records.json",
              format: "json",
              recordPointer: "/skills/managed-effects",
            },
            {
              kind: "command-succeeds",
              command: {
                executable: "fixture-manager",
                arguments: ["has", "managed-effects"],
              },
              successExitCodes: [1],
            },
          ],
        },
      }),
    });
    const removalPlan = plan(inventoryWith([installation]), {
      kind: "targets",
      targets: [target(installation.id)],
      force: false,
      mode: "managed-first",
    });
    const action = removalPlan.actions[0];

    expect(action).toMatchObject({
      kind: "managed-removal",
      invocation: {
        kind: "direct",
        command: {
          executable: "fixture-manager",
          arguments: ["remove", "managed-effects"],
        },
      },
      effects: [
        { kind: "remove-path", path: "/fixtures/managed/removed" },
        { kind: "modify-path", path: "/fixtures/managed/modified" },
      ],
    });
    expect(
      removalPlan.verificationChecks.flatMap((check) =>
        check.kind === "path-absent" ? [check.path] : [],
      ),
    ).toEqual(["/fixtures/managed/removed"]);
    expect(removalPlan.verificationChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "record-absent",
          recordPointer: "/skills/managed-effects",
        }),
        expect.objectContaining({
          kind: "command-succeeds",
          command: {
            executable: "fixture-manager",
            arguments: ["has", "managed-effects"],
          },
          successExitCodes: [1],
        }),
      ]),
    );
  });

  it("never lets force override a protected managed effect", () => {
    const installation = managerInstallation("protected-effect", {
      removal: managerRemoval({
        managed: {
          adapterId: "fixture-adapter",
          operationId: "remove",
          availability: { kind: "available" },
          trust: { kind: "trusted" },
          externalId: "protected-effect",
          invocation: {
            kind: "direct",
            command: {
              executable: "fixture-manager",
              arguments: ["remove", "protected-effect"],
            },
          },
          effects: [
            {
              kind: "modify-path",
              path: "/fixtures/project/settings.json",
              protection: {
                git: {
                  kind: "protected",
                  worktreeRoot: "/fixtures/project",
                },
                system: { kind: "none" },
                filesystem: { kind: "writable" },
              },
            },
          ],
          verifications: [],
        },
      }),
    });
    const removalPlan = plan(inventoryWith([installation]), {
      kind: "targets",
      targets: [target(installation.id)],
      force: true,
      mode: "managed-first",
    });

    expect(removalPlan.actions).toEqual([]);
    expect(removalPlan.blocks).toContainEqual({
      kind: "git-protection",
      target: target(installation.id),
      path: "/fixtures/project/settings.json",
      overridable: false,
    });
    expect(removalPlan.verificationChecks).toEqual([]);
  });

  it("rejects missing targets at the planner interface", () => {
    expect(() =>
      plan(buildInventory(), {
        kind: "targets",
        targets: [target("missing")],
        force: false,
        mode: "managed-first",
      }),
    ).toThrow(PlanningError);
  });
  it("resolves a declared source to its Group and expands the Group to exact members", () => {
    const members = ["a", "b"].map((id) =>
      buildInstallation({
        id,
        manager: { id: "vercel-skills" },
        source: { id: "acme/toolkit", url: null },
        ownership: {
          kind: "manager",
          managerId: "vercel-skills",
          confidence: "declared",
        },
        location: {
          path: `/fixtures/skills/${id}`,
          canonicalPath: `/fixtures/skills/${id}`,
          artifactType: { kind: "directory" },
        },
        removal: {
          managed: null,
          fallback: availableFallback,
          recordCleanups: [],
        },
      }),
    );
    const inventory = buildInventory({
      installations: members,
      groups: [
        {
          id: "installation-group-1",
          label: "acme/toolkit",
          tier: "declared",
          evidence: {
            tier: "declared",
            kind: "manager-source",
            managerId: "vercel-skills",
            sourceId: "acme/toolkit",
          },
          scope: { kind: "user" },
          installationIds: ["a", "b"],
        },
      ],
    });

    const bySource = resolveTargetSelectors(inventory, ["source:acme/toolkit"]);
    const byId = resolveTargetSelectors(inventory, [
      "group:installation-group-1",
    ]);
    expect(bySource).toEqual([
      { kind: "source-group", groupId: "installation-group-1" },
    ]);
    expect(byId).toEqual(bySource);

    const result = plan(inventory, {
      kind: "targets",
      targets: bySource,
      force: false,
      mode: "brute-force",
    });
    expect(result.targets).toEqual(bySource);
    expect(
      result.actions.flatMap((action) => action.affectedInstallationIds).sort(),
    ).toEqual(["a", "b"]);
  });

  it("keeps the source selector expanding to Installations when no Group declares it", () => {
    const inventory = buildInventory({
      installations: [
        buildInstallation({ source: { id: "loose-source", url: null } }),
      ],
    });

    expect(resolveTargetSelectors(inventory, ["source:loose-source"])).toEqual([
      { kind: "installation", installationId: "installation-1" },
    ]);
  });

  it("refuses an ambiguous source selector that matches more than one Group", () => {
    const group = (id: string, scope: Scope, installationIds: string[]) => ({
      id,
      label: "acme/toolkit",
      tier: "declared" as const,
      evidence: {
        tier: "declared" as const,
        kind: "manager-source" as const,
        managerId: "vercel-skills",
        sourceId: "acme/toolkit",
      },
      scope,
      installationIds,
    });
    const member = (id: string, scope: Scope) =>
      buildInstallation({
        id,
        manager: { id: "vercel-skills" },
        source: { id: "acme/toolkit", url: null },
        scope,
        ownership: {
          kind: "manager",
          managerId: "vercel-skills",
          confidence: "declared",
        },
        location: {
          path: `/fixtures/skills/${id}`,
          canonicalPath: `/fixtures/skills/${id}`,
          artifactType: { kind: "directory" },
        },
      });
    const inventory = buildInventory({
      installations: [
        member("a", { kind: "user" }),
        member("b", { kind: "workspace", workspacePath: "/work" }),
      ],
      groups: [
        group("installation-group-1", { kind: "user" }, ["a"]),
        group(
          "installation-group-2",
          { kind: "workspace", workspacePath: "/work" },
          ["b"],
        ),
      ],
    });

    expect(() =>
      resolveTargetSelectors(inventory, ["source:acme/toolkit"]),
    ).toThrow(/use group:<id>/);
  });
});
