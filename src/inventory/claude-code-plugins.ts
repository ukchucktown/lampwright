import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  type ParseError,
  parseTree,
  type Node as JsonNode,
} from "jsonc-parser";

import {
  CLAUDE_CODE_EXECUTABLE,
  CLAUDE_CODE_PLUGIN_ADAPTER_ID,
  type ClaudeCodePluginScope,
  claudeCodePluginUninstallArguments,
} from "../adapter/built-ins.js";
import { parseWindowsReparseKind } from "../filesystem/windows-reparse.js";
import { stringifyModel } from "../model/json.js";
import type {
  ArtifactLocation,
  DeclarativeRecordCleanup,
  FindingId,
  Installation,
  InstallationId,
  ManagedRemovalEvidence,
  NonInstallationFinding,
  PluginBoundary,
  PluginResource,
  ProtectionStatus,
  Scope,
  Sha256Digest,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
} from "../model/types.js";
import { hashSkillDirectory } from "./content-hash.js";
import { inspectGitProtection } from "./git-protection.js";
import { stableId } from "./identity.js";
import { readSkillMetadata } from "./metadata.js";
import type {
  InventoryCommandRunner,
  InventoryScanEnvironment,
} from "./types.js";

const registryVersion = 2;
const safeQualifiedUninstallVersion = [2, 1, 212] as const;
const agentId = "claude-code";

interface StableJsonDocument {
  readonly path: string;
  readonly bytes: Buffer;
  readonly value: unknown;
  readonly location: ArtifactLocation;
  readonly protection: ProtectionStatus;
}

type JsonReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly path: string }
  | { readonly kind: "valid"; readonly document: StableJsonDocument };

type RegistryScope = ClaudeCodePluginScope | "managed";

interface RegistryRecord {
  readonly scope: RegistryScope;
  readonly installPath: string;
  readonly version: string | null;
  readonly projectPath: string | null;
  readonly installedAt: string | null;
  readonly lastUpdated: string | null;
  readonly gitCommitSha: string | null;
  readonly raw: Record<string, unknown>;
}

interface RegistryEntry {
  readonly pluginKey: string;
  readonly pluginName: string;
  readonly marketplaceName: string;
  readonly index: number;
  readonly record: RegistryRecord;
  readonly recordPointer: string;
  readonly boundaryId: string;
  readonly duplicate: boolean;
}

interface ManagerProbe {
  readonly available: boolean;
  readonly version: readonly [number, number, number] | null;
}

interface PluginManifest {
  readonly name: string | null;
  readonly description: string | null;
  readonly version: string | null;
  readonly skills: readonly string[];
  readonly components: readonly ManifestComponent[];
  readonly raw: Record<string, unknown> | null;
  readonly invalid: boolean;
}

interface ManifestComponent {
  readonly kind: PluginResource["kind"];
  readonly id: string;
  readonly relativePath: string;
}

interface MaterializedPlugin {
  readonly installations: readonly Installation[];
  readonly boundary: PluginBoundary;
}

export interface ClaudeCodePluginsScanResult {
  readonly installations: readonly Installation[];
  readonly plugins: readonly PluginBoundary[];
  readonly otherFindings: readonly NonInstallationFinding[];
}

export async function scanClaudeCodePlugins(
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner,
): Promise<ClaudeCodePluginsScanResult> {
  const configRoot = claudeConfigRoot(environment);
  const pluginsRoot = join(configRoot, "plugins");
  const cacheRoot = join(pluginsRoot, "cache");
  const registryPath = join(pluginsRoot, "installed_plugins.json");
  const registryResult = await readStableJson(registryPath, commandRunner);
  const registryEntries =
    registryResult.kind === "valid"
      ? parseRegistry(registryResult.document.value, environment)
      : null;
  const allReferencedPaths = new Set(
    (registryEntries ?? []).map((entry) => pathKey(entry.record.installPath)),
  );
  const applicableEntries = (registryEntries ?? []).filter((entry) =>
    appliesToWorkspace(entry.record, environment.workspaceDirectory),
  );
  const installPathUseCount = countInstallPaths(registryEntries ?? []);
  const pluginScopeCount = countPluginScopes(registryEntries ?? []);
  const manager =
    applicableEntries.length === 0
      ? { available: false, version: null }
      : await probeManager(commandRunner);
  const materialized: MaterializedPlugin[] = [];

  if (registryResult.kind === "valid" && registryEntries !== null) {
    for (const entry of applicableEntries) {
      materialized.push(
        await materializePlugin({
          environment,
          commandRunner,
          configRoot,
          cacheRoot,
          registry: registryResult.document,
          entry,
          manager,
          installPathUseCount:
            installPathUseCount.get(pathKey(entry.record.installPath)) ?? 0,
          pluginScopeCount: pluginScopeCount.get(entry.pluginKey) ?? 0,
        }),
      );
    }
  }

  const otherFindings = await scanNonInstallationPluginTrees({
    environment,
    commandRunner,
    configRoot,
    cacheRoot,
    referencedPaths: allReferencedPaths,
  });

  return {
    installations: materialized
      .flatMap((plugin) => plugin.installations)
      .sort(compareInstallation),
    plugins: materialized
      .map((plugin) => plugin.boundary)
      .sort((left, right) => compareText(left.id, right.id)),
    otherFindings: otherFindings.sort((left, right) =>
      compareText(left.location.path, right.location.path),
    ),
  };
}

