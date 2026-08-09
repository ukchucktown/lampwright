import { createHash } from "node:crypto";

import { stringifyModel } from "../model/json.js";
import { artifactPathKey, physicalPathKey } from "../model/paths.js";
import type {
  ApprovalRequirement,
  HardDependency,
  HarnessExposure,
  Installation,
  InstallationId,
  Inventory,
  NativeControlDocumentEvidence,
  RemovalTarget,
  SkillIdentity,
} from "../model/types.js";
import { parseInventory } from "../model/validation.js";
import { parseDisabledEntry } from "../disabled-storage/schema.js";
import type { DisabledEntry } from "../disabled-storage/types.js";
import type {
  AvailabilityAction,
  AvailabilityBlock,
  AvailabilityIntent,
  AvailabilityPlan,
  AvailabilityTarget,
  AvailabilityVerificationCheck,
  NativeConfigurationMutation,
} from "../availability/types.js";
import {
  parseAvailabilityIntent,
  parseAvailabilityPlan,
} from "../availability/validation.js";
import { PlanningError } from "./types.js";

interface ResolvedAvailabilityTarget {
  readonly target: AvailabilityTarget;
  readonly installations: readonly Installation[];
  readonly installationIds: readonly InstallationId[];
}
type NativeExposure = HarnessExposure & {
  readonly control: Extract<HarnessExposure["control"], { kind: "native" }>;
};

export function planAvailability(
  inventoryInput: Inventory,
  disabledEntryInputs: readonly DisabledEntry[],
  intentInput: AvailabilityIntent,
): AvailabilityPlan {
  const inventory = parseInventory(inventoryInput);
  const entries = disabledEntryInputs.map(parseDisabledEntry);
  const intent = parseAvailabilityIntent(intentInput);
  const resolved = normalizeTargets(
    intent.targets.map((target) => resolveTarget(inventory, entries, target)),
  );
  const targets = resolved.map((item) => item.target);
  const normalizedIntent = { ...intent, targets };
  const planId = stableId(
    "availability-plan",
    inventory.id,
    stringifyModel(normalizedIntent, 0),
    stringifyModel(entries.map((entry) => entry.id).sort(compare), 0),
  );
  const selectedIds = new Set(resolved.flatMap((item) => item.installationIds));
  const blocks: AvailabilityBlock[] = [];
  const actions: AvailabilityAction[] = [];

  for (const item of resolved) {
    const itemBlocks = targetBlocks(
      inventory,
      entries,
      item,
      normalizedIntent,
      selectedIds,
    );
    blocks.push(...itemBlocks);
    if (itemBlocks.some((block) => !block.overridable || !intent.force))
      continue;
    const approvals = approvalsFor(itemBlocks, intent.force);
    if (intent.operation === "disable")
      actions.push(...disableActions(item, planId, approvals));
    else actions.push(...enableActions(item, entries, approvals));
  }

  const orderedActions = applyDependencyOrdering(
    groupNativeActions(actions),
    inventory,
    intent.operation,
  );
  const verificationChecks = createChecks(
    resolved,
    orderedActions,
    intent.operation,
  );
  const warnings = inventory.dependencies
    .filter((dependency) => dependency.kind === "soft")
    .flatMap((reference) =>
      resolved
        .filter((item) =>
          removalTargetTouches(
            reference.target,
            item.installationIds,
            inventory,
          ),
        )
        .map((item) => ({
          kind: "soft-reference" as const,
          target: item.target,
          reference,
        })),
    )
    .sort((left, right) =>
      compare(stringifyModel(left, 0), stringifyModel(right, 0)),
    );

  return parseAvailabilityPlan({
    schemaVersion: 1,
    id: planId,
    inventoryId: inventory.id,
    createdAt: inventory.scannedAt,
    intent: normalizedIntent,
    targets,
    disabledEntryIds: entries.map((entry) => entry.id).sort(compare),
    actions: orderedActions,
    blocks: deduplicate(blocks),
    warnings,
    verificationChecks,
  });
}

