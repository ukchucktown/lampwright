import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { parse as parseJsonc, parseTree, type ParseError } from "jsonc-parser";

import { CLAUDE_CODE_PLUGIN_ADAPTER_ID } from "../adapter/built-ins.js";
import { stringifyModel } from "../model/json.js";
import type {
  HarnessExposure,
  Inventory,
  NativeControlDocumentEvidence,
  Ownership,
  PluginBoundary,
} from "../model/types.js";
import { recoveredSourceProfiles } from "../session-setup/profiles.js";
import type {
  SessionSetupScanRequest,
  SessionSetupSnapshot,
  SessionSetupSourceResult,
  SessionSetupTarget,
  SetupConfigurationLayer,
  SetupConfiguredState,
  SetupNativeControl,
  SetupScope,
  SetupSourceRef,
} from "../session-setup/types.js";
import { parseSessionSetupSnapshot } from "../session-setup/validation.js";
import { readAvailabilityDocument } from "./availability-evidence.js";
import { hasDuplicateKeys, pathKey } from "./evidence.js";
import { stableId } from "./identity.js";
import { createInventoryScanner } from "./scanner.js";
import { pluginDescriptor } from "./session-setup.js";
import type {
  InventoryCommandRunner,
  InventoryScanEnvironment,
  InventoryScannerOptions,
} from "./types.js";

const profile = recoveredSourceProfiles.find(
  (candidate) => candidate.id === "claude-code-2.1.270",
)!;

interface JsonDocument {
  readonly path: string;
  readonly scope: SetupScope;
  readonly evidence: NativeControlDocumentEvidence;
  readonly value: Record<string, unknown>;
  readonly unsafe: boolean;
}

interface ProjectState {
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly disabledMcpServers: ReadonlySet<string>;
  readonly invalidReason: string | null;
}

/** Builds the qualified Claude Code terminal profile from bounded local evidence. */
export async function scanClaudeCodeSessionSetup(
  request: SessionSetupScanRequest,
  options: InventoryScannerOptions,
  existingInventory?: Inventory,
): Promise<SessionSetupSnapshot> {
  if (request.harnessId !== undefined && request.harnessId !== "claude-code")
    throw new Error(
      "the Claude Code session-setup adapter accepts only the Claude Code harness",
    );
  const workspace = request.workspace ?? {
    path: options.environment.workspaceDirectory,
  };
  const environment: InventoryScanEnvironment = {
    ...options.environment,
    workspaceDirectory: workspace.path,
  };
  const inventory =
    existingInventory ??
    (await createInventoryScanner({ ...options, environment }).scan(
      request.roots === undefined ? {} : { roots: request.roots },
    ));
  return buildClaudeSnapshot(inventory, workspace, environment, options);
}

