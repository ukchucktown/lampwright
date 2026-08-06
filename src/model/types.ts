declare const modelIdBrand: unique symbol;

export type ModelId<Kind extends string> = string & {
  readonly [modelIdBrand]: Kind;
};

export type InventoryId = ModelId<"Inventory">;
export type InstallationId = ModelId<"Installation">;
export type FindingId = ModelId<"Finding">;
export type LogicalSkillId = ModelId<"LogicalSkill">;
export type RemovalPlanId = ModelId<"RemovalPlan">;
export type RemovalActionId = ModelId<"RemovalAction">;
export type VerificationCheckId = ModelId<"VerificationCheck">;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type StrongIdentityEvidence =
  | {
      readonly strength: "strong";
      readonly kind: "source";
      readonly sourceId: string;
      readonly skillPath: string;
    }
  | {
      readonly strength: "strong";
      readonly kind: "plugin";
      readonly pluginId: string;
      readonly skillId: string;
    }
  | {
      readonly strength: "strong";
      readonly kind: "canonical-target";
      readonly canonicalPath: string;
    }
  | {
      readonly strength: "strong";
      readonly kind: "package";
      readonly packageId: string;
    };

export type WeakIdentityEvidence =
  | {
      readonly strength: "weak";
      readonly kind: "name";
      readonly normalizedName: string;
    }
  | {
      readonly strength: "weak";
      readonly kind: "content-hash";
      readonly algorithm: "sha256";
      readonly digest: string;
    };

export type SkillIdentityEvidence =
  StrongIdentityEvidence | WeakIdentityEvidence;

export interface SkillIdentity {
  readonly strongEvidence: readonly StrongIdentityEvidence[];
  readonly weakEvidence: readonly WeakIdentityEvidence[];
}

export interface LogicalSkillIdentity extends SkillIdentity {
  readonly strongEvidence: readonly [
    StrongIdentityEvidence,
    ...StrongIdentityEvidence[],
  ];
}

export interface SkillDescriptor {
  readonly name: string;
  readonly description: string | null;
}

export type Scope =
  | { readonly kind: "user" }
  | { readonly kind: "workspace"; readonly workspacePath: string }
  | { readonly kind: "agent"; readonly agentId: string };

export type OwnershipConfidence = "declared" | "inferred";

export type FilesystemOwnership = {
  readonly kind: "filesystem";
  readonly confidence: OwnershipConfidence;
};

export type ManagerOwnership = {
  readonly kind: "manager";
  readonly managerId: string;
  readonly confidence: OwnershipConfidence;
};

export type PluginOwnership = {
  readonly kind: "plugin";
  readonly pluginId: string;
  readonly independentlySelectable: boolean;
  readonly confidence: OwnershipConfidence;
};

export type AgentRuntimeOwnership = {
  readonly kind: "agent-runtime";
  readonly agentId: string;
  readonly confidence: OwnershipConfidence;
};

export type UnknownOwnership = {
  readonly kind: "unknown";
  readonly confidence: "unknown";
};

export type Ownership =
  | FilesystemOwnership
  | ManagerOwnership
  | PluginOwnership
  | AgentRuntimeOwnership
  | UnknownOwnership;

export type ManagedOwnership = ManagerOwnership | PluginOwnership;

export type GitProtection =
  | { readonly kind: "outside-worktree" }
  | { readonly kind: "ignored"; readonly worktreeRoot: string }
  | { readonly kind: "protected"; readonly worktreeRoot: string };

export type SystemProtection =
  | { readonly kind: "none" }
  | { readonly kind: "system-skill"; readonly agentId: string };

export type FilesystemProtection =
  | { readonly kind: "writable" }
  | { readonly kind: "read-only"; readonly reason: string };

export interface ProtectionStatus {
  readonly git: GitProtection;
  readonly system: SystemProtection;
  readonly filesystem: FilesystemProtection;
}

export type ArtifactType =
  | { readonly kind: "directory" }
  | {
      readonly kind: "symbolic-link";
      readonly target: string;
      readonly broken: boolean;
    }
  | {
      readonly kind: "junction";
      readonly target: string;
      readonly broken: boolean;
    };

export interface ArtifactLocation {
  readonly path: string;
  readonly canonicalPath: string | null;
  readonly artifactType: ArtifactType;
}

export interface SourceReference {
  readonly id: string;
  readonly url: string | null;
}

export interface PluginReference {
  readonly id: string;
  readonly version: string | null;
}

export interface ManagerReference {
  readonly id: string;
}

export type RemovalTarget =
  | { readonly kind: "installation"; readonly installationId: InstallationId }
  | { readonly kind: "logical-skill"; readonly logicalSkillId: LogicalSkillId }
  | { readonly kind: "plugin"; readonly pluginId: string };

export type InventoryRecordReference =
  | { readonly kind: "installation"; readonly installationId: InstallationId }
  | { readonly kind: "finding"; readonly findingId: FindingId };