function normalizeTargets(
  resolved: readonly ResolvedAvailabilityTarget[],
): ResolvedAvailabilityTarget[] {
  const unique = [
    ...new Map(resolved.map((item) => [targetKey(item.target), item])).values(),
  ].sort(
    (left, right) =>
      right.installationIds.length - left.installationIds.length ||
      targetBreadth(right.target) - targetBreadth(left.target) ||
      compare(targetKey(left.target), targetKey(right.target)),
  );
  const result: ResolvedAvailabilityTarget[] = [];
  for (const candidate of unique) {
    const candidateIds = new Set(candidate.installationIds);
    const covering = result.find((existing) =>
      candidate.installationIds.every((id) =>
        existing.installationIds.includes(id),
      ),
    );
    if (covering !== undefined) continue;
    const partial = result.find((existing) =>
      existing.installationIds.some((id) => candidateIds.has(id)),
    );
    if (partial !== undefined)
      throw new PlanningError(
        "overlapping-targets",
        `Availability Targets overlap without containment: ${targetKey(partial.target)} and ${targetKey(candidate.target)}`,
      );
    result.push(candidate);
  }
  return result.sort((left, right) =>
    compare(targetKey(left.target), targetKey(right.target)),
  );
}

function targetBreadth(target: AvailabilityTarget): number {
  return target.kind === "source-group"
    ? 2
    : target.kind === "logical-skill"
      ? 1
      : 0;
}

function resolveTarget(
  inventory: Inventory,
  entries: readonly DisabledEntry[],
  target: AvailabilityTarget,
): ResolvedAvailabilityTarget {
  if (target.kind === "installation") {
    const installation = inventory.installations.find(
      (candidate) => candidate.id === target.installationId,
    );
    const inStorage = entries.some((entry) =>
      entry.installationIds.includes(target.installationId),
    );
    if (installation === undefined && !inStorage)
      throw new PlanningError(
        "target-not-found",
        `Installation not found: ${target.installationId}`,
      );
    return {
      target,
      installations: installation === undefined ? [] : [installation],
      installationIds: [target.installationId],
    };
  }
  if (target.kind === "logical-skill") {
    const logical = inventory.logicalSkills.find(
      (candidate) => candidate.id === target.logicalSkillId,
    );
    if (logical === undefined)
      throw new PlanningError(
        "target-not-found",
        `Logical Skill not found: ${target.logicalSkillId}`,
      );
    return {
      target,
      installations: inventory.installations.filter((installation) =>
        logical.installationIds.includes(installation.id),
      ),
      installationIds: [...logical.installationIds],
    };
  }
  const group = inventory.groups.find(
    (candidate) => candidate.id === target.groupId,
  );
  if (group === undefined)
    throw new PlanningError(
      "target-not-found",
      `Installation Group not found: ${target.groupId}`,
    );
  return {
    target,
    installations: inventory.installations.filter((installation) =>
      group.installationIds.includes(installation.id),
    ),
    installationIds: [...group.installationIds],
  };
}

