import { posix, win32 } from "node:path";

import { isCommandCapable } from "./commands.js";
import type {
  AdapterCatalog,
  AdapterDefinitionV1,
  AdapterHardDependencyDefinition,
  AdapterManifestDefinition,
  AdapterRemovalActionDefinition,
  AdapterOwnershipRule,
  AdapterPathBases,
  AdapterPathTemplate,
  AdapterPlatform,
  AdapterProbeDefinition,
  AdapterRootDefinition,
  AdapterRuleSource,
  AdapterTrustApproval,
  CompiledAdapter,
  CompiledAdapterManifest,
  CompiledAdapterProbe,
  CompiledAdapterRemovalAction,
  CompiledAdapterRoot,
  CompiledAdapterScope,
  CompiledAdapterSource,
  CompiledAdapterTrust,
  CompiledAdapterVerification,
  PlatformVariant,
} from "./types.js";
import { AdapterLoadError } from "./types.js";

const platformOrder: Readonly<Record<AdapterPlatform, number>> = {
  darwin: 0,
  linux: 1,
  win32: 2,
};

export interface AdapterCompilationInput {
  readonly definition: AdapterDefinitionV1;
  readonly source: CompiledAdapterSource;
  readonly platform: AdapterPlatform;
  readonly pathBases: AdapterPathBases;
  readonly approvals: readonly AdapterTrustApproval[];
}

export function compileAdapter(
  input: AdapterCompilationInput,
): CompiledAdapter | null {
  const { definition, source, platform, pathBases } = input;
  validateDefinitionSemantics(definition, sourcePath(source));
  if (!definition.platforms.includes(platform)) {
    return null;
  }

  const probes = active(definition.probes, platform).map((probe) =>
    compileProbe(probe, platform, pathBases, sourcePath(source)),
  );
  const roots = active(definition.roots, platform).map((root) =>
    compileRoot(root, platform, pathBases, sourcePath(source)),
  );
  const manifests = active(definition.manifests, platform).map((manifest) =>
    compileManifest(manifest, platform, pathBases, sourcePath(source)),
  );
  const ownershipRules = active(definition.ownershipRules, platform).map(
    normalizeDeclaration,
  );
  const groupingRules = active(definition.groupingRules, platform).map(
    normalizeDeclaration,
  );
  const hardDependencies = active(definition.hardDependencies, platform).map(
    normalizeDeclaration,
  );
  const actions: CompiledAdapterRemovalAction[] = active(
    definition.actions,
    platform,
  ).map((action) =>
    compileAction(action, platform, pathBases, sourcePath(source)),
  );
  const verificationRules = active(definition.verificationRules, platform).map(
    (verification) =>
      compileVerification(
        verification,
        platform,
        pathBases,
        sourcePath(source),
      ),
  );

  validateActiveReferences(
    {
      probes,
      roots,
      manifests,
      ownershipRules,
      groupingRules,
      hardDependencies,
      actions,
      verificationRules,
    },
    sourcePath(source),
  );

  const commandCapable = isCommandCapable(definition);
  const trust = trustFor(input, commandCapable);
  return deepFreeze({
    schemaVersion: 1,
    id: definition.id,
    name: definition.name,
    platforms: [...definition.platforms].sort(comparePlatform),
    source,
    trust,
    commandCapable,
    probes,
    roots,
    manifests,
    ownershipRules,
    groupingRules,
    hardDependencies,
    actions,
    verificationRules,
  });
}

export function createCatalog(
  platform: AdapterPlatform,
  adapters: readonly CompiledAdapter[],
): AdapterCatalog {
  return deepFreeze({
    schemaVersion: 1,
    platform,
    adapters: [...adapters].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  });
}

function compileProbe(
  probe: AdapterProbeDefinition,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): CompiledAdapterProbe {
  switch (probe.kind) {
    case "path": {
      const { path, ...base } = probe;
      return {
        ...normalizeDeclaration(base),
        path: compilePath(
          selectVariant(path, platform, sourcePath_, `probe ${probe.id}`),
          platform,
          bases,
          sourcePath_,
        ),
      };
    }
    case "executable": {
      const { executable, ...base } = probe;
      return {
        ...normalizeDeclaration(base),
        executable: selectVariant(
          executable,
          platform,
          sourcePath_,
          `probe ${probe.id}`,
        ),
      };
    }
    case "command": {
      const { command, ...base } = probe;
      return {
        ...normalizeDeclaration(base),
        command: selectVariant(
          command,
          platform,
          sourcePath_,
          `probe ${probe.id}`,
        ),
        successExitCodes: [...probe.successExitCodes].sort(
          (left, right) => left - right,
        ),
      };
    }
  }
}

