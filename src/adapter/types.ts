import type { JsonPrimitive, PackageRunner } from "../model/types.js";

export type AdapterPlatform = "darwin" | "linux" | "win32";

export interface PlatformVariant<Value> {
  readonly default?: Value;
  readonly darwin?: Value;
  readonly linux?: Value;
  readonly win32?: Value;
}

export type AdapterPathBase =
  "home" | "workspace" | "config" | "state" | "cache" | "temporary";

export type AdapterPathBases = Readonly<Record<AdapterPathBase, string>>;

export interface AdapterPathTemplate {
  readonly base: AdapterPathBase;
  readonly segments: readonly string[];
}

export type AdapterCommandValue =
  | "installationPath"
  | "canonicalPath"
  | "skillName"
  | "sourceId"
  | "pluginId"
  | "managerId"
  | "externalId"
  | "manifestPath"
  | "scopePath";

export type AdapterCommandArgument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "value"; readonly from: AdapterCommandValue };

export interface AdapterCommandTemplate {
  readonly executable: string;
  readonly arguments: readonly AdapterCommandArgument[];
}

export type AdapterValueSelector =
  | { readonly kind: "literal"; readonly value: JsonPrimitive }
  | { readonly kind: "pointer"; readonly pointer: string }
  | { readonly kind: "record-key" };

interface AdapterDeclarationBase {
  readonly id: string;
  readonly platforms?: readonly AdapterPlatform[];
}

export type AdapterProbeDefinition =
  | (AdapterDeclarationBase & {
      readonly kind: "path";
      readonly path: PlatformVariant<AdapterPathTemplate>;
      readonly pathType: "file" | "directory";
    })
  | (AdapterDeclarationBase & {
      readonly kind: "executable";
      readonly executable: PlatformVariant<string>;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "command";
      readonly command: PlatformVariant<AdapterCommandTemplate>;
      readonly successExitCodes: readonly number[];
    });

export type AdapterScopeTemplate =
  | { readonly kind: "user" }
  | { readonly kind: "workspace" }
  | { readonly kind: "agent"; readonly agentId: string };

export type AdapterRootKind =
  | "user"
  | "agent"
  | "workspace"
  | "plugin"
  | "source"
  | "cache-or-vendor"
  | "system"
  | "unknown";

export interface AdapterRootDefinition extends AdapterDeclarationBase {
  readonly kind: AdapterRootKind;
  readonly path: PlatformVariant<AdapterPathTemplate>;
  readonly requiresProbes?: readonly string[];
  readonly agentId?: string | null;
  readonly scope?: AdapterScopeTemplate | null;
  readonly plugin?: {
    readonly id: string;
    readonly version: string | null;
  };
  readonly independentlySelectable?: boolean;
  readonly source?: {
    readonly id: string;
    readonly url: string | null;
  };
}

export type AdapterManifestFormat = "json" | "jsonc" | "yaml";
export type AdapterManifestCollection =
  "single" | "array" | "object-values" | "object-entries";

export interface AdapterManifestFields {
  readonly skillName?: AdapterValueSelector;
  readonly description?: AdapterValueSelector;
  readonly skillPath?: AdapterValueSelector;
  readonly sourceId?: AdapterValueSelector;
  readonly sourceUrl?: AdapterValueSelector;
  readonly pluginId?: AdapterValueSelector;
  readonly pluginVersion?: AdapterValueSelector;
  readonly managerId?: AdapterValueSelector;
  readonly agentId?: AdapterValueSelector;
  readonly status?: AdapterValueSelector;
  readonly tags?: AdapterValueSelector;
}

export interface AdapterMetadataMapping {
  readonly namespace: string;
  readonly key: string;
  readonly value: AdapterValueSelector;
}

export interface AdapterManifestDefinition extends AdapterDeclarationBase {
  readonly path: PlatformVariant<AdapterPathTemplate>;
  readonly format: AdapterManifestFormat;
  readonly requiresProbes?: readonly string[];
  readonly records: {
    readonly pointer: string;
    readonly collection: AdapterManifestCollection;
  };
  readonly fields: AdapterManifestFields;
  readonly metadata?: readonly AdapterMetadataMapping[];
}

export type AdapterRuleSource =
  | { readonly kind: "root"; readonly rootId: string }
  | { readonly kind: "manifest"; readonly manifestId: string };