async function buildClaudeSnapshot(
  inventory: Inventory,
  workspace: { readonly path: string },
  environment: InventoryScanEnvironment,
  options: InventoryScannerOptions,
): Promise<SessionSetupSnapshot> {
  const targets: SessionSetupTarget[] = [];
  const sources: SessionSetupSourceResult[] = [];
  const addSource = (
    kind: SessionSetupSourceResult["kind"],
    scope: SetupScope,
    id: string,
    targetIds: readonly string[],
    status: SessionSetupSourceResult["status"] = "success",
    reason: string | null = null,
    path: string | null = null,
  ): SetupSourceRef => {
    const source = { sourceId: id, path };
    sources.push({
      source,
      profileId: profile.id,
      harnessId: "claude-code",
      kind,
      scope,
      status,
      reason,
      targetIds: [...targetIds],
      collateralTargetIds: [...targetIds],
    });
    return source;
  };
  const policySources = new Map<string, SetupSourceRef>();
  const nativePolicySource = (
    kind: "skill-exposure" | "plugin",
    evidence: NativeControlDocumentEvidence,
  ): SetupSourceRef => {
    const key = `${kind}:${pathKey(evidence.path)}`;
    const current = policySources.get(key);
    if (current) return current;
    const invalid = evidence.exists && evidence.selectorValue === null;
    const source = addSource(
      kind,
      evidence.scope as SetupScope,
      `claude-code:${kind}-policy:${evidence.path}`,
      [],
      invalid ? "invalid" : "success",
      invalid
        ? "Claude Code settings are malformed, linked, hard-linked, unreadable, or unstable"
        : null,
      evidence.path,
    );
    policySources.set(key, source);
    return source;
  };

  for (const installation of inventory.installations) {
    if (
      installation.ownership.kind === "plugin" ||
      !installation.exposedTo.includes("claude-code")
    )
      continue;
    const exposure = installation.harnessExposures.find(
      (candidate) => candidate.harnessId === "claude-code",
    );
    if (!exposure) continue;
    const id = stableId("setup-skill", "claude-code", installation.id);
    const source = addSource(
      "skill-exposure",
      installation.scope as SetupScope,
      `claude-code:skill:${installation.id}`,
      [id],
      "success",
      null,
      installation.location.path,
    );
    targets.push({
      id,
      kind: "skill-exposure",
      harnessId: "claude-code",
      workspace,
      name: installation.skill.name,
      source,
      owner: ownerForInstallation(installation.ownership),
      definitionScope: installation.scope as SetupScope,
      state: stateFromStatus(exposure.status),
      control: skillControl(exposure, id, nativePolicySource),
      installationId: installation.id,
    });
  }

  const claudeHome =
    environment.agentHomeDirectories?.["claude-code"] ??
    join(environment.homeDirectory, ".claude");
  const registryPath = join(claudeHome, "plugins", "installed_plugins.json");
  const registryDocument = await readJsonDocument(
    registryPath,
    { kind: "user" },
    "user",
    options.commandRunner,
  );
  const registryInvalid =
    registryDocument.evidence.exists &&
    (registryDocument.unsafe || !validPluginRegistry(registryDocument.value));
  const plugins = inventory.plugins.filter(
    (candidate) =>
      candidate.adapterId === CLAUDE_CODE_PLUGIN_ADAPTER_ID &&
      candidate.exposedTo.includes("claude-code"),
  );
  const pluginTargetIds = new Map(
    plugins.map((plugin) => [
      plugin.id,
      stableId("setup-plugin", "claude-code", plugin.id),
    ]),
  );
  const pluginInventorySource = addSource(
    "plugin",
    { kind: "user" },
    "claude-code:installed-plugins",
    [...pluginTargetIds.values()].sort(),
    registryInvalid ? "invalid" : "success",
    registryInvalid
      ? "the Claude Code installed Plugin registry is unsafe or malformed"
      : null,
    registryPath,
  );
  for (const plugin of plugins) {
    const id = pluginTargetIds.get(plugin.id)!;
    targets.push({
      id,
      kind: "plugin",
      harnessId: "claude-code",
      workspace,
      name: plugin.pluginId,
      source: pluginInventorySource,
      owner: { kind: "plugin", pluginBoundaryId: plugin.id },
      definitionScope: pluginScope(plugin, inventory),
      state: stateFromStatus(plugin.availability.status),
      control: pluginControl(plugin, id, nativePolicySource),
      pluginBoundaryId: plugin.id,
      pluginId: plugin.pluginId,
      childTargetIds: [],
    });
  }

  const childIds = new Map<string, string[]>();
  for (const installation of inventory.installations) {
    if (
      installation.pluginBoundaryId === null ||
      !pluginTargetIds.has(installation.pluginBoundaryId)
    )
      continue;
    const id = stableId("setup-plugin-skill", "claude-code", installation.id);
    const source = addSource(
      "skill-exposure",
      installation.scope as SetupScope,
      `claude-code:plugin-skill:${installation.id}`,
      [id],
      "success",
      null,
      installation.location.path,
    );
    const owner = plugins.find(
      (candidate) => candidate.id === installation.pluginBoundaryId,
    );
    targets.push({
      id,
      kind: "skill-exposure",
      harnessId: "claude-code",
      workspace,
      name: installation.skill.name,
      source,
      owner: {
        kind: "plugin",
        pluginBoundaryId: installation.pluginBoundaryId,
      },
      definitionScope: installation.scope as SetupScope,
      state: stateFromStatus(owner?.availability.status ?? "unresolved"),
      control: unavailableControl(
        skillSelector(installation.skill.name, id),
        "Plugin-owned Skills have no independent Claude Code availability policy",
        [],
      ),
      installationId: installation.id,
    });
    childIds.set(installation.pluginBoundaryId, [
      ...(childIds.get(installation.pluginBoundaryId) ?? []),
      id,
    ]);
  }
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (target?.kind === "plugin")
      targets[index] = {
        ...target,
        childTargetIds: [
          ...(childIds.get(target.pluginBoundaryId) ?? []),
        ].sort(),
      };
  }

  const statePath = join(environment.homeDirectory, ".claude.json");
  const stateDocument = await readJsonDocument(
    statePath,
    { kind: "workspace", workspacePath: workspace.path },
    "workspace",
    options.commandRunner,
  );
  const projectState = selectProjectState(stateDocument, workspace.path);
  const stateInvalid =
    stateDocument.unsafe || projectState.invalidReason !== null;
  const stateSource = addSource(
    "mcp-registration",
    { kind: "workspace", workspacePath: workspace.path },
    `claude-code:mcp-policy:${statePath}:${projectState.key}`,
    [],
    stateInvalid ? "invalid" : "success",
    stateDocument.unsafe
      ? "Claude Code state is malformed, linked, hard-linked, unreadable, or unstable"
      : projectState.invalidReason,
    statePath,
  );
  const stateLayer = jsonLayer(stateSource, stateDocument, 0);

  const declarations: McpDeclaration[] = [];
  if (!stateDocument.unsafe) {
    collectMcpDeclarations(
      declarations,
      stateDocument.value.mcpServers,
      "user",
      statePath,
      "claude-code:user-mcp",
      addSource,
    );
    if (projectState.invalidReason === null)
      collectMcpDeclarations(
        declarations,
        projectState.value.mcpServers,
        { kind: "workspace", workspacePath: workspace.path },
        statePath,
        `claude-code:local-mcp:${projectState.key}`,
        addSource,
      );
  }

  const projectMcpPath = join(workspace.path, ".mcp.json");
  const projectMcpDocument = await readJsonDocument(
    projectMcpPath,
    { kind: "workspace", workspacePath: workspace.path },
    "shared-workspace",
    options.commandRunner,
  );
  const projectMcpValue = projectMcpDocument.value.mcpServers;
  const projectMcpInvalid =
    projectMcpDocument.unsafe || !validMcpMap(projectMcpValue, true);
  const projectMcpSource = addSource(
    "mcp-registration",
    { kind: "workspace", workspacePath: workspace.path },
    `claude-code:project-mcp:${projectMcpPath}`,
    [],
    projectMcpInvalid ? "invalid" : "success",
    projectMcpInvalid
      ? "the selected project's .mcp.json is unsafe or malformed"
      : null,
    projectMcpPath,
  );
  if (!projectMcpInvalid)
    collectMcpDeclarationsFromSource(
      declarations,
      projectMcpValue,
      { kind: "workspace", workspacePath: workspace.path },
      projectMcpPath,
      projectMcpSource,
    );

  for (const plugin of plugins) {
    const descriptor = await pluginDescriptor(plugin);
    const descriptorIncomplete = descriptor.sources.some(
      (candidate) =>
        candidate.kind === "mcp-registration" && candidate.status !== "success",
    );
    for (const result of descriptor.sources) {
      if (result.kind !== "mcp-registration") continue;
      addSource(
        "mcp-registration",
        pluginScope(plugin, inventory),
        `claude-code:plugin-descriptor:${plugin.id}:${result.resourceId}`,
        [],
        result.status,
        result.reason,
        result.path,
      );
    }
    const pluginName = nativePluginName(plugin.pluginId);
    for (const declaration of descriptor.mcp) {
      const nativeKey = `plugin:${pluginName}:${declaration.key}`;
      const source = addSource(
        "mcp-registration",
        pluginScope(plugin, inventory),
        `claude-code:plugin-mcp:${plugin.id}:${declaration.path}:${declaration.key}`,
        [],
        "success",
        null,
        declaration.path,
      );
      declarations.push({
        name: declaration.key,
        nativeKey,
        path: declaration.path,
        scope: pluginScope(plugin, inventory),
        source,
        owner: { kind: "plugin", plugin },
        unavailableReason: descriptorIncomplete
          ? "the installed Plugin's MCP declaration evidence is incomplete"
          : null,
      });
    }
  }

  for (const declaration of declarations) {
    const id = stableId(
      "setup-mcp",
      "claude-code",
      declaration.source.sourceId,
      declaration.nativeKey,
    );
    replaceSourceTarget(sources, declaration.source.sourceId, id);
    const ownerDisabled =
      declaration.owner.kind === "plugin" &&
      declaration.owner.plugin.availability.status === "disabled";
    const selector = {
      kind: "mcp-server-key" as const,
      id: `claude-code:mcp:${id}`,
      serverKey: declaration.nativeKey,
      policyOwner:
        declaration.owner.kind === "plugin"
          ? ({
              kind: "plugin" as const,
              pluginId: declaration.owner.plugin.pluginId,
            } as const)
          : ({ kind: "standalone" as const } as const),
      authority: "exact-target" as const,
      governedTargetIds: [id] as [string],
    };
    targets.push({
      id,
      kind: "mcp-registration",
      harnessId: "claude-code",
      workspace,
      name: declaration.name,
      source: declaration.source,
      owner:
        declaration.owner.kind === "plugin"
          ? {
              kind: "plugin",
              pluginBoundaryId: declaration.owner.plugin.id,
            }
          : { kind: "standalone" },
      definitionScope: declaration.scope,
      state: stateFromDisabledMembership(
        projectState.disabledMcpServers,
        declaration.nativeKey,
        stateInvalid,
        ownerDisabled,
      ),
      control:
        declaration.unavailableReason === null
          ? mcpControl(
              selector,
              stateSource,
              stateLayer,
              stateInvalid
                ? stateDocument.unsafe
                  ? "Claude Code state is unsafe or malformed"
                  : projectState.invalidReason!
                : null,
            )
          : unavailableControl(selector, declaration.unavailableReason, [
              stateLayer,
            ]),
      declarationSource: declaration.source,
      serverKey: declaration.nativeKey,
      requiredAppBindingId: null,
    });
  }

  addSource(
    "mcp-registration",
    { kind: "user" },
    "claude-code:account-connectors",
    [],
    "unavailable",
    "Claude account connectors have no authoritative offline inventory contract; use Claude Code /mcp or account management",
  );

  const snapshotBase = {
    schemaVersion: 1 as const,
    kind: "session-setup-snapshot" as const,
    scannedAt: inventory.scannedAt,
    workspace,
    harnesses: ["claude-code" as const],
    targets,
    sources,
    profiles: [profile],
    dependencies: [],
    legacyInventory: inventory,
  };
  const fingerprint = createHash("sha256")
    .update(
      stringifyModel(
        {
          ...snapshotBase,
          scannedAt: "",
          legacyInventory: { ...inventory, scannedAt: "" },
        },
        0,
      ),
    )
    .digest("hex");
  return parseSessionSetupSnapshot({
    ...snapshotBase,
    id: stableId("session-setup", fingerprint),
    semanticFingerprint: { algorithm: "sha256", digest: fingerprint },
  });
}

