import { stringifyModel } from "../model/json.js";
import type {
  SessionSetupApprovals,
  SessionSetupConfigurationRequest,
  SessionSetupExecutionOptions,
  SessionSetupPlan,
  SessionSetupReport,
  SessionSetupSnapshot,
  SessionSetupTargetRef,
  SetupApproval,
  SetupActionResult,
  SetupExecutionError,
  SetupPlanAction,
  SetupTargetResult,
  SetupVerificationResult,
} from "./types.js";
import {
  parseSessionSetupPlan,
  parseSessionSetupReport,
  parseSessionSetupSnapshot,
} from "./validation.js";
import { ExecutionModuleError } from "../execution/types.js";
import { selectReadyDependencyActions } from "../execution/dependency-scheduler.js";

/** Execute an approved, fresh native Session setup plan through shared effects. */
export async function executeSessionSetup(
  planInput: SessionSetupPlan,
  approvalsInput: SessionSetupApprovals,
  options: SessionSetupExecutionOptions,
): Promise<SessionSetupReport> {
  const plan = parseSessionSetupPlan(planInput);
  validateOptions(options);
  const approvals = normalizeApprovals(approvalsInput);
  const startedAt = stamp(options.now());
  let fresh: SessionSetupSnapshot;
  let freshPlan: SessionSetupPlan;
  try {
    fresh = parseSessionSetupSnapshot(await options.scan());
    freshPlan = parseSessionSetupPlan(options.replan(fresh, plan.intent));
  } catch {
    return rejectedReport(
      plan,
      startedAt,
      options.now,
      "fresh-scan-failed",
      "the setup plan could not be refreshed safely",
      null,
      failure(
        "fresh-scan-failed",
        "the setup plan could not be refreshed safely",
      ),
    );
  }
  if (!plansMatch(plan, freshPlan))
    return rejectedReport(
      plan,
      startedAt,
      options.now,
      "stale-plan",
      "the approved setup plan differs from the fresh plan",
      fresh.id,
      null,
    );

  const attempted = new Set<string>();
  const actionResults = await executeActions(
    plan,
    approvals,
    options,
    attempted,
  );
  let finalSnapshot: SessionSetupSnapshot;
  try {
    finalSnapshot = parseSessionSetupSnapshot(await options.scan());
  } catch {
    const error = failure(
      "final-rescan-failed",
      "the final setup state could not be verified",
    );
    const report = unverifiedReport(
      plan,
      actionResults,
      startedAt,
      stamp(options.now()),
      error,
    );
    await writeAudit(plan, approvals, report, attempted, options);
    return report;
  }

  const verificationResults = verify(plan, finalSnapshot, actionResults);
  const targetResults = createTargetResults(
    plan,
    actionResults,
    verificationResults,
  );
  const report = buildReport(
    plan,
    startedAt,
    stamp(options.now()),
    reportStatus(actionResults, targetResults, verificationResults),
    actionResults,
    targetResults,
    verificationResults,
    finalSnapshot.id,
    null,
  );
  await writeAudit(plan, approvals, report, attempted, options);
  return report;
}

async function executeActions(
  plan: SessionSetupPlan,
  approvals: SessionSetupApprovals,
  options: SessionSetupExecutionOptions,
  attempted: Set<string>,
): Promise<SetupActionResult[]> {
  const results = new Map<string, SetupActionResult>();
  const remaining = new Set(plan.actions.map((action) => action.id));
  const concurrency = options.maxConcurrency ?? 4;
  while (remaining.size > 0) {
    const ready = selectReadyDependencyActions(
      plan.actions,
      remaining,
      new Set(results.keys()),
      concurrency,
    );
    if (ready.length === 0) {
      for (const action of plan.actions.filter((item) =>
        remaining.has(item.id),
      ))
        results.set(action.id, {
          actionId: action.id,
          status: "blocked",
          blockedByActionIds: [action.id],
        });
      break;
    }
    const completed = await Promise.all(
      ready.map((action) =>
        executeAction(action, plan, approvals, results, options, attempted),
      ),
    );
    for (const result of completed) {
      results.set(result.actionId, result);
      remaining.delete(result.actionId);
    }
  }
  return plan.actions.map((action) => results.get(action.id)!);
}