function targetBlocks(
  inventory: Inventory,
  entries: readonly DisabledEntry[],
  resolved: ResolvedAvailabilityTarget,
  intent: AvailabilityIntent,
  selectedIds: ReadonlySet<InstallationId>,
): AvailabilityBlock[] {
  const blocks: AvailabilityBlock[] = [];
  const selectedEntries = entries.filter((entry) =>
    entry.installationIds.some((id) => resolved.installationIds.includes(id)),
  );
  for (const installation of resolved.installations) {
    if (installation.protection.system.kind === "system-skill")
      blocks.push(
        absoluteBlock(
          "system-skill",
          resolved.target,
          "System Skills cannot be disabled or enabled",
          installation.location.path,
        ),
      );
    if (installation.ownership.kind === "plugin")
      blocks.push(
        absoluteBlock(
          "ownership",
          resolved.target,
          "Plugin-owned Skills cannot be individually disabled",
          installation.location.path,
        ),
      );
    if (installation.ownership.kind === "agent-runtime")
      blocks.push(
        absoluteBlock(
          "ownership",
          resolved.target,
          "runtime-owned Skills cannot be disabled",
          installation.location.path,
        ),
      );
    if (
      installation.harnessExposures.some(
        (exposure) => exposure.status === "unresolved",
      )
    )
      blocks.push(
        absoluteBlock(
          "unresolved-exposure",
          resolved.target,
          "a Harness Exposure has unresolved runtime state",
          installation.location.path,
        ),
      );

    if (
      intent.operation === "disable" &&
      entries.some(
        (entry) =>
          entry.installationIds.includes(installation.id) ||
          sameArtifactPath(entry.originalLocation, installation.location),
      )
    )
      blocks.push(
        absoluteBlock(
          "configuration-unsafe",
          resolved.target,
          "a matching Disabled Storage entry already exists",
          installation.location.path,
        ),
      );

    if (intent.operation === "disable") {
      const needsChange = installation.harnessExposures.some(
        (exposure) => exposure.status !== "disabled",
      );
      const unsupported = installation.harnessExposures.some(
        (exposure) => exposure.control.kind === "unsupported",
      );
      if (needsChange && unsupported)
        blocks.push(...suspensionBlocks(resolved.target, installation));
      else
        blocks.push(
          ...nativeBlocks(inventory, resolved.target, installation, "disable"),
        );
    } else {
      blocks.push(
        ...nativeBlocks(inventory, resolved.target, installation, "enable"),
      );
    }
  }
  if (intent.operation === "enable") {
    const hasLive = resolved.installations.some((installation) =>
      installation.harnessExposures.some(
        (exposure) => exposure.status === "disabled",
      ),
    );
    const hasStored = entries.some((entry) =>
      entry.installationIds.some((id) => resolved.installationIds.includes(id)),
    );
    if (!hasLive && !hasStored && resolved.installations.length === 0)
      blocks.push(
        absoluteBlock(
          "entry-not-found",
          resolved.target,
          "no disabled Installation or Disabled Storage entry was found",
          null,
        ),
      );
    for (const entry of entries) {
      if (
        entry.installationIds.some((id) =>
          resolved.installationIds.includes(id),
        ) &&
        !entry.installationIds.every((id) => selectedIds.has(id))
      )
        blocks.push(
          absoluteBlock(
            "configuration-unsafe",
            resolved.target,
            "a Disabled Storage entry cannot be partially enabled",
            entry.originalLocation.path,
          ),
        );
    }
    for (const entry of selectedEntries) {
      const key = physicalPathKey(entry.originalLocation);
      if (
        inventory.installations.some((installation) =>
          sameArtifactPath(entry.originalLocation, installation.location),
        )
      )
        blocks.push(
          absoluteBlock(
            "configuration-unsafe",
            resolved.target,
            "a live Installation occupies the Disabled entry's original path",
            entry.originalLocation.path,
          ),
        );
      if (
        entries.some(
          (other) =>
            other.id !== entry.id &&
            (physicalPathKey(other.originalLocation) === key ||
              artifactPathKey(other.originalLocation) ===
                artifactPathKey(entry.originalLocation)),
        )
      )
        blocks.push(
          absoluteBlock(
            "configuration-unsafe",
            resolved.target,
            "another Disabled Storage entry claims the same original path",
            entry.originalLocation.path,
          ),
        );
    }
  }
  for (const dependency of inventory.dependencies) {
    if (dependency.kind !== "hard") continue;
    if (
      !removalTargetTouches(
        dependency.target,
        resolved.installationIds,
        inventory,
      )
    )
      continue;
    if (!selectedIds.has(dependency.dependentInstallationId))
      blocks.push({
        kind: "hard-dependency",
        target: resolved.target,
        dependency,
        overridable: true,
      });
  }
  const cyclicIds = cyclicInstallationIds(inventory, selectedIds);
  if (resolved.installationIds.some((id) => cyclicIds.has(id))) {
    const dependency = inventory.dependencies.find(
      (candidate): candidate is HardDependency =>
        candidate.kind === "hard" &&
        cyclicIds.has(candidate.dependentInstallationId) &&
        removalTargetIds(candidate.target, inventory).some((id) =>
          cyclicIds.has(id),
        ) &&
        (resolved.installationIds.includes(candidate.dependentInstallationId) ||
          removalTargetIds(candidate.target, inventory).some((id) =>
            resolved.installationIds.includes(id),
          )),
    );
    if (dependency !== undefined)
      blocks.push({
        kind: "hard-dependency",
        target: resolved.target,
        dependency,
        overridable: true,
      });
  }
  return deduplicate(blocks);
}

