import { z } from "zod";

import {
  executableSafetyIssue,
  resolvedArgumentSafetyIssue,
} from "./command-safety.js";

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const exactPackageVersion = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "must be an exact package version",
  );
const exactPackageName = z
  .string()
  .max(214)
  .regex(
    /^(?:@[a-z\d](?:[a-z\d._~-]*[a-z\d])?\/)?[a-z\d](?:[a-z\d._~-]*[a-z\d])?$/,
    "must be an exact npm package identifier",
  );
const timestamp = z.iso.datetime({ offset: true });
const modelId = nonEmptyString;
const jsonObject = z.record(z.string(), z.json());

const skillDescriptorSchema = z.strictObject({
  name: nonEmptyString,
  description: z.string().nullable(),
});

const sourceIdentityEvidenceSchema = z.strictObject({
  strength: z.literal("strong"),
  kind: z.literal("source"),
  sourceId: nonEmptyString,
  skillPath: nonEmptyString,
});

const pluginIdentityEvidenceSchema = z.strictObject({
  strength: z.literal("strong"),
  kind: z.literal("plugin"),
  pluginId: nonEmptyString,
  skillId: nonEmptyString,
});

const canonicalTargetIdentityEvidenceSchema = z.strictObject({
  strength: z.literal("strong"),
  kind: z.literal("canonical-target"),
  canonicalPath: nonEmptyString,
});

const packageIdentityEvidenceSchema = z.strictObject({
  strength: z.literal("strong"),
  kind: z.literal("package"),
  packageId: nonEmptyString,
});

export const strongIdentityEvidenceSchema = z.discriminatedUnion("kind", [
  sourceIdentityEvidenceSchema,
  pluginIdentityEvidenceSchema,
  canonicalTargetIdentityEvidenceSchema,
  packageIdentityEvidenceSchema,
]);

const nameIdentityEvidenceSchema = z.strictObject({
  strength: z.literal("weak"),
  kind: z.literal("name"),
  normalizedName: nonEmptyString,
});

const hashIdentityEvidenceSchema = z.strictObject({
  strength: z.literal("weak"),
  kind: z.literal("content-hash"),
  algorithm: z.literal("sha256"),
  digest: nonEmptyString,
});

export const weakIdentityEvidenceSchema = z.discriminatedUnion("kind", [
  nameIdentityEvidenceSchema,
  hashIdentityEvidenceSchema,
]);

const skillIdentitySchema = z.strictObject({
  strongEvidence: z.array(strongIdentityEvidenceSchema),
  weakEvidence: z.array(weakIdentityEvidenceSchema),
});

const logicalSkillIdentitySchema = z.strictObject({
  strongEvidence: z.array(strongIdentityEvidenceSchema).min(1),
  weakEvidence: z.array(weakIdentityEvidenceSchema),
});

const scopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({
    kind: z.literal("workspace"),
    workspacePath: nonEmptyString,
  }),
  z.strictObject({ kind: z.literal("agent"), agentId: nonEmptyString }),
]);

const filesystemOwnershipSchema = z.strictObject({
  kind: z.literal("filesystem"),
  confidence: z.enum(["declared", "inferred"]),
});

const managerOwnershipSchema = z.strictObject({
  kind: z.literal("manager"),
  managerId: nonEmptyString,
  confidence: z.enum(["declared", "inferred"]),
});

const pluginOwnershipSchema = z.strictObject({
  kind: z.literal("plugin"),
  pluginId: nonEmptyString,
  independentlySelectable: z.boolean(),
  confidence: z.enum(["declared", "inferred"]),
});

const agentRuntimeOwnershipSchema = z.strictObject({
  kind: z.literal("agent-runtime"),
  agentId: nonEmptyString,
  confidence: z.enum(["declared", "inferred"]),
});

const unknownOwnershipSchema = z.strictObject({
  kind: z.literal("unknown"),
  confidence: z.literal("unknown"),
});

const ownershipSchema = z.discriminatedUnion("kind", [
  filesystemOwnershipSchema,
  managerOwnershipSchema,
  pluginOwnershipSchema,
  agentRuntimeOwnershipSchema,
  unknownOwnershipSchema,
]);

const managedOwnershipSchema = z.discriminatedUnion("kind", [
  managerOwnershipSchema,
  pluginOwnershipSchema,
]);

const gitProtectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("outside-worktree") }),
  z.strictObject({ kind: z.literal("ignored"), worktreeRoot: nonEmptyString }),
  z.strictObject({
    kind: z.literal("protected"),
    worktreeRoot: nonEmptyString,
  }),
]);

const systemProtectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("system-skill"), agentId: nonEmptyString }),
]);

const filesystemProtectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("writable") }),
  z.strictObject({ kind: z.literal("read-only"), reason: nonEmptyString }),
]);

const protectionStatusSchema = z.strictObject({
  git: gitProtectionSchema,
  system: systemProtectionSchema,
  filesystem: filesystemProtectionSchema,
});

const artifactTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({ kind: z.literal("directory") }),
  z.strictObject({
    kind: z.literal("symbolic-link"),
    target: nonEmptyString,
    broken: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("junction"),
    target: nonEmptyString,
    broken: z.boolean(),
  }),
]);

const artifactLocationSchema = z.strictObject({
  path: nonEmptyString,
  canonicalPath: nonEmptyString.nullable(),
  artifactType: artifactTypeSchema,
});

const sourceReferenceSchema = z.strictObject({
  id: nonEmptyString,
  url: z.url().nullable(),
});

const pluginReferenceSchema = z.strictObject({
  id: nonEmptyString,
  version: nonEmptyString.nullable(),
});

const managerReferenceSchema = z.strictObject({ id: nonEmptyString });

export const removalTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), installationId: modelId }),
  z.strictObject({ kind: z.literal("logical-skill"), logicalSkillId: modelId }),
  z.strictObject({
    kind: z.literal("plugin"),
    pluginBoundaryId: nonEmptyString,
  }),
]);

const inventoryRecordReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), installationId: modelId }),
  z.strictObject({ kind: z.literal("finding"), findingId: modelId }),
]);

const dependencySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manifest"), path: nonEmptyString }),
  z.strictObject({ kind: z.literal("adapter"), adapterId: nonEmptyString }),
]);

const hardDependencySchema = z.strictObject({
  kind: z.literal("hard"),
  dependentInstallationId: modelId,
  target: removalTargetSchema,
  source: dependencySourceSchema,
  reason: nonEmptyString,
});

const softReferenceSchema = z.strictObject({
  kind: z.literal("soft"),
  referringRecord: inventoryRecordReferenceSchema,
  target: removalTargetSchema,
  evidence: nonEmptyString,
});

const dependencySchema = z.discriminatedUnion("kind", [
  hardDependencySchema,
  softReferenceSchema,
]);

const fallbackAvailabilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    requiresSeparateConfirmation: z.literal(true),
  }),
  z.strictObject({ kind: z.literal("unavailable"), reason: nonEmptyString }),
]);

const safeExecutable = nonEmptyString.superRefine((value, context) => {
  const issue = executableSafetyIssue(value);
  if (issue !== null) {
    context.addIssue({ code: "custom", message: issue });
  }
});

const commandArgument = z.string().superRefine((value, context) => {
  const issue = resolvedArgumentSafetyIssue(value);
  if (issue !== null) {
    context.addIssue({ code: "custom", message: issue });
  }
});

const packageExecutionSchema = z.strictObject({
  runner: z.literal("npx"),
  packageName: exactPackageName,
  packageVersion: exactPackageVersion,
  adapterHash: nonEmptyString,
  mayDownload: z.literal(true),
});

const executableCommandSchema = z.strictObject({
  executable: safeExecutable,
  arguments: z.array(commandArgument),
});

const managedRemovalInvocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("direct"),
    command: executableCommandSchema,
  }),
  z.strictObject({
    kind: z.literal("ephemeral-package"),
    packageExecution: packageExecutionSchema,
    packageArguments: z.array(commandArgument),
  }),
]);

const sha256DigestSchema = z.strictObject({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f\d]{64}$/i, "expected a SHA-256 digest"),
});

const declarativeDocumentFormatSchema = z.enum(["json", "jsonc", "yaml"]);

const recordPointer = z
  .string()
  .regex(
    /^\/(?:[^~]|~[01])*(?:\/(?:[^~]|~[01])*)*$/,
    "expected a resolved RFC 6901 record pointer",
  );

const managedVerificationEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path-absent"), path: nonEmptyString }),
  z.strictObject({
    kind: z.literal("record-absent"),
    path: nonEmptyString,
    format: declarativeDocumentFormatSchema,
    recordPointer,
  }),
  z.strictObject({
    kind: z.literal("owner-state-absent"),
    externalId: nonEmptyString,
  }),
  z.strictObject({
    kind: z.literal("command-succeeds"),
    command: executableCommandSchema,
    successExitCodes: z.array(z.number().int().min(0).max(255)).min(1),
  }),
]);

const adapterExecutionTrustSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("trusted") }),
  z.strictObject({
    kind: z.literal("blocked"),
    adapterId: nonEmptyString,
    contentHash: nonEmptyString,
  }),
]);

const managedRemovalEffectSchema = z.strictObject({
  kind: z.enum(["remove-path", "modify-path"]),
  path: nonEmptyString,
  protection: protectionStatusSchema,
});

const managedRemovalEvidenceSchema = z.strictObject({
  adapterId: nonEmptyString,
  operationId: nonEmptyString,
  availability: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("available") }),
    z.strictObject({
      kind: z.literal("unavailable"),
      reason: nonEmptyString,
    }),
  ]),
  trust: adapterExecutionTrustSchema,
  externalId: nonEmptyString.nullable(),
  invocation: managedRemovalInvocationSchema,
  effects: z.array(managedRemovalEffectSchema),
  verifications: z.array(managedVerificationEvidenceSchema),
});

const declarativeRecordCleanupSchema = z.strictObject({
  id: modelId,
  location: artifactLocationSchema,
  adapterId: nonEmptyString,
  format: declarativeDocumentFormatSchema,
  recordPointer,
  expectedFileHash: sha256DigestSchema,
  expectedRecordHash: sha256DigestSchema,
  protection: protectionStatusSchema,
});

const removalEvidenceSchema = z.strictObject({
  managed: managedRemovalEvidenceSchema.nullable(),
  fallback: fallbackAvailabilitySchema,
  recordCleanups: z.array(declarativeRecordCleanupSchema),
});

export const installationSchema = z.strictObject({
  id: modelId,
  classification: z.enum([
    "active-installation",
    "managed-plugin-resource",
    "standalone-project-skill",
  ]),
  status: z.enum(["active", "broken", "unresolved"]),
  skill: skillDescriptorSchema,
  identity: skillIdentitySchema,
  source: sourceReferenceSchema.nullable(),
  plugin: pluginReferenceSchema.nullable(),
  manager: managerReferenceSchema.nullable(),
  adapterId: nonEmptyString.nullable(),
  pluginBoundaryId: nonEmptyString.nullable(),
  agentId: nonEmptyString,
  scope: scopeSchema,
  location: artifactLocationSchema,
  contentHash: nonEmptyString.nullable(),
  modifiedAt: timestamp.nullable(),
  ownership: ownershipSchema,
  protection: protectionStatusSchema,
  removal: removalEvidenceSchema,
  tags: z.array(nonEmptyString),
  metadata: jsonObject,
});

const ordinaryFindingSchema = z.strictObject({
  id: modelId,
  classification: z.enum([
    "source-artifact",
    "cache-or-vendor-artifact",
    "unknown",
  ]),
  skill: skillDescriptorSchema,
  identity: skillIdentitySchema,
  source: sourceReferenceSchema.nullable(),
  plugin: pluginReferenceSchema.nullable(),
  manager: managerReferenceSchema.nullable(),
  adapterId: nonEmptyString.nullable(),
  agentId: nonEmptyString.nullable(),
  scope: scopeSchema.nullable(),
  location: artifactLocationSchema,
  contentHash: nonEmptyString.nullable(),
  modifiedAt: timestamp.nullable(),
  ownership: ownershipSchema,
  protection: protectionStatusSchema,
  tags: z.array(nonEmptyString),
  metadata: jsonObject,
});

const systemFindingSchema = z.strictObject({
  id: modelId,
  classification: z.literal("system-skill"),
  skill: skillDescriptorSchema,
  identity: skillIdentitySchema,
  source: sourceReferenceSchema.nullable(),
  plugin: pluginReferenceSchema.nullable(),
  manager: managerReferenceSchema.nullable(),
  adapterId: nonEmptyString.nullable(),
  agentId: nonEmptyString,
  scope: scopeSchema.nullable(),
  location: artifactLocationSchema,
  contentHash: nonEmptyString.nullable(),
  modifiedAt: timestamp.nullable(),
  ownership: agentRuntimeOwnershipSchema,
  protection: z.strictObject({
    git: gitProtectionSchema,
    system: z.strictObject({
      kind: z.literal("system-skill"),
      agentId: nonEmptyString,
    }),
    filesystem: filesystemProtectionSchema,
  }),
  tags: z.array(nonEmptyString),
  metadata: jsonObject,
});