type SourceAdder = (
  kind: SessionSetupSourceResult["kind"],
  scope: SetupScope,
  id: string,
  targetIds: readonly string[],
  status?: SessionSetupSourceResult["status"],
  reason?: string | null,
  path?: string | null,
) => SetupSourceRef;

interface McpDeclaration {
  readonly name: string;
  readonly nativeKey: string;
  readonly path: string;
  readonly scope: SetupScope;
  readonly source: SetupSourceRef;
  readonly owner:
    | { readonly kind: "standalone" }
    | { readonly kind: "plugin"; readonly plugin: PluginBoundary };
  readonly unavailableReason: string | null;
}

function collectMcpDeclarations(
  declarations: McpDeclaration[],
  value: unknown,
  scope: "user" | SetupScope,
  path: string,
  sourceId: string,
  addSource: SourceAdder,
): void {
  const setupScope: SetupScope = scope === "user" ? { kind: "user" } : scope;
  const valid = validMcpMap(value, true);
  const source = addSource(
    "mcp-registration",
    setupScope,
    sourceId,
    [],
    valid ? "success" : "invalid",
    valid ? null : "Claude Code MCP declarations are malformed",
    path,
  );
  if (valid)
    collectMcpDeclarationsFromSource(
      declarations,
      value,
      setupScope,
      path,
      source,
    );
}