function suspensionBlocks(
  target: AvailabilityTarget,
  installation: Installation,
): AvailabilityBlock[] {
  const blocks: AvailabilityBlock[] = [];
  if (installation.ownership.kind !== "filesystem")
    blocks.push(
      absoluteBlock(
        "ownership",
        target,
        "unsupported native control may fall back only for independently filesystem-owned Skills",
        installation.location.path,
      ),
    );
  if (installation.protection.git.kind === "protected")
    blocks.push(
      absoluteBlock(
        "git-protection",
        target,
        "Git-protected Skills cannot be suspended",
        installation.location.path,
      ),
    );
  if (installation.protection.filesystem.kind === "read-only")
    blocks.push(
      absoluteBlock(
        "filesystem-permission",
        target,
        installation.protection.filesystem.reason,
        installation.location.path,
      ),
    );
  if (installation.status !== "active")
    blocks.push(
      absoluteBlock(
        "configuration-unsafe",
        target,
        "only a complete active Installation can be suspended",
        installation.location.path,
      ),
    );
  return blocks;
}

function nativeBlocks(
  inventory: Inventory,
  target: AvailabilityTarget,
  installation: Installation,
  operation: "disable" | "enable",
): AvailabilityBlock[] {
  const blocks: AvailabilityBlock[] = [];
  for (const exposure of installation.harnessExposures) {
    if (exposure.status === (operation === "disable" ? "disabled" : "enabled"))
      continue;
    if (exposure.control.kind !== "native") {
      if (operation === "enable")
        blocks.push(
          absoluteBlock(
            "unsupported-control",
            target,
            exposure.control.reason,
            installation.location.path,
          ),
        );
      continue;
    }
    const availability = exposure.control.availability[operation];
    if (availability.kind === "unavailable")
      blocks.push(
        absoluteBlock(
          "configuration-unsafe",
          target,
          availability.reason,
          configurationPath(exposure),
        ),
      );
    if (
      exposure.control.selector.kind === "name" &&
      nameCollision(inventory, installation, exposure)
    )
      blocks.push(
        absoluteBlock(
          "name-collision",
          target,
          `the ${exposure.harnessId} name selector could affect another Skill Identity`,
          configurationPath(exposure),
        ),
      );
  }
  return blocks;
}

function disableActions(
  resolved: ResolvedAvailabilityTarget,
  planId: string,
  approvals: readonly ApprovalRequirement[],
): AvailabilityAction[] {
  const actions: AvailabilityAction[] = [];
  for (const installation of resolved.installations) {
    const exposures = installation.harnessExposures;
    if (exposures.every((exposure) => exposure.status === "disabled")) continue;
    const needsSuspension = exposures.some(
      (exposure) => exposure.control.kind === "unsupported",
    );
    if (needsSuspension) {
      actions.push({
        id: stableId("availability-action", planId, installation.id, "suspend"),
        kind: "suspended-disable",
        targets: [resolved.target],
        installationId: installation.id,
        affectedInstallationIds: [installation.id],
        dependsOn: [],
        approvals,
        request: {
          location: installation.location,
          skillIdentity: installation.identity,
          installationIds: [installation.id],
          ownership: installation.ownership,
          harnessExposures: installation.harnessExposures,
          operation: { id: planId, displayNames: [installation.skill.name] },
        },
      });
      continue;
    }
    for (const exposure of exposures) {
      if (exposure.status === "disabled" || !isNativeExposure(exposure))
        continue;
      const mutations = nativeMutations(
        exposure,
        "disable",
        installation.skill.name,
      );
      if (mutations.length === 0) continue;
      actions.push(
        ...nativeActions(
          resolved.target,
          installation,
          exposure,
          "disable",
          mutations,
          approvals,
        ),
      );
    }
  }
  return actions;
}

function enableActions(
  resolved: ResolvedAvailabilityTarget,
  entries: readonly DisabledEntry[],
  approvals: readonly ApprovalRequirement[],
): AvailabilityAction[] {
  const actions: AvailabilityAction[] = [];
  for (const entry of entries) {
    const ids = entry.installationIds.filter((id) =>
      resolved.installationIds.includes(id),
    );
    if (ids.length === 0) continue;
    actions.push({
      id: stableId("availability-action", entry.id, "enable"),
      kind: "suspended-enable",
      targets: [resolved.target],
      affectedInstallationIds: ids,
      dependsOn: [],
      approvals,
      entry,
    });
  }
  for (const installation of resolved.installations) {
    for (const exposure of installation.harnessExposures) {
      if (exposure.status !== "disabled" || !isNativeExposure(exposure))
        continue;
      const mutations = nativeMutations(
        exposure,
        "enable",
        installation.skill.name,
      );
      if (mutations.length === 0) continue;
      actions.push(
        ...nativeActions(
          resolved.target,
          installation,
          exposure,
          "enable",
          mutations,
          approvals,
        ),
      );
    }
  }
  return actions;
}

