import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { parse as parseJsonc, parseTree, type ParseError } from "jsonc-parser";

import { CODEX_PLUGIN_ADAPTER_ID } from "../adapter/built-ins.js";
import { stringifyModel } from "../model/json.js";
import type { PluginBoundary } from "../model/types.js";
import type {
  SessionSetupScanRequest,
  SessionSetupScanner,
  SessionSetupSnapshot,
  SessionSetupSourceResult,
  SessionSetupTarget,
  SetupConfigurationLayer,
  SetupConfiguredState,
  SetupNativeControl,
  SetupScope,
  SetupSourceRef,
} from "../session-setup/types.js";
import { recoveredSourceProfiles } from "../session-setup/profiles.js";
import { parseSessionSetupSnapshot } from "../session-setup/validation.js";
import { readAvailabilityDocument } from "./availability-evidence.js";
import {
  hasDuplicateKeys,
  pathKey,
  readStableRegularFile,
} from "./evidence.js";
import {
  createInventoryScanner,
  defaultInventoryScanEnvironment,
} from "./scanner.js";
import { stableId } from "./identity.js";
import { systemCommandRunner } from "./process.js";
import type {
  InventoryCommandRunner,
  InventoryScannerOptions,
} from "./types.js";

const codexProfile = recoveredSourceProfiles.find(
  (profile) => profile.id === "codex-0.154.0",
)!;

export interface CodexSessionSetupScanRequest extends SessionSetupScanRequest {
  /** Durable workspace trust evidence. Unknown trust never authorizes a project edit. */
  readonly workspaceTrusted?: boolean | null;
}

export function createSessionSetupScanner(
  options: InventoryScannerOptions,
): SessionSetupScanner {
  return {
    scanSessionSetup: (request = {}) => scanCodexSessionSetup(request, options),
  };
}

/** Scans the process's bounded Codex roots without creating configuration. */
export async function scanSessionSetup(
  request: CodexSessionSetupScanRequest = {},
): Promise<SessionSetupSnapshot> {
  return scanCodexSessionSetup(request, {
    now: () => new Date(),
    environment: defaultInventoryScanEnvironment(),
    commandRunner: systemCommandRunner,
  });
}

