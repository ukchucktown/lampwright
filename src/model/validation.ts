import { z } from "zod";

import {
  executionReportSchema,
  installationSchema,
  inventorySchema,
  logicalSkillSchema,
  nonInstallationFindingSchema,
  removalPlanSchema,
} from "./schemas.js";
import type {
  ApprovalRequirement,
  ExecutionReport,
  Installation,
  Inventory,
  InventoryRecordReference,
  JsonValue,
  LogicalSkill,
  NonInstallationFinding,
  RemovalAction,
  RemovalPlan,
  RemovalTarget,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
} from "./types.js";

export interface ModelValidationIssue {
  readonly path: readonly (number | string)[];
  readonly message: string;
}

export class ModelValidationError extends Error {
  readonly issues: readonly ModelValidationIssue[];

  constructor(issues: readonly ModelValidationIssue[]) {
    super(issues.map(formatIssue).join("; "));
    this.name = "ModelValidationError";
    this.issues = deepFreeze([...issues]);
  }
}

type MutableIssue = {
  path: (number | string)[];
  message: string;
};

function formatIssue(issue: ModelValidationIssue): string {
  const path = issue.path.length === 0 ? "value" : issue.path.join(".");
  return `${path}: ${issue.message}`;
}

function parseSchema<T>(schema: z.ZodType, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ModelValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? String(segment) : segment,
        ),
        message: issue.message,
      })),
    );
  }

  return result.data as T;
}

function finish<T>(value: T, issues: readonly MutableIssue[]): T {
  if (issues.length > 0) {
    throw new ModelValidationError(issues);
  }
  return deepFreeze(value);
}

function addIssue(
  issues: MutableIssue[],
  path: readonly (number | string)[],
  message: string,
): void {
  issues.push({ path: [...path], message });
}

function duplicateIndexes<T>(
  values: readonly T[],
  key: (value: T) => string,
): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => {
    const identity = key(value);
    if (seen.has(identity)) {
      duplicates.push(index);
    }
    seen.add(identity);
  });
  return duplicates;
}

function targetKey(target: RemovalTarget): string {
  switch (target.kind) {
    case "installation":
      return `installation:${target.installationId}`;
    case "logical-skill":
      return `logical-skill:${target.logicalSkillId}`;
    case "plugin":
      return `plugin:${target.pluginId}`;
  }
}

function referenceKey(reference: InventoryRecordReference): string {
  return reference.kind === "installation"
    ? `installation:${reference.installationId}`
    : `finding:${reference.findingId}`;
}

function hasSameStrongIdentity(
  left: StrongIdentityEvidence,
  right: StrongIdentityEvidence,
): boolean {
  switch (left.kind) {
    case "source":
      return (
        right.kind === "source" &&
        left.sourceId === right.sourceId &&
        left.skillPath === right.skillPath
      );
    case "plugin":
      return (
        right.kind === "plugin" &&
        left.pluginId === right.pluginId &&
        left.skillId === right.skillId
      );
    case "canonical-target":
      return (
        right.kind === "canonical-target" &&
        left.canonicalPath === right.canonicalPath
      );
    case "package":
      return right.kind === "package" && left.packageId === right.packageId;
  }
}

function hasSameWeakIdentity(
  left: WeakIdentityEvidence,
  right: WeakIdentityEvidence,
): boolean {
  switch (left.kind) {
    case "name":
      return (
        right.kind === "name" && left.normalizedName === right.normalizedName
      );
    case "content-hash":
      return (
        right.kind === "content-hash" &&
        left.algorithm === right.algorithm &&
        left.digest === right.digest
      );
  }
}

