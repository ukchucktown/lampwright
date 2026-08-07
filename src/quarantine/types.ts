import type {
  ArtifactLocation,
  ArtifactType,
  GitProtection,
  InstallationId,
  ManagerReference,
  Ownership,
  PluginReference,
  RemovalActionId,
  RemovalTarget,
  Sha256Digest,
  SourceReference,
} from "../model/types.js";

declare const quarantineEntryIdBrand: unique symbol;

export type QuarantineEntryId = string & {
  readonly [quarantineEntryIdBrand]: "QuarantineEntry";
};

export interface QuarantineProvenanceSubject {
  readonly installationIds: readonly InstallationId[];
  readonly ownership: Ownership;
  readonly adapterId: string | null;
  readonly source: SourceReference | null;
  readonly plugin: PluginReference | null;
  readonly manager: ManagerReference | null;
}

export interface QuarantineProvenance {
  readonly actionId: RemovalActionId;
  readonly targets: readonly [RemovalTarget, ...RemovalTarget[]];
  readonly affectedInstallationIds: readonly InstallationId[];
  readonly subjects: readonly [
    QuarantineProvenanceSubject,
    ...QuarantineProvenanceSubject[],
  ];
}

export interface RestorationMetadata {
  readonly mode: number | null;
  readonly modifiedAt: string | null;
}

interface QuarantineRequestBase {
  readonly location: ArtifactLocation;
  readonly provenance: QuarantineProvenance;
}

export type QuarantineRequest =
  | (QuarantineRequestBase & {
      readonly kind: "displaced-artifact";
    })
  | (QuarantineRequestBase & {
      readonly kind: "record-cleanup-preimage";
      readonly location: ArtifactLocation & {
        readonly artifactType: { readonly kind: "file" };
      };
      readonly expectedPreimageHash: Sha256Digest;
      readonly expectedPostimageHash: Sha256Digest;
    });

interface QuarantineEntryBase {
  readonly schemaVersion: 1;
  readonly id: QuarantineEntryId;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly originalLocation: ArtifactLocation;
  readonly integrity: Sha256Digest;
  readonly provenance: QuarantineProvenance;
  readonly restoration: RestorationMetadata;
}

export type QuarantineEntry =
  | (QuarantineEntryBase & {
      readonly kind: "displaced-artifact";
      readonly removedAt: string;
    })
  | (QuarantineEntryBase & {
      readonly kind: "record-cleanup-preimage";
      readonly capturedAt: string;
      readonly expectedPreimageHash: Sha256Digest;
      readonly expectedPostimageHash: Sha256Digest;
    });

export type QuarantineResult =
  | {
      readonly status: "quarantined";
      readonly entry: QuarantineEntry;
    }
  | {
      readonly status: "already-absent";
      readonly path: string;
    };

export type RestoreResolution =
  | {
      readonly kind: "alternate-destination";
      readonly path: string;
    }
  | { readonly kind: "replace-record-postimage" };

export type RestoreBlockReason =
  | "destination-occupied"
  | "destination-changed"
  | "git-protected"
  | "entry-not-found"
  | "integrity-failed";

export type RestoreResult =
  | {
      readonly status: "restored";
      readonly entryId: QuarantineEntryId;
      readonly destination: string;
      readonly restoredAt: string;
    }
  | {
      readonly status: "blocked";
      readonly entryId: QuarantineEntryId;
      readonly reason: RestoreBlockReason;
      readonly path: string;
    };

export type RestorePreview =
  | {
      readonly schemaVersion: 1;
      readonly status: "would-restore";
      readonly entryId: QuarantineEntryId;
      readonly destination: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "blocked";
      readonly entryId: QuarantineEntryId;
      readonly reason: RestoreBlockReason;
      readonly path: string;
    };

export type QuarantineSelection =
  | {
      readonly kind: "entries";
      readonly entryIds: readonly QuarantineEntryId[];
    }
  | { readonly kind: "expired" };

export type PurgeEntryResult =
  | {
      readonly entryId: QuarantineEntryId;
      readonly status: "purged";
    }
  | {
      readonly entryId: QuarantineEntryId;
      readonly status: "unchanged";
      readonly reason: "entry-not-found";
    }
  | {
      readonly entryId: QuarantineEntryId;
      readonly status: "blocked";
      readonly reason: "integrity-failed";
    };

export interface PurgeResult {
  readonly purgedAt: string;
  readonly entries: readonly PurgeEntryResult[];
}

export interface PurgePreview {
  readonly schemaVersion: 1;
  readonly entries: readonly (
    | { readonly entryId: QuarantineEntryId; readonly status: "would-purge" }
    | {
        readonly entryId: QuarantineEntryId;
        readonly status: "unchanged";
        readonly reason: "entry-not-found";
      }
    | {
        readonly entryId: QuarantineEntryId;
        readonly status: "blocked";
        readonly reason: "integrity-failed";
      }
  )[];
}

export interface QuarantineModule {
  list(): Promise<readonly QuarantineEntry[]>;
  quarantine(request: QuarantineRequest): Promise<QuarantineResult>;
  restore(
    entry: QuarantineEntry,
    resolution?: RestoreResolution,
  ): Promise<RestoreResult>;
  previewRestore(
    entry: QuarantineEntry,
    resolution?: RestoreResolution,
  ): Promise<RestorePreview>;
  purge(selection: QuarantineSelection): Promise<PurgeResult>;
  previewPurge(selection: QuarantineSelection): Promise<PurgePreview>;
}

export interface QuarantineModuleOptions {
  readonly stateRoot: string;
  readonly now: () => Date;
  readonly createId: () => string;
  readonly fileSystem: QuarantineFileSystem;
  readonly inspectGitProtection?: QuarantineGitProtectionInspector;
}

export type QuarantineGitProtectionInspector = (
  path: string,
  artifactType: ArtifactType,
) => Promise<GitProtection>;

export interface QuarantineFileStats {
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly mode: number;
  readonly modifiedAt: Date;
}

export interface QuarantineLink {
  readonly kind: "symbolic-link" | "junction";
  readonly target: string;
}

export interface QuarantineFileSystem {
  lstat(path: string): Promise<QuarantineFileStats>;
  readdir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<Buffer>;
  readLink(path: string): Promise<QuarantineLink>;
  realpath(path: string): Promise<string>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<void>;
  writeFile(
    path: string,
    data: string | Buffer,
    options?: { readonly exclusive?: boolean },
  ): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, accessedAt: Date, modifiedAt: Date): Promise<void>;
  symlink(
    target: string,
    path: string,
    type?: "file" | "dir" | "junction",
  ): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

export type QuarantineErrorCode =
  | "entry-exists"
  | "filesystem-unavailable"
  | "git-protected"
  | "invalid-entry"
  | "invalid-request"
  | "recovery-failed"
  | "source-changed"
  | "source-not-found"
  | "state-unsafe"
  | "unsupported-artifact";

export class QuarantineError extends Error {
  readonly code: QuarantineErrorCode;
  readonly path: string | null;

  constructor(
    code: QuarantineErrorCode,
    message: string,
    path: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "QuarantineError";
    this.code = code;
    this.path = path;
  }
}
