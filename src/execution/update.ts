import { posix, win32 } from "node:path";

import { stringifyModel } from "../model/json.js";
import type {
  ApprovalRequirement,
  ExecutionApprovals,
  Inventory,
  ManagedUpdateEvidence,
} from "../model/types.js";
import { parseExecutionApprovals } from "../model/validation.js";
import type {
  UpdateAction,
  UpdateActionResult,
  UpdateExecutionError,
  UpdatePlan,
  UpdateReport,
  UpdateTargetResult,
  UpdateVerificationCheck,
  UpdateVerificationResult,
} from "../update/types.js";
import { parseUpdatePlan, parseUpdateReport } from "../update/validation.js";
import {
  prepareEphemeralExecutionState,
  prepareIsolatedExecutionWorkingDirectory,
} from "./state.js";
import type {
  Approvals,
  ExecutionModuleOptions,
  ExecutionProcessResult,
} from "./types.js";
import { ExecutionModuleError } from "./types.js";

export async function executeUpdatePlan(
  planInput: UpdatePlan,
  approvalsInput: Approvals,
  options: ExecutionModuleOptions,
): Promise<UpdateReport> {
  requireDependencies(options);
  const plan = parseUpdatePlan(planInput);
  const approvals = parseExecutionApprovals(approvalsInput);
  const startedAt = timestamp(options.now());
  const freshInventory = await scan(options, "freshness");
  let freshPlan: UpdatePlan;
  try {
    freshPlan = options.replanUpdate!(freshInventory, plan.intent);
  } catch {
    return staleReport(plan, freshInventory, startedAt, options.now);
  }
  if (!plansMatch(plan, freshPlan))
    return staleReport(plan, freshInventory, startedAt, options.now);

  const attempted = new Set<string>();
  const actionResults = await executeActions(
    plan,
    approvals,
    options,
    attempted,
  );
  if (attempted.size === 0)
    return noMutationReport(
      plan,
      freshInventory,
      actionResults,
      startedAt,
      options.now,
    );
  let finalInventory: Inventory;
  try {
    finalInventory = await scan(options, "verification");
  } catch (error: unknown) {
    const report = rescanFailureReport(
      plan,
      actionResults,
      startedAt,
      failure("final-rescan-failed", error),
      options.now,
    );
    await writeAudit(plan, approvals, report, attempted, options);
    return report;
  }
  const verificationResults = await verify(
    plan,
    finalInventory,
    actionResults,
    options,
  );
  const targetResult = targetResultFor(
    plan,
    actionResults,
    verificationResults,
  );
  const report = parseUpdateReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: finalInventory.id,
    rescanError: null,
    startedAt,
    completedAt: timestamp(options.now()),
    status: reportStatus(actionResults, targetResult),
    actionResults,
    targetResults: [targetResult],
    verificationResults,
  });
  await writeAudit(plan, approvals, report, attempted, options);
  return report;
}

function requireDependencies(options: ExecutionModuleOptions): void {
  if (
    typeof options.replanUpdate !== "function" ||
    typeof options.updateAuditWriter?.write !== "function"
  )
    throw new ExecutionModuleError(
      "invalid-options",
      "Update execution dependencies are not configured",
    );
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
      `Update execution ${purpose} scan failed`,
      { cause: error },
    );
  }
}

function plansMatch(left: UpdatePlan, rightInput: UpdatePlan): boolean {
  const right = parseUpdatePlan(rightInput);
  const withoutTime = (plan: UpdatePlan) => {
    const { createdAt, ...semantic } = plan;
    void createdAt;
    return semantic;
  };
  return (
    stringifyModel(withoutTime(left), 0) ===
    stringifyModel(withoutTime(right), 0)
  );
}

async function executeActions(
  plan: UpdatePlan,
  approvals: ExecutionApprovals,
  options: ExecutionModuleOptions,
  attempted: Set<string>,
): Promise<UpdateActionResult[]> {
  const results = new Map<string, UpdateActionResult>();
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
    if (ready.length === 0)
      throw new ExecutionModuleError(
        "invalid-options",
        "fresh Update Plan contains an unschedulable action graph",
      );
    const completed = await Promise.all(
      ready.map((action) =>
        executeAction(action, approvals, results, options, attempted),
      ),
    );
    completed.forEach((result) => {
      results.set(result.actionId, result);
      remaining.delete(result.actionId);
    });
  }
  return plan.actions.map((action) => results.get(action.id)!);
}

