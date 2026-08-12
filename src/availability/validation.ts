import { z } from "zod";

import {
  disabledEntrySchema,
  suspendRequestSchema,
} from "../disabled-storage/schema.js";
import {
  approvalRequirementSchema,
  hardDependencySchema,
  protectionStatusSchema,
  sha256DigestSchema,
  softReferenceSchema,
} from "../model/schemas.js";
import type {
  AvailabilityIntent,
  AvailabilityPlan,
  AvailabilityReport,
} from "./types.js";

const nonBlank = z.string().refine((value) => value.trim().length > 0);
const timestamp = z.iso.datetime({ offset: true });
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const details = z.record(z.string(), scalar);

export const availabilityTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), installationId: nonBlank }),
  z.strictObject({
    kind: z.literal("logical-skill"),
    logicalSkillId: nonBlank,
  }),
  z.strictObject({
    kind: z.literal("plugin"),
    pluginBoundaryId: nonBlank,
  }),
  z.strictObject({ kind: z.literal("source-group"), groupId: nonBlank }),
]);

export const availabilityIntentSchema = z.strictObject({
  operation: z.enum(["disable", "enable"]),
  targets: z.array(availabilityTargetSchema).min(1),
  force: z.boolean(),
});

const mutationOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("codex-skills-config"),
    selectorPath: nonBlank,
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("claude-skill-overrides"),
    skillName: nonBlank,
    mode: z.enum(["on", "off"]),
  }),
  z.strictObject({
    kind: z.literal("gemini-disabled-skills"),
    skillName: nonBlank,
    disabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("codex-plugin-enabled"),
    pluginId: nonBlank,
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("claude-enabled-plugins"),
    pluginId: nonBlank,
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("gemini-extension-enablement"),
    pluginId: nonBlank,
    scopePath: nonBlank,
    enabled: z.boolean(),
  }),
]);

const nativeMutationSchema = z.strictObject({
  path: nonBlank,
  format: z.enum(["toml", "json", "jsonc"]),
  documentScope: z.enum([
    "user",
    "shared-workspace",
    "local-workspace",
    "workspace",
  ]),
  exists: z.boolean(),
  expectedPreimageHash: sha256DigestSchema.nullable(),
  protection: protectionStatusSchema,
  operation: mutationOperationSchema,
});

const actionBase = {
  id: nonBlank,
  targets: z.array(availabilityTargetSchema).min(1),
  dependsOn: z.array(nonBlank),
  approvals: z.array(approvalRequirementSchema),
};

export const availabilityActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...actionBase,
    kind: z.literal("native-control"),
    affectedInstallationIds: z.array(nonBlank),
    effects: z
      .array(
        z.union([
          z.strictObject({
            installationId: nonBlank,
            harnessId: nonBlank,
            operation: z.enum(["disable", "enable"]),
          }),
          z.strictObject({
            pluginBoundaryId: nonBlank,
            harnessId: nonBlank,
            operation: z.enum(["disable", "enable"]),
          }),
        ]),
      )
      .min(1),
    mutations: z.array(nativeMutationSchema).min(1),
  }),
  z.strictObject({
    ...actionBase,
    kind: z.literal("suspended-disable"),
    affectedInstallationIds: z.array(nonBlank).min(1),
    installationId: nonBlank,
    request: suspendRequestSchema,
  }),
  z.strictObject({
    ...actionBase,
    kind: z.literal("suspended-enable"),
    affectedInstallationIds: z.array(nonBlank).min(1),
    entry: disabledEntrySchema,
  }),
]);

const blockSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hard-dependency"),
    target: availabilityTargetSchema,
    dependency: hardDependencySchema,
    overridable: z.literal(true),
  }),
  z.strictObject({
    kind: z.enum([
      "name-collision",
      "unresolved-exposure",
      "unsupported-control",
      "ownership",
      "system-skill",
      "git-protection",
      "filesystem-permission",
      "configuration-unsafe",
      "entry-not-found",
    ]),
    target: availabilityTargetSchema,
    reason: nonBlank,
    path: z.string().nullable(),
    overridable: z.literal(false),
  }),
]);

const warningSchema = z.strictObject({
  kind: z.literal("soft-reference"),
  target: availabilityTargetSchema,
  reference: softReferenceSchema,
});

export const availabilityVerificationCheckSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      id: nonBlank,
      kind: z.literal("harness-exposure-state"),
      target: availabilityTargetSchema,
      actionId: nonBlank.nullable(),
      installationId: nonBlank,
      harnessId: nonBlank,
      expectedStatus: z.enum(["enabled", "disabled"]),
    }),
    z.strictObject({
      id: nonBlank,
      kind: z.literal("disabled-entry-state"),
      target: availabilityTargetSchema,
      actionId: nonBlank,
      entryId: nonBlank.nullable(),
      installationId: nonBlank,
      expectedPresent: z.boolean(),
    }),
    z.strictObject({
      id: nonBlank,
      kind: z.literal("plugin-state"),
      target: availabilityTargetSchema,
      actionId: nonBlank.nullable(),
      pluginBoundaryId: nonBlank,
      expectedStatus: z.enum(["enabled", "disabled"]),
    }),
  ],
);

export const availabilityPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonBlank,
  inventoryId: nonBlank,
  createdAt: timestamp,
  intent: availabilityIntentSchema,
  targets: z.array(availabilityTargetSchema).min(1),
  disabledEntryIds: z.array(nonBlank),
  actions: z.array(availabilityActionSchema),
  blocks: z.array(blockSchema),
  warnings: z.array(warningSchema),
  verificationChecks: z.array(availabilityVerificationCheckSchema),
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
    status: z.enum(["succeeded", "unchanged"]),
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
  target: availabilityTargetSchema,
  status: z.enum([
    "disabled",
    "enabled",
    "unchanged",
    "partial",
    "failed",
    "blocked",
  ]),
  actionIds: z.array(nonBlank),
  reason: z.string().nullable(),
});
const verificationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ checkId: nonBlank, status: z.literal("passed"), details }),
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

export const availabilityReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: nonBlank,
  inventoryId: nonBlank,
  finalInventoryId: nonBlank.nullable(),
  rescanError: errorSchema.nullable(),
  startedAt: timestamp,
  completedAt: timestamp,
  status: z.enum(["succeeded", "partial", "failed", "blocked"]),
  actionResults: z.array(actionResultSchema),
  targetResults: z.array(targetResultSchema),
  verificationResults: z.array(verificationResultSchema),
});

function parse<T>(schema: z.ZodType, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new TypeError(
      `${label}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return result.data as T;
}

export function parseAvailabilityIntent(value: unknown): AvailabilityIntent {
  return parse(availabilityIntentSchema, value, "invalid Availability intent");
}
export function parseAvailabilityPlan(value: unknown): AvailabilityPlan {
  return parse(availabilityPlanSchema, value, "invalid Availability plan");
}
export function parseAvailabilityReport(value: unknown): AvailabilityReport {
  return parse(availabilityReportSchema, value, "invalid Availability report");
}
