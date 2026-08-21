import { z } from "zod";

import {
  approvalRequirementSchema,
  artifactLocationSchema,
  hardDependencySchema,
  managedOwnershipSchema,
  managedUpdateEvidenceSchema,
  ownershipSchema,
  scopeSchema,
  skillIdentitySchema,
  softReferenceSchema,
  sourceReferenceSchema,
  strongIdentityEvidenceSchema,
  updateRevisionEvidenceSchema,
} from "../model/schemas.js";
import type { UpdateIntent, UpdatePlan, UpdateReport } from "./types.js";

const nonBlank = z.string().refine((value) => value.trim().length > 0);
const timestamp = z.iso.datetime({ offset: true });
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const details = z.record(z.string(), scalar);

export const updateTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), installationId: nonBlank }),
  z.strictObject({
    kind: z.literal("logical-skill"),
    logicalSkillId: nonBlank,
  }),
  z.strictObject({ kind: z.literal("source-group"), groupId: nonBlank }),
  z.strictObject({ kind: z.literal("plugin"), pluginBoundaryId: nonBlank }),
]);

export const updateIntentSchema = z.strictObject({
  target: updateTargetSchema,
  force: z.boolean(),
});

const availabilityExpectationSchema = z.strictObject({
  harnessStatuses: z.array(
    z.strictObject({
      installationId: nonBlank,
      strongEvidence: z.array(strongIdentityEvidenceSchema).min(1),
      harnessId: nonBlank,
      status: z.enum(["enabled", "disabled"]),
    }),
  ),
  pluginStatus: z.enum(["enabled", "disabled", "unresolved"]).nullable(),
});

const lifecycleFactsSchema = z.strictObject({
  adapterId: nonBlank,
  operationId: nonBlank,
  source: sourceReferenceSchema,
  ref: nonBlank.nullable(),
  scope: scopeSchema,
  owner: managedOwnershipSchema,
  externalId: nonBlank,
});

const installationBoundaryFactsSchema = z.strictObject({
  id: nonBlank,
  location: artifactLocationSchema,
  strongEvidence: z.array(strongIdentityEvidenceSchema).min(1),
  source: sourceReferenceSchema.nullable(),
  scope: scopeSchema,
  ownership: ownershipSchema,
  pluginBoundaryId: nonBlank.nullable(),
  lifecycle: lifecycleFactsSchema.nullable(),
});

const pluginBoundaryFactsSchema = z.strictObject({
  id: nonBlank,
  pluginId: nonBlank,
  ownership: z.strictObject({
    kind: z.literal("plugin"),
    pluginId: nonBlank,
    independentlySelectable: z.boolean(),
    confidence: z.enum(["declared", "inferred"]),
  }),
  lifecycle: lifecycleFactsSchema,
});

const updateActionSchema = z.strictObject({
  id: nonBlank,
  kind: z.literal("managed-update"),
  target: updateTargetSchema,
  affectedInstallationIds: z.array(nonBlank),
  dependsOn: z.array(nonBlank),
  approvals: z.array(approvalRequirementSchema),
  operation: managedUpdateEvidenceSchema,
  availabilityExpectation: availabilityExpectationSchema,
  selectedInstallations: z.array(installationBoundaryFactsSchema),
  selectedPlugin: pluginBoundaryFactsSchema.nullable(),
});

const updateBlockSchema = z.strictObject({
  kind: z.enum([
    "unsupported-update",
    "unresolved-update",
    "operation-unavailable",
    "plugin-child",
    "system-skill",
    "runtime-default-plugin",
    "unresolved-availability",
    "git-protection",
    "filesystem-permission",
    "adapter-trust",
    "ambiguous-owner",
    "local-changes",
    "dependency-cycle",
    "independent-boundary",
    "incomplete-authority",
  ]),
  target: updateTargetSchema,
  installationId: nonBlank.nullable(),
  path: z.string().nullable(),
  reason: nonBlank,
  overridable: z.literal(false),
});

const updateWarningSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("network-access"),
    target: updateTargetSchema,
    actionId: nonBlank,
    reason: nonBlank,
  }),
  z.strictObject({
    kind: z.literal("package-download"),
    target: updateTargetSchema,
    actionId: nonBlank,
    packageName: nonBlank,
    packageVersion: nonBlank,
  }),
  z.strictObject({
    kind: z.literal("local-change-unavailable"),
    target: updateTargetSchema,
    installationId: nonBlank.nullable(),
    reason: nonBlank,
  }),
  z.strictObject({
    kind: z.literal("soft-reference"),
    target: updateTargetSchema,
    reference: softReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("hard-dependency"),
    target: updateTargetSchema,
    dependency: hardDependencySchema,
  }),
  z.strictObject({
    kind: z.literal("plugin-impact"),
    target: z.strictObject({
      kind: z.literal("plugin"),
      pluginBoundaryId: nonBlank,
    }),
    pluginId: nonBlank,
    installationIds: z.array(nonBlank),
  }),
]);

const updateVerificationCheckSchema = z.strictObject({
  id: nonBlank,
  actionId: nonBlank,
  target: updateTargetSchema,
  installationId: nonBlank.nullable(),
  pluginBoundaryId: nonBlank.nullable(),
  identity: skillIdentitySchema.nullable(),
  pluginId: nonBlank.nullable(),
  source: sourceReferenceSchema,
  ref: nonBlank.nullable(),
  scope: scopeSchema,
  owner: managedOwnershipSchema,
  currentRevision: z.array(updateRevisionEvidenceSchema).min(1),
  availabilityExpectation: availabilityExpectationSchema,
});

export const updatePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonBlank,
  inventoryId: nonBlank,
  createdAt: timestamp,
  intent: updateIntentSchema,
  targets: z.array(updateTargetSchema).length(1),
  actions: z.array(updateActionSchema),
  blocks: z.array(updateBlockSchema),
  warnings: z.array(updateWarningSchema),
  verificationChecks: z.array(updateVerificationCheckSchema),
});

const errorSchema = z.strictObject({
  code: nonBlank,
  message: nonBlank,
  details,
});
const actionResultBase = {
  actionId: nonBlank,
  startedAt: timestamp,
  completedAt: timestamp,
};
const actionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...actionResultBase,
    status: z.literal("succeeded"),
    details,
  }),
  z.strictObject({
    ...actionResultBase,
    status: z.literal("failed"),
    error: errorSchema,
  }),
  z.strictObject({
    ...actionResultBase,
    status: z.literal("blocked"),
    blockedByActionIds: z.array(nonBlank).min(1),
    reason: nonBlank,
  }),
  z.strictObject({
    ...actionResultBase,
    status: z.literal("skipped"),
    reason: nonBlank,
  }),
]);
const targetResultSchema = z.strictObject({
  target: updateTargetSchema,
  status: z.enum([
    "updated",
    "unchanged",
    "partially-updated",
    "blocked",
    "failed",
    "unresolved",
  ]),
  actionIds: z.array(nonBlank),
  reason: z.string().nullable(),
});
const verificationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    checkId: nonBlank,
    status: z.literal("passed"),
    changed: z.boolean(),
    details,
  }),
  z.strictObject({
    checkId: nonBlank,
    status: z.literal("failed"),
    error: errorSchema,
  }),
  z.strictObject({
    checkId: nonBlank,
    status: z.literal("skipped"),
    reason: nonBlank,
  }),
]);

export const updateReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: nonBlank,
  inventoryId: nonBlank,
  finalInventoryId: nonBlank.nullable(),
  rescanError: errorSchema.nullable(),
  startedAt: timestamp,
  completedAt: timestamp,
  status: z.enum(["succeeded", "partial", "failed", "blocked"]),
  actionResults: z.array(actionResultSchema),
  targetResults: z.array(targetResultSchema).length(1),
  verificationResults: z.array(verificationResultSchema),
});

export function parseUpdateIntent(value: unknown): UpdateIntent {
  return freeze(
    parse<UpdateIntent>(updateIntentSchema, value, "Update intent"),
  );
}

