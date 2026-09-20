import type {
  Inventory,
  ProtectionStatus,
  Sha256Digest,
} from "../model/types.js";

/** Native-only values for configuring a future harness session. */
export type SetupHarnessId = "codex" | "claude-code" | "gemini-cli";
export type SessionSetupAction = "enable" | "disable";
export type SessionSetupTargetKind =
  "skill-exposure" | "plugin" | "mcp-registration" | "app-binding";
export interface SetupWorkspace {
  readonly path: string;
}
export type SetupScope =
  | { readonly kind: "user" }
  | { readonly kind: "workspace"; readonly workspacePath: string }
  | { readonly kind: "agent"; readonly agentId: SetupHarnessId };
export interface SetupSourceRef {
  readonly sourceId: string;
  readonly path: string | null;
}
export type SetupOwner =
  | { readonly kind: "standalone" }
  | { readonly kind: "plugin"; readonly pluginBoundaryId: string }
  | { readonly kind: "manager"; readonly managerId: string }
  | { readonly kind: "runtime"; readonly harnessId: SetupHarnessId }
  | { readonly kind: "unknown"; readonly reason: string };
export interface SetupConfiguredState {
  readonly policy: "enabled" | "disabled" | "unresolved";
  readonly effectiveWorkspaceState: "enabled" | "disabled" | "unresolved";
  readonly accountState: "unknown";
  readonly liveSessionState: "unknown";
}
export interface SetupConfigurationLayer {
  readonly source: SetupSourceRef;
  readonly format: "toml" | "json" | "jsonc";
  readonly scope: SetupScope;
  readonly precedence: number;
  readonly applies: true | false | "unresolved";
  readonly exists: boolean;
  readonly canonicalPath: string | null;
  readonly expectedPreimage: Sha256Digest | null;
  readonly protection: ProtectionStatus;
  readonly integrity:
    | "regular"
    | "missing"
    | "symbolic-link"
    | "junction"
    | "hard-linked"
    | "duplicate-keys"
    | "unreadable";
}
export type SetupNativeSelector =
  | {
      readonly kind: "skill-path";
      readonly id: string;
      readonly path: string;
      readonly authority: "exact-target";
      readonly governedTargetIds: readonly [string];
    }
  | {
      readonly kind: "plugin-id";
      readonly id: string;
      readonly pluginId: string;
      readonly authority: "exact-target";
      readonly governedTargetIds: readonly [string];
    }
  | {
      readonly kind: "mcp-server-key";
      readonly id: string;
      readonly serverKey: string;
      readonly authority: "exact-target";
      readonly governedTargetIds: readonly [string];
    }
  | {
      readonly kind: "app-connector-id";
      readonly id: string;
      readonly connectorId: string;
      readonly authority: "shared-connector";
      readonly governedTargetIds: readonly [string, ...string[]];
      readonly collateralComplete: boolean;
    };
export type SetupNativeMutationAuthority =
  | {
      readonly kind: "configuration";
      readonly source: SetupSourceRef;
      readonly layerSourceId: string;
      readonly layerCanonicalPath: string | null;
    }
  | {
      readonly kind: "native-command";
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly source: SetupSourceRef;
      readonly scope: SetupScope;
      readonly effects: readonly [
        {
          readonly selectorId: string;
          readonly targets: readonly [
            SessionSetupTargetRef,
            ...SessionSetupTargetRef[],
          ];
        },
        ...{
          readonly selectorId: string;
          readonly targets: readonly [
            SessionSetupTargetRef,
            ...SessionSetupTargetRef[],
          ];
        }[],
      ];
    };
export type SetupOperationAvailability =
  | {
      readonly kind: "available";
      readonly controlScope: SetupScope;
      readonly authority: SetupNativeMutationAuthority;
    }
  | { readonly kind: "unavailable"; readonly reason: string };
export interface SetupNativeControl {
  readonly selector: SetupNativeSelector;
  readonly layers: readonly SetupConfigurationLayer[];
  readonly availability: Readonly<
    Record<SessionSetupAction, SetupOperationAvailability>
  >;
}

