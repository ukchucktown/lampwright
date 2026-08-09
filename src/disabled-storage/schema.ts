import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  harnessExposureSchema,
  strongIdentityEvidenceSchema,
  weakIdentityEvidenceSchema,
} from "../model/schemas.js";
import type { DisabledEntry, SuspendRequest } from "./types.js";

const nonBlank = z.string().refine((value) => value.trim().length > 0);
const absolutePath = nonBlank.refine(isAbsolute, "must be an absolute path");
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

const requestSchema = z
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

const entrySchema = z
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
    requestSchema,
    value,
    "invalid disabled-storage suspend request",
  ) as unknown as SuspendRequest;
}

export function parseDisabledEntry(value: unknown): DisabledEntry {
  return parse(
    entrySchema,
    value,
    "invalid disabled-storage manifest",
  ) as unknown as DisabledEntry;
}
