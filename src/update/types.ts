import type {
  ApprovalRequirement,
  ArtifactLocation,
  ExecutionApprovals,
  GeminiExtensionUpdatePolicy,
  InstallationGroupId,
  InstallationId,
  InventoryId,
  HardDependency,
  LogicalSkillId,
  ManagedOwnership,
  ManagedUpdateEvidence,
  Ownership,
  PluginSettingsRecordSnapshot,
  Scope,
  SkillIdentity,
  SoftReference,
  SourceReference,
  StrongIdentityEvidence,
  UpdateRevisionEvidence,
} from "../model/types.js";

export type UpdateTarget =
  | { readonly kind: "installation"; readonly installationId: InstallationId }
  | { readonly kind: "logical-skill"; readonly logicalSkillId: LogicalSkillId }
  | { readonly kind: "source-group"; readonly groupId: InstallationGroupId }
  | { readonly kind: "plugin"; readonly pluginBoundaryId: string };

/** One explicit target. Bulk or remote-discovery Update is not representable. */
export interface UpdateIntent {
  readonly target: UpdateTarget;
  readonly force: boolean;
}

export interface UpdateAvailabilityExpectation {
  readonly harnessStatuses: readonly {
    readonly installationId: InstallationId;
    readonly strongEvidence: readonly [
      StrongIdentityEvidence,
      ...StrongIdentityEvidence[],
    ];
    readonly harnessId: string;
    readonly status: "enabled" | "disabled";
  }[];
  readonly pluginStatus: "enabled" | "disabled" | "unresolved" | null;
}

export interface UpdateLifecycleFacts {
  readonly adapterId: string;
  readonly operationId: string;
  readonly source: SourceReference;
  readonly ref: string | null;
  readonly scope: Scope;
  readonly owner: ManagedOwnership;
  readonly externalId: string;
}

export interface UpdateInstallationBoundaryFacts {
  readonly id: InstallationId;
  readonly location: ArtifactLocation;
  readonly strongEvidence: readonly [
    StrongIdentityEvidence,
    ...StrongIdentityEvidence[],
  ];
  readonly source: SourceReference | null;
  readonly scope: Scope;
  readonly ownership: Ownership;
  readonly pluginBoundaryId: string | null;
  readonly lifecycle: UpdateLifecycleFacts | null;
}

export interface UpdatePluginBoundaryFacts {
  readonly id: string;
  readonly pluginId: string;
  readonly version: string | null;
  readonly resourceKeys: readonly string[];
  readonly settingsRecords: readonly PluginSettingsRecordSnapshot[];
  readonly policy: GeminiExtensionUpdatePolicy | null;
  readonly ownership: Extract<Ownership, { readonly kind: "plugin" }>;
  readonly lifecycle: UpdateLifecycleFacts;
}

export interface UpdateAction {
  readonly id: string;
  readonly kind: "managed-update";
  readonly target: UpdateTarget;
  readonly affectedInstallationIds: readonly InstallationId[];
  readonly dependsOn: readonly string[];
  readonly approvals: readonly ApprovalRequirement[];
  /** The complete reviewed authority. Execution never reconstructs it. */
  readonly operation: ManagedUpdateEvidence;
  readonly availabilityExpectation: UpdateAvailabilityExpectation;
  readonly selectedInstallations: readonly UpdateInstallationBoundaryFacts[];
  readonly selectedPlugin: UpdatePluginBoundaryFacts | null;
}

export interface UpdateBlock {
  readonly kind:
    | "unsupported-update"
    | "unresolved-update"
    | "operation-unavailable"
    | "plugin-child"
    | "system-skill"
    | "runtime-default-plugin"
    | "unresolved-availability"
    | "git-protection"
    | "filesystem-permission"
    | "adapter-trust"
    | "ambiguous-owner"
    | "local-changes"
    | "dependency-cycle"
    | "independent-boundary"
    | "incomplete-authority";
  readonly target: UpdateTarget;
  readonly installationId: InstallationId | null;
  readonly path: string | null;
  readonly reason: string;
  readonly overridable: false;
}

