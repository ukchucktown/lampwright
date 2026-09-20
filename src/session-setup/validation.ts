import { z } from "zod";
import { inventorySchema, protectionStatusSchema } from "../model/schemas.js";
import { parseInventory } from "../model/validation.js";
import {
  executableSafetyIssue,
  resolvedArgumentSafetyIssue,
} from "../model/command-safety.js";
import type {
  SessionSetupIntent,
  SessionSetupPlan,
  SessionSetupPublicValue,
  SessionSetupReport,
  SessionSetupSnapshot,
  SessionSetupSourceProfile,
  SessionSetupTarget,
  SessionSetupTargetRef,
  SetupScope,
} from "./types.js";

const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });
const digest = z.strictObject({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f\d]{64}$/i),
});
const harness = z.enum(["codex", "claude-code", "gemini-cli"]);
const workspace = z.strictObject({ path: text });
const scope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("workspace"), workspacePath: text }),
  z.strictObject({ kind: z.literal("agent"), agentId: harness }),
]);
const source = z.strictObject({ sourceId: text, path: text.nullable() });
const owner = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("standalone") }),
  z.strictObject({ kind: z.literal("plugin"), pluginBoundaryId: text }),
  z.strictObject({ kind: z.literal("manager"), managerId: text }),
  z.strictObject({ kind: z.literal("runtime"), harnessId: harness }),
  z.strictObject({ kind: z.literal("unknown"), reason: text }),
]);
const state = z.strictObject({
  policy: z.enum(["enabled", "disabled", "unresolved"]),
  effectiveWorkspaceState: z.enum(["enabled", "disabled", "unresolved"]),
  accountState: z.literal("unknown"),
  liveSessionState: z.literal("unknown"),
});
const layer = z.strictObject({
  source,
  format: z.enum(["toml", "json", "jsonc"]),
  scope,
  precedence: z.number().int().nonnegative(),
  applies: z.union([
    z.literal(true),
    z.literal(false),
    z.literal("unresolved"),
  ]),
  exists: z.boolean(),
  canonicalPath: text.nullable(),
  expectedPreimage: digest.nullable(),
  protection: protectionStatusSchema,
  integrity: z.enum([
    "regular",
    "missing",
    "symbolic-link",
    "junction",
    "hard-linked",
    "duplicate-keys",
    "unreadable",
  ]),
});
const selector = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("skill-path"),
    id: text,
    path: text,
    authority: z.literal("exact-target"),
    governedTargetIds: z.tuple([text]),
  }),
  z.strictObject({
    kind: z.literal("plugin-id"),
    id: text,
    pluginId: text,
    authority: z.literal("exact-target"),
    governedTargetIds: z.tuple([text]),
  }),
  z.strictObject({
    kind: z.literal("mcp-server-key"),
    id: text,
    serverKey: text,
    authority: z.literal("exact-target"),
    governedTargetIds: z.tuple([text]),
  }),
  z.strictObject({
    kind: z.literal("app-connector-id"),
    id: text,
    connectorId: text,
    authority: z.literal("shared-connector"),
    governedTargetIds: z.array(text).min(1),
    collateralComplete: z.boolean(),
  }),
]);
const safeExecutable = text.superRefine((value, context) => {
  const issue = executableSafetyIssue(value);
  if (issue) context.addIssue({ code: "custom", message: issue });
});
const safeArgument = z.string().superRefine((value, context) => {
  const issue = resolvedArgumentSafetyIssue(value);
  if (issue) context.addIssue({ code: "custom", message: issue });
});
const authority = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("configuration"),
    source,
    layerSourceId: text,
    layerCanonicalPath: text.nullable(),
  }),
  z.strictObject({
    kind: z.literal("native-command"),
    executable: safeExecutable,
    arguments: z.array(safeArgument),
    source,
    scope,
    effects: z
      .array(
        z.strictObject({
          selectorId: text,
          targets: z.array(z.lazy(() => sessionSetupTargetRefSchema)).min(1),
        }),
      )
      .min(1),
  }),
]);
const availability = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("available"),
    controlScope: scope,
    authority,
  }),
  z.strictObject({ kind: z.literal("unavailable"), reason: text }),
]);
const control = z.strictObject({
  selector,
  layers: z.array(layer),
  availability: z.strictObject({ enable: availability, disable: availability }),
});
const base = {
  id: text,
  harnessId: harness,
  workspace,
  name: text,
  source,
  owner,
  definitionScope: scope,
  state,
  control,
};
export const sessionSetupTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal("skill-exposure"),
    installationId: text,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("plugin"),
    pluginBoundaryId: text,
    pluginId: text,
    childTargetIds: z.array(text),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("mcp-registration"),
    declarationSource: source,
    serverKey: text,
    requiredAppBindingId: text.nullable(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("app-binding"),
    owner: z.strictObject({
      kind: z.literal("plugin"),
      pluginBoundaryId: text,
    }),
    declarationSource: source,
    alias: text,
    connectorId: text,
    requiredByTargetIds: z.array(text),
  }),
]);
export const sessionSetupTargetRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("skill-exposure"),
    targetId: text,
    installationId: text,
  }),
  z.strictObject({
    kind: z.literal("plugin"),
    targetId: text,
    pluginBoundaryId: text,
  }),
  z.strictObject({
    kind: z.literal("mcp-registration"),
    targetId: text,
    declarationSourceId: text,
    serverKey: text,
  }),
  z.strictObject({
    kind: z.literal("app-binding"),
    targetId: text,
    declarationSourceId: text,
    alias: text,
    connectorId: text,
  }),
]);
const profile = z.strictObject({
  id: text,
  harnessId: harness,
  clientSurface: z.enum(["cli", "desktop", "cli-and-desktop", "unknown"]),
  sourceVersion: text,
  sourceSignature: text,
  qualification: z.enum(["fixture-only", "qualified", "unsupported"]),
  definitionScopes: z.array(z.enum(["user", "workspace", "agent"])).min(1),
  precedence: z.array(text),
  trust: z.enum(["trusted", "untrusted", "unknown"]),
  offlineProbe: z.enum(["metadata-only", "none", "unsupported"]),
  activation: z.enum(["restart", "new-session", "unknown"]),
  fixtureCoverage: z.array(text),
  supportedTargetKinds: z.array(
    z.enum(["skill-exposure", "plugin", "mcp-registration", "app-binding"]),
  ),
  controlScopeKinds: z.array(z.enum(["user", "workspace", "agent"])).min(1),
  selectorEffects: z.array(
    z.strictObject({
      targetKind: z.enum([
        "skill-exposure",
        "plugin",
        "mcp-registration",
        "app-binding",
      ]),
      authority: z.enum(["exact-target", "shared-connector"]),
    }),
  ),
});
const sourceResult = z.strictObject({
  source,
  profileId: text,
  harnessId: harness,
  kind: z.enum(["skill-exposure", "plugin", "mcp-registration", "app-binding"]),
  scope,
  status: z.enum(["success", "unavailable", "invalid", "incomplete"]),
  reason: text.nullable(),
  targetIds: z.array(text),
  collateralTargetIds: z.array(text),
});
const dependency = z.strictObject({
  kind: z.enum(["hard", "soft"]),
  dependent: sessionSetupTargetRefSchema,
  required: sessionSetupTargetRefSchema,
  reason: text,
});
export const sessionSetupSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("session-setup-snapshot"),
  id: text,
  scannedAt: timestamp,
  workspace,
  harnesses: z.array(harness).min(1),
  targets: z.array(sessionSetupTargetSchema),
  sources: z.array(sourceResult),
  profiles: z.array(profile),
  dependencies: z.array(dependency),
  legacyInventory: inventorySchema,
  semanticFingerprint: digest,
});
export const sessionSetupIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("session-setup-intent"),
  action: z.enum(["enable", "disable"]),
  harnessId: harness,
  workspace,
  targets: z.array(sessionSetupTargetRefSchema).min(1),
});
const mutation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("configuration"),
    authority: z.strictObject({
      kind: z.literal("configuration"),
      source,
      layerSourceId: text,
      layerCanonicalPath: text.nullable(),
    }),
    selectorId: text,
    policy: z.enum(["enabled", "disabled"]),
  }),
  z.strictObject({
    kind: z.literal("native-command"),
    authority: z.strictObject({
      kind: z.literal("native-command"),
      executable: safeExecutable,
      arguments: z.array(safeArgument),
      source,
      scope,
      effects: z
        .array(
          z.strictObject({
            selectorId: text,
            targets: z.array(sessionSetupTargetRefSchema).min(1),
          }),
        )
        .min(1),
    }),
    selectorId: text,
    policy: z.enum(["enabled", "disabled"]),
  }),
]);
const approval = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("confirmation"),
    required: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("scope-disclosure"),
    scope,
    required: z.literal(true),
  }),
]);
const action = z.strictObject({
  id: text,
  kind: z.literal("native-availability"),
  targets: z.array(sessionSetupTargetRefSchema).min(1),
  operation: z.enum(["enable", "disable"]),
  mutations: z.array(mutation).min(1),
  dependsOn: z.array(text),
  approvals: z.array(approval),
});
const block = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("missing-target"),
    target: sessionSetupTargetRefSchema,
  }),
  z.strictObject({
    kind: z.literal("hard-dependency"),
    target: sessionSetupTargetRefSchema,
    dependency,
  }),
  z.strictObject({
    kind: z.literal("owner-gate"),
    target: sessionSetupTargetRefSchema,
    owner: sessionSetupTargetRefSchema,
  }),
  z.strictObject({
    kind: z.enum([
      "unsupported-control",
      "source-incomplete",
      "source-invalid",
      "source-unavailable",
      "selector-collision",
      "shared-selector-incomplete",
      "protected",
      "unresolved",
    ]),
    target: sessionSetupTargetRefSchema,
    reason: text,
  }),
]);
const warning = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("soft-reference"),
    target: sessionSetupTargetRefSchema,
    dependency,
  }),
  z.strictObject({
    kind: z.literal("control-scope"),
    target: sessionSetupTargetRefSchema,
    scope,
  }),
  z.strictObject({
    kind: z.literal("activation"),
    target: sessionSetupTargetRefSchema,
    activation: z.enum(["restart", "new-session", "unknown"]),
  }),
]);
const verification = z.discriminatedUnion("kind", [
  z.strictObject({
    id: text,
    kind: z.literal("native-policy"),
    target: sessionSetupTargetRefSchema,
    selectorId: text,
    expectedPolicy: z.enum(["enabled", "disabled"]),
  }),
  z.strictObject({
    id: text,
    kind: z.literal("effective-workspace-state"),
    target: sessionSetupTargetRefSchema,
    expected: z.enum(["enabled", "disabled"]),
  }),
  z.strictObject({
    id: text,
    kind: z.literal("new-session-required"),
    target: sessionSetupTargetRefSchema,
    activation: z.enum(["restart", "new-session", "unknown"]),
  }),
]);
export const sessionSetupPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("session-setup-plan"),
  id: text,
  snapshotId: text,
  snapshotFingerprint: digest,
  createdAt: timestamp,
  intent: sessionSetupIntentSchema,
  targets: z.array(sessionSetupTargetSchema),
  actions: z.array(action),
  blocks: z.array(block),
  warnings: z.array(warning),
  verifications: z.array(verification),
  errors: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("stale-snapshot"), snapshotId: text }),
      z.strictObject({
        kind: z.enum(["invalid-intent", "planner"]),
        reason: text,
      }),
    ]),
  ),
});
const error = z.strictObject({ code: text, message: text });
export const sessionSetupReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("session-setup-report"),
  planId: text,
  snapshotId: text,
  startedAt: timestamp,
  completedAt: timestamp,
  status: z.enum(["succeeded", "unchanged", "partial", "blocked", "failed"]),
  actionResults: z.array(
    z.discriminatedUnion("status", [
      z.strictObject({
        actionId: text,
        status: z.enum(["succeeded", "unchanged"]),
      }),
      z.strictObject({ actionId: text, status: z.literal("failed"), error }),
      z.strictObject({
        actionId: text,
        status: z.literal("blocked"),
        blockedByActionIds: z.array(text).min(1),
      }),
    ]),
  ),
  targetResults: z.array(
    z.discriminatedUnion("status", [
      z.strictObject({
        target: sessionSetupTargetRefSchema,
        status: z.enum(["enabled", "disabled", "unchanged"]),
      }),
      z.strictObject({
        target: sessionSetupTargetRefSchema,
        status: z.enum(["failed", "blocked", "unverified"]),
        error,
      }),
    ]),
  ),
  verificationResults: z.array(
    z.discriminatedUnion("status", [
      z.strictObject({
        verificationId: text,
        status: z.enum(["passed", "skipped"]),
      }),
      z.strictObject({
        verificationId: text,
        status: z.literal("failed"),
        error,
      }),
    ]),
  ),
  finalSnapshotId: text.nullable(),
  rescanError: error.nullable(),
});
export const sessionSetupPublicValueSchema = z.discriminatedUnion("kind", [
  sessionSetupSnapshotSchema,
  sessionSetupIntentSchema,
  sessionSetupPlanSchema,
  sessionSetupReportSchema,
]);