export function parseUpdatePlan(value: unknown): UpdatePlan {
  const plan = parse<UpdatePlan>(updatePlanSchema, value, "Update Plan");
  if (!same(plan.intent.target, plan.targets[0]))
    throw new TypeError(
      "invalid Update Plan: normalized target does not match intent",
    );
  const ids = new Set(plan.actions.map((action) => action.id));
  if (ids.size !== plan.actions.length)
    throw new TypeError("invalid Update Plan: action IDs must be unique");
  if (plan.blocks.length > 0 && plan.actions.length > 0)
    throw new TypeError(
      "invalid Update Plan: blocked plans cannot contain actions",
    );
  for (const action of plan.actions) {
    if (!same(action.target, plan.intent.target))
      throw new TypeError(
        "invalid Update Plan: action target differs from intent",
      );
    if (action.dependsOn.some((id) => !ids.has(id) || id === action.id))
      throw new TypeError("invalid Update Plan: action dependency is invalid");
    if (new Set(action.dependsOn).size !== action.dependsOn.length)
      throw new TypeError(
        "invalid Update Plan: action dependencies must be unique",
      );
    if (new Set(action.approvals.map(key)).size !== action.approvals.length)
      throw new TypeError(
        "invalid Update Plan: action approvals must be unique",
      );
    if (!action.approvals.some((approval) => approval.kind === "confirmation"))
      throw new TypeError(
        "invalid Update Plan: every action requires confirmation",
      );
    const packageApproval = action.approvals.find(
      (approval) => approval.kind === "package-trust",
    );
    if (
      action.operation.invocation.kind === "ephemeral-package"
        ? packageApproval?.kind !== "package-trust" ||
          packageApproval.runner !==
            action.operation.invocation.packageExecution.runner ||
          packageApproval.packageName !==
            action.operation.invocation.packageExecution.packageName ||
          packageApproval.packageVersion !==
            action.operation.invocation.packageExecution.packageVersion ||
          packageApproval.adapterHash !==
            action.operation.invocation.packageExecution.adapterHash
        : packageApproval !== undefined
    )
      throw new TypeError(
        "invalid Update Plan: package approval must match the exact invocation",
      );
    if (action.operation.trust.kind !== "trusted")
      throw new TypeError(
        "invalid Update Plan: untrusted operations cannot be actions",
      );
  }
  if (hasCycle(plan.actions))
    throw new TypeError("invalid Update Plan: action graph contains a cycle");
  const checkIds = new Set(plan.verificationChecks.map((check) => check.id));
  if (checkIds.size !== plan.verificationChecks.length)
    throw new TypeError("invalid Update Plan: verification IDs must be unique");
  if (
    plan.verificationChecks.some(
      (check) =>
        !ids.has(check.actionId) || !same(check.target, plan.intent.target),
    )
  )
    throw new TypeError(
      "invalid Update Plan: verification is not bound to an action",
    );
  if (
    plan.verificationChecks.length !== plan.actions.length ||
    plan.actions.some(
      (action) =>
        plan.verificationChecks.filter((check) => check.actionId === action.id)
          .length !== 1,
    )
  )
    throw new TypeError(
      "invalid Update Plan: every action requires one lifecycle verification",
    );
  for (const check of plan.verificationChecks) {
    const action = plan.actions.find((item) => item.id === check.actionId)!;
    if (
      !same(check.source, action.operation.source) ||
      check.ref !== action.operation.ref ||
      !same(check.scope, action.operation.scope) ||
      !same(check.owner, action.operation.owner) ||
      !same(check.currentRevision, action.operation.currentRevision) ||
      !same(check.availabilityExpectation, action.availabilityExpectation)
    )
      throw new TypeError(
        "invalid Update Plan: verification evidence differs from its action",
      );
  }
  return freeze(plan);
}