function nativeActions(
  target: AvailabilityTarget,
  installation: Installation,
  exposure: NativeExposure,
  operation: "disable" | "enable",
  mutations: readonly NativeConfigurationMutation[],
  approvals: readonly ApprovalRequirement[],
): AvailabilityAction[] {
  return mutations.map((mutation) => ({
    id: stableId(
      "availability-action",
      installation.id,
      exposure.harnessId,
      operation,
      mutation.path,
    ),
    kind: "native-control" as const,
    targets: [target],
    affectedInstallationIds: [installation.id],
    effects: [
      {
        installationId: installation.id,
        harnessId: exposure.harnessId,
        operation,
      },
    ],
    mutations: [mutation],
    dependsOn: [],
    approvals,
  }));
}

function nativeMutations(
  exposure: NativeExposure,
  operation: "disable" | "enable",
  skillName: string,
): NativeConfigurationMutation[] {
  const control = exposure.control;
  let layers: readonly NativeControlDocumentEvidence[] = [];
  if (control.mechanism === "codex-skills-config") {
    layers = control.layers
      .filter((layer) => control.writableLayerPaths.includes(layer.path))
      .slice(0, 1);
  } else if (control.mechanism === "claude-skill-overrides") {
    layers = control.layers
      .filter(
        (layer) =>
          control.writableLayerPaths.includes(layer.path) && writable(layer),
      )
      .sort(
        (left, right) =>
          precedence(right.documentScope) - precedence(left.documentScope),
      )
      .slice(0, 1);
  } else if (operation === "disable") {
    layers = control.layers
      .filter((layer) => layer.applies === true && writable(layer))
      .slice(0, 1);
  } else {
    layers = control.layers.filter(
      (layer) =>
        layer.applies === true &&
        layer.selectorValue?.kind === "gemini-disabled-skills" &&
        layer.selectorValue.disabled,
    );
  }
  return layers.map((layer) => ({
    path: layer.path,
    format: layer.format,
    documentScope: layer.documentScope,
    exists: layer.exists,
    expectedPreimageHash: layer.preimageHash,
    protection: layer.protection,
    operation:
      control.mechanism === "codex-skills-config"
        ? {
            kind: control.mechanism,
            selectorPath: control.selector.value,
            enabled: operation === "enable",
          }
        : control.mechanism === "claude-skill-overrides"
          ? {
              kind: control.mechanism,
              skillName,
              mode: operation === "disable" ? "off" : "on",
            }
          : {
              kind: control.mechanism,
              skillName,
              disabled: operation === "disable",
            },
  }));
}

function groupNativeActions(
  actions: readonly AvailabilityAction[],
): AvailabilityAction[] {
  const grouped = new Map<
    string,
    Extract<AvailabilityAction, { kind: "native-control" }>[]
  >();
  const result: AvailabilityAction[] = actions.filter(
    (action) =>
      action.kind !== "native-control" && action.kind !== "suspended-enable",
  );
  for (const action of actions) {
    if (action.kind !== "native-control") continue;
    const path = action.mutations[0]!.path;
    grouped.set(path, [...(grouped.get(path) ?? []), action]);
  }
  for (const [path, members] of grouped) {
    const first = members[0]!;
    const evidence = ({ operation, ...value }: NativeConfigurationMutation) => {
      void operation;
      return value;
    };
    if (
      members.some(
        (member) =>
          stringifyModel(evidence(member.mutations[0]!), 0) !==
          stringifyModel(evidence(first.mutations[0]!), 0),
      )
    )
      throw new PlanningError(
        "invalid-intent",
        `Inventory contains inconsistent native configuration evidence: ${path}`,
      );
    const effects = members
      .flatMap((member) => member.effects)
      .sort((left, right) =>
        compare(stringifyModel(left, 0), stringifyModel(right, 0)),
      );
    const mutations = members
      .flatMap((member) => member.mutations)
      .sort((left, right) =>
        compare(
          stringifyModel(left.operation, 0),
          stringifyModel(right.operation, 0),
        ),
      );
    const targets = deduplicate(members.flatMap((member) => member.targets));
    const affectedInstallationIds = [
      ...new Set(effects.map((effect) => effect.installationId)),
    ].sort(compare);
    const approvals = deduplicate(
      members.flatMap((member) => member.approvals),
    );
    result.push({
      id: stableId(
        "availability-action",
        path,
        stringifyModel(effects, 0),
        stringifyModel(mutations, 0),
      ),
      kind: "native-control",
      targets: targets as [AvailabilityTarget, ...AvailabilityTarget[]],
      affectedInstallationIds,
      effects: effects as unknown as typeof first.effects,
      mutations: mutations as unknown as typeof first.mutations,
      dependsOn: [],
      approvals,
    });
  }
  const enables = new Map<
    string,
    Extract<AvailabilityAction, { kind: "suspended-enable" }>[]
  >();
  for (const action of actions) {
    if (action.kind !== "suspended-enable") continue;
    enables.set(action.entry.id, [
      ...(enables.get(action.entry.id) ?? []),
      action,
    ]);
  }
  for (const members of enables.values()) {
    const first = members[0]!;
    if (
      members.some(
        (member) =>
          stringifyModel(member.entry, 0) !== stringifyModel(first.entry, 0),
      )
    )
      throw new PlanningError(
        "invalid-intent",
        `Inventory contains inconsistent Disabled Storage evidence: ${first.entry.id}`,
      );
    result.push({
      ...first,
      targets: deduplicate(members.flatMap((member) => member.targets)) as [
        AvailabilityTarget,
        ...AvailabilityTarget[],
      ],
      affectedInstallationIds: [
        ...new Set(members.flatMap((member) => member.affectedInstallationIds)),
      ].sort(compare),
      approvals: deduplicate(members.flatMap((member) => member.approvals)),
    });
  }
  return result;
}