function collectMcpDeclarationsFromSource(
  declarations: McpDeclaration[],
  value: unknown,
  scope: SetupScope,
  path: string,
  source: SetupSourceRef,
): void {
  for (const [name] of Object.entries(record(value) ?? {}))
    declarations.push({
      name,
      nativeKey: name,
      path,
      scope,
      source,
      owner: { kind: "standalone" },
      unavailableReason: null,
    });
}

function replaceSourceTarget(
  sources: SessionSetupSourceResult[],
  sourceId: string,
  targetId: string,
): void {
  const index = sources.findIndex(
    (candidate) => candidate.source.sourceId === sourceId,
  );
  if (index < 0) return;
  const source = sources[index]!;
  const targetIds = [...source.targetIds, targetId].sort();
  sources[index] = {
    ...source,
    targetIds,
    collateralTargetIds: targetIds,
  };
}

async function readJsonDocument(
  path: string,
  scope: SetupScope,
  documentScope: NativeControlDocumentEvidence["documentScope"],
  runner: InventoryCommandRunner,
): Promise<JsonDocument> {
  const read = await readAvailabilityDocument(
    path,
    "json",
    scope,
    documentScope,
    true,
    runner,
  );
  let value: Record<string, unknown> = {};
  let unsafe = read.unsafe;
  if (read.text !== null && !unsafe) {
    const errors: ParseError[] = [];
    const tree = parseTree(read.text, errors, {
      allowTrailingComma: false,
      disallowComments: true,
    });
    const parsed = record(parseJsonc(read.text));
    if (
      tree === undefined ||
      errors.length > 0 ||
      tree.type !== "object" ||
      hasDuplicateKeys(tree) ||
      parsed === null
    )
      unsafe = true;
    else value = parsed;
  }
  return { path, scope, evidence: read.evidence, value, unsafe };
}