function validateInstallation(
  installation: Installation,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  const ownership = installation.ownership;

  if (
    installation.scope.kind === "agent" &&
    installation.scope.agentId !== installation.agentId
  ) {
    addIssue(
      issues,
      [...path, "scope", "agentId"],
      "agent scope must match the installation agent",
    );
  }

  if (
    installation.classification === "standalone-project-skill" &&
    installation.scope.kind !== "workspace"
  ) {
    addIssue(
      issues,
      [...path, "scope"],
      "a standalone project skill must use workspace scope",
    );
  }

  if (
    installation.classification === "managed-plugin-resource" &&
    ownership.kind !== "plugin"
  ) {
    addIssue(
      issues,
      [...path, "ownership"],
      "a managed plugin resource must have plugin ownership",
    );
  }

  if (
    ownership.kind === "plugin" &&
    installation.classification !== "managed-plugin-resource"
  ) {
    addIssue(
      issues,
      [...path, "classification"],
      "plugin ownership is reserved for managed plugin resources",
    );
  }

  if (ownership.kind === "plugin") {
    if (installation.plugin?.id !== ownership.pluginId) {
      addIssue(
        issues,
        [...path, "plugin"],
        "plugin reference must match plugin ownership",
      );
    }
  } else if (installation.plugin !== null) {
    addIssue(
      issues,
      [...path, "plugin"],
      "plugin reference requires plugin ownership",
    );
  }

  if (ownership.kind === "manager") {
    if (installation.manager?.id !== ownership.managerId) {
      addIssue(
        issues,
        [...path, "manager"],
        "manager reference must match manager ownership",
      );
    }
  } else if (installation.manager !== null) {
    addIssue(
      issues,
      [...path, "manager"],
      "manager reference requires manager ownership",
    );
  }

  if (ownership.kind === "agent-runtime") {
    addIssue(
      issues,
      [...path, "ownership"],
      "agent runtime content must be represented as a system finding",
    );
  }

  if (installation.protection.system.kind === "system-skill") {
    addIssue(
      issues,
      [...path, "protection", "system"],
      "a system skill cannot be represented as an installation",
    );
  }
}

function validateFinding(
  finding: NonInstallationFinding,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  if (finding.classification !== "system-skill") {
    if (finding.protection.system.kind === "system-skill") {
      addIssue(
        issues,
        [...path, "protection", "system"],
        "system protection requires system-skill classification",
      );
    }
    return;
  }

  const expectedAgentId = finding.agentId;
  if (
    finding.ownership.agentId !== expectedAgentId ||
    finding.protection.system.agentId !== expectedAgentId
  ) {
    addIssue(
      issues,
      path,
      "system skill agent, owner, and protection must identify the same agent",
    );
  }

  if (
    finding.scope?.kind === "agent" &&
    finding.scope.agentId !== expectedAgentId
  ) {
    addIssue(
      issues,
      [...path, "scope", "agentId"],
      "agent scope must match the system skill agent",
    );
  }
}

function validateTargetExists(
  target: RemovalTarget,
  path: readonly (number | string)[],
  installationIds: ReadonlySet<string>,
  logicalSkillIds: ReadonlySet<string>,
  pluginIds: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  const exists =
    target.kind === "installation"
      ? installationIds.has(target.installationId)
      : target.kind === "logical-skill"
        ? logicalSkillIds.has(target.logicalSkillId)
        : pluginIds.has(target.pluginId);

  if (!exists) {
    addIssue(issues, path, `target ${targetKey(target)} does not exist`);
  }
}

function validateInventoryDependencies(
  inventory: Inventory,
  installationIds: ReadonlySet<string>,
  findingIds: ReadonlySet<string>,
  logicalSkillIds: ReadonlySet<string>,
  pluginIds: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  inventory.dependencies.forEach((dependency, dependencyIndex) => {
    const path = ["dependencies", dependencyIndex];

    validateTargetExists(
      dependency.target,
      [...path, "target"],
      installationIds,
      logicalSkillIds,
      pluginIds,
      issues,
    );

    if (dependency.kind === "hard") {
      if (!installationIds.has(dependency.dependentInstallationId)) {
        addIssue(
          issues,
          [...path, "dependentInstallationId"],
          "dependent installation does not exist",
        );
      }
      if (
        dependency.target.kind === "installation" &&
        dependency.target.installationId === dependency.dependentInstallationId
      ) {
        addIssue(
          issues,
          [...path, "target"],
          "a dependency cannot target itself",
        );
      }
    } else {
      const reference = referenceKey(dependency.referringRecord);
      const exists =
        dependency.referringRecord.kind === "installation"
          ? installationIds.has(dependency.referringRecord.installationId)
          : findingIds.has(dependency.referringRecord.findingId);
      if (!exists) {
        addIssue(
          issues,
          [...path, "referringRecord"],
          `${reference} does not exist`,
        );
      }
    }
  });
}