interface TargetBase {
  readonly id: string;
  readonly harnessId: SetupHarnessId;
  readonly workspace: SetupWorkspace;
  readonly name: string;
  readonly source: SetupSourceRef;
  readonly owner: SetupOwner;
  readonly definitionScope: SetupScope;
  readonly state: SetupConfiguredState;
  readonly control: SetupNativeControl;
}
export interface SkillHarnessExposure extends TargetBase {
  readonly kind: "skill-exposure";
  readonly installationId: string;
}
export interface PluginTarget extends TargetBase {
  readonly kind: "plugin";
  readonly pluginBoundaryId: string;
  readonly pluginId: string;
  readonly childTargetIds: readonly string[];
}
export interface McpRegistration extends TargetBase {
  readonly kind: "mcp-registration";
  readonly declarationSource: SetupSourceRef;
  readonly serverKey: string;
  readonly requiredAppBindingId: string | null;
}
export interface AppBinding extends TargetBase {
  readonly kind: "app-binding";
  readonly owner: Extract<SetupOwner, { readonly kind: "plugin" }>;
  readonly declarationSource: SetupSourceRef;
  readonly alias: string;
  readonly connectorId: string;
  readonly requiredByTargetIds: readonly string[];
}
export type SessionSetupTarget =
  SkillHarnessExposure | PluginTarget | McpRegistration | AppBinding;
export type SessionSetupTargetRef =
  | {
      readonly kind: "skill-exposure";
      readonly targetId: string;
      readonly installationId: string;
    }
  | {
      readonly kind: "plugin";
      readonly targetId: string;
      readonly pluginBoundaryId: string;
    }
  | {
      readonly kind: "mcp-registration";
      readonly targetId: string;
      readonly declarationSourceId: string;
      readonly serverKey: string;
    }
  | {
      readonly kind: "app-binding";
      readonly targetId: string;
      readonly declarationSourceId: string;
      readonly alias: string;
      readonly connectorId: string;
    };
export interface SessionSetupSourceResult {
  readonly source: SetupSourceRef;
  readonly profileId: string;
  readonly harnessId: SetupHarnessId;
  readonly kind: SessionSetupTargetKind;
  readonly scope: SetupScope;
  readonly status: "success" | "unavailable" | "invalid" | "incomplete";
  readonly reason: string | null;
  readonly targetIds: readonly string[];
  readonly collateralTargetIds: readonly string[];
}
export interface SessionSetupSourceProfile {
  readonly id: string;
  readonly harnessId: SetupHarnessId;
  readonly clientSurface: "cli" | "desktop" | "cli-and-desktop" | "unknown";
  readonly sourceVersion: string;
  readonly sourceSignature: string;
  readonly qualification: "fixture-only" | "qualified" | "unsupported";
  readonly definitionScopes: readonly SetupScope["kind"][];
  readonly precedence: readonly string[];
  readonly trust: "trusted" | "untrusted" | "unknown";
  readonly offlineProbe: "metadata-only" | "none" | "unsupported";
  readonly activation: "restart" | "new-session" | "unknown";
  readonly fixtureCoverage: readonly string[];
  readonly supportedTargetKinds: readonly SessionSetupTargetKind[];
  readonly controlScopeKinds: readonly SetupScope["kind"][];
  readonly selectorEffects: readonly {
    readonly targetKind: SessionSetupTargetKind;
    readonly authority: "exact-target" | "shared-connector";
  }[];
}
export interface SessionSetupDependency {
  readonly kind: "hard" | "soft";
  readonly dependent: SessionSetupTargetRef;
  readonly required: SessionSetupTargetRef;
  readonly reason: string;
}
export interface SessionSetupSnapshot {
  readonly schemaVersion: 1;
  readonly kind: "session-setup-snapshot";
  readonly id: string;
  readonly scannedAt: string;
  readonly workspace: SetupWorkspace;
  readonly harnesses: readonly SetupHarnessId[];
  readonly targets: readonly SessionSetupTarget[];
  readonly sources: readonly SessionSetupSourceResult[];
  readonly profiles: readonly SessionSetupSourceProfile[];
  readonly dependencies: readonly SessionSetupDependency[];
  readonly legacyInventory: Inventory;
  readonly semanticFingerprint: Sha256Digest;
}
export type SessionSetupInventory = SessionSetupSnapshot;
export interface SessionSetupIntent {
  readonly schemaVersion: 1;
  readonly kind: "session-setup-intent";
  readonly action: SessionSetupAction;
  readonly harnessId: SetupHarnessId;
  readonly workspace: SetupWorkspace;
  readonly targets: readonly [
    SessionSetupTargetRef,
    ...SessionSetupTargetRef[],
  ];
}
export type SetupMutation =
  | {
      readonly kind: "configuration";
      readonly authority: Extract<
        SetupNativeMutationAuthority,
        { kind: "configuration" }
      >;
      readonly selectorId: string;
      readonly policy: "enabled" | "disabled";
    }
  | {
      readonly kind: "native-command";
      readonly authority: Extract<
        SetupNativeMutationAuthority,
        { kind: "native-command" }
      >;
      readonly selectorId: string;
      readonly policy: "enabled" | "disabled";
    };
