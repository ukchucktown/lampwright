import { createHash } from "node:crypto";

import { stringifyModel } from "../model/json.js";
import type {
  SessionSetupIntent,
  SessionSetupPlan,
  SessionSetupSnapshot,
  SessionSetupTarget,
  SessionSetupTargetRef,
  SetupBlock,
  SetupMutation,
  SetupScope,
  SetupWarning,
} from "./types.js";
import {
  parseSessionSetupIntent,
  parseSessionSetupPlan,
  parseSessionSetupSnapshot,
} from "./validation.js";

interface Candidate {
  readonly target: SessionSetupTarget;
  readonly ref: SessionSetupTargetRef;
  readonly mutation: SetupMutation;
  readonly scope: SetupScope;
}

interface ActionGroup {
  readonly key: string;
  readonly candidates: Candidate[];
}

/** Pure planner for one harness and workspace using native controls only. */
export function planSessionSetup(
  snapshotInput: SessionSetupSnapshot,
  intentInput: SessionSetupIntent,
): SessionSetupPlan {
  const snapshot = parseSessionSetupSnapshot(snapshotInput);
  const intent = normalizeIntent(parseSessionSetupIntent(intentInput));
  const targetById = new Map(
    snapshot.targets.map((target) => [target.id, target]),
  );
  const selectedTargets: SessionSetupTarget[] = [];
  const blocks: SetupBlock[] = [];
  const warnings: SetupWarning[] = [];
  const includedIds = new Set<string>();

  for (const ref of intent.targets) {
    const target = targetById.get(ref.targetId);
    if (!target || !sameRef(refFor(target), ref)) {
      blocks.push({ kind: "missing-target", target: ref });
      continue;
    }
    include(target.id, includedIds);
    if (
      target.harnessId !== intent.harnessId ||
      target.workspace.path !== intent.workspace.path
    ) {
      blocks.push({
        kind: "unresolved",
        target: ref,
        reason: "target belongs to another harness or workspace",
      });
      continue;
    }
    selectedTargets.push(target);
  }

  includeDisclosureTargets(snapshot, selectedTargets, includedIds);
  const selectedIds = new Set(selectedTargets.map((target) => target.id));
  const prerequisites = new Map<string, Set<string>>();
  const candidates: Candidate[] = [];

  for (const target of selectedTargets) {
    const ref = refFor(target);
    const availability = target.control.availability[intent.action];
    const priorBlockCount = blocks.length;
    addSourceBlocks(snapshot, target, ref, availability, blocks);
    addSelectorBlocks(snapshot, target, ref, blocks);
    if (availability.kind === "unavailable") {
      blocks.push({
        kind: "unsupported-control",
        target: ref,
        reason: availability.reason,
      });
    } else {
      if (availability.authority.kind === "configuration")
        addConfigurationBlocks(target, ref, availability.authority, blocks);
      warnings.push({
        kind: "control-scope",
        target: ref,
        scope: availability.controlScope,
      });
      warnings.push({
        kind: "activation",
        target: ref,
        activation: activationFor(snapshot, target),
      });
    }
    addSoftWarnings(snapshot, target, ref, warnings, includedIds);
    if (intent.action === "enable" && target.owner.kind === "plugin") {
      const owner = pluginOwner(
        snapshot,
        target.owner.pluginBoundaryId,
        target,
      );
      if (owner?.state.effectiveWorkspaceState === "disabled") {
        if (!selectedIds.has(owner.id)) {
          include(owner.id, includedIds);
          blocks.push({
            kind: "owner-gate",
            target: ref,
            owner: refFor(owner),
          });
        } else {
          addPrerequisite(prerequisites, target.id, owner.id);
        }
      }
    }
    if (
      availability.kind === "available" &&
      blocks.length === priorBlockCount
    ) {
      candidates.push({
        target,
        ref,
        scope: availability.controlScope,
        mutation: {
          kind: availability.authority.kind,
          authority: availability.authority,
          selectorId: target.control.selector.id,
          policy: intent.action === "enable" ? "enabled" : "disabled",
        } as SetupMutation,
      });
    }
  }

  addHardDependencyRules(
    snapshot,
    intent,
    selectedIds,
    includedIds,
    blocks,
    prerequisites,
  );

  const blockedIds = new Set(blocks.map((block) => block.target.targetId));
  const preliminaryGroups = groupCandidates(
    candidates.filter((candidate) => !blockedIds.has(candidate.target.id)),
  );
  const preliminaryGroupByTarget = new Map<string, ActionGroup>();
  for (const group of preliminaryGroups)
    for (const candidate of group.candidates)
      preliminaryGroupByTarget.set(candidate.target.id, group);

  for (const targetId of cyclicTargets(
    prerequisites,
    preliminaryGroupByTarget,
  )) {
    const target = targetById.get(targetId);
    if (target)
      blocks.push({
        kind: "unresolved",
        target: refFor(target),
        reason: "selected dependency actions cannot be ordered safely",
      });
    blockedIds.add(targetId);
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const [targetId, requiredIds] of prerequisites) {
      if (blockedIds.has(targetId)) continue;
      const group = preliminaryGroupByTarget.get(targetId);
      if (
        !group ||
        [...requiredIds].some(
          (requiredId) =>
            blockedIds.has(requiredId) ||
            !preliminaryGroupByTarget.has(requiredId),
        )
      ) {
        const target = targetById.get(targetId);
        if (target)
          blocks.push({
            kind: "unresolved",
            target: refFor(target),
            reason: "a required selected action cannot be planned safely",
          });
        blockedIds.add(targetId);
        propagated = true;
      }
    }
  }

  const finalGroups = groupCandidates(
    candidates.filter((candidate) => !blockedIds.has(candidate.target.id)),
  );
  const actionIdByTarget = new Map<string, string>();
  const actionIdByGroup = new Map<string, string>();
  for (const group of finalGroups) {
    const id = stableId("setup-action", intent.action, group.key);
    actionIdByGroup.set(group.key, id);
    for (const candidate of group.candidates)
      actionIdByTarget.set(candidate.target.id, id);
  }
  const actions = finalGroups.map((group) => {
    const id = actionIdByGroup.get(group.key)!;
    const dependsOn = new Set<string>();
    for (const candidate of group.candidates)
      for (const requiredId of prerequisites.get(candidate.target.id) ?? []) {
        const dependencyId = actionIdByTarget.get(requiredId);
        if (dependencyId && dependencyId !== id) dependsOn.add(dependencyId);
      }
    const scopes = uniqueScopes(group.candidates.map((item) => item.scope));
    return {
      id,
      kind: "native-availability" as const,
      targets: group.candidates.map((item) => item.ref) as [
        SessionSetupTargetRef,
        ...SessionSetupTargetRef[],
      ],
      operation: intent.action,
      mutations: uniqueMutations(group.candidates.map((item) => item.mutation)),
      dependsOn: [...dependsOn].sort(),
      approvals: [
        { kind: "confirmation" as const, required: true as const },
        ...scopes.map((scope) => ({
          kind: "scope-disclosure" as const,
          scope,
          required: true as const,
        })),
      ],
    };
  });

  const targets = closureTargets(
    snapshot,
    includedIds,
    intent.harnessId,
    intent.workspace.path,
  );
  const verifications = selectedTargets.flatMap((target) => {
    const ref = refFor(target);
    const expected = intent.action === "enable" ? "enabled" : "disabled";
    return [
      {
        id: `policy:${target.id}`,
        kind: "native-policy" as const,
        target: ref,
        selectorId: target.control.selector.id,
        expectedPolicy: expected,
      },
      {
        id: `effective:${target.id}`,
        kind: "effective-workspace-state" as const,
        target: ref,
        expected,
      },
      {
        id: `activation:${target.id}`,
        kind: "new-session-required" as const,
        target: ref,
        activation: activationFor(snapshot, target),
      },
    ];
  });
  const id = stableId(
    "session-setup-plan",
    snapshot.semanticFingerprint.digest,
    stringifyModel(intent, 0),
  );
  return parseSessionSetupPlan({
    schemaVersion: 1,
    kind: "session-setup-plan",
    id,
    snapshotId: snapshot.id,
    snapshotFingerprint: snapshot.semanticFingerprint,
    createdAt: snapshot.scannedAt,
    intent,
    targets,
    actions,
    blocks: deduplicate(blocks),
    warnings: deduplicate(warnings),
    verifications,
    errors: [],
  });
}

