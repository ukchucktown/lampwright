import {
  parseSessionSetupIntent,
  parseSessionSetupPlan,
  parseSessionSetupReport,
  parseSessionSetupSnapshot,
} from "../session-setup/index.js";
import { buildInstallation, buildInventory } from "./model-builders.js";
import type {
  SessionSetupIntent,
  SessionSetupPlan,
  SessionSetupReport,
  SessionSetupSnapshot,
  SessionSetupTarget,
  SessionSetupTargetRef,
} from "../session-setup/types.js";

const hash = { algorithm: "sha256" as const, digest: "0".repeat(64) };
const source = { sourceId: "fixture-source", path: "/fixtures/config.toml" };
const workspace = { path: "/fixtures/workspace" };
export function buildSessionSetupTarget(
  overrides: Partial<SessionSetupTarget> = {},
): SessionSetupTarget {
  return {
    id: "setup-target-1",
    kind: "skill-exposure",
    name: "example-skill",
    harnessId: "codex",
    workspace,
    source,
    owner: { kind: "standalone" },
    definitionScope: { kind: "user" },
    state: {
      policy: "enabled",
      effectiveWorkspaceState: "enabled",
      accountState: "unknown",
      liveSessionState: "unknown",
    },
    control: {
      selector: {
        kind: "skill-path",
        id: "selector-skill",
        path: "/fixtures/skills/example-skill",
        authority: "exact-target",
        governedTargetIds: ["setup-target-1"],
      },
      layers: [
        {
          source,
          format: "toml",
          scope: { kind: "user" },
          precedence: 0,
          applies: true,
          exists: true,
          canonicalPath: "/fixtures/config.toml",
          expectedPreimage: hash,
          protection: {
            git: { kind: "outside-worktree" },
            system: { kind: "none" },
            filesystem: { kind: "writable" },
          },
          integrity: "regular",
        },
      ],
      availability: {
        enable: {
          kind: "available",
          controlScope: { kind: "user" },
          authority: {
            kind: "configuration",
            source,
            layerSourceId: source.sourceId,
            layerCanonicalPath: "/fixtures/config.toml",
          },
        },
        disable: {
          kind: "available",
          controlScope: { kind: "user" },
          authority: {
            kind: "configuration",
            source,
            layerSourceId: source.sourceId,
            layerCanonicalPath: "/fixtures/config.toml",
          },
        },
      },
    },
    installationId: "installation-1",
    ...overrides,
  } as SessionSetupTarget;
}
export function targetRef(
  target: SessionSetupTarget = buildSessionSetupTarget(),
): SessionSetupTargetRef {
  if (target.kind === "skill-exposure")
    return {
      kind: target.kind,
      targetId: target.id,
      installationId: target.installationId,
    };
  if (target.kind === "plugin")
    return {
      kind: target.kind,
      targetId: target.id,
      pluginBoundaryId: target.pluginBoundaryId,
    };
  if (target.kind === "mcp-registration")
    return {
      kind: target.kind,
      targetId: target.id,
      declarationSourceId: target.declarationSource.sourceId,
      serverKey: target.serverKey,
    };
  return {
    kind: target.kind,
    targetId: target.id,
    declarationSourceId: target.declarationSource.sourceId,
    alias: target.alias,
    connectorId: target.connectorId,
  };
}
export function buildSessionSetupSnapshot(
  overrides: Partial<SessionSetupSnapshot> = {},
): SessionSetupSnapshot {
  const target = buildSessionSetupTarget();
  return parseSessionSetupSnapshot({
    schemaVersion: 1,
    kind: "session-setup-snapshot",
    id: "setup-snapshot-1",
    scannedAt: "2026-01-01T00:00:00.000Z",
    workspace,
    harnesses: ["codex"],
    targets: [target],
    sources: [
      {
        source,
        profileId: "codex-fixture",
        harnessId: "codex",
        kind: "skill-exposure",
        scope: { kind: "user" },
        status: "success",
        reason: null,
        targetIds: [target.id],
        collateralTargetIds: [target.id],
      },
    ],
    profiles: [
      {
        id: "codex-fixture",
        harnessId: "codex",
        clientSurface: "cli",
        sourceVersion: "0.154.0",
        sourceSignature: "fixture-config-v1",
        qualification: "fixture-only",
        definitionScopes: ["user"],
        precedence: ["user"],
        trust: "trusted",
        offlineProbe: "metadata-only",
        activation: "new-session",
        fixtureCoverage: ["discovery", "enable", "disable"],
        supportedTargetKinds: ["skill-exposure"],
        controlScopeKinds: ["user"],
        selectorEffects: [
          { targetKind: "skill-exposure", authority: "exact-target" },
        ],
      },
    ],
    dependencies: [],
    legacyInventory: buildInventory({
      installations: [buildInstallation({ exposedTo: ["codex"] })],
    }),
    semanticFingerprint: hash,
    ...overrides,
  });
}
export function buildSessionSetupIntent(
  overrides: Partial<SessionSetupIntent> = {},
): SessionSetupIntent {
  return parseSessionSetupIntent({
    schemaVersion: 1,
    kind: "session-setup-intent",
    action: "disable",
    harnessId: "codex",
    workspace,
    targets: [targetRef()],
    ...overrides,
  });
}
export function buildSessionSetupPlan(
  overrides: Partial<SessionSetupPlan> = {},
): SessionSetupPlan {
  const target = buildSessionSetupTarget();
  const ref = targetRef(target);
  return parseSessionSetupPlan({
    schemaVersion: 1,
    kind: "session-setup-plan",
    id: "setup-plan-1",
    snapshotId: "setup-snapshot-1",
    snapshotFingerprint: hash,
    createdAt: "2026-01-01T00:00:00.000Z",
    intent: buildSessionSetupIntent(),
    targets: [target],
    actions: [
      {
        id: "action-1",
        kind: "native-availability",
        targets: [ref],
        operation: "disable",
        mutations: [
          {
            kind: "configuration",
            authority: {
              kind: "configuration",
              source,
              layerSourceId: source.sourceId,
              layerCanonicalPath: "/fixtures/config.toml",
            },
            selectorId: "selector-skill",
            policy: "disabled",
          },
        ],
        dependsOn: [],
        approvals: [{ kind: "confirmation", required: true }],
      },
    ],
    blocks: [],
    warnings: [],
    verifications: [
      {
        id: "verify-1",
        kind: "native-policy",
        target: ref,
        selectorId: "selector-skill",
        expectedPolicy: "disabled",
      },
    ],
    errors: [],
    ...overrides,
  });
}
export function buildSessionSetupReport(
  overrides: Partial<SessionSetupReport> = {},
): SessionSetupReport {
  return parseSessionSetupReport({
    schemaVersion: 1,
    kind: "session-setup-report",
    planId: "setup-plan-1",
    snapshotId: "setup-snapshot-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "succeeded",
    actionResults: [{ actionId: "action-1", status: "succeeded" }],
    targetResults: [{ target: targetRef(), status: "disabled" }],
    verificationResults: [{ verificationId: "verify-1", status: "passed" }],
    finalSnapshotId: "setup-snapshot-2",
    rescanError: null,
    ...overrides,
  });
}