async function executeAction(
  action: SetupPlanAction,
  plan: SessionSetupPlan,
  approvals: SessionSetupApprovals,
  prior: ReadonlyMap<string, SetupActionResult>,
  options: SessionSetupExecutionOptions,
  attempted: Set<string>,
): Promise<SetupActionResult> {
  const blockedBy = action.dependsOn.filter((id) => {
    const result = prior.get(id);
    return result?.status !== "succeeded" && result?.status !== "unchanged";
  });
  if (blockedBy.length > 0)
    return {
      actionId: action.id,
      status: "blocked",
      blockedByActionIds: blockedBy as [string, ...string[]],
    };
  if (
    action.approvals.some(
      (requirement) =>
        !approvals.grants.some(
          (grant) =>
            stringifyModel(grant, 0) === stringifyModel(requirement, 0),
        ),
    )
  )
    return {
      actionId: action.id,
      status: "blocked",
      blockedByActionIds: [action.id],
    };

  if (actionAlreadySatisfied(action, plan))
    return { actionId: action.id, status: "unchanged" };

  const kinds = new Set(action.mutations.map((mutation) => mutation.kind));
  if (kinds.size !== 1)
    return failedAction(
      action,
      "invalid-native-method",
      "the planned native method is inconsistent",
    );
  return action.mutations[0]!.kind === "configuration"
    ? executeConfigurationAction(action, plan, options, attempted)
    : executeCommandAction(action, options, attempted);
}

function actionAlreadySatisfied(
  action: SetupPlanAction,
  plan: SessionSetupPlan,
): boolean {
  const expected = action.operation === "enable" ? "enabled" : "disabled";
  return action.targets.every((ref) => {
    const target = plan.targets.find(
      (candidate) => candidate.id === ref.targetId,
    );
    return (
      target?.state.policy === expected &&
      target.state.effectiveWorkspaceState === expected
    );
  });
}

async function executeConfigurationAction(
  action: SetupPlanAction,
  plan: SessionSetupPlan,
  options: SessionSetupExecutionOptions,
  attempted: Set<string>,
): Promise<SetupActionResult> {
  let request: SessionSetupConfigurationRequest;
  try {
    request = configurationRequest(action, plan);
  } catch {
    return failedAction(
      action,
      "invalid-configuration-authority",
      "the native configuration authority is incomplete",
    );
  }
  let prepared: Awaited<
    ReturnType<SessionSetupExecutionOptions["configurationWriter"]["prepare"]>
  >;
  try {
    prepared = await options.configurationWriter.prepare(request);
  } catch {
    return failedAction(
      action,
      "configuration-prepare-failed",
      "the native configuration could not be prepared safely",
    );
  }
  if (prepared.status === "unchanged")
    return { actionId: action.id, status: "unchanged" };
  try {
    const protection = await options.inspectGitProtection(request.path, {
      kind: "file",
    });
    if (protection.kind === "protected")
      return await discardAndFail(
        prepared,
        options,
        action,
        "configuration-protected",
        "the native configuration became Git-protected",
      );
  } catch {
    return await discardAndFail(
      prepared,
      options,
      action,
      "protection-check-failed",
      "the native configuration protection could not be verified",
    );
  }
  attempted.add(action.id);
  try {
    await options.configurationWriter.commit(prepared);
    return { actionId: action.id, status: "succeeded" };
  } catch {
    return failedAction(
      action,
      "configuration-write-failed",
      "the native configuration changed or could not be written safely",
    );
  }
}

async function executeCommandAction(
  action: SetupPlanAction,
  options: SessionSetupExecutionOptions,
  attempted: Set<string>,
): Promise<SetupActionResult> {
  const mutations = action.mutations.filter(
    (mutation) => mutation.kind === "native-command",
  );
  const first = mutations[0];
  if (
    !first ||
    mutations.some(
      (mutation) =>
        stringifyModel(mutation.authority, 0) !==
        stringifyModel(first.authority, 0),
    )
  )
    return failedAction(
      action,
      "invalid-native-command",
      "the planned native command authority is inconsistent",
    );
  attempted.add(action.id);
  try {
    const result = await options.processRunner.run({
      command: {
        executable: first.authority.executable,
        arguments: first.authority.arguments,
      },
    });
    if (result.exitCode === null)
      return failedAction(
        action,
        "native-command-unavailable",
        "the planned native command is unavailable",
      );
    if (result.exitCode !== 0)
      return failedAction(
        action,
        "native-command-failed",
        "the planned native command failed",
      );
    return { actionId: action.id, status: "succeeded" };
  } catch {
    return failedAction(
      action,
      "native-command-failed",
      "the planned native command failed",
    );
  }
}