export type SetupApproval =
  | { readonly kind: "confirmation"; readonly required: true }
  | {
      readonly kind: "scope-disclosure";
      readonly scope: SetupScope;
      readonly required: true;
    };
export interface SetupPlanAction {
  readonly id: string;
  readonly kind: "native-availability";
  readonly targets: readonly [
    SessionSetupTargetRef,
    ...SessionSetupTargetRef[],
  ];
  readonly operation: SessionSetupAction;
  readonly mutations: readonly [SetupMutation, ...SetupMutation[]];
  readonly dependsOn: readonly string[];
  readonly approvals: readonly SetupApproval[];
}
export type SetupBlock =
  | { readonly kind: "missing-target"; readonly target: SessionSetupTargetRef }
  | {
      readonly kind: "hard-dependency";
      readonly target: SessionSetupTargetRef;
      readonly dependency: SessionSetupDependency;
    }
  | {
      readonly kind: "owner-gate";
      readonly target: SessionSetupTargetRef;
      readonly owner: SessionSetupTargetRef;
    }
  | {
      readonly kind:
        | "unsupported-control"
        | "source-incomplete"
        | "source-invalid"
        | "source-unavailable"
        | "selector-collision"
        | "shared-selector-incomplete"
        | "protected"
        | "unresolved";
      readonly target: SessionSetupTargetRef;
      readonly reason: string;
    };
export type SetupWarning =
  | {
      readonly kind: "soft-reference";
      readonly target: SessionSetupTargetRef;
      readonly dependency: SessionSetupDependency;
    }
  | {
      readonly kind: "control-scope";
      readonly target: SessionSetupTargetRef;
      readonly scope: SetupScope;
    }
  | {
      readonly kind: "activation";
      readonly target: SessionSetupTargetRef;
      readonly activation: "restart" | "new-session" | "unknown";
    };
export type SetupVerification =
  | {
      readonly id: string;
      readonly kind: "native-policy";
      readonly target: SessionSetupTargetRef;
      readonly selectorId: string;
      readonly expectedPolicy: "enabled" | "disabled";
    }
  | {
      readonly id: string;
      readonly kind: "effective-workspace-state";
      readonly target: SessionSetupTargetRef;
      readonly expected: "enabled" | "disabled";
    }
  | {
      readonly id: string;
      readonly kind: "new-session-required";
      readonly target: SessionSetupTargetRef;
      readonly activation: "restart" | "new-session" | "unknown";
    };
export type SetupPlanError =
  | { readonly kind: "stale-snapshot"; readonly snapshotId: string }
  | { readonly kind: "invalid-intent" | "planner"; readonly reason: string };