async function materializePlugin(input: {
  readonly environment: InventoryScanEnvironment;
  readonly commandRunner: InventoryCommandRunner;
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly registry: StableJsonDocument;
  readonly entry: RegistryEntry;
  readonly manager: ManagerProbe;
  readonly installPathUseCount: number;
  readonly pluginScopeCount: number;
}): Promise<MaterializedPlugin> {
  const rootLocation = await artifactLocation(
    input.entry.record.installPath,
    input.commandRunner,
  );
  const pathIssue = await installPathSafetyIssue(
    input.entry,
    input.cacheRoot,
    rootLocation,
  );
  const manifestResult =
    rootLocation === null || isBroken(rootLocation)
      ? ({
          name: null,
          description: null,
          version: null,
          skills: [],
          components: [],
          raw: null,
          invalid: false,
        } satisfies PluginManifest)
      : await readPluginManifest(
          input.entry.record.installPath,
          input.commandRunner,
        );
  const unsafeReason = input.entry.duplicate
    ? "duplicate Claude plugin registry records identify the same scope"
    : (pathIssue ??
      (manifestResult.invalid
        ? "the Claude plugin manifest is invalid or unsafe to read"
        : null));
  const scope = modelScope(input.entry.record, input.environment);
  const skillPaths =
    rootLocation === null || isBroken(rootLocation) || unsafeReason !== null
      ? []
      : await discoverSkillDirectories(
          input.entry.record.installPath,
          manifestResult,
        );
  const installations = await Promise.all(
    skillPaths.map((skillPath) =>
      materializeSkill({
        commandRunner: input.commandRunner,
        entry: input.entry,
        manifest: manifestResult,
        scope,
        pluginRoot: input.entry.record.installPath,
        skillPath,
      }),
    ),
  );
  const registryCleanup = recordCleanup(
    "claude-plugin-registry-record",
    input.registry,
    input.entry.recordPointer,
    input.entry.record.raw,
  );
  const settings = await scopeSettingsEvidence(
    input.environment,
    input.entry,
    input.commandRunner,
  );
  const dataLocation =
    input.pluginScopeCount === 1
      ? await artifactLocation(
          join(
            input.configRoot,
            "plugins",
            "data",
            pluginDataDirectoryName(input.entry.pluginKey),
          ),
          input.commandRunner,
        )
      : null;
  const rootProtection =
    rootLocation === null
      ? await protectionFor(
          absentDirectoryLocation(input.entry.record.installPath),
          input.commandRunner,
          true,
        )
      : await protectionFor(rootLocation, input.commandRunner);
  const managed = await managedRemoval({
    environment: input.environment,
    commandRunner: input.commandRunner,
    entry: input.entry,
    manager: input.manager,
    unsafeReason,
    registry: input.registry,
    settings,
    dataLocation,
  });
  const fallbackReason =
    unsafeReason ??
    (input.entry.record.scope === "managed"
      ? "managed Claude Code plugins are read-only"
      : settings.kind === "invalid"
        ? "the Claude plugin scope settings are invalid or unsafe to read"
        : input.installPathUseCount > 1 && rootLocation !== null
          ? "the Claude plugin cache path is shared by multiple installed scopes"
          : null);
  const cleanups = [
    registryCleanup,
    ...(settings.kind === "present" ? [settings.cleanup] : []),
  ];
  const resources = await pluginResources({
    commandRunner: input.commandRunner,
    entry: input.entry,
    rootLocation,
    rootProtection,
    dataLocation,
    manifest: manifestResult,
    registryCleanup,
    settings,
    declarativeCleanupAvailable: fallbackReason === null,
  });

  return {
    installations,
    boundary: {
      id: input.entry.boundaryId,
      pluginId: input.entry.pluginKey,
      version: input.entry.record.version ?? manifestResult.version,
      adapterId: CLAUDE_CODE_PLUGIN_ADAPTER_ID,
      ownership: {
        kind: "plugin",
        pluginId: input.entry.pluginKey,
        independentlySelectable: false,
        confidence: "declared",
      },
      installationIds: installations.map((installation) => installation.id),
      resources,
      removal: {
        managed,
        fallback:
          fallbackReason === null
            ? { kind: "available", requiresSeparateConfirmation: true }
            : { kind: "unavailable", reason: fallbackReason },
        primaryArtifactPresent: false,
        supplementalArtifacts: [],
        recordCleanups: fallbackReason === null ? cleanups : [],
      },
    },
  };
}