function selectProjectState(
  document: JsonDocument,
  workspacePath: string,
): ProjectState {
  if (document.unsafe)
    return {
      key: workspacePath,
      value: {},
      disabledMcpServers: new Set(),
      invalidReason: "Claude Code state is unsafe or malformed",
    };
  const projects = document.value.projects;
  if (projects !== undefined && record(projects) === null)
    return invalidProjectState(
      workspacePath,
      "Claude Code projects state is malformed",
    );
  const candidates = Object.entries(record(projects) ?? {}).filter(
    ([key]) => pathKey(resolve(key)) === pathKey(resolve(workspacePath)),
  );
  if (candidates.length > 1)
    return invalidProjectState(
      workspacePath,
      "multiple Claude Code project records resolve to the selected workspace",
    );
  const [key, raw] = candidates[0] ?? [workspacePath, {}];
  const value = record(raw);
  if (value === null)
    return invalidProjectState(key, "Claude Code project state is malformed");
  if (!validMcpMap(value.mcpServers, true))
    return invalidProjectState(
      key,
      "Claude Code local MCP declarations are malformed",
    );
  const rawDisabled = value.disabledMcpServers;
  if (
    rawDisabled !== undefined &&
    (!Array.isArray(rawDisabled) ||
      !rawDisabled.every((item) => typeof item === "string"))
  )
    return invalidProjectState(
      key,
      "Claude Code disabled MCP preferences are malformed",
    );
  return {
    key,
    value,
    disabledMcpServers: new Set(
      Array.isArray(rawDisabled) ? (rawDisabled as string[]) : [],
    ),
    invalidReason: null,
  };
}

function invalidProjectState(key: string, reason: string): ProjectState {
  return {
    key,
    value: {},
    disabledMcpServers: new Set(),
    invalidReason: reason,
  };
}

function validMcpMap(value: unknown, absentAllowed: boolean): boolean {
  if (value === undefined) return absentAllowed;
  const map = record(value);
  return (
    map !== null &&
    Object.entries(map).every(
      ([key, declaration]) =>
        key.trim().length > 0 && record(declaration) !== null,
    )
  );
}

function validPluginRegistry(value: Record<string, unknown>): boolean {
  if (value.version !== 2) return false;
  const plugins = record(value.plugins);
  if (plugins === null) return false;
  return Object.entries(plugins).every(
    ([pluginId, records]) =>
      pluginId.trim().length > 0 &&
      Array.isArray(records) &&
      records.every((candidate) => {
        const item = record(candidate);
        if (item === null) return false;
        if (
          !["user", "project", "local", "managed"].includes(
            String(item.scope),
          ) ||
          typeof item.installPath !== "string" ||
          !isAbsolute(item.installPath)
        )
          return false;
        return (
          (item.scope !== "project" && item.scope !== "local") ||
          (typeof item.projectPath === "string" && isAbsolute(item.projectPath))
        );
      }),
  );
}