function compileAction(
  action: NonNullable<AdapterDefinitionV1["actions"]>[number],
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): CompiledAdapterRemovalAction {
  if (action.kind === "managed") {
    const { command, effects = [], ...base } = action;
    return {
      ...normalizeDeclaration(base),
      command: selectVariant(
        command,
        platform,
        sourcePath_,
        `action ${action.id}`,
      ),
      effects: compileEffects(effects, action.id, platform, bases, sourcePath_),
    };
  }
  const { effects = [], ...base } = action;
  return {
    ...normalizeDeclaration(base),
    effects: compileEffects(effects, action.id, platform, bases, sourcePath_),
  };
}

function compileEffects(
  effects: readonly NonNullable<
    AdapterRemovalActionDefinition["effects"]
  >[number][],
  actionId: string,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
) {
  return effects.map((effect) => ({
    kind: effect.kind,
    ...(effect.path.kind === "static"
      ? compileCompiledPath(
          selectVariant(
            effect.path.path,
            platform,
            sourcePath_,
            `action ${actionId} effect`,
          ),
          platform,
          bases,
          sourcePath_,
        )
      : { value: effect.path.from }),
  }));
}

function compileRoot(
  root: AdapterRootDefinition,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): CompiledAdapterRoot {
  const { path: pathVariant, scope, ...base } = root;
  const compiledPath = compileCompiledPath(
    selectVariant(pathVariant, platform, sourcePath_, `root ${root.id}`),
    platform,
    bases,
    sourcePath_,
  );
  const compiledScope =
    scope === undefined || scope === null
      ? scope
      : compileScope(scope, platform, bases, sourcePath_);
  const normalized = normalizeDeclaration(base);
  if (root.kind === "workspace") {
    return {
      ...normalized,
      path: compiledPath.path,
      pathBase: compiledPath.pathBase,
      workspacePath: absoluteBase("workspace", platform, bases, sourcePath_),
    };
  }
  return compiledScope === undefined
    ? {
        ...normalized,
        path: compiledPath.path,
        pathBase: compiledPath.pathBase,
      }
    : {
        ...normalized,
        path: compiledPath.path,
        pathBase: compiledPath.pathBase,
        scope: compiledScope,
      };
}

function compileScope(
  scope: NonNullable<AdapterRootDefinition["scope"]>,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): CompiledAdapterScope {
  return scope.kind === "workspace"
    ? {
        kind: "workspace",
        workspacePath: absoluteBase("workspace", platform, bases, sourcePath_),
      }
    : scope;
}

function compileManifest(
  manifest: AdapterManifestDefinition,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): CompiledAdapterManifest {
  return {
    ...normalizeDeclaration(manifest),
    ...compileCompiledPath(
      selectVariant(
        manifest.path,
        platform,
        sourcePath_,
        `manifest ${manifest.id}`,
      ),
      platform,
      bases,
      sourcePath_,
    ),
    metadata: [...(manifest.metadata ?? [])].sort((left, right) =>
      compareText(
        `${left.namespace}\0${left.key}`,
        `${right.namespace}\0${right.key}`,
      ),
    ),
  };
}

function compileVerification(
  verification: NonNullable<AdapterDefinitionV1["verificationRules"]>[number],
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): CompiledAdapterVerification {
  switch (verification.kind) {
    case "path-absent": {
      const { path, ...base } = verification;
      return {
        ...normalizeDeclaration(base),
        path: compilePath(
          selectVariant(
            path,
            platform,
            sourcePath_,
            `verification ${verification.id}`,
          ),
          platform,
          bases,
          sourcePath_,
        ),
      };
    }
    case "command": {
      const { command, ...base } = verification;
      return {
        ...normalizeDeclaration(base),
        command: selectVariant(
          command,
          platform,
          sourcePath_,
          `verification ${verification.id}`,
        ),
        successExitCodes: [...verification.successExitCodes].sort(
          (left, right) => left - right,
        ),
      };
    }
    case "manifest-record-absent":
    case "owner-state-absent":
      return normalizeDeclaration(verification);
  }
}