function configurationRequest(
  action: SetupPlanAction,
  plan: SessionSetupPlan,
): SessionSetupConfigurationRequest {
  const mutations = action.mutations.filter(
    (mutation) => mutation.kind === "configuration",
  );
  if (mutations.length !== action.mutations.length || mutations.length === 0)
    throw new Error("action is not a configuration action");
  const layers = mutations.map((mutation) => {
    const target = plan.targets.find(
      (candidate) =>
        candidate.control.selector.id === mutation.selectorId &&
        candidate.control.availability[action.operation].kind === "available",
    );
    const layer = target?.control.layers.find(
      (candidate) =>
        candidate.source.sourceId === mutation.authority.layerSourceId &&
        candidate.canonicalPath === mutation.authority.layerCanonicalPath,
    );
    if (!layer || layer.canonicalPath === null)
      throw new Error("missing configuration layer");
    return layer;
  });
  const first = layers[0]!;
  if (
    layers.some(
      (layer) =>
        layer.canonicalPath !== first.canonicalPath ||
        layer.format !== first.format ||
        layer.exists !== first.exists ||
        stringifyModel(layer.expectedPreimage, 0) !==
          stringifyModel(first.expectedPreimage, 0),
    )
  )
    throw new Error("configuration action crosses documents");
  const selectors = mutations.map(
    (mutation) =>
      plan.targets.find(
        (target) => target.control.selector.id === mutation.selectorId,
      )!.control.selector,
  );
  return {
    path: first.canonicalPath!,
    format: first.format,
    exists: first.exists,
    expectedPreimage: first.expectedPreimage,
    selectors: [selectors[0]!, ...selectors.slice(1)],
    mutations: [mutations[0]!, ...mutations.slice(1)],
  };
}

function verify(
  plan: SessionSetupPlan,
  snapshot: SessionSetupSnapshot,
  actionResults: readonly SetupActionResult[],
): SetupVerificationResult[] {
  return plan.verifications.map((verification) => {
    const action = plan.actions.find((candidate) =>
      candidate.targets.some(
        (target) => target.targetId === verification.target.targetId,
      ),
    );
    const result = action
      ? actionResults.find((candidate) => candidate.actionId === action.id)
      : undefined;
    if (
      !result ||
      (result.status !== "succeeded" && result.status !== "unchanged")
    )
      return { verificationId: verification.id, status: "skipped" };
    const target = snapshot.targets.find(
      (candidate) => candidate.id === verification.target.targetId,
    );
    if (!target)
      return failedVerification(
        verification.id,
        "target-missing",
        "the target is absent from the final setup snapshot",
      );
    if (verification.kind === "native-policy")
      return target.state.policy === verification.expectedPolicy
        ? { verificationId: verification.id, status: "passed" }
        : failedVerification(
            verification.id,
            "policy-not-saved",
            "the saved native policy does not match the plan",
          );
    if (verification.kind === "effective-workspace-state")
      return target.state.effectiveWorkspaceState === verification.expected
        ? { verificationId: verification.id, status: "passed" }
        : failedVerification(
            verification.id,
            "effective-state-mismatch",
            "the effective workspace state does not match the plan",
          );
    return { verificationId: verification.id, status: "passed" };
  });
}

function createTargetResults(
  plan: SessionSetupPlan,
  actionResults: readonly SetupActionResult[],
  verificationResults: readonly SetupVerificationResult[],
): SetupTargetResult[] {
  return plan.intent.targets.map((target) => {
    if (plan.blocks.some((block) => block.target.targetId === target.targetId))
      return blockedTarget(
        target,
        "plan-blocked",
        "the setup target is blocked",
      );
    const action = plan.actions.find((candidate) =>
      candidate.targets.some((item) => item.targetId === target.targetId),
    );
    const result = action
      ? actionResults.find((candidate) => candidate.actionId === action.id)
      : undefined;
    if (!result)
      return blockedTarget(
        target,
        "action-missing",
        "the setup target has no executable action",
      );
    if (result.status === "failed")
      return { target, status: "failed", error: result.error };
    if (result.status === "blocked")
      return blockedTarget(
        target,
        "action-blocked",
        "the setup action did not run",
      );
    const failed = verificationResults.find(
      (verification) =>
        verification.status === "failed" &&
        plan.verifications.find(
          (candidate) => candidate.id === verification.verificationId,
        )?.target.targetId === target.targetId,
    );
    if (failed?.status === "failed")
      return { target, status: "unverified", error: failed.error };
    return {
      target,
      status:
        result.status === "unchanged"
          ? "unchanged"
          : plan.intent.action === "enable"
            ? "enabled"
            : "disabled",
    };
  });
}

