import { createHash } from "node:crypto";

import { z } from "zod";

import { stringifyModel } from "../model/json.js";
import {
  artifactPathKey,
  locationContains,
  physicalPathKey,
  quarantineLocationContains,
} from "../model/paths.js";
import { removalTargetSchema } from "../model/schemas.js";
import type {
  ApprovalRequirement,
  DeclarativeRecordCleanup,
  FallbackAvailability,
  HardDependency,
  Installation,
  InstallationId,
  Inventory,
  ManagedOwnership,
  PlanBlock,
  PlanWarning,
  PluginBoundary,
  RemovalAction,
  RemovalActionId,
  RemovalEvidence,
  RemovalPlan,
  RemovalPlanIntent,
  RemovalPlanId,
  RemovalTarget,
  RecordCleanupAction,
  SoftReference,
  VerificationCheck,
  VerificationCheckId,
} from "../model/types.js";
import { parseInventory, parseRemovalPlan } from "../model/validation.js";
import { PlanningError, type RemovalIntent } from "./types.js";

const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("targets"),
    targets: z.array(removalTargetSchema).min(1),
    force: z.boolean(),
    mode: z.enum(["managed-first", "brute-force"]),
  }),
  z.strictObject({
    kind: z.literal("all"),
    includePlugins: z.boolean(),
    force: z.boolean(),
    mode: z.enum(["managed-first", "brute-force"]),
  }),
]);

interface ResolvedTarget {
  readonly target: RemovalTarget;
  readonly installations: readonly Installation[];
  readonly plugin: PluginBoundary | null;
}

interface TargetState {
  readonly resolved: ResolvedTarget;
  readonly blocks: PlanBlock[];
  readonly safeguards: Set<"ambiguity" | "dependency">;
}

interface PlanningUnit {
  readonly key: string;
  readonly state: TargetState;
  readonly installations: readonly Installation[];
  readonly ownership: ManagedOwnership | Installation["ownership"];
  readonly removal: RemovalEvidence;
}

type PlannedMethod = "managed" | "brute-force";

interface DependencyGraph {
  readonly prerequisites: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dependencyByEdge: ReadonlyMap<string, HardDependency>;
  readonly components: readonly DependencyComponent[];
  readonly componentById: ReadonlyMap<string, DependencyComponent>;
  readonly componentByUnitKey: ReadonlyMap<string, DependencyComponent>;
  readonly cyclePredecessorByUnitKey: ReadonlyMap<string, string>;
}

interface DependencyComponent {
  readonly id: string;
  readonly unitKeys: readonly string[];
  readonly prerequisiteIds: ReadonlySet<string>;
  readonly cyclic: boolean;
}

interface RecordCleanupGroup {
  readonly id: RemovalActionId;
  readonly key: string;
  readonly cleanup: DeclarativeRecordCleanup;
  readonly participants: readonly PlanningUnit[];
  readonly records: RecordCleanupAction["records"];
}

interface QuarantineEntryDraft {
  readonly location: Installation["location"];
  readonly affectedInstallationIds: Set<InstallationId>;
}

export function plan(
  inventoryInput: Inventory,
  intentInput: RemovalIntent,
): RemovalPlan {
  const inventory = parseInventory(inventoryInput);
  const intent = parseIntent(intentInput);
  const resolvedTargets = resolveIntentTargets(inventory, intent);
  const states = resolvedTargets.map<TargetState>((resolved) => ({
    resolved,
    blocks: [],
    safeguards: new Set(),
  }));
  const units = createPlanningUnits(states);
  const unitByInstallationId = indexUnitsByInstallation(units);

  addBoundaryAmbiguityAndProtectionBlocks(states, intent);
  const graph = buildDependencyGraph(
    inventory,
    states,
    units,
    unitByInstallationId,
  );
  addCycleBlocks(graph, units, intent);
  if (intent.force) {
    for (const state of states) {
      if (state.blocks.some((block) => block.kind === "hard-dependency")) {
        state.safeguards.add("dependency");
      }
    }
  }

  const methods = chooseMethods(units, intent);
  const candidateCleanupGroups = createRecordCleanupGroups(
    inventory,
    units,
    methods,
    intent,
  );
  addQuarantineCleanupConflictBlocks(
    candidateCleanupGroups,
    units,
    methods,
    intent,
  );
  addSharedCleanupDependencyBlocks(candidateCleanupGroups, graph);
  addUnavailablePrerequisiteBlocks(graph, units, methods, intent);
  const orderedUnits = orderUnits(units, graph);
  const { actions, warnings: actionWarnings } = createActions(
    inventory,
    orderedUnits,
    graph,
    methods,
    intent,
  );

  const warnings = deduplicateAndSort([
    ...createSoftReferenceWarnings(inventory, states),
    ...createPluginImpactWarnings(states),
    ...actionWarnings,
  ]);
  const blocks = deduplicateAndSort(states.flatMap((state) => state.blocks));
  const verificationChecks = createVerificationChecks(
    inventory,
    states,
    actions,
  );
  const targets = states.map((state) => state.resolved.target);
  const normalizedIntent = normalizeIntent(intent, targets);
  const planId = stableId(
    "removal-plan",
    inventory.id,
    stringifyModel(
      {
        targets,
        intent: normalizedIntent,
      },
      0,
    ),
  ) as RemovalPlanId;

  return parseRemovalPlan({
    schemaVersion: 1,
    id: planId,
    inventoryId: inventory.id,
    createdAt: inventory.scannedAt,
    intent: normalizedIntent,
    targets,
    actions,
    blocks,
    warnings,
    verificationChecks,
  });
}

function normalizeIntent(
  intent: RemovalIntent,
  targets: readonly RemovalTarget[],
): RemovalPlanIntent {
  return intent.kind === "all"
    ? intent
    : {
        kind: "targets",
        targets,
        force: intent.force,
        mode: intent.mode,
      };
}

