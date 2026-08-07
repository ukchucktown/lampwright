import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { stringifyModel } from "../model/json.js";
import type {
  ActionResult,
  ApprovalRequirement,
  ExecutionError,
  ExecutionReport,
  Inventory,
  ManagedRemovalAction,
  RecordCleanupAction,
  RemovalAction,
  RemovalPlan,
  RemovalTarget,
  TargetResult,
  VerificationCheck,
  VerificationResult,
} from "../model/types.js";
import {
  parseExecutionApprovals,
  parseExecutionReport,
  parseRemovalPlan,
} from "../model/validation.js";
import type {
  QuarantineProvenance,
  QuarantineProvenanceSubject,
} from "../quarantine/types.js";
import {
  commitRecordCleanup,
  prepareRecordCleanup,
  verifyRecordAbsent,
} from "./records.js";
import { prepareEphemeralExecutionState } from "./state.js";
import type {
  Approvals,
  ExecutionModule,
  ExecutionModuleOptions,
  ExecutionProcessResult,
} from "./types.js";
import { ExecutionModuleError } from "./types.js";

export function createExecutionModule(
  options: ExecutionModuleOptions,
): ExecutionModule {
  validateOptions(options);
  return {
    async execute(planInput, approvalsInput) {
      const plan = parseRemovalPlan(planInput);
      const approvals = parseExecutionApprovals(approvalsInput);
      const startedAt = timestamp(options.now());
      const freshInventory = await scan(options, "freshness");
      const freshPlan = options.replan(freshInventory, plan.intent);

      if (!plansMatch(plan, freshPlan)) {
        return stalePlanReport(plan, freshInventory, startedAt, options.now);
      }

      const actionResults = await executeActions(
        plan,
        approvals,
        freshInventory,
        options,
      );
      let finalInventory: Inventory;
      try {
        finalInventory = await scan(options, "verification");
      } catch (error: unknown) {
        const report = rescanFailureReport(
          plan,
          actionResults,
          startedAt,
          executionError("final-rescan-failed", error),
          options.now,
        );
        await writeAuditIfAttempted(
          plan,
          approvals,
          report,
          actionResults,
          options,
        );
        return report;
      }
      const verificationResults = await verifyPlan(
        plan,
        finalInventory,
        actionResults,
        options,
      );
      const targetResults = createTargetResults(
        plan,
        actionResults,
        verificationResults,
      );
      const fallbackPlans = createFallbackPlans(
        plan,
        actionResults,
        verificationResults,
        finalInventory,
        options,
      );
      const report = parseExecutionReport({
        schemaVersion: 1,
        planId: plan.id,
        inventoryId: plan.inventoryId,
        finalInventoryId: finalInventory.id,
        rescanError: null,
        startedAt,
        completedAt: timestamp(options.now()),
        status: reportStatus(actionResults, targetResults, verificationResults),
        actionResults,
        targetResults,
        verificationResults,
        fallbackPlans,
      });

      await writeAuditIfAttempted(
        plan,
        approvals,
        report,
        actionResults,
        options,
      );
      return report;
    },
  };
}

function validateOptions(options: ExecutionModuleOptions): void {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.scan !== "function" ||
    typeof options.replan !== "function" ||
    typeof options.quarantine?.quarantine !== "function" ||
    typeof options.processRunner?.run !== "function" ||
    typeof options.inspectGitProtection !== "function" ||
    typeof options.auditWriter?.write !== "function" ||
    typeof options.packageTrustStore?.isTrusted !== "function" ||
    typeof options.packageTrustStore?.trust !== "function" ||
    typeof options.now !== "function" ||
    typeof options.stateRoot !== "string" ||
    !isAbsolute(options.stateRoot) ||
    (options.maxConcurrency !== undefined &&
      (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1))
  ) {
    throw new ExecutionModuleError(
      "invalid-options",
      "execution module requires valid side-effect dependencies",
    );
  }
}

async function scan(
  options: ExecutionModuleOptions,
  purpose: "freshness" | "verification",
): Promise<Inventory> {
  try {
    return await options.scan();
  } catch (error: unknown) {
    throw new ExecutionModuleError(
      "scan-failed",
      `execution ${purpose} scan failed`,
      { cause: error },
    );
  }
}

