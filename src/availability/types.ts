import type {
  ApprovalRequirement,
  HardDependency,
  InstallationId,
  InventoryId,
  LogicalSkillId,
  NativeControlDocumentScope,
  NativeControlFormat,
  ProtectionStatus,
  Sha256Digest,
  SoftReference,
} from "../model/types.js";
import type {
  DisabledEntry,
  DisabledEntryId,
  SuspendRequest,
} from "../disabled-storage/types.js";

export type AvailabilityTarget =
  | { readonly kind: "installation"; readonly installationId: InstallationId }
  | { readonly kind: "logical-skill"; readonly logicalSkillId: LogicalSkillId }
  | { readonly kind: "plugin"; readonly pluginBoundaryId: string }
  | { readonly kind: "source-group"; readonly groupId: string };

export interface AvailabilityIntent {
  readonly operation: "disable" | "enable";
  readonly targets: readonly AvailabilityTarget[];
  readonly force: boolean;
}

export type NativeMutationOperation =
  | {
      readonly kind: "codex-skills-config";
      readonly selectorPath: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "claude-skill-overrides";
      readonly skillName: string;
      readonly mode: "on" | "off";
    }
  | {
      readonly kind: "gemini-disabled-skills";
      readonly skillName: string;
      readonly disabled: boolean;
    }
  | {
      readonly kind: "codex-plugin-enabled";
      readonly pluginId: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "claude-enabled-plugins";
      readonly pluginId: string;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "gemini-extension-enablement";
      readonly pluginId: string;
      readonly scopePath: string;
      readonly enabled: boolean;
    };

export interface NativeConfigurationMutation {
  readonly path: string;
  readonly format: NativeControlFormat;
  readonly documentScope: NativeControlDocumentScope;
  readonly exists: boolean;
  readonly expectedPreimageHash: Sha256Digest | null;
  readonly protection: ProtectionStatus;
  readonly operation: NativeMutationOperation;
}

export type NativeControlEffect =
  | {
      readonly installationId: InstallationId;
      readonly harnessId: string;
      readonly operation: "disable" | "enable";
    }
  | {
      readonly pluginBoundaryId: string;
      readonly harnessId: string;
      readonly operation: "disable" | "enable";
    };

interface AvailabilityActionBase {
  readonly id: string;
  readonly targets: readonly [AvailabilityTarget, ...AvailabilityTarget[]];
  readonly affectedInstallationIds: readonly InstallationId[];
  readonly dependsOn: readonly string[];
  readonly approvals: readonly ApprovalRequirement[];
}

export type AvailabilityAction =
  | (AvailabilityActionBase & {
      readonly kind: "native-control";
      readonly effects: readonly [
        NativeControlEffect,
        ...NativeControlEffect[],
      ];
      readonly mutations: readonly [
        NativeConfigurationMutation,
        ...NativeConfigurationMutation[],
      ];
    })
  | (AvailabilityActionBase & {
      readonly kind: "suspended-disable";
      readonly installationId: InstallationId;
      readonly request: SuspendRequest;
    })
  | (AvailabilityActionBase & {
      readonly kind: "suspended-enable";
      readonly entry: DisabledEntry;
    });

export type AvailabilityBlock =
  | {
      readonly kind: "hard-dependency";
      readonly target: AvailabilityTarget;
      readonly dependency: HardDependency;
      readonly overridable: true;
    }
  | {
      readonly kind:
        | "name-collision"
        | "unresolved-exposure"
        | "unsupported-control"
        | "ownership"
        | "system-skill"
        | "git-protection"
        | "filesystem-permission"
        | "configuration-unsafe"
        | "entry-not-found";
      readonly target: AvailabilityTarget;
      readonly reason: string;
      readonly path: string | null;
      readonly overridable: false;
    };

export interface AvailabilityWarning {
  readonly kind: "soft-reference";
  readonly target: AvailabilityTarget;
  readonly reference: SoftReference;
}

export type AvailabilityVerificationCheck =
  | {
      readonly id: string;
      readonly kind: "harness-exposure-state";
      readonly target: AvailabilityTarget;
      readonly actionId: string | null;
      readonly installationId: InstallationId;
      readonly harnessId: string;
      readonly expectedStatus: "enabled" | "disabled";
    }
  | {
      readonly id: string;
      readonly kind: "disabled-entry-state";
      readonly target: AvailabilityTarget;
      readonly actionId: string;
      readonly entryId: DisabledEntryId | null;
      readonly installationId: InstallationId;
      readonly expectedPresent: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "plugin-state";
      readonly target: AvailabilityTarget;
      readonly actionId: string | null;
      readonly pluginBoundaryId: string;
      readonly expectedStatus: "enabled" | "disabled";
    };

export interface AvailabilityPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly inventoryId: InventoryId;
  readonly createdAt: string;
  readonly intent: AvailabilityIntent;
  readonly targets: readonly AvailabilityTarget[];
  readonly disabledEntryIds: readonly DisabledEntryId[];
  readonly actions: readonly AvailabilityAction[];
  readonly blocks: readonly AvailabilityBlock[];
  readonly warnings: readonly AvailabilityWarning[];
  readonly verificationChecks: readonly AvailabilityVerificationCheck[];
}

export interface AvailabilityExecutionError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export type AvailabilityActionResult =
  | {
      readonly actionId: string;
      readonly status: "succeeded" | "unchanged";
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
      readonly error: AvailabilityExecutionError;
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

export interface AvailabilityTargetResult {
  readonly target: AvailabilityTarget;
  readonly status:
    "disabled" | "enabled" | "unchanged" | "partial" | "failed" | "blocked";
  readonly actionIds: readonly string[];
  readonly reason: string | null;
}

export type AvailabilityVerificationResult =
  | {
      readonly checkId: string;
      readonly status: "passed";
      readonly details: Readonly<
        Record<string, string | number | boolean | null>
      >;
    }
  | {
      readonly checkId: string;
      readonly status: "failed";
      readonly error: AvailabilityExecutionError;
    }
  | {
      readonly checkId: string;
      readonly status: "skipped";
      readonly reason: string;
    };

export interface AvailabilityReport {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly inventoryId: InventoryId;
  readonly finalInventoryId: InventoryId | null;
  readonly rescanError: AvailabilityExecutionError | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "succeeded" | "partial" | "failed" | "blocked";
  readonly actionResults: readonly AvailabilityActionResult[];
  readonly targetResults: readonly AvailabilityTargetResult[];
  readonly verificationResults: readonly AvailabilityVerificationResult[];
}
