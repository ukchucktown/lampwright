import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
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
  z.strictObject({ kind: z.literal("plugin"), pluginId: nonEmptyString }),
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
  agentId: nonEmptyString,
  scope: scopeSchema,
  location: artifactLocationSchema,
  contentHash: nonEmptyString.nullable(),
  modifiedAt: timestamp.nullable(),
  ownership: ownershipSchema,
  protection: protectionStatusSchema,
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
  agentId: nonEmptyString.nullable(),
  scope: scopeSchema.nullable(),
  location: artifactLocationSchema,
  ownership: ownershipSchema,
  protection: protectionStatusSchema,
  metadata: jsonObject,
});

const systemFindingSchema = z.strictObject({
  id: modelId,
  classification: z.literal("system-skill"),
  skill: skillDescriptorSchema,
  identity: skillIdentitySchema,
  agentId: nonEmptyString,
  scope: scopeSchema.nullable(),
  location: artifactLocationSchema,
  ownership: agentRuntimeOwnershipSchema,
  protection: z.strictObject({
    git: gitProtectionSchema,
    system: z.strictObject({
      kind: z.literal("system-skill"),
      agentId: nonEmptyString,
    }),
    filesystem: filesystemProtectionSchema,
  }),
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

export const inventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: modelId,
  scannedAt: timestamp,
  installations: z.array(installationSchema),
  otherFindings: z.array(nonInstallationFindingSchema),
  logicalSkills: z.array(logicalSkillSchema),
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
    runner: nonEmptyString,
    packageName: nonEmptyString,
    packageVersion: nonEmptyString,
    adapterHash: nonEmptyString,
  }),
]);

const fallbackAvailabilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    requiresSeparateConfirmation: z.literal(true),
  }),
  z.strictObject({ kind: z.literal("unavailable"), reason: nonEmptyString }),
]);

const packageExecutionSchema = z.strictObject({
  runner: nonEmptyString,
  packageName: nonEmptyString,
  packageVersion: nonEmptyString,
  adapterHash: nonEmptyString,
  mayDownload: z.literal(true),
});

const removalActionBase = {
  id: modelId,
  target: removalTargetSchema,
  dependsOn: z.array(modelId),
  approvals: z.array(approvalRequirementSchema),
};

const managedRemovalActionSchema = z.strictObject({
  ...removalActionBase,
  kind: z.literal("managed-removal"),
  owner: managedOwnershipSchema,
  adapterId: nonEmptyString,
  operationId: nonEmptyString,
  packageExecution: packageExecutionSchema.nullable(),
  fallback: fallbackAvailabilitySchema,
});

const quarantineActionSchema = z.strictObject({
  ...removalActionBase,
  kind: z.literal("quarantine"),
  location: artifactLocationSchema,
});

const recordCleanupActionSchema = z.strictObject({
  ...removalActionBase,
  kind: z.literal("record-cleanup"),
  path: nonEmptyString,
  adapterId: nonEmptyString,
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
    kind: z.literal("adapter-trust"),
    target: removalTargetSchema,
    adapterId: nonEmptyString,
    contentHash: nonEmptyString,
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
    kind: z.literal("unreconciled-manager-state"),
    target: removalTargetSchema,
    managerId: nonEmptyString,
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
]);

export const removalPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: modelId,
  inventoryId: modelId,
  createdAt: timestamp,
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