export type DependencySource =
  | {
      readonly kind: "manifest";
      readonly path: string;
    }
  | {
      readonly kind: "adapter";
      readonly adapterId: string;
    };

export interface HardDependency {
  readonly kind: "hard";
  readonly dependentInstallationId: InstallationId;
  readonly target: RemovalTarget;
  readonly source: DependencySource;
  readonly reason: string;
}

export interface SoftReference {
  readonly kind: "soft";
  readonly referringRecord: InventoryRecordReference;
  readonly target: RemovalTarget;
  readonly evidence: string;
}

export type Dependency = HardDependency | SoftReference;

export type InstallationClassification =
  | "active-installation"
  | "managed-plugin-resource"
  | "standalone-project-skill";

export type InstallationStatus = "active" | "broken" | "unresolved";

export interface Installation {
  readonly id: InstallationId;
  readonly classification: InstallationClassification;
  readonly status: InstallationStatus;
  readonly skill: SkillDescriptor;
  readonly identity: SkillIdentity;
  readonly source: SourceReference | null;
  readonly plugin: PluginReference | null;
  readonly manager: ManagerReference | null;
  readonly adapterId: string | null;
  readonly agentId: string;
  readonly scope: Scope;
  readonly location: ArtifactLocation;
  readonly contentHash: string | null;
  readonly modifiedAt: string | null;
  readonly ownership: Ownership;
  readonly protection: ProtectionStatus;
  readonly tags: readonly string[];
  readonly metadata: JsonObject;
}

export type NonInstallationClassification =
  "source-artifact" | "cache-or-vendor-artifact" | "system-skill" | "unknown";

interface NonInstallationFindingBase {
  readonly id: FindingId;
  readonly skill: SkillDescriptor;
  readonly identity: SkillIdentity;
  readonly source: SourceReference | null;
  readonly plugin: PluginReference | null;
  readonly manager: ManagerReference | null;
  readonly adapterId: string | null;
  readonly agentId: string | null;
  readonly scope: Scope | null;
  readonly location: ArtifactLocation;
  readonly contentHash: string | null;
  readonly modifiedAt: string | null;
  readonly ownership: Ownership;
  readonly protection: ProtectionStatus;
  readonly tags: readonly string[];
  readonly metadata: JsonObject;
}

export type NonInstallationFinding = NonInstallationFindingBase &
  (
    | {
        readonly classification:
          "source-artifact" | "cache-or-vendor-artifact" | "unknown";
      }
    | {
        readonly classification: "system-skill";
        readonly ownership: AgentRuntimeOwnership;
        readonly protection: ProtectionStatus & {
          readonly system: {
            readonly kind: "system-skill";
            readonly agentId: string;
          };
        };
      }
  );

export interface LogicalSkill {
  readonly id: LogicalSkillId;
  readonly skill: SkillDescriptor;
  readonly identity: LogicalSkillIdentity;
  readonly installationIds: readonly [InstallationId, ...InstallationId[]];
}

export interface WeakIdentityHint {
  readonly evidence: WeakIdentityEvidence;
  readonly installationIds: readonly [
    InstallationId,
    InstallationId,
    ...InstallationId[],
  ];
}

export interface Inventory {
  readonly schemaVersion: 1;
  readonly id: InventoryId;
  readonly scannedAt: string;
  readonly installations: readonly Installation[];
  readonly otherFindings: readonly NonInstallationFinding[];
  readonly logicalSkills: readonly LogicalSkill[];
  readonly identityHints: readonly WeakIdentityHint[];
  readonly dependencies: readonly Dependency[];
}

export type ApprovalRequirement =
  | { readonly kind: "confirmation" }
  | { readonly kind: "brute-force-confirmation" }
  | {
      readonly kind: "force-override";
      readonly safeguards: readonly ("dependency" | "ambiguity")[];
    }
  | {
      readonly kind: "adapter-trust";
      readonly adapterId: string;
      readonly contentHash: string;
    }
  | {
      readonly kind: "package-trust";
      readonly runner: string;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly adapterHash: string;
    };

