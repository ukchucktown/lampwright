import { posix, win32 } from "node:path";

import { z } from "zod";

import {
  executableSafetyIssue,
  resolvedArgumentSafetyIssue,
} from "./command-safety.js";

const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const absoluteFilesystemPath = nonEmptyString.refine(
  (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
  "must be an absolute filesystem path",
);
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

export const protectionStatusSchema = z.strictObject({
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

const suspensionEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    artifacts: z
      .array(
        z.strictObject({
          location: artifactLocationSchema,
          protection: protectionStatusSchema,
        }),
      )
      .min(1),
    managerRecord: z.enum(["not-applicable", "preserved"]),
    managerMayRecreate: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("unavailable"), reason: nonEmptyString }),
]);

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
  z.strictObject({ kind: z.literal("source-group"), groupId: modelId }),
]);

const inventoryRecordReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), installationId: modelId }),
  z.strictObject({ kind: z.literal("finding"), findingId: modelId }),
]);

const dependencySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manifest"), path: nonEmptyString }),
  z.strictObject({ kind: z.literal("adapter"), adapterId: nonEmptyString }),
]);

export const hardDependencySchema = z.strictObject({
  kind: z.literal("hard"),
  dependentInstallationId: modelId,
  target: removalTargetSchema,
  source: dependencySourceSchema,
  reason: nonEmptyString,
});

export const softReferenceSchema = z.strictObject({
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
    workingDirectory: z
      .discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("exact"),
          path: absoluteFilesystemPath,
        }),
        z.strictObject({ kind: z.literal("isolated-temporary") }),
      ])
      .nullable()
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("ephemeral-package"),
    packageExecution: packageExecutionSchema,
    packageArguments: z.array(commandArgument),
  }),
]);

export const sha256DigestSchema = z.strictObject({
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
  primaryArtifactPresent: z.boolean().optional(),
  supplementalArtifacts: z
    .array(
      z.strictObject({
        location: artifactLocationSchema,
        protection: protectionStatusSchema,
      }),
    )
    .default([]),
  recordCleanups: z.array(declarativeRecordCleanupSchema),
});