function unverifiedReport(
  plan: SessionSetupPlan,
  actionResults: readonly SetupActionResult[],
  startedAt: string,
  completedAt: string,
  error: SetupExecutionError,
): SessionSetupReport {
  const targetResults = plan.intent.targets.map<SetupTargetResult>((target) => {
    if (plan.blocks.some((block) => block.target.targetId === target.targetId))
      return blockedTarget(
        target,
        "plan-blocked",
        "the setup target is blocked",
      );
    const action = plan.actions.find((candidate) =>
      candidate.targets.some((item) => item.targetId === target.targetId),
    );
    const result = action
      ? actionResults.find((candidate) => candidate.actionId === action.id)
      : undefined;
    if (result?.status === "failed")
      return { target, status: "failed", error: result.error };
    if (!result || result.status === "blocked")
      return blockedTarget(
        target,
        "action-blocked",
        "the setup action did not run",
      );
    return { target, status: "unverified", error };
  });
  return buildReport(
    plan,
    startedAt,
    completedAt,
    actionResults.some(
      (result) =>
        result.status === "succeeded" || result.status === "unchanged",
    )
      ? "partial"
      : actionResults.some((result) => result.status === "failed")
        ? "failed"
        : "blocked",
    actionResults,
    targetResults,
    plan.verifications.map((verification) => ({
      verificationId: verification.id,
      status: "skipped" as const,
    })),
    null,
    error,
  );
}

function rejectedReport(
  plan: SessionSetupPlan,
  startedAt: string,
  now: () => Date,
  code: string,
  message: string,
  finalSnapshotId: string | null,
  rescanError: SetupExecutionError | null,
): SessionSetupReport {
  return buildReport(
    plan,
    startedAt,
    stamp(now()),
    "blocked",
    plan.actions.map((action) => ({
      actionId: action.id,
      status: "blocked" as const,
      blockedByActionIds: [action.id] as [string, ...string[]],
    })),
    plan.intent.targets.map((target) => blockedTarget(target, code, message)),
    [],
    finalSnapshotId,
    rescanError,
  );
}

function buildReport(
  plan: SessionSetupPlan,
  startedAt: string,
  completedAt: string,
  status: SessionSetupReport["status"],
  actionResults: readonly SetupActionResult[],
  targetResults: readonly SetupTargetResult[],
  verificationResults: readonly SetupVerificationResult[],
  finalSnapshotId: string | null,
  rescanError: SetupExecutionError | null,
): SessionSetupReport {
  return parseSessionSetupReport({
    schemaVersion: 1,
    kind: "session-setup-report",
    planId: plan.id,
    snapshotId: plan.snapshotId,
    startedAt,
    completedAt,
    status,
    actionResults,
    targetResults,
    verificationResults,
    finalSnapshotId,
    rescanError,
  });
}

function reportStatus(
  actions: readonly SetupActionResult[],
  targets: readonly SetupTargetResult[],
  verifications: readonly SetupVerificationResult[],
): SessionSetupReport["status"] {
  const completed = targets.every((target) =>
    ["enabled", "disabled", "unchanged"].includes(target.status),
  );
  const verified = verifications.every(
    (verification) => verification.status === "passed",
  );
  if (completed && verified)
    return actions.length > 0 &&
      actions.every((action) => action.status === "unchanged")
      ? "unchanged"
      : "succeeded";
  if (
    actions.some(
      (action) =>
        action.status === "succeeded" || action.status === "unchanged",
    )
  )
    return "partial";
  if (actions.some((action) => action.status === "failed")) return "failed";
  return "blocked";
}

async function writeAudit(
  plan: SessionSetupPlan,
  approvals: SessionSetupApprovals,
  report: SessionSetupReport,
  attempted: ReadonlySet<string>,
  options: SessionSetupExecutionOptions,
): Promise<void> {
  if (attempted.size === 0) return;
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
      "Session setup completed but its audit record could not be written",
      { cause: error },
    );
  }
}