async function scanCodexSessionSetup(
  request: CodexSessionSetupScanRequest,
  options: InventoryScannerOptions,
): Promise<SessionSetupSnapshot> {
  const environment = {
    ...options.environment,
    workspaceDirectory: (
      request.workspace ?? { path: options.environment.workspaceDirectory }
    ).path,
  };
  const inventory = await createInventoryScanner({
    ...options,
    environment,
  }).scan(request.roots === undefined ? {} : { roots: request.roots });
  if (request.harnessId !== undefined && request.harnessId !== "codex")
    throw new Error(
      "the Codex session-setup scanner accepts only the Codex harness",
    );
  const workspace = request.workspace ?? {
    path: environment.workspaceDirectory,
  };
  const home =
    environment.agentHomeDirectories?.codex ??
    join(environment.homeDirectory, ".codex");
  const userPath = join(home, "config.toml");
  const projectPath = join(workspace.path, ".codex", "config.toml");
  const userDocument = await readDocument(
    userPath,
    { kind: "user" },
    true,
    options.commandRunner,
  );
  const projectApplies =
    request.workspaceTrusted === true
      ? true
      : request.workspaceTrusted === false
        ? false
        : "unresolved";
  const projectDocument = await readDocument(
    projectPath,
    { kind: "workspace", workspacePath: workspace.path },
    projectApplies,
    options.commandRunner,
  );
  const sources: SessionSetupSourceResult[] = [];
  const targets: SessionSetupTarget[] = [];
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
      profileId: codexProfile.id,
      harnessId: "codex",
      kind,
      scope,
      status,
      reason,
      targetIds: [...targetIds],
      collateralTargetIds: [...targetIds],
    });
    return source;
  };
  const configurationSources = new Map<string, SetupSourceRef>();
  for (const [index, document] of [userDocument, projectDocument].entries()) {
    if (index === 1 && pathKey(document.path) === pathKey(userDocument.path))
      continue;
    configurationSources.set(
      pathKey(document.path),
      addSource(
        "mcp-registration",
        document.scope,
        `codex:mcp-document:${document.path}`,
        [],
        document.unsafe ? "invalid" : "success",
        document.unsafe ? "Codex configuration is unsafe or malformed" : null,
        document.path,
      ),
    );
  }

  // Standalone Skills use the pre-existing exact path exposure evidence.
  for (const installation of inventory.installations) {
    if (
      installation.ownership.kind === "plugin" ||
      !installation.exposedTo.includes("codex")
    )
      continue;
    const exposure = installation.harnessExposures.find(
      (item) => item.harnessId === "codex",
    );
    if (!exposure) continue;
    const id = stableId("setup-skill", installation.id);
    const source = addSource(
      "skill-exposure",
      installation.scope as SetupScope,
      `codex:skill:${installation.id}`,
      [id],
    );
    targets.push({
      id,
      kind: "skill-exposure",
      harnessId: "codex",
      workspace,
      name: installation.skill.name,
      source,
      owner: ownerForInstallation(installation.ownership),
      definitionScope: installation.scope as SetupScope,
      state: stateFromExposure(exposure.status),
      control: controlFromExposure(exposure, source),
      installationId: installation.id,
    });
  }

  const pluginTargets = new Map<string, string>();
  const pluginMcpIds = new Map<string, string[]>();
  const requiredApps = new Map<string, string[]>();
  for (const plugin of inventory.plugins) {
    if (
      plugin.adapterId !== CODEX_PLUGIN_ADAPTER_ID ||
      !plugin.exposedTo.includes("codex")
    )
      continue;
    const id = stableId("setup-plugin", plugin.id);
    pluginTargets.set(plugin.id, id);
    const source = addSource(
      "plugin",
      { kind: "user" },
      `codex:plugin-policy:${plugin.id}`,
      [id],
    );
    targets.push({
      id,
      kind: "plugin",
      harnessId: "codex",
      workspace,
      name: plugin.pluginId,
      source,
      owner: { kind: "plugin", pluginBoundaryId: plugin.id },
      definitionScope: { kind: "user" },
      state: stateFromPlugin(plugin.availability.status),
      control: pluginControl(plugin, source, userDocument),
      pluginBoundaryId: plugin.id,
      pluginId: plugin.pluginId,
      childTargetIds: [],
    });
  }
  const childIds = new Map<string, string[]>();
  for (const installation of inventory.installations) {
    if (
      installation.pluginBoundaryId === null ||
      !pluginTargets.has(installation.pluginBoundaryId)
    )
      continue;
    const id = stableId("setup-plugin-skill", installation.id);
    const source = addSource(
      "skill-exposure",
      installation.scope as SetupScope,
      `codex:plugin-skill:${installation.id}`,
      [id],
      "success",
      null,
      installation.location.path,
    );
    targets.push({
      id,
      kind: "skill-exposure",
      harnessId: "codex",
      workspace,
      name: installation.skill.name,
      source,
      owner: {
        kind: "plugin",
        pluginBoundaryId: installation.pluginBoundaryId,
      },
      definitionScope: installation.scope as SetupScope,
      state: stateFromPlugin(
        inventory.plugins.find(
          (plugin) => plugin.id === installation.pluginBoundaryId,
        )?.availability.status ?? "unresolved",
      ),
      control: unavailablePathControl(
        installation.location.path,
        "Plugin-owned Skills have no independent Codex availability policy",
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

  const configurationDocuments =
    pathKey(userDocument.path) === pathKey(projectDocument.path)
      ? [userDocument]
      : [userDocument, projectDocument];
  for (const declarationDocument of configurationDocuments) {
    for (const [serverKey, declarationValue] of entries(
      objectAt(declarationDocument.value, ["mcp_servers"]),
    )) {
      const projectValue = objectAt(projectDocument.value, [
        "mcp_servers",
        serverKey,
      ]);
      const projectDefines = projectValue !== undefined;
      const useWorkspaceAuthority =
        declarationDocument.scope.kind === "user" && projectApplies === true;
      const authorityDocument = useWorkspaceAuthority
        ? projectDocument
        : declarationDocument;
      const id = stableId("setup-mcp", declarationDocument.path, serverKey);
      const source = addSource(
        "mcp-registration",
        declarationDocument.scope,
        `codex:mcp:${declarationDocument.path}:${serverKey}`,
        [id],
        "success",
        null,
        declarationDocument.path,
      );
      targets.push({
        id,
        kind: "mcp-registration",
        harnessId: "codex",
        workspace,
        name: serverKey,
        source,
        owner: { kind: "standalone" },
        definitionScope: declarationDocument.scope,
        state: stateFromEnabled(
          objectAt(
            projectApplies === true && projectDefines
              ? projectValue
              : declarationValue,
            ["enabled"],
          ),
          projectApplies === "unresolved" && projectDefines,
        ),
        control: mcpControl(
          serverKey,
          configurationSources.get(pathKey(authorityDocument.path)) ?? source,
          authorityDocument,
          projectApplies === true || !projectDefines,
          configurationDocuments.map((item) =>
            layer(configurationSources.get(pathKey(item.path)) ?? source, item),
          ),
          declarationDocument.path,
        ),
        declarationSource: source,
        serverKey,
        requiredAppBindingId: null,
      });
    }
  }

  // Only paths already recognized as resources of an installed Plugin are read.
  for (const plugin of inventory.plugins.filter(
    (item) =>
      item.adapterId === CODEX_PLUGIN_ADAPTER_ID && pluginTargets.has(item.id),
  )) {
    const descriptor = await pluginDescriptor(plugin);
    const owner = { kind: "plugin" as const, pluginBoundaryId: plugin.id };
    for (const result of descriptor.sources)
      addSource(
        result.kind,
        { kind: "user" },
        `codex:plugin-descriptor:${plugin.id}:${result.resourceId}:${result.kind}`,
        [],
        result.status,
        result.reason,
        result.path,
      );
    for (const [serverKey] of entries(descriptor.mcp)) {
      const id = stableId("setup-plugin-mcp", plugin.id, serverKey);
      const source = addSource(
        "mcp-registration",
        { kind: "user" },
        `codex:plugin-mcp-policy:${plugin.id}:${serverKey}`,
        [id],
        "success",
        null,
        userDocument.path,
      );
      const declarationSource = addSource(
        "mcp-registration",
        { kind: "user" },
        `codex:plugin-mcp-declaration:${plugin.id}:${serverKey}`,
        [],
        "success",
        null,
        descriptor.path,
      );
      targets.push({
        id,
        kind: "mcp-registration",
        harnessId: "codex",
        workspace,
        name: serverKey,
        source,
        owner,
        definitionScope: { kind: "user" },
        state: stateFromEnabled(
          objectAt(userDocument.value, [
            "plugins",
            plugin.pluginId,
            "mcp_servers",
            serverKey,
            "enabled",
          ]),
        ),
        control: pluginMcpControl(plugin, serverKey, source, userDocument),
        declarationSource,
        serverKey,
        requiredAppBindingId: null,
      });
      pluginMcpIds.set(plugin.id, [...(pluginMcpIds.get(plugin.id) ?? []), id]);
    }
    for (const [alias, raw] of entries(descriptor.apps)) {
      const connectorId = stringAt(raw, ["id"]);
      if (!connectorId) continue;
      const id = stableId("setup-app", plugin.id, alias);
      const source = addSource(
        "app-binding",
        { kind: "user" },
        `codex:app-policy:${plugin.id}:${alias}`,
        [id],
        "success",
        null,
        userDocument.path,
      );
      const declarationSource = addSource(
        "app-binding",
        { kind: "user" },
        `codex:app-declaration:${plugin.id}:${alias}`,
        [],
        "success",
        null,
        descriptor.path,
      );
      targets.push({
        id,
        kind: "app-binding",
        harnessId: "codex",
        workspace,
        name: alias,
        source,
        owner,
        definitionScope: { kind: "user" },
        state: stateFromEnabled(
          objectAt(userDocument.value, ["apps", connectorId, "enabled"]),
        ),
        control: appControl(connectorId, source, userDocument),
        declarationSource,
        alias,
        connectorId,
        requiredByTargetIds: [],
      });
      if (objectAt(raw, ["required"]) === true)
        requiredApps.set(plugin.id, [
          ...(requiredApps.get(plugin.id) ?? []),
          id,
        ]);
    }
  }

  const dependencies: {
    kind: "hard";
    dependent: import("../session-setup/types.js").SessionSetupTargetRef;
    required: import("../session-setup/types.js").SessionSetupTargetRef;
    reason: string;
  }[] = [];
  const byId = new Map(targets.map((target) => [target.id, target]));
  for (const [pluginId, appIds] of requiredApps) {
    const appId = appIds[0];
    if (!appId) continue;
    const app = byId.get(appId);
    if (!app || app.kind !== "app-binding") continue;
    for (const mcpId of pluginMcpIds.get(pluginId) ?? []) {
      const mcp = byId.get(mcpId);
      if (!mcp || mcp.kind !== "mcp-registration") continue;
      const index = targets.findIndex((target) => target.id === mcp.id);
      targets[index] = { ...mcp, requiredAppBindingId: app.id };
      const appIndex = targets.findIndex((target) => target.id === app.id);
      targets[appIndex] = {
        ...app,
        requiredByTargetIds: [...app.requiredByTargetIds, mcp.id].sort(),
      };
      dependencies.push({
        kind: "hard",
        dependent: mcpRef(mcp),
        required: appRef(app),
        reason: "the installed Plugin declares this App Binding as required",
      });
    }
  }

  const completeTargets = completeSelectors(targets);
  const completeSources = sources.map((source) => {
    if (source.kind !== "app-binding" || source.targetIds.length !== 1)
      return source;
    const target = completeTargets.find(
      (item) => item.id === source.targetIds[0],
    );
    if (target?.kind !== "app-binding") return source;
    return {
      ...source,
      collateralTargetIds: completeTargets
        .filter(
          (item) =>
            item.kind === "app-binding" &&
            item.connectorId === target.connectorId,
        )
        .map((item) => item.id)
        .sort(),
    };
  });
  const snapshotBase = {
    schemaVersion: 1 as const,
    kind: "session-setup-snapshot" as const,
    scannedAt: inventory.scannedAt,
    workspace,
    harnesses: ["codex" as const],
    targets: completeTargets,
    sources: completeSources,
    profiles: [codexProfile],
    dependencies,
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

interface Document {
  readonly path: string;
  readonly scope: SetupScope;
  readonly evidence: Awaited<
    ReturnType<typeof readAvailabilityDocument>
  >["evidence"];
  readonly value: Record<string, unknown>;
  readonly unsafe: boolean;
}
async function readDocument(
  path: string,
  scope: SetupScope,
  applies: true | false | "unresolved",
  runner: InventoryCommandRunner,
): Promise<Document> {
  const read = await readAvailabilityDocument(
    path,
    "toml",
    scope,
    scope.kind === "user" ? "user" : "shared-workspace",
    applies,
    runner,
  );
  let value: Record<string, unknown> = {};
  let unsafe = read.unsafe;
  if (read.text !== null && !unsafe) {
    try {
      value = record(parseToml(read.text)) ?? {};
    } catch {
      unsafe = true;
    }
  }
  return { path, scope, evidence: read.evidence, value, unsafe };
}
function layer(
  source: SetupSourceRef,
  document: Document,
): SetupConfigurationLayer {
  return {
    source,
    format: "toml",
    scope: document.scope,
    precedence: document.scope.kind === "workspace" ? 1 : 0,
    applies: document.evidence.applies,
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
function configurationControl(
  selector: SetupNativeControl["selector"],
  source: SetupSourceRef,
  document: Document,
  available = true,
  layers: readonly SetupConfigurationLayer[] | null = null,
): SetupNativeControl {
  const currentLayer = layer(source, document);
  const operation =
    available && !document.unsafe
      ? {
          kind: "available" as const,
          controlScope: document.scope,
          authority: {
            kind: "configuration" as const,
            source,
            layerSourceId: source.sourceId,
            layerCanonicalPath: currentLayer.canonicalPath,
          },
        }
      : {
          kind: "unavailable" as const,
          reason: document.unsafe
            ? "Codex configuration is unsafe or malformed"
            : "project policy requires trusted workspace evidence",
        };
  return {
    selector,
    layers: layers ?? [currentLayer],
    availability: { enable: operation, disable: operation },
  };
}
function pluginControl(
  plugin: PluginBoundary,
  source: SetupSourceRef,
  document: Document,
): SetupNativeControl {
  return configurationControl(
    {
      kind: "plugin-id",
      id: `plugin:${plugin.id}`,
      pluginId: plugin.pluginId,
      authority: "exact-target",
      governedTargetIds: [stableId("setup-plugin", plugin.id)],
    },
    source,
    document,
  );
}
function mcpControl(
  serverKey: string,
  source: SetupSourceRef,
  document: Document,
  available: boolean,
  layers: readonly SetupConfigurationLayer[],
  declarationPath: string,
): SetupNativeControl {
  return configurationControl(
    {
      kind: "mcp-server-key",
      id: `mcp:${declarationPath}:${serverKey}`,
      serverKey,
      policyOwner: { kind: "standalone" },
      authority: "exact-target",
      governedTargetIds: [stableId("setup-mcp", declarationPath, serverKey)],
    },
    source,
    document,
    available,
    layers,
  );
}
function pluginMcpControl(
  plugin: PluginBoundary,
  serverKey: string,
  source: SetupSourceRef,
  document: Document,
): SetupNativeControl {
  return configurationControl(
    {
      kind: "mcp-server-key",
      id: `plugin-mcp:${plugin.id}:${serverKey}`,
      serverKey,
      policyOwner: { kind: "plugin", pluginId: plugin.pluginId },
      authority: "exact-target",
      governedTargetIds: [stableId("setup-plugin-mcp", plugin.id, serverKey)],
    },
    source,
    document,
  );
}
function appControl(
  connectorId: string,
  source: SetupSourceRef,
  document: Document,
): SetupNativeControl {
  return configurationControl(
    {
      kind: "app-connector-id",
      id: `app:${connectorId}`,
      connectorId,
      authority: "shared-connector",
      governedTargetIds: ["pending"],
      collateralComplete: true,
    },
    source,
    document,
  );
}
function controlFromExposure(
  exposure: import("../model/types.js").HarnessExposure,
  source: SetupSourceRef,
): SetupNativeControl {
  if (
    exposure.control.kind !== "native" ||
    exposure.control.selector.kind !== "path"
  )
    return unavailablePathControl(
      source.sourceId,
      "this Skill exposure has no supported Codex native policy",
    );
  const evidence = exposure.control.layers[0];
  if (!evidence)
    return unavailablePathControl(
      source.sourceId,
      "Codex Skill policy has no configuration evidence",
    );
  const doc: Document = {
    path: evidence.path,
    scope: evidence.scope as SetupScope,
    evidence,
    value: {},
    unsafe: evidence.selectorValue === null,
  };
  const targetId = source.sourceId.slice("codex:skill:".length);
  const result = configurationControl(
    {
      kind: "skill-path",
      id: `skill:${exposure.control.selector.value}`,
      path: exposure.control.selector.value,
      authority: "exact-target",
      governedTargetIds: [stableId("setup-skill", targetId)],
    },
    source,
    doc,
  );
  return exposure.control.availability.enable.kind === "available" &&
    exposure.control.availability.disable.kind === "available"
    ? result
    : unavailablePathControl(
        source.sourceId,
        "Codex Skill policy is unavailable",
      );
}
function unavailablePathControl(
  id: string,
  reason: string,
): SetupNativeControl {
  return {
    selector: {
      kind: "skill-path",
      id: `skill:${id}`,
      path: id,
      authority: "exact-target",
      governedTargetIds: ["pending"],
    },
    layers: [],
    availability: {
      enable: { kind: "unavailable", reason },
      disable: { kind: "unavailable", reason },
    },
  };
}
function stateFromEnabled(
  value: unknown,
  effectiveUnresolved = false,
): SetupConfiguredState {
  const policy =
    value === false
      ? "disabled"
      : value === true || value === undefined
        ? "enabled"
        : "unresolved";
  return {
    policy,
    effectiveWorkspaceState: effectiveUnresolved ? "unresolved" : policy,
    accountState: "unknown",
    liveSessionState: "unknown",
  };
}
function stateFromExposure(status: string): SetupConfiguredState {
  return stateFromEnabled(
    status === "disabled" ? false : status === "enabled" ? true : "invalid",
  );
}
function stateFromPlugin(status: string): SetupConfiguredState {
  return stateFromExposure(status);
}
function mcpRef(
  target: Extract<SessionSetupTarget, { kind: "mcp-registration" }>,
) {
  return {
    kind: "mcp-registration" as const,
    targetId: target.id,
    declarationSourceId: target.declarationSource.sourceId,
    serverKey: target.serverKey,
  };
}
function appRef(target: Extract<SessionSetupTarget, { kind: "app-binding" }>) {
  return {
    kind: "app-binding" as const,
    targetId: target.id,
    declarationSourceId: target.declarationSource.sourceId,
    alias: target.alias,
    connectorId: target.connectorId,
  };
}
function ownerForInstallation(
  owner: import("../model/types.js").Ownership,
): SessionSetupTarget["owner"] {
  if (owner.kind === "manager")
    return { kind: "manager", managerId: owner.managerId };
  if (owner.kind === "agent-runtime")
    return { kind: "runtime", harnessId: "codex" };
  if (owner.kind === "filesystem") return { kind: "standalone" };
  return {
    kind: "unknown",
    reason: "legacy inventory does not establish a standalone setup owner",
  };
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function objectAt(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const item of path) {
    const next = record(current);
    if (!next) return undefined;
    current = next[item];
  }
  return current;
}
function stringAt(value: unknown, path: readonly string[]): string | null {
  const result = objectAt(value, path);
  return typeof result === "string" && result.trim() ? result : null;
}
function entries(value: unknown): readonly [string, Record<string, unknown>][] {
  const item = record(value);
  return item
    ? Object.entries(item).flatMap(([key, entry]) => {
        const child = record(entry);
        return child ? [[key, child] as const] : [];
      })
    : [];
}
async function pluginDescriptor(plugin: PluginBoundary): Promise<{
  readonly mcp: Record<string, unknown>;
  readonly apps: Record<string, unknown>;
  readonly path: string | null;
  readonly sources: readonly DescriptorSourceResult[];
}> {
  const combined: {
    mcp: Record<string, unknown>;
    apps: Record<string, unknown>;
  } = { mcp: {}, apps: {} };
  let descriptorPath: string | null = null;
  const sources: DescriptorSourceResult[] = [];
  for (const resource of plugin.resources.filter(
    (item) =>
      item.kind === "configuration" &&
      ["mcp-servers", "apps", "plugin-manifest"].includes(item.id),
  )) {
    const kinds = [
      ...(resource.id === "apps" || resource.id === "plugin-manifest"
        ? (["app-binding"] as const)
        : []),
      ...(resource.id === "mcp-servers" || resource.id === "plugin-manifest"
        ? (["mcp-registration"] as const)
        : []),
    ];
    const path = resource.location?.path ?? null;
    const read =
      path === null
        ? {
            kind: "incomplete" as const,
            reason: "the installed Owner declares a descriptor that is missing",
            value: null,
          }
        : await readJsoncDescriptor(path);
    for (const kind of kinds)
      sources.push({
        kind,
        resourceId: resource.id,
        path,
        status: read.kind === "valid" ? "success" : read.kind,
        reason: read.kind === "valid" ? null : read.reason,
      });
    if (read.kind !== "valid" || read.value === null) continue;
    descriptorPath ??= path;
    if (resource.id === "mcp-servers") {
      Object.assign(
        combined.mcp,
        record(read.value.mcpServers) ??
          record(read.value.mcp_servers) ??
          read.value,
      );
    } else {
      Object.assign(combined.mcp, record(read.value.mcpServers) ?? {});
      Object.assign(combined.apps, record(read.value.apps) ?? {});
    }
  }
  return { ...combined, path: descriptorPath, sources };
}
interface DescriptorSourceResult {
  readonly kind: "mcp-registration" | "app-binding";
  readonly resourceId: string;
  readonly path: string | null;
  readonly status: "success" | "invalid" | "incomplete";
  readonly reason: string | null;
}
async function readJsoncDescriptor(path: string): Promise<
  | {
      readonly kind: "valid";
      readonly value: Record<string, unknown>;
      readonly reason: null;
    }
  | {
      readonly kind: "invalid" | "incomplete";
      readonly value: null;
      readonly reason: string;
    }
> {
  const initial = await lstat(path).catch(() => null);
  if (initial === null)
    return {
      kind: "incomplete",
      value: null,
      reason: "the declared descriptor is missing",
    };
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1)
    return {
      kind: "incomplete",
      value: null,
      reason: "the declared descriptor is not a safe regular file",
    };
  const stable = await readStableRegularFile(path, initial);
  if (stable === null)
    return {
      kind: "incomplete",
      value: null,
      reason: "the declared descriptor changed while read",
    };
  const errors: ParseError[] = [];
  const tree = parseTree(stable.bytes.toString("utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const value = record(parseJsonc(stable.bytes.toString("utf8")));
  if (
    tree === undefined ||
    errors.length > 0 ||
    hasDuplicateKeys(tree) ||
    value === null
  )
    return {
      kind: "invalid",
      value: null,
      reason: "the declared descriptor is malformed or has duplicate keys",
    };
  return { kind: "valid", value, reason: null };
}
function completeSelectors(
  targets: readonly SessionSetupTarget[],
): SessionSetupTarget[] {
  const apps = new Map<string, string[]>();
  for (const target of targets)
    if (target.kind === "app-binding")
      apps.set(target.connectorId, [
        ...(apps.get(target.connectorId) ?? []),
        target.id,
      ]);
  return targets.map((target) => {
    if (target.kind !== "app-binding") {
      if (target.control.selector.governedTargetIds[0] !== "pending")
        return target;
      return {
        ...target,
        control: {
          ...target.control,
          selector: {
            ...target.control.selector,
            governedTargetIds: [target.id],
          } as SessionSetupTarget["control"]["selector"],
        },
      } as SessionSetupTarget;
    }
    const governedTargetIds = apps.get(target.connectorId)!.sort();
    return {
      ...target,
      control: {
        ...target.control,
        selector: {
          ...target.control.selector,
          governedTargetIds: governedTargetIds as [string, ...string[]],
          collateralComplete: true,
        },
      },
    } as SessionSetupTarget;
  });
}

/** A checked TOML editor for only the four Codex availability selectors. */