function normalizeIntent(intent: SessionSetupIntent): SessionSetupIntent {
  const unique = new Map(
    intent.targets.map((target) => [stringifyModel(target, 0), target]),
  );
  return {
    ...intent,
    targets: [...unique.values()] as [
      SessionSetupTargetRef,
      ...SessionSetupTargetRef[],
    ],
  };
}

function includeDisclosureTargets(
  snapshot: SessionSetupSnapshot,
  selected: readonly SessionSetupTarget[],
  included: Set<string>,
): void {
  for (const target of selected) {
    for (const governedId of target.control.selector.governedTargetIds)
      include(governedId, included);
    if (target.kind === "plugin") {
      for (const childId of target.childTargetIds) include(childId, included);
      for (const candidate of snapshot.targets)
        if (
          candidate.owner.kind === "plugin" &&
          candidate.owner.pluginBoundaryId === target.pluginBoundaryId &&
          candidate.harnessId === target.harnessId &&
          candidate.workspace.path === target.workspace.path
        )
          include(candidate.id, included);
    }
    for (const operation of [
      target.control.availability.enable,
      target.control.availability.disable,
    ])
      if (
        operation.kind === "available" &&
        operation.authority.kind === "native-command"
      )
        for (const effect of operation.authority.effects)
          for (const affected of effect.targets)
            include(affected.targetId, included);
  }
}