function plansMatch(left: RemovalPlan, rightInput: RemovalPlan): boolean {
  const right = parseRemovalPlan(rightInput);
  return (
    stringifyModel(withoutCreatedAt(left), 0) ===
    stringifyModel(withoutCreatedAt(right), 0)
  );
}

function withoutCreatedAt(plan: RemovalPlan): Omit<RemovalPlan, "createdAt"> {
  const { createdAt, ...semanticPlan } = plan;
  void createdAt;
  return semanticPlan;
}

async function executeActions(
  plan: RemovalPlan,
  approvals: Approvals,
  inventory: Inventory,
  options: ExecutionModuleOptions,
): Promise<readonly ActionResult[]> {
  const results = new Map<string, ActionResult>();
  const remaining = new Set(plan.actions.map((action) => action.id));
  const concurrency = options.maxConcurrency ?? 4;

  while (remaining.size > 0) {
    const ready = plan.actions
      .filter(
        (action) =>
          remaining.has(action.id) &&
          action.dependsOn.every((dependency) => results.has(dependency)),
      )
      .slice(0, concurrency);
    if (ready.length === 0) {
      throw new ExecutionModuleError(
        "invalid-options",
        "fresh plan contains an unschedulable action graph",
      );
    }
    const completed = await Promise.all(
      ready.map((action) =>
        runAction(action, approvals, results, inventory, options),
      ),
    );
    completed.forEach((result) => {
      results.set(result.actionId, result);
      remaining.delete(result.actionId);
    });
  }
  return plan.actions.map((action) => results.get(action.id)!);
}

async function runAction(
  action: RemovalAction,
  approvals: Approvals,
  priorResults: ReadonlyMap<string, ActionResult>,
  inventory: Inventory,
  options: ExecutionModuleOptions,
): Promise<ActionResult> {
  const blockedBy = action.dependsOn.filter((dependency) => {
    const result = priorResults.get(dependency);
    return result?.status !== "succeeded" && result?.status !== "unchanged";
  });
  const startedAt = timestamp(options.now());
  if (blockedBy.length > 0) {
    return {
      actionId: action.id,
      startedAt,
      completedAt: timestamp(options.now()),
      status: "blocked",
      blockedByActionIds: blockedBy as [
        typeof action.id,
        ...(typeof action.id)[],
      ],
      reason: "a prerequisite action did not complete successfully",
    };
  }

  let missing: readonly ApprovalRequirement[];
  try {
    missing = await missingApprovals(action.approvals, approvals, options);
  } catch (error: unknown) {
    return {
      actionId: action.id,
      startedAt,
      completedAt: timestamp(options.now()),
      status: "failed",
      error: executionError("approval-check-failed", error),
    };
  }
  if (missing.length > 0) {
    return {
      actionId: action.id,
      startedAt,
      completedAt: timestamp(options.now()),
      status: "skipped",
      reason: `required approval was not granted: ${missing
        .map((approval) => approval.kind)
        .join(", ")}`,
    };
  }

  try {
    const outcome = await executeAction(action, inventory, options);
    return {
      actionId: action.id,
      startedAt,
      completedAt: timestamp(options.now()),
      ...outcome,
    };
  } catch (error: unknown) {
    return {
      actionId: action.id,
      startedAt,
      completedAt: timestamp(options.now()),
      status: "failed",
      error: executionError(
        action.kind === "managed-removal"
          ? "managed-removal-failed"
          : action.kind === "quarantine"
            ? "quarantine-failed"
            : "record-cleanup-failed",
        error,
      ),
    };
  }
}

async function executeAction(
  action: RemovalAction,
  inventory: Inventory,
  options: ExecutionModuleOptions,
): Promise<
  | {
      readonly status: "succeeded";
      readonly details: Record<string, string | number | boolean | null>;
    }
  | {
      readonly status: "unchanged";
      readonly details: Record<string, string | number | boolean | null>;
    }
  | { readonly status: "skipped"; readonly reason: string }
> {
  switch (action.kind) {
    case "managed-removal":
      return executeManagedRemoval(action, options);
    case "quarantine": {
      const protection = await options.inspectGitProtection(
        action.location.path,
        action.location.artifactType,
      );
      if (protection.kind === "protected") {
        return { status: "skipped", reason: "path became Git-protected" };
      }
      const result = await options.quarantine.quarantine({
        kind: "displaced-artifact",
        location: action.location,
        provenance: provenanceFor(action, inventory),
      });
      return result.status === "already-absent"
        ? {
            status: "unchanged",
            details: { path: result.path, reason: "already absent" },
          }
        : {
            status: "succeeded",
            details: { path: action.location.path, entryId: result.entry.id },
          };
    }
    case "record-cleanup":
      return executeRecordCleanup(action, inventory, options);
  }
}