async function executeAction(
  action: UpdateAction,
  approvals: ExecutionApprovals,
  prior: ReadonlyMap<string, UpdateActionResult>,
  options: ExecutionModuleOptions,
  attempted: Set<string>,
): Promise<UpdateActionResult> {
  const startedAt = timestamp(options.now());
  const blockedBy = action.dependsOn.filter((id) => {
    const result = prior.get(id);
    return result?.status !== "succeeded";
  });
  if (blockedBy.length > 0)
    return {
      actionId: action.id,
      status: "blocked",
      startedAt,
      completedAt: timestamp(options.now()),
      blockedByActionIds: blockedBy as [string, ...string[]],
      reason: "a prerequisite Update action failed or did not run",
    };
  try {
    const missing = await missingApprovals(
      action.approvals,
      approvals,
      options,
    );
    if (missing.length > 0)
      return {
        actionId: action.id,
        status: "skipped",
        startedAt,
        completedAt: timestamp(options.now()),
        reason: `required approval was not granted: ${missing.map((item) => item.kind).join(", ")}`,
      };
    for (const effect of action.operation.effects) {
      const protection = await options.inspectGitProtection(effect.path);
      if (protection.kind === "protected")
        return {
          actionId: action.id,
          status: "skipped",
          startedAt,
          completedAt: timestamp(options.now()),
          reason: `declared Update effect became Git-protected: ${effect.path}`,
        };
    }
    const details = await invoke(action.operation, options, () =>
      attempted.add(action.id),
    );
    return {
      actionId: action.id,
      status: "succeeded",
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
      error: failure("managed-update-failed", error),
    };
  }
}

