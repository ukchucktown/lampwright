import type {
  ArtifactLocation,
  ArtifactType,
  GitProtection,
  HarnessExposure,
  InstallationId,
  Ownership,
  Sha256Digest,
  SkillIdentity,
} from "../model/types.js";
import type { ArtifactFileSystem } from "../filesystem/artifact-filesystem.js";

export interface DisabledRestorationMetadata {
  readonly mode: number | null;
  readonly modifiedAt: string | null;
}
export type DisabledGitProtectionInspector = (
  path: string,
  artifactType: ArtifactType,
) => Promise<GitProtection>;

declare const disabledEntryIdBrand: unique symbol;

/** Opaque identifier for one suspended filesystem artifact. */
export type DisabledEntryId = string & {
  readonly [disabledEntryIdBrand]: "DisabledEntry";
};

/** Display evidence retained from the approved availability operation. */
export interface DisabledOperationProvenance {
  readonly id: string;
  readonly displayNames: readonly [string, ...string[]];
}

/**
 * Versioned, non-expiring record for a Suspended Disable.
 *
 * This is intentionally not a Quarantine entry: it has no removal timestamp,
 * retention policy, or purge operation.
 */
export interface DisabledArtifact {
  readonly originalLocation: ArtifactLocation;
  readonly integrity: Sha256Digest;
  readonly restoration: DisabledRestorationMetadata;
}

export interface DisabledEntryV1 {
  readonly schemaVersion: 1;
  readonly id: DisabledEntryId;
  readonly suspendedAt: string;
  readonly originalLocation: ArtifactLocation;
  readonly integrity: Sha256Digest;
  readonly skillIdentity: SkillIdentity;
  readonly installationIds: readonly [InstallationId, ...InstallationId[]];
  readonly ownership: Ownership;
  readonly harnessExposures: readonly HarnessExposure[];
  readonly operation: DisabledOperationProvenance;
  readonly restoration: DisabledRestorationMetadata;
}

export interface DisabledEntryV2 {
  readonly schemaVersion: 2;
  readonly id: DisabledEntryId;
  readonly suspendedAt: string;
  readonly artifacts: readonly [DisabledArtifact, ...DisabledArtifact[]];
  readonly skillIdentity: SkillIdentity;
  readonly installationIds: readonly [InstallationId, ...InstallationId[]];
  readonly ownership: Extract<Ownership, { kind: "filesystem" | "manager" }>;
  readonly harnessExposures: readonly HarnessExposure[];
  readonly operation: DisabledOperationProvenance;
}

export type DisabledEntry = DisabledEntryV1 | DisabledEntryV2;

export interface SuspendArtifact {
  readonly location: ArtifactLocation;
}

/** The complete planner-authorized evidence required to suspend an Installation. */
export interface SuspendRequestV1 {
  readonly location: ArtifactLocation;
  readonly skillIdentity: SkillIdentity;
  readonly installationIds: readonly [InstallationId, ...InstallationId[]];
  readonly ownership: Ownership;
  readonly harnessExposures: readonly HarnessExposure[];
  readonly operation: DisabledOperationProvenance;
}

export interface SuspendRequestV2 {
  readonly schemaVersion: 2;
  readonly artifacts: readonly [SuspendArtifact, ...SuspendArtifact[]];
  readonly skillIdentity: SkillIdentity;
  readonly installationIds: readonly [InstallationId, ...InstallationId[]];
  readonly ownership: Extract<Ownership, { kind: "filesystem" | "manager" }>;
  readonly harnessExposures: readonly HarnessExposure[];
  readonly operation: DisabledOperationProvenance;
}

export type SuspendRequest = SuspendRequestV1 | SuspendRequestV2;

export type DisabledBlockReason =
  | "destination-occupied"
  | "git-protected"
  | "integrity-failed"
  | "entry-not-found"
  | "state-unsafe"
  | "source-not-eligible";

export type SuspendResult =
  | { readonly status: "suspended"; readonly entry: DisabledEntry }
  | { readonly status: "already-absent"; readonly path: string }
  | {
      readonly status: "blocked";
      readonly path: string;
      readonly reason: DisabledBlockReason;
    };

export type EnablePreview =
  | {
      readonly schemaVersion: 1;
      readonly status: "would-enable";
      readonly entryId: DisabledEntryId;
      readonly destination: string;
      readonly destinations?: readonly [string, ...string[]];
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "blocked";
      readonly entryId: DisabledEntryId;
      readonly path: string;
      readonly reason: DisabledBlockReason;
    };

export type EnableResult =
  | {
      readonly status: "enabled";
      readonly entryId: DisabledEntryId;
      readonly destination: string;
      readonly destinations?: readonly [string, ...string[]];
      readonly enabledAt: string;
    }
  | {
      readonly status: "blocked";
      readonly entryId: DisabledEntryId;
      readonly path: string;
      readonly reason: DisabledBlockReason;
    };

/** The only stateful interface for Suspended Disable. It deliberately has no purge. */
export interface DisabledStorageModule {
  list(): Promise<readonly DisabledEntry[]>;
  suspend(request: SuspendRequest): Promise<SuspendResult>;
  previewEnable(entry: DisabledEntry): Promise<EnablePreview>;
  enable(entry: DisabledEntry): Promise<EnableResult>;
}

export interface DisabledStorageModuleOptions {
  readonly stateRoot: string;
  readonly now: () => Date;
  readonly createId: () => string;
  readonly fileSystem: ArtifactFileSystem;
  readonly inspectGitProtection?: DisabledGitProtectionInspector;
}