export class SessionSetupValidationError extends Error {
  readonly issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];
  constructor(
    issues: readonly { path: readonly (string | number)[]; message: string }[],
  ) {
    super(
      issues
        .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
        .join("; "),
    );
    this.name = "SessionSetupValidationError";
    this.issues = issues;
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child);
  }
  return value;
}
function parse<T>(schema: z.ZodType, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new SessionSetupValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message: issue.message,
      })),
    );
  return freeze(result.data as T);
}
function refFor(target: SessionSetupTarget): SessionSetupTargetRef {
  switch (target.kind) {
    case "skill-exposure":
      return {
        kind: target.kind,
        targetId: target.id,
        installationId: target.installationId,
      };
    case "plugin":
      return {
        kind: target.kind,
        targetId: target.id,
        pluginBoundaryId: target.pluginBoundaryId,
      };
    case "mcp-registration":
      return {
        kind: target.kind,
        targetId: target.id,
        declarationSourceId: target.declarationSource.sourceId,
        serverKey: target.serverKey,
      };
    case "app-binding":
      return {
        kind: target.kind,
        targetId: target.id,
        declarationSourceId: target.declarationSource.sourceId,
        alias: target.alias,
        connectorId: target.connectorId,
      };
  }
}
function sameRef(
  left: SessionSetupTargetRef,
  right: SessionSetupTargetRef,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameSource(
  left: SessionSetupSnapshot["sources"][number]["source"],
  right: SessionSetupSnapshot["sources"][number]["source"],
): boolean {
  return left.sourceId === right.sourceId && left.path === right.path;
}
function sameStringSet(left: readonly string[], right: readonly string[]) {
  return (
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}
function scopeMatchesTarget(
  scope: SetupScope,
  target: SessionSetupTarget,
): boolean {
  return (
    (scope.kind !== "agent" || scope.agentId === target.harnessId) &&
    (scope.kind !== "workspace" ||
      scope.workspacePath === target.workspace.path)
  );
}
function selectorMatchesTarget(target: SessionSetupTarget): boolean {
  if (target.kind === "skill-exposure")
    return target.control.selector.kind === "skill-path";
  if (target.kind === "plugin")
    return (
      target.control.selector.kind === "plugin-id" &&
      target.control.selector.pluginId === target.pluginId
    );
  if (target.kind === "mcp-registration")
    return (
      target.control.selector.kind === "mcp-server-key" &&
      target.control.selector.serverKey === target.serverKey
    );
  return (
    target.control.selector.kind === "app-connector-id" &&
    target.control.selector.connectorId === target.connectorId
  );
}
function validateTargets(
  targets: readonly SessionSetupTarget[],
  sources: SessionSetupSnapshot["sources"],
  profiles: readonly SessionSetupSourceProfile[],
  inventory: SessionSetupSnapshot["legacyInventory"] | null,
): void {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const ids = new Set<string>();
  const profileById = new Map(profiles.map((item) => [item.id, item]));
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const installationIds = new Set<string>(
    inventory?.installations.map((item) => item.id as string),
  );
  const pluginIds = new Set<string>(inventory?.plugins.map((item) => item.id));
  for (const [i, target] of targets.entries()) {
    if (ids.has(target.id))
      issues.push({
        path: ["targets", i, "id"],
        message: "duplicate target id",
      });
    ids.add(target.id);
    if (
      sources.length &&
      !sources.some((item) => sameSource(item.source, target.source))
    )
      issues.push({
        path: ["targets", i, "source"],
        message: "unknown source",
      });
    if (
      target.kind === "skill-exposure" &&
      inventory &&
      !installationIds.has(target.installationId)
    )
      issues.push({
        path: ["targets", i, "installationId"],
        message: "unknown legacy installation",
      });
    if (target.kind === "skill-exposure" && inventory) {
      const installation = inventory.installations.find(
        (item) => item.id === target.installationId,
      );
      if (installation && !installation.exposedTo.includes(target.harnessId))
        issues.push({
          path: ["targets", i, "harnessId"],
          message: "legacy installation is not exposed to target harness",
        });
    }
    const pluginBoundaryId =
      target.kind === "plugin"
        ? target.pluginBoundaryId
        : target.owner.kind === "plugin"
          ? target.owner.pluginBoundaryId
          : null;
    if (pluginBoundaryId && inventory && !pluginIds.has(pluginBoundaryId))
      issues.push({
        path: ["targets", i, "owner"],
        message: "unknown legacy plugin boundary",
      });
    if (target.kind === "plugin" && inventory) {
      const plugin = inventory.plugins.find(
        (item) => item.id === target.pluginBoundaryId,
      );
      if (
        plugin &&
        (!plugin.exposedTo.includes(target.harnessId) ||
          plugin.pluginId !== target.pluginId)
      )
        issues.push({
          path: ["targets", i, "pluginBoundaryId"],
          message: "legacy plugin does not match target identity or harness",
        });
    }
    if (!target.control.selector.governedTargetIds.includes(target.id))
      issues.push({
        path: ["targets", i, "control", "selector"],
        message: "selector does not govern its target",
      });
    if (!selectorMatchesTarget(target))
      issues.push({
        path: ["targets", i, "control", "selector"],
        message: "selector does not match native target identity",
      });
    for (const [scopeValue, scopePath] of [
      [target.definitionScope, ["targets", i, "definitionScope"]],
      ...target.control.layers.map(
        (item, layerIndex) =>
          [
            item.scope,
            ["targets", i, "control", "layers", layerIndex, "scope"],
          ] as const,
      ),
    ] as const)
      if (!scopeMatchesTarget(scopeValue, target))
        issues.push({
          path: [...scopePath],
          message: "scope does not match target harness or workspace",
        });
    if (sources.length)
      for (const layer of target.control.layers)
        if (!sources.some((item) => sameSource(item.source, layer.source)))
          issues.push({
            path: ["targets", i, "control", "layers"],
            message: "layer references unknown source",
          });
    if (
      sources.length &&
      (target.kind === "mcp-registration" || target.kind === "app-binding") &&
      !sources.some((item) => sameSource(item.source, target.declarationSource))
    )
      issues.push({
        path: ["targets", i, "declarationSource"],
        message: "unknown declaration source",
      });
    const pluginOwner = target.owner.kind === "plugin" ? target.owner : null;
    if (
      pluginOwner !== null &&
      !targets.some(
        (candidate) =>
          candidate.kind === "plugin" &&
          candidate.pluginBoundaryId === pluginOwner.pluginBoundaryId,
      )
    )
      issues.push({
        path: ["targets", i, "owner"],
        message: "plugin-owned target lacks matching Plugin target",
      });
    if (target.kind === "plugin")
      for (const childId of target.childTargetIds) {
        const child = targetById.get(childId);
        if (
          child?.kind !== "skill-exposure" ||
          child.owner.kind !== "plugin" ||
          child.owner.pluginBoundaryId !== target.pluginBoundaryId
        )
          issues.push({
            path: ["targets", i, "childTargetIds"],
            message: "plugin child is not an owned Skill exposure",
          });
      }
    if (target.kind === "skill-exposure" && target.owner.kind === "plugin") {
      const ownerBoundaryId = target.owner.pluginBoundaryId;
      if (
        !targets.some(
          (candidate) =>
            candidate.kind === "plugin" &&
            candidate.pluginBoundaryId === ownerBoundaryId &&
            candidate.childTargetIds.includes(target.id),
        )
      )
        issues.push({
          path: ["targets", i, "owner"],
          message: "plugin-owned Skill is absent from the owner child list",
        });
    }
    if (
      target.kind === "mcp-registration" &&
      target.requiredAppBindingId !== null &&
      targetById.get(target.requiredAppBindingId)?.kind !== "app-binding"
    )
      issues.push({
        path: ["targets", i, "requiredAppBindingId"],
        message: "required App Binding is missing",
      });
    if (target.kind === "app-binding")
      for (const requiredById of target.requiredByTargetIds)
        if (!targetById.has(requiredById))
          issues.push({
            path: ["targets", i, "requiredByTargetIds"],
            message: "required-by target is missing",
          });
    for (const operation of ["enable", "disable"] as const) {
      const operationValue = target.control.availability[operation];
      if (operationValue.kind !== "available") continue;
      if (!scopeMatchesTarget(operationValue.controlScope, target))
        issues.push({
          path: ["targets", i, "control", "availability", operation],
          message: "control scope does not match target context",
        });
      if (
        operationValue.authority.kind === "native-command" &&
        !scopeMatchesTarget(operationValue.authority.scope, target)
      )
        issues.push({
          path: ["targets", i, "control", "availability", operation],
          message: "command scope does not match target context",
        });
      if (operationValue.authority.kind === "configuration") {
        const configurationAuthority = operationValue.authority;
        if (
          !target.control.layers.some(
            (item) =>
              item.source.sourceId === configurationAuthority.layerSourceId &&
              item.canonicalPath ===
                configurationAuthority.layerCanonicalPath &&
              sameSource(item.source, configurationAuthority.source),
          )
        )
          issues.push({
            path: ["targets", i, "control", "availability", operation],
            message: "configuration authority is not an exact target layer",
          });
      }
    }
  }
  for (const [i, sourceResult] of sources.entries()) {
    const profile = profileById.get(sourceResult.profileId);
    if (!profile || profile.harnessId !== sourceResult.harnessId)
      issues.push({
        path: ["sources", i, "profileId"],
        message: "profile does not authorize source harness",
      });
    if (
      profile &&
      !profile.supportedTargetKinds.includes(sourceResult.kind) &&
      sourceResult.status !== "unavailable"
    )
      issues.push({
        path: ["sources", i, "kind"],
        message: "profile does not support source target kind",
      });
    if ((sourceResult.status === "success") !== (sourceResult.reason === null))
      issues.push({
        path: ["sources", i, "reason"],
        message: "success requires no reason and non-success requires a reason",
      });
    for (const id of [
      ...sourceResult.targetIds,
      ...sourceResult.collateralTargetIds,
    ])
      if (!ids.has(id))
        issues.push({
          path: ["sources", i],
          message: "source references unknown target",
        });
    if (
      sourceResult.status === "unavailable" &&
      (sourceResult.targetIds.length > 0 ||
        sourceResult.collateralTargetIds.length > 0)
    )
      issues.push({
        path: ["sources", i],
        message: "unavailable source cannot publish targets",
      });
  }
  const selectors = new Map<string, SessionSetupTarget[]>();
  for (const target of targets)
    selectors.set(target.control.selector.id, [
      ...(selectors.get(target.control.selector.id) ?? []),
      target,
    ]);
  for (const [selectorId, controlledTargets] of selectors) {
    const expectedTargetIds = controlledTargets.map((target) => target.id);
    const first = controlledTargets[0]!.control.selector;
    for (const target of controlledTargets) {
      const candidate = target.control.selector;
      if (
        candidate.kind !== first.kind ||
        candidate.authority !== first.authority ||
        !sameStringSet(candidate.governedTargetIds, expectedTargetIds)
      )
        issues.push({
          path: ["targets"],
          message: `selector ${selectorId} has inconsistent collateral`,
        });
    }
    if (first.authority === "exact-target" && controlledTargets.length !== 1)
      issues.push({
        path: ["targets"],
        message: `exact selector ${selectorId} governs multiple targets`,
      });
    if (
      first.authority === "shared-connector" &&
      controlledTargets.some(
        (target) =>
          target.kind !== "app-binding" ||
          target.connectorId !== first.connectorId ||
          target.control.selector.kind !== "app-connector-id" ||
          target.control.selector.connectorId !== first.connectorId ||
          !target.control.selector.collateralComplete,
      )
    )
      issues.push({
        path: ["targets"],
        message: `shared selector ${selectorId} lacks complete connector collateral`,
      });
  }
  for (const [targetIndex, target] of targets.entries())
    for (const operation of ["enable", "disable"] as const) {
      const operationValue = target.control.availability[operation];
      if (
        operationValue.kind !== "available" ||
        operationValue.authority.kind !== "native-command"
      )
        continue;
      let includesPrimarySelector = false;
      for (const effect of operationValue.authority.effects) {
        const controlledTargets = selectors.get(effect.selectorId);
        if (effect.selectorId === target.control.selector.id)
          includesPrimarySelector = true;
        if (
          controlledTargets === undefined ||
          !sameStringSet(
            effect.targets.map((item) => item.targetId),
            controlledTargets.map((item) => item.id),
          ) ||
          effect.targets.some((ref) => {
            const affected = targetById.get(ref.targetId);
            return affected === undefined || !sameRef(refFor(affected), ref);
          })
        )
          issues.push({
            path: [
              "targets",
              targetIndex,
              "control",
              "availability",
              operation,
              "authority",
              "effects",
            ],
            message: "native-command effect exceeds selector authority",
          });
      }
      if (!includesPrimarySelector)
        issues.push({
          path: [
            "targets",
            targetIndex,
            "control",
            "availability",
            operation,
            "authority",
            "effects",
          ],
          message: "native-command omits its primary selector effect",
        });
    }
  if (issues.length) throw new SessionSetupValidationError(issues);
}
function validateReferences(
  targets: readonly SessionSetupTarget[],
  refs: readonly SessionSetupTargetRef[],
  path: (string | number)[],
): void {
  const byId = new Map(targets.map((target) => [target.id, target]));
  const issues: { path: (string | number)[]; message: string }[] = [];
  refs.forEach((ref, index) => {
    const target = byId.get(ref.targetId);
    if (!target || !sameRef(refFor(target), ref))
      issues.push({
        path: [...path, index],
        message: "target reference does not match exact target identity",
      });
  });
  if (issues.length) throw new SessionSetupValidationError(issues);
}
export function parseSessionSetupSnapshot(
  input: unknown,
): SessionSetupSnapshot {
  const value = parse<SessionSetupSnapshot>(sessionSetupSnapshotSchema, input);
  parseInventory(value.legacyInventory);
  validateTargets(
    value.targets,
    value.sources,
    value.profiles,
    value.legacyInventory,
  );
  const targetById = new Map(
    value.targets.map((target) => [target.id, target]),
  );
  const issues: { path: (string | number)[]; message: string }[] = [];
  for (const [label, ids] of [
    ["harnesses", value.harnesses],
    ["profiles", value.profiles.map((profile) => profile.id)],
    ["sources", value.sources.map((source) => source.source.sourceId)],
  ] as const)
    if (new Set(ids).size !== ids.length)
      issues.push({
        path: [label],
        message: `duplicate ${label.slice(0, -1)} id`,
      });
  value.targets.forEach((target, index) => {
    if (target.workspace.path !== value.workspace.path)
      issues.push({
        path: ["targets", index, "workspace"],
        message: "target belongs to another workspace",
      });
    if (!value.harnesses.includes(target.harnessId))
      issues.push({
        path: ["targets", index, "harnessId"],
        message: "target harness is absent from snapshot",
      });
    const owningSource = value.sources.find((source) =>
      sameSource(source.source, target.source),
    );
    if (!owningSource || !owningSource.targetIds.includes(target.id))
      issues.push({
        path: ["targets", index, "source"],
        message: "target is not a member of its authoritative source",
      });
    const profile = owningSource
      ? value.profiles.find(
          (candidate) => candidate.id === owningSource.profileId,
        )
      : undefined;
    if (
      profile &&
      !profile.selectorEffects.some(
        (effect) =>
          effect.targetKind === target.kind &&
          effect.authority === target.control.selector.authority,
      )
    )
      issues.push({
        path: ["targets", index, "control", "selector"],
        message: "source profile does not authorize selector effects",
      });
    const validateScope = (
      scope: SetupScope,
      path: (string | number)[],
      allowed: readonly SetupScope["kind"][],
    ) => {
      if (scope.kind === "agent" && scope.agentId !== target.harnessId)
        issues.push({ path, message: "agent scope does not match harness" });
      if (
        scope.kind === "workspace" &&
        scope.workspacePath !== value.workspace.path
      )
        issues.push({
          path,
          message: "workspace scope does not match snapshot",
        });
      if (profile && !allowed.includes(scope.kind))
        issues.push({
          path,
          message: "source profile does not authorize scope",
        });
    };
    validateScope(
      target.definitionScope,
      ["targets", index, "definitionScope"],
      profile?.definitionScopes ?? [],
    );
    target.control.layers.forEach((layer, layerIndex) =>
      validateScope(
        layer.scope,
        ["targets", index, "control", "layers", layerIndex, "scope"],
        profile?.controlScopeKinds ?? [],
      ),
    );
    for (const operation of ["enable", "disable"] as const) {
      const available = target.control.availability[operation];
      if (
        available.kind === "available" &&
        !value.sources.some((source) =>
          sameSource(source.source, available.authority.source),
        )
      )
        issues.push({
          path: ["targets", index, "control", "availability", operation],
          message: "operation authority references unknown source",
        });
      const operationAuthority =
        available.kind === "available" ? available.authority : null;
      if (available.kind === "available")
        validateScope(
          available.controlScope,
          [
            "targets",
            index,
            "control",
            "availability",
            operation,
            "controlScope",
          ],
          profile?.controlScopeKinds ?? [],
        );
      if (operationAuthority?.kind === "native-command")
        validateScope(
          operationAuthority.scope,
          [
            "targets",
            index,
            "control",
            "availability",
            operation,
            "authority",
            "scope",
          ],
          profile?.controlScopeKinds ?? [],
        );
    }
  });
  value.sources.forEach((source, index) => {
    const profile = value.profiles.find(
      (candidate) => candidate.id === source.profileId,
    );
    if (!value.harnesses.includes(source.harnessId))
      issues.push({
        path: ["sources", index, "harnessId"],
        message: "source harness is absent from snapshot",
      });
    if (
      source.scope.kind === "agent" &&
      source.scope.agentId !== source.harnessId
    )
      issues.push({
        path: ["sources", index, "scope"],
        message: "source agent scope does not match harness",
      });
    if (
      source.scope.kind === "workspace" &&
      source.scope.workspacePath !== value.workspace.path
    )
      issues.push({
        path: ["sources", index, "scope"],
        message: "source workspace scope does not match snapshot",
      });
    if (profile && !profile.definitionScopes.includes(source.scope.kind))
      issues.push({
        path: ["sources", index, "scope"],
        message: "source profile does not authorize definition scope",
      });
    if (
      new Set(source.targetIds).size !== source.targetIds.length ||
      new Set(source.collateralTargetIds).size !==
        source.collateralTargetIds.length
    )
      issues.push({
        path: ["sources", index],
        message: "source contains duplicate target references",
      });
    for (const id of [...source.targetIds, ...source.collateralTargetIds]) {
      const target = targetById.get(id);
      if (
        target &&
        (target.harnessId !== source.harnessId || target.kind !== source.kind)
      )
        issues.push({
          path: ["sources", index],
          message: "source target does not match harness and kind",
        });
    }
  });
  value.profiles.forEach((profile, index) => {
    if (!value.harnesses.includes(profile.harnessId))
      issues.push({
        path: ["profiles", index, "harnessId"],
        message: "profile harness is absent from snapshot",
      });
  });
  if (issues.length) throw new SessionSetupValidationError(issues);
  validateReferences(
    value.targets,
    value.dependencies.flatMap((item) => [item.dependent, item.required]),
    ["dependencies"],
  );
  for (const target of value.targets) {
    if (
      target.kind === "mcp-registration" &&
      target.requiredAppBindingId !== null
    ) {
      const app = targetById.get(target.requiredAppBindingId);
      if (
        app?.kind !== "app-binding" ||
        !app.requiredByTargetIds.includes(target.id) ||
        !value.dependencies.some(
          (dependency) =>
            dependency.kind === "hard" &&
            sameRef(dependency.dependent, refFor(target)) &&
            sameRef(dependency.required, refFor(app)),
        )
      )
        throw new SessionSetupValidationError([
          {
            path: ["dependencies"],
            message:
              "required App Binding lacks reciprocal hard dependency evidence",
          },
        ]);
    }
    if (target.kind === "app-binding")
      for (const dependentId of target.requiredByTargetIds) {
        const dependent = targetById.get(dependentId);
        if (
          !dependent ||
          !value.dependencies.some(
            (dependency) =>
              dependency.kind === "hard" &&
              sameRef(dependency.dependent, refFor(dependent)) &&
              sameRef(dependency.required, refFor(target)),
          )
        )
          throw new SessionSetupValidationError([
            {
              path: ["dependencies"],
              message: "App Binding required-by evidence lacks hard dependency",
            },
          ]);
      }
  }
  return value;
}
export function parseSessionSetupIntent(input: unknown): SessionSetupIntent {
  return parse<SessionSetupIntent>(sessionSetupIntentSchema, input);
}
export function parseSessionSetupPlan(input: unknown): SessionSetupPlan {
  const value = parse<SessionSetupPlan>(sessionSetupPlanSchema, input);
  validateTargets(value.targets, [], [], null);
  const targetById = new Map(
    value.targets.map((target) => [target.id, target]),
  );
  const missingBlocks = value.blocks.filter(
    (
      item,
    ): item is Extract<
      (typeof value.blocks)[number],
      { kind: "missing-target" }
    > => item.kind === "missing-target",
  );
  const refs = [
    ...value.actions.flatMap((item) => item.targets),
    ...value.blocks.flatMap((item) =>
      item.kind === "missing-target" ? [] : [item.target],
    ),
    ...value.warnings.map((item) => item.target),
    ...value.verifications.map((item) => item.target),
    ...value.blocks.flatMap((item) =>
      item.kind === "hard-dependency"
        ? [item.dependency.dependent, item.dependency.required]
        : item.kind === "owner-gate"
          ? [item.owner]
          : [],
    ),
    ...value.warnings.flatMap((item) =>
      item.kind === "soft-reference"
        ? [item.dependency.dependent, item.dependency.required]
        : [],
    ),
  ];
  validateReferences(value.targets, refs, ["plan"]);
  const intentIds = new Set(
    value.intent.targets.map((target) => target.targetId),
  );
  const actionIds = new Set<string>();
  const planIssues: { path: (string | number)[]; message: string }[] = [];
  if (intentIds.size !== value.intent.targets.length)
    planIssues.push({
      path: ["intent", "targets"],
      message: "intent contains duplicate targets",
    });
  value.intent.targets.forEach((ref, index) => {
    const target = targetById.get(ref.targetId);
    if (target) {
      if (!sameRef(refFor(target), ref))
        planIssues.push({
          path: ["intent", "targets", index],
          message: "intent target does not match exact target identity",
        });
    } else if (!missingBlocks.some((block) => sameRef(block.target, ref)))
      planIssues.push({
        path: ["intent", "targets", index],
        message: "missing intent target lacks a missing-target block",
      });
  });
  missingBlocks.forEach((block, index) => {
    if (
      targetById.has(block.target.targetId) ||
      !value.intent.targets.some((target) => sameRef(target, block.target))
    )
      planIssues.push({
        path: ["blocks", index],
        message: "missing-target block must identify an absent intent target",
      });
  });
  value.targets.forEach((target, index) => {
    if (
      target.harnessId !== value.intent.harnessId ||
      target.workspace.path !== value.intent.workspace.path
    )
      planIssues.push({
        path: ["targets", index],
        message: "plan target differs from intent harness or workspace",
      });
  });
  for (const [index, action] of value.actions.entries()) {
    if (actionIds.has(action.id))
      planIssues.push({
        path: ["actions", index, "id"],
        message: "duplicate action id",
      });
    actionIds.add(action.id);
    if (
      action.operation !== value.intent.action ||
      action.targets.some((target) => !intentIds.has(target.targetId))
    )
      planIssues.push({
        path: ["actions", index],
        message: "action must use intended targets and operation",
      });
    if (
      action.targets.some(
        (ref) =>
          value.targets.find((target) => target.id === ref.targetId)
            ?.harnessId !== value.intent.harnessId ||
          value.targets.find((target) => target.id === ref.targetId)?.workspace
            .path !== value.intent.workspace.path,
      )
    )
      planIssues.push({
        path: ["actions", index, "targets"],
        message: "action target differs from intent harness or workspace",
      });
    if (action.dependsOn.includes(action.id))
      planIssues.push({
        path: ["actions", index, "dependsOn"],
        message: "action cannot depend on itself",
      });
  }
  for (const action of value.actions)
    if (action.dependsOn.some((id) => !actionIds.has(id)))
      planIssues.push({
        path: ["actions", action.id, "dependsOn"],
        message: "unknown action dependency",
      });
  if (planIssues.length) throw new SessionSetupValidationError(planIssues);
  const selectors = new Map(
    value.targets.map((target) => [
      target.control.selector.id,
      target.control.selector,
    ]),
  );
  for (const action of value.actions)
    for (const mutation of action.mutations) {
      const selectorValue = selectors.get(mutation.selectorId);
      if (!selectorValue)
        throw new SessionSetupValidationError([
          {
            path: ["actions", action.id, "mutations"],
            message: "mutation references unknown selector",
          },
        ]);
      const expectedAuthority =
        action.operation === "enable" ? "enable" : "disable";
      const availabilityValue = value.targets.find(
        (target) => target.control.selector.id === mutation.selectorId,
      )?.control.availability[expectedAuthority];
      if (
        !availabilityValue ||
        availabilityValue.kind !== "available" ||
        availabilityValue.authority.kind !== mutation.kind ||
        JSON.stringify(availabilityValue.authority) !==
          JSON.stringify(mutation.authority)
      )
        throw new SessionSetupValidationError([
          {
            path: ["actions", action.id, "mutations"],
            message: "mutation exceeds native selector authority",
          },
        ]);
      const controlledTargets = value.targets.filter(
        (target) => target.control.selector.id === mutation.selectorId,
      );
      if (
        mutation.kind === "configuration" &&
        !controlledTargets.every((target) =>
          target.control.layers.some(
            (layer) =>
              layer.source.sourceId === mutation.authority.layerSourceId &&
              layer.canonicalPath === mutation.authority.layerCanonicalPath &&
              sameSource(layer.source, mutation.authority.source),
          ),
        )
      )
        throw new SessionSetupValidationError([
          {
            path: ["actions", action.id, "mutations"],
            message: "configuration authority is not an exact target layer",
          },
        ]);
      if (mutation.kind === "native-command") {
        const effectRefs = mutation.authority.effects.flatMap(
          (effect) => effect.targets,
        );
        validateReferences(value.targets, effectRefs, [
          "actions",
          action.id,
          "mutations",
          "effects",
        ]);
        if (
          !mutation.authority.effects.some(
            (effect) => effect.selectorId === mutation.selectorId,
          ) ||
          mutation.authority.effects.some((effect) => {
            const governed = value.targets
              .filter(
                (target) => target.control.selector.id === effect.selectorId,
              )
              .map((target) => target.id);
            return !sameStringSet(
              effect.targets.map((target) => target.targetId),
              governed,
            );
          })
        )
          throw new SessionSetupValidationError([
            {
              path: ["actions", action.id, "mutations", "effects"],
              message: "native-command effect exceeds selector authority",
            },
          ]);
      }
      if (
        mutation.policy !==
          (action.operation === "enable" ? "enabled" : "disabled") ||
        !action.targets.every((target) =>
          selectorValue.governedTargetIds.includes(target.targetId),
        )
      )
        throw new SessionSetupValidationError([
          {
            path: ["actions", action.id, "mutations"],
            message: "mutation policy or selector targets disagree with action",
          },
        ]);
    }
  return value;
}
export function parseSessionSetupReport(input: unknown): SessionSetupReport {
  const value = parse<SessionSetupReport>(sessionSetupReportSchema, input);
  if ((value.finalSnapshotId === null) !== (value.rescanError !== null))
    throw new SessionSetupValidationError([
      {
        path: ["rescanError"],
        message: "final snapshot and rescan error must agree",
      },
    ]);
  return value;
}
export function parseSessionSetupSourceProfile(
  input: unknown,
): SessionSetupSourceProfile {
  return parse<SessionSetupSourceProfile>(profile, input);
}
export function parseSessionSetupPublicValue(
  input: unknown,
): SessionSetupPublicValue {
  const kind = parse<{ kind: SessionSetupPublicValue["kind"] }>(
    z
      .object({
        kind: z.enum([
          "session-setup-snapshot",
          "session-setup-intent",
          "session-setup-plan",
          "session-setup-report",
        ]),
      })
      .passthrough(),
    input,
  ).kind;
  switch (kind) {
    case "session-setup-snapshot":
      return parseSessionSetupSnapshot(input);
    case "session-setup-intent":
      return parseSessionSetupIntent(input);
    case "session-setup-plan":
      return parseSessionSetupPlan(input);
    case "session-setup-report":
      return parseSessionSetupReport(input);
  }
}
export function sessionSetupJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/ukchucktown/lampwright/raw/main/schemas/session-setup-v1.schema.json",
    ...(z.toJSONSchema(sessionSetupPublicValueSchema, {
      target: "draft-2020-12",
      io: "input",
    }) as Record<string, unknown>),
  };
}