function addSourceBlocks(
  snapshot: SessionSetupSnapshot,
  target: SessionSetupTarget,
  ref: SessionSetupTargetRef,
  availability: SessionSetupTarget["control"]["availability"]["enable"],
  blocks: SetupBlock[],
): void {
  const sourceIds = new Set([target.source.sourceId]);
  if (availability.kind === "available")
    sourceIds.add(availability.authority.source.sourceId);
  for (const sourceId of sourceIds) {
    const source = snapshot.sources.find(
      (candidate) => candidate.source.sourceId === sourceId,
    );
    if (!source) {
      blocks.push({
        kind: "unresolved",
        target: ref,
        reason: `authoritative source '${sourceId}' is missing`,
      });
      continue;
    }
    if (source.status === "success") continue;
    blocks.push({
      kind:
        source.status === "incomplete"
          ? "source-incomplete"
          : source.status === "invalid"
            ? "source-invalid"
            : "source-unavailable",
      target: ref,
      reason: source.reason ?? `source '${sourceId}' is not usable`,
    });
  }
}

function addSelectorBlocks(
  snapshot: SessionSetupSnapshot,
  target: SessionSetupTarget,
  ref: SessionSetupTargetRef,
  blocks: SetupBlock[],
): void {
  if (
    target.kind === "skill-exposure" &&
    snapshot.targets.some(
      (candidate) =>
        candidate.kind === "skill-exposure" &&
        candidate.id !== target.id &&
        candidate.harnessId === target.harnessId &&
        candidate.workspace.path === target.workspace.path &&
        candidate.name === target.name,
    )
  )
    blocks.push({
      kind: "selector-collision",
      target: ref,
      reason: `Skill name '${target.name}' is ambiguous in the selected harness`,
    });
  if (target.control.selector.authority !== "shared-connector") return;
  const governed = [...target.control.selector.governedTargetIds].sort();
  const known = snapshot.targets
    .filter(
      (candidate) =>
        candidate.control.selector.id === target.control.selector.id,
    )
    .map((candidate) => candidate.id)
    .sort();
  const source = snapshot.sources.find(
    (candidate) => candidate.source.sourceId === target.source.sourceId,
  );
  const collateral = [...(source?.collateralTargetIds ?? [])].sort();
  if (
    !target.control.selector.collateralComplete ||
    stringifyModel(governed, 0) !== stringifyModel(known, 0) ||
    !governed.every((id) => collateral.includes(id))
  )
    blocks.push({
      kind: "shared-selector-incomplete",
      target: ref,
      reason: "shared connector collateral is incomplete",
    });
}

function addConfigurationBlocks(
  target: SessionSetupTarget,
  ref: SessionSetupTargetRef,
  authority: Extract<SetupMutation, { kind: "configuration" }>["authority"],
  blocks: SetupBlock[],
): void {
  const layer = target.control.layers.find(
    (candidate) =>
      candidate.source.sourceId === authority.layerSourceId &&
      candidate.canonicalPath === authority.layerCanonicalPath,
  );
  if (!layer || layer.canonicalPath === null) {
    blocks.push({
      kind: "unresolved",
      target: ref,
      reason: "configuration authority has no canonical writable layer",
    });
    return;
  }
  const protection = layer.protection;
  if (
    protection.git.kind === "protected" ||
    protection.system.kind !== "none" ||
    protection.filesystem.kind !== "writable"
  )
    blocks.push({
      kind: "protected",
      target: ref,
      reason: "native configuration is protected",
    });
  if (
    !["regular", "missing"].includes(layer.integrity) ||
    (layer.exists &&
      (layer.integrity !== "regular" || layer.expectedPreimage === null)) ||
    (!layer.exists &&
      (layer.integrity !== "missing" || layer.expectedPreimage !== null))
  )
    blocks.push({
      kind: "unresolved",
      target: ref,
      reason: "native configuration integrity is unsafe or inconsistent",
    });
}