function applyDependencyOrdering(
  actions: readonly AvailabilityAction[],
  inventory: Inventory,
  operation: "disable" | "enable",
): AvailabilityAction[] {
  const byInstallation = new Map<InstallationId, string[]>();
  for (const action of actions)
    for (const id of action.affectedInstallationIds)
      byInstallation.set(id, [...(byInstallation.get(id) ?? []), action.id]);
  const ordered = [...actions]
    .map((action) => {
      const dependencies = new Set(action.dependsOn);
      for (const dependency of inventory.dependencies) {
        if (dependency.kind !== "hard") continue;
        const prerequisiteIds = removalTargetIds(dependency.target, inventory);
        if (
          operation === "disable" &&
          action.affectedInstallationIds.some((id) =>
            prerequisiteIds.includes(id),
          )
        )
          for (const id of byInstallation.get(
            dependency.dependentInstallationId,
          ) ?? [])
            dependencies.add(id);
        if (
          operation === "enable" &&
          action.affectedInstallationIds.includes(
            dependency.dependentInstallationId,
          )
        )
          for (const prerequisiteId of prerequisiteIds)
            for (const id of byInstallation.get(prerequisiteId) ?? [])
              dependencies.add(id);
      }
      dependencies.delete(action.id);
      return { ...action, dependsOn: [...dependencies].sort(compare) };
    })
    .sort((left, right) => compare(left.id, right.id));
  const actionIds = new Set(ordered.map((action) => action.id));
  const components = stronglyConnectedComponents(
    [...actionIds],
    new Map(
      ordered.map((action) => [
        action.id,
        new Set(action.dependsOn.filter((id) => actionIds.has(id))),
      ]),
    ),
  );
  const cyclicPredecessor = new Map<string, string | null>();
  for (const component of components.filter(
    (members) =>
      members.length > 1 ||
      ordered
        .find((action) => action.id === members[0])
        ?.dependsOn.includes(members[0]!) === true,
  ))
    component.forEach((id, index) =>
      cyclicPredecessor.set(id, index === 0 ? null : component[index - 1]!),
    );
  return ordered.map((action) => {
    if (!cyclicPredecessor.has(action.id)) return action;
    const component = new Set(
      components.find((members) => members.includes(action.id))!,
    );
    const external = action.dependsOn.filter((id) => !component.has(id));
    const predecessor = cyclicPredecessor.get(action.id) ?? null;
    return {
      ...action,
      dependsOn: [
        ...external,
        ...(predecessor === null ? [] : [predecessor]),
      ].sort(compare),
    };
  });
}