async function executeManagedRemoval(
  action: ManagedRemovalAction,
  options: ExecutionModuleOptions,
): Promise<
  | {
      readonly status: "succeeded";
      readonly details: Record<string, string | number | boolean | null>;
    }
  | { readonly status: "skipped"; readonly reason: string }
> {
  for (const effect of action.effects) {
    const protection = await options.inspectGitProtection(effect.path);
    if (protection.kind === "protected") {
      return {
        status: "skipped",
        reason: `managed effect became Git-protected: ${effect.path}`,
      };
    }
  }

  if (action.invocation.kind === "direct") {
    const result = await options.processRunner.run({
      command: action.invocation.command,
      environment: ownerPrivacyEnvironment,
    });
    requireSuccessfulOwnerExit(result.exitCode);
    return ownerSuccess(action, result.exitCode, null);
  }

  const packageExecution = action.invocation.packageExecution;
  const state = await prepareEphemeralExecutionState(options.stateRoot);
  let temporaryCleanupSucceeded = true;
  let result: ExecutionProcessResult;
  try {
    result = await options.processRunner.run({
      command: {
        executable: packageExecution.runner,
        arguments: [
          "--yes",
          `${packageExecution.packageName}@${packageExecution.packageVersion}`,
          ...action.invocation.packageArguments,
        ],
      },
      cwd: state.cwd,
      environment: {
        ...ownerPrivacyEnvironment,
        npm_config_cache: state.cache,
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        npm_config_global: "false",
        npm_config_save: "false",
        npm_config_package_lock: "false",
      },
    });
  } finally {
    try {
      await state.cleanup();
    } catch {
      temporaryCleanupSucceeded = false;
    }
  }
  requireSuccessfulOwnerExit(result.exitCode);
  return ownerSuccess(action, result.exitCode, temporaryCleanupSucceeded);
}

const ownerPrivacyEnvironment = {
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
} as const;

function requireSuccessfulOwnerExit(
  exitCode: number | null,
): asserts exitCode is number {
  if (exitCode === 0) return;
  throw new Error(
    `Owner operation exited with ${exitCode === null ? "no exit code" : String(exitCode)}`,
  );
}

function ownerSuccess(
  action: ManagedRemovalAction,
  exitCode: number,
  temporaryCleanupSucceeded: boolean | null,
): {
  readonly status: "succeeded";
  readonly details: Record<string, string | number | boolean | null>;
} {
  return {
    status: "succeeded",
    details: {
      adapterId: action.adapterId,
      operationId: action.operationId,
      exitCode,
      temporaryCleanupSucceeded,
    },
  };
}

async function executeRecordCleanup(
  action: RecordCleanupAction,
  inventory: Inventory,
  options: ExecutionModuleOptions,
): Promise<
  | {
      readonly status: "succeeded";
      readonly details: Record<string, string | number | boolean | null>;
    }
  | {
      readonly status: "unchanged";
      readonly details: Record<string, string | number | boolean | null>;
    }
  | { readonly status: "skipped"; readonly reason: string }
> {
  const protection = await options.inspectGitProtection(
    action.location.path,
    action.location.artifactType,
  );
  if (protection.kind === "protected") {
    return { status: "skipped", reason: "record became Git-protected" };
  }
  const prepared = await prepareRecordCleanup(action);
  if (prepared.status === "already-absent") {
    return {
      status: "unchanged",
      details: { path: action.location.path, reason: "already absent" },
    };
  }
  const capture = await options.quarantine.quarantine({
    kind: "record-cleanup-preimage",
    location: action.location as RecordCleanupAction["location"] & {
      readonly artifactType: { readonly kind: "file" };
    },
    provenance: provenanceFor(action, inventory),
    expectedPreimageHash: prepared.preimageHash,
    expectedPostimageHash: prepared.postimageHash,
  });
  if (capture.status !== "quarantined") {
    throw new Error("record preimage disappeared before capture");
  }
  const commitProtection = await options.inspectGitProtection(
    action.location.path,
    action.location.artifactType,
  );
  if (commitProtection.kind === "protected") {
    throw new Error("record became Git-protected after preimage capture");
  }
  await commitRecordCleanup(
    action.location.path,
    prepared.preimageHash,
    prepared.postimage,
  );
  return {
    status: "succeeded",
    details: {
      path: action.location.path,
      entryId: capture.entry.id,
      recordsRemoved: action.records.length,
    },
  };
}

