import { z } from "zod";

import type { ScanRequest } from "./types.js";

const nonBlankString = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const adapterId = nonBlankString.nullable();
const scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({
    kind: z.literal("workspace"),
    workspacePath: nonBlankString,
  }),
  z.strictObject({ kind: z.literal("agent"), agentId: nonBlankString }),
]);
const rootBase = { path: nonBlankString, adapterId };

const discoveryRoot = z.discriminatedUnion("kind", [
  z.strictObject({
    ...rootBase,
    kind: z.literal("user"),
    agentId: nonBlankString,
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("agent"),
    agentId: nonBlankString,
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("workspace"),
    agentId: nonBlankString,
    workspacePath: nonBlankString,
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("plugin"),
    agentId: nonBlankString,
    scope,
    plugin: z.strictObject({
      id: nonBlankString,
      version: nonBlankString.nullable(),
    }),
    independentlySelectable: z.boolean(),
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("source"),
    agentId: nonBlankString.nullable(),
    scope: scope.nullable(),
    source: z.strictObject({
      id: nonBlankString,
      url: z.url().nullable(),
    }),
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("cache-or-vendor"),
    agentId: nonBlankString.nullable(),
    scope: scope.nullable(),
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("unknown"),
    agentId: nonBlankString.nullable(),
    scope: scope.nullable(),
  }),
  z.strictObject({
    ...rootBase,
    kind: z.literal("system"),
    agentId: nonBlankString,
  }),
]);

const scanRequest = z.strictObject({ roots: z.array(discoveryRoot) });

export function parseScanRequest(input: unknown): ScanRequest {
  const result = scanRequest.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") ?? "request";
    const message = issue?.message ?? "invalid scan request";
    throw new Error(`${path}: ${message}`);
  }
  return result.data as ScanRequest;
}