function cyclicInstallationIds(
  inventory: Inventory,
  selectedIds: ReadonlySet<InstallationId>,
): ReadonlySet<InstallationId> {
  const prerequisites = new Map(
    [...selectedIds].map((id) => [id, new Set<InstallationId>()]),
  );
  for (const dependency of inventory.dependencies) {
    if (
      dependency.kind !== "hard" ||
      !selectedIds.has(dependency.dependentInstallationId)
    )
      continue;
    for (const required of removalTargetIds(dependency.target, inventory))
      if (selectedIds.has(required))
        prerequisites.get(dependency.dependentInstallationId)!.add(required);
  }
  const cyclic = new Set<InstallationId>();
  for (const component of stronglyConnectedComponents(
    [...selectedIds],
    prerequisites,
  )) {
    if (
      component.length > 1 ||
      prerequisites.get(component[0]!)?.has(component[0]!)
    )
      component.forEach((id) => cyclic.add(id));
  }
  return cyclic;
}

function stronglyConnectedComponents<Value extends string>(
  values: readonly Value[],
  edges: ReadonlyMap<Value, ReadonlySet<Value>>,
): Value[][] {
  let nextIndex = 0;
  const indexes = new Map<Value, number>();
  const lowLinks = new Map<Value, number>();
  const stack: Value[] = [];
  const onStack = new Set<Value>();
  const result: Value[][] = [];
  const visit = (value: Value): void => {
    indexes.set(value, nextIndex);
    lowLinks.set(value, nextIndex);
    nextIndex += 1;
    stack.push(value);
    onStack.add(value);
    for (const edge of [...(edges.get(value) ?? [])].sort(compare)) {
      if (!indexes.has(edge)) {
        visit(edge);
        lowLinks.set(
          value,
          Math.min(lowLinks.get(value)!, lowLinks.get(edge)!),
        );
      } else if (onStack.has(edge)) {
        lowLinks.set(value, Math.min(lowLinks.get(value)!, indexes.get(edge)!));
      }
    }
    if (lowLinks.get(value) !== indexes.get(value)) return;
    const component: Value[] = [];
    let member: Value | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== value);
    result.push(component.sort(compare));
  };
  for (const value of [...values].sort(compare))
    if (!indexes.has(value)) visit(value);
  return result;
}

function createChecks(
  resolved: readonly ResolvedAvailabilityTarget[],
  actions: readonly AvailabilityAction[],
  operation: "disable" | "enable",
): AvailabilityVerificationCheck[] {
  const checks: AvailabilityVerificationCheck[] = [];
  for (const item of resolved) {
    for (const installation of item.installations) {
      for (const exposure of installation.harnessExposures) {
        const action = actions.find(
          (candidate) =>
            candidate.affectedInstallationIds.includes(installation.id) &&
            (candidate.kind !== "native-control" ||
              candidate.effects.some(
                (effect) =>
                  effect.installationId === installation.id &&
                  effect.harnessId === exposure.harnessId,
              )),
        );
        checks.push({
          id: stableId(
            "availability-check",
            targetKey(item.target),
            installation.id,
            exposure.harnessId,
            operation,
          ),
          kind: "harness-exposure-state",
          target: item.target,
          actionId: action?.id ?? null,
          installationId: installation.id,
          harnessId: exposure.harnessId,
          expectedStatus: operation === "disable" ? "disabled" : "enabled",
        });
      }
    }
    for (const action of actions.filter((candidate) =>
      candidate.targets.some(
        (target) => targetKey(target) === targetKey(item.target),
      ),
    )) {
      if (action.kind === "suspended-disable")
        checks.push({
          id: stableId("availability-check", action.id, "entry-present"),
          kind: "disabled-entry-state",
          target: item.target,
          actionId: action.id,
          entryId: null,
          installationId: action.installationId,
          expectedPresent: true,
        });
      if (action.kind === "suspended-enable") {
        checks.push({
          id: stableId("availability-check", action.id, "entry-absent"),
          kind: "disabled-entry-state",
          target: item.target,
          actionId: action.id,
          entryId: action.entry.id,
          installationId: action.affectedInstallationIds[0]!,
          expectedPresent: false,
        });
        for (const installationId of action.affectedInstallationIds)
          for (const exposure of action.entry.harnessExposures)
            checks.push({
              id: stableId(
                "availability-check",
                action.id,
                installationId,
                exposure.harnessId,
                "enabled",
              ),
              kind: "harness-exposure-state",
              target: item.target,
              actionId: action.id,
              installationId,
              harnessId: exposure.harnessId,
              expectedStatus: "enabled",
            });
      }
    }
  }
  return checks.sort((left, right) => compare(left.id, right.id));
}