async function invoke(
  operation: ManagedUpdateEvidence,
  options: ExecutionModuleOptions,
  markAttempted: () => void,
): Promise<Record<string, string | number | boolean | null>> {
  let result: ExecutionProcessResult;
  let cleanupSucceeded = true;
  if (operation.invocation.kind === "direct") {
    const temporary =
      operation.invocation.workingDirectory.kind === "isolated-temporary"
        ? await prepareIsolatedExecutionWorkingDirectory()
        : null;
    try {
      markAttempted();
      const cwd =
        temporary?.cwd ??
        (operation.invocation.workingDirectory.kind === "exact"
          ? operation.invocation.workingDirectory.path
          : undefined);
      result = await options.processRunner.run({
        command: operation.invocation.command,
        ...(cwd === undefined ? {} : { cwd }),
        environment: ownerPrivacyEnvironment,
      });
    } finally {
      if (temporary !== null)
        try {
          await temporary.cleanup();
        } catch {
          cleanupSucceeded = false;
        }
    }
  } else {
    const state = await prepareEphemeralExecutionState(options.stateRoot);
    try {
      const packageExecution = operation.invocation.packageExecution;
      markAttempted();
      result = await options.processRunner.run({
        command: {
          executable: packageExecution.runner,
          arguments: [
            "--yes",
            `${packageExecution.packageName}@${packageExecution.packageVersion}`,
            ...operation.invocation.packageArguments,
          ],
        },
        cwd:
          operation.invocation.workingDirectory.kind === "exact"
            ? operation.invocation.workingDirectory.path
            : state.cwd,
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
        cleanupSucceeded = false;
      }
    }
  }
  if (result.exitCode !== 0) throw new UpdateOwnerProcessError(result);
  return {
    adapterId: operation.adapterId,
    operationId: operation.operationId,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    temporaryCleanupSucceeded: cleanupSucceeded,
  };
}

class UpdateOwnerProcessError extends Error {
  constructor(readonly result: ExecutionProcessResult) {
    super(
      `Owner Update exited with ${result.exitCode === null ? "no exit code" : String(result.exitCode)}`,
    );
    this.name = "UpdateOwnerProcessError";
  }
}

const ownerPrivacyEnvironment = {
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
} as const;

async function missingApprovals(
  requirements: readonly ApprovalRequirement[],
  approvals: ExecutionApprovals,
  options: ExecutionModuleOptions,
): Promise<ApprovalRequirement[]> {
  const missing: ApprovalRequirement[] = [];
  for (const requirement of requirements) {
    const granted = approvals.grants.some(
      (grant) => stringifyModel(grant, 0) === stringifyModel(requirement, 0),
    );
    if (requirement.kind !== "package-trust") {
      if (!granted) missing.push(requirement);
      continue;
    }
    const decision = {
      runner: requirement.runner,
      packageName: requirement.packageName,
      packageVersion: requirement.packageVersion,
      adapterHash: requirement.adapterHash,
    };
    if (await options.packageTrustStore.isTrusted(decision)) continue;
    if (!granted) missing.push(requirement);
    else await options.packageTrustStore.trust(decision);
  }
  return missing;
}

async function verify(
  plan: UpdatePlan,
  inventory: Inventory,
  actionResults: readonly UpdateActionResult[],
  options: ExecutionModuleOptions,
): Promise<UpdateVerificationResult[]> {
  const results = new Map(
    actionResults.map((result) => [result.actionId, result]),
  );
  return Promise.all(
    plan.verificationChecks.map(async (check) => {
      if (results.get(check.actionId)?.status !== "succeeded")
        return {
          checkId: check.id,
          status: "skipped" as const,
          reason: "owning Update action did not complete successfully",
        };
      try {
        return await verifyCheck(
          check,
          plan.actions.find((action) => action.id === check.actionId)!,
          inventory,
          options,
        );
      } catch (error: unknown) {
        return {
          checkId: check.id,
          status: "failed" as const,
          error: failure("update-verification-failed", error),
        };
      }
    }),
  );
}

async function verifyCheck(
  check: UpdateVerificationCheck,
  action: UpdateAction,
  inventory: Inventory,
  options: ExecutionModuleOptions,
): Promise<UpdateVerificationResult> {
  const matchingInstallations =
    check.identity === null
      ? []
      : inventory.installations.filter(
          (item) =>
            stringifyModel(item.identity.strongEvidence, 0) ===
            stringifyModel(check.identity!.strongEvidence, 0),
        );
  const installationByOldId =
    check.installationId === null
      ? undefined
      : inventory.installations.find(
          (item) => item.id === check.installationId,
        );
  const matchingManagedInstallations = matchingInstallations.filter(
    (item) =>
      item.update.kind === "managed" &&
      stringifyModel(item.update.operation.source, 0) ===
        stringifyModel(check.source, 0) &&
      stringifyModel(item.update.operation.scope, 0) ===
        stringifyModel(check.scope, 0) &&
      stringifyModel(item.update.operation.owner, 0) ===
        stringifyModel(check.owner, 0) &&
      item.update.operation.externalId === action.operation.externalId,
  );
  const record =
    check.installationId !== null
      ? (installationByOldId ??
        (matchingManagedInstallations.length === 1
          ? matchingManagedInstallations[0]
          : undefined))
      : check.pluginBoundaryId !== null
        ? inventory.plugins.find((item) => item.id === check.pluginBoundaryId)
        : undefined;
  if (record === undefined)
    return failedCheck(check.id, "the selected lifecycle identity is absent");
  if ("identity" in record) {
    const selected = action.selectedInstallations.find(
      (installation) => installation.id === check.installationId,
    );
    if (selected === undefined || !sameInstallationBoundary(selected, record))
      return failedCheck(
        check.id,
        "the selected Installation lifecycle boundary changed",
      );
  }
  if (
    "identity" in record &&
    stringifyModel(record.identity.strongEvidence, 0) !==
      stringifyModel(check.identity?.strongEvidence, 0)
  )
    return failedCheck(check.id, "strong Skill identity changed");
  if ("pluginId" in record && record.pluginId !== check.pluginId)
    return failedCheck(check.id, "Plugin identity changed");
  if (record.update.kind !== "managed")
    return failedCheck(
      check.id,
      "final Update evidence is not managed and readable",
    );
  const finalOperation = record.update.operation;
  if (
    finalOperation.adapterId !== action.operation.adapterId ||
    finalOperation.operationId !== action.operation.operationId ||
    finalOperation.externalId !== action.operation.externalId ||
    stringifyModel(finalOperation.source, 0) !==
      stringifyModel(check.source, 0) ||
    finalOperation.ref !== check.ref ||
    stringifyModel(finalOperation.scope, 0) !==
      stringifyModel(check.scope, 0) ||
    stringifyModel(finalOperation.owner, 0) !== stringifyModel(check.owner, 0)
  )
    return failedCheck(check.id, "source, ref, Scope, or Owner changed");
  const finalVerificationKeys = new Set(
    finalOperation.verifications.map(verificationKey),
  );
  if (
    action.operation.verifications.some(
      (verification) =>
        !finalVerificationKeys.has(verificationKey(verification)),
    )
  )
    return failedCheck(
      check.id,
      "the final Inventory does not contain every approved verification",
    );
  for (const expectation of check.availabilityExpectation.harnessStatuses) {
    const byOldId = inventory.installations.find(
      (item) => item.id === expectation.installationId,
    );
    const candidates = inventory.installations.filter((item) => {
      if (
        stringifyModel(item.identity.strongEvidence, 0) !==
        stringifyModel(expectation.strongEvidence, 0)
      )
        return false;
      if (check.pluginBoundaryId !== null)
        return item.pluginBoundaryId === check.pluginBoundaryId;
      return (
        item.update.kind === "managed" &&
        stringifyModel(item.update.operation.source, 0) ===
          stringifyModel(check.source, 0) &&
        stringifyModel(item.update.operation.scope, 0) ===
          stringifyModel(check.scope, 0) &&
        stringifyModel(item.update.operation.owner, 0) ===
          stringifyModel(check.owner, 0) &&
        item.update.operation.externalId === action.operation.externalId
      );
    });
    const installation =
      byOldId ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (
      installation?.harnessExposures.find(
        (item) => item.harnessId === expectation.harnessId,
      )?.status !== expectation.status
    )
      return failedCheck(check.id, "the prior Harness Exposure state changed");
  }
  if (check.pluginBoundaryId === null && "harnessExposures" in record) {
    const expectedStatuses = check.availabilityExpectation.harnessStatuses
      .map((expectation) => ({
        harnessId: expectation.harnessId,
        status: expectation.status,
      }))
      .sort((left, right) => left.harnessId.localeCompare(right.harnessId));
    const finalStatuses = record.harnessExposures
      .map((exposure) => ({
        harnessId: exposure.harnessId,
        status: exposure.status,
      }))
      .sort((left, right) => left.harnessId.localeCompare(right.harnessId));
    if (
      stringifyModel(expectedStatuses, 0) !== stringifyModel(finalStatuses, 0)
    )
      return failedCheck(check.id, "the Harness Exposure set changed");
  }
  if (
    check.availabilityExpectation.pluginStatus !== null &&
    "availability" in record &&
    record.availability.status !== check.availabilityExpectation.pluginStatus
  )
    return failedCheck(check.id, "the prior Plugin availability state changed");
  const boundaryFailure = newBoundaryFailure(action, inventory);
  if (boundaryFailure !== null) return failedCheck(check.id, boundaryFailure);
  for (const verification of action.operation.verifications) {
    if (verification.kind !== "command-succeeds") continue;
    const result = await options.processRunner.run({
      command: verification.command,
      environment: ownerPrivacyEnvironment,
    });
    if (
      result.exitCode === null ||
      !verification.successExitCodes.includes(result.exitCode)
    )
      return failedCheck(
        check.id,
        "an approved Owner verification command failed",
      );
  }
  const changed =
    stringifyModel(check.currentRevision, 0) !==
    stringifyModel(finalOperation.currentRevision, 0);
  return {
    checkId: check.id,
    status: "passed",
    changed,
    details: { revisionChanged: changed },
  };
}

function newBoundaryFailure(
  action: UpdateAction,
  inventory: Inventory,
): string | null {
  const paths = action.operation.effects
    .filter((effect) => effect.kind === "mutation-root")
    .map((effect) => effect.path);
  const selectedPlugin =
    action.target.kind === "plugin" ? action.target.pluginBoundaryId : null;
  const newPlugin = inventory.plugins.find(
    (plugin) =>
      plugin.id !== selectedPlugin &&
      pluginBoundaryPaths(plugin, inventory).some((candidate) =>
        paths.some((path) => pathContains(path, candidate)),
      ),
  );
  if (newPlugin !== undefined)
    return "the Update created an independent Plugin inside a declared effect";
  const newInstallation = inventory.installations.find(
    (item) =>
      (selectedPlugin === null || item.pluginBoundaryId !== selectedPlugin) &&
      locationPaths(item.location).some((candidate) =>
        paths.some((path) => pathContains(path, candidate)),
      ) &&
      !action.selectedInstallations.some((selected) =>
        sameInstallationBoundary(selected, item),
      ),
  );
  return newInstallation === undefined
    ? null
    : "the Update created an independent Installation inside a declared effect";
}

function sameInstallationBoundary(
  selected: UpdateAction["selectedInstallations"][number],
  installation: Inventory["installations"][number],
): boolean {
  const lifecycle =
    installation.update.kind === "managed"
      ? {
          adapterId: installation.update.operation.adapterId,
          operationId: installation.update.operation.operationId,
          source: installation.update.operation.source,
          ref: installation.update.operation.ref,
          scope: installation.update.operation.scope,
          owner: installation.update.operation.owner,
          externalId: installation.update.operation.externalId,
        }
      : null;
  return (
    stringifyModel(selected.location, 0) ===
      stringifyModel(installation.location, 0) &&
    stringifyModel(selected.strongEvidence, 0) ===
      stringifyModel(installation.identity.strongEvidence, 0) &&
    stringifyModel(selected.source, 0) ===
      stringifyModel(installation.source, 0) &&
    stringifyModel(selected.scope, 0) ===
      stringifyModel(installation.scope, 0) &&
    stringifyModel(selected.ownership, 0) ===
      stringifyModel(installation.ownership, 0) &&
    selected.pluginBoundaryId === installation.pluginBoundaryId &&
    stringifyModel(selected.lifecycle, 0) === stringifyModel(lifecycle, 0)
  );
}

function pluginBoundaryPaths(
  plugin: Inventory["plugins"][number],
  inventory: Inventory,
): readonly string[] {
  return [
    ...plugin.resources.flatMap((resource) =>
      resource.location === null ? [] : locationPaths(resource.location),
    ),
    ...inventory.installations
      .filter((installation) => installation.pluginBoundaryId === plugin.id)
      .flatMap((installation) => locationPaths(installation.location)),
  ];
}

function locationPaths(
  location: Inventory["installations"][number]["location"],
): readonly string[] {
  return location.canonicalPath === null
    ? [location.path]
    : [location.path, location.canonicalPath];
}

function failedCheck(
  checkId: string,
  message: string,
): UpdateVerificationResult {
  return {
    checkId,
    status: "failed",
    error: { code: "update-verification-failed", message, details: {} },
  };
}

function verificationKey(
  value: ManagedUpdateEvidence["verifications"][number],
): string {
  return value.kind === "revision-manifest-value"
    ? stringifyModel(
        {
          kind: value.kind,
          path: value.path,
          format: value.format,
          recordPointer: value.recordPointer,
        },
        0,
      )
    : stringifyModel(value, 0);
}

function targetResultFor(
  plan: UpdatePlan,
  actions: readonly UpdateActionResult[],
  checks: readonly UpdateVerificationResult[],
): UpdateTargetResult {
  const actionIds = plan.actions.map((action) => action.id);
  if (plan.blocks.length > 0)
    return {
      target: plan.intent.target,
      status: "blocked",
      actionIds,
      reason: "Update is blocked",
    };
  const interrupted = actions.some(
    (item) => item.status === "skipped" || item.status === "blocked",
  );
  const anySucceeded = actions.some((item) => item.status === "succeeded");
  const anyFailed = actions.some((item) => item.status === "failed");
  if (interrupted && !anySucceeded && !anyFailed)
    return {
      target: plan.intent.target,
      status: "blocked",
      actionIds,
      reason: "one or more Update actions did not receive authority",
    };
  const failed = actions.some((item) => item.status === "failed");
  const passed = checks.filter((item) => item.status === "passed");
  const changed = passed.filter(
    (item) => item.status === "passed" && item.changed,
  ).length;
  const verificationFailed = checks.some((item) => item.status === "failed");
  if ((failed || verificationFailed) && changed > 0)
    return {
      target: plan.intent.target,
      status: "partially-updated",
      actionIds,
      reason: "only some Update actions were verified",
    };
  if (failed)
    return {
      target: plan.intent.target,
      status: "failed",
      actionIds,
      reason: "Owner Update failed",
    };
  if (verificationFailed)
    return {
      target: plan.intent.target,
      status: "unresolved",
      actionIds,
      reason: "final lifecycle verification failed",
    };
  if (interrupted && changed > 0)
    return {
      target: plan.intent.target,
      status: "partially-updated",
      actionIds,
      reason: "only some Update actions ran and changed local evidence",
    };
  if (interrupted)
    return {
      target: plan.intent.target,
      status: "blocked",
      actionIds,
      reason: "one or more Update actions did not receive authority",
    };
  if (passed.length !== actions.length)
    return {
      target: plan.intent.target,
      status: "unresolved",
      actionIds,
      reason: "final lifecycle state was not verified",
    };
  if (changed > 0 && changed < passed.length)
    return {
      target: plan.intent.target,
      status: "partially-updated",
      actionIds,
      reason: "some represented Installations changed and others did not",
    };
  return {
    target: plan.intent.target,
    status:
      changed === passed.length && passed.length > 0 ? "updated" : "unchanged",
    actionIds,
    reason: null,
  };
}

function reportStatus(
  actions: readonly UpdateActionResult[],
  target: UpdateTargetResult,
): UpdateReport["status"] {
  if (target.status === "updated" || target.status === "unchanged")
    return "succeeded";
  if (target.status === "partially-updated" || target.status === "unresolved")
    return "partial";
  if (target.status === "blocked")
    return actions.some((item) => item.status === "succeeded")
      ? "partial"
      : "blocked";
  return actions.some((item) => item.status === "succeeded")
    ? "partial"
    : "failed";
}

function staleReport(
  plan: UpdatePlan,
  inventory: Inventory,
  startedAt: string,
  now: () => Date,
): UpdateReport {
  return parseUpdateReport({
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
      reason: "plan is stale or differs from the fresh Update Plan",
    })),
    targetResults: [
      {
        target: plan.intent.target,
        status: "blocked",
        actionIds: plan.actions.map((action) => action.id),
        reason: "plan is stale or differs from the fresh Update Plan",
      },
    ],
    verificationResults: [],
  });
}