function parseIntent(input: RemovalIntent): RemovalIntent {
  const result = intentSchema.safeParse(input);
  if (!result.success) {
    throw new PlanningError(
      "invalid-intent",
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "intent"}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data as RemovalIntent;
}

function resolveIntentTargets(
  inventory: Inventory,
  intent: RemovalIntent,
): readonly ResolvedTarget[] {
  const requested =
    intent.kind === "targets"
      ? [...intent.targets]
      : targetsForAll(inventory, intent.includePlugins);
  if (requested.length === 0) {
    throw new PlanningError(
      "no-targets",
      "the removal intent does not select any removable targets",
    );
  }

  const unique = new Map<string, RemovalTarget>();
  for (const target of requested) {
    unique.set(targetKey(target), target);
  }
  const resolved = [...unique.values()]
    .map((target) => resolveTarget(inventory, target))
    .sort(compareResolvedTargetByBreadth);

  const retained: ResolvedTarget[] = [];
  const coveredInstallationIds = new Set<InstallationId>();
  for (const candidate of resolved) {
    const candidateIds = new Set(
      candidate.installations.map((installation) => installation.id),
    );
    const overlap = [...candidateIds].filter((id) =>
      coveredInstallationIds.has(id),
    );
    if (candidateIds.size > 0 && overlap.length === candidateIds.size) {
      continue;
    }
    if (overlap.length > 0) {
      throw new PlanningError(
        "overlapping-targets",
        `targets overlap without one containing the other: ${targetKey(candidate.target)}`,
      );
    }
    retained.push(candidate);
    candidateIds.forEach((id) => coveredInstallationIds.add(id));
  }

  return retained.sort((left, right) =>
    compareText(targetKey(left.target), targetKey(right.target)),
  );
}

function targetsForAll(
  inventory: Inventory,
  includePlugins: boolean,
): RemovalTarget[] {
  const ordinaryInstallationIds = new Set(
    inventory.installations
      .filter(
        (installation) =>
          installation.ownership.kind !== "plugin" ||
          (!includePlugins && installation.ownership.independentlySelectable),
      )
      .map((installation) => installation.id),
  );
  const covered = new Set<InstallationId>();
  const targets: RemovalTarget[] = [];

  for (const logicalSkill of [...inventory.logicalSkills].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    if (
      logicalSkill.installationIds.every((id) =>
        ordinaryInstallationIds.has(id),
      )
    ) {
      targets.push({ kind: "logical-skill", logicalSkillId: logicalSkill.id });
      logicalSkill.installationIds.forEach((id) => covered.add(id));
    }
  }
  for (const installation of [...inventory.installations].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    if (
      ordinaryInstallationIds.has(installation.id) &&
      !covered.has(installation.id)
    ) {
      targets.push({ kind: "installation", installationId: installation.id });
    }
  }
  if (includePlugins) {
    for (const plugin of [...inventory.plugins].sort((left, right) =>
      compareText(left.id, right.id),
    )) {
      targets.push({ kind: "plugin", pluginBoundaryId: plugin.id });
    }
  }
  return targets;
}

function resolveTarget(
  inventory: Inventory,
  target: RemovalTarget,
): ResolvedTarget {
  if (target.kind === "installation") {
    const installation = inventory.installations.find(
      (candidate) => candidate.id === target.installationId,
    );
    if (installation === undefined) {
      throw targetNotFound(target);
    }
    return { target, installations: [installation], plugin: null };
  }
  if (target.kind === "logical-skill") {
    const logicalSkill = inventory.logicalSkills.find(
      (candidate) => candidate.id === target.logicalSkillId,
    );
    if (logicalSkill === undefined) {
      throw targetNotFound(target);
    }
    const installations = logicalSkill.installationIds.map((id) => {
      const installation = inventory.installations.find(
        (candidate) => candidate.id === id,
      );
      if (installation === undefined) {
        throw targetNotFound(target);
      }
      return installation;
    });
    return { target, installations, plugin: null };
  }

  const plugin = inventory.plugins.find(
    (candidate) => candidate.id === target.pluginBoundaryId,
  );
  if (plugin === undefined) {
    throw targetNotFound(target);
  }
  const installations = plugin.installationIds.map((id) => {
    const installation = inventory.installations.find(
      (candidate) => candidate.id === id,
    );
    if (installation === undefined) {
      throw targetNotFound(target);
    }
    return installation;
  });
  return { target, installations, plugin };
}

function targetNotFound(target: RemovalTarget): PlanningError {
  return new PlanningError(
    "target-not-found",
    `removal target does not exist: ${targetKey(target)}`,
  );
}

function compareResolvedTargetByBreadth(
  left: ResolvedTarget,
  right: ResolvedTarget,
): number {
  const priority = { plugin: 0, "logical-skill": 1, installation: 2 } as const;
  return (
    priority[left.target.kind] - priority[right.target.kind] ||
    compareText(targetKey(left.target), targetKey(right.target))
  );
}

function createPlanningUnits(states: readonly TargetState[]): PlanningUnit[] {
  const units: PlanningUnit[] = [];
  for (const state of states) {
    const plugin = state.resolved.plugin;
    if (plugin !== null) {
      units.push({
        key: `${targetKey(state.resolved.target)}|plugin`,
        state,
        installations: state.resolved.installations,
        ownership: plugin.ownership,
        removal: plugin.removal,
      });
      continue;
    }
    for (const installation of state.resolved.installations) {
      units.push({
        key: `${targetKey(state.resolved.target)}|installation:${installation.id}`,
        state,
        installations: [installation],
        ownership: installation.ownership,
        removal: installation.removal,
      });
    }
  }
  return units;
}

function indexUnitsByInstallation(
  units: readonly PlanningUnit[],
): ReadonlyMap<InstallationId, PlanningUnit> {
  const result = new Map<InstallationId, PlanningUnit>();
  for (const unit of units) {
    for (const installation of unit.installations) {
      result.set(installation.id, unit);
    }
  }
  return result;
}

function addBoundaryAmbiguityAndProtectionBlocks(
  states: readonly TargetState[],
  intent: RemovalIntent,
): void {
  for (const state of states) {
    const target = state.resolved.target;
    if (target.kind !== "plugin") {
      const nonSelectablePlugins = state.resolved.installations.filter(
        (installation) =>
          installation.ownership.kind === "plugin" &&
          !installation.ownership.independentlySelectable,
      );
      const seenBoundaries = new Set<string>();
      for (const nonSelectablePlugin of nonSelectablePlugins) {
        if (nonSelectablePlugin.ownership.kind !== "plugin") {
          continue;
        }
        const pluginBoundaryId = nonSelectablePlugin.pluginBoundaryId;
        if (pluginBoundaryId === null) {
          throw new PlanningError(
            "target-not-found",
            `plugin installation has no boundary: ${nonSelectablePlugin.id}`,
          );
        }
        if (seenBoundaries.has(pluginBoundaryId)) {
          continue;
        }
        seenBoundaries.add(pluginBoundaryId);
        addBlock(state, {
          kind: "plugin-boundary",
          target,
          pluginId: nonSelectablePlugin.ownership.pluginId,
          alternative: {
            kind: "plugin",
            pluginBoundaryId,
          },
          overridable: false,
        });
      }
    }

    for (const installation of state.resolved.installations) {
      if (
        installation.ownership.kind === "unknown" ||
        installation.status === "unresolved"
      ) {
        addBlock(state, {
          kind: "ambiguous-ownership",
          target,
          reason:
            installation.ownership.kind === "unknown"
              ? `installation ${installation.id} has unknown ownership`
              : `installation ${installation.id} has unresolved metadata`,
          overridable: true,
        });
        if (intent.force) {
          state.safeguards.add("ambiguity");
        }
      }
      if (installation.removal.primaryArtifactPresent !== false) {
        addProtectionBlocks(
          state,
          target,
          installation.location.path,
          installation.protection,
        );
      }
      for (const artifact of installation.removal.supplementalArtifacts ?? []) {
        addProtectionBlocks(
          state,
          target,
          artifact.location.path,
          artifact.protection,
        );
      }
    }

    for (const resource of state.resolved.plugin?.resources ?? []) {
      if (resource.location !== null && resource.protection !== null) {
        addProtectionBlocks(
          state,
          target,
          resource.location.path,
          resource.protection,
        );
      }
    }
  }
}

function addProtectionBlocks(
  state: TargetState,
  target: RemovalTarget,
  path: string,
  protection: Installation["protection"],
): void {
  if (protection.git.kind === "protected") {
    addBlock(state, {
      kind: "git-protection",
      target,
      path,
      overridable: false,
    });
  }
  if (protection.system.kind === "system-skill") {
    addBlock(state, {
      kind: "system-skill",
      target,
      agentId: protection.system.agentId,
      overridable: false,
    });
  }
  if (protection.filesystem.kind === "read-only") {
    addBlock(state, {
      kind: "filesystem-permission",
      target,
      path,
      reason: protection.filesystem.reason,
      overridable: false,
    });
  }
}

function buildDependencyGraph(
  inventory: Inventory,
  states: readonly TargetState[],
  units: readonly PlanningUnit[],
  unitByInstallationId: ReadonlyMap<InstallationId, PlanningUnit>,
): DependencyGraph {
  const prerequisites = new Map(
    units.map((unit) => [unit.key, new Set<string>()]),
  );
  const dependencyByEdge = new Map<string, HardDependency>();

  for (const dependency of inventory.dependencies) {
    if (dependency.kind !== "hard") {
      continue;
    }
    const affectedUnits = unitsAffectedByDependencyTarget(
      inventory,
      states,
      units,
      dependency.target,
    );
    if (affectedUnits.length === 0) {
      continue;
    }
    const dependentUnit = unitByInstallationId.get(
      dependency.dependentInstallationId,
    );
    if (dependentUnit === undefined) {
      for (const affected of affectedUnits) {
        addDependencyBlock(affected.state, dependency);
      }
      continue;
    }

    for (const affected of affectedUnits) {
      if (affected.key === dependentUnit.key) {
        continue;
      }
      prerequisites.get(affected.key)?.add(dependentUnit.key);
      dependencyByEdge.set(
        dependencyEdgeKey(affected.key, dependentUnit.key),
        dependency,
      );
    }
  }

  const components = buildDependencyComponents(units, prerequisites);
  const componentById = new Map(
    components.map((component) => [component.id, component]),
  );
  const componentByUnitKey = new Map<string, DependencyComponent>();
  for (const component of components) {
    component.unitKeys.forEach((unitKey) =>
      componentByUnitKey.set(unitKey, component),
    );
  }
  const cyclePredecessorByUnitKey = new Map<string, string>();
  for (const component of components.filter((candidate) => candidate.cyclic)) {
    component.unitKeys.slice(1).forEach((unitKey, index) => {
      const predecessor = component.unitKeys[index];
      if (predecessor !== undefined) {
        cyclePredecessorByUnitKey.set(unitKey, predecessor);
      }
    });
  }
  return {
    prerequisites,
    dependencyByEdge,
    components,
    componentById,
    componentByUnitKey,
    cyclePredecessorByUnitKey,
  };
}

function unitsAffectedByDependencyTarget(
  inventory: Inventory,
  states: readonly TargetState[],
  units: readonly PlanningUnit[],
  target: RemovalTarget,
): PlanningUnit[] {
  if (target.kind === "plugin") {
    const state = states.find(
      (candidate) =>
        candidate.resolved.target.kind === "plugin" &&
        candidate.resolved.target.pluginBoundaryId === target.pluginBoundaryId,
    );
    return state === undefined
      ? []
      : units.filter((unit) => unit.state === state);
  }

  const requiredIds =
    target.kind === "installation"
      ? [target.installationId]
      : (inventory.logicalSkills.find(
          (logical) => logical.id === target.logicalSkillId,
        )?.installationIds ?? []);
  const selectedIds = new Set(
    states.flatMap((state) =>
      state.resolved.installations.map((installation) => installation.id),
    ),
  );
  if (!requiredIds.every((id) => selectedIds.has(id))) {
    return [];
  }
  const required = new Set(requiredIds);
  return units.filter((unit) =>
    unit.installations.some((installation) => required.has(installation.id)),
  );
}

function addDependencyBlock(
  state: TargetState,
  dependency: HardDependency,
): void {
  addBlock(state, {
    kind: "hard-dependency",
    target: state.resolved.target,
    dependency: { ...dependency, target: state.resolved.target },
    overridable: true,
  });
}

function addCycleBlocks(
  graph: DependencyGraph,
  units: readonly PlanningUnit[],
  intent: RemovalIntent,
): void {
  const unitByKey = new Map(units.map((unit) => [unit.key, unit]));
  for (const component of graph.components.filter(
    (candidate) => candidate.cyclic,
  )) {
    const componentKeys = new Set(component.unitKeys);
    for (const unitKey of component.unitKeys) {
      const unit = unitByKey.get(unitKey);
      if (unit === undefined) {
        continue;
      }
      const dependency = [...(graph.prerequisites.get(unitKey) ?? [])]
        .filter((prerequisite) => componentKeys.has(prerequisite))
        .sort(compareText)
        .map((prerequisite) =>
          graph.dependencyByEdge.get(dependencyEdgeKey(unitKey, prerequisite)),
        )
        .find((candidate) => candidate !== undefined);
      if (dependency !== undefined) {
        addDependencyBlock(unit.state, dependency);
        if (intent.force) {
          unit.state.safeguards.add("dependency");
        }
      }
    }
  }
}

function chooseMethods(
  units: readonly PlanningUnit[],
  intent: RemovalIntent,
): ReadonlyMap<string, PlannedMethod> {
  const methods = new Map<string, PlannedMethod>();
  for (const unit of units) {
    const managed = unit.removal.managed;
    if (managed?.trust.kind === "blocked") {
      addBlock(unit.state, {
        kind: "adapter-trust",
        target: unit.state.resolved.target,
        adapterId: managed.trust.adapterId,
        contentHash: managed.trust.contentHash,
        overridable: false,
      });
      continue;
    }

    if (intent.mode === "managed-first" && managed !== null) {
      if (managed.availability.kind === "available") {
        for (const effect of managed.effects) {
          addProtectionBlocks(
            unit.state,
            unit.state.resolved.target,
            effect.path,
            effect.protection,
          );
        }
        methods.set(unit.key, "managed");
      } else {
        addUnavailableBlock(
          unit.state,
          managed.availability.reason,
          unit.removal.fallback,
        );
      }
      continue;
    }

    if (intent.mode === "managed-first" && isManagedOwnership(unit.ownership)) {
      addUnavailableBlock(
        unit.state,
        "the owner has no available managed removal operation",
        unit.removal.fallback,
      );
      continue;
    }

    if (unit.removal.fallback.kind === "unavailable") {
      addUnavailableBlock(
        unit.state,
        unit.removal.fallback.reason,
        unit.removal.fallback,
      );
      continue;
    }

    const unrepresentedCollateral =
      unit.state.resolved.plugin?.resources.filter(
        (resource) => resource.location === null && resource.cleanupId === null,
      ) ?? [];
    if (unrepresentedCollateral.length > 0) {
      addUnavailableBlock(
        unit.state,
        `plugin fallback cannot represent collateral resources: ${unrepresentedCollateral
          .map((resource) => `${resource.kind}:${resource.id}`)
          .sort(compareText)
          .join(", ")}`,
        {
          kind: "unavailable",
          reason: "plugin collateral requires managed removal",
        },
      );
      continue;
    }

    if (
      unit.state.resolved.plugin !== null &&
      unit.installations.length === 0 &&
      !unit.state.resolved.plugin.resources.some(
        (resource) => resource.location !== null,
      ) &&
      unit.removal.recordCleanups.length === 0
    ) {
      const reason = "plugin fallback has no concrete removal effects";
      addUnavailableBlock(unit.state, reason, {
        kind: "unavailable",
        reason,
      });
      continue;
    }

    methods.set(unit.key, "brute-force");
    for (const cleanup of unit.removal.recordCleanups) {
      addProtectionBlocks(
        unit.state,
        unit.state.resolved.target,
        cleanup.location.path,
        cleanup.protection,
      );
    }
  }
  return methods;
}

function addUnavailableBlock(
  state: TargetState,
  reason: string,
  fallback: FallbackAvailability,
): void {
  addBlock(state, {
    kind: "managed-removal-unavailable",
    target: state.resolved.target,
    reason,
    fallback,
    overridable: false,
  });
}

function addUnavailablePrerequisiteBlocks(
  graph: DependencyGraph,
  units: readonly PlanningUnit[],
  methods: ReadonlyMap<string, PlannedMethod>,
  intent: RemovalIntent,
): void {
  const unitByKey = new Map(units.map((unit) => [unit.key, unit]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      for (const prerequisiteKey of graph.prerequisites.get(unit.key) ?? []) {
        const prerequisite = unitByKey.get(prerequisiteKey);
        const unavailable =
          prerequisite === undefined ||
          !methods.has(prerequisiteKey) ||
          !canCreateActions(prerequisite.state, intent.force);
        if (!unavailable) {
          continue;
        }
        const dependency = graph.dependencyByEdge.get(
          dependencyEdgeKey(unit.key, prerequisiteKey),
        );
        if (dependency === undefined) {
          continue;
        }
        const before = unit.state.blocks.length;
        addDependencyBlock(unit.state, dependency);
        if (intent.force) {
          unit.state.safeguards.add("dependency");
        }
        changed ||= unit.state.blocks.length !== before;
      }
    }
  }
}

function addSharedCleanupDependencyBlocks(
  cleanupGroups: readonly RecordCleanupGroup[],
  graph: DependencyGraph,
): void {
  for (const group of cleanupGroups) {
    const participantKeys = group.participants.map((unit) => unit.key);
    const hasRelatedParticipants = participantKeys.some((left, leftIndex) =>
      participantKeys
        .slice(leftIndex + 1)
        .some(
          (right) =>
            hasDependencyPath(graph, left, right) ||
            hasDependencyPath(graph, right, left),
        ),
    );
    if (!hasRelatedParticipants) {
      continue;
    }
    for (const participant of group.participants) {
      addBlock(participant.state, {
        kind: "cleanup-conflict",
        target: participant.state.resolved.target,
        path: group.cleanup.location.path,
        reason:
          "shared record cleanup cannot preserve hard-dependency failure boundaries",
        overridable: false,
      });
    }
  }
}

function addQuarantineCleanupConflictBlocks(
  cleanupGroups: readonly RecordCleanupGroup[],
  units: readonly PlanningUnit[],
  methods: ReadonlyMap<string, PlannedMethod>,
  intent: RemovalIntent,
): void {
  const actionableQuarantines = units
    .filter(
      (unit) =>
        methods.get(unit.key) === "brute-force" &&
        canCreateActions(unit.state, intent.force),
    )
    .map((unit) => ({ unit, entries: createQuarantineEntries(unit) }));

  for (const group of cleanupGroups) {
    const coveringUnits = actionableQuarantines.filter(({ entries }) =>
      entries.some((entry) =>
        quarantineLocationContains(entry.location, group.cleanup.location),
      ),
    );
    if (coveringUnits.length === 0) {
      continue;
    }
    const affectedStates = new Set([
      ...group.participants.map((participant) => participant.state),
      ...coveringUnits.map(({ unit }) => unit.state),
    ]);
    for (const state of affectedStates) {
      addBlock(state, {
        kind: "cleanup-conflict",
        target: state.resolved.target,
        path: group.cleanup.location.path,
        reason: "quarantine path contains a planned record-cleanup document",
        overridable: false,
      });
    }
  }
}

function hasDependencyPath(
  graph: DependencyGraph,
  from: string,
  to: string,
): boolean {
  const pending = [...(graph.prerequisites.get(from) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || visited.has(candidate)) {
      continue;
    }
    if (candidate === to) {
      return true;
    }
    visited.add(candidate);
    pending.push(...(graph.prerequisites.get(candidate) ?? []));
  }
  return false;
}

function createActions(
  inventory: Inventory,
  units: readonly PlanningUnit[],
  graph: DependencyGraph,
  methods: ReadonlyMap<string, PlannedMethod>,
  intent: RemovalIntent,
): { readonly actions: RemovalAction[]; readonly warnings: PlanWarning[] } {
  const actions: RemovalAction[] = [];
  const warnings: PlanWarning[] = [];
  const terminalActionIds = new Map<string, RemovalActionId[]>();
  const immediateActionIds = new Map<string, RemovalActionId[]>();
  const cleanupGroups = createRecordCleanupGroups(
    inventory,
    units,
    methods,
    intent,
  );
  const cleanupGroupIdsByUnitKey = indexCleanupGroupsByUnit(cleanupGroups);

  for (const unit of units) {
    const method = methods.get(unit.key);
    if (method === undefined || !canCreateActions(unit.state, intent.force)) {
      terminalActionIds.set(unit.key, []);
      immediateActionIds.set(unit.key, []);
      continue;
    }
    const cleanupGroupIds = cleanupGroupIdsByUnitKey.get(unit.key) ?? [];
    const prerequisiteActionIds = dependenciesForUnit(
      unit,
      graph,
      cleanupGroupIds,
      terminalActionIds,
      immediateActionIds,
    );
    const approvals = approvalsFor(unit, method, intent);

    if (method === "managed") {
      const managed = unit.removal.managed;
      if (managed === null || managed.availability.kind !== "available") {
        terminalActionIds.set(unit.key, []);
        immediateActionIds.set(unit.key, []);
        continue;
      }
      const affectedInstallationIds = unit.installations.map(
        (installation) => installation.id,
      );
      const action: RemovalAction = {
        id: stableId(
          "action",
          inventory.id,
          unit.key,
          "managed-removal",
          managed.adapterId,
          managed.operationId,
        ) as RemovalActionId,
        kind: "managed-removal",
        target: unit.state.resolved.target,
        affectedInstallationIds,
        dependsOn: deduplicateText(prerequisiteActionIds),
        approvals,
        owner: managedOwner(unit),
        adapterId: managed.adapterId,
        operationId: managed.operationId,
        invocation: managed.invocation,
        fallback: unit.removal.fallback,
        effects: managed.effects,
        verifications: managed.verifications,
      };
      actions.push(action);
      terminalActionIds.set(unit.key, [action.id]);
      immediateActionIds.set(unit.key, [action.id]);
      if (managed.invocation.kind === "ephemeral-package") {
        warnings.push({
          kind: "ephemeral-download",
          target: unit.state.resolved.target,
          packageExecution: managed.invocation.packageExecution,
        });
      }
      continue;
    }

    const quarantineActions = createQuarantineActions(
      inventory,
      unit,
      prerequisiteActionIds,
      approvals,
    );
    actions.push(...quarantineActions);
    const quarantineActionIds = quarantineActions.map((action) => action.id);
    immediateActionIds.set(unit.key, quarantineActionIds);
    terminalActionIds.set(
      unit.key,
      cleanupGroupIds.length > 0 ? [...cleanupGroupIds] : quarantineActionIds,
    );
    if (
      isManagedOwnership(unit.ownership) &&
      unit.removal.recordCleanups.length === 0
    ) {
      warnings.push({
        kind: "unreconciled-owner-state",
        target: unit.state.resolved.target,
        owner: unit.ownership,
        reason: "brute-force removal has no declarative owner-record cleanup",
      });
    }
  }

  for (const group of cleanupGroups) {
    const approvals = deduplicateAndSort(
      group.participants.flatMap((unit) =>
        approvalsFor(unit, "brute-force", intent),
      ),
    );
    const dependencies = deduplicateText(
      group.participants.flatMap((unit) => [
        ...(immediateActionIds.get(unit.key) ?? []),
        ...dependenciesForUnit(
          unit,
          graph,
          cleanupGroupIdsByUnitKey.get(unit.key) ?? [],
          terminalActionIds,
          immediateActionIds,
        ),
      ]),
    ).filter((id) => id !== group.id);
    actions.push({
      id: group.id,
      kind: "record-cleanup",
      affectedTargets: deduplicateAndSort(
        group.participants.map((unit) => unit.state.resolved.target),
        targetKey,
      ),
      affectedInstallationIds: deduplicateText(
        group.participants.flatMap((unit) =>
          unit.installations.map((installation) => installation.id),
        ),
      ),
      dependsOn: dependencies,
      approvals,
      location: group.cleanup.location,
      adapterId: group.cleanup.adapterId,
      format: group.cleanup.format,
      expectedFileHash: group.cleanup.expectedFileHash,
      protection: group.cleanup.protection,
      records: group.records,
    });
  }

  return { actions: orderActions(actions), warnings };
}

function dependenciesForUnit(
  unit: PlanningUnit,
  graph: DependencyGraph,
  currentCleanupGroupIds: readonly RemovalActionId[],
  terminalActionIds: ReadonlyMap<string, readonly RemovalActionId[]>,
  immediateActionIds: ReadonlyMap<string, readonly RemovalActionId[]>,
): RemovalActionId[] {
  const currentGroups = new Set(currentCleanupGroupIds);
  const dependencies: RemovalActionId[] = [];
  const addPredecessor = (predecessorKey: string): void => {
    const terminal = terminalActionIds.get(predecessorKey) ?? [];
    const retained = terminal.filter((id) => !currentGroups.has(id));
    dependencies.push(
      ...(retained.length > 0
        ? retained
        : (immediateActionIds.get(predecessorKey) ?? [])),
    );
  };
  const component = graph.componentByUnitKey.get(unit.key);
  for (const prerequisite of [
    ...(graph.prerequisites.get(unit.key) ?? []),
  ].sort(compareText)) {
    if (
      component !== undefined &&
      graph.componentByUnitKey.get(prerequisite)?.id === component.id
    ) {
      continue;
    }
    addPredecessor(prerequisite);
  }
  if (component?.unitKeys[0] === unit.key) {
    for (const prerequisiteId of [...component.prerequisiteIds].sort(
      compareText,
    )) {
      const prerequisiteComponent = graph.componentById.get(prerequisiteId);
      const terminalUnitKey = prerequisiteComponent?.unitKeys.at(-1);
      if (terminalUnitKey !== undefined) {
        addPredecessor(terminalUnitKey);
      }
    }
  }
  const cyclePredecessor = graph.cyclePredecessorByUnitKey.get(unit.key);
  if (cyclePredecessor !== undefined) {
    addPredecessor(cyclePredecessor);
  }
  return deduplicateText(dependencies);
}

function createRecordCleanupGroups(
  inventory: Inventory,
  units: readonly PlanningUnit[],
  methods: ReadonlyMap<string, PlannedMethod>,
  intent: RemovalIntent,
): readonly RecordCleanupGroup[] {
  const drafts = new Map<
    string,
    {
      cleanups: DeclarativeRecordCleanup[];
      participants: Map<string, PlanningUnit>;
    }
  >();
  for (const unit of units) {
    if (
      methods.get(unit.key) !== "brute-force" ||
      !canCreateActions(unit.state, intent.force)
    ) {
      continue;
    }
    for (const cleanup of unit.removal.recordCleanups) {
      const key = physicalPathKey(cleanup.location);
      const draft = drafts.get(key) ?? {
        cleanups: [],
        participants: new Map<string, PlanningUnit>(),
      };
      draft.cleanups.push(cleanup);
      draft.participants.set(unit.key, unit);
      drafts.set(key, draft);
    }
  }
  return [...drafts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, draft]) => {
      const cleanup = [...draft.cleanups].sort((left, right) =>
        compareText(
          stringifyModel(left.location, 0),
          stringifyModel(right.location, 0),
        ),
      )[0];
      if (cleanup === undefined) {
        throw new PlanningError(
          "invalid-intent",
          `record cleanup document has no records: ${key}`,
        );
      }
      const records = deduplicateAndSort(
        draft.cleanups.map(({ recordPointer, expectedRecordHash }) => ({
          recordPointer,
          expectedRecordHash,
        })),
        (record) => record.recordPointer,
      );
      return {
        id: stableId(
          "action",
          inventory.id,
          "record-cleanup",
          key,
        ) as RemovalActionId,
        key,
        cleanup,
        participants: [...draft.participants.values()].sort((left, right) =>
          compareText(left.key, right.key),
        ),
        records,
      };
    });
}

