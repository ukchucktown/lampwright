import { stringifyModel } from "../model/json.js";
import type { ExecutionApprovals, Inventory } from "../model/types.js";
import type {
  AvailabilityAction,
  AvailabilityActionResult,
  AvailabilityExecutionError,
  AvailabilityPlan,
  AvailabilityReport,
  AvailabilityTarget,
  AvailabilityTargetResult,
  AvailabilityVerificationResult,
} from "../availability/types.js";
import {
  parseAvailabilityPlan,
  parseAvailabilityReport,
} from "../availability/validation.js";
import { parseExecutionApprovals } from "../model/validation.js";
import {
  commitAvailabilityMutation,
  prepareAvailabilityMutations,
} from "./availability-documents.js";
import type { Approvals, ExecutionModuleOptions } from "./types.js";
import { ExecutionModuleError } from "./types.js";

export async function executeAvailabilityPlan(
  planInput: AvailabilityPlan,
  approvalsInput: Approvals,
  options: ExecutionModuleOptions,
): Promise<AvailabilityReport> {
  const plan = parseAvailabilityPlan(planInput);
  const approvals = parseExecutionApprovals(approvalsInput);
  requireDependencies(options);
  const startedAt = timestamp(options.now());
  const freshInventory = await options.scan();
  const freshEntries = await options.disabledStorage!.list();
  const freshPlan = options.replanAvailability!(
    freshInventory,
    freshEntries,
    plan.intent,
  );
  if (!plansMatch(plan, freshPlan))
    return staleReport(plan, freshInventory, startedAt, options.now);

  const attemptedMutations = new Set<string>();
  const actionResults = await executeActions(
    plan,
    approvals,
    options,
    attemptedMutations,
  );
  let finalInventory: Inventory;
  let finalEntries: Awaited<
    ReturnType<NonNullable<ExecutionModuleOptions["disabledStorage"]>["list"]>
  >;
  try {
    finalInventory = await options.scan();
    finalEntries = await options.disabledStorage!.list();
  } catch (error: unknown) {
    const report = unverifiedReport(
      plan,
      actionResults,
      startedAt,
      failure("final-rescan-failed", error),
      options.now,
    );
    await writeAudit(plan, approvals, report, attemptedMutations, options);
    return report;
  }
  const verificationResults = verify(
    plan,
    finalInventory,
    finalEntries,
    actionResults,
  );
  const targetResults = targets(plan, actionResults, verificationResults);
  const report = parseAvailabilityReport({
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
  });
  await writeAudit(plan, approvals, report, attemptedMutations, options);
  return report;
}

function requireDependencies(options: ExecutionModuleOptions): void {
  if (
    typeof options.disabledStorage?.list !== "function" ||
    typeof options.disabledStorage.suspend !== "function" ||
    typeof options.disabledStorage.enable !== "function" ||
    typeof options.replanAvailability !== "function" ||
    typeof options.availabilityAuditWriter?.write !== "function"
  )
    throw new ExecutionModuleError(
      "invalid-options",
      "Availability execution dependencies are not configured",
    );
}

async function executeActions(
  plan: AvailabilityPlan,
  approvals: ExecutionApprovals,
  options: ExecutionModuleOptions,
  attemptedMutations: Set<string>,
): Promise<AvailabilityActionResult[]> {
  const results = new Map<string, AvailabilityActionResult>();
  const remaining = new Set(plan.actions.map((action) => action.id));
  while (remaining.size > 0) {
    const action = plan.actions.find(
      (candidate) =>
        remaining.has(candidate.id) &&
        candidate.dependsOn.every((id) => results.has(id)),
    );
    if (action === undefined)
      throw new ExecutionModuleError(
        "invalid-options",
        "Availability action graph contains a cycle",
      );
    const result = await executeAction(
      action,
      approvals,
      results,
      options,
      attemptedMutations,
    );
    results.set(action.id, result);
    remaining.delete(action.id);
  }
  return plan.actions.map((action) => results.get(action.id)!);
}