function noMutationReport(
  plan: UpdatePlan,
  inventory: Inventory,
  actions: readonly UpdateActionResult[],
  startedAt: string,
  now: () => Date,
): UpdateReport {
  const failed = actions.some((action) => action.status === "failed");
  return parseUpdateReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: inventory.id,
    rescanError: null,
    startedAt,
    completedAt: timestamp(now()),
    status: failed ? "failed" : "blocked",
    actionResults: actions,
    targetResults: [
      {
        target: plan.intent.target,
        status: failed ? "failed" : "blocked",
        actionIds: plan.actions.map((action) => action.id),
        reason: failed
          ? "Update failed before the Owner process started"
          : "Update did not receive mutation authority",
      },
    ],
    verificationResults: [],
  });
}

function rescanFailureReport(
  plan: UpdatePlan,
  actions: readonly UpdateActionResult[],
  startedAt: string,
  error: UpdateExecutionError,
  now: () => Date,
): UpdateReport {
  const attempted = actions.some(
    (item) => item.status === "succeeded" || item.status === "failed",
  );
  return parseUpdateReport({
    schemaVersion: 1,
    planId: plan.id,
    inventoryId: plan.inventoryId,
    finalInventoryId: null,
    rescanError: error,
    startedAt,
    completedAt: timestamp(now()),
    status: attempted ? "partial" : "failed",
    actionResults: actions,
    targetResults: [
      {
        target: plan.intent.target,
        status: "unresolved",
        actionIds: plan.actions.map((action) => action.id),
        reason: "final Inventory scan failed after the Update attempt",
      },
    ],
    verificationResults: [],
  });
}

async function writeAudit(
  plan: UpdatePlan,
  approvals: ExecutionApprovals,
  report: UpdateReport,
  attempted: ReadonlySet<string>,
  options: ExecutionModuleOptions,
): Promise<void> {
  if (attempted.size === 0) return;
  try {
    await options.updateAuditWriter!.write({
      schemaVersion: 1,
      plan,
      approvals,
      report,
    });
  } catch (error: unknown) {
    throw new ExecutionModuleError(
      "audit-failed",
      "Update completed but its audit record could not be written",
      { cause: error },
    );
  }
}

function failure(code: string, error: unknown): UpdateExecutionError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    details:
      error instanceof UpdateOwnerProcessError
        ? {
            exitCode: error.result.exitCode,
            stdout: error.result.stdout,
            stderr: error.result.stderr,
          }
        : {},
  };
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new ExecutionModuleError(
      "invalid-options",
      "execution clock returned an invalid date",
    );
  return value.toISOString();
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