function indexCleanupGroupsByUnit(
  groups: readonly RecordCleanupGroup[],
): ReadonlyMap<string, readonly RemovalActionId[]> {
  const result = new Map<string, RemovalActionId[]>();
  for (const group of groups) {
    for (const unit of group.participants) {
      result.set(unit.key, [...(result.get(unit.key) ?? []), group.id]);
    }
  }
  return result;
}

function orderActions(actions: readonly RemovalAction[]): RemovalAction[] {
  const remaining = new Map(actions.map((action) => [action.id, action]));
  const orderIndex = new Map(
    actions.map((action, index) => [action.id, index]),
  );
  const completed = new Set<RemovalActionId>();
  const result: RemovalAction[] = [];
  while (remaining.size > 0) {
    const next = [...remaining.values()]
      .sort(
        (left, right) =>
          (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0),
      )
      .find((action) =>
        action.dependsOn.every((dependency) => completed.has(dependency)),
      );
    if (next === undefined) {
      throw new PlanningError(
        "invalid-intent",
        "removal action graph unexpectedly contains a cycle",
      );
    }
    remaining.delete(next.id);
    completed.add(next.id);
    result.push(next);
  }
  return result;
}

function createQuarantineActions(
  inventory: Inventory,
  unit: PlanningUnit,
  prerequisiteActionIds: readonly RemovalActionId[],
  approvals: readonly ApprovalRequirement[],
): RemovalAction[] {
  return createQuarantineEntries(unit).map((entry) => ({
    id: stableId(
      "action",
      inventory.id,
      unit.key,
      "quarantine",
      entry.location.path,
    ) as RemovalActionId,
    kind: "quarantine" as const,
    target: unit.state.resolved.target,
    affectedInstallationIds: [...entry.affectedInstallationIds].sort(
      compareText,
    ),
    dependsOn: deduplicateText(prerequisiteActionIds),
    approvals,
    location: entry.location,
  }));
}