/** Canonical persisted shape for Harness Exposure evidence. */
export const harnessExposureSchema = z
  .strictObject({
    harnessId: nonEmptyString,
    status: z.enum(["enabled", "disabled", "unresolved"]),
    control: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("unsupported"),
        reason: nonEmptyString,
      }),
      z.strictObject({
        kind: z.literal("native"),
        mechanism: z.enum([
          "codex-skills-config",
          "claude-skill-overrides",
          "gemini-disabled-skills",
        ]),
        availability: z.strictObject({
          disable: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("available") }),
            z.strictObject({
              kind: z.literal("unavailable"),
              reason: nonEmptyString,
            }),
          ]),
          enable: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("available") }),
            z.strictObject({
              kind: z.literal("unavailable"),
              reason: nonEmptyString,
            }),
          ]),
        }),
        selector: z.strictObject({
          kind: z.enum(["path", "name"]),
          value: nonEmptyString,
        }),
        layers: z.array(
          z.strictObject({
            path: nonEmptyString,
            format: z.enum(["toml", "json", "jsonc"]),
            scope: scopeSchema,
            documentScope: z.enum([
              "user",
              "shared-workspace",
              "local-workspace",
              "workspace",
            ]),
            applies: z.union([
              z.literal(true),
              z.literal(false),
              z.literal("unresolved"),
            ]),
            exists: z.boolean(),
            canonicalPath: nonEmptyString.nullable(),
            preimageHash: sha256DigestSchema.nullable(),
            protection: protectionStatusSchema,
            selectorValue: z
              .discriminatedUnion("kind", [
                z.strictObject({
                  kind: z.literal("codex-skills-config"),
                  matchingRules: z.array(
                    z.strictObject({
                      index: z.number().int().min(0),
                      selector: z.strictObject({
                        kind: z.enum(["path", "name"]),
                        value: nonEmptyString,
                      }),
                      enabled: z.boolean(),
                    }),
                  ),
                }),
                z.strictObject({
                  kind: z.literal("claude-skill-overrides"),
                  mode: z
                    .enum(["on", "name-only", "user-invocable-only", "off"])
                    .nullable(),
                }),
                z.strictObject({
                  kind: z.literal("gemini-disabled-skills"),
                  disabled: z.boolean(),
                }),
              ])
              .nullable(),
          }),
        ),
        writableLayerPaths: z.array(nonEmptyString),
      }),
    ]),
  })
  .superRefine((exposure, context) => {
    if (exposure.control.kind !== "native") return;
    const { control } = exposure;
    const fail = (message: string) =>
      context.addIssue({ code: "custom", message });
    const values = control.layers.map((layer) => layer.selectorValue);
    const allSafe = values.every((value) => value !== null);
    const expectedHarness =
      control.mechanism === "codex-skills-config"
        ? "codex"
        : control.mechanism === "claude-skill-overrides"
          ? "claude-code"
          : "gemini-cli";
    if (exposure.harnessId !== expectedHarness)
      fail("native mechanism must match its harness identifier");
    if (
      new Set(control.layers.map((layer) => layer.path)).size !==
      control.layers.length
    )
      fail("native configuration layer paths must be unique");
    if (
      new Set(control.writableLayerPaths).size !==
      control.writableLayerPaths.length
    )
      fail("native writable layer paths must be unique");
    for (const layer of control.layers) {
      if (
        !layer.exists &&
        (layer.canonicalPath !== null || layer.preimageHash !== null)
      )
        fail(
          "missing configuration layers cannot have canonical paths or preimage hashes",
        );
      if (
        layer.exists &&
        layer.selectorValue !== null &&
        (layer.canonicalPath === null || layer.preimageHash === null)
      )
        fail(
          "safe existing configuration layers require canonical paths and preimage hashes",
        );
    }
    if (control.mechanism === "codex-skills-config") {
      if (
        control.selector.kind !== "path" ||
        control.layers.length !== 1 ||
        control.layers[0]?.format !== "toml" ||
        control.layers[0]?.documentScope !== "user" ||
        control.layers[0]?.applies !== true ||
        values.some(
          (value) => value !== null && value.kind !== "codex-skills-config",
        )
      )
        fail(
          "Codex native evidence must contain one applied user TOML path layer",
        );
    }
    if (control.mechanism === "claude-skill-overrides") {
      if (
        control.selector.kind !== "name" ||
        control.layers.length !== 3 ||
        control.layers
          .map((layer) => layer.format)
          .some((format) => format !== "json") ||
        control.layers.map((layer) => layer.documentScope).join(",") !==
          "user,shared-workspace,local-workspace" ||
        control.layers.some((layer) => layer.applies !== true) ||
        values.some(
          (value) => value !== null && value.kind !== "claude-skill-overrides",
        )
      )
        fail(
          "Claude native evidence must contain ordered applied user, shared, and local JSON layers",
        );
    }
    if (control.mechanism === "gemini-disabled-skills") {
      if (
        control.selector.kind !== "name" ||
        control.layers.length !== 2 ||
        control.layers
          .map((layer) => layer.format)
          .some((format) => format !== "jsonc") ||
        control.layers.map((layer) => layer.documentScope).join(",") !==
          "user,workspace" ||
        control.layers[0]?.applies !== true ||
        values.some(
          (value) => value !== null && value.kind !== "gemini-disabled-skills",
        )
      )
        fail(
          "Gemini native evidence must contain user and workspace JSONC layers",
        );
    }
    if (
      control.writableLayerPaths.some(
        (path) => !control.layers.some((layer) => layer.path === path),
      )
    )
      fail("writable native layer paths must name a materialized layer");
    const expectedWritableIndexes =
      control.mechanism === "codex-skills-config"
        ? [0]
        : control.mechanism === "claude-skill-overrides"
          ? [0, 2]
          : [0, 1];
    const expectedWritablePaths = expectedWritableIndexes
      .map((index) => control.layers[index]?.path)
      .filter((path): path is string => path !== undefined);
    if (
      control.writableLayerPaths.length !== expectedWritablePaths.length ||
      control.writableLayerPaths.some(
        (path, index) => path !== expectedWritablePaths[index],
      )
    )
      fail(
        "native writable layer paths must match the documented candidate layers",
      );
    if (!allSafe && exposure.status !== "unresolved")
      fail("unsafe native evidence requires unresolved status");
    if (
      exposure.status === "unresolved" &&
      (control.availability.disable.kind !== "unavailable" ||
        control.availability.enable.kind !== "unavailable")
    )
      fail(
        "unresolved native evidence requires both operations to be unavailable",
      );
    if (allSafe && exposure.status === "unresolved") {
      const unresolvedWorkspace = control.layers.some(
        (layer) =>
          layer.applies === "unresolved" &&
          layer.selectorValue?.kind === "gemini-disabled-skills" &&
          layer.selectorValue.disabled,
      );
      if (!unresolvedWorkspace)
        fail("resolved native evidence cannot report unresolved status");
    }
    if (allSafe && exposure.status !== "unresolved") {
      const disabled =
        control.mechanism === "codex-skills-config"
          ? control.layers[0]!.selectorValue!.kind === "codex-skills-config" &&
            control.layers[0]!.selectorValue!.matchingRules.at(-1)?.enabled ===
              false
          : control.mechanism === "claude-skill-overrides"
            ? control.layers
                .map((layer) =>
                  layer.selectorValue?.kind === "claude-skill-overrides"
                    ? layer.selectorValue.mode
                    : null,
                )
                .filter((mode) => mode !== null)
                .at(-1) === "off"
            : control.layers.some(
                (layer) =>
                  layer.applies === true &&
                  layer.selectorValue?.kind === "gemini-disabled-skills" &&
                  layer.selectorValue.disabled,
              );
      if ((disabled ? "disabled" : "enabled") !== exposure.status)
        fail("native exposure status must match its effective layer evidence");
    }
    if (allSafe && exposure.status !== "unresolved") {
      const writable = (layer: (typeof control.layers)[number] | undefined) =>
        layer !== undefined &&
        layer.protection.git.kind !== "protected" &&
        layer.protection.filesystem.kind === "writable";
      const disableAvailable =
        control.availability.disable.kind === "available";
      const enableAvailable = control.availability.enable.kind === "available";
      if (control.mechanism === "codex-skills-config") {
        if (
          disableAvailable !== writable(control.layers[0]) ||
          enableAvailable !== writable(control.layers[0])
        )
          fail(
            "Codex operation availability must match its writable user document",
          );
      }
      if (control.mechanism === "claude-skill-overrides") {
        const shared = control.layers[1]!.selectorValue;
        const local = control.layers[2]!.selectorValue;
        const canUseUser =
          writable(control.layers[0]) &&
          shared?.kind === "claude-skill-overrides" &&
          shared.mode === null &&
          local?.kind === "claude-skill-overrides" &&
          local.mode === null;
        const canOverride = writable(control.layers[2]) || canUseUser;
        if (disableAvailable !== canOverride || enableAvailable !== canOverride)
          fail(
            "Claude operation availability must use a writable effective override layer",
          );
      }
      if (control.mechanism === "gemini-disabled-skills") {
        const canDisable = control.layers.some(
          (layer) => layer.applies === true && writable(layer),
        );
        const enableTargets = control.layers.filter(
          (layer) =>
            layer.applies === true &&
            layer.selectorValue?.kind === "gemini-disabled-skills" &&
            layer.selectorValue.disabled,
        );
        if (
          disableAvailable !== canDisable ||
          enableAvailable !== enableTargets.every(writable)
        )
          fail(
            "Gemini operation availability must cover its applied disabled-name memberships",
          );
      }
    }
  });