export const nonInstallationFindingSchema = z.discriminatedUnion(
  "classification",
  [ordinaryFindingSchema, systemFindingSchema],
);

export const logicalSkillSchema = z.strictObject({
  id: modelId,
  skill: skillDescriptorSchema,
  identity: logicalSkillIdentitySchema,
  installationIds: z.array(modelId).min(1),
});

const weakIdentityHintSchema = z.strictObject({
  evidence: weakIdentityEvidenceSchema,
  installationIds: z.array(modelId).min(2),
});

const pluginResourceSchema = z.strictObject({
  kind: z.enum(["agent", "command", "hook", "configuration", "other"]),
  id: nonEmptyString,
  location: artifactLocationSchema.nullable(),
  protection: protectionStatusSchema.nullable(),
  cleanupId: modelId.nullable(),
});

const pluginBoundarySchema = z.strictObject({
  id: nonEmptyString,
  pluginId: nonEmptyString,
  version: nonEmptyString.nullable(),
  adapterId: nonEmptyString.nullable(),
  ownership: pluginOwnershipSchema,
  installationIds: z.array(modelId),
  resources: z.array(pluginResourceSchema),
  removal: removalEvidenceSchema,
});

export const inventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: modelId,
  scannedAt: timestamp,
  installations: z.array(installationSchema),
  otherFindings: z.array(nonInstallationFindingSchema),
  logicalSkills: z.array(logicalSkillSchema),
  identityHints: z.array(weakIdentityHintSchema),
  plugins: z.array(pluginBoundarySchema),
  dependencies: z.array(dependencySchema),
});

const approvalRequirementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("confirmation") }),
  z.strictObject({ kind: z.literal("brute-force-confirmation") }),
  z.strictObject({
    kind: z.literal("force-override"),
    safeguards: z.array(z.enum(["dependency", "ambiguity"])).min(1),
  }),
  z.strictObject({
    kind: z.literal("adapter-trust"),
    adapterId: nonEmptyString,
    contentHash: nonEmptyString,
  }),
  z.strictObject({
    kind: z.literal("package-trust"),
    runner: z.literal("npx"),
    packageName: exactPackageName,
    packageVersion: exactPackageVersion,
    adapterHash: nonEmptyString,
  }),
]);

const removalActionBase = {
  id: modelId,
  affectedInstallationIds: z.array(modelId),
  dependsOn: z.array(modelId),
  approvals: z.array(approvalRequirementSchema),
};

const managedRemovalActionSchema = z.strictObject({
  ...removalActionBase,
  kind: z.literal("managed-removal"),
  target: removalTargetSchema,
  owner: managedOwnershipSchema,
  adapterId: nonEmptyString,
  operationId: nonEmptyString,
  invocation: managedRemovalInvocationSchema,
  fallback: fallbackAvailabilitySchema,
  effects: z.array(managedRemovalEffectSchema),
});

const quarantineActionSchema = z.strictObject({
  ...removalActionBase,
  kind: z.literal("quarantine"),
  target: removalTargetSchema,
  location: artifactLocationSchema,
});

const recordCleanupActionSchema = z.strictObject({
  ...removalActionBase,
  kind: z.literal("record-cleanup"),
  affectedTargets: z.array(removalTargetSchema).min(1),
  location: artifactLocationSchema,
  adapterId: nonEmptyString,
  format: declarativeDocumentFormatSchema,
  expectedFileHash: sha256DigestSchema,
  protection: protectionStatusSchema,
  records: z
    .array(
      z.strictObject({
        recordPointer,
        expectedRecordHash: sha256DigestSchema,
      }),
    )
    .min(1),
});

export const removalActionSchema = z.discriminatedUnion("kind", [
  managedRemovalActionSchema,
  quarantineActionSchema,
  recordCleanupActionSchema,
]);

const planBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hard-dependency"),
    target: removalTargetSchema,
    dependency: hardDependencySchema,
    overridable: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("ambiguous-ownership"),
    target: removalTargetSchema,
    reason: nonEmptyString,
    overridable: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("git-protection"),
    target: removalTargetSchema,
    path: nonEmptyString,
    overridable: z.literal(false),
  }),
  z.strictObject({
    kind: z.literal("system-skill"),
    target: removalTargetSchema,
    agentId: nonEmptyString,
    overridable: z.literal(false),
  }),
  z.strictObject({
    kind: z.literal("filesystem-permission"),
    target: removalTargetSchema,
    path: nonEmptyString,
    reason: nonEmptyString,
    overridable: z.literal(false),
  }),
  z.strictObject({
    kind: z.literal("cleanup-conflict"),
    target: removalTargetSchema,
    path: nonEmptyString,
    reason: nonEmptyString,
    overridable: z.literal(false),
  }),
  z.strictObject({
    kind: z.literal("adapter-trust"),
    target: removalTargetSchema,
    adapterId: nonEmptyString,
    contentHash: nonEmptyString,
    overridable: z.literal(false),
  }),
  z.strictObject({
    kind: z.literal("plugin-boundary"),
    target: removalTargetSchema,
    pluginId: nonEmptyString,
    alternative: z.strictObject({
      kind: z.literal("plugin"),
      pluginBoundaryId: nonEmptyString,
    }),
    overridable: z.literal(false),
  }),
  z.strictObject({
    kind: z.literal("managed-removal-unavailable"),
    target: removalTargetSchema,
    reason: nonEmptyString,
    fallback: fallbackAvailabilitySchema,
    overridable: z.literal(false),
  }),
]);

const planWarningSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("soft-reference"),
    target: removalTargetSchema,
    reference: softReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("plugin-impact"),
    target: removalTargetSchema,
    pluginId: nonEmptyString,
    affectedResources: z.array(nonEmptyString).min(1),
  }),
  z.strictObject({
    kind: z.literal("ephemeral-download"),
    target: removalTargetSchema,
    packageExecution: packageExecutionSchema,
  }),
  z.strictObject({
    kind: z.literal("unreconciled-owner-state"),
    target: removalTargetSchema,
    owner: managedOwnershipSchema,
    reason: nonEmptyString,
  }),
]);

const verificationCheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: modelId,
    kind: z.literal("target-unavailable"),
    target: removalTargetSchema,
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("path-absent"),
    path: nonEmptyString,
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("owner-state-absent"),
    owner: managedOwnershipSchema,
    externalId: nonEmptyString,
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("record-absent"),
    path: nonEmptyString,
    format: declarativeDocumentFormatSchema,
    recordPointer,
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("command-succeeds"),
    command: executableCommandSchema,
    successExitCodes: z.array(z.number().int().min(0).max(255)).min(1),
  }),
]);

export const removalPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: modelId,
  inventoryId: modelId,
  createdAt: timestamp,
  intent: z.discriminatedUnion("kind", [
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
  ]),
  targets: z.array(removalTargetSchema).min(1),
  actions: z.array(removalActionSchema),
  blocks: z.array(planBlockSchema),
  warnings: z.array(planWarningSchema),
  verificationChecks: z.array(verificationCheckSchema),
});

const executionErrorSchema = z.strictObject({
  code: nonEmptyString,
  message: nonEmptyString,
  details: jsonObject,
});

const actionResultBase = {
  actionId: modelId,
  startedAt: timestamp,
  completedAt: timestamp,
};

const actionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...actionResultBase,
    status: z.enum(["succeeded", "unchanged"]),
    details: jsonObject,
  }),
  z.strictObject({
    ...actionResultBase,
    status: z.literal("failed"),
    error: executionErrorSchema,
  }),
  z.strictObject({
    ...actionResultBase,
    status: z.literal("blocked"),
    blockedByActionIds: z.array(modelId).min(1),
    reason: nonEmptyString,
  }),
  z.strictObject({
    ...actionResultBase,
    status: z.literal("skipped"),
    reason: nonEmptyString,
  }),
]);

const targetResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    target: removalTargetSchema,
    status: z.enum(["removed", "unchanged"]),
    actionIds: z.array(modelId),
  }),
  z.strictObject({
    target: removalTargetSchema,
    status: z.enum(["partially-removed", "unresolved"]),
    actionIds: z.array(modelId),
    reason: nonEmptyString,
  }),
  z.strictObject({
    target: removalTargetSchema,
    status: z.literal("blocked"),
    actionIds: z.array(modelId),
    reason: nonEmptyString,
  }),
]);

const verificationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    checkId: modelId,
    status: z.literal("passed"),
    details: jsonObject,
  }),
  z.strictObject({
    checkId: modelId,
    status: z.literal("failed"),
    error: executionErrorSchema,
  }),
]);

export const executionReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: modelId,
  inventoryId: modelId,
  startedAt: timestamp,
  completedAt: timestamp,
  status: z.enum(["succeeded", "partial", "failed", "blocked"]),
  actionResults: z.array(actionResultSchema),
  targetResults: z.array(targetResultSchema),
  verificationResults: z.array(verificationResultSchema),
});