export type FallbackAvailability =
  | {
      readonly kind: "available";
      readonly requiresSeparateConfirmation: true;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface EphemeralPackageExecution {
  readonly runner: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly adapterHash: string;
  readonly mayDownload: true;
}

interface RemovalActionBase {
  readonly id: RemovalActionId;
  readonly target: RemovalTarget;
  readonly dependsOn: readonly RemovalActionId[];
  readonly approvals: readonly ApprovalRequirement[];
}

export type ManagedRemovalAction = RemovalActionBase & {
  readonly kind: "managed-removal";
  readonly owner: ManagedOwnership;
  readonly adapterId: string;
  readonly operationId: string;
  readonly packageExecution: EphemeralPackageExecution | null;
  readonly fallback: FallbackAvailability;
};

export type QuarantineAction = RemovalActionBase & {
  readonly kind: "quarantine";
  readonly location: ArtifactLocation;
};

export type RecordCleanupAction = RemovalActionBase & {
  readonly kind: "record-cleanup";
  readonly path: string;
  readonly adapterId: string;
};

export type RemovalAction =
  ManagedRemovalAction | QuarantineAction | RecordCleanupAction;

export type PlanBlock =
  | {
      readonly kind: "hard-dependency";
      readonly target: RemovalTarget;
      readonly dependency: HardDependency;
      readonly overridable: true;
    }
  | {
      readonly kind: "ambiguous-ownership";
      readonly target: RemovalTarget;
      readonly reason: string;
      readonly overridable: true;
    }
  | {
      readonly kind: "git-protection";
      readonly target: RemovalTarget;
      readonly path: string;
      readonly overridable: false;
    }
  | {
      readonly kind: "system-skill";
      readonly target: RemovalTarget;
      readonly agentId: string;
      readonly overridable: false;
    }
  | {
      readonly kind: "filesystem-permission";
      readonly target: RemovalTarget;
      readonly path: string;
      readonly reason: string;
      readonly overridable: false;
    }
  | {
      readonly kind: "adapter-trust";
      readonly target: RemovalTarget;
      readonly adapterId: string;
      readonly contentHash: string;
      readonly overridable: false;
    };

export type PlanWarning =
  | {
      readonly kind: "soft-reference";
      readonly target: RemovalTarget;
      readonly reference: SoftReference;
    }
  | {
      readonly kind: "plugin-impact";
      readonly target: RemovalTarget;
      readonly pluginId: string;
      readonly affectedResources: readonly string[];
    }
  | {
      readonly kind: "ephemeral-download";
      readonly target: RemovalTarget;
      readonly packageExecution: EphemeralPackageExecution;
    }
  | {
      readonly kind: "unreconciled-manager-state";
      readonly target: RemovalTarget;
      readonly managerId: string;
      readonly reason: string;
    };

export type VerificationCheck =
  | {
      readonly id: VerificationCheckId;
      readonly kind: "target-unavailable";
      readonly target: RemovalTarget;
    }
  | {
      readonly id: VerificationCheckId;
      readonly kind: "path-absent";
      readonly path: string;
    }
  | {
      readonly id: VerificationCheckId;
      readonly kind: "owner-state-absent";
      readonly owner: ManagedOwnership;
      readonly externalId: string;
    };

export interface RemovalPlan {
  readonly schemaVersion: 1;
  readonly id: RemovalPlanId;
  readonly inventoryId: InventoryId;
  readonly createdAt: string;
  readonly targets: readonly RemovalTarget[];
  readonly actions: readonly RemovalAction[];
  readonly blocks: readonly PlanBlock[];
  readonly warnings: readonly PlanWarning[];
  readonly verificationChecks: readonly VerificationCheck[];
}

export interface ExecutionError {
  readonly code: string;
  readonly message: string;
  readonly details: JsonObject;
}

interface ActionResultBase {
  readonly actionId: RemovalActionId;
  readonly startedAt: string;
  readonly completedAt: string;
}

export type ActionResult =
  | (ActionResultBase & {
      readonly status: "succeeded" | "unchanged";
      readonly details: JsonObject;
    })
  | (ActionResultBase & {
      readonly status: "failed";
      readonly error: ExecutionError;
    })
  | (ActionResultBase & {
      readonly status: "blocked";
      readonly blockedByActionIds: readonly [
        RemovalActionId,
        ...RemovalActionId[],
      ];
      readonly reason: string;
    })
  | (ActionResultBase & {
      readonly status: "skipped";
      readonly reason: string;
    });

export type TargetResult =
  | {
      readonly target: RemovalTarget;
      readonly status: "removed" | "unchanged";
      readonly actionIds: readonly RemovalActionId[];
    }
  | {
      readonly target: RemovalTarget;
      readonly status: "partially-removed" | "unresolved";
      readonly actionIds: readonly RemovalActionId[];
      readonly reason: string;
    }
  | {
      readonly target: RemovalTarget;
      readonly status: "blocked";
      readonly actionIds: readonly RemovalActionId[];
      readonly reason: string;
    };

export type VerificationResult =
  | {
      readonly checkId: VerificationCheckId;
      readonly status: "passed";
      readonly details: JsonObject;
    }
  | {
      readonly checkId: VerificationCheckId;
      readonly status: "failed";
      readonly error: ExecutionError;
    };

export type ExecutionStatus = "succeeded" | "partial" | "failed" | "blocked";

export interface ExecutionReport {
  readonly schemaVersion: 1;
  readonly planId: RemovalPlanId;
  readonly inventoryId: InventoryId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: ExecutionStatus;
  readonly actionResults: readonly ActionResult[];
  readonly targetResults: readonly TargetResult[];
  readonly verificationResults: readonly VerificationResult[];
}