export function parseUpdateReport(value: unknown): UpdateReport {
  const report = parse<UpdateReport>(
    updateReportSchema,
    value,
    "Update Report",
  );
  if (report.rescanError !== null && report.verificationResults.length > 0)
    throw new TypeError(
      "invalid Update Report: rescan failures cannot be verified",
    );
  if (
    report.rescanError !== null
      ? report.finalInventoryId !== null
      : report.finalInventoryId === null
  )
    throw new TypeError(
      "invalid Update Report: final Inventory and rescan error are inconsistent",
    );
  if (Date.parse(report.startedAt) > Date.parse(report.completedAt))
    throw new TypeError(
      "invalid Update Report: report timestamps are reversed",
    );
  const actionIds = report.actionResults.map((result) => result.actionId);
  const checkIds = report.verificationResults.map((result) => result.checkId);
  if (
    new Set(actionIds).size !== actionIds.length ||
    new Set(checkIds).size !== checkIds.length
  )
    throw new TypeError("invalid Update Report: result IDs must be unique");
  if (
    report.actionResults.some(
      (result) =>
        Date.parse(result.startedAt) < Date.parse(report.startedAt) ||
        Date.parse(result.completedAt) < Date.parse(result.startedAt) ||
        Date.parse(result.completedAt) > Date.parse(report.completedAt),
    )
  )
    throw new TypeError("invalid Update Report: action timestamps are invalid");
  const target = report.targetResults[0];
  if (
    new Set(target.actionIds).size !== target.actionIds.length ||
    !same([...target.actionIds].sort(), [...actionIds].sort())
  )
    throw new TypeError(
      "invalid Update Report: target action IDs do not match the results",
    );
  const succeeded = report.actionResults.filter(
    (result) => result.status === "succeeded",
  ).length;
  const failed = report.actionResults.some(
    (result) => result.status === "failed",
  );
  const interrupted = report.actionResults.some(
    (result) => result.status === "blocked" || result.status === "skipped",
  );
  const passed = report.verificationResults.filter(
    (result) => result.status === "passed",
  );
  const changed = passed.filter((result) => result.changed).length;
  const verificationFailed = report.verificationResults.some(
    (result) => result.status === "failed",
  );
  const attemptedChecks = report.verificationResults.filter(
    (result) => result.status !== "skipped",
  ).length;
  if (attemptedChecks > succeeded)
    throw new TypeError(
      "invalid Update Report: verification ran without a successful action",
    );
  const completedUpdate =
    report.actionResults.length > 0 &&
    succeeded === report.actionResults.length &&
    report.verificationResults.length === report.actionResults.length &&
    passed.length === report.verificationResults.length;
  const expectedStatus =
    target.status === "updated" || target.status === "unchanged"
      ? "succeeded"
      : target.status === "blocked"
        ? succeeded > 0
          ? "partial"
          : "blocked"
        : target.status === "failed" && succeeded === 0
          ? "failed"
          : "partial";
  if (report.status !== expectedStatus)
    throw new TypeError(
      "invalid Update Report: top-level status differs from the target result",
    );
  if (
    (target.status === "updated" &&
      (!completedUpdate || changed !== passed.length)) ||
    (target.status === "unchanged" && (!completedUpdate || changed !== 0)) ||
    (target.status === "partially-updated" &&
      (changed === 0 || (completedUpdate && changed === passed.length))) ||
    (target.status === "failed" && (!failed || changed > 0)) ||
    (target.status === "blocked" &&
      ((!interrupted && report.actionResults.length > 0) || changed > 0)) ||
    (target.status === "unresolved" &&
      (changed > 0 || (report.rescanError === null && !verificationFailed)))
  )
    throw new TypeError(
      "invalid Update Report: target result differs from action or verification results",
    );
  if (
    report.rescanError !== null &&
    (target.status !== "unresolved" || report.status !== "partial")
  )
    throw new TypeError(
      "invalid Update Report: a final rescan failure must stay unresolved",
    );
  return freeze(report);
}

function parse<T>(schema: z.ZodType, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new TypeError(
      `invalid ${label}: ${result.error.issues.map((issue) => `${issue.path.join(".") || label}: ${issue.message}`).join("; ")}`,
    );
  return result.data as T;
}

function hasCycle(actions: UpdatePlan["actions"]): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(actions.map((action) => [action.id, action]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if (byId.get(id)?.dependsOn.some(visit) === true) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return actions.some((action) => visit(action.id));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function key(value: unknown): string {
  return JSON.stringify(value);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(freeze);
  return value;
}