async function missingApprovals(
  requirements: readonly ApprovalRequirement[],
  approvals: Approvals,
  options: ExecutionModuleOptions,
): Promise<readonly ApprovalRequirement[]> {
  const missing: ApprovalRequirement[] = [];
  for (const requirement of requirements) {
    if (requirement.kind === "package-trust") {
      const decision = {
        runner: requirement.runner,
        packageName: requirement.packageName,
        packageVersion: requirement.packageVersion,
        adapterHash: requirement.adapterHash,
      };
      if (await options.packageTrustStore.isTrusted(decision)) continue;
      if (hasApproval(requirement, approvals.grants)) {
        await options.packageTrustStore.trust(decision);
        continue;
      }
      missing.push(requirement);
    } else if (!hasApproval(requirement, approvals.grants)) {
      missing.push(requirement);
    }
  }
  return missing;
}

function hasApproval(
  requirement: ApprovalRequirement,
  grants: readonly ApprovalRequirement[],
): boolean {
  return grants.some((grant) => {
    if (grant.kind !== requirement.kind) return false;
    switch (requirement.kind) {
      case "confirmation":
      case "brute-force-confirmation":
        return true;
      case "force-override":
        return (
          grant.kind === "force-override" &&
          requirement.safeguards.every((guard) =>
            grant.safeguards.includes(guard),
          )
        );
      case "adapter-trust":
        return (
          grant.kind === "adapter-trust" &&
          grant.adapterId === requirement.adapterId &&
          grant.contentHash === requirement.contentHash
        );
      case "package-trust":
        return (
          grant.kind === "package-trust" &&
          grant.runner === requirement.runner &&
          grant.packageName === requirement.packageName &&
          grant.packageVersion === requirement.packageVersion &&
          grant.adapterHash === requirement.adapterHash
        );
    }
  });
}

async function verifyPlan(
  plan: RemovalPlan,
  inventory: Inventory,
  actionResults: readonly ActionResult[],
  options: ExecutionModuleOptions,
): Promise<readonly VerificationResult[]> {
  const actions = new Map(
    actionResults.map((result) => [result.actionId, result]),
  );
  return Promise.all(
    plan.verificationChecks.map(async (check): Promise<VerificationResult> => {
      if (check.kind !== "target-unavailable") {
        const action = actions.get(check.actionId);
        if (action?.status !== "succeeded" && action?.status !== "unchanged") {
          return {
            checkId: check.id,
            status: "skipped",
            reason: "owning action did not complete successfully",
          };
        }
      }
      try {
        const result = await runVerification(check, inventory, options);
        if (!result.passed) {
          return {
            checkId: check.id,
            status: "failed",
            error: {
              code: "verification-failed",
              message: result.reason,
              details: {},
            },
          };
        }
        return { checkId: check.id, status: "passed", details: result.details };
      } catch (error: unknown) {
        return {
          checkId: check.id,
          status: "failed",
          error: executionError("verification-failed", error),
        };
      }
    }),
  );
}

async function runVerification(
  check: VerificationCheck,
  inventory: Inventory,
  options: ExecutionModuleOptions,
): Promise<
  | {
      readonly passed: true;
      readonly details: Record<string, string | number | boolean | null>;
    }
  | { readonly passed: false; readonly reason: string }
> {
  switch (check.kind) {
    case "target-unavailable":
      return targetExists(check.target, inventory)
        ? { passed: false, reason: "target remains available after execution" }
        : { passed: true, details: { unavailable: true } };
    case "path-absent":
      return (await pathExists(check.path))
        ? { passed: false, reason: `path remains present: ${check.path}` }
        : { passed: true, details: { path: check.path } };
    case "record-absent":
      return (await verifyRecordAbsent(check))
        ? {
            passed: true,
            details: { path: check.path, recordPointer: check.recordPointer },
          }
        : {
            passed: false,
            reason: `record remains present: ${check.recordPointer}`,
          };
    case "owner-state-absent":
      return ownerStateExists(check.owner, check.externalId, inventory)
        ? { passed: false, reason: "Owner state remains present" }
        : { passed: true, details: { externalId: check.externalId } };
    case "command-succeeds": {
      const result = await options.processRunner.run({
        command: check.command,
      });
      return result.exitCode !== null &&
        check.successExitCodes.includes(result.exitCode)
        ? { passed: true, details: { exitCode: result.exitCode } }
        : {
            passed: false,
            reason: `verification command exited with ${result.exitCode === null ? "no exit code" : String(result.exitCode)}`,
          };
    }
  }
}