async function executeAction(
  action: AvailabilityAction,
  approvals: ExecutionApprovals,
  prior: ReadonlyMap<string, AvailabilityActionResult>,
  options: ExecutionModuleOptions,
  attemptedMutations: Set<string>,
): Promise<AvailabilityActionResult> {
  const startedAt = timestamp(options.now());
  const blockedBy = action.dependsOn.filter((id) => {
    const result = prior.get(id);
    return result?.status !== "succeeded" && result?.status !== "unchanged";
  });
  if (blockedBy.length > 0)
    return {
      actionId: action.id,
      status: "blocked",
      startedAt,
      completedAt: timestamp(options.now()),
      blockedByActionIds: blockedBy as [string, ...string[]],
      reason:
        "a prerequisite Availability action did not complete successfully",
    };
  const missing = action.approvals.filter(
    (requirement) =>
      !approvals.grants.some(
        (grant) => stringifyModel(grant, 0) === stringifyModel(requirement, 0),
      ),
  );
  if (missing.length > 0)
    return {
      actionId: action.id,
      status: "skipped",
      startedAt,
      completedAt: timestamp(options.now()),
      reason: `required approval was not granted: ${missing.map((item) => item.kind).join(", ")}`,
    };
  try {
    let details: Record<string, string | number | boolean | null>;
    let unchanged = false;
    if (action.kind === "native-control") {
      const postimage = await prepareAvailabilityMutations(action.mutations);
      const mutation = action.mutations[0];
      const protection = await options.inspectGitProtection(mutation.path);
      if (protection.kind === "protected")
        throw new Error("native configuration became Git-protected");
      attemptedMutations.add(action.id);
      await commitAvailabilityMutation(mutation, postimage);
      details = {
        path: mutation.path,
        affectedExposures: action.effects.length,
      };
    } else if (action.kind === "suspended-disable") {
      attemptedMutations.add(action.id);
      const result = await options.disabledStorage!.suspend(action.request);
      if (result.status === "blocked")
        throw new Error(
          `Disabled Storage blocked suspension: ${result.reason}`,
        );
      unchanged = result.status === "already-absent";
      details =
        result.status === "suspended"
          ? {
              entryId: result.entry.id,
              path: result.entry.originalLocation.path,
            }
          : { path: result.path, reason: "already absent" };
    } else {
      attemptedMutations.add(action.id);
      const result = await options.disabledStorage!.enable(action.entry);
      if (result.status === "blocked")
        throw new Error(
          `Disabled Storage blocked enablement: ${result.reason}`,
        );
      details = { entryId: result.entryId, destination: result.destination };
    }
    return {
      actionId: action.id,
      status: unchanged ? "unchanged" : "succeeded",
      startedAt,
      completedAt: timestamp(options.now()),
      details,
    };
  } catch (error: unknown) {
    return {
      actionId: action.id,
      status: "failed",
      startedAt,
      completedAt: timestamp(options.now()),
      error: failure(
        action.kind === "native-control"
          ? "native-control-failed"
          : action.kind === "suspended-disable"
            ? "suspension-failed"
            : "enable-failed",
        error,
      ),
    };
  }
}

function verify(
  plan: AvailabilityPlan,
  inventory: Inventory,
  entries: Awaited<
    ReturnType<NonNullable<ExecutionModuleOptions["disabledStorage"]>["list"]>
  >,
  actionResults: readonly AvailabilityActionResult[],
): AvailabilityVerificationResult[] {
  const results = new Map(
    actionResults.map((result) => [result.actionId, result]),
  );
  return plan.verificationChecks.map((check) => {
    if (check.actionId !== null) {
      const owner = results.get(check.actionId);
      if (owner?.status !== "succeeded" && owner?.status !== "unchanged")
        return {
          checkId: check.id,
          status: "skipped",
          reason: "owning action did not complete",
        };
    }
    let passed = false;
    if (check.kind === "disabled-entry-state") {
      const present = entries.some((entry) =>
        check.entryId === null
          ? entry.installationIds.includes(check.installationId)
          : entry.id === check.entryId,
      );
      passed = present === check.expectedPresent;
    } else {
      const installation = inventory.installations.find(
        (item) => item.id === check.installationId,
      );
      const exposure = installation?.harnessExposures.find(
        (item) => item.harnessId === check.harnessId,
      );
      passed = exposure?.status === check.expectedStatus;
      if (
        !passed &&
        check.expectedStatus === "disabled" &&
        installation === undefined
      )
        passed = entries.some((entry) =>
          entry.installationIds.includes(check.installationId),
        );
    }
    return passed
      ? { checkId: check.id, status: "passed", details: {} }
      : {
          checkId: check.id,
          status: "failed",
          error: failure(
            "availability-verification-failed",
            "requested exposure state was not observed",
          ),
        };
  });
}

