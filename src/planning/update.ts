import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import { stringifyModel } from "../model/json.js";
import type {
  ApprovalRequirement,
  HardDependency,
  Installation,
  InstallationId,
  Inventory,
  PluginBoundary,
  UpdateEvidence,
} from "../model/types.js";
import { parseInventory } from "../model/validation.js";
import type {
  UpdateAction,
  UpdateAvailabilityExpectation,
  UpdateBlock,
  UpdateInstallationBoundaryFacts,
  UpdateIntent,
  UpdateLifecycleFacts,
  UpdatePlan,
  UpdateTarget,
  UpdateVerificationCheck,
  UpdateWarning,
} from "../update/types.js";
import { parseUpdateIntent, parseUpdatePlan } from "../update/validation.js";
import { PlanningError } from "./types.js";

interface ResolvedUpdateTarget {
  readonly target: UpdateTarget;
  readonly installations: readonly Installation[];
  readonly plugin: PluginBoundary | null;
}

interface Unit {
  readonly key: string;
  readonly installation: Installation | null;
  readonly plugin: PluginBoundary | null;
  readonly update: UpdateEvidence;
}

/** Purely resolves one explicit Update Target from materialized Inventory. */
export function planUpdate(
  inventoryInput: Inventory,
  intentInput: UpdateIntent,
): UpdatePlan {
  const inventory = parseInventory(inventoryInput);
  const intent = parseUpdateIntent(intentInput);
  const resolved = resolveTarget(inventory, intent.target);
  const units = planningUnits(resolved);
  let blocks = sortUnique([
    ...units.flatMap((unit) => blocksForUnit(unit, resolved.target)),
    ...targetBoundaryBlocks(resolved),
    ...authorityBoundaryBlocks(inventory, resolved, units),
    ...(resolved.plugin !== null &&
    resolved.installations.some((installation) =>
      installation.harnessExposures.some(
        (exposure) => exposure.status === "unresolved",
      ),
    )
      ? [
          {
            kind: "unresolved-availability" as const,
            target: resolved.target,
            installationId: null,
            path: null,
            reason: "Plugin child availability must be resolved before Update",
            overridable: false as const,
          },
        ]
      : []),
  ]);
  if (blocks.length === 0 && hasSelectedDependencyCycle(resolved, inventory))
    blocks = [
      {
        kind: "dependency-cycle",
        target: resolved.target,
        installationId: null,
        path: null,
        reason: "selected Hard Dependencies contain a cycle",
        overridable: false,
      },
    ];
  const planId = stableId(
    "update-plan",
    inventory.id,
    stringifyModel(intent, 0),
  );
  let actions: UpdateAction[] = [];
  let checks: UpdateVerificationCheck[] = [];
  let warnings: UpdateWarning[] = [];
  if (blocks.length === 0) {
    actions = units.map((unit) => actionForUnit(inventory, resolved, unit));
    actions = addDependencyOrdering(actions, inventory);
    checks = actions.map((action) => checkForAction(resolved, action));
    warnings = sortUnique([
      ...actions.flatMap((action) => warningsForAction(action)),
      ...softReferenceWarnings(inventory, resolved),
      ...dependencyWarnings(inventory, resolved),
      ...(resolved.plugin === null
        ? []
        : [
            {
              kind: "plugin-impact" as const,
              target: resolved.target as Extract<
                UpdateTarget,
                { kind: "plugin" }
              >,
              pluginId: resolved.plugin.pluginId,
              installationIds: resolved.installations.map((item) => item.id),
            },
          ]),
    ]);
  }
  return parseUpdatePlan({
    schemaVersion: 1,
    id: planId,
    inventoryId: inventory.id,
    createdAt: inventory.scannedAt,
    intent,
    targets: [resolved.target],
    actions,
    blocks,
    warnings,
    verificationChecks: checks,
  });
}