export const installationSchema = z
  .strictObject({
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
    exposedTo: z.array(nonEmptyString),
    harnessExposures: z.array(harnessExposureSchema),
    suspension: suspensionEvidenceSchema,
    scope: scopeSchema,
    location: artifactLocationSchema,
    contentHash: nonEmptyString.nullable(),
    modifiedAt: timestamp.nullable(),
    ownership: ownershipSchema,
    protection: protectionStatusSchema,
    removal: removalEvidenceSchema,
    tags: z.array(nonEmptyString),
    metadata: jsonObject,
  })
  .superRefine((installation, context) => {
    const expected = [...new Set(installation.exposedTo)].sort();
    if (expected.length !== installation.exposedTo.length) {
      context.addIssue({
        code: "custom",
        path: ["exposedTo"],
        message: "must be unique",
      });
    }
    const actual = installation.harnessExposures.map(
      (exposure) => exposure.harnessId,
    );
    if (
      actual.length !== expected.length ||
      actual.some((id, index) => id !== expected[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["harnessExposures"],
        message: "must be unique, sorted, and match exposedTo",
      });
    }
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
  groupId: modelId.nullable(),
  spansGroups: z.boolean(),
});

const installationGroupEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    tier: z.literal("declared"),
    kind: z.literal("manager-source"),
    managerId: nonEmptyString,
    sourceId: nonEmptyString,
  }),
  z.strictObject({
    tier: z.literal("structural"),
    kind: z.literal("repository-remote"),
    remoteUrl: nonEmptyString,
  }),
]);