function createQuarantineEntries(
  unit: PlanningUnit,
): readonly QuarantineEntryDraft[] {
  const entries = new Map<string, QuarantineEntryDraft>();
  const addEntry = (
    location: Installation["location"],
    installationIds: readonly InstallationId[],
  ): void => {
    const key = artifactPathKey(location);
    const entry = entries.get(key) ?? {
      location,
      affectedInstallationIds: new Set<InstallationId>(),
    };
    installationIds.forEach((id) => entry.affectedInstallationIds.add(id));
    entries.set(key, entry);
  };
  for (const installation of unit.installations) {
    if (installation.removal.primaryArtifactPresent !== false) {
      addEntry(installation.location, [installation.id]);
    }
    for (const artifact of installation.removal.supplementalArtifacts ?? []) {
      addEntry(artifact.location, [installation.id]);
    }
  }
  for (const resource of unit.state.resolved.plugin?.resources ?? []) {
    if (resource.location !== null) {
      addEntry(resource.location, []);
    }
  }

  const collapsed: QuarantineEntryDraft[] = [];
  for (const entry of [...entries.values()].sort(
    (left, right) =>
      artifactPathKey(left.location).length -
        artifactPathKey(right.location).length ||
      compareText(
        artifactPathKey(left.location),
        artifactPathKey(right.location),
      ),
  )) {
    const ancestor = collapsed.find((candidate) =>
      locationContains(candidate.location, entry.location),
    );
    if (ancestor !== undefined) {
      entry.affectedInstallationIds.forEach((id) =>
        ancestor.affectedInstallationIds.add(id),
      );
    } else {
      collapsed.push(entry);
    }
  }

  return collapsed.sort((left, right) =>
    compareText(left.location.path, right.location.path),
  );
}