async function materializeSkill(input: {
  readonly commandRunner: InventoryCommandRunner;
  readonly entry: RegistryEntry;
  readonly manifest: PluginManifest;
  readonly scope: Scope;
  readonly pluginRoot: string;
  readonly skillPath: string;
}): Promise<Installation> {
  const location = (await artifactLocation(
    input.skillPath,
    input.commandRunner,
  ))!;
  const protection = await protectionFor(location, input.commandRunner);
  const fallbackName = basename(input.skillPath);
  const metadata = isBroken(location)
    ? null
    : await readSkillMetadata(join(input.skillPath, "SKILL.md"), fallbackName);
  const contentHash =
    location.artifactType.kind === "directory"
      ? await hashSkillDirectory(input.skillPath).catch(() => null)
      : null;
  const skillName = metadata?.skill.name ?? fallbackName;
  const skillId = portableRelativePath(input.pluginRoot, input.skillPath);
  const strongEvidence: StrongIdentityEvidence[] = [
    {
      strength: "strong",
      kind: "plugin",
      pluginId: input.entry.pluginKey,
      skillId,
    },
  ];
  const weakEvidence: WeakIdentityEvidence[] = [
    {
      strength: "weak",
      kind: "name",
      normalizedName: skillName.normalize("NFKC").toLowerCase(),
    },
  ];
  if (contentHash !== null) {
    weakEvidence.push({
      strength: "weak",
      kind: "content-hash",
      algorithm: "sha256",
      digest: contentHash,
    });
  }

  return {
    id: stableId(
      "installation",
      CLAUDE_CODE_PLUGIN_ADAPTER_ID,
      input.entry.boundaryId,
      skillId,
    ) as InstallationId,
    classification: "managed-plugin-resource",
    status: isBroken(location) ? "broken" : (metadata?.status ?? "unresolved"),
    skill: metadata?.skill ?? { name: skillName, description: null },
    identity: { strongEvidence, weakEvidence },
    source: { id: input.entry.pluginKey, url: null },
    plugin: {
      id: input.entry.pluginKey,
      version: input.entry.record.version ?? input.manifest.version,
    },
    manager: null,
    adapterId: CLAUDE_CODE_PLUGIN_ADAPTER_ID,
    pluginBoundaryId: input.entry.boundaryId,
    agentId,
    scope: input.scope,
    location,
    contentHash,
    modifiedAt: await modificationTime(input.skillPath),
    ownership: {
      kind: "plugin",
      pluginId: input.entry.pluginKey,
      independentlySelectable: false,
      confidence: "declared",
    },
    protection,
    removal: {
      managed: null,
      fallback: {
        kind: "unavailable",
        reason: "Claude Code plugins do not support child skill uninstall",
      },
      primaryArtifactPresent: false,
      supplementalArtifacts: [],
      recordCleanups: [],
    },
    tags: ["claude-code", "plugin", input.entry.record.scope],
    metadata: {
      ...(metadata?.metadata ?? {}),
      "claude-code-plugin": {
        pluginId: input.entry.pluginKey,
        pluginName: input.entry.pluginName,
        marketplace: input.entry.marketplaceName,
        scope: input.entry.record.scope,
        projectPath: input.entry.record.projectPath,
        skillId,
        independentlySelectable: false,
        installedAt: input.entry.record.installedAt,
        lastUpdated: input.entry.record.lastUpdated,
        gitCommitSha: input.entry.record.gitCommitSha,
        manifest: {
          name: input.manifest.name,
          description: input.manifest.description,
          version: input.manifest.version,
        },
      },
    },
  };
}

async function managedRemoval(input: {
  readonly environment: InventoryScanEnvironment;
  readonly commandRunner: InventoryCommandRunner;
  readonly entry: RegistryEntry;
  readonly manager: ManagerProbe;
  readonly unsafeReason: string | null;
  readonly registry: StableJsonDocument;
  readonly settings: ScopeSettingsEvidence;
  readonly dataLocation: ArtifactLocation | null;
}): Promise<ManagedRemovalEvidence | null> {
  if (input.entry.record.scope === "managed") return null;
  const scope = input.entry.record.scope;
  const unavailableReason =
    input.unsafeReason ??
    (!input.manager.available
      ? "the Claude Code executable is not available"
      : input.manager.version === null
        ? "the installed Claude Code version could not be verified"
        : compareVersion(input.manager.version, safeQualifiedUninstallVersion) <
            0
          ? "Claude Code 2.1.212 or newer is required for exact marketplace-qualified uninstall"
          : null);
  const settingsPath = settingsPathFor(input.environment, input.entry.record);
  const settingsProtection =
    input.settings.kind === "present"
      ? input.settings.document.protection
      : await protectionFor(
          absentFileLocation(settingsPath),
          input.commandRunner,
          true,
        );
  const effects = [
    {
      kind: "modify-path" as const,
      path: input.registry.path,
      protection: input.registry.protection,
    },
    {
      kind: "modify-path" as const,
      path: settingsPath,
      protection: settingsProtection,
    },
    ...(input.dataLocation === null
      ? []
      : [
          {
            kind: "remove-path" as const,
            path: input.dataLocation.path,
            protection: await protectionFor(
              input.dataLocation,
              input.commandRunner,
            ),
          },
        ]),
  ];
  const workingDirectory =
    scope === "user"
      ? ({ kind: "isolated-temporary" } as const)
      : ({
          kind: "exact",
          path:
            input.entry.record.projectPath ??
            input.environment.workspaceDirectory,
        } as const);

  return {
    adapterId: CLAUDE_CODE_PLUGIN_ADAPTER_ID,
    operationId: `uninstall-${scope}-plugin`,
    availability:
      unavailableReason === null
        ? { kind: "available" }
        : { kind: "unavailable", reason: unavailableReason },
    trust: { kind: "trusted" },
    externalId: input.entry.pluginKey,
    invocation: {
      kind: "direct",
      command: {
        executable: CLAUDE_CODE_EXECUTABLE,
        arguments: claudeCodePluginUninstallArguments(
          scope,
          input.entry.pluginKey,
        ),
      },
      workingDirectory,
    },
    effects,
    verifications: [
      {
        kind: "record-absent",
        path: input.registry.path,
        format: "json",
        recordPointer: input.entry.recordPointer,
      },
      ...(input.settings.kind === "present"
        ? [
            {
              kind: "record-absent" as const,
              path: input.settings.document.path,
              format: "json" as const,
              recordPointer: input.settings.recordPointer,
            },
          ]
        : []),
    ],
  };
}