function targets(
  plan: AvailabilityPlan,
  actions: readonly AvailabilityActionResult[],
  checks: readonly AvailabilityVerificationResult[],
): AvailabilityTargetResult[] {
  const actionById = new Map(
    actions.map((result) => [result.actionId, result]),
  );
  const checkById = new Map(checks.map((result) => [result.checkId, result]));
  return plan.targets.map((target) => {
    const targetActions = plan.actions.filter((action) =>
      action.targets.some((candidate) => sameTarget(candidate, target)),
    );
    const targetChecks = plan.verificationChecks.filter((check) =>
      sameTarget(check.target, target),
    );
    const actionResults = targetActions.map((action) =>
      actionById.get(action.id)!,
    );
    const verificationResults = targetChecks
      .map((check) => checkById.get(check.id)!)
      .filter(Boolean);
    const planBlocked = plan.blocks.some(
      (block) => sameTarget(block.target, target) && !block.overridable,
    );
    if (
      planBlocked ||
      actionResults.some(
        (result) => result.status === "blocked" || result.status === "skipped",
      )
    )
      return {
        target,
        status: "blocked",
        actionIds: targetActions.map((action) => action.id),
        reason: "Availability action is blocked",
      };
    const passed = verificationResults.filter(
      (result) => result.status === "passed",
    ).length;
    const failed = verificationResults.some(
      (result) => result.status === "failed",
    );
    if (
      !failed &&
      verificationResults.length > 0 &&
      passed === verificationResults.length
    )
      return {
        target,
        status:
          targetActions.length === 0
            ? "unchanged"
            : plan.intent.operation === "disable"
              ? "disabled"
              : "enabled",
        actionIds: targetActions.map((action) => action.id),
        reason: null,
      };
    if (actionResults.some((result) => result.status === "succeeded"))
      return {
        target,
        status: "partial",
        actionIds: targetActions.map((action) => action.id),
        reason: "not every Harness Exposure reached the requested state",
      };
    if (actionResults.some((result) => result.status === "failed"))
      return {
        target,
        status: "failed",
        actionIds: targetActions.map((action) => action.id),
        reason: "Availability action failed",
      };
    return {
      target,
      status: "blocked",
      actionIds: targetActions.map((action) => action.id),
      reason: "requested state was not verified",
    };
  });
}

function reportStatus(
  actions: readonly AvailabilityActionResult[],
  targets: readonly AvailabilityTargetResult[],
  checks: readonly AvailabilityVerificationResult[],
): AvailabilityReport["status"] {
  if (
    targets.every((target) =>
      ["disabled", "enabled", "unchanged"].includes(target.status),
    ) &&
    checks.every((check) => check.status === "passed")
  )
    return "succeeded";
  if (actions.some((action) => action.status === "succeeded")) return "partial";
  if (actions.some((action) => action.status === "failed")) return "failed";
  return "blocked";
}

function plansMatch(
  left: AvailabilityPlan,
  rightInput: AvailabilityPlan,
): boolean {
  const right = parseAvailabilityPlan(rightInput);
  const withoutTime = (plan: AvailabilityPlan) => {
    const { createdAt, ...semantic } = plan;
    void createdAt;
    return semantic;
  };
  return (
    stringifyModel(withoutTime(left), 0) ===
    stringifyModel(withoutTime(right), 0)
  );
}

function staleReport(
  plan: AvailabilityPlan,
  inventory: Inventory,
  startedAt: string,
  now: () => Date,
): AvailabilityReport {
  return parseAvailabilityReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: inventory.id,
    rescanError: null,
    startedAt,
    completedAt: timestamp(now()),
    status: "blocked",
    actionResults: plan.actions.map((action) => ({
      actionId: action.id,
      status: "skipped",
      startedAt,
      completedAt: timestamp(now()),
      reason: "plan is stale or differs from the fresh Availability Plan",
    })),
    targetResults: plan.targets.map((target) => ({
      target,
      status: "blocked",
      actionIds: plan.actions
        .filter((action) =>
          action.targets.some((candidate) => sameTarget(candidate, target)),
        )
        .map((action) => action.id),
      reason: "plan is stale or differs from the fresh Availability Plan",
    })),
    verificationResults: [],
  });
}

function unverifiedReport(
  plan: AvailabilityPlan,
  actionResults: readonly AvailabilityActionResult[],
  startedAt: string,
  error: AvailabilityExecutionError,
  now: () => Date,
): AvailabilityReport {
  return parseAvailabilityReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: null,
    rescanError: error,
    startedAt,
    completedAt: timestamp(now()),
    status: actionResults.some((result) => result.status === "succeeded")
      ? "partial"
      : "failed",
    actionResults,
    targetResults: plan.targets.map((target) => ({
      target,
      status: actionResults.some((result) => result.status === "succeeded")
        ? "partial"
        : "failed",
      actionIds: plan.actions
        .filter((action) =>
          action.targets.some((candidate) => sameTarget(candidate, target)),
        )
        .map((action) => action.id),
      reason: "final Inventory or Disabled Storage rescan failed",
    })),
    verificationResults: [],
  });
}

async function writeAudit(
  plan: AvailabilityPlan,
  approvals: ExecutionApprovals,
  report: AvailabilityReport,
  attemptedMutations: ReadonlySet<string>,
  options: ExecutionModuleOptions,
): Promise<void> {
  if (attemptedMutations.size === 0) return;
  await options.availabilityAuditWriter!.write({
    schemaVersion: 1,
    plan,
    approvals,
    report,
  });
}
function failure(code: string, error: unknown): AvailabilityExecutionError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}
function sameTarget(
  left: AvailabilityTarget,
  right: AvailabilityTarget,
): boolean {
  return stringifyModel(left, 0) === stringifyModel(right, 0);
}
function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime()))
    throw new ExecutionModuleError(
      "invalid-options",
      "execution clock returned an invalid date",
    );
  return value.toISOString();
}
