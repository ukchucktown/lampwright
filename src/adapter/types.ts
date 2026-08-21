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
  /** Stable owner selector used by a bound managed operation. */
  readonly externalId?: AdapterValueSelector;
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
  /** The bounded root containing every skill path declared by this manifest. */
  readonly rootId: string;
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
  /** The root or manifest record which supplies this operation's values. */
  readonly source?: AdapterRuleSource;
  readonly ownerKind: "manager" | "plugin";
  readonly operationId: string;
  readonly requiresProbes?: readonly string[];
  readonly verificationRules?: readonly string[];
  readonly effects?: readonly AdapterManagedEffectDefinition[];
}

export type AdapterManagedEffectPath =
  | {
      readonly kind: "static";
      readonly path: PlatformVariant<AdapterPathTemplate>;
    }
  | {
      readonly kind: "value";
      readonly from: "installationPath" | "manifestPath";
    };

export interface AdapterManagedEffectDefinition {
  readonly kind: "remove-path" | "modify-path";
  readonly path: AdapterManagedEffectPath;
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

export type AdapterRuntimePathDefinition =
  | {
      readonly kind: "static";
      readonly path: PlatformVariant<AdapterPathTemplate>;
    }
  | {
      readonly kind: "value";
      readonly from: "installationPath" | "manifestPath" | "scopePath";
    };

export type AdapterWorkingDirectoryDefinition =
  | { readonly kind: "isolated-temporary" }
  | {
      readonly kind: "exact";
      readonly path: AdapterRuntimePathDefinition;
    };

export type AdapterNetworkDisclosure =
  | { readonly kind: "none" }
  | { readonly kind: "required"; readonly reason: string };

export type AdapterLifecycleInvocationDefinition =
  | {
      readonly kind: "direct";
      readonly command: PlatformVariant<AdapterCommandTemplate>;
    }
  | {
      readonly kind: "ephemeral-package";
      readonly runner: PackageRunner;
      readonly packageName: string;
      readonly packageVersion: string;
      readonly mayDownload: true;
      readonly arguments: readonly AdapterCommandArgument[];
    };

export interface AdapterRemovalEffectDefinition {
  readonly kind: "remove-path" | "modify-path";
  readonly path: AdapterManagedEffectPath;
}

export interface AdapterUpdateEffectDefinition {
  readonly kind: "mutation-root" | "configuration-path";
  readonly path: AdapterRuntimePathDefinition;
}

export type AdapterLocalChangeEvidenceDefinition =
  | {
      readonly kind: "content-hash-match";
      readonly algorithm: "sha256";
      readonly path: AdapterRuntimePathDefinition;
      readonly manifestId: string;
      readonly expectedDigest: AdapterValueSelector;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
    };

interface AdapterLifecycleOperationBase extends AdapterDeclarationBase {
  /** The root or manifest record which supplies this operation's values. */
  readonly source: AdapterRuleSource;
  readonly ownerKind: "manager" | "plugin";
  readonly operationId: string;
  readonly requiresProbes?: readonly string[];
  readonly workingDirectory: AdapterWorkingDirectoryDefinition;
  readonly invocation: AdapterLifecycleInvocationDefinition;
  readonly network: AdapterNetworkDisclosure;
  readonly verificationRules: readonly string[];
}

export interface AdapterManagedRemovalOperationDefinition extends AdapterLifecycleOperationBase {
  readonly lifecycle: "remove";
  readonly effects: readonly AdapterRemovalEffectDefinition[];
}

export interface AdapterManagedUpdateOperationDefinition extends AdapterLifecycleOperationBase {
  readonly lifecycle: "update";
  readonly effects: readonly AdapterUpdateEffectDefinition[];
  readonly localChangeEvidence: AdapterLocalChangeEvidenceDefinition;
}

export type AdapterLifecycleOperationDefinition =
  | AdapterManagedRemovalOperationDefinition
  | AdapterManagedUpdateOperationDefinition;

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

export type AdapterUpdateVerificationDefinition =
  | (AdapterDeclarationBase & {
      readonly kind: "path-present";
      readonly path: PlatformVariant<AdapterPathTemplate>;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "manifest-record-present";
      readonly manifestId: string;
      readonly selector: AdapterValueSelector;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "owner-state-present";
      readonly ownerKind: "manager" | "plugin";
      readonly externalId: AdapterValueSelector;
    })
  | (AdapterDeclarationBase & {
      readonly kind: "revision-evidence";
      readonly evidence:
        | {
            readonly kind: "content-hash";
            readonly path: AdapterRuntimePathDefinition;
          }
        | {
            readonly kind: "manifest-value";
            readonly manifestId: string;
            readonly selector: AdapterValueSelector;
          };
    });

export type AdapterVerificationDefinitionV2 =
  AdapterVerificationDefinition | AdapterUpdateVerificationDefinition;

interface AdapterDefinitionBase {
  readonly $schema?: string;
  readonly id: string;
  readonly name: string;
  readonly platforms: readonly AdapterPlatform[];
  readonly probes?: readonly AdapterProbeDefinition[];
  readonly roots?: readonly AdapterRootDefinition[];
  readonly manifests?: readonly AdapterManifestDefinition[];
  readonly ownershipRules?: readonly AdapterOwnershipRule[];
  readonly groupingRules?: readonly AdapterGroupingRule[];
  readonly hardDependencies?: readonly AdapterHardDependencyDefinition[];
}

export interface AdapterDefinitionV1 extends AdapterDefinitionBase {
  readonly schemaVersion: 1;
  readonly actions?: readonly AdapterRemovalActionDefinition[];
  readonly verificationRules?: readonly AdapterVerificationDefinition[];
}

export interface AdapterDefinitionV2 extends AdapterDefinitionBase {
  readonly schemaVersion: 2;
  readonly lifecycleOperations?: readonly AdapterLifecycleOperationDefinition[];
  readonly verificationRules?: readonly AdapterVerificationDefinitionV2[];
}

export type AdapterDefinition = AdapterDefinitionV1 | AdapterDefinitionV2;

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
  /** Lexically selected template base; retained for runtime canonical checks. */
  readonly pathBase: string;
  readonly scope?: CompiledAdapterScope | null;
  readonly workspacePath?: string;
}