function compilePath(
  template: AdapterPathTemplate,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): string {
  return compileCompiledPath(template, platform, bases, sourcePath_).path;
}

function compileCompiledPath(
  template: AdapterPathTemplate,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): { readonly path: string; readonly pathBase: string } {
  validatePathTemplate(template, sourcePath_);
  const pathImplementation = platform === "win32" ? win32 : posix;
  const base = absoluteBase(template.base, platform, bases, sourcePath_);
  const result = pathImplementation.resolve(base, ...template.segments);
  const relative = pathImplementation.relative(base, result);
  if (
    relative === ".." ||
    relative.startsWith(`..${pathImplementation.sep}`) ||
    pathImplementation.isAbsolute(relative)
  ) {
    throw new AdapterLoadError(
      "schema-invalid",
      `adapter path escapes its ${template.base} base`,
      sourcePath_,
    );
  }
  return { path: result, pathBase: base };
}

function absoluteBase(
  baseName: keyof AdapterPathBases,
  platform: AdapterPlatform,
  bases: AdapterPathBases,
  sourcePath_: string | null,
): string {
  const pathImplementation = platform === "win32" ? win32 : posix;
  const base = bases[baseName];
  if (!pathImplementation.isAbsolute(base)) {
    throw new AdapterLoadError(
      "invalid-request",
      `adapter path base ${baseName} must be absolute for ${platform}`,
      sourcePath_,
    );
  }
  return pathImplementation.resolve(base);
}

function validateDefinitionSemantics(
  definition: AdapterDefinitionV1,
  sourcePath_: string | null,
): void {
  const allIds = new Set<string>();
  for (const declaration of allDeclarations(definition)) {
    if (allIds.has(declaration.id)) {
      throw new AdapterLoadError(
        "duplicate-id",
        `duplicate adapter declaration id: ${declaration.id}`,
        sourcePath_,
      );
    }
    allIds.add(declaration.id);
    for (const platform of declaration.platforms ?? definition.platforms) {
      if (!definition.platforms.includes(platform)) {
        throw new AdapterLoadError(
          "schema-invalid",
          `declaration ${declaration.id} uses unsupported platform ${platform}`,
          sourcePath_,
        );
      }
    }
  }

  for (const root of definition.roots ?? []) {
    validateRoot(root, sourcePath_);
    validatePathVariants(root.path, root, definition, sourcePath_);
  }
  for (const probe of definition.probes ?? []) {
    if (probe.kind === "path") {
      validatePathVariants(probe.path, probe, definition, sourcePath_);
    } else if (probe.kind === "executable") {
      validateVariants(probe.executable, probe, definition, sourcePath_);
    } else {
      validateVariants(probe.command, probe, definition, sourcePath_);
    }
  }
  for (const manifest of definition.manifests ?? []) {
    validatePathVariants(manifest.path, manifest, definition, sourcePath_);
    const metadataKeys = new Set<string>();
    for (const mapping of manifest.metadata ?? []) {
      const key = `${mapping.namespace}\0${mapping.key}`;
      if (metadataKeys.has(key)) {
        throw new AdapterLoadError(
          "duplicate-id",
          `duplicate manifest metadata mapping: ${mapping.namespace}.${mapping.key}`,
          sourcePath_,
        );
      }
      metadataKeys.add(key);
    }
  }
  for (const action of definition.actions ?? []) {
    if (action.kind === "managed") {
      validateVariants(action.command, action, definition, sourcePath_);
    }
    for (const effect of action.effects ?? []) {
      if (effect.path.kind === "static") {
        validatePathVariants(effect.path.path, action, definition, sourcePath_);
      }
    }
  }
  for (const verification of definition.verificationRules ?? []) {
    if (verification.kind === "path-absent") {
      validatePathVariants(
        verification.path,
        verification,
        definition,
        sourcePath_,
      );
    } else if (verification.kind === "command") {
      validateVariants(
        verification.command,
        verification,
        definition,
        sourcePath_,
      );
    }
  }

  validateAllReferences(definition, sourcePath_);
}