function approvalsFor(
  unit: PlanningUnit,
  method: PlannedMethod,
  intent: RemovalIntent,
): readonly ApprovalRequirement[] {
  const approvals: ApprovalRequirement[] = [{ kind: "confirmation" }];
  if (method === "brute-force") {
    approvals.push({ kind: "brute-force-confirmation" });
  }
  const safeguards = [...unit.state.safeguards].sort(compareText);
  if (intent.force && safeguards.length > 0) {
    approvals.push({ kind: "force-override", safeguards });
  }
  const packageExecution =
    unit.removal.managed?.invocation.kind === "ephemeral-package"
      ? unit.removal.managed.invocation.packageExecution
      : null;
  if (method === "managed" && packageExecution !== null) {
    approvals.push({
      kind: "package-trust",
      runner: packageExecution.runner,
      packageName: packageExecution.packageName,
      packageVersion: packageExecution.packageVersion,
      adapterHash: packageExecution.adapterHash,
    });
  }
  return approvals;
}

function managedOwner(unit: PlanningUnit): ManagedOwnership {
  if (!isManagedOwnership(unit.ownership)) {
    throw new PlanningError(
      "invalid-intent",
      `managed removal evidence has no managed owner for ${unit.key}`,
    );
  }
  return unit.ownership;
}