type ScopeSettingsEvidence =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "present";
      readonly document: StableJsonDocument;
      readonly recordPointer: string;
      readonly cleanup: DeclarativeRecordCleanup;
    };

async function scopeSettingsEvidence(
  environment: InventoryScanEnvironment,
  entry: RegistryEntry,
  commandRunner: InventoryCommandRunner,
): Promise<ScopeSettingsEvidence> {
  if (entry.record.scope === "managed") return { kind: "absent" };
  const path = settingsPathFor(environment, entry.record);
  const result = await readStableJson(path, commandRunner);
  if (result.kind !== "valid") return result;
  if (!isRecord(result.document.value)) return { kind: "invalid" };
  const enabled = result.document.value.enabledPlugins;
  if (enabled === undefined) return { kind: "absent" };
  if (!isRecord(enabled)) return { kind: "invalid" };
  if (!Object.hasOwn(enabled, entry.pluginKey)) {
    return { kind: "absent" };
  }
  const recordPointer = `/enabledPlugins/${escapePointer(entry.pluginKey)}`;
  return {
    kind: "present",
    document: result.document,
    recordPointer,
    cleanup: recordCleanup(
      "claude-plugin-settings-record",
      result.document,
      recordPointer,
      enabled[entry.pluginKey],
    ),
  };
}

function settingsPathFor(
  environment: InventoryScanEnvironment,
  record: RegistryRecord,
): string {
  const configRoot = claudeConfigRoot(environment);
  if (record.scope === "user" || record.scope === "managed") {
    return join(configRoot, "settings.json");
  }
  const workspace = record.projectPath ?? environment.workspaceDirectory;
  return join(
    workspace,
    ".claude",
    record.scope === "local" ? "settings.local.json" : "settings.json",
  );
}

async function pluginResources(input: {
  readonly commandRunner: InventoryCommandRunner;
  readonly entry: RegistryEntry;
  readonly rootLocation: ArtifactLocation | null;
  readonly rootProtection: ProtectionStatus;
  readonly dataLocation: ArtifactLocation | null;
  readonly manifest: PluginManifest;
  readonly registryCleanup: DeclarativeRecordCleanup;
  readonly settings: ScopeSettingsEvidence;
  readonly declarativeCleanupAvailable: boolean;
}): Promise<readonly PluginResource[]> {
  const resources: PluginResource[] = [
    {
      kind: "configuration",
      id: "installed-registry-record",
      location: null,
      protection: null,
      cleanupId: input.declarativeCleanupAvailable
        ? input.registryCleanup.id
        : null,
    },
  ];
  if (input.settings.kind === "present") {
    resources.push({
      kind: "configuration",
      id: "scope-settings-record",
      location: null,
      protection: null,
      cleanupId: input.declarativeCleanupAvailable
        ? input.settings.cleanup.id
        : null,
    });
  }
  if (input.rootLocation !== null) {
    resources.push({
      kind: "other",
      id: "installed-plugin-root",
      location: input.rootLocation,
      protection: input.rootProtection,
      cleanupId: null,
    });
    const defaultComponents: readonly ManifestComponent[] = [
      { kind: "command", id: "commands", relativePath: "commands" },
      { kind: "agent", id: "agents", relativePath: "agents" },
      { kind: "hook", id: "hooks", relativePath: "hooks" },
      { kind: "configuration", id: "settings", relativePath: "settings.json" },
      { kind: "configuration", id: "mcp-servers", relativePath: ".mcp.json" },
      { kind: "configuration", id: "lsp-servers", relativePath: ".lsp.json" },
      { kind: "other", id: "workflows", relativePath: "workflows" },
      { kind: "other", id: "output-styles", relativePath: "output-styles" },
      { kind: "other", id: "monitors", relativePath: "monitors" },
      { kind: "other", id: "executables", relativePath: "bin" },
    ];
    const componentPaths = new Set<string>();
    for (const component of [
      ...defaultComponents,
      ...input.manifest.components,
    ]) {
      const componentPath = safeManifestPath(
        input.entry.record.installPath,
        component.relativePath === "." ||
          component.relativePath.startsWith("./") ||
          component.relativePath.startsWith(`.${sep}`)
          ? component.relativePath
          : `./${component.relativePath}`,
      );
      if (componentPath === null) continue;
      const componentKey = pathKey(componentPath);
      if (componentPaths.has(componentKey)) continue;
      componentPaths.add(componentKey);
      const location = await artifactLocation(
        componentPath,
        input.commandRunner,
        true,
      );
      if (location === null) continue;
      resources.push({
        kind: component.kind,
        id: component.id,
        location,
        protection: await protectionFor(location, input.commandRunner),
        cleanupId: null,
      });
    }
  }
  if (input.dataLocation !== null) {
    resources.push({
      kind: "configuration",
      id: "persistent-data",
      location: input.dataLocation,
      protection: await protectionFor(input.dataLocation, input.commandRunner),
      cleanupId: null,
    });
  }
  return resources.sort((left, right) => compareText(left.id, right.id));
}