function validateRoot(
  root: AdapterRootDefinition,
  sourcePath_: string | null,
): void {
  const hasAgent = typeof root.agentId === "string";
  if (root.kind !== "plugin" && root.independentlySelectable !== undefined) {
    forbidRoot(true, root, "independentlySelectable", sourcePath_);
  }
  switch (root.kind) {
    case "user":
    case "agent":
    case "workspace":
      requireRoot(hasAgent, root, "agentId", sourcePath_);
      forbidRoot(root.scope !== undefined, root, "scope", sourcePath_);
      forbidRoot(root.plugin !== undefined, root, "plugin", sourcePath_);
      forbidRoot(root.source !== undefined, root, "source", sourcePath_);
      break;
    case "plugin":
      requireRoot(hasAgent, root, "agentId", sourcePath_);
      requireRoot(root.scope != null, root, "scope", sourcePath_);
      requireRoot(root.plugin !== undefined, root, "plugin", sourcePath_);
      requireRoot(
        typeof root.independentlySelectable === "boolean",
        root,
        "independentlySelectable",
        sourcePath_,
      );
      forbidRoot(root.source !== undefined, root, "source", sourcePath_);
      if (root.scope?.kind === "agent" && root.scope.agentId !== root.agentId) {
        throw new AdapterLoadError(
          "schema-invalid",
          `root ${root.id} agent scope must match agentId`,
          sourcePath_,
        );
      }
      break;
    case "source":
      requireRoot(root.agentId !== undefined, root, "agentId", sourcePath_);
      requireRoot(root.scope !== undefined, root, "scope", sourcePath_);
      requireRoot(root.source !== undefined, root, "source", sourcePath_);
      forbidRoot(root.plugin !== undefined, root, "plugin", sourcePath_);
      break;
    case "cache-or-vendor":
    case "unknown":
      requireRoot(root.agentId !== undefined, root, "agentId", sourcePath_);
      requireRoot(root.scope !== undefined, root, "scope", sourcePath_);
      forbidRoot(root.plugin !== undefined, root, "plugin", sourcePath_);
      forbidRoot(root.source !== undefined, root, "source", sourcePath_);
      break;
    case "system":
      requireRoot(hasAgent, root, "agentId", sourcePath_);
      forbidRoot(root.scope !== undefined, root, "scope", sourcePath_);
      forbidRoot(root.plugin !== undefined, root, "plugin", sourcePath_);
      forbidRoot(root.source !== undefined, root, "source", sourcePath_);
      break;
  }
}

function requireRoot(
  condition: boolean,
  root: AdapterRootDefinition,
  field: string,
  sourcePath_: string | null,
): void {
  if (!condition) {
    throw new AdapterLoadError(
      "schema-invalid",
      `root ${root.id} of kind ${root.kind} requires ${field}`,
      sourcePath_,
    );
  }
}

function forbidRoot(
  condition: boolean,
  root: AdapterRootDefinition,
  field: string,
  sourcePath_: string | null,
): void {
  if (condition) {
    throw new AdapterLoadError(
      "schema-invalid",
      `root ${root.id} of kind ${root.kind} cannot declare ${field}`,
      sourcePath_,
    );
  }
}

function validateAllReferences(
  definition: AdapterDefinitionV1,
  sourcePath_: string | null,
): void {
  const probes = new Set((definition.probes ?? []).map(({ id }) => id));
  const roots = new Set((definition.roots ?? []).map(({ id }) => id));
  const manifests = new Set((definition.manifests ?? []).map(({ id }) => id));
  const verifications = new Set(
    (definition.verificationRules ?? []).map(({ id }) => id),
  );

  for (const declaration of [
    ...(definition.roots ?? []),
    ...(definition.manifests ?? []),
    ...(definition.actions ?? []),
  ]) {
    for (const probeId of declaration.requiresProbes ?? []) {
      requireReference(probes, probeId, "probe", declaration.id, sourcePath_);
    }
  }
  for (const manifest of definition.manifests ?? []) {
    if (manifest.rootId === undefined) {
      throw new AdapterLoadError(
        "invalid-reference",
        `manifest ${manifest.id} requires rootId`,
        sourcePath_,
      );
    }
    requireReference(roots, manifest.rootId, "root", manifest.id, sourcePath_);
  }
  for (const rule of definition.ownershipRules ?? []) {
    validateRuleSource(rule.source, roots, manifests, rule.id, sourcePath_);
  }
  for (const action of definition.actions ?? []) {
    if (action.source !== undefined) {
      validateRuleSource(
        action.source,
        roots,
        manifests,
        action.id,
        sourcePath_,
      );
    }
    for (const verificationId of action.verificationRules ?? []) {
      requireReference(
        verifications,
        verificationId,
        "verification rule",
        action.id,
        sourcePath_,
      );
    }
  }
  for (const rule of definition.groupingRules ?? []) {
    requireReference(
      manifests,
      rule.manifestId,
      "manifest",
      rule.id,
      sourcePath_,
    );
  }
  for (const dependency of definition.hardDependencies ?? []) {
    requireReference(
      manifests,
      dependency.manifestId,
      "manifest",
      dependency.id,
      sourcePath_,
    );
  }
  for (const verification of definition.verificationRules ?? []) {
    if (verification.kind === "manifest-record-absent") {
      requireReference(
        manifests,
        verification.manifestId,
        "manifest",
        verification.id,
        sourcePath_,
      );
    }
  }
}