function isManagedOwnership(
  ownership: PlanningUnit["ownership"],
): ownership is ManagedOwnership {
  return ownership.kind === "manager" || ownership.kind === "plugin";
}

function createSoftReferenceWarnings(
  inventory: Inventory,
  states: readonly TargetState[],
): PlanWarning[] {
  const units = createPlanningUnits(states);
  return inventory.dependencies.flatMap((dependency) => {
    if (dependency.kind !== "soft") {
      return [];
    }
    const affected = unitsAffectedByDependencyTarget(
      inventory,
      states,
      units,
      dependency.target,
    );
    const affectedStates = new Set(affected.map((unit) => unit.state));
    return [...affectedStates].map((state) => ({
      kind: "soft-reference" as const,
      target: state.resolved.target,
      reference: dependency as SoftReference,
    }));
  });
}

function createPluginImpactWarnings(
  states: readonly TargetState[],
): PlanWarning[] {
  return states.flatMap((state) => {
    const plugin = state.resolved.plugin;
    if (plugin === null) {
      return [];
    }
    const affectedResources = [
      ...state.resolved.installations.map(
        (installation) =>
          `skill:${installation.skill.name}:${installation.location.path}`,
      ),
      ...plugin.resources.map((resource) => `${resource.kind}:${resource.id}`),
    ].sort(compareText);
    return [
      {
        kind: "plugin-impact" as const,
        target: state.resolved.target,
        pluginId: plugin.pluginId,
        affectedResources:
          affectedResources.length > 0
            ? affectedResources
            : [`plugin:${plugin.pluginId}`],
      },
    ];
  });
}