export interface CompiledAdapterManifest extends Omit<
  AdapterManifestDefinition,
  "path"
> {
  readonly path: string;
  /** Lexically selected template base; retained for runtime canonical checks. */
  readonly pathBase: string;
}

export type CompiledAdapterManagedEffect =
  | {
      readonly kind: "remove-path" | "modify-path";
      readonly path: string;
      /** Lexically selected template base; retained for runtime canonical checks. */
      readonly pathBase: string;
    }
  | {
      readonly kind: "remove-path" | "modify-path";
      readonly value: "installationPath" | "manifestPath";
    };

export type CompiledAdapterRuntimePath =
  | {
      readonly path: string;
      /** Lexically selected template base; retained for runtime canonical checks. */
      readonly pathBase: string;
    }
  | {
      readonly value: "installationPath" | "manifestPath" | "scopePath";
    };

export type CompiledAdapterWorkingDirectory =
  | { readonly kind: "isolated-temporary" }
  | ({ readonly kind: "exact" } & CompiledAdapterRuntimePath);

export type CompiledAdapterLifecycleInvocation =
  | {
      readonly kind: "direct";
      readonly command: AdapterCommandTemplate;
    }
  | Extract<
      AdapterLifecycleInvocationDefinition,
      { kind: "ephemeral-package" }
    >;

export type CompiledAdapterRemovalEffect = {
  readonly kind: "remove-path" | "modify-path";
} & CompiledAdapterRuntimePath;

export type CompiledAdapterUpdateEffect = {
  readonly kind: "mutation-root" | "configuration-path";
} & CompiledAdapterRuntimePath;

export type CompiledAdapterLocalChangeEvidence =
  | Extract<AdapterLocalChangeEvidenceDefinition, { kind: "unavailable" }>
  | (Omit<
      Extract<
        AdapterLocalChangeEvidenceDefinition,
        { kind: "content-hash-match" }
      >,
      "path"
    > &
      CompiledAdapterRuntimePath);

export type CompiledAdapterRemovalAction =
  | (Omit<
      Extract<AdapterRemovalActionDefinition, { kind: "managed" }>,
      "command" | "effects"
    > & {
      readonly command: AdapterCommandTemplate;
      readonly effects: readonly CompiledAdapterManagedEffect[];
    })
  | (Omit<
      Extract<AdapterRemovalActionDefinition, { kind: "ephemeral-package" }>,
      "effects"
    > & { readonly effects: readonly CompiledAdapterManagedEffect[] });

export type CompiledAdapterLegacyRemovalOperation =
  CompiledAdapterRemovalAction & {
    readonly lifecycle: "remove";
    readonly adapterSchemaVersion: 1;
  };

interface CompiledAdapterLifecycleOperationBase extends Omit<
  AdapterLifecycleOperationBase,
  "workingDirectory" | "invocation"
> {
  readonly adapterSchemaVersion: 2;
  readonly workingDirectory: CompiledAdapterWorkingDirectory;
  readonly invocation: CompiledAdapterLifecycleInvocation;
}

export type CompiledAdapterLifecycleOperationV2 =
  | (CompiledAdapterLifecycleOperationBase & {
      readonly lifecycle: "remove";
      readonly effects: readonly CompiledAdapterRemovalEffect[];
    })
  | (CompiledAdapterLifecycleOperationBase & {
      readonly lifecycle: "update";
      readonly effects: readonly CompiledAdapterUpdateEffect[];
      readonly localChangeEvidence: CompiledAdapterLocalChangeEvidence;
    });

export type CompiledAdapterLifecycleOperation =
  CompiledAdapterLegacyRemovalOperation | CompiledAdapterLifecycleOperationV2;

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

export type CompiledAdapterUpdateVerification =
  | (Omit<
      Extract<AdapterUpdateVerificationDefinition, { kind: "path-present" }>,
      "path"
    > & {
      readonly path: string;
      /** Lexically selected template base; retained for runtime canonical checks. */
      readonly pathBase: string;
    })
  | Extract<
      AdapterUpdateVerificationDefinition,
      { kind: "manifest-record-present" | "owner-state-present" }
    >
  | (Omit<
      Extract<
        AdapterUpdateVerificationDefinition,
        { kind: "revision-evidence" }
      >,
      "evidence"
    > & {
      readonly evidence:
        | ({ readonly kind: "content-hash" } & CompiledAdapterRuntimePath)
        | Extract<
            Extract<
              AdapterUpdateVerificationDefinition,
              { kind: "revision-evidence" }
            >["evidence"],
            { kind: "manifest-value" }
          >;
    });

export type CompiledAdapterVerificationV2 =
  CompiledAdapterVerification | CompiledAdapterUpdateVerification;

export interface CompiledAdapter {
  readonly schemaVersion: 1 | 2;
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
  /** Version 1-only Removal compatibility view for existing Inventory consumers. */
  readonly actions: readonly CompiledAdapterRemovalAction[];
  readonly lifecycleOperations: readonly CompiledAdapterLifecycleOperation[];
  readonly verificationRules: readonly CompiledAdapterVerificationV2[];
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