function approvalsFor(
  blocks: readonly AvailabilityBlock[],
  force: boolean,
): ApprovalRequirement[] {
  const approvals: ApprovalRequirement[] = [{ kind: "confirmation" }];
  if (force && blocks.some((block) => block.kind === "hard-dependency"))
    approvals.push({ kind: "force-override", safeguards: ["dependency"] });
  return approvals;
}

function nameCollision(
  inventory: Inventory,
  own: Installation,
  exposure: HarnessExposure,
): boolean {
  if (
    exposure.control.kind !== "native" ||
    exposure.control.selector.kind !== "name"
  )
    return false;
  const selectorValue = exposure.control.selector.value;
  return (
    inventory.installations.some(
      (candidate) =>
        candidate.id !== own.id &&
        candidate.harnessExposures.some(
          (other) => other.harnessId === exposure.harnessId,
        ) &&
        candidate.skill.name === selectorValue &&
        !sameIdentity(own.identity, candidate.identity),
    ) ||
    inventory.otherFindings.some(
      (finding) =>
        finding.classification === "system-skill" &&
        finding.agentId === exposure.harnessId &&
        finding.skill.name === selectorValue &&
        !sameIdentity(own.identity, finding.identity),
    )
  );
}

function isNativeExposure(
  exposure: HarnessExposure,
): exposure is NativeExposure {
  return exposure.control.kind === "native";
}

function sameIdentity(left: SkillIdentity, right: SkillIdentity): boolean {
  const rightEvidence = new Set(
    right.strongEvidence.map((evidence) => stringifyModel(evidence, 0)),
  );
  return left.strongEvidence.some((evidence) =>
    rightEvidence.has(stringifyModel(evidence, 0)),
  );
}

function configurationPath(exposure: HarnessExposure): string | null {
  return exposure.control.kind === "native"
    ? (exposure.control.layers[0]?.path ?? null)
    : null;
}
function writable(layer: NativeControlDocumentEvidence): boolean {
  return (
    layer.protection.git.kind !== "protected" &&
    layer.protection.filesystem.kind === "writable"
  );
}
function precedence(
  scope: NativeControlDocumentEvidence["documentScope"],
): number {
  return scope === "local-workspace"
    ? 3
    : scope === "shared-workspace" || scope === "workspace"
      ? 2
      : 1;
}
function absoluteBlock(
  kind: Exclude<AvailabilityBlock["kind"], "hard-dependency">,
  target: AvailabilityTarget,
  reason: string,
  path: string | null,
): AvailabilityBlock {
  return {
    kind,
    target,
    reason,
    path,
    overridable: false,
  } as AvailabilityBlock;
}
function sameArtifactPath(
  left: Installation["location"],
  right: Installation["location"],
): boolean {
  return (
    artifactPathKey(left) === artifactPathKey(right) ||
    physicalPathKey(left) === physicalPathKey(right)
  );
}
function removalTargetTouches(
  target: RemovalTarget,
  ids: readonly InstallationId[],
  inventory: Inventory,
): boolean {
  return removalTargetIds(target, inventory).some((id) => ids.includes(id));
}
function removalTargetIds(
  target: RemovalTarget,
  inventory: Inventory,
): InstallationId[] {
  if (target.kind === "installation") return [target.installationId];
  if (target.kind === "logical-skill")
    return [
      ...(inventory.logicalSkills.find(
        (item) => item.id === target.logicalSkillId,
      )?.installationIds ?? []),
    ];
  if (target.kind === "source-group")
    return [
      ...(inventory.groups.find((item) => item.id === target.groupId)
        ?.installationIds ?? []),
    ];
  return inventory.installations
    .filter(
      (installation) =>
        installation.pluginBoundaryId === target.pluginBoundaryId,
    )
    .map((installation) => installation.id);
}
function targetKey(target: AvailabilityTarget): string {
  return target.kind === "installation"
    ? `installation:${target.installationId}`
    : target.kind === "logical-skill"
      ? `logical-skill:${target.logicalSkillId}`
      : `source-group:${target.groupId}`;
}
function stableId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:${part}`);
  return `${prefix}-${hash.digest("hex").slice(0, 24)}`;
}
function deduplicate<T>(values: readonly T[]): T[] {
  return [
    ...new Map(
      values.map((value) => [stringifyModel(value, 0), value]),
    ).entries(),
  ]
    .sort(([left], [right]) => compare(left, right))
    .map(([, value]) => value);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