function resolveTarget(
  inventory: Inventory,
  target: UpdateTarget,
): ResolvedUpdateTarget {
  if (target.kind === "installation") {
    const installation = inventory.installations.find(
      (item) => item.id === target.installationId,
    );
    if (installation === undefined) throw targetNotFound(target);
    return { target, installations: [installation], plugin: null };
  }
  if (target.kind === "logical-skill") {
    const logical = inventory.logicalSkills.find(
      (item) => item.id === target.logicalSkillId,
    );
    if (logical === undefined) throw targetNotFound(target);
    return {
      target,
      installations: logical.installationIds.map((id) =>
        requireInstallation(inventory, id, target),
      ),
      plugin: null,
    };
  }
  if (target.kind === "source-group") {
    const group = inventory.groups.find((item) => item.id === target.groupId);
    if (group === undefined) throw targetNotFound(target);
    return {
      target,
      installations: group.installationIds.map((id) =>
        requireInstallation(inventory, id, target),
      ),
      plugin: null,
    };
  }
  const plugin = inventory.plugins.find(
    (item) => item.id === target.pluginBoundaryId,
  );
  if (plugin === undefined) throw targetNotFound(target);
  return {
    target,
    plugin,
    installations: plugin.installationIds.map((id) =>
      requireInstallation(inventory, id, target),
    ),
  };
}

function requireInstallation(
  inventory: Inventory,
  id: Installation["id"],
  target: UpdateTarget,
): Installation {
  const installation = inventory.installations.find((item) => item.id === id);
  if (installation === undefined) throw targetNotFound(target);
  return installation;
}

function targetNotFound(target: UpdateTarget): PlanningError {
  return new PlanningError(
    "target-not-found",
    `Update Target is absent from Inventory: ${targetKey(target)}`,
  );
}

function planningUnits(resolved: ResolvedUpdateTarget): Unit[] {
  if (resolved.plugin !== null)
    return [
      {
        key: `plugin:${resolved.plugin.id}`,
        installation: null,
        plugin: resolved.plugin,
        update: resolved.plugin.update,
      },
    ];
  return [...resolved.installations]
    .sort((left, right) => compare(left.id, right.id))
    .map((installation) => ({
      key: `installation:${installation.id}`,
      installation,
      plugin: null,
      update: installation.update,
    }));
}

function blocksForUnit(unit: Unit, target: UpdateTarget): UpdateBlock[] {
  const blocks: UpdateBlock[] = [];
  const installationId = unit.installation?.id ?? null;
  const add = (
    kind: UpdateBlock["kind"],
    reason: string,
    path: string | null = null,
  ): void => {
    blocks.push({
      kind,
      target,
      installationId,
      path,
      reason,
      overridable: false,
    });
  };
  if (unit.plugin?.runtimeDefault === true)
    add(
      "runtime-default-plugin",
      "runtime-default Plugins have no Update authority",
    );
  if (
    unit.installation?.ownership.kind === "plugin" &&
    target.kind !== "plugin"
  )
    add("plugin-child", "Plugin-owned child Skills are not Update Targets");
  if (
    unit.installation?.status !== undefined &&
    unit.installation.status !== "active"
  )
    add("unresolved-update", "only active Installations can be updated");
  if (unit.installation?.protection.system.kind === "system-skill")
    add("system-skill", "System lifecycle content cannot be updated");
  if (
    unit.installation?.ownership.kind === "unknown" ||
    unit.installation?.ownership.confidence === "inferred" ||
    unit.plugin?.ownership.confidence === "inferred"
  )
    add("ambiguous-owner", "Update requires one declared Owner");
  if (
    unit.installation?.harnessExposures.some(
      (exposure) => exposure.status === "unresolved",
    ) === true ||
    unit.plugin?.availability.status === "unresolved"
  )
    add(
      "unresolved-availability",
      "current availability must be resolved before Update",
    );
  if (unit.update.kind === "unsupported") {
    add("unsupported-update", unit.update.reason);
    return blocks;
  }
  if (unit.update.kind === "unresolved") {
    add("unresolved-update", unit.update.reason);
    return blocks;
  }
  const operation = unit.update.operation;
  if (operation.availability.kind === "unavailable")
    add("operation-unavailable", operation.availability.reason);
  if (operation.trust.kind === "blocked")
    add("adapter-trust", "the Update Adapter is not trusted");
  if (operation.localChanges.kind === "changed")
    add(
      "local-changes",
      "proven local changes can be overwritten",
      operation.localChanges.path,
    );
  for (const effect of operation.effects) {
    if (effect.protection.git.kind === "protected")
      add(
        "git-protection",
        "declared Update effect is Git-protected",
        effect.path,
      );
    if (effect.protection.system.kind === "system-skill")
      add(
        "system-skill",
        "declared Update effect is System content",
        effect.path,
      );
    if (effect.protection.filesystem.kind === "read-only")
      add(
        "filesystem-permission",
        effect.protection.filesystem.reason,
        effect.path,
      );
  }
  return blocks;
}