function validateLogicalSkills(
  inventory: Inventory,
  installationsById: ReadonlyMap<string, Installation>,
  issues: MutableIssue[],
): void {
  const groupedInstallations = new Set<string>();

  inventory.logicalSkills.forEach((logicalSkill, logicalIndex) => {
    duplicateIndexes(logicalSkill.installationIds, String).forEach((index) => {
      addIssue(
        issues,
        ["logicalSkills", logicalIndex, "installationIds", index],
        "installation appears more than once in the logical skill",
      );
    });

    logicalSkill.installationIds.forEach(
      (installationId, installationIndex) => {
        const installation = installationsById.get(installationId);
        if (installation === undefined) {
          addIssue(
            issues,
            [
              "logicalSkills",
              logicalIndex,
              "installationIds",
              installationIndex,
            ],
            "installation does not exist",
          );
          return;
        }

        if (groupedInstallations.has(installationId)) {
          addIssue(
            issues,
            [
              "logicalSkills",
              logicalIndex,
              "installationIds",
              installationIndex,
            ],
            "installation already belongs to another logical skill",
          );
        }
        groupedInstallations.add(installationId);

        logicalSkill.identity.strongEvidence.forEach(
          (sharedEvidence, evidenceIndex) => {
            if (
              !installation.identity.strongEvidence.some((evidence) =>
                hasSameStrongIdentity(evidence, sharedEvidence),
              )
            ) {
              addIssue(
                issues,
                [
                  "logicalSkills",
                  logicalIndex,
                  "identity",
                  "strongEvidence",
                  evidenceIndex,
                ],
                `strong evidence is not present on installation ${installationId}`,
              );
            }
          },
        );
      },
    );
  });
}

function validateWeakIdentityHints(
  inventory: Inventory,
  installationsById: ReadonlyMap<string, Installation>,
  issues: MutableIssue[],
): void {
  inventory.identityHints.forEach((hint, hintIndex) => {
    duplicateIndexes(hint.installationIds, String).forEach((index) => {
      addIssue(
        issues,
        ["identityHints", hintIndex, "installationIds", index],
        "installation appears more than once in the identity hint",
      );
    });

    hint.installationIds.forEach((installationId, installationIndex) => {
      const installation = installationsById.get(installationId);
      const path = [
        "identityHints",
        hintIndex,
        "installationIds",
        installationIndex,
      ];
      if (installation === undefined) {
        addIssue(issues, path, "installation does not exist");
      } else if (
        !installation.identity.weakEvidence.some((evidence) =>
          hasSameWeakIdentity(evidence, hint.evidence),
        )
      ) {
        addIssue(
          issues,
          path,
          `weak evidence is not present on installation ${installationId}`,
        );
      }
    });
  });
}

export function parseInstallation(input: unknown): Installation {
  const installation = parseSchema<Installation>(installationSchema, input);
  const issues: MutableIssue[] = [];
  validateInstallation(installation, [], issues);
  return finish(installation, issues);
}

export function parseNonInstallationFinding(
  input: unknown,
): NonInstallationFinding {
  const finding = parseSchema<NonInstallationFinding>(
    nonInstallationFindingSchema,
    input,
  );
  const issues: MutableIssue[] = [];
  validateFinding(finding, [], issues);
  return finish(finding, issues);
}

export function parseLogicalSkill(input: unknown): LogicalSkill {
  return deepFreeze(parseSchema<LogicalSkill>(logicalSkillSchema, input));
}