function plansMatch(left: SessionSetupPlan, right: SessionSetupPlan): boolean {
  const semantic = (plan: SessionSetupPlan) => {
    const { createdAt, snapshotId, ...value } = plan;
    void createdAt;
    void snapshotId;
    return value;
  };
  return (
    stringifyModel(semantic(left), 0) === stringifyModel(semantic(right), 0)
  );
}

function normalizeApprovals(
  approvals: SessionSetupApprovals,
): SessionSetupApprovals {
  if (!approvals || !Array.isArray(approvals.grants))
    throw new ExecutionModuleError(
      "invalid-options",
      "Session setup approvals must contain a grant list",
    );
  const grants = approvals.grants.map((grant): SetupApproval => {
    if (!grant || typeof grant !== "object") throw invalidApprovals();
    const value = grant as unknown as Record<string, unknown>;
    if (
      value.kind === "confirmation" &&
      value.required === true &&
      exactKeys(value, ["kind", "required"])
    )
      return { kind: "confirmation", required: true };
    if (
      value.kind !== "scope-disclosure" ||
      value.required !== true ||
      !exactKeys(value, ["kind", "required", "scope"]) ||
      !value.scope ||
      typeof value.scope !== "object"
    )
      throw invalidApprovals();
    const scope = value.scope as Record<string, unknown>;
    if (scope.kind === "user" && exactKeys(scope, ["kind"]))
      return {
        kind: "scope-disclosure",
        scope: { kind: "user" },
        required: true,
      };
    if (
      scope.kind === "workspace" &&
      typeof scope.workspacePath === "string" &&
      scope.workspacePath.trim() &&
      exactKeys(scope, ["kind", "workspacePath"])
    )
      return {
        kind: "scope-disclosure",
        scope: { kind: "workspace", workspacePath: scope.workspacePath },
        required: true,
      };
    if (
      scope.kind === "agent" &&
      ["codex", "claude-code", "gemini-cli"].includes(String(scope.agentId)) &&
      exactKeys(scope, ["agentId", "kind"])
    )
      return {
        kind: "scope-disclosure",
        scope: {
          kind: "agent",
          agentId: scope.agentId as "codex" | "claude-code" | "gemini-cli",
        },
        required: true,
      };
    throw invalidApprovals();
  });
  return { grants };
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function invalidApprovals(): ExecutionModuleError {
  return new ExecutionModuleError(
    "invalid-options",
    "Session setup approvals contain an invalid grant",
  );
}

function validateOptions(options: SessionSetupExecutionOptions): void {
  if (
    !options ||
    typeof options.scan !== "function" ||
    typeof options.replan !== "function" ||
    typeof options.configurationWriter?.prepare !== "function" ||
    typeof options.configurationWriter.commit !== "function" ||
    typeof options.configurationWriter.discard !== "function" ||
    typeof options.processRunner?.run !== "function" ||
    typeof options.inspectGitProtection !== "function" ||
    typeof options.auditWriter?.write !== "function" ||
    typeof options.now !== "function" ||
    (options.maxConcurrency !== undefined &&
      (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1))
  )
    throw new ExecutionModuleError(
      "invalid-options",
      "Session setup execution dependencies are not configured",
    );
}

async function discardAndFail(
  prepared: Awaited<
    ReturnType<SessionSetupExecutionOptions["configurationWriter"]["prepare"]>
  >,
  options: SessionSetupExecutionOptions,
  action: SetupPlanAction,
  code: string,
  message: string,
): Promise<SetupActionResult> {
  try {
    await options.configurationWriter.discard(prepared);
  } catch {
    // Discard is best-effort and cannot replace the original safety result.
  }
  return failedAction(action, code, message);
}

function blockedTarget(
  target: SessionSetupTargetRef,
  code: string,
  message: string,
): SetupTargetResult {
  return { target, status: "blocked", error: failure(code, message) };
}

function failedAction(
  action: SetupPlanAction,
  code: string,
  message: string,
): SetupActionResult {
  return {
    actionId: action.id,
    status: "failed",
    error: failure(code, message),
  };
}

function failedVerification(
  verificationId: string,
  code: string,
  message: string,
): SetupVerificationResult {
  return { verificationId, status: "failed", error: failure(code, message) };
}

function failure(code: string, message: string): SetupExecutionError {
  return { code, message };
}

function stamp(value: Date): string {
  if (!Number.isFinite(value.getTime()))
    throw new ExecutionModuleError(
      "invalid-options",
      "Session setup execution clock returned an invalid date",
    );
  return value.toISOString();
}