async function discoverSkillDirectories(
  pluginRoot: string,
  manifest: PluginManifest,
): Promise<readonly string[]> {
  const roots = new Map<string, string>();
  const defaultRoot = join(pluginRoot, "skills");
  roots.set(pathKey(defaultRoot), defaultRoot);
  for (const configured of manifest.skills) {
    const resolvedPath = safeManifestPath(pluginRoot, configured);
    if (resolvedPath !== null) roots.set(pathKey(resolvedPath), resolvedPath);
  }
  if (manifest.skills.length === 0) {
    const rootSkill = join(pluginRoot, "SKILL.md");
    if ((await lstat(rootSkill).catch(() => null))?.isFile() === true) {
      roots.set(pathKey(pluginRoot), pluginRoot);
    }
  }
  const skills = new Map<string, string>();
  for (const root of roots.values()) {
    const rootStats = await lstat(root).catch(() => null);
    if (rootStats === null) continue;
    const directSkill = await lstat(join(root, "SKILL.md")).catch(() => null);
    if (directSkill?.isFile() === true) {
      skills.set(pathKey(root), root);
      continue;
    }
    if (!rootStats.isDirectory()) continue;
    const children = await readdir(root, { withFileTypes: true }).catch(
      () => [],
    );
    for (const child of children) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      const childPath = join(root, child.name);
      if (
        (await lstat(join(childPath, "SKILL.md")).catch(() => null)) !== null
      ) {
        skills.set(pathKey(childPath), childPath);
      }
    }
  }
  return [...skills.values()].sort(compareText);
}

async function readPluginManifest(
  pluginRoot: string,
  commandRunner: InventoryCommandRunner,
): Promise<PluginManifest> {
  const result = await readStableJson(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    commandRunner,
  );
  if (result.kind === "absent") {
    return {
      name: null,
      description: null,
      version: null,
      skills: [],
      components: [],
      raw: null,
      invalid: false,
    };
  }
  if (result.kind === "invalid" || !isRecord(result.document.value)) {
    return {
      name: null,
      description: null,
      version: null,
      skills: [],
      components: [],
      raw: null,
      invalid: true,
    };
  }
  const value = result.document.value;
  const name = optionalString(value.name);
  if (name === null) {
    return {
      name: null,
      description: null,
      version: null,
      skills: [],
      components: [],
      raw: value,
      invalid: true,
    };
  }
  const skills = stringList(value.skills);
  const components = parseManifestComponents(pluginRoot, value);
  if (
    skills === null ||
    skills.some(
      (skillPath) => safeManifestPath(pluginRoot, skillPath) === null,
    ) ||
    components === null
  ) {
    return {
      name,
      description: optionalString(value.description),
      version: optionalString(value.version),
      skills: [],
      components: [],
      raw: value,
      invalid: true,
    };
  }
  return {
    name,
    description: optionalString(value.description),
    version: optionalString(value.version),
    skills,
    components,
    raw: value,
    invalid: false,
  };
}

function parseManifestComponents(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): readonly ManifestComponent[] | null {
  const fields = [
    ["commands", "command", "manifest-commands"],
    ["agents", "agent", "manifest-agents"],
    ["hooks", "hook", "manifest-hooks"],
    ["mcpServers", "configuration", "manifest-mcp-servers"],
    ["lspServers", "configuration", "manifest-lsp-servers"],
    ["outputStyles", "other", "manifest-output-styles"],
  ] as const;
  const components: ManifestComponent[] = [];
  for (const [field, kind, id] of fields) {
    const paths = stringList(manifest[field]);
    if (paths === null) return null;
    for (const [index, relativePath] of paths.entries()) {
      if (safeManifestPath(pluginRoot, relativePath) === null) return null;
      components.push({
        kind,
        id: paths.length === 1 ? id : `${id}-${String(index + 1)}`,
        relativePath,
      });
    }
  }
  return components;
}