function createVerificationChecks(
  inventory: Inventory,
  states: readonly TargetState[],
  actions: readonly RemovalAction[],
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const actionTargetKeys = new Set(
    actions.flatMap((action) => actionTargets(action).map(targetKey)),
  );
  for (const state of states) {
    if (!actionTargetKeys.has(targetKey(state.resolved.target))) {
      continue;
    }
    checks.push({
      id: stableId(
        "verification",
        inventory.id,
        targetKey(state.resolved.target),
        "target-unavailable",
      ) as VerificationCheckId,
      kind: "target-unavailable",
      target: state.resolved.target,
    });
  }
  for (const action of actions) {
    if (action.kind === "quarantine") {
      checks.push({
        id: stableId(
          "verification",
          inventory.id,
          action.id,
          "path-absent",
          action.location.path,
        ) as VerificationCheckId,
        kind: "path-absent",
        actionId: action.id,
        path: action.location.path,
      });
    }
    if (action.kind === "managed-removal") {
      const state = states.find(
        (candidate) =>
          targetKey(candidate.resolved.target) === targetKey(action.target),
      );
      const affectedIds = new Set(action.affectedInstallationIds);
      const managedEvidence =
        state === undefined
          ? []
          : state.resolved.plugin !== null
            ? [state.resolved.plugin.removal.managed].filter(
                (managed) => managed !== null,
              )
            : state.resolved.installations
                .filter((installation) => affectedIds.has(installation.id))
                .map((installation) => installation.removal.managed)
                .filter((managed) => managed !== null);
      for (const managed of managedEvidence) {
        for (const verification of managed.verifications) {
          switch (verification.kind) {
            case "path-absent":
              checks.push({
                id: stableId(
                  "verification",
                  inventory.id,
                  action.id,
                  stringifyModel(verification, 0),
                ) as VerificationCheckId,
                actionId: action.id,
                ...verification,
              });
              break;
            case "record-absent":
              checks.push({
                id: stableId(
                  "verification",
                  inventory.id,
                  action.id,
                  stringifyModel(verification, 0),
                ) as VerificationCheckId,
                actionId: action.id,
                ...verification,
                expectedRecordHash: null,
              });
              break;
            case "owner-state-absent":
              checks.push({
                id: stableId(
                  "verification",
                  inventory.id,
                  action.id,
                  stringifyModel(verification, 0),
                ) as VerificationCheckId,
                kind: "owner-state-absent",
                actionId: action.id,
                owner: action.owner,
                externalId: verification.externalId,
              });
              break;
            case "command-succeeds":
              checks.push({
                id: stableId(
                  "verification",
                  inventory.id,
                  action.id,
                  stringifyModel(verification, 0),
                ) as VerificationCheckId,
                actionId: action.id,
                ...verification,
              });
              break;
          }
        }
      }
      for (const effect of action.effects) {
        if (effect.kind !== "remove-path") {
          continue;
        }
        checks.push({
          id: stableId(
            "verification",
            inventory.id,
            action.id,
            "path-absent",
            effect.path,
          ) as VerificationCheckId,
          kind: "path-absent",
          actionId: action.id,
          path: effect.path,
        });
      }
    }
    if (action.kind === "record-cleanup") {
      for (const record of action.records) {
        checks.push({
          id: stableId(
            "verification",
            inventory.id,
            action.id,
            "record-absent",
            action.location.path,
            record.recordPointer,
          ) as VerificationCheckId,
          kind: "record-absent",
          actionId: action.id,
          path: action.location.path,
          format: action.format,
          recordPointer: record.recordPointer,
          expectedRecordHash: record.expectedRecordHash,
        });
      }
    }
  }
  return deduplicateAndSort(checks, (check) =>
    check.kind === "target-unavailable"
      ? `${check.kind}:${targetKey(check.target)}`
      : check.kind === "path-absent"
        ? `${check.actionId}:${check.kind}:${check.path}`
        : check.kind === "owner-state-absent"
          ? `${check.actionId}:${check.kind}:${stringifyModel(check.owner, 0)}:${check.externalId}`
          : check.kind === "record-absent"
            ? `${check.actionId}:${check.kind}:${check.path}:${check.recordPointer}`
            : `${check.actionId}:${check.kind}:${stringifyModel(check.command, 0)}:${check.successExitCodes.join(",")}`,
  );
}

