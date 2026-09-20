import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseJsonc, parseTree, type ParseError } from "jsonc-parser";

import { GEMINI_CLI_ADAPTER_ID } from "../adapter/built-ins.js";
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
  (candidate) => candidate.id === "gemini-cli-0.59.0",
)!;

interface JsonDocument {
  readonly path: string;
  readonly scope: SetupScope;
  readonly applies: true | false | "unresolved";
  readonly evidence: NativeControlDocumentEvidence;
  readonly value: Record<string, unknown>;
  readonly unsafe: boolean;
}

interface McpDeclaration {
  readonly name: string;
  readonly path: string;
  readonly scope: SetupScope;
  readonly applies: true | false | "unresolved";
  readonly source: SetupSourceRef;
  readonly owner:
    | { readonly kind: "standalone" }
    | { readonly kind: "plugin"; readonly plugin: PluginBoundary };
  readonly unavailableReason: string | null;
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

/** Builds the qualified Gemini CLI profile from bounded local evidence. */
export async function scanGeminiCliSessionSetup(
  request: SessionSetupScanRequest,
  options: InventoryScannerOptions,
  existingInventory?: Inventory,
): Promise<SessionSetupSnapshot> {
  if (request.harnessId !== undefined && request.harnessId !== "gemini-cli")
    throw new Error(
      "the Gemini CLI session-setup adapter accepts only the Gemini CLI harness",
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
  return buildGeminiSnapshot(inventory, workspace, environment, options);
}

async function buildGeminiSnapshot(
  inventory: Inventory,
  workspace: { readonly path: string },
  environment: InventoryScanEnvironment,
  options: InventoryScannerOptions,
): Promise<SessionSetupSnapshot> {
  const targets: SessionSetupTarget[] = [];
  const sources: SessionSetupSourceResult[] = [];
  const addSource: SourceAdder = (
    kind,
    scope,
    id,
    targetIds,
    status = "success",
    reason = null,
    path = null,
  ) => {
    const source = { sourceId: id, path };
    sources.push({
      source,
      profileId: profile.id,
      harnessId: "gemini-cli",
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
      `gemini-cli:${kind}-policy:${evidence.path}`,
      [],
      invalid ? "invalid" : "success",
      invalid
        ? "Gemini CLI settings are malformed, linked, hard-linked, unreadable, or unstable"
        : null,
      evidence.path,
    );
    policySources.set(key, source);
    return source;
  };

  for (const installation of inventory.installations) {
    if (
      installation.ownership.kind === "plugin" ||
      !installation.exposedTo.includes("gemini-cli")
    )
      continue;
    const exposure = installation.harnessExposures.find(
      (candidate) => candidate.harnessId === "gemini-cli",
    );
    if (!exposure) continue;
    const id = stableId("setup-skill", "gemini-cli", installation.id);
    const source = addSource(
      "skill-exposure",
      installation.scope as SetupScope,
      `gemini-cli:skill:${installation.id}`,
      [id],
      "success",
      null,
      installation.location.path,
    );
    targets.push({
      id,
      kind: "skill-exposure",
      harnessId: "gemini-cli",
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

  const geminiHome =
    environment.agentHomeDirectories?.["gemini-cli"] ??
    join(environment.homeDirectory, ".gemini");
  const extensionRoot = join(geminiHome, "extensions");
  const plugins = inventory.plugins.filter(
    (candidate) =>
      candidate.adapterId === GEMINI_CLI_ADAPTER_ID &&
      candidate.exposedTo.includes("gemini-cli"),
  );
  const pluginTargetIds = new Map(
    plugins.map((plugin) => [
      plugin.id,
      stableId("setup-plugin", "gemini-cli", plugin.id),
    ]),
  );
  const pluginInventorySource = addSource(
    "plugin",
    { kind: "user" },
    "gemini-cli:installed-extensions",
    [...pluginTargetIds.values()].sort(),
    "success",
    null,
    extensionRoot,
  );
  for (const plugin of plugins) {
    const id = pluginTargetIds.get(plugin.id)!;
    targets.push({
      id,
      kind: "plugin",
      harnessId: "gemini-cli",
      workspace,
      name: plugin.pluginId,
      source: pluginInventorySource,
      owner: { kind: "plugin", pluginBoundaryId: plugin.id },
      definitionScope: pluginScope(plugin, inventory),
      state: stateFromStatus(plugin.availability.status),
      control: pluginControl(plugin, id, workspace.path, nativePolicySource),
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
    const id = stableId("setup-plugin-skill", "gemini-cli", installation.id);
    const source = addSource(
      "skill-exposure",
      installation.scope as SetupScope,
      `gemini-cli:plugin-skill:${installation.id}`,
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
      harnessId: "gemini-cli",
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
        "Plugin-owned Skills have no independent Gemini CLI availability policy",
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

  let incompleteExtensionEvidence = false;
  for (const invalidPath of await invalidExtensionRoots(
    extensionRoot,
    plugins,
  )) {
    incompleteExtensionEvidence = true;
    addSource(
      "plugin",
      { kind: "user" },
      `gemini-cli:invalid-extension:${invalidPath}`,
      [],
      "invalid",
      "Gemini extension install or manifest evidence is unsafe or malformed",
      invalidPath,
    );
  }

  const workspaceApplies =
    environment.geminiWorkspaceTrusted === true
      ? true
      : environment.geminiWorkspaceTrusted === false
        ? false
        : "unresolved";
  const userSettings = await readJsonDocument(
    join(geminiHome, "settings.json"),
    "jsonc",
    { kind: "user" },
    "user",
    true,
    options.commandRunner,
  );
  const workspaceSettings = await readJsonDocument(
    join(workspace.path, ".gemini", "settings.json"),
    "jsonc",
    { kind: "workspace", workspacePath: workspace.path },
    "workspace",
    workspaceApplies,
    options.commandRunner,
  );
  const declarations: McpDeclaration[] = [];
  let incompleteMcpEvidence = incompleteExtensionEvidence;
  for (const [label, document] of [
    ["user", userSettings],
    ["workspace", workspaceSettings],
  ] as const) {
    const valid = !document.unsafe && validMcpMap(document.value.mcpServers);
    const source = addSource(
      "mcp-registration",
      document.scope,
      `gemini-cli:${label}-mcp:${document.path}`,
      [],
      valid ? "success" : "invalid",
      valid ? null : "Gemini CLI MCP declarations are unsafe or malformed",
      document.path,
    );
    if (!valid && document.applies !== false) incompleteMcpEvidence = true;
    if (valid)
      for (const [name] of Object.entries(
        record(document.value.mcpServers) ?? {},
      ))
        declarations.push({
          name,
          path: document.path,
          scope: document.scope,
          applies: document.applies,
          source,
          owner: { kind: "standalone" },
          unavailableReason: null,
        });
  }

  for (const plugin of plugins) {
    const descriptor = await pluginDescriptor(plugin);
    const descriptorIncomplete = descriptor.sources.some(
      (candidate) =>
        candidate.kind === "mcp-registration" && candidate.status !== "success",
    );
    if (descriptorIncomplete) incompleteMcpEvidence = true;
    for (const result of descriptor.sources) {
      if (result.kind !== "mcp-registration") continue;
      addSource(
        "mcp-registration",
        pluginScope(plugin, inventory),
        `gemini-cli:extension-descriptor:${plugin.id}:${result.resourceId}`,
        [],
        result.status,
        result.reason,
        result.path,
      );
    }
    for (const declaration of descriptor.mcp) {
      const source = addSource(
        "mcp-registration",
        pluginScope(plugin, inventory),
        `gemini-cli:extension-mcp:${plugin.id}:${declaration.path}:${declaration.key}`,
        [],
        "success",
        null,
        declaration.path,
      );
      declarations.push({
        name: declaration.key,
        path: declaration.path,
        scope: pluginScope(plugin, inventory),
        applies: true,
        source,
        owner: { kind: "plugin", plugin },
        unavailableReason: descriptorIncomplete
          ? "the installed extension's MCP declaration evidence is incomplete"
          : null,
      });
    }
  }

  const policyDocument = await readJsonDocument(
    join(geminiHome, "mcp-server-enablement.json"),
    "json",
    { kind: "user" },
    "user",
    true,
    options.commandRunner,
  );
  const policyValid =
    !policyDocument.unsafe && validMcpEnablement(policyDocument.value);
  const policySource = addSource(
    "mcp-registration",
    { kind: "user" },
    `gemini-cli:mcp-policy:${policyDocument.path}`,
    [],
    policyValid ? "success" : "invalid",
    policyValid ? null : "Gemini CLI MCP enablement is unsafe or malformed",
    policyDocument.path,
  );
  const policyLayer = jsonLayer(policySource, policyDocument, 2);
  const disabledServers = policyValid
    ? new Set(
        Object.entries(policyDocument.value)
          .filter(([, value]) => record(value)?.enabled === false)
          .map(([name]) => name),
      )
    : new Set<string>();

  for (const declaration of declarations) {
    const id = stableId(
      "setup-mcp",
      "gemini-cli",
      declaration.source.sourceId,
      declaration.name,
    );
    replaceSourceTarget(sources, declaration.source.sourceId, id);
    const ownerDisabled =
      declaration.owner.kind === "plugin" &&
      declaration.owner.plugin.availability.status === "disabled";
    const selector = {
      kind: "mcp-server-key" as const,
      id: `gemini-cli:mcp:${id}`,
      serverKey: declaration.name,
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
    const applicabilityReason =
      declaration.applies === "unresolved"
        ? "selected-workspace trust is unresolved for this Gemini CLI declaration"
        : declaration.applies === false
          ? "this Gemini CLI workspace declaration does not apply to the selected untrusted workspace"
          : null;
    const unavailableReason =
      declaration.unavailableReason ??
      applicabilityReason ??
      (!policyValid
        ? "Gemini CLI MCP enablement is unsafe or malformed"
        : incompleteMcpEvidence
          ? "MCP declaration evidence is incomplete, so native name authority is unproven"
          : null);
    targets.push({
      id,
      kind: "mcp-registration",
      harnessId: "gemini-cli",
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
      state: stateFromMcpPolicy(
        disabledServers,
        declaration.name,
        policyValid,
        declaration.applies,
        ownerDisabled,
      ),
      control:
        unavailableReason === null
          ? mcpControl(selector, policySource, policyLayer)
          : unavailableControl(selector, unavailableReason, [policyLayer]),
      declarationSource: declaration.source,
      serverKey: declaration.name,
      requiredAppBindingId: null,
    });
  }

  addSource(
    "app-binding",
    { kind: "agent", agentId: "gemini-cli" },
    "gemini-cli:account-apps",
    [],
    "unavailable",
    "Gemini account apps have no qualified authoritative offline provider",
  );

  const snapshotBase = {
    schemaVersion: 1 as const,
    kind: "session-setup-snapshot" as const,
    scannedAt: inventory.scannedAt,
    workspace,
    harnesses: ["gemini-cli" as const],
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
    exposure.control.mechanism !== "gemini-disabled-skills" ||
    exposure.control.selector.kind !== "name"
  )
    return unavailableControl(
      selector,
      exposure.control.kind === "unsupported"
        ? exposure.control.reason
        : "this Skill exposure has no supported Gemini CLI native policy",
      [],
    );
  const control = exposure.control;
  const pairs = control.layers.map((evidence) => ({
    evidence,
    layer: nativeLayer(evidence, policySource("skill-exposure", evidence)),
  }));
  const operation = (action: "enable" | "disable") => {
    const availability = control.availability[action];
    if (availability.kind === "unavailable") return availability;
    const applicable = pairs.filter(
      (candidate) => candidate.layer.applies === true,
    );
    const selected =
      action === "enable"
        ? applicable.filter(
            (candidate) =>
              candidate.evidence.selectorValue?.kind ===
                "gemini-disabled-skills" &&
              candidate.evidence.selectorValue.disabled,
          )
        : [...applicable]
            .reverse()
            .filter((candidate) => layerWritable(candidate.layer))
            .slice(0, 1);
    const effectiveSelection =
      selected.length > 0
        ? selected
        : [...applicable]
            .reverse()
            .filter((candidate) => layerWritable(candidate.layer))
            .slice(0, 1);
    if (
      effectiveSelection.length === 0 ||
      effectiveSelection.some((candidate) => !layerWritable(candidate.layer))
    )
      return {
        kind: "unavailable" as const,
        reason:
          action === "enable"
            ? "every applied Gemini CLI disabled-name membership must be writable"
            : "no applied Gemini CLI configuration layer is writable",
      };
    const steps = effectiveSelection.map((candidate) =>
      configurationStep(candidate.layer),
    );
    return {
      kind: "available" as const,
      ...steps[0]!,
      ...(steps.length > 1 ? { additionalControls: steps.slice(1) } : {}),
    };
  };
  return {
    selector,
    layers: pairs.map((candidate) => candidate.layer),
    availability: {
      enable: operation("enable"),
      disable: operation("disable"),
    },
  };
}

function pluginControl(
  plugin: PluginBoundary,
  targetId: string,
  workspacePath: string,
  policySource: (
    kind: "skill-exposure" | "plugin",
    evidence: NativeControlDocumentEvidence,
  ) => SetupSourceRef,
): SetupNativeControl {
  const selector = {
    kind: "plugin-id" as const,
    id: `gemini-cli:plugin:${plugin.id}`,
    pluginId: plugin.pluginId,
    authority: "exact-target" as const,
    governedTargetIds: [targetId] as [string],
  };
  const control = plugin.availability.control;
  if (
    control.kind !== "native" ||
    control.mechanism !== "gemini-extension-enablement"
  )
    return unavailableControl(
      selector,
      control.kind === "unsupported"
        ? control.reason
        : "this extension has no supported Gemini CLI native policy",
      [],
    );
  const layers = control.layers.map((evidence) =>
    nativeLayer(evidence, policySource("plugin", evidence)),
  );
  const layer = layers.find((candidate) => layerWritable(candidate));
  const operation = (action: "enable" | "disable") => {
    if (plugin.runtimeDefault)
      return {
        kind: "unavailable" as const,
        reason: "runtime-default Plugins are protected",
      };
    const availability = control.availability[action];
    if (availability.kind === "unavailable") return availability;
    if (!layer)
      return {
        kind: "unavailable" as const,
        reason: "the Gemini CLI extension enablement document is not writable",
      };
    const step = configurationStep(layer);
    return {
      kind: "available" as const,
      authority: step.authority,
      controlScope: {
        kind: "workspace" as const,
        workspacePath,
      },
    };
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
  layer: SetupConfigurationLayer,
): SetupNativeControl {
  const operation = layerWritable(layer)
    ? {
        kind: "available" as const,
        controlScope: { kind: "user" as const },
        authority: {
          kind: "configuration" as const,
          source,
          layerSourceId: source.sourceId,
          layerCanonicalPath: layer.canonicalPath ?? layer.source.path,
        },
      }
    : {
        kind: "unavailable" as const,
        reason: "the Gemini CLI MCP enablement document is not safe to modify",
      };
  return {
    selector,
    layers: [layer],
    availability: { enable: operation, disable: operation },
  };
}

function configurationStep(layer: SetupConfigurationLayer) {
  return {
    controlScope: layer.scope,
    authority: {
      kind: "configuration" as const,
      source: layer.source,
      layerSourceId: layer.source.sourceId,
      layerCanonicalPath: layer.canonicalPath ?? layer.source.path,
    },
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
    precedence: evidence.documentScope === "user" ? 0 : 1,
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
    format: document.evidence.format,
    scope: document.scope,
    precedence,
    applies: document.applies,
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

async function readJsonDocument(
  path: string,
  format: "json" | "jsonc",
  scope: SetupScope,
  documentScope: NativeControlDocumentEvidence["documentScope"],
  applies: true | false | "unresolved",
  runner: InventoryCommandRunner,
): Promise<JsonDocument> {
  const read = await readAvailabilityDocument(
    path,
    format,
    scope,
    documentScope,
    applies,
    runner,
  );
  let value: Record<string, unknown> = {};
  let unsafe = read.unsafe;
  if (read.text !== null && !unsafe) {
    const errors: ParseError[] = [];
    const parseOptions = {
      allowTrailingComma: format === "jsonc",
      disallowComments: format === "json",
    };
    const tree = parseTree(read.text, errors, parseOptions);
    const parsed = record(parseJsonc(read.text, errors, parseOptions));
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
  return { path, scope, applies, evidence: read.evidence, value, unsafe };
}

async function invalidExtensionRoots(
  extensionRoot: string,
  plugins: readonly PluginBoundary[],
): Promise<readonly string[]> {
  const represented = new Set(
    plugins.flatMap((plugin) =>
      plugin.resources
        .filter(
          (resource) =>
            resource.id === "management-root" && resource.location !== null,
        )
        .map((resource) => pathKey(resource.location!.path)),
    ),
  );
  const entries = await readdir(extensionRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const invalid: string[] = [];
  for (const entry of entries) {
    if (entry.name === "extension-enablement.json") continue;
    const root = join(extensionRoot, entry.name);
    if (represented.has(pathKey(root))) continue;
    const [install, manifest] = await Promise.all([
      lstat(join(root, ".gemini-extension-install.json")).catch(() => null),
      lstat(join(root, "gemini-extension.json")).catch(() => null),
    ]);
    if (install !== null || manifest !== null) invalid.push(root);
  }
  return invalid.sort();
}

function validMcpMap(value: unknown): boolean {
  if (value === undefined) return true;
  const map = record(value);
  return (
    map !== null &&
    Object.entries(map).every(
      ([name, declaration]) =>
        name.trim().length > 0 && record(declaration) !== null,
    )
  );
}

function validMcpEnablement(value: Record<string, unknown>): boolean {
  return Object.entries(value).every(
    ([name, state]) =>
      name.trim().length > 0 && typeof record(state)?.enabled === "boolean",
  );
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

function skillSelector(name: string, targetId: string) {
  return {
    kind: "skill-name" as const,
    id: `gemini-cli:skill:${targetId}`,
    name,
    authority: "exact-target" as const,
    governedTargetIds: [targetId] as [string],
  };
}

function layerWritable(layer: SetupConfigurationLayer): boolean {
  return (
    (layer.canonicalPath !== null ||
      (!layer.exists && layer.source.path !== null)) &&
    layer.protection.git.kind !== "protected" &&
    layer.protection.system.kind === "none" &&
    layer.protection.filesystem.kind === "writable" &&
    ["regular", "missing"].includes(layer.integrity)
  );
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

function stateFromMcpPolicy(
  disabled: ReadonlySet<string>,
  serverKey: string,
  policyValid: boolean,
  applies: true | false | "unresolved",
  ownerDisabled: boolean,
): SetupConfiguredState {
  const policy = !policyValid
    ? "unresolved"
    : disabled.has(serverKey)
      ? "disabled"
      : "enabled";
  const effectiveWorkspaceState =
    ownerDisabled || applies === false
      ? "disabled"
      : applies === "unresolved"
        ? "unresolved"
        : policy;
  return {
    policy,
    effectiveWorkspaceState,
    accountState: "unknown",
    liveSessionState: "unknown",
  };
}

function ownerForInstallation(owner: Ownership): SessionSetupTarget["owner"] {
  if (owner.kind === "manager")
    return { kind: "manager", managerId: owner.managerId };
  if (owner.kind === "agent-runtime")
    return { kind: "runtime", harnessId: "gemini-cli" };
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