function parseRegistry(
  value: unknown,
  environment: InventoryScanEnvironment,
): readonly RegistryEntry[] | null {
  if (
    !isRecord(value) ||
    value.version !== registryVersion ||
    !isRecord(value.plugins)
  ) {
    return null;
  }
  const entries: Omit<RegistryEntry, "duplicate">[] = [];
  for (const [pluginKey, records] of Object.entries(value.plugins).sort(
    ([left], [right]) => compareText(left, right),
  )) {
    const parsedKey = parsePluginKey(pluginKey);
    if (parsedKey === null || !Array.isArray(records)) return null;
    for (const [index, raw] of records.entries()) {
      if (!isRecord(raw)) return null;
      const scope = registryScope(raw.scope);
      const installPath = optionalString(raw.installPath);
      const projectPath = optionalString(raw.projectPath);
      if (
        scope === null ||
        installPath === null ||
        !isAbsolute(installPath) ||
        ((scope === "project" || scope === "local") &&
          (projectPath === null || !isAbsolute(projectPath)))
      ) {
        return null;
      }
      const record: RegistryRecord = {
        scope,
        installPath: resolve(installPath),
        version: optionalString(raw.version),
        projectPath: projectPath === null ? null : resolve(projectPath),
        installedAt: optionalString(raw.installedAt),
        lastUpdated: optionalString(raw.lastUpdated),
        gitCommitSha: optionalString(raw.gitCommitSha),
        raw,
      };
      entries.push({
        pluginKey,
        ...parsedKey,
        index,
        record,
        recordPointer: `/plugins/${escapePointer(pluginKey)}/${String(index)}`,
        boundaryId: boundaryId(pluginKey, record, environment),
      });
    }
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = recordIdentity(entry.pluginKey, entry.record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.map((entry) => ({
    ...entry,
    duplicate:
      (counts.get(recordIdentity(entry.pluginKey, entry.record)) ?? 0) > 1,
  }));
}

function appliesToWorkspace(
  record: RegistryRecord,
  workspaceDirectory: string,
): boolean {
  return (
    record.scope === "user" ||
    record.scope === "managed" ||
    (record.projectPath !== null &&
      pathKey(record.projectPath) === pathKey(workspaceDirectory))
  );
}

function modelScope(
  record: RegistryRecord,
  environment: InventoryScanEnvironment,
): Scope {
  return record.scope === "user" || record.scope === "managed"
    ? { kind: "user" }
    : {
        kind: "workspace",
        workspacePath: record.projectPath ?? environment.workspaceDirectory,
      };
}

function boundaryId(
  pluginKey: string,
  record: RegistryRecord,
  environment: InventoryScanEnvironment,
): string {
  return stableId(
    "plugin-boundary",
    CLAUDE_CODE_PLUGIN_ADAPTER_ID,
    pluginKey,
    record.scope,
    record.projectPath ?? environment.homeDirectory,
    pathKey(record.installPath),
  );
}

function recordIdentity(pluginKey: string, record: RegistryRecord): string {
  return stringifyModel([pluginKey, record.scope, record.projectPath ?? ""], 0);
}

function countInstallPaths(
  entries: readonly RegistryEntry[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) {
    const key = pathKey(entry.record.installPath);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function countPluginScopes(
  entries: readonly RegistryEntry[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) {
    result.set(entry.pluginKey, (result.get(entry.pluginKey) ?? 0) + 1);
  }
  return result;
}

async function installPathSafetyIssue(
  entry: RegistryEntry,
  cacheRoot: string,
  location: ArtifactLocation | null,
): Promise<string | null> {
  if (!pathIsWithin(cacheRoot, entry.record.installPath)) {
    return "the Claude plugin install path is outside the configured cache";
  }
  const expectedParent = join(
    cacheRoot,
    entry.marketplaceName,
    entry.pluginName,
  );
  if (!pathIsWithin(expectedParent, entry.record.installPath)) {
    return "the Claude plugin install path does not match its qualified plugin ID";
  }
  if (location === null) {
    const pathStats = await lstat(entry.record.installPath).catch(() => null);
    if (
      pathStats !== null &&
      !pathStats.isDirectory() &&
      !pathStats.isSymbolicLink()
    ) {
      return "the Claude plugin install path is not a directory or directory link";
    }
  }
  if (
    location?.canonicalPath !== null &&
    location?.canonicalPath !== undefined
  ) {
    const canonicalCache = await realpath(cacheRoot).catch(() => null);
    if (
      canonicalCache !== null &&
      !pathIsWithin(canonicalCache, location.canonicalPath)
    ) {
      return "the Claude plugin install path resolves outside its cache";
    }
  }
  return null;
}

async function probeManager(
  commandRunner: InventoryCommandRunner,
): Promise<ManagerProbe> {
  try {
    const result = await commandRunner.run({
      executable: CLAUDE_CODE_EXECUTABLE,
      arguments: ["--version"],
    });
    return {
      available: result.exitCode === 0,
      version: result.exitCode === 0 ? parseVersion(result.stdout) : null,
    };
  } catch {
    return { available: false, version: null };
  }
}

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

async function scanNonInstallationPluginTrees(input: {
  readonly environment: InventoryScanEnvironment;
  readonly commandRunner: InventoryCommandRunner;
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly referencedPaths: ReadonlySet<string>;
}): Promise<NonInstallationFinding[]> {
  const findings: NonInstallationFinding[] = [];
  const cacheMarketplaces = await readdir(input.cacheRoot, {
    withFileTypes: true,
  }).catch(() => []);
  for (const marketplace of cacheMarketplaces) {
    if (!marketplace.isDirectory()) continue;
    const marketplacePath = join(input.cacheRoot, marketplace.name);
    const plugins = await readdir(marketplacePath, {
      withFileTypes: true,
    }).catch(() => []);
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginPath = join(marketplacePath, plugin.name);
      const versions = await readdir(pluginPath, {
        withFileTypes: true,
      }).catch(() => []);
      for (const version of versions) {
        if (!version.isDirectory()) continue;
        const versionPath = join(pluginPath, version.name);
        if (input.referencedPaths.has(pathKey(versionPath))) continue;
        findings.push(
          ...(await sourceSkillFindings({
            pluginRoot: versionPath,
            classification: "cache-or-vendor-artifact",
            sourceId: `${plugin.name}@${marketplace.name}`,
            scope: { kind: "user" },
            commandRunner: input.commandRunner,
          })),
        );
      }
    }
  }
  findings.push(
    ...(await sourceSkillFindings({
      pluginRoot: input.environment.workspaceDirectory,
      classification: "source-artifact",
      sourceId: `workspace:${input.environment.workspaceDirectory}`,
      scope: {
        kind: "workspace",
        workspacePath: input.environment.workspaceDirectory,
      },
      commandRunner: input.commandRunner,
      requireManifest: true,
    })),
  );
  findings.push(
    ...(await marketplaceSourceFindings({
      marketplacesRoot: join(input.configRoot, "plugins", "marketplaces"),
      commandRunner: input.commandRunner,
    })),
  );
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.classification}:${pathKey(finding.location.path)}`,
        finding,
      ]),
    ).values(),
  ];
}

async function marketplaceSourceFindings(input: {
  readonly marketplacesRoot: string;
  readonly commandRunner: InventoryCommandRunner;
}): Promise<NonInstallationFinding[]> {
  const findings: NonInstallationFinding[] = [];
  const marketplaces = await readdir(input.marketplacesRoot, {
    withFileTypes: true,
  }).catch(() => []);
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory() && !marketplace.isSymbolicLink()) continue;
    const marketplaceRoot = join(input.marketplacesRoot, marketplace.name);
    const manifestResult = await readStableJson(
      join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
      input.commandRunner,
    );
    if (
      manifestResult.kind !== "valid" ||
      !isRecord(manifestResult.document.value) ||
      !Array.isArray(manifestResult.document.value.plugins)
    ) {
      continue;
    }
    for (const plugin of manifestResult.document.value.plugins) {
      if (!isRecord(plugin)) continue;
      const pluginName = optionalString(plugin.name);
      const sourcePath = optionalString(plugin.source);
      if (pluginName === null || sourcePath === null) continue;
      const pluginRoot = safeManifestPath(marketplaceRoot, sourcePath);
      if (pluginRoot === null) continue;
      findings.push(
        ...(await sourceSkillFindings({
          pluginRoot,
          classification: "source-artifact",
          sourceId: `${pluginName}@${marketplace.name}`,
          scope: { kind: "user" },
          commandRunner: input.commandRunner,
          requireManifest: true,
        })),
      );
    }
  }
  return findings;
}

async function sourceSkillFindings(input: {
  readonly pluginRoot: string;
  readonly classification: "source-artifact" | "cache-or-vendor-artifact";
  readonly sourceId: string;
  readonly scope: Scope;
  readonly commandRunner: InventoryCommandRunner;
  readonly requireManifest?: boolean;
}): Promise<NonInstallationFinding[]> {
  const manifest = await readPluginManifest(
    input.pluginRoot,
    input.commandRunner,
  );
  if (
    manifest.invalid ||
    (input.requireManifest === true && manifest.raw === null)
  ) {
    return [];
  }
  const skillPaths = await discoverSkillDirectories(input.pluginRoot, manifest);
  const findings: NonInstallationFinding[] = [];
  for (const skillPath of skillPaths) {
    const location = await artifactLocation(skillPath, input.commandRunner);
    if (location === null) continue;
    const name = basename(skillPath);
    const metadata = isBroken(location)
      ? null
      : await readSkillMetadata(join(skillPath, "SKILL.md"), name);
    const protection = await protectionFor(location, input.commandRunner);
    findings.push({
      id: stableId(
        "finding",
        CLAUDE_CODE_PLUGIN_ADAPTER_ID,
        input.classification,
        pathKey(skillPath),
      ) as FindingId,
      classification: input.classification,
      skill: metadata?.skill ?? { name, description: null },
      identity: {
        strongEvidence: [],
        weakEvidence: [
          {
            strength: "weak",
            kind: "name",
            normalizedName: (metadata?.skill.name ?? name)
              .normalize("NFKC")
              .toLowerCase(),
          },
        ],
      },
      source: { id: input.sourceId, url: null },
      plugin: null,
      manager: null,
      adapterId: CLAUDE_CODE_PLUGIN_ADAPTER_ID,
      agentId,
      scope: input.scope,
      location,
      contentHash: null,
      modifiedAt: await modificationTime(skillPath),
      ownership: { kind: "unknown", confidence: "unknown" },
      protection,
      tags: ["claude-code", "plugin", input.classification],
      metadata: {
        "claude-code-plugin": {
          state: input.classification,
          sourceRoot: input.pluginRoot,
        },
      },
    });
  }
  return findings;
}

async function readStableJson(
  path: string,
  commandRunner: InventoryCommandRunner,
): Promise<JsonReadResult> {
  const initialStats = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (initialStats === null) return { kind: "absent" };
  const file = await readStableRegularFile(path, initialStats);
  if (file === null) return { kind: "invalid", path };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return { kind: "invalid", path };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", path };
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (tree === undefined || errors.length > 0 || hasDuplicateKeys(tree)) {
    return { kind: "invalid", path };
  }
  const location: ArtifactLocation = {
    path,
    canonicalPath: file.canonicalPath,
    artifactType: { kind: "file" },
  };
  return {
    kind: "valid",
    document: {
      path,
      bytes: file.bytes,
      value,
      location,
      protection: await protectionFor(location, commandRunner),
    },
  };
}

async function readStableRegularFile(
  path: string,
  initialStats: Stats,
): Promise<{ readonly bytes: Buffer; readonly canonicalPath: string } | null> {
  if (
    !initialStats.isFile() ||
    initialStats.isSymbolicLink() ||
    initialStats.nlink !== 1
  ) {
    return null;
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (handle === null) return null;
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.nlink !== 1 ||
      !sameFile(initialStats, openedStats)
    ) {
      return null;
    }
    const bytes = await handle.readFile();
    const finalStats = await handle.stat();
    const pathStats = await lstat(path).catch(() => null);
    const canonicalPath = await realpath(path).catch(() => null);
    const confirmedStats = await lstat(path).catch(() => null);
    if (
      pathStats === null ||
      confirmedStats === null ||
      canonicalPath === null ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.nlink !== 1 ||
      !sameFile(openedStats, finalStats) ||
      !sameFile(finalStats, pathStats) ||
      !sameFile(pathStats, confirmedStats) ||
      openedStats.size !== finalStats.size ||
      openedStats.mtimeMs !== finalStats.mtimeMs ||
      openedStats.ctimeMs !== finalStats.ctimeMs
    ) {
      return null;
    }
    return { bytes, canonicalPath };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function artifactLocation(
  path: string,
  commandRunner: InventoryCommandRunner,
  allowFile = false,
): Promise<ArtifactLocation | null> {
  const pathStats = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (pathStats === null) return null;
  if (pathStats.isSymbolicLink()) {
    const target = await readlink(path);
    const followed = await stat(path).catch(() => null);
    const kind = await linkArtifactType(path, commandRunner);
    return {
      path,
      canonicalPath: followed === null ? null : await realpath(path),
      artifactType: {
        kind,
        target,
        broken: followed === null,
      },
    };
  }
  if (pathStats.isDirectory()) {
    return {
      path,
      canonicalPath: await realpath(path),
      artifactType: { kind: "directory" },
    };
  }
  if (allowFile && pathStats.isFile()) {
    return {
      path,
      canonicalPath: await realpath(path),
      artifactType: { kind: "file" },
    };
  }
  return null;
}

async function linkArtifactType(
  path: string,
  commandRunner: InventoryCommandRunner,
): Promise<"symbolic-link" | "junction"> {
  if (process.platform !== "win32") return "symbolic-link";
  const result = await commandRunner.run({
    executable: "fsutil",
    arguments: ["reparsepoint", "query", path],
  });
  return result.exitCode === 0
    ? (parseWindowsReparseKind(result.stdout) ?? "symbolic-link")
    : "symbolic-link";
}

async function protectionFor(
  location: ArtifactLocation,
  commandRunner: InventoryCommandRunner,
  absent = false,
): Promise<ProtectionStatus> {
  const writablePath =
    absent || isBroken(location)
      ? await nearestExistingAncestor(dirname(location.path))
      : location.path;
  const filesystem = await access(writablePath, constants.W_OK)
    .then(() => ({ kind: "writable" as const }))
    .catch(() => ({
      kind: "read-only" as const,
      reason: "filesystem denied write access",
    }));
  return {
    git: await inspectGitProtection(
      location.path,
      location.artifactType.kind === "directory",
      commandRunner,
    ),
    system: { kind: "none" },
    filesystem,
  };
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error: unknown) {
      if (!isMissing(error)) return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

function recordCleanup(
  namespace: string,
  document: StableJsonDocument,
  recordPointer: string,
  record: unknown,
): DeclarativeRecordCleanup {
  return {
    id: stableId(namespace, pathKey(document.path), recordPointer),
    location: document.location,
    adapterId: CLAUDE_CODE_PLUGIN_ADAPTER_ID,
    format: "json",
    recordPointer,
    expectedFileHash: digest(document.bytes),
    expectedRecordHash: digest(Buffer.from(stringifyModel(record, 0), "utf8")),
    protection: document.protection,
  };
}

function absentDirectoryLocation(path: string): ArtifactLocation {
  return {
    path,
    canonicalPath: null,
    artifactType: { kind: "directory" },
  };
}

function absentFileLocation(path: string): ArtifactLocation {
  return { path, canonicalPath: null, artifactType: { kind: "file" } };
}

function claudeConfigRoot(environment: InventoryScanEnvironment): string {
  return resolve(
    environment.agentHomeDirectories?.[agentId] ??
      join(environment.homeDirectory, ".claude"),
  );
}

function pluginDataDirectoryName(pluginKey: string): string {
  return pluginKey.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function safeManifestPath(pluginRoot: string, value: string): string | null {
  if (
    value !== "." &&
    value !== "./" &&
    !value.startsWith(`.${sep}`) &&
    !value.startsWith("./")
  ) {
    return null;
  }
  const candidate = resolve(pluginRoot, value);
  return pathIsWithin(pluginRoot, candidate) ? candidate : null;
}

function parsePluginKey(
  pluginKey: string,
): { readonly pluginName: string; readonly marketplaceName: string } | null {
  const separator = pluginKey.lastIndexOf("@");
  const pluginName = pluginKey.slice(0, separator);
  const marketplaceName = pluginKey.slice(separator + 1);
  const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (
    separator <= 0 ||
    separator === pluginKey.length - 1 ||
    !safeName.test(pluginName) ||
    !safeName.test(marketplaceName)
  ) {
    return null;
  }
  return { pluginName, marketplaceName };
}

function registryScope(value: unknown): RegistryScope | null {
  return value === "user" ||
    value === "project" ||
    value === "local" ||
    value === "managed"
    ? value
    : null;
}

function stringList(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  return [...new Set(value as string[])].sort(compareText);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDuplicateKeys(node: JsonNode): boolean {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string" || seen.has(key)) return true;
      seen.add(key);
    }
  }
  return (node.children ?? []).some(hasDuplicateKeys);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function digest(bytes: Buffer): Sha256Digest {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function portableRelativePath(rootPath: string, artifactPath: string): string {
  return relative(rootPath, artifactPath).split(sep).join("/");
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isBroken(location: ArtifactLocation): boolean {
  return (
    (location.artifactType.kind === "symbolic-link" ||
      location.artifactType.kind === "junction") &&
    location.artifactType.broken
  );
}

async function modificationTime(path: string): Promise<string | null> {
  const stats = await lstat(path).catch(() => null);
  return stats === null || !Number.isFinite(stats.mtimeMs)
    ? null
    : stats.mtime.toISOString();
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { readonly code?: unknown }).code === "ENOENT" ||
      (error as { readonly code?: unknown }).code === "ENOTDIR")
  );
}

function compareInstallation(left: Installation, right: Installation): number {
  return compareText(left.location.path, right.location.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