export function parseInventory(input: unknown): Inventory {
  const inventory = parseSchema<Inventory>(inventorySchema, input);
  const issues: MutableIssue[] = [];

  duplicateIndexes(inventory.installations, (item) => item.id).forEach(
    (index) => {
      addIssue(
        issues,
        ["installations", index, "id"],
        "duplicate installation id",
      );
    },
  );
  duplicateIndexes(inventory.otherFindings, (item) => item.id).forEach(
    (index) => {
      addIssue(issues, ["otherFindings", index, "id"], "duplicate finding id");
    },
  );
  duplicateIndexes(inventory.logicalSkills, (item) => item.id).forEach(
    (index) => {
      addIssue(
        issues,
        ["logicalSkills", index, "id"],
        "duplicate logical skill id",
      );
    },
  );

  inventory.installations.forEach((installation, index) => {
    validateInstallation(installation, ["installations", index], issues);
  });
  inventory.otherFindings.forEach((finding, index) => {
    validateFinding(finding, ["otherFindings", index], issues);
  });

  const installationsById = new Map(
    inventory.installations.map((installation) => [
      installation.id,
      installation,
    ]),
  );
  const installationIds = new Set(installationsById.keys());
  const findingIds = new Set(
    inventory.otherFindings.map((finding) => finding.id),
  );
  const logicalSkillIds = new Set(
    inventory.logicalSkills.map((logicalSkill) => logicalSkill.id),
  );
  const pluginIds = new Set(
    inventory.installations.flatMap((installation) =>
      installation.plugin === null ? [] : [installation.plugin.id],
    ),
  );

  validateLogicalSkills(inventory, installationsById, issues);
  validateWeakIdentityHints(inventory, installationsById, issues);
  validateInventoryDependencies(
    inventory,
    installationIds,
    findingIds,
    logicalSkillIds,
    pluginIds,
    issues,
  );

  return finish(inventory, issues);
}

function hasApproval(
  approvals: readonly ApprovalRequirement[],
  predicate: (approval: ApprovalRequirement) => boolean,
): boolean {
  return approvals.some(predicate);
}

function isBruteForceAction(action: RemovalAction): boolean {
  return action.kind === "quarantine" || action.kind === "record-cleanup";
}

function validateAction(
  action: RemovalAction,
  actionIndex: number,
  priorActionIds: ReadonlySet<string>,
  targetKeys: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  const path = ["actions", actionIndex];
  if (!targetKeys.has(targetKey(action.target))) {
    addIssue(issues, [...path, "target"], "action target is not a plan target");
  }

  duplicateIndexes(action.dependsOn, String).forEach((index) => {
    addIssue(
      issues,
      [...path, "dependsOn", index],
      "dependency appears more than once",
    );
  });
  action.dependsOn.forEach((dependency, dependencyIndex) => {
    if (!priorActionIds.has(dependency)) {
      addIssue(
        issues,
        [...path, "dependsOn", dependencyIndex],
        "action dependencies must reference an earlier action",
      );
    }
  });

  if (
    isBruteForceAction(action) &&
    !hasApproval(
      action.approvals,
      (approval) => approval.kind === "brute-force-confirmation",
    )
  ) {
    addIssue(
      issues,
      [...path, "approvals"],
      "brute-force removal requires separate brute-force confirmation",
    );
  }

  if (action.kind === "managed-removal") {
    if (
      action.owner.kind === "manager" &&
      action.owner.managerId.length === 0
    ) {
      addIssue(issues, [...path, "owner"], "managed removal requires an owner");
    }

    if (action.packageExecution !== null) {
      const packageExecution = action.packageExecution;
      const approved = hasApproval(action.approvals, (approval) =>
        approval.kind === "package-trust"
          ? approval.runner === packageExecution.runner &&
            approval.packageName === packageExecution.packageName &&
            approval.packageVersion === packageExecution.packageVersion &&
            approval.adapterHash === packageExecution.adapterHash
          : false,
      );
      if (!approved) {
        addIssue(
          issues,
          [...path, "approvals"],
          "ephemeral package execution requires matching package trust",
        );
      }
    }
  }
}