const installationGroupSchema = z.strictObject({
  id: modelId,
  label: nonEmptyString,
  tier: z.enum(["declared", "structural"]),
  evidence: installationGroupEvidenceSchema,
  scope: scopeSchema,
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
  exposedTo: z.array(nonEmptyString).min(1),
  ownership: pluginOwnershipSchema,
  runtimeDefault: z.boolean(),
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
  groups: z.array(installationGroupSchema),
  plugins: z.array(pluginBoundarySchema),
  dependencies: z.array(dependencySchema),
});

export const approvalRequirementSchema = z.discriminatedUnion("kind", [
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

export const executionApprovalsSchema = z.strictObject({
  grants: z.array(approvalRequirementSchema),
});

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
  verifications: z.array(managedVerificationEvidenceSchema).default([]),
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
    kind: z.literal("runtime-default-plugin"),
    target: z.strictObject({
      kind: z.literal("plugin"),
      pluginBoundaryId: nonEmptyString,
    }),
    pluginId: nonEmptyString,
    exposedTo: z.array(nonEmptyString),
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
    actionId: modelId,
    path: nonEmptyString,
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("owner-state-absent"),
    actionId: modelId,
    owner: managedOwnershipSchema,
    externalId: nonEmptyString,
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("record-absent"),
    actionId: modelId,
    path: nonEmptyString,
    format: declarativeDocumentFormatSchema,
    recordPointer,
    expectedRecordHash: sha256DigestSchema.nullable(),
  }),
  z.strictObject({
    id: modelId,
    kind: z.literal("command-succeeds"),
    actionId: modelId,
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
    status: z.enum(["partially-removed", "unresolved", "failed"]),
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
  z.strictObject({
    checkId: modelId,
    status: z.literal("skipped"),
    reason: nonEmptyString,
  }),
]);

export const executionReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: modelId,
  inventoryId: modelId,
  finalInventoryId: modelId.nullable(),
  rescanError: executionErrorSchema.nullable(),
  startedAt: timestamp,
  completedAt: timestamp,
  status: z.enum(["succeeded", "partial", "failed", "blocked"]),
  actionResults: z.array(actionResultSchema),
  targetResults: z.array(targetResultSchema),
  verificationResults: z.array(verificationResultSchema),
  fallbackPlans: z.array(removalPlanSchema),
});