function createTargetResults(
  plan: RemovalPlan,
  actionResults: readonly ActionResult[],
  verificationResults: readonly VerificationResult[],
): readonly TargetResult[] {
  const byId = new Map(
    actionResults.map((result) => [result.actionId, result]),
  );
  const verificationById = new Map(
    verificationResults.map((result) => [result.checkId, result]),
  );
  return plan.targets.map((target) => {
    const actions = plan.actions.filter((action) =>
      actionTargets(action).some((candidate) => sameTarget(candidate, target)),
    );
    const results = actions.map((action) => byId.get(action.id)!);
    const actionIds = actions.map((action) => action.id);
    const block =
      actions.length === 0
        ? plan.blocks.find((candidate) => sameTarget(candidate.target, target))
        : undefined;
    if (block !== undefined) {
      return {
        target,
        status: "blocked",
        actionIds,
        reason:
          block === undefined
            ? "one or more actions were not approved or became protected"
            : `plan block: ${block.kind}`,
      };
    }
    const succeeded = results.some((result) => result.status === "succeeded");
    const actionFailed = results.some((result) => result.status === "failed");
    if (actionFailed) {
      return {
        target,
        status: succeeded ? "partially-removed" : "failed",
        actionIds,
        reason: "one or more actions failed",
      };
    }
    const interrupted = results.some(
      (result) => result.status === "skipped" || result.status === "blocked",
    );
    if (interrupted) {
      return {
        target,
        status: succeeded ? "partially-removed" : "blocked",
        actionIds,
        reason: succeeded
          ? "one or more sibling actions did not complete"
          : "one or more actions were not approved, became protected, or had a failed prerequisite",
      };
    }
    const failedVerification = plan.verificationChecks.some(
      (check) =>
        verificationAffectsTarget(check, target, actions) &&
        verificationById.get(check.id)?.status === "failed",
    );
    if (failedVerification) {
      return {
        target,
        status: succeeded ? "partially-removed" : "unresolved",
        actionIds,
        reason: "final verification failed",
      };
    }
    return {
      target,
      status: results.some((result) => result.status === "succeeded")
        ? "removed"
        : "unchanged",
      actionIds,
    };
  });
}

function verificationAffectsTarget(
  check: VerificationCheck,
  target: RemovalTarget,
  actions: readonly RemovalAction[],
): boolean {
  if (check.kind === "target-unavailable")
    return sameTarget(check.target, target);
  return actions.some((action) => action.id === check.actionId);
}

function createFallbackPlans(
  plan: RemovalPlan,
  actionResults: readonly ActionResult[],
  verificationResults: readonly VerificationResult[],
  inventory: Inventory,
  options: ExecutionModuleOptions,
): readonly RemovalPlan[] {
  const results = new Map(
    actionResults.map((result) => [result.actionId, result]),
  );
  const verificationById = new Map(
    verificationResults.map((result) => [result.checkId, result]),
  );
  const offers: RemovalPlan[] = [];
  const seen = new Set<string>();
  for (const action of plan.actions) {
    if (
      action.kind !== "managed-removal" ||
      action.fallback.kind !== "available"
    ) {
      continue;
    }
    const actionResult = results.get(action.id);
    const invocationFailed =
      actionResult?.status === "failed" &&
      actionResult.error.code === "managed-removal-failed";
    const verificationFailed = plan.verificationChecks.some(
      (check) =>
        check.kind !== "target-unavailable" &&
        check.actionId === action.id &&
        verificationById.get(check.id)?.status === "failed",
    );
    const remainedAvailable =
      actionResult?.status === "succeeded" &&
      managedActionStillPresent(action, inventory);
    if (!invocationFailed && !verificationFailed && !remainedAvailable)
      continue;
    const key = stringifyModel(action.target, 0);
    if (seen.has(key)) continue;
    try {
      const fallback = parseRemovalPlan(
        options.replan(inventory, {
          kind: "targets",
          targets: [action.target],
          force: false,
          mode: "brute-force",
        }),
      );
      if (
        fallback.intent.mode === "brute-force" &&
        fallback.actions.length > 0
      ) {
        offers.push(fallback);
        seen.add(key);
      }
    } catch {
      // A partially mutated Owner may no longer expose an offerable target.
    }
  }
  return offers;
}

