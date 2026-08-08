import { isAbsolute } from "node:path";

import { z } from "zod";

import type {
  QuarantineEntry,
  QuarantineRequest,
  QuarantineSelection,
  RestoreResolution,
} from "./types.js";
import { QuarantineError } from "./types.js";

const nonBlankString = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const absolutePath = nonBlankString.refine(isAbsolute, "must be absolute");
const timestamp = z.iso.datetime({ offset: true });
const sha256Digest = z.strictObject({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f\d]{64}$/i, "expected a SHA-256 digest"),
});
const entryId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "invalid quarantine entry id");

const ownership = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("filesystem"),
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("manager"),
    managerId: nonBlankString,
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("plugin"),
    pluginId: nonBlankString,
    independentlySelectable: z.boolean(),
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("agent-runtime"),
    agentId: nonBlankString,
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    confidence: z.literal("unknown"),
  }),
]);

const removalTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("installation"),
    installationId: nonBlankString,
  }),
  z.strictObject({
    kind: z.literal("logical-skill"),
    logicalSkillId: nonBlankString,
  }),
  z.strictObject({
    kind: z.literal("source-group"),
    groupId: nonBlankString,
  }),
  z.strictObject({
    kind: z.literal("plugin"),
    pluginBoundaryId: nonBlankString,
  }),
]);

const artifactType = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({ kind: z.literal("directory") }),
  z.strictObject({
    kind: z.literal("symbolic-link"),
    target: nonBlankString,
    broken: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("junction"),
    target: nonBlankString,
    broken: z.boolean(),
  }),
]);

const artifactLocation = z.strictObject({
  path: absolutePath,
  canonicalPath: absolutePath.nullable(),
  artifactType,
});

const provenanceSubject = z
  .strictObject({
    installationIds: z.array(nonBlankString),
    ownership,
    adapterId: nonBlankString.nullable(),
    source: z
      .strictObject({ id: nonBlankString, url: z.url().nullable() })
      .nullable(),
    plugin: z
      .strictObject({ id: nonBlankString, version: nonBlankString.nullable() })
      .nullable(),
    manager: z.strictObject({ id: nonBlankString }).nullable(),
  })
  .superRefine((value, context) => {
    if (new Set(value.installationIds).size !== value.installationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["installationIds"],
        message: "affected installation ids must be unique",
      });
    }
    if (
      value.ownership.kind === "manager" &&
      value.manager?.id !== value.ownership.managerId
    ) {
      context.addIssue({
        code: "custom",
        path: ["manager"],
        message: "manager provenance must match ownership",
      });
    }
    if (value.ownership.kind !== "manager" && value.manager !== null) {
      context.addIssue({
        code: "custom",
        path: ["manager"],
        message: "manager provenance requires manager ownership",
      });
    }
    if (
      value.ownership.kind === "plugin" &&
      value.plugin?.id !== value.ownership.pluginId
    ) {
      context.addIssue({
        code: "custom",
        path: ["plugin"],
        message: "plugin provenance must match ownership",
      });
    }
    if (value.ownership.kind !== "plugin" && value.plugin !== null) {
      context.addIssue({
        code: "custom",
        path: ["plugin"],
        message: "plugin provenance requires plugin ownership",
      });
    }
  });

const provenance = z
  .strictObject({
    actionId: nonBlankString,
    targets: z.array(removalTarget).min(1),
    affectedInstallationIds: z.array(nonBlankString),
    subjects: z.array(provenanceSubject).min(1),
    operation: z
      .strictObject({
        id: nonBlankString,
        displayNames: z.array(nonBlankString).min(1),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.affectedInstallationIds).size !==
      value.affectedInstallationIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["affectedInstallationIds"],
        message: "affected installation ids must be unique",
      });
    }
    const subjectInstallationIds = value.subjects.flatMap(
      (subject) => subject.installationIds,
    );
    if (
      new Set(subjectInstallationIds).size !== subjectInstallationIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["subjects"],
        message: "an installation may have only one provenance subject",
      });
    }
    if (
      [...new Set(subjectInstallationIds)].sort().join("\0") !==
      [...new Set(value.affectedInstallationIds)].sort().join("\0")
    ) {
      context.addIssue({
        code: "custom",
        path: ["subjects"],
        message: "provenance subjects must cover affected installations",
      });
    }
  });

const requestBase = {
  location: artifactLocation,
  provenance,
};

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...requestBase,
    kind: z.literal("displaced-artifact"),
  }),
  z.strictObject({
    ...requestBase,
    kind: z.literal("record-cleanup-preimage"),
    location: artifactLocation.refine(
      (value) => value.artifactType.kind === "file",
      "record cleanup preimage must be a file",
    ),
    expectedPreimageHash: sha256Digest,
    expectedPostimageHash: sha256Digest,
  }),
]);

const restoration = z.strictObject({
  mode: z.number().int().nonnegative().nullable(),
  modifiedAt: timestamp.nullable(),
});

const entryBase = {
  schemaVersion: z.literal(1),
  id: entryId,
  createdAt: timestamp,
  expiresAt: timestamp,
  originalLocation: artifactLocation,
  integrity: sha256Digest,
  provenance,
  restoration,
};

const entrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...entryBase,
    kind: z.literal("displaced-artifact"),
    removedAt: timestamp,
  }),
  z.strictObject({
    ...entryBase,
    kind: z.literal("record-cleanup-preimage"),
    capturedAt: timestamp,
    expectedPreimageHash: sha256Digest,
    expectedPostimageHash: sha256Digest,
  }),
]);

const resolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("alternate-destination"),
    path: absolutePath,
  }),
  z.strictObject({ kind: z.literal("replace-record-postimage") }),
]);

const selectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entries"), entryIds: z.array(entryId) }),
  z.strictObject({ kind: z.literal("expired") }),
]);

export function parseQuarantineRequest(input: unknown): QuarantineRequest {
  return parse(requestSchema, input, "invalid-request") as QuarantineRequest;
}

export function parseQuarantineEntry(input: unknown): QuarantineEntry {
  const entry = parse(entrySchema, input, "invalid-entry") as QuarantineEntry;
  if (Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt)) {
    throw new QuarantineError(
      "invalid-entry",
      "quarantine entry expiry must follow creation",
    );
  }
  if (
    entry.kind === "record-cleanup-preimage" &&
    entry.integrity.digest.toLowerCase() !==
      entry.expectedPreimageHash.digest.toLowerCase()
  ) {
    throw new QuarantineError(
      "invalid-entry",
      "record preimage integrity must match its expected preimage hash",
    );
  }
  return deepFreeze(entry);
}

export function parseRestoreResolution(input: unknown): RestoreResolution {
  return parse(resolutionSchema, input, "invalid-request") as RestoreResolution;
}

export function parseQuarantineSelection(input: unknown): QuarantineSelection {
  return parse(
    selectionSchema,
    input,
    "invalid-request",
  ) as QuarantineSelection;
}

function parse(
  schema: z.ZodType,
  input: unknown,
  code: "invalid-entry" | "invalid-request",
): unknown {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new QuarantineError(
    code,
    result.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; "),
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  Object.values(value).forEach((child) => deepFreeze(child));
  return value;
}
