import { createHash } from "node:crypto";
import { join } from "node:path";

import { parse as parseToml } from "@iarna/toml";

import { CODEX_PLUGIN_ADAPTER_ID } from "../adapter/built-ins.js";
import {
  createSessionSetupConfigurationWriter,
  type SessionSetupConfigurationEditor,
} from "../execution/availability-documents.js";
import { stringifyModel } from "../model/json.js";
import type { PluginBoundary } from "../model/types.js";
import type {
  SessionSetupConfigurationRequest,
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
  const projectApplies = request.workspaceTrusted === true;
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

  for (const document of [userDocument, projectDocument]) {
    for (const [serverKey, value] of entries(
      objectAt(document.value, ["mcp_servers"]),
    )) {
      const id = stableId("setup-mcp", document.path, serverKey);
      const source = addSource(
        "mcp-registration",
        document.scope,
        `codex:mcp:${document.path}:${serverKey}`,
        [id],
        "success",
        null,
        document.path,
      );
      targets.push({
        id,
        kind: "mcp-registration",
        harnessId: "codex",
        workspace,
        name: serverKey,
        source,
        owner: { kind: "standalone" },
        definitionScope: document.scope,
        state: stateFromEnabled(objectAt(value, ["enabled"])),
        control: mcpControl(
          serverKey,
          source,
          document,
          projectApplies || document.scope.kind === "user",
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
    const descriptor = await pluginDescriptor(plugin, options.commandRunner);
    const owner = { kind: "plugin" as const, pluginBoundaryId: plugin.id };
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
    }
    for (const [alias, raw] of entries(descriptor.apps)) {
      const connectorId =
        stringAt(raw, ["connectorId"]) ?? stringAt(raw, ["connector_id"]);
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
    dependencies: [],
    legacyInventory: inventory,
  };
  const fingerprint = createHash("sha256")
    .update(stringifyModel(snapshotBase, 0))
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
  applies: boolean,
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
    layers: [currentLayer],
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
): SetupNativeControl {
  return configurationControl(
    {
      kind: "mcp-server-key",
      id: `mcp:${document.path}:${serverKey}`,
      serverKey,
      policyOwner: { kind: "standalone" },
      authority: "exact-target",
      governedTargetIds: [stableId("setup-mcp", document.path, serverKey)],
    },
    source,
    document,
    available,
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
function stateFromEnabled(value: unknown): SetupConfiguredState {
  const policy =
    value === false
      ? "disabled"
      : value === true || value === undefined
        ? "enabled"
        : "unresolved";
  return {
    policy,
    effectiveWorkspaceState: policy,
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
async function pluginDescriptor(
  plugin: PluginBoundary,
  runner: InventoryCommandRunner,
): Promise<{
  readonly mcp: Record<string, unknown>;
  readonly apps: Record<string, unknown>;
}> {
  const paths = plugin.resources
    .filter(
      (resource) =>
        resource.kind === "configuration" &&
        ["mcp-servers", "apps", "plugin-manifest"].includes(resource.id),
    )
    .map((resource) => resource.location?.path)
    .filter((path): path is string => path !== null);
  const combined: {
    mcp: Record<string, unknown>;
    apps: Record<string, unknown>;
  } = { mcp: {}, apps: {} };
  for (const path of paths) {
    const read = await readAvailabilityDocument(
      path,
      "json",
      { kind: "user" },
      "user",
      true,
      runner,
    );
    if (read.unsafe || read.text === null) continue;
    try {
      const value = record(JSON.parse(read.text));
      Object.assign(
        combined.mcp,
        record(value?.mcpServers) ?? record(value?.mcp_servers) ?? {},
      );
      Object.assign(combined.apps, record(value?.apps) ?? {});
    } catch {
      /* an invalid descriptor remains non-actionable */
    }
  }
  return combined;
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
export function createCodexSessionSetupConfigurationEditor(): SessionSetupConfigurationEditor {
  return { edit: (text, request) => editCodexToml(text, request) };
}
export const createCodexSessionSetupConfigurationWriter = () =>
  createSessionSetupConfigurationWriter(
    createCodexSessionSetupConfigurationEditor(),
  );
function editCodexToml(
  text: string,
  request: SessionSetupConfigurationRequest,
): string {
  parseToml(text);
  let updated = text;
  for (const mutation of request.mutations) {
    const selector = request.selectors.find(
      (item) => item.id === mutation.selectorId,
    );
    if (!selector)
      throw new Error(
        "Codex mutation selector is absent from its checked request",
      );
    const path =
      selector.kind === "skill-path"
        ? ["skills", "config"]
        : selector.kind === "plugin-id"
          ? ["plugins", selector.pluginId]
          : selector.kind === "mcp-server-key"
            ? selector.policyOwner.kind === "plugin"
              ? [
                  "plugins",
                  selector.policyOwner.pluginId,
                  "mcp_servers",
                  selector.serverKey,
                ]
              : ["mcp_servers", selector.serverKey]
            : ["apps", selector.connectorId];
    updated = setTomlEnabled(
      updated,
      path,
      mutation.policy === "enabled",
      selector.kind === "skill-path" ? selector.path : null,
    );
  }
  parseToml(updated);
  return updated;
}
function setTomlEnabled(
  text: string,
  path: readonly string[],
  enabled: boolean,
  skillPath: string | null,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const header = `[${path.map((part, index) => (index === 0 ? part : JSON.stringify(part))).join(".")}]`;
  let start = lines.findIndex((line) => line.trim() === header);
  if (skillPath !== null) {
    const existing = lines.findIndex(
      (line, index) =>
        line.trim() === "[[skills.config]]" &&
        lines
          .slice(index + 1)
          .some(
            (candidate) =>
              candidate.trim() === `path = ${JSON.stringify(skillPath)}`,
          ),
    );
    start = existing;
  }
  if (start < 0) {
    const suffix = text.length === 0 || text.endsWith("\n") ? "" : eol;
    const table =
      skillPath === null
        ? `${header}${eol}`
        : `[[skills.config]]${eol}path = ${JSON.stringify(skillPath)}${eol}`;
    return `${text}${suffix}${table}enabled = ${enabled}${eol}`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1)
    if (/^\s*\[/u.test(lines[index]!)) {
      end = index;
      break;
    }
  const matches: number[] = [];
  for (let index = start + 1; index < end; index += 1)
    if (/^\s*enabled\s*=/u.test(lines[index]!)) matches.push(index);
  if (matches.length > 1) throw new Error("Codex enabled setting is ambiguous");
  if (matches.length === 1)
    lines[matches[0]!] = lines[matches[0]!]!.replace(
      /^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?)$/u,
      `$1${enabled}$3`,
    );
  else lines.splice(start + 1, 0, `enabled = ${enabled}`);
  return lines.join(eol);
}