export type AdapterOwnershipTemplate =
  | { readonly kind: "filesystem" }
  | {
      readonly kind: "manager";
      readonly managerId: AdapterValueSelector;
    }
  | {
      readonly kind: "plugin";
      readonly pluginId: AdapterValueSelector;
      readonly independentlySelectable: boolean;
    }
  | {
      readonly kind: "agent-runtime";
      readonly agentId: AdapterValueSelector;
    }
  | { readonly kind: "unknown" };

export interface AdapterOwnershipRule extends AdapterDeclarationBase {
  readonly source: AdapterRuleSource;
  readonly ownership: AdapterOwnershipTemplate;
  readonly confidence: "declared" | "inferred";
}

export type AdapterGroupingEvidence =
  | {
      readonly kind: "source";
      readonly sourceId: AdapterValueSelector;
      readonly skillPath: AdapterValueSelector;
    }
  | {
      readonly kind: "plugin";
      readonly pluginId: AdapterValueSelector;
      readonly skillId: AdapterValueSelector;
    }
  | {
      readonly kind: "canonical-target";
      readonly canonicalPath: AdapterValueSelector;
    }
  | {
      readonly kind: "package";
      readonly packageId: AdapterValueSelector;
    };

export interface AdapterGroupingRule extends AdapterDeclarationBase {
  readonly manifestId: string;
  readonly evidence: AdapterGroupingEvidence;
}

export type AdapterTargetTemplate =
  | {
      readonly kind: "installation";
      readonly installationId: AdapterValueSelector;
    }
  | {
      readonly kind: "logical-skill";
      readonly logicalSkillId: AdapterValueSelector;
    }
  | { readonly kind: "plugin"; readonly pluginId: AdapterValueSelector };

export interface AdapterHardDependencyDefinition extends AdapterDeclarationBase {
  readonly manifestId: string;
  readonly dependentInstallationId: AdapterValueSelector;
  readonly target: AdapterTargetTemplate;
  readonly reason: AdapterValueSelector;
}

interface AdapterRemovalActionBase extends AdapterDeclarationBase {
  readonly ownerKind: "manager" | "plugin";
  readonly operationId: string;
  readonly requiresProbes?: readonly string[];
  readonly verificationRules?: readonly string[];
}

export type AdapterRemovalActionDefinition =
  | (AdapterRemovalActionBase & {
      readonly kind: "managed";
      readonly command: PlatformVariant<AdapterCommandTemplate>;
    })
  | (AdapterRemovalActionBase & {
      readonly kind: "ephemeral-package";
      readonly runner: PackageRunner;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly mayDownload: true;
      readonly arguments: readonly AdapterCommandArgument[];
    });

export type AdapterVerificationDefinition =
  | (AdapterDeclarationBase & {
      readonly kind: "path-absent";
      readonly path: PlatformVariant<AdapterPathTemplate>;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "manifest-record-absent";
      readonly manifestId: string;
      readonly selector: AdapterValueSelector;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "owner-state-absent";
      readonly ownerKind: "manager" | "plugin";
      readonly externalId: AdapterValueSelector;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "command";
      readonly command: PlatformVariant<AdapterCommandTemplate>;
      readonly successExitCodes: readonly number[];
    });

export interface AdapterDefinitionV1 {
  readonly $schema?: string;
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly platforms: readonly AdapterPlatform[];
  readonly probes?: readonly AdapterProbeDefinition[];
  readonly roots?: readonly AdapterRootDefinition[];
  readonly manifests?: readonly AdapterManifestDefinition[];
  readonly ownershipRules?: readonly AdapterOwnershipRule[];
  readonly groupingRules?: readonly AdapterGroupingRule[];
  readonly hardDependencies?: readonly AdapterHardDependencyDefinition[];
  readonly actions?: readonly AdapterRemovalActionDefinition[];
  readonly verificationRules?: readonly AdapterVerificationDefinition[];
}

export interface AdapterTrustApproval {
  readonly adapterId: string;
  readonly contentHash: string;
}

export interface AdapterLoadRequest {
  readonly localAdapterPaths?: readonly string[];
  readonly platform?: AdapterPlatform;
  readonly pathBases?: Partial<AdapterPathBases>;
  readonly approvals?: readonly AdapterTrustApproval[];
}