function validateActiveReferences(
  values: {
    readonly probes: readonly CompiledAdapterProbe[];
    readonly roots: readonly CompiledAdapterRoot[];
    readonly manifests: readonly CompiledAdapterManifest[];
    readonly ownershipRules: readonly AdapterOwnershipRule[];
    readonly groupingRules: readonly {
      readonly id: string;
      readonly manifestId: string;
    }[];
    readonly hardDependencies: readonly AdapterHardDependencyDefinition[];
    readonly actions: readonly CompiledAdapterRemovalAction[];
    readonly verificationRules: readonly CompiledAdapterVerification[];
  },
  sourcePath_: string | null,
): void {
  const probes = new Set(values.probes.map(({ id }) => id));
  const roots = new Set(values.roots.map(({ id }) => id));
  const manifests = new Set(values.manifests.map(({ id }) => id));
  const verifications = new Set(values.verificationRules.map(({ id }) => id));
  for (const declaration of [
    ...values.roots,
    ...values.manifests,
    ...values.actions,
  ]) {
    for (const probeId of declaration.requiresProbes ?? []) {
      requireReference(
        probes,
        probeId,
        "active probe",
        declaration.id,
        sourcePath_,
      );
    }
  }
  for (const manifest of values.manifests) {
    if (manifest.rootId === undefined) {
      throw new AdapterLoadError(
        "invalid-reference",
        `active manifest ${manifest.id} requires rootId`,
        sourcePath_,
      );
    }
    requireReference(
      roots,
      manifest.rootId,
      "active root",
      manifest.id,
      sourcePath_,
    );
  }
  for (const rule of values.ownershipRules) {
    validateRuleSource(rule.source, roots, manifests, rule.id, sourcePath_);
  }
  for (const action of values.actions) {
    if (action.source !== undefined) {
      validateRuleSource(
        action.source,
        roots,
        manifests,
        action.id,
        sourcePath_,
      );
    }
    for (const verificationId of action.verificationRules ?? []) {
      requireReference(
        verifications,
        verificationId,
        "active verification rule",
        action.id,
        sourcePath_,
      );
    }
  }
  for (const rule of values.groupingRules) {
    requireReference(
      manifests,
      rule.manifestId,
      "active manifest",
      rule.id,
      sourcePath_,
    );
  }
  for (const dependency of values.hardDependencies) {
    requireReference(
      manifests,
      dependency.manifestId,
      "active manifest",
      dependency.id,
      sourcePath_,
    );
  }
  for (const verification of values.verificationRules) {
    if (verification.kind === "manifest-record-absent") {
      requireReference(
        manifests,
        verification.manifestId,
        "active manifest",
        verification.id,
        sourcePath_,
      );
    }
  }
}

function validateRuleSource(
  source: AdapterRuleSource,
  roots: ReadonlySet<string>,
  manifests: ReadonlySet<string>,
  declarationId: string,
  sourcePath_: string | null,
): void {
  if (source.kind === "root") {
    requireReference(roots, source.rootId, "root", declarationId, sourcePath_);
  } else {
    requireReference(
      manifests,
      source.manifestId,
      "manifest",
      declarationId,
      sourcePath_,
    );
  }
}

function requireReference(
  ids: ReadonlySet<string>,
  id: string,
  kind: string,
  declarationId: string,
  sourcePath_: string | null,
): void {
  if (!ids.has(id)) {
    throw new AdapterLoadError(
      "invalid-reference",
      `${declarationId} references missing ${kind}: ${id}`,
      sourcePath_,
    );
  }
}