function validateBlocks(
  plan: RemovalPlan,
  actionsByTarget: ReadonlyMap<string, readonly RemovalAction[]>,
  targetKeys: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  plan.blocks.forEach((block, blockIndex) => {
    const key = targetKey(block.target);
    if (!targetKeys.has(key)) {
      addIssue(
        issues,
        ["blocks", blockIndex, "target"],
        "block target is not a plan target",
      );
    }
    if (
      block.kind === "hard-dependency" &&
      targetKey(block.dependency.target) !== key
    ) {
      addIssue(
        issues,
        ["blocks", blockIndex, "dependency", "target"],
        "hard dependency target must match the block target",
      );
    }
    const targetActions = actionsByTarget.get(key) ?? [];
    if (!block.overridable && targetActions.length > 0) {
      addIssue(
        issues,
        ["blocks", blockIndex],
        "a non-overridable block cannot have removal actions",
      );
    }
    if (block.overridable && targetActions.length > 0) {
      const safeguard =
        block.kind === "hard-dependency" ? "dependency" : "ambiguity";
      const overridden = targetActions.every((action) =>
        hasApproval(
          action.approvals,
          (approval) =>
            approval.kind === "force-override" &&
            approval.safeguards.includes(safeguard),
        ),
      );
      if (!overridden) {
        addIssue(
          issues,
          ["blocks", blockIndex],
          `actions require a force override for ${safeguard}`,
        );
      }
    }
  });
}

export function parseRemovalPlan(input: unknown): RemovalPlan {
  const plan = parseSchema<RemovalPlan>(removalPlanSchema, input);
  const issues: MutableIssue[] = [];

  duplicateIndexes(plan.targets, targetKey).forEach((index) => {
    addIssue(issues, ["targets", index], "duplicate removal target");
  });
  duplicateIndexes(plan.actions, (action) => action.id).forEach((index) => {
    addIssue(issues, ["actions", index, "id"], "duplicate removal action id");
  });
  duplicateIndexes(plan.verificationChecks, (check) => check.id).forEach(
    (index) => {
      addIssue(
        issues,
        ["verificationChecks", index, "id"],
        "duplicate verification check id",
      );
    },
  );

  const targetKeys = new Set(plan.targets.map(targetKey));
  const actionsByTarget = new Map<string, RemovalAction[]>();
  const priorActionIds = new Set<string>();
  plan.actions.forEach((action, index) => {
    validateAction(action, index, priorActionIds, targetKeys, issues);
    priorActionIds.add(action.id);
    const key = targetKey(action.target);
    actionsByTarget.set(key, [...(actionsByTarget.get(key) ?? []), action]);
  });

  for (const [key, actions] of actionsByTarget) {
    if (
      actions.some((action) => action.kind === "managed-removal") &&
      actions.some(isBruteForceAction)
    ) {
      const index = plan.actions.findIndex(
        (action) =>
          targetKey(action.target) === key && isBruteForceAction(action),
      );
      addIssue(
        issues,
        ["actions", index],
        "managed and brute-force removal require separate plans",
      );
    }
  }

  validateBlocks(plan, actionsByTarget, targetKeys, issues);

  plan.warnings.forEach((warning, index) => {
    if (!targetKeys.has(targetKey(warning.target))) {
      addIssue(
        issues,
        ["warnings", index, "target"],
        "warning target is not a plan target",
      );
    }
  });
  plan.verificationChecks.forEach((check, index) => {
    if (
      check.kind === "target-unavailable" &&
      !targetKeys.has(targetKey(check.target))
    ) {
      addIssue(
        issues,
        ["verificationChecks", index, "target"],
        "verification target is not a plan target",
      );
    }
  });

  return finish(plan, issues);
}

function validateCompletedAfterStarted(
  startedAt: string,
  completedAt: string,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    addIssue(issues, path, "completion time cannot precede start time");
  }
}