export type CompiledAdapterSource =
  | { readonly kind: "built-in"; readonly name: string }
  | {
      readonly kind: "local";
      readonly path: string;
      readonly contentHash: string;
    };

export type CompiledAdapterTrust =
  | { readonly kind: "built-in" }
  | { readonly kind: "read-only" }
  | { readonly kind: "approved"; readonly contentHash: string };

export type CompiledAdapterProbe =
  | (Omit<Extract<AdapterProbeDefinition, { kind: "path" }>, "path"> & {
      readonly path: string;
    })
  | (Omit<
      Extract<AdapterProbeDefinition, { kind: "executable" }>,
      "executable"
    > & { readonly executable: string })
  | (Omit<Extract<AdapterProbeDefinition, { kind: "command" }>, "command"> & {
      readonly command: AdapterCommandTemplate;
    });

export type CompiledAdapterScope =
  | { readonly kind: "user" }
  | { readonly kind: "workspace"; readonly workspacePath: string }
  | { readonly kind: "agent"; readonly agentId: string };

export interface CompiledAdapterRoot extends Omit<
  AdapterRootDefinition,
  "path" | "scope"
> {
  readonly path: string;
  readonly scope?: CompiledAdapterScope | null;
  readonly workspacePath?: string;
}

export interface CompiledAdapterManifest extends Omit<
  AdapterManifestDefinition,
  "path"
> {
  readonly path: string;
}

export type CompiledAdapterRemovalAction =
  | (Omit<
      Extract<AdapterRemovalActionDefinition, { kind: "managed" }>,
      "command"
    > & { readonly command: AdapterCommandTemplate })
  | Extract<AdapterRemovalActionDefinition, { kind: "ephemeral-package" }>;

export type CompiledAdapterVerification =
  | (Omit<
      Extract<AdapterVerificationDefinition, { kind: "path-absent" }>,
      "path"
    > & { readonly path: string })
  | Extract<
      AdapterVerificationDefinition,
      { kind: "manifest-record-absent" | "owner-state-absent" }
    >
  | (Omit<
      Extract<AdapterVerificationDefinition, { kind: "command" }>,
      "command"
    > & { readonly command: AdapterCommandTemplate });

export interface CompiledAdapter {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly platforms: readonly AdapterPlatform[];
  readonly source: CompiledAdapterSource;
  readonly trust: CompiledAdapterTrust;
  readonly commandCapable: boolean;
  readonly probes: readonly CompiledAdapterProbe[];
  readonly roots: readonly CompiledAdapterRoot[];
  readonly manifests: readonly CompiledAdapterManifest[];
  readonly ownershipRules: readonly AdapterOwnershipRule[];
  readonly groupingRules: readonly AdapterGroupingRule[];
  readonly hardDependencies: readonly AdapterHardDependencyDefinition[];
  readonly actions: readonly CompiledAdapterRemovalAction[];
  readonly verificationRules: readonly CompiledAdapterVerification[];
}

export interface AdapterCatalog {
  readonly schemaVersion: 1;
  readonly platform: AdapterPlatform;
  readonly adapters: readonly CompiledAdapter[];
}

export type AdapterLoadErrorCode =
  | "invalid-request"
  | "unsupported-source"
  | "read-failed"
  | "parse-failed"
  | "schema-invalid"
  | "unsupported-version"
  | "unsafe-command"
  | "duplicate-id"
  | "invalid-reference"
  | "trust-required";

export class AdapterLoadError extends Error {
  readonly code: AdapterLoadErrorCode;
  readonly sourcePath: string | null;

  constructor(
    code: AdapterLoadErrorCode,
    message: string,
    sourcePath: string | null = null,
  ) {
    super(message);
    this.name = "AdapterLoadError";
    this.code = code;
    this.sourcePath = sourcePath;
  }
}

export interface AdapterTrustRequirement {
  readonly adapterId: string;
  readonly contentHash: string;
  readonly path: string;
}

export class AdapterTrustRequiredError extends AdapterLoadError {
  readonly requirements: readonly AdapterTrustRequirement[];

  constructor(requirements: readonly AdapterTrustRequirement[]) {
    super(
      "trust-required",
      "local command-capable adapters require exact content-hash approval",
    );
    this.name = "AdapterTrustRequiredError";
    this.requirements = requirements;
  }
}