function skillControl(
  exposure: HarnessExposure,
  targetId: string,
  policySource: (
    kind: "skill-exposure" | "plugin",
    evidence: NativeControlDocumentEvidence,
  ) => SetupSourceRef,
): SetupNativeControl {
  const selector = skillSelector(
    exposure.control.kind === "native"
      ? exposure.control.selector.value
      : targetId,
    targetId,
  );
  if (
    exposure.control.kind !== "native" ||
    exposure.control.mechanism !== "claude-skill-overrides" ||
    exposure.control.selector.kind !== "name"
  )
    return unavailableControl(
      selector,
      exposure.control.kind === "unsupported"
        ? exposure.control.reason
        : "this Skill exposure has no supported Claude Code native policy",
      [],
    );
  const control = exposure.control;
  const layers = control.layers.map((evidence) =>
    nativeLayer(evidence, policySource("skill-exposure", evidence)),
  );
  const operation = (action: "enable" | "disable") => {
    const availability = control.availability[action];
    return availability.kind === "unavailable"
      ? availability
      : configurationOperation(layers, control.writableLayerPaths);
  };
  return {
    selector,
    layers,
    availability: {
      enable: operation("enable"),
      disable: operation("disable"),
    },
  };
}

function skillSelector(name: string, targetId: string) {
  return {
    kind: "skill-name" as const,
    id: `claude-code:skill:${targetId}`,
    name,
    authority: "exact-target" as const,
    governedTargetIds: [targetId] as [string],
  };
}

function pluginControl(
  plugin: PluginBoundary,
  targetId: string,
  policySource: (
    kind: "skill-exposure" | "plugin",
    evidence: NativeControlDocumentEvidence,
  ) => SetupSourceRef,
): SetupNativeControl {
  const selector = {
    kind: "plugin-id" as const,
    id: `claude-code:plugin:${plugin.id}`,
    pluginId: plugin.pluginId,
    authority: "exact-target" as const,
    governedTargetIds: [targetId] as [string],
  };
  const control = plugin.availability.control;
  if (control.kind !== "native")
    return unavailableControl(selector, control.reason, []);
  if (control.mechanism !== "claude-enabled-plugins")
    return unavailableControl(
      selector,
      "this Plugin has no supported Claude Code native policy",
      [],
    );
  const layers = control.layers.map((evidence) =>
    nativeLayer(evidence, policySource("plugin", evidence)),
  );
  const operation = (action: "enable" | "disable") => {
    if (plugin.runtimeDefault)
      return {
        kind: "unavailable" as const,
        reason: "runtime-default Plugins are protected",
      };
    const availability = control.availability[action];
    return availability.kind === "unavailable"
      ? availability
      : configurationOperation(layers, control.writableLayerPaths);
  };
  return {
    selector,
    layers,
    availability: {
      enable: operation("enable"),
      disable: operation("disable"),
    },
  };
}

function mcpControl(
  selector: Extract<
    SetupNativeControl["selector"],
    { readonly kind: "mcp-server-key" }
  >,
  source: SetupSourceRef,
  stateLayer: SetupConfigurationLayer,
  unavailableReason: string | null,
): SetupNativeControl {
  const operation =
    unavailableReason !== null || !layerWritable(stateLayer)
      ? {
          kind: "unavailable" as const,
          reason:
            unavailableReason ??
            "the selected Claude Code project preference is not safe to modify",
        }
      : {
          kind: "available" as const,
          controlScope: stateLayer.scope,
          authority: {
            kind: "configuration" as const,
            source,
            layerSourceId: source.sourceId,
            layerCanonicalPath:
              stateLayer.canonicalPath ?? stateLayer.source.path,
          },
        };
  return {
    selector,
    layers: [stateLayer],
    availability: { enable: operation, disable: operation },
  };
}