export interface SessionSetupPlan {
  readonly schemaVersion: 1;
  readonly kind: "session-setup-plan";
  readonly id: string;
  readonly snapshotId: string;
  readonly snapshotFingerprint: Sha256Digest;
  readonly createdAt: string;
  readonly intent: SessionSetupIntent;
  readonly targets: readonly SessionSetupTarget[];
  readonly actions: readonly SetupPlanAction[];
  readonly blocks: readonly SetupBlock[];
  readonly warnings: readonly SetupWarning[];
  readonly verifications: readonly SetupVerification[];
  readonly errors: readonly SetupPlanError[];
}
export interface SetupExecutionError {
  readonly code: string;
  readonly message: string;
}
export type SetupActionResult =
  | { readonly actionId: string; readonly status: "succeeded" | "unchanged" }
  | {
      readonly actionId: string;
      readonly status: "failed";
      readonly error: SetupExecutionError;
    }
  | {
      readonly actionId: string;
      readonly status: "blocked";
      readonly blockedByActionIds: readonly [string, ...string[]];
    };
export type SetupTargetResult =
  | {
      readonly target: SessionSetupTargetRef;
      readonly status: "enabled" | "disabled" | "unchanged";
    }
  | {
      readonly target: SessionSetupTargetRef;
      readonly status: "failed" | "blocked" | "unverified";
      readonly error: SetupExecutionError;
    };
export type SetupVerificationResult =
  | { readonly verificationId: string; readonly status: "passed" | "skipped" }
  | {
      readonly verificationId: string;
      readonly status: "failed";
      readonly error: SetupExecutionError;
    };
export interface SessionSetupReport {
  readonly schemaVersion: 1;
  readonly kind: "session-setup-report";
  readonly planId: string;
  readonly snapshotId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "succeeded" | "unchanged" | "partial" | "blocked" | "failed";
  readonly actionResults: readonly SetupActionResult[];
  readonly targetResults: readonly SetupTargetResult[];
  readonly verificationResults: readonly SetupVerificationResult[];
  readonly finalSnapshotId: string | null;
  readonly rescanError: SetupExecutionError | null;
}
export interface SessionSetupConfigurationRequest {
  readonly path: string;
  readonly format: SetupConfigurationLayer["format"];
  readonly exists: boolean;
  readonly expectedPreimage: Sha256Digest | null;
  readonly selectors: readonly [SetupNativeSelector, ...SetupNativeSelector[]];
  readonly mutations: readonly [
    Extract<SetupMutation, { readonly kind: "configuration" }>,
    ...Extract<SetupMutation, { readonly kind: "configuration" }>[],
  ];
}
export interface SessionSetupPreparedConfiguration {
  readonly token: string;
  readonly status: "changed" | "unchanged";
}
/**
 * Checked native-document writer. Implementations retain document contents
 * behind the opaque token so public setup values cannot expose credentials.
 */
export interface SessionSetupConfigurationWriter {
  prepare(
    request: SessionSetupConfigurationRequest,
  ): Promise<SessionSetupPreparedConfiguration>;
  commit(prepared: SessionSetupPreparedConfiguration): Promise<void>;
  discard(prepared: SessionSetupPreparedConfiguration): Promise<void>;
}
export interface SessionSetupExecutionAuditRecord {
  readonly schemaVersion: 1;
  readonly plan: SessionSetupPlan;
  readonly approvals: SessionSetupApprovals;
  readonly report: SessionSetupReport;
}
export interface SessionSetupExecutionAuditWriter {
  write(record: SessionSetupExecutionAuditRecord): Promise<void>;
}
/** Injected effect boundaries for native-only Session setup execution. */
export interface SessionSetupExecutionOptions {
  readonly scan: () => Promise<SessionSetupSnapshot>;
  readonly replan: (
    snapshot: SessionSetupSnapshot,
    intent: SessionSetupIntent,
  ) => SessionSetupPlan;
  readonly configurationWriter: SessionSetupConfigurationWriter;
  readonly processRunner: import("../execution/types.js").ExecutionProcessRunner;
  readonly inspectGitProtection: import("../execution/types.js").ExecutionGitProtectionInspector;
  readonly auditWriter: SessionSetupExecutionAuditWriter;
  readonly now: () => Date;
  readonly maxConcurrency?: number;
}
export interface SessionSetupApprovals {
  readonly grants: readonly SetupApproval[];
}
export type SessionSetupPublicValue =
  | SessionSetupSnapshot
  | SessionSetupIntent
  | SessionSetupPlan
  | SessionSetupReport;