export type UpdateWarning =
  | {
      readonly kind: "network-access";
      readonly target: UpdateTarget;
      readonly actionId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "package-download";
      readonly target: UpdateTarget;
      readonly actionId: string;
      readonly packageName: string;
      readonly packageVersion: string;
    }
  | {
      readonly kind: "local-change-unavailable";
      readonly target: UpdateTarget;
      readonly installationId: InstallationId | null;
      readonly reason: string;
    }
  | {
      readonly kind: "soft-reference";
      readonly target: UpdateTarget;
      readonly reference: SoftReference;
    }
  | {
      readonly kind: "hard-dependency";
      readonly target: UpdateTarget;
      readonly dependency: HardDependency;
    }
  | {
      readonly kind: "plugin-impact";
      readonly target: Extract<UpdateTarget, { readonly kind: "plugin" }>;
      readonly pluginId: string;
      readonly installationIds: readonly InstallationId[];
    };

export interface UpdateVerificationCheck {
  readonly id: string;
  readonly actionId: string;
  readonly target: UpdateTarget;
  readonly installationId: InstallationId | null;
  readonly pluginBoundaryId: string | null;
  readonly identity: SkillIdentity | null;
  readonly pluginId: string | null;
  readonly source: SourceReference;
  readonly ref: string | null;
  readonly scope: Scope;
  readonly owner: ManagedOwnership;
  readonly currentRevision: readonly [
    UpdateRevisionEvidence,
    ...UpdateRevisionEvidence[],
  ];
  readonly availabilityExpectation: UpdateAvailabilityExpectation;
}

export interface UpdatePlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly inventoryId: InventoryId;
  readonly createdAt: string;
  readonly intent: UpdateIntent;
  readonly targets: readonly [UpdateTarget];
  readonly actions: readonly UpdateAction[];
  readonly blocks: readonly UpdateBlock[];
  readonly warnings: readonly UpdateWarning[];
  readonly verificationChecks: readonly UpdateVerificationCheck[];
}

export interface UpdateExecutionError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type UpdateActionResult =
  | {
      readonly actionId: string;
      readonly status: "succeeded";
      readonly startedAt: string;
      readonly completedAt: string;
      readonly details: Readonly<
        Record<string, string | number | boolean | null>
      >;
    }
  | {
      readonly actionId: string;
      readonly status: "failed";
      readonly startedAt: string;
      readonly completedAt: string;
      readonly error: UpdateExecutionError;
    }
  | {
      readonly actionId: string;
      readonly status: "blocked";
      readonly startedAt: string;
      readonly completedAt: string;
      readonly blockedByActionIds: readonly [string, ...string[]];
      readonly reason: string;
    }
  | {
      readonly actionId: string;
      readonly status: "skipped";
      readonly startedAt: string;
      readonly completedAt: string;
      readonly reason: string;
    };

export type UpdateVerificationResult =
  | {
      readonly checkId: string;
      readonly status: "passed";
      readonly changed: boolean;
      readonly details: Readonly<
        Record<string, string | number | boolean | null>
      >;
    }
  | {
      readonly checkId: string;
      readonly status: "failed";
      readonly error: UpdateExecutionError;
    }
  | {
      readonly checkId: string;
      readonly status: "skipped";
      readonly reason: string;
    };

export interface UpdateTargetResult {
  readonly target: UpdateTarget;
  readonly status:
    | "updated"
    | "unchanged"
    | "partially-updated"
    | "blocked"
    | "failed"
    | "unresolved";
  readonly actionIds: readonly string[];
  readonly reason: string | null;
}

export interface UpdateReport {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly inventoryId: InventoryId;
  readonly finalInventoryId: InventoryId | null;
  readonly rescanError: UpdateExecutionError | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "succeeded" | "partial" | "failed" | "blocked";
  readonly actionResults: readonly UpdateActionResult[];
  readonly targetResults: readonly [UpdateTargetResult];
  readonly verificationResults: readonly UpdateVerificationResult[];
}

export type UpdateApprovals = ExecutionApprovals;