function provenanceFor(
  action: Extract<RemovalAction, { kind: "quarantine" | "record-cleanup" }>,
  inventory: Inventory,
): QuarantineProvenance {
  const subjects: QuarantineProvenanceSubject[] =
    action.affectedInstallationIds.map((installationId) => {
      const installation = inventory.installations.find(
        (candidate) => candidate.id === installationId,
      );
      if (installation === undefined) {
        throw new Error(`affected Installation is absent: ${installationId}`);
      }
      return {
        installationIds: [installationId],
        ownership: installation.ownership,
        adapterId: installation.adapterId,
        source: installation.source,
        plugin:
          installation.ownership.kind === "plugin" ? installation.plugin : null,
        manager:
          installation.ownership.kind === "manager"
            ? installation.manager
            : null,
      };
    });
  if (subjects.length === 0) {
    const pluginTarget = actionTargets(action).find(
      (target): target is Extract<RemovalTarget, { kind: "plugin" }> =>
        target.kind === "plugin",
    );
    const plugin = inventory.plugins.find(
      (candidate) => candidate.id === pluginTarget?.pluginBoundaryId,
    );
    subjects.push(
      plugin === undefined
        ? {
            installationIds: [],
            ownership: { kind: "unknown", confidence: "unknown" },
            adapterId: null,
            source: null,
            plugin: null,
            manager: null,
          }
        : {
            installationIds: [],
            ownership: plugin.ownership,
            adapterId: plugin.adapterId,
            source: null,
            plugin: { id: plugin.pluginId, version: plugin.version },
            manager: null,
          },
    );
  }
  const targets = actionTargets(action);
  return {
    actionId: action.id,
    targets: targets as [RemovalTarget, ...RemovalTarget[]],
    affectedInstallationIds: action.affectedInstallationIds,
    subjects: subjects as [
      QuarantineProvenanceSubject,
      ...QuarantineProvenanceSubject[],
    ],
  };
}

function actionTargets(action: RemovalAction): readonly RemovalTarget[] {
  return action.kind === "record-cleanup"
    ? action.affectedTargets
    : [action.target];
}

function sameTarget(left: RemovalTarget, right: RemovalTarget): boolean {
  return stringifyModel(left, 0) === stringifyModel(right, 0);
}

function targetExists(target: RemovalTarget, inventory: Inventory): boolean {
  switch (target.kind) {
    case "installation":
      return inventory.installations.some(
        (item) => item.id === target.installationId,
      );
    case "logical-skill":
      return inventory.logicalSkills.some(
        (item) => item.id === target.logicalSkillId,
      );
    case "plugin":
      return inventory.plugins.some(
        (item) => item.id === target.pluginBoundaryId,
      );
  }
}