function nativeLayer(
  evidence: NativeControlDocumentEvidence,
  source: SetupSourceRef,
): SetupConfigurationLayer {
  return {
    source,
    format: evidence.format,
    scope: evidence.scope as SetupScope,
    precedence:
      evidence.documentScope === "user"
        ? 0
        : evidence.documentScope === "shared-workspace"
          ? 1
          : 2,
    applies: evidence.applies,
    exists: evidence.exists,
    canonicalPath: evidence.canonicalPath,
    expectedPreimage: evidence.preimageHash,
    protection: evidence.protection,
    integrity: !evidence.exists
      ? "missing"
      : evidence.canonicalPath === null
        ? "unreadable"
        : "regular",
  };
}

function jsonLayer(
  source: SetupSourceRef,
  document: JsonDocument,
  precedence: number,
): SetupConfigurationLayer {
  return {
    source,
    format: "json",
    scope: document.scope,
    precedence,
    applies: true,
    exists: document.evidence.exists,
    canonicalPath: document.evidence.canonicalPath,
    expectedPreimage: document.evidence.preimageHash,
    protection: document.evidence.protection,
    integrity: !document.evidence.exists
      ? "missing"
      : document.unsafe
        ? "unreadable"
        : "regular",
  };
}

function configurationOperation(
  layers: readonly SetupConfigurationLayer[],
  writablePaths: readonly string[],
) {
  const layer = [...layers]
    .reverse()
    .find(
      (candidate) =>
        writablePaths.includes(candidate.source.path ?? "") &&
        (candidate.canonicalPath !== null ||
          (!candidate.exists && candidate.source.path !== null)) &&
        layerWritable(candidate),
    );
  return layer === undefined
    ? {
        kind: "unavailable" as const,
        reason:
          "no writable Claude Code layer can override the effective setting",
      }
    : {
        kind: "available" as const,
        controlScope: layer.scope,
        authority: {
          kind: "configuration" as const,
          source: layer.source,
          layerSourceId: layer.source.sourceId,
          layerCanonicalPath: layer.canonicalPath ?? layer.source.path,
        },
      };
}

function layerWritable(layer: SetupConfigurationLayer): boolean {
  return (
    (layer.canonicalPath !== null ||
      (!layer.exists && layer.source.path !== null)) &&
    layer.protection.git.kind !== "protected" &&
    layer.protection.system.kind === "none" &&
    layer.protection.filesystem.kind === "writable"
  );
}

function unavailableControl(
  selector: SetupNativeControl["selector"],
  reason: string,
  layers: readonly SetupConfigurationLayer[],
): SetupNativeControl {
  return {
    selector,
    layers,
    availability: {
      enable: { kind: "unavailable", reason },
      disable: { kind: "unavailable", reason },
    },
  };
}

function stateFromStatus(status: string): SetupConfiguredState {
  const policy =
    status === "enabled"
      ? "enabled"
      : status === "disabled"
        ? "disabled"
        : "unresolved";
  return {
    policy,
    effectiveWorkspaceState: policy,
    accountState: "unknown",
    liveSessionState: "unknown",
  };
}

function stateFromDisabledMembership(
  disabled: ReadonlySet<string>,
  serverKey: string,
  unresolved: boolean,
  ownerDisabled: boolean,
): SetupConfiguredState {
  const policy = unresolved
    ? "unresolved"
    : disabled.has(serverKey)
      ? "disabled"
      : "enabled";
  return {
    policy,
    effectiveWorkspaceState: ownerDisabled ? "disabled" : policy,
    accountState: "unknown",
    liveSessionState: "unknown",
  };
}

function ownerForInstallation(owner: Ownership): SessionSetupTarget["owner"] {
  if (owner.kind === "manager")
    return { kind: "manager", managerId: owner.managerId };
  if (owner.kind === "agent-runtime")
    return { kind: "runtime", harnessId: "claude-code" };
  if (owner.kind === "filesystem") return { kind: "standalone" };
  return {
    kind: "unknown",
    reason: "legacy inventory does not establish a standalone setup owner",
  };
}

function pluginScope(plugin: PluginBoundary, inventory: Inventory): SetupScope {
  return (inventory.installations.find((candidate) =>
    plugin.installationIds.includes(candidate.id),
  )?.scope ?? { kind: "user" }) as SetupScope;
}

function nativePluginName(pluginId: string): string {
  const separator = pluginId.lastIndexOf("@");
  return separator > 0 ? pluginId.slice(0, separator) : pluginId;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