function validateExecutionStatus(
  report: ExecutionReport,
  issues: MutableIssue[],
): void {
  const failed =
    report.actionResults.some((result) => result.status === "failed") ||
    report.verificationResults.some((result) => result.status === "failed");
  const blocked =
    report.actionResults.some((result) => result.status === "blocked") ||
    report.targetResults.some((result) => result.status === "blocked");
  const incomplete =
    report.actionResults.some((result) => result.status === "skipped") ||
    report.targetResults.some((result) =>
      ["partially-removed", "unresolved"].includes(result.status),
    );

  if (report.status === "succeeded" && (failed || blocked || incomplete)) {
    addIssue(
      issues,
      ["status"],
      "a succeeded report cannot contain failed, blocked, skipped, or incomplete results",
    );
  }
  if (report.status === "failed" && !failed) {
    addIssue(issues, ["status"], "a failed report requires a failed result");
  }
  if (report.status === "blocked" && !blocked) {
    addIssue(issues, ["status"], "a blocked report requires a blocked result");
  }
  if (report.status === "partial" && !(failed || blocked || incomplete)) {
    addIssue(
      issues,
      ["status"],
      "a partial report requires an incomplete result",
    );
  }
}

export function parseExecutionReport(input: unknown): ExecutionReport {
  const report = parseSchema<ExecutionReport>(executionReportSchema, input);
  const issues: MutableIssue[] = [];

  duplicateIndexes(report.actionResults, (result) => result.actionId).forEach(
    (index) => {
      addIssue(
        issues,
        ["actionResults", index, "actionId"],
        "duplicate action result",
      );
    },
  );
  duplicateIndexes(report.targetResults, (result) =>
    targetKey(result.target),
  ).forEach((index) => {
    addIssue(
      issues,
      ["targetResults", index, "target"],
      "duplicate target result",
    );
  });
  duplicateIndexes(
    report.verificationResults,
    (result) => result.checkId,
  ).forEach((index) => {
    addIssue(
      issues,
      ["verificationResults", index, "checkId"],
      "duplicate verification result",
    );
  });

  validateCompletedAfterStarted(
    report.startedAt,
    report.completedAt,
    ["completedAt"],
    issues,
  );
  report.actionResults.forEach((result, index) => {
    validateCompletedAfterStarted(
      result.startedAt,
      result.completedAt,
      ["actionResults", index, "completedAt"],
      issues,
    );
  });

  const actionResultsById = new Map(
    report.actionResults.map((result, index) => [
      result.actionId,
      { index, result },
    ]),
  );
  report.actionResults.forEach((result, index) => {
    if (result.status !== "blocked") {
      return;
    }
    duplicateIndexes(result.blockedByActionIds, String).forEach(
      (duplicateIndex) => {
        addIssue(
          issues,
          ["actionResults", index, "blockedByActionIds", duplicateIndex],
          "blocking action appears more than once",
        );
      },
    );
    result.blockedByActionIds.forEach((blockingId, blockingIndex) => {
      const blocking = actionResultsById.get(blockingId);
      const path = [
        "actionResults",
        index,
        "blockedByActionIds",
        blockingIndex,
      ];
      if (blocking === undefined) {
        addIssue(issues, path, "blocking action result does not exist");
      } else if (blocking.index >= index) {
        addIssue(issues, path, "blocking action result must appear earlier");
      } else if (
        blocking.result.status !== "failed" &&
        blocking.result.status !== "blocked"
      ) {
        addIssue(
          issues,
          path,
          "blocking action must have failed or been blocked",
        );
      }
    });
  });

  report.targetResults.forEach((result, index) => {
    duplicateIndexes(result.actionIds, String).forEach((duplicateIndex) => {
      addIssue(
        issues,
        ["targetResults", index, "actionIds", duplicateIndex],
        "action appears more than once in the target result",
      );
    });
    result.actionIds.forEach((actionId, actionIndex) => {
      if (!actionResultsById.has(actionId)) {
        addIssue(
          issues,
          ["targetResults", index, "actionIds", actionIndex],
          "action result does not exist",
        );
      }
    });
  });
  validateExecutionStatus(report, issues);

  return finish(report, issues);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child as JsonValue);
  }
  return value;
}