function ownerStateExists(
  owner: ManagedRemovalAction["owner"],
  externalId: string,
  inventory: Inventory,
): boolean {
  return [...inventory.installations, ...inventory.plugins].some((item) => {
    const managed = item.removal.managed;
    return (
      managed?.externalId === externalId &&
      "ownership" in item &&
      stringifyModel(item.ownership, 0) === stringifyModel(owner, 0)
    );
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

function reportStatus(
  actionResults: readonly ActionResult[],
  targetResults: readonly TargetResult[],
  verificationResults: readonly VerificationResult[],
): ExecutionReport["status"] {
  const changed = actionResults.some((result) => result.status === "succeeded");
  const failed =
    actionResults.some((result) => result.status === "failed") ||
    verificationResults.some((result) => result.status === "failed");
  const blocked = targetResults.some((result) => result.status === "blocked");
  const incomplete = targetResults.some(
    (result) =>
      result.status === "partially-removed" || result.status === "unresolved",
  );
  if (failed && !changed) return "failed";
  if (blocked && !changed && !failed && !incomplete) return "blocked";
  if (failed || blocked || incomplete) return "partial";
  return "succeeded";
}

function actionAttempted(result: ActionResult): boolean {
  return result.status === "succeeded" || result.status === "failed";
}

async function writeAuditIfAttempted(
  plan: RemovalPlan,
  approvals: Approvals,
  report: ExecutionReport,
  actionResults: readonly ActionResult[],
  options: ExecutionModuleOptions,
): Promise<void> {
  if (!actionResults.some(actionAttempted)) return;
  try {
    await options.auditWriter.write({
      schemaVersion: 1,
      plan,
      approvals,
      report,
    });
  } catch (error: unknown) {
    throw new ExecutionModuleError(
      "audit-failed",
      "execution completed but its audit record could not be written",
      { cause: error },
    );
  }
}

function executionError(code: string, error: unknown): ExecutionError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function stalePlanReport(
  plan: RemovalPlan,
  inventory: Inventory,
  startedAt: string,
  now: () => Date,
): ExecutionReport {
  const actionResults: ActionResult[] = plan.actions.map((action) => ({
    actionId: action.id,
    startedAt,
    completedAt: timestamp(now()),
    status: "skipped",
    reason: "plan is stale or differs from the fresh plan",
  }));
  const targetResults: TargetResult[] = plan.targets.map((target) => ({
    target,
    status: "blocked",
    actionIds: plan.actions
      .filter((action) =>
        actionTargets(action).some((candidate) =>
          sameTarget(candidate, target),
        ),
      )
      .map((action) => action.id),
    reason: "plan is stale or differs from the fresh plan",
  }));
  return parseExecutionReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: inventory.id,
    rescanError: null,
    startedAt,
    completedAt: timestamp(now()),
    status: "blocked",
    actionResults,
    targetResults,
    verificationResults: [],
    fallbackPlans: [],
  });
}

function rescanFailureReport(
  plan: RemovalPlan,
  actionResults: readonly ActionResult[],
  startedAt: string,
  rescanError: ExecutionError,
  now: () => Date,
): ExecutionReport {
  const targetResults = createUnverifiedTargetResults(plan, actionResults);
  const changed = actionResults.some((result) => result.status === "succeeded");
  return parseExecutionReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: null,
    rescanError,
    startedAt,
    completedAt: timestamp(now()),
    status: changed ? "partial" : "failed",
    actionResults,
    targetResults,
    verificationResults: [],
    fallbackPlans: [],
  });
}

function createUnverifiedTargetResults(
  plan: RemovalPlan,
  actionResults: readonly ActionResult[],
): readonly TargetResult[] {
  const byId = new Map(
    actionResults.map((result) => [result.actionId, result]),
  );
  return plan.targets.map((target) => {
    const actions = plan.actions.filter((action) =>
      actionTargets(action).some((candidate) => sameTarget(candidate, target)),
    );
    const results = actions.map((action) => byId.get(action.id)!);
    const actionIds = actions.map((action) => action.id);
    if (results.some((result) => result.status === "succeeded")) {
      return {
        target,
        status: "partially-removed",
        actionIds,
        reason: "final Inventory rescan failed after mutation",
      };
    }
    if (results.some((result) => result.status === "failed")) {
      return {
        target,
        status: "failed",
        actionIds,
        reason: "action and final Inventory rescan failed",
      };
    }
    if (
      results.some(
        (result) => result.status === "skipped" || result.status === "blocked",
      )
    ) {
      return {
        target,
        status: "blocked",
        actionIds,
        reason: "action did not run and final Inventory rescan failed",
      };
    }
    return {
      target,
      status: "unresolved",
      actionIds,
      reason: "final Inventory rescan failed",
    };
  });
}

function managedActionStillPresent(
  action: ManagedRemovalAction,
  inventory: Inventory,
): boolean {
  if (
    action.affectedInstallationIds.some((installationId) =>
      inventory.installations.some(
        (installation) => installation.id === installationId,
      ),
    )
  ) {
    return true;
  }
  if (action.target.kind !== "plugin") return false;
  const pluginBoundaryId = action.target.pluginBoundaryId;
  return inventory.plugins.some((plugin) => plugin.id === pluginBoundaryId);
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ExecutionModuleError(
      "invalid-options",
      "execution clock returned an invalid date",
    );
  }
  return value.toISOString();
}