function addSoftWarnings(
  snapshot: SessionSetupSnapshot,
  target: SessionSetupTarget,
  ref: SessionSetupTargetRef,
  warnings: SetupWarning[],
  included: Set<string>,
): void {
  for (const dependency of snapshot.dependencies)
    if (
      dependency.kind === "soft" &&
      (dependency.required.targetId === target.id ||
        dependency.dependent.targetId === target.id)
    ) {
      include(dependency.required.targetId, included);
      include(dependency.dependent.targetId, included);
      warnings.push({ kind: "soft-reference", target: ref, dependency });
    }
}

function addHardDependencyRules(
  snapshot: SessionSetupSnapshot,
  intent: SessionSetupIntent,
  selectedIds: ReadonlySet<string>,
  included: Set<string>,
  blocks: SetupBlock[],
  prerequisites: Map<string, Set<string>>,
): void {
  for (const dependency of snapshot.dependencies) {
    if (dependency.kind !== "hard") continue;
    const dependent = snapshot.targets.find(
      (target) => target.id === dependency.dependent.targetId,
    );
    const required = snapshot.targets.find(
      (target) => target.id === dependency.required.targetId,
    );
    if (!dependent || !required) continue;
    const dependentController = controllerFor(
      snapshot,
      dependent,
      selectedIds,
      intent.action,
      "dependent",
    );
    const requiredController = controllerFor(
      snapshot,
      required,
      selectedIds,
      intent.action,
      "required",
    );
    if (intent.action === "disable" && requiredController) {
      include(dependent.id, included);
      include(required.id, included);
      if (
        dependent.state.effectiveWorkspaceState !== "disabled" &&
        !dependentController
      ) {
        const target = snapshot.targets.find(
          (candidate) => candidate.id === requiredController,
        );
        if (target)
          blocks.push({
            kind: "hard-dependency",
            target: refFor(target),
            dependency,
          });
      } else if (dependentController) {
        addPrerequisite(prerequisites, requiredController, dependentController);
      }
    }
    if (intent.action === "enable" && dependentController) {
      include(dependent.id, included);
      include(required.id, included);
      if (
        required.state.effectiveWorkspaceState !== "enabled" &&
        !requiredController
      ) {
        const target = snapshot.targets.find(
          (candidate) => candidate.id === dependentController,
        );
        if (target)
          blocks.push({
            kind: "hard-dependency",
            target: refFor(target),
            dependency,
          });
      } else if (requiredController) {
        addPrerequisite(prerequisites, dependentController, requiredController);
      }
    }
  }
}

function controllerFor(
  snapshot: SessionSetupSnapshot,
  target: SessionSetupTarget,
  selectedIds: ReadonlySet<string>,
  action: SessionSetupIntent["action"],
  role: "dependent" | "required",
): string | null {
  if (selectedIds.has(target.id)) return target.id;
  if (target.owner.kind !== "plugin") return null;
  const owner = pluginOwner(snapshot, target.owner.pluginBoundaryId, target);
  if (!owner || !selectedIds.has(owner.id)) return null;
  if (action === "disable") return owner.id;
  if (role === "dependent")
    return target.state.policy === "disabled" ? null : owner.id;
  return target.state.policy === "enabled" ? owner.id : null;
}