function targetBoundaryBlocks(resolved: ResolvedUpdateTarget): UpdateBlock[] {
  const blocks: UpdateBlock[] = [];
  const addProtection = (
    installationId: Installation["id"] | null,
    path: string,
    protection: Installation["protection"],
  ): void => {
    if (protection.git.kind === "protected")
      blocks.push({
        kind: "git-protection",
        target: resolved.target,
        installationId,
        path,
        reason: "the selected lifecycle artifact is Git-protected",
        overridable: false,
      });
    if (protection.system.kind === "system-skill")
      blocks.push({
        kind: "system-skill",
        target: resolved.target,
        installationId,
        path,
        reason: "the selected lifecycle artifact is System content",
        overridable: false,
      });
    if (protection.filesystem.kind === "read-only")
      blocks.push({
        kind: "filesystem-permission",
        target: resolved.target,
        installationId,
        path,
        reason: protection.filesystem.reason,
        overridable: false,
      });
  };
  resolved.installations.forEach((installation) => {
    addProtection(
      installation.id,
      installation.location.path,
      installation.protection,
    );
    if (installation.suspension.kind === "available")
      installation.suspension.artifacts.forEach((artifact) =>
        addProtection(
          installation.id,
          artifact.location.path,
          artifact.protection,
        ),
      );
    (installation.removal.supplementalArtifacts ?? []).forEach((artifact) =>
      addProtection(
        installation.id,
        artifact.location.path,
        artifact.protection,
      ),
    );
  });
  resolved.plugin?.resources.forEach((resource) => {
    if (resource.location !== null && resource.protection !== null)
      addProtection(null, resource.location.path, resource.protection);
  });
  return blocks;
}

function authorityBoundaryBlocks(
  inventory: Inventory,
  resolved: ResolvedUpdateTarget,
  units: readonly Unit[],
): UpdateBlock[] {
  const blocks: UpdateBlock[] = [];
  const selectedInstallationIds = new Set(
    resolved.installations.map((installation) => installation.id),
  );
  const selectedPluginId = resolved.plugin?.id ?? null;
  for (const unit of units) {
    if (unit.update.kind !== "managed") continue;
    const roots = unit.update.operation.effects
      .filter((effect) => effect.kind === "mutation-root")
      .map((effect) => effect.path);
    const configurationPaths = unit.update.operation.effects
      .filter((effect) => effect.kind === "configuration-path")
      .map((effect) => effect.path);
    const affected =
      unit.installation === null ? resolved.installations : [unit.installation];
    const affectedPaths = [
      ...affected.flatMap(installationArtifactPaths),
      ...(unit.plugin?.resources.flatMap((resource) =>
        resource.location === null ? [] : [resource.location.path],
      ) ?? []),
    ];
    for (const path of affectedPaths) {
      if (
        !roots.some((root) => pathContains(root, path)) &&
        !configurationPaths.some(
          (configurationPath) =>
            pathContains(configurationPath, path) &&
            pathContains(path, configurationPath),
        )
      )
        blocks.push({
          kind: "incomplete-authority",
          target: resolved.target,
          installationId: unit.installation?.id ?? null,
          path,
          reason: "declared mutation roots do not cover an affected artifact",
          overridable: false,
        });
    }
    for (const installation of inventory.installations) {
      if (selectedInstallationIds.has(installation.id)) continue;
      const path = installationArtifactPaths(installation).find((candidate) =>
        roots.some((root) => pathContains(root, candidate)),
      );
      if (path !== undefined)
        blocks.push({
          kind: "independent-boundary",
          target: resolved.target,
          installationId: installation.id,
          path,
          reason: "a mutation root contains an unselected Installation",
          overridable: false,
        });
    }
    for (const plugin of inventory.plugins) {
      if (plugin.id === selectedPluginId) continue;
      const paths = pluginBoundaryPaths(plugin, inventory);
      const path = paths.find((candidate) =>
        roots.some((root) => pathContains(root, candidate)),
      );
      if (path !== undefined)
        blocks.push({
          kind: "independent-boundary",
          target: resolved.target,
          installationId: null,
          path,
          reason: "a mutation root contains an unselected Plugin boundary",
          overridable: false,
        });
    }
  }
  return blocks;
}

function installationArtifactPaths(
  installation: Installation,
): readonly string[] {
  return [
    ...artifactLocationPaths(installation.location),
    ...(installation.suspension.kind === "available"
      ? installation.suspension.artifacts.flatMap((artifact) =>
          artifactLocationPaths(artifact.location),
        )
      : []),
    ...(installation.removal.supplementalArtifacts ?? []).flatMap((artifact) =>
      artifactLocationPaths(artifact.location),
    ),
  ].filter((path, index, paths) => paths.indexOf(path) === index);
}