function actionTargets(action: RemovalAction): readonly RemovalTarget[] {
  return action.kind === "record-cleanup"
    ? action.affectedTargets
    : [action.target];
}

function canCreateActions(state: TargetState, force: boolean): boolean {
  return state.blocks.every((block) => block.overridable && force);
}

function addBlock(state: TargetState, block: PlanBlock): void {
  const key = stringifyModel(block, 0);
  if (!state.blocks.some((candidate) => stringifyModel(candidate, 0) === key)) {
    state.blocks.push(block);
  }
}

function buildDependencyComponents(
  units: readonly PlanningUnit[],
  prerequisites: ReadonlyMap<string, ReadonlySet<string>>,
): readonly DependencyComponent[] {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const rawComponents: string[][] = [];

  const visit = (key: string): void => {
    indexes.set(key, nextIndex);
    lowLinks.set(key, nextIndex);
    nextIndex += 1;
    stack.push(key);
    onStack.add(key);

    for (const prerequisite of [...(prerequisites.get(key) ?? [])].sort(
      compareText,
    )) {
      if (!indexes.has(prerequisite)) {
        visit(prerequisite);
        lowLinks.set(
          key,
          Math.min(
            lowLinks.get(key) as number,
            lowLinks.get(prerequisite) as number,
          ),
        );
      } else if (onStack.has(prerequisite)) {
        lowLinks.set(
          key,
          Math.min(
            lowLinks.get(key) as number,
            indexes.get(prerequisite) as number,
          ),
        );
      }
    }

    if (lowLinks.get(key) !== indexes.get(key)) {
      return;
    }
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== key);
    rawComponents.push(component.sort(compareText));
  };

  for (const unit of [...units].sort((left, right) =>
    compareText(left.key, right.key),
  )) {
    if (!indexes.has(unit.key)) {
      visit(unit.key);
    }
  }
  const componentIdByUnitKey = new Map<string, string>();
  const componentDrafts = rawComponents.map((unitKeys) => {
    const id = stableId("dependency-component", ...unitKeys);
    unitKeys.forEach((unitKey) => componentIdByUnitKey.set(unitKey, id));
    return { id, unitKeys };
  });
  const components = componentDrafts
    .map<DependencyComponent>((draft) => {
      const prerequisiteIds = new Set<string>();
      for (const unitKey of draft.unitKeys) {
        for (const prerequisite of prerequisites.get(unitKey) ?? []) {
          const prerequisiteId = componentIdByUnitKey.get(prerequisite);
          if (prerequisiteId !== undefined && prerequisiteId !== draft.id) {
            prerequisiteIds.add(prerequisiteId);
          }
        }
      }
      return {
        ...draft,
        prerequisiteIds,
        cyclic:
          draft.unitKeys.length > 1 ||
          (prerequisites
            .get(draft.unitKeys[0] as string)
            ?.has(draft.unitKeys[0] as string) ??
            false),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
  return components;
}

function orderUnits(
  units: readonly PlanningUnit[],
  graph: DependencyGraph,
): PlanningUnit[] {
  const unitByKey = new Map(units.map((unit) => [unit.key, unit]));
  const remaining = new Map(
    graph.components.map((component) => [component.id, component]),
  );
  const processedComponents = new Set<string>();
  const result: PlanningUnit[] = [];
  while (remaining.size > 0) {
    const next = [...remaining.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .find((component) =>
        [...component.prerequisiteIds].every((id) =>
          processedComponents.has(id),
        ),
      );
    if (next === undefined) {
      throw new PlanningError(
        "invalid-intent",
        "dependency component graph unexpectedly contains a cycle",
      );
    }
    remaining.delete(next.id);
    processedComponents.add(next.id);
    for (const unitKey of next.unitKeys) {
      const unit = unitByKey.get(unitKey);
      if (unit !== undefined) {
        result.push(unit);
      }
    }
  }
  return result;
}

function dependencyEdgeKey(unitKey: string, prerequisiteKey: string): string {
  return stringifyModel([unitKey, prerequisiteKey], 0);
}

function targetKey(target: RemovalTarget): string {
  switch (target.kind) {
    case "installation":
      return `installation:${target.installationId}`;
    case "logical-skill":
      return `logical-skill:${target.logicalSkillId}`;
    case "plugin":
      return `plugin:${target.pluginBoundaryId}`;
  }
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
  }
  return `${prefix}-${hash.digest("hex").slice(0, 24)}`;
}

function deduplicateText<Value extends string>(
  values: readonly Value[],
): Value[] {
  return [...new Set(values)].sort(compareText);
}

function deduplicateAndSort<Value>(
  values: readonly Value[],
  key: (value: Value) => string = (value) => stringifyModel(value, 0),
): Value[] {
  return [...new Map(values.map((value) => [key(value), value])).entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