function groupCandidates(candidates: readonly Candidate[]): ActionGroup[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = mutationGroupKey(candidate.mutation);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return [...groups]
    .map(([key, values]) => ({
      key,
      candidates: values.sort((left, right) =>
        left.target.id.localeCompare(right.target.id),
      ),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function cyclicTargets(
  prerequisites: ReadonlyMap<string, ReadonlySet<string>>,
  groups: ReadonlyMap<string, ActionGroup>,
): ReadonlySet<string> {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  const visit = (targetId: string): void => {
    const current = state.get(targetId);
    if (current === "visited") return;
    if (current === "visiting") {
      const start = stack.lastIndexOf(targetId);
      for (const member of stack.slice(Math.max(0, start))) cyclic.add(member);
      return;
    }
    state.set(targetId, "visiting");
    stack.push(targetId);
    for (const requiredId of prerequisites.get(targetId) ?? [])
      if (groups.get(requiredId)?.key !== groups.get(targetId)?.key)
        visit(requiredId);
    stack.pop();
    state.set(targetId, "visited");
  };
  for (const targetId of prerequisites.keys()) visit(targetId);
  return cyclic;
}

function mutationGroupKey(mutation: SetupMutation): string {
  return mutation.kind === "configuration"
    ? `configuration:${mutation.authority.layerCanonicalPath ?? "missing"}`
    : `native-command:${stringifyModel(mutation.authority, 0)}`;
}

function uniqueMutations(
  mutations: readonly SetupMutation[],
): [SetupMutation, ...SetupMutation[]] {
  const unique = new Map(
    mutations.map((mutation) => [
      `${mutation.selectorId}:${mutation.policy}`,
      mutation,
    ]),
  );
  return [...unique.values()].sort((left, right) =>
    left.selectorId.localeCompare(right.selectorId),
  ) as [SetupMutation, ...SetupMutation[]];
}

function uniqueScopes(scopes: readonly SetupScope[]): SetupScope[] {
  const unique = new Map(
    scopes.map((scope) => [stringifyModel(scope, 0), scope]),
  );
  return [...unique.values()].sort((left, right) =>
    stringifyModel(left, 0).localeCompare(stringifyModel(right, 0)),
  );
}

function closureTargets(
  snapshot: SessionSetupSnapshot,
  includedIds: ReadonlySet<string>,
  harnessId: SessionSetupTarget["harnessId"],
  workspacePath: string,
): SessionSetupTarget[] {
  const closed = new Set(includedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of snapshot.targets) {
      if (!closed.has(target.id)) continue;
      if (target.owner.kind === "plugin") {
        const owner = pluginOwner(
          snapshot,
          target.owner.pluginBoundaryId,
          target,
        );
        if (owner && !closed.has(owner.id)) {
          closed.add(owner.id);
          changed = true;
        }
      }
      if (target.kind === "plugin")
        for (const childId of target.childTargetIds)
          if (!closed.has(childId)) {
            closed.add(childId);
            changed = true;
          }
      for (const governedId of target.control.selector.governedTargetIds)
        if (!closed.has(governedId)) {
          closed.add(governedId);
          changed = true;
        }
    }
  }
  return snapshot.targets
    .filter(
      (target) =>
        closed.has(target.id) &&
        target.harnessId === harnessId &&
        target.workspace.path === workspacePath,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function activationFor(
  snapshot: SessionSetupSnapshot,
  target: SessionSetupTarget,
): "restart" | "new-session" | "unknown" {
  const source = snapshot.sources.find(
    (candidate) => candidate.source.sourceId === target.source.sourceId,
  );
  return (
    snapshot.profiles.find((profile) => profile.id === source?.profileId)
      ?.activation ?? "unknown"
  );
}

function pluginOwner(
  snapshot: SessionSetupSnapshot,
  boundaryId: string,
  context: SessionSetupTarget,
): Extract<SessionSetupTarget, { kind: "plugin" }> | undefined {
  return snapshot.targets.find(
    (target): target is Extract<SessionSetupTarget, { kind: "plugin" }> =>
      target.kind === "plugin" &&
      target.pluginBoundaryId === boundaryId &&
      target.harnessId === context.harnessId &&
      target.workspace.path === context.workspace.path,
  );
}

function refFor(target: SessionSetupTarget): SessionSetupTargetRef {
  if (target.kind === "skill-exposure")
    return {
      kind: target.kind,
      targetId: target.id,
      installationId: target.installationId,
    };
  if (target.kind === "plugin")
    return {
      kind: target.kind,
      targetId: target.id,
      pluginBoundaryId: target.pluginBoundaryId,
    };
  if (target.kind === "mcp-registration")
    return {
      kind: target.kind,
      targetId: target.id,
      declarationSourceId: target.declarationSource.sourceId,
      serverKey: target.serverKey,
    };
  return {
    kind: target.kind,
    targetId: target.id,
    declarationSourceId: target.declarationSource.sourceId,
    alias: target.alias,
    connectorId: target.connectorId,
  };
}

function sameRef(
  left: SessionSetupTargetRef,
  right: SessionSetupTargetRef,
): boolean {
  return stringifyModel(left, 0) === stringifyModel(right, 0);
}

function include(id: string, values: Set<string>): void {
  values.add(id);
}

function addPrerequisite(
  graph: Map<string, Set<string>>,
  targetId: string,
  prerequisiteId: string,
): void {
  if (targetId === prerequisiteId) return;
  graph.set(
    targetId,
    new Set([...(graph.get(targetId) ?? []), prerequisiteId]),
  );
}

function deduplicate<T>(values: readonly T[]): T[] {
  return [
    ...new Map(
      values.map((value) => [stringifyModel(value, 0), value]),
    ).values(),
  ];
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 20)}`;
}