function validatePathVariants(
  variant: PlatformVariant<AdapterPathTemplate>,
  declaration: {
    readonly id: string;
    readonly platforms?: readonly AdapterPlatform[];
  },
  definition: AdapterDefinitionV1,
  sourcePath_: string | null,
): void {
  for (const template of variantValues(variant)) {
    validatePathTemplate(template, sourcePath_);
  }
  validateVariants(variant, declaration, definition, sourcePath_);
}

function validatePathTemplate(
  template: AdapterPathTemplate,
  sourcePath_: string | null,
): void {
  for (const segment of template.segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0") ||
      posix.isAbsolute(segment) ||
      win32.isAbsolute(segment)
    ) {
      throw new AdapterLoadError(
        "schema-invalid",
        `unsafe adapter path segment: ${segment}`,
        sourcePath_,
      );
    }
  }
}

function validateVariants<Value>(
  variant: PlatformVariant<Value>,
  declaration: {
    readonly id: string;
    readonly platforms?: readonly AdapterPlatform[];
  },
  definition: AdapterDefinitionV1,
  sourcePath_: string | null,
): void {
  for (const platform of declaration.platforms ?? definition.platforms) {
    if (variant[platform] === undefined && variant.default === undefined) {
      throw new AdapterLoadError(
        "schema-invalid",
        `${declaration.id} has no ${platform} or default variant`,
        sourcePath_,
      );
    }
  }
}

function trustFor(
  input: AdapterCompilationInput,
  commandCapable: boolean,
): CompiledAdapterTrust {
  const source = input.source;
  if (source.kind === "built-in") {
    return { kind: "built-in" };
  }
  if (!commandCapable) {
    return { kind: "read-only" };
  }
  const approved = input.approvals.some(
    (approval) =>
      approval.adapterId === input.definition.id &&
      approval.contentHash === source.contentHash,
  );
  return approved
    ? { kind: "approved", contentHash: source.contentHash }
    : { kind: "read-only" };
}

function selectVariant<Value>(
  variant: PlatformVariant<Value>,
  platform: AdapterPlatform,
  sourcePath_: string | null,
  context: string,
): Value {
  const value = variant[platform] ?? variant.default;
  if (value === undefined) {
    throw new AdapterLoadError(
      "schema-invalid",
      `${context} has no variant for ${platform}`,
      sourcePath_,
    );
  }
  return value;
}

function active<
  Declaration extends {
    readonly id: string;
    readonly platforms?: readonly AdapterPlatform[];
  },
>(
  values: readonly Declaration[] | undefined,
  platform: AdapterPlatform,
): Declaration[] {
  return [...(values ?? [])]
    .filter(
      (value) =>
        value.platforms === undefined || value.platforms.includes(platform),
    )
    .sort((left, right) => compareText(left.id, right.id));
}

function normalizeDeclaration<
  Declaration extends {
    readonly platforms?: readonly AdapterPlatform[];
    readonly requiresProbes?: readonly string[];
    readonly verificationRules?: readonly string[];
  },
>(declaration: Declaration): Declaration {
  const result = { ...declaration };
  if (declaration.platforms !== undefined) {
    Object.assign(result, {
      platforms: [...declaration.platforms].sort(comparePlatform),
    });
  }
  if (declaration.requiresProbes !== undefined) {
    Object.assign(result, {
      requiresProbes: [...declaration.requiresProbes].sort(compareText),
    });
  }
  if (declaration.verificationRules !== undefined) {
    Object.assign(result, {
      verificationRules: [...declaration.verificationRules].sort(compareText),
    });
  }
  return result;
}

function allDeclarations(definition: AdapterDefinitionV1): readonly {
  readonly id: string;
  readonly platforms?: readonly AdapterPlatform[];
}[] {
  return [
    ...(definition.probes ?? []),
    ...(definition.roots ?? []),
    ...(definition.manifests ?? []),
    ...(definition.ownershipRules ?? []),
    ...(definition.groupingRules ?? []),
    ...(definition.hardDependencies ?? []),
    ...(definition.actions ?? []),
    ...(definition.verificationRules ?? []),
  ];
}

function variantValues<Value>(variant: PlatformVariant<Value>): Value[] {
  return [variant.default, variant.darwin, variant.linux, variant.win32].filter(
    (value): value is Value => value !== undefined,
  );
}

function sourcePath(source: CompiledAdapterSource): string | null {
  return source.kind === "local" ? source.path : null;
}

function comparePlatform(
  left: AdapterPlatform,
  right: AdapterPlatform,
): number {
  return platformOrder[left] - platformOrder[right];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