function artifactLocationPaths(
  location: Installation["location"],
): readonly string[] {
  return location.canonicalPath === null
    ? [location.path]
    : [location.path, location.canonicalPath];
}

function pluginBoundaryPaths(
  plugin: PluginBoundary,
  inventory: Inventory,
): readonly string[] {
  return [
    ...plugin.resources.flatMap((resource) =>
      resource.location === null
        ? []
        : artifactLocationPaths(resource.location),
    ),
    ...plugin.installationIds.flatMap((id) => {
      const installation = inventory.installations.find(
        (candidate) => candidate.id === id,
      );
      return installation === undefined
        ? []
        : installationArtifactPaths(installation);
    }),
  ];
}

function installationBoundaryFacts(
  installation: Installation,
): UpdateInstallationBoundaryFacts {
  return {
    id: installation.id,
    location: installation.location,
    strongEvidence: installation.identity.strongEvidence as readonly [
      (typeof installation.identity.strongEvidence)[number],
      ...(typeof installation.identity.strongEvidence)[number][],
    ],
    source: installation.source,
    scope: installation.scope,
    ownership: installation.ownership,
    pluginBoundaryId: installation.pluginBoundaryId,
    lifecycle:
      installation.update.kind === "managed"
        ? lifecycleFacts(installation.update.operation)
        : null,
  };
}

function lifecycleFacts(
  operation: import("../model/types.js").ManagedUpdateEvidence,
): UpdateLifecycleFacts {
  return {
    adapterId: operation.adapterId,
    operationId: operation.operationId,
    source: operation.source,
    ref: operation.ref,
    scope: operation.scope,
    owner: operation.owner,
    externalId: operation.externalId,
  };
}

function actionForUnit(
  inventory: Inventory,
  resolved: ResolvedUpdateTarget,
  unit: Unit,
): UpdateAction {
  if (unit.update.kind !== "managed")
    throw new PlanningError(
      "invalid-intent",
      "blocked Update unit became actionable",
    );
  const operation = unit.update.operation;
  const affectedInstallationIds =
    unit.installation === null
      ? resolved.installations.map((item) => item.id)
      : [unit.installation.id];
  const actionId = stableId(
    "update-action",
    inventory.id,
    unit.key,
    operation.adapterId,
    operation.operationId,
    operation.externalId,
  );
  const approvals: ApprovalRequirement[] = [{ kind: "confirmation" }];
  if (operation.invocation.kind === "ephemeral-package")
    approvals.push({
      kind: "package-trust",
      runner: operation.invocation.packageExecution.runner,
      packageName: operation.invocation.packageExecution.packageName,
      packageVersion: operation.invocation.packageExecution.packageVersion,
      adapterHash: operation.invocation.packageExecution.adapterHash,
    });
  const expectation = availabilityExpectation(unit, resolved.installations);
  return {
    id: actionId,
    kind: "managed-update",
    target: resolved.target,
    affectedInstallationIds,
    dependsOn: [],
    approvals,
    operation,
    availabilityExpectation: expectation,
    selectedInstallations: resolved.installations.map(
      installationBoundaryFacts,
    ),
    selectedPlugin:
      resolved.plugin === null
        ? null
        : {
            id: resolved.plugin.id,
            pluginId: resolved.plugin.pluginId,
            version: resolved.plugin.version,
            resourceKeys: pluginResourceKeys(
              resolved.plugin,
              resolved.installations,
            ),
            settingsRecords: resolved.plugin.settingsRecords ?? [],
            policy: resolved.plugin.updatePolicy ?? null,
            ownership: resolved.plugin.ownership,
            lifecycle: lifecycleFacts(operation),
          },
  };
}

