import { posix, win32 } from "node:path";

import { z } from "zod";

import {
  harnessExposureSchema,
  strongIdentityEvidenceSchema,
  weakIdentityEvidenceSchema,
} from "../model/schemas.js";
import type { DisabledEntry, SuspendRequest } from "./types.js";
import { artifactPathKey } from "../model/paths.js";

const nonBlank = z.string().refine((value) => value.trim().length > 0);
const absolutePath = nonBlank.refine(
  (value) => posix.isAbsolute(value) || win32.isAbsolute(value),
  "must be an absolute path",
);
const identifier = nonBlank.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const timestamp = z.iso.datetime({ offset: true });
const digest = z.strictObject({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f\d]{64}$/i),
});
const artifactType = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({ kind: z.literal("directory") }),
  z.strictObject({
    kind: z.literal("symbolic-link"),
    target: nonBlank,
    broken: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("junction"),
    target: nonBlank,
    broken: z.boolean(),
  }),
]);
const location = z.strictObject({
  path: absolutePath,
  canonicalPath: absolutePath.nullable(),
  artifactType,
});
const ownership = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("filesystem"),
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("manager"),
    managerId: nonBlank,
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("plugin"),
    pluginId: nonBlank,
    independentlySelectable: z.boolean(),
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("agent-runtime"),
    agentId: nonBlank,
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    confidence: z.literal("unknown"),
  }),
]);
const suspendableOwnership = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("filesystem"),
    confidence: z.enum(["declared", "inferred"]),
  }),
  z.strictObject({
    kind: z.literal("manager"),
    managerId: nonBlank,
    confidence: z.enum(["declared", "inferred"]),
  }),
]);
const identity = z.strictObject({
  strongEvidence: z.array(strongIdentityEvidenceSchema),
  weakEvidence: z.array(weakIdentityEvidenceSchema),
});
const operation = z.strictObject({
  id: nonBlank,
  displayNames: z.array(nonBlank).min(1),
});
const restoration = z.strictObject({
  mode: z.number().int().nonnegative().nullable(),
  modifiedAt: timestamp.nullable(),
});

const disabledArtifact = z.strictObject({
  originalLocation: location,
  integrity: digest,
  restoration,
});

const suspendArtifact = z.strictObject({ location });

const suspendRequestV1Schema = z
  .strictObject({
    location,
    skillIdentity: identity,
    installationIds: z.array(nonBlank).min(1),
    ownership,
    harnessExposures: z.array(harnessExposureSchema),
    operation,
  })
  .superRefine((value, context) => {
    if (new Set(value.installationIds).size !== value.installationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["installationIds"],
        message: "installation IDs must be unique",
      });
    }
    validateExposures(value.harnessExposures, context);
  });

const suspendRequestV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    artifacts: z.array(suspendArtifact).min(1),
    skillIdentity: identity,
    installationIds: z.array(nonBlank).min(1),
    ownership: suspendableOwnership,
    harnessExposures: z.array(harnessExposureSchema),
    operation,
  })
  .superRefine((value, context) => {
    validateIdsAndExposures(value, context);
    validateSortedPaths(
      value.artifacts.map((artifact) => artifact.location),
      ["artifacts"],
      context,
    );
  });

export const suspendRequestSchema = z.union([
  suspendRequestV1Schema,
  suspendRequestV2Schema,
]);

const disabledEntryV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: identifier,
    suspendedAt: timestamp,
    originalLocation: location,
    integrity: digest,
    skillIdentity: identity,
    installationIds: z.array(nonBlank).min(1),
    ownership,
    harnessExposures: z.array(harnessExposureSchema),
    operation,
    restoration,
  })
  .superRefine((value, context) => {
    if (new Set(value.installationIds).size !== value.installationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["installationIds"],
        message: "installation IDs must be unique",
      });
    }
    validateExposures(value.harnessExposures, context);
  });

const disabledEntryV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    id: identifier,
    suspendedAt: timestamp,
    artifacts: z.array(disabledArtifact).min(1),
    skillIdentity: identity,
    installationIds: z.array(nonBlank).min(1),
    ownership: suspendableOwnership,
    harnessExposures: z.array(harnessExposureSchema),
    operation,
  })
  .superRefine((value, context) => {
    validateIdsAndExposures(value, context);
    validateSortedPaths(
      value.artifacts.map((artifact) => artifact.originalLocation),
      ["artifacts"],
      context,
    );
  });

export const disabledEntrySchema = z.union([
  disabledEntryV1Schema,
  disabledEntryV2Schema,
]);

function validateIdsAndExposures(
  value: {
    readonly installationIds: readonly string[];
    readonly harnessExposures: readonly { readonly harnessId: string }[];
  },
  context: z.RefinementCtx,
): void {
  if (new Set(value.installationIds).size !== value.installationIds.length) {
    context.addIssue({
      code: "custom",
      path: ["installationIds"],
      message: "installation IDs must be unique",
    });
  }
  validateExposures(value.harnessExposures, context);
}

function validateSortedPaths(
  locations: readonly z.infer<typeof location>[],
  path: readonly (number | string)[],
  context: z.RefinementCtx,
): void {
  const paths = locations.map(artifactPathKey);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((value, index) => index > 0 && paths[index - 1]! >= value)
  )
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "artifact paths must be nonempty, unique, and sorted",
    });
}

function validateExposures(
  exposures: readonly { readonly harnessId: string }[],
  context: z.RefinementCtx,
): void {
  if (exposures.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["harnessExposures"],
      message: "at least one Harness Exposure is required",
    });
    return;
  }
  const ids = exposures.map((exposure) => exposure.harnessId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && ids[index - 1]! >= id)
  )
    context.addIssue({
      code: "custom",
      path: ["harnessExposures"],
      message: "Harness Exposures must be unique and sorted by harness ID",
    });
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TypeError(
      `${label}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function parseSuspendRequest(value: unknown): SuspendRequest {
  return parse(
    suspendRequestSchema,
    value,
    "invalid disabled-storage suspend request",
  ) as unknown as SuspendRequest;
}

export function parseDisabledEntry(value: unknown): DisabledEntry {
  return parse(
    disabledEntrySchema,
    value,
    "invalid disabled-storage manifest",
  ) as unknown as DisabledEntry;
}