function pluginResourceKeys(
  plugin: PluginBoundary,
  installations: readonly Installation[],
): readonly string[] {
  return [
    ...plugin.resources.map((resource) => `${resource.kind}:${resource.id}`),
    ...installations.flatMap((installation) =>
      installation.identity.strongEvidence.flatMap((evidence) =>
        evidence.kind === "plugin" && evidence.pluginId === plugin.pluginId
          ? [`skill:${evidence.skillId}`]
          : [],
      ),
    ),
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort(compare);
}

function availabilityExpectation(
  unit: Unit,
  installations: readonly Installation[],
): UpdateAvailabilityExpectation {
  const represented =
    unit.installation === null ? installations : [unit.installation];
  return {
    harnessStatuses: represented
      .flatMap((installation) =>
        installation.harnessExposures
          .filter(
            (
              exposure,
            ): exposure is typeof exposure & {
              status: "enabled" | "disabled";
            } => exposure.status !== "unresolved",
          )
          .map((exposure) => ({
            installationId: installation.id,
            strongEvidence: installation.identity.strongEvidence as readonly [
              (typeof installation.identity.strongEvidence)[number],
              ...(typeof installation.identity.strongEvidence)[number][],
            ],
            harnessId: exposure.harnessId,
            status: exposure.status,
          })),
      )
      .sort((left, right) =>
        compare(
          `${left.installationId}\u0000${left.harnessId}`,
          `${right.installationId}\u0000${right.harnessId}`,
        ),
      ),
    pluginStatus: unit.plugin?.availability.status ?? null,
  };
}

function addDependencyOrdering(
  actions: readonly UpdateAction[],
  inventory: Inventory,
): UpdateAction[] {
  const byInstallation = new Map<string, UpdateAction>();
  for (const action of actions)
    action.affectedInstallationIds.forEach((id) =>
      byInstallation.set(id, action),
    );
  const edges = new Map(
    actions.map((action) => [action.id, new Set<string>()]),
  );
  for (const dependency of inventory.dependencies) {
    if (dependency.kind !== "hard") continue;
    const dependent = byInstallation.get(dependency.dependentInstallationId);
    for (const targetId of dependencyTargetIds(dependency, inventory)) {
      const prerequisite = byInstallation.get(targetId);
      if (
        dependent !== undefined &&
        prerequisite !== undefined &&
        dependent.id !== prerequisite.id
      )
        edges.get(dependent.id)?.add(prerequisite.id);
    }
  }
  return [...actions]
    .sort((left, right) => compare(left.id, right.id))
    .map((action) => ({
      ...action,
      dependsOn: [...(edges.get(action.id) ?? [])].sort(compare),
    }));
}

function stronglyConnected(
  ids: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  const visit = (id: string): void => {
    index.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    onStack.add(id);
    for (const dep of [...(edges.get(id) ?? [])].sort(compare)) {
      if (!index.has(dep)) {
        visit(dep);
        low.set(id, Math.min(low.get(id)!, low.get(dep)!));
      } else if (onStack.has(dep))
        low.set(id, Math.min(low.get(id)!, index.get(dep)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    result.push(component);
  };
  ids.forEach((id) => {
    if (!index.has(id)) visit(id);
  });
  return result;
}

function hasSelectedDependencyCycle(
  resolved: ResolvedUpdateTarget,
  inventory: Inventory,
): boolean {
  if (resolved.plugin !== null) return false;
  const selected = new Set(resolved.installations.map((item) => item.id));
  const edges = new Map([...selected].map((id) => [id, new Set<string>()]));
  for (const dependency of inventory.dependencies) {
    if (
      dependency.kind !== "hard" ||
      !selected.has(dependency.dependentInstallationId)
    )
      continue;
    for (const targetId of dependencyTargetIds(dependency, inventory)) {
      if (!selected.has(targetId)) continue;
      if (dependency.dependentInstallationId === targetId) return true;
      edges.get(dependency.dependentInstallationId)?.add(targetId);
    }
  }
  return stronglyConnected([...selected].sort(compare), edges).some(
    (component) => component.length > 1,
  );
}

function dependencyTargetIds(
  dependency: HardDependency,
  inventory: Inventory,
): readonly InstallationId[] {
  const target = dependency.target;
  if (target.kind === "installation") return [target.installationId];
  if (target.kind === "logical-skill")
    return (
      inventory.logicalSkills.find((item) => item.id === target.logicalSkillId)
        ?.installationIds ?? []
    );
  if (target.kind === "source-group")
    return (
      inventory.groups.find((item) => item.id === target.groupId)
        ?.installationIds ?? []
    );
  return (
    inventory.plugins.find((item) => item.id === target.pluginBoundaryId)
      ?.installationIds ?? []
  );
}

function checkForAction(
  resolved: ResolvedUpdateTarget,
  action: UpdateAction,
): UpdateVerificationCheck {
  const installation =
    resolved.plugin === null && action.affectedInstallationIds.length === 1
      ? (resolved.installations.find(
          (item) => item.id === action.affectedInstallationIds[0],
        ) ?? null)
      : null;
  return {
    id: stableId("update-check", action.id),
    actionId: action.id,
    target: resolved.target,
    installationId: installation?.id ?? null,
    pluginBoundaryId: resolved.plugin?.id ?? null,
    identity: installation?.identity ?? null,
    pluginId: resolved.plugin?.pluginId ?? null,
    source: action.operation.source,
    ref: action.operation.ref,
    scope: action.operation.scope,
    owner: action.operation.owner,
    currentRevision: action.operation.currentRevision,
    availabilityExpectation: action.availabilityExpectation,
  };
}

function warningsForAction(action: UpdateAction): UpdateWarning[] {
  const warnings: UpdateWarning[] = [];
  if (action.operation.network.kind === "required")
    warnings.push({
      kind: "network-access",
      target: action.target,
      actionId: action.id,
      reason: action.operation.network.reason,
    });
  if (action.operation.packageDownload.kind === "possible")
    warnings.push({
      kind: "package-download",
      target: action.target,
      actionId: action.id,
      packageName: action.operation.packageDownload.packageName,
      packageVersion: action.operation.packageDownload.packageVersion,
    });
  if (action.operation.localChanges.kind === "unavailable")
    warnings.push({
      kind: "local-change-unavailable",
      target: action.target,
      installationId:
        action.affectedInstallationIds.length === 1
          ? action.affectedInstallationIds[0]!
          : null,
      reason: action.operation.localChanges.reason,
    });
  return warnings;
}

function softReferenceWarnings(
  inventory: Inventory,
  resolved: ResolvedUpdateTarget,
): UpdateWarning[] {
  const selected = new Set(resolved.installations.map((item) => item.id));
  return inventory.dependencies.flatMap((dependency) =>
    dependency.kind === "soft" &&
    targetTouches(dependency.target, selected, inventory)
      ? [
          {
            kind: "soft-reference" as const,
            target: resolved.target,
            reference: dependency,
          },
        ]
      : [],
  );
}

function dependencyWarnings(
  inventory: Inventory,
  resolved: ResolvedUpdateTarget,
): UpdateWarning[] {
  const selected = new Set(resolved.installations.map((item) => item.id));
  return inventory.dependencies.flatMap((dependency) =>
    dependency.kind === "hard" &&
    (selected.has(dependency.dependentInstallationId) ||
      targetTouches(dependency.target, selected, inventory))
      ? [
          {
            kind: "hard-dependency" as const,
            target: resolved.target,
            dependency,
          },
        ]
      : [],
  );
}

function targetTouches(
  target: import("../model/types.js").RemovalTarget,
  selected: ReadonlySet<string>,
  inventory: Inventory,
): boolean {
  if (target.kind === "installation")
    return selected.has(target.installationId);
  if (target.kind === "logical-skill")
    return (
      inventory.logicalSkills
        .find((item) => item.id === target.logicalSkillId)
        ?.installationIds.some((id) => selected.has(id)) === true
    );
  if (target.kind === "source-group")
    return (
      inventory.groups
        .find((item) => item.id === target.groupId)
        ?.installationIds.some((id) => selected.has(id)) === true
    );
  return resolvedPluginIds(inventory, target.pluginBoundaryId).some((id) =>
    selected.has(id),
  );
}

function resolvedPluginIds(
  inventory: Inventory,
  id: string,
): readonly string[] {
  return (
    inventory.plugins.find((plugin) => plugin.id === id)?.installationIds ?? []
  );
}

function targetKey(target: UpdateTarget): string {
  if (target.kind === "installation")
    return `installation:${target.installationId}`;
  if (target.kind === "logical-skill")
    return `logical-skill:${target.logicalSkillId}`;
  if (target.kind === "source-group") return `source-group:${target.groupId}`;
  return `plugin:${target.pluginBoundaryId}`;
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  parts.forEach((part) => hash.update(`${Buffer.byteLength(part)}:${part}`));
  return `${prefix}-${hash.digest("hex").slice(0, 24)}`;
}

function sortUnique<T>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [stringifyModel(item, 0), item]))]
    .sort(([left], [right]) => compare(left, right))
    .map(([, item]) => item);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathContains(parent: string, child: string): boolean {
  const windows = win32.isAbsolute(parent);
  if (windows !== win32.isAbsolute(child)) return false;
  const paths = windows ? win32 : posix;
  const normalize = (value: string): string => {
    const result = paths.normalize(value);
    return windows ? result.toLowerCase() : result;
  };
  const relative = paths.relative(normalize(parent), normalize(child));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative))
  );
}
