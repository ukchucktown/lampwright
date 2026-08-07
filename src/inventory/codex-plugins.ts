import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
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

import { type ParseError, parseTree } from "jsonc-parser";

import {
  CODEX_EXECUTABLE,
  CODEX_PLUGIN_ADAPTER_ID,
  codexPluginRemoveArguments,
} from "../adapter/built-ins.js";
import { parseWindowsReparseKind } from "../filesystem/windows-reparse.js";
import type {
  ArtifactLocation,
  FindingId,
  Installation,
  InstallationId,
  ManagedRemovalEvidence,
  NonInstallationFinding,
  PluginBoundary,
  PluginResource,
  ProtectionStatus,
  Scope,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
} from "../model/types.js";
import { hashSkillDirectory } from "./content-hash.js";
import {
  hasDuplicateKeys,
  pathKey,
  readStableRegularFile,
} from "./evidence.js";
import { inspectGitProtection } from "./git-protection.js";
import { stableId } from "./identity.js";
import { readSkillMetadata } from "./metadata.js";
import type {
  InventoryCommandRunner,
  InventoryScanEnvironment,
} from "./types.js";

const agentId = "codex";
const safeMarketplaceName = /^[A-Za-z0-9_-]+$/;
const safeVersion = /^[A-Za-z0-9._+-]+$/;
const agentPluginSchema =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const agentPluginSchemaPrefix = "https://agent-plugins.org/schemas/";
const manifestPaths = [
  [".codex-plugin", "plugin.json"],
  [".claude-plugin", "plugin.json"],
  [".cursor-plugin", "plugin.json"],
] as const;

interface CodexPluginEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly marketplaceName: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly source: PluginSource;
  /** Where the marketplace supplying this Plugin lives, when Codex reports it. */
  readonly marketplaceSource: string | null;
}

type PluginSource =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "non-local" };

interface StableJsonDocument {
  readonly path: string;
  readonly location: ArtifactLocation;
  readonly protection: ProtectionStatus;
  readonly value: Record<string, unknown>;
}

interface ManifestComponent {
  readonly kind: PluginResource["kind"];
  readonly id: string;
  readonly relativePath: string | null;
}

interface PluginManifest {
  readonly format: "legacy" | "agent";
  readonly name: string | null;
  readonly description: string | null;
  readonly version: string | null;
  readonly skillRoots: readonly string[];
  readonly components: readonly ManifestComponent[];
  readonly document: StableJsonDocument | null;
  readonly overlayDocument: StableJsonDocument | null;
  readonly invalid: boolean;
}

interface LocatedSkill {
  readonly path: string;
  readonly location: ArtifactLocation;
}

type ListState =
  | { readonly kind: "valid"; readonly entries: readonly CodexPluginEntry[] }
  | { readonly kind: "manager-unavailable" | "invalid-output" };

export interface CodexPluginsScanResult {
  readonly installations: readonly Installation[];
  readonly plugins: readonly PluginBoundary[];
  readonly otherFindings: readonly NonInstallationFinding[];
}

export async function scanCodexPlugins(
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner,
): Promise<CodexPluginsScanResult> {
  const home = codexHome(environment);
  const cacheRoot = join(home, "plugins", "cache");
  const runtimeMarketplaceRoots = codexRuntimeMarketplaceRoots(environment);
  const listState = await listInstalledPlugins(home, commandRunner);
  const materialized =
    listState.kind === "valid"
      ? await Promise.all(
          listState.entries.map((entry) =>
            materializePlugin({
              environment,
              commandRunner,
              home,
              cacheRoot,
              entry,
              runtimeDefault: isRuntimeMarketplace(
                entry.marketplaceSource,
                runtimeMarketplaceRoots,
              ),
            }),
          ),
        )
      : [];
  const installedKeys = new Set(
    listState.kind === "valid"
      ? listState.entries.map((entry) => entry.pluginId)
      : [],
  );
  const cacheFindings = await scanUnownedCaches({
    cacheRoot,
    commandRunner,
    installedKeys,
    state: listState.kind,
  });

  return {
    installations: materialized
      .flatMap((plugin) => plugin.installations)
      .sort(compareInstallation),
    plugins: materialized
      .map((plugin) => plugin.boundary)
      .sort((left, right) => compareText(left.id, right.id)),
    otherFindings: [
      ...new Map(
        [
          ...materialized.flatMap((plugin) => plugin.otherFindings),
          ...cacheFindings,
        ].map((finding) => [finding.id, finding]),
      ).values(),
    ].sort((left, right) =>
      compareText(left.location.path, right.location.path),
    ),
  };
}

async function listInstalledPlugins(
  home: string,
  commandRunner: InventoryCommandRunner,
): Promise<ListState> {
  let result;
  try {
    result = await commandRunner.run({
      executable: CODEX_EXECUTABLE,
      arguments: ["plugin", "list", "--json"],
      environment: {
        CODEX_HOME: home,
        TMPDIR: home,
        TMP: home,
        TEMP: home,
        DO_NOT_TRACK: "1",
        DISABLE_TELEMETRY: "1",
      },
    });
  } catch {
    return { kind: "manager-unavailable" };
  }
  if (result.exitCode !== 0) return { kind: "manager-unavailable" };
  const entries = parseListOutput(result.stdout);
  return entries === null
    ? { kind: "invalid-output" }
    : { kind: "valid", entries };
}

function parseListOutput(stdout: string): readonly CodexPluginEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const tree = parseTree(stdout, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (
    tree === undefined ||
    errors.length > 0 ||
    hasDuplicateKeys(tree) ||
    !isRecord(value) ||
    !hasExactKeys(value, ["installed", "available"]) ||
    !Array.isArray(value.installed) ||
    !Array.isArray(value.available)
  ) {
    return null;
  }
  const entries: CodexPluginEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.installed) {
    const parsed = parseListEntry(raw);
    if (parsed === null || seen.has(parsed.pluginId)) return null;
    seen.add(parsed.pluginId);
    entries.push(parsed);
  }
  return entries.sort((left, right) =>
    compareText(left.pluginId, right.pluginId),
  );
}

function parseListEntry(value: unknown): CodexPluginEntry | null {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, [
      "pluginId",
      "name",
      "marketplaceName",
      "version",
      "installed",
      "enabled",
      "source",
      "marketplaceSource",
      "installPolicy",
      "authPolicy",
    ]) ||
    typeof value.name !== "string" ||
    !isSafePluginName(value.name) ||
    typeof value.marketplaceName !== "string" ||
    !safeMarketplaceName.test(value.marketplaceName) ||
    value.pluginId !== `${value.name}@${value.marketplaceName}` ||
    value.installed !== true ||
    typeof value.enabled !== "boolean" ||
    typeof value.version !== "string" ||
    !isSafeVersion(value.version) ||
    typeof value.installPolicy !== "string" ||
    typeof value.authPolicy !== "string"
  ) {
    return null;
  }
  const source = parseSource(value.source);
  if (
    source === null ||
    (value.marketplaceSource !== undefined &&
      (!isRecord(value.marketplaceSource) ||
        !hasExactKeys(value.marketplaceSource, ["sourceType", "source"]) ||
        typeof value.marketplaceSource.sourceType !== "string" ||
        typeof value.marketplaceSource.source !== "string"))
  ) {
    return null;
  }
  return {
    pluginId: value.pluginId,
    name: value.name,
    marketplaceName: value.marketplaceName,
    version: value.version,
    enabled: value.enabled,
    source,
    marketplaceSource:
      isRecord(value.marketplaceSource) &&
      typeof value.marketplaceSource.source === "string"
        ? value.marketplaceSource.source
        : null,
  };
}

function parseSource(value: unknown): PluginSource | null {
  if (!isRecord(value) || typeof value.source !== "string") return null;
  switch (value.source) {
    case "local":
      return hasExactKeys(value, ["source", "path"]) &&
        typeof value.path === "string" &&
        isAbsolute(value.path)
        ? { kind: "local", path: resolve(value.path) }
        : null;
    case "git":
      return hasAllowedKeys(value, ["source", "url", "ref", "sha"]) &&
        typeof value.url === "string" &&
        optionalFieldsAreStrings(value, ["ref", "sha"])
        ? { kind: "non-local" }
        : null;
    case "git-subdir":
      return hasAllowedKeys(value, ["source", "url", "path", "ref", "sha"]) &&
        typeof value.url === "string" &&
        typeof value.path === "string" &&
        optionalFieldsAreStrings(value, ["ref", "sha"])
        ? { kind: "non-local" }
        : null;
    case "npm":
      return hasAllowedKeys(value, [
        "source",
        "package",
        "version",
        "registry",
      ]) &&
        typeof value.package === "string" &&
        optionalFieldsAreStrings(value, ["version", "registry"])
        ? { kind: "non-local" }
        : null;
    default:
      return null;
  }
}

async function materializePlugin(input: {
  readonly environment: InventoryScanEnvironment;
  readonly commandRunner: InventoryCommandRunner;
  readonly home: string;
  readonly cacheRoot: string;
  readonly entry: CodexPluginEntry;
  readonly runtimeDefault: boolean;
}): Promise<{
  readonly installations: readonly Installation[];
  readonly boundary: PluginBoundary;
  readonly otherFindings: readonly NonInstallationFinding[];
}> {
  const cacheBase = join(
    input.cacheRoot,
    input.entry.marketplaceName,
    input.entry.name,
  );
  const activeRoot = join(cacheBase, input.entry.version);
  const cacheBaseLocation = await artifactLocation(
    cacheBase,
    input.commandRunner,
  );
  const activeRootLocation = await artifactLocation(
    activeRoot,
    input.commandRunner,
  );
  const pathIssue = await cacheSafetyIssue({
    home: input.home,
    cacheRoot: input.cacheRoot,
    cacheBase,
    activeRoot,
    cacheBaseLocation,
    activeRootLocation,
  });
  const manifest =
    pathIssue === null && activeRootLocation !== null
      ? await readPluginManifest(activeRoot, input.commandRunner)
      : emptyManifest();
  const manifestIssue = manifest.invalid
    ? "the Codex plugin manifest is invalid or unsafe to read"
    : null;
  const manifestPathIssue =
    pathIssue === null && !manifest.invalid && activeRootLocation !== null
      ? await manifestPathSafetyIssue(
          activeRoot,
          activeRootLocation,
          manifest,
          input.commandRunner,
        )
      : null;
  const config = await configEvidence(input.home, input.commandRunner);
  const discoveryIssue = pathIssue ?? manifestIssue ?? manifestPathIssue;
  const unsafeReason = discoveryIssue ?? config.issue;
  const locatedSkills =
    discoveryIssue === null
      ? await locateSkills(activeRoot, manifest, input.commandRunner)
      : [];
  const externalSkills = locatedSkills.filter((skill) =>
    resolvesOutsideRoot(activeRootLocation, skill.location),
  );
  const internalSkills = locatedSkills.filter(
    (skill) => !resolvesOutsideRoot(activeRootLocation, skill.location),
  );
  const boundaryId = stableId(
    "plugin-boundary",
    CODEX_PLUGIN_ADAPTER_ID,
    input.entry.pluginId,
    pathKey(cacheBase),
  );
  const scope: Scope = { kind: "user" };
  const installations = await Promise.all(
    (discoveryIssue === null ? internalSkills : []).map((skill) =>
      materializeSkill({
        entry: input.entry,
        manifest,
        boundaryId,
        root: activeRoot,
        skill,
        commandRunner: input.commandRunner,
      }),
    ),
  );
  const otherFindings = await Promise.all([
    ...externalSkills.map((skill) =>
      sourceFinding({
        path: skill.path,
        location: skill.location,
        sourceId: input.entry.pluginId,
        sourceRoot: activeRoot,
        classification: "source-artifact" as const,
        scope,
        state: "linked-outside-plugin",
        commandRunner: input.commandRunner,
        readMetadata: false,
      }),
    ),
    ...(input.entry.source.kind === "local"
      ? await scanSourceTree({
          root: input.entry.source.path,
          sourceId: input.entry.pluginId,
          commandRunner: input.commandRunner,
        })
      : []),
  ]);
  const resources = await pluginResources({
    commandRunner: input.commandRunner,
    entry: input.entry,
    home: input.home,
    cacheBase,
    cacheBaseLocation,
    activeRoot,
    activeRootLocation,
    manifest,
    config,
  });
  const managed = await managedRemoval({
    entry: input.entry,
    cacheBase,
    cacheBaseLocation,
    config,
    unsafeReason,
    commandRunner: input.commandRunner,
  });

  return {
    installations,
    otherFindings,
    boundary: {
      id: boundaryId,
      pluginId: input.entry.pluginId,
      version: input.entry.version,
      adapterId: CODEX_PLUGIN_ADAPTER_ID,
      ownership: {
        kind: "plugin",
        pluginId: input.entry.pluginId,
        independentlySelectable: false,
        confidence: "declared",
      },
      runtimeDefault: input.runtimeDefault,
      installationIds: installations.map((installation) => installation.id),
      resources,
      removal: {
        managed,
        fallback: {
          kind: "unavailable",
          reason:
            "Codex plugin configuration is TOML and v1 has no declarative TOML cleanup",
        },
        primaryArtifactPresent: false,
        supplementalArtifacts: [],
        recordCleanups: [],
      },
    },
  };
}

async function materializeSkill(input: {
  readonly entry: CodexPluginEntry;
  readonly manifest: PluginManifest;
  readonly boundaryId: string;
  readonly root: string;
  readonly skill: LocatedSkill;
  readonly commandRunner: InventoryCommandRunner;
}): Promise<Installation> {
  const fallbackName = basename(input.skill.path);
  const metadata = isBroken(input.skill.location)
    ? null
    : await readSkillMetadata(join(input.skill.path, "SKILL.md"), fallbackName);
  const contentHash =
    input.skill.location.artifactType.kind === "directory"
      ? await hashSkillDirectory(input.skill.path).catch(() => null)
      : null;
  const skillName = metadata?.skill.name ?? fallbackName;
  const skillId = portableRelativePath(input.root, input.skill.path);
  const strongEvidence: StrongIdentityEvidence[] = [
    {
      strength: "strong",
      kind: "plugin",
      pluginId: input.entry.pluginId,
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
      CODEX_PLUGIN_ADAPTER_ID,
      input.boundaryId,
      skillId,
    ) as InstallationId,
    classification: "managed-plugin-resource",
    status: isBroken(input.skill.location)
      ? "broken"
      : (metadata?.status ?? "unresolved"),
    skill: metadata?.skill ?? { name: skillName, description: null },
    identity: { strongEvidence, weakEvidence },
    source: { id: input.entry.pluginId, url: null },
    plugin: { id: input.entry.pluginId, version: input.entry.version },
    manager: null,
    adapterId: CODEX_PLUGIN_ADAPTER_ID,
    pluginBoundaryId: input.boundaryId,
    agentId,
    scope: { kind: "user" },
    location: input.skill.location,
    contentHash,
    modifiedAt: await modificationTime(input.skill.path),
    ownership: {
      kind: "plugin",
      pluginId: input.entry.pluginId,
      independentlySelectable: false,
      confidence: "declared",
    },
    protection: await protectionFor(input.skill.location, input.commandRunner),
    removal: {
      managed: null,
      fallback: {
        kind: "unavailable",
        reason: "Codex plugins do not support child skill removal",
      },
      primaryArtifactPresent: false,
      supplementalArtifacts: [],
      recordCleanups: [],
    },
    tags: ["codex", "plugin", input.entry.enabled ? "enabled" : "disabled"],
    metadata: {
      ...(metadata?.metadata ?? {}),
      "codex-plugin": {
        pluginId: input.entry.pluginId,
        pluginName: input.entry.name,
        marketplace: input.entry.marketplaceName,
        version: input.entry.version,
        enabled: input.entry.enabled,
        skillId,
        independentlySelectable: false,
        manifest: {
          name: input.manifest.name,
          description: input.manifest.description,
          version: input.manifest.version,
        },
      },
    },
  };
}

interface ConfigEvidence {
  readonly path: string;
  readonly location: ArtifactLocation;
  readonly protection: ProtectionStatus;
  readonly issue: string | null;
}

async function configEvidence(
  home: string,
  commandRunner: InventoryCommandRunner,
): Promise<ConfigEvidence> {
  const path = join(home, "config.toml");
  const initialStats = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (initialStats === null) {
    const location = absentFileLocation(path);
    return {
      path,
      location,
      protection: await protectionFor(location, commandRunner, true),
      issue: null,
    };
  }
  const file = await readStableRegularFile(path, initialStats);
  if (file === null) {
    const location =
      (await artifactLocation(path, commandRunner, true)) ??
      absentFileLocation(path);
    return {
      path,
      location,
      protection: await protectionFor(location, commandRunner),
      issue: "the Codex configuration is linked, hard-linked, or unstable",
    };
  }
  const location: ArtifactLocation = {
    path,
    canonicalPath: file.canonicalPath,
    artifactType: { kind: "file" },
  };
  return {
    path,
    location,
    protection: await protectionFor(location, commandRunner),
    issue: null,
  };
}

async function managedRemoval(input: {
  readonly entry: CodexPluginEntry;
  readonly cacheBase: string;
  readonly cacheBaseLocation: ArtifactLocation | null;
  readonly config: ConfigEvidence;
  readonly unsafeReason: string | null;
  readonly commandRunner: InventoryCommandRunner;
}): Promise<ManagedRemovalEvidence> {
  const cacheProtection =
    input.cacheBaseLocation === null
      ? await protectionFor(
          absentDirectoryLocation(input.cacheBase),
          input.commandRunner,
          true,
        )
      : await protectionFor(input.cacheBaseLocation, input.commandRunner);
  return {
    adapterId: CODEX_PLUGIN_ADAPTER_ID,
    operationId: "remove-user-plugin",
    availability:
      input.unsafeReason === null
        ? { kind: "available" }
        : { kind: "unavailable", reason: input.unsafeReason },
    trust: { kind: "trusted" },
    externalId: input.entry.pluginId,
    invocation: {
      kind: "direct",
      command: {
        executable: CODEX_EXECUTABLE,
        arguments: codexPluginRemoveArguments(input.entry.pluginId),
      },
      workingDirectory: { kind: "isolated-temporary" },
    },
    effects: [
      {
        kind: "remove-path",
        path: input.cacheBase,
        protection: cacheProtection,
      },
      {
        kind: "modify-path",
        path: input.config.path,
        protection: input.config.protection,
      },
    ],
    verifications: [
      { kind: "path-absent", path: input.cacheBase },
      { kind: "owner-state-absent", externalId: input.entry.pluginId },
    ],
  };
}

async function pluginResources(input: {
  readonly commandRunner: InventoryCommandRunner;
  readonly entry: CodexPluginEntry;
  readonly home: string;
  readonly cacheBase: string;
  readonly cacheBaseLocation: ArtifactLocation | null;
  readonly activeRoot: string;
  readonly activeRootLocation: ArtifactLocation | null;
  readonly manifest: PluginManifest;
  readonly config: ConfigEvidence;
}): Promise<readonly PluginResource[]> {
  const resources: PluginResource[] = [
    {
      kind: "configuration",
      id: "codex-config-state",
      location: input.config.location,
      protection: input.config.protection,
      cleanupId: null,
    },
  ];
  if (input.cacheBaseLocation !== null) {
    resources.push({
      kind: "other",
      id: "plugin-cache-all-versions",
      location: input.cacheBaseLocation,
      protection: await protectionFor(
        input.cacheBaseLocation,
        input.commandRunner,
      ),
      cleanupId: null,
    });
  }
  if (input.activeRootLocation !== null) {
    resources.push({
      kind: "other",
      id: "active-plugin-root",
      location: input.activeRootLocation,
      protection: await protectionFor(
        input.activeRootLocation,
        input.commandRunner,
      ),
      cleanupId: null,
    });
  }
  if (input.manifest.document !== null) {
    resources.push({
      kind: "configuration",
      id: "plugin-manifest",
      location: input.manifest.document.location,
      protection: input.manifest.document.protection,
      cleanupId: null,
    });
  }
  if (input.manifest.overlayDocument !== null) {
    resources.push({
      kind: "configuration",
      id: "codex-plugin-overlay",
      location: input.manifest.overlayDocument.location,
      protection: input.manifest.overlayDocument.protection,
      cleanupId: null,
    });
  }
  const componentPaths = new Set<string>();
  const defaultComponents: readonly ManifestComponent[] =
    input.manifest.format === "agent"
      ? [{ kind: "configuration", id: "mcp-servers", relativePath: "mcp.json" }]
      : [
          { kind: "command", id: "commands", relativePath: "commands" },
          { kind: "hook", id: "hooks", relativePath: "hooks/hooks.json" },
          {
            kind: "configuration",
            id: "mcp-servers",
            relativePath: ".mcp.json",
          },
          { kind: "configuration", id: "apps", relativePath: ".app.json" },
          {
            kind: "other",
            id: "migrated-command-skills",
            relativePath: ".codex-plugin/migrated-command-skills",
          },
        ];
  const skillComponents: readonly ManifestComponent[] =
    input.manifest.skillRoots.length === 0
      ? [{ kind: "other", id: "skills", relativePath: "skills" }]
      : input.manifest.skillRoots.map((relativePath, index) => ({
          kind: "other" as const,
          id:
            input.manifest.skillRoots.length === 1
              ? "manifest-skills"
              : `manifest-skills-${String(index + 1)}`,
          relativePath,
        }));
  for (const component of [
    ...skillComponents,
    ...defaultComponents,
    ...input.manifest.components,
  ]) {
    if (component.relativePath === null) {
      if (input.manifest.document === null) continue;
      resources.push({
        kind: component.kind,
        id: component.id,
        location: input.manifest.document.location,
        protection: input.manifest.document.protection,
        cleanupId: null,
      });
      continue;
    }
    const componentPath = component.relativePath.startsWith("./")
      ? safeManifestPath(input.activeRoot, component.relativePath)
      : resolve(input.activeRoot, component.relativePath);
    if (
      componentPath === null ||
      !pathIsWithin(input.activeRoot, componentPath)
    ) {
      continue;
    }
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
  const versions = await directDirectories(input.cacheBase);
  for (const version of versions) {
    if (version.name === input.entry.version) continue;
    const versionPath = join(input.cacheBase, version.name);
    const location = await artifactLocation(versionPath, input.commandRunner);
    if (location === null) continue;
    resources.push({
      kind: "other",
      id: `stale-cache-version:${version.name}`,
      location,
      protection: await protectionFor(location, input.commandRunner),
      cleanupId: null,
    });
  }
  const dataPath = pluginDataPath(
    input.home,
    input.entry,
    input.manifest.format,
  );
  const dataLocation = await artifactLocation(dataPath, input.commandRunner);
  if (dataLocation !== null) {
    resources.push({
      kind: "configuration",
      id: "persistent-data-retained",
      location: dataLocation,
      protection: await protectionFor(dataLocation, input.commandRunner),
      cleanupId: null,
    });
  }
  return resources.sort((left, right) => compareText(left.id, right.id));
}

async function readPluginManifest(
  root: string,
  commandRunner: InventoryCommandRunner,
): Promise<PluginManifest> {
  const rootManifestPath = join(root, "plugin.json");
  const rootStats = await lstat(rootManifestPath).catch(() => null);
  if (rootStats !== null) {
    if (!rootStats.isFile() || rootStats.isSymbolicLink()) {
      return { ...emptyManifest(), invalid: true };
    }
    const rootDocument = await readStableJson(rootManifestPath, commandRunner);
    if (rootDocument === null) return { ...emptyManifest(), invalid: true };
    if (rootDocument.value.$schema === agentPluginSchema) {
      return readAgentPluginManifest(root, rootDocument, commandRunner);
    }
    if (
      typeof rootDocument.value.$schema === "string" &&
      rootDocument.value.$schema.startsWith(agentPluginSchemaPrefix)
    ) {
      return { ...emptyManifest(), document: rootDocument, invalid: true };
    }
  }
  let manifestPath: string | null = null;
  for (const segments of manifestPaths) {
    const candidate = join(root, ...segments);
    if ((await lstat(candidate).catch(() => null)) !== null) {
      manifestPath = candidate;
      break;
    }
  }
  if (manifestPath === null) return { ...emptyManifest(), invalid: true };
  const document = await readStableJson(manifestPath, commandRunner);
  if (document === null) return { ...emptyManifest(), invalid: true };
  const value = document.value;
  const name = optionalString(value.name);
  const description = optionalString(value.description);
  const version = optionalString(value.version);
  if (
    (value.name !== undefined && name === null) ||
    (value.description !== undefined && description === null) ||
    (value.version !== undefined &&
      (version === null || !isSafeVersion(version)))
  ) {
    return { ...emptyManifest(), document, invalid: true };
  }
  const skillRoots = manifestPathList(value.skills);
  const components = parseManifestComponents(value);
  if (
    skillRoots === null ||
    skillRoots.some((path) => safeManifestPath(root, path) === null) ||
    components === null ||
    components.some(
      (component) =>
        component.relativePath !== null &&
        safeManifestPath(root, component.relativePath) === null,
    )
  ) {
    return { ...emptyManifest(), document, invalid: true };
  }
  return {
    format: "legacy",
    name,
    description,
    version,
    skillRoots,
    components,
    document,
    overlayDocument: null,
    invalid: false,
  };
}

async function readAgentPluginManifest(
  root: string,
  document: StableJsonDocument,
  commandRunner: InventoryCommandRunner,
): Promise<PluginManifest> {
  const value = document.value;
  const name = optionalString(value.name);
  const description = optionalString(value.description);
  const version = optionalString(value.version);
  if (
    name === null ||
    !isSafeAgentPluginName(name) ||
    (value.description !== undefined && description === null) ||
    (value.version !== undefined &&
      (version === null || !isSafeVersion(version)))
  ) {
    return { ...emptyManifest(), document, invalid: true };
  }
  const extension = agentCodexExtension(value);
  if (extension === null)
    return { ...emptyManifest(), document, invalid: true };
  let overlayDocument: StableJsonDocument | null = null;
  let extensionValue = extension;
  if (extensionValue === undefined) {
    const overlayPath = join(root, ".codex-plugin", "plugin.json");
    if ((await lstat(overlayPath).catch(() => null)) !== null) {
      overlayDocument = await readStableJson(overlayPath, commandRunner);
      if (overlayDocument === null) {
        return { ...emptyManifest(), document, invalid: true };
      }
      extensionValue = overlayDocument.value;
    }
  }
  const components =
    extensionValue === undefined
      ? []
      : parseAgentExtensionComponents(extensionValue);
  if (
    components === null ||
    components.some(
      (component) =>
        component.relativePath !== null &&
        safeManifestPath(root, component.relativePath) === null,
    )
  ) {
    return { ...emptyManifest(), document, overlayDocument, invalid: true };
  }
  return {
    format: "agent",
    name,
    description,
    version,
    skillRoots: [],
    components,
    document,
    overlayDocument,
    invalid: false,
  };
}

function agentCodexExtension(
  manifest: Record<string, unknown>,
): Record<string, unknown> | undefined | null {
  if (manifest.extensions === undefined) return undefined;
  if (!isRecord(manifest.extensions)) return null;
  const extension = manifest.extensions["com.openai"];
  return extension === undefined
    ? undefined
    : isRecord(extension)
      ? extension
      : null;
}

function parseAgentExtensionComponents(
  extension: Record<string, unknown>,
): readonly ManifestComponent[] | null {
  const components: ManifestComponent[] = [];
  const hooks = extension.hooks;
  const inlineHooks = isRecord(hooks) || isRecordList(hooks);
  const hookPaths = inlineHooks ? [] : manifestPathList(hooks);
  const appPaths = manifestPathList(extension.apps, false);
  if (hookPaths === null || appPaths === null) return null;
  if (inlineHooks) {
    components.push({ kind: "hook", id: "inline-hooks", relativePath: null });
  } else {
    addPathComponents(components, "hook", "manifest-hooks", hookPaths);
  }
  addPathComponents(components, "configuration", "manifest-apps", appPaths);
  if (extension.interface !== undefined) {
    if (!isRecord(extension.interface)) return null;
    for (const [field, id] of [
      ["composerIcon", "interface-composer-icon"],
      ["logo", "interface-logo"],
      ["logoDark", "interface-logo-dark"],
    ] as const) {
      const paths = manifestPathList(extension.interface[field], false);
      if (paths === null) return null;
      addPathComponents(components, "other", id, paths);
    }
    const screenshots = manifestPathList(extension.interface.screenshots, true);
    if (screenshots === null) return null;
    addPathComponents(components, "other", "interface-screenshot", screenshots);
  }
  return components;
}

function parseManifestComponents(
  manifest: Record<string, unknown>,
): readonly ManifestComponent[] | null {
  const components: ManifestComponent[] = [];
  const commandPaths = manifestPathList(manifest.commands);
  if (commandPaths === null) return null;
  addPathComponents(components, "command", "manifest-commands", commandPaths);

  const hooks = manifest.hooks;
  if (isRecord(hooks) || isRecordList(hooks)) {
    components.push({ kind: "hook", id: "inline-hooks", relativePath: null });
  } else {
    const hookPaths = manifestPathList(hooks);
    if (hookPaths === null) return null;
    addPathComponents(components, "hook", "manifest-hooks", hookPaths);
  }

  if (isRecord(manifest.mcpServers)) {
    components.push({
      kind: "configuration",
      id: "inline-mcp-servers",
      relativePath: null,
    });
  } else {
    const mcpPaths = manifestPathList(manifest.mcpServers, false);
    if (mcpPaths === null) return null;
    addPathComponents(
      components,
      "configuration",
      "manifest-mcp-servers",
      mcpPaths,
    );
  }

  const apps = manifestPathList(manifest.apps, false);
  if (apps === null) return null;
  addPathComponents(components, "configuration", "manifest-apps", apps);

  if (manifest.interface !== undefined) {
    if (!isRecord(manifest.interface)) return null;
    const interfaceFields = [
      ["composerIcon", "interface-composer-icon"],
      ["logo", "interface-logo"],
      ["logoDark", "interface-logo-dark"],
    ] as const;
    for (const [field, id] of interfaceFields) {
      const paths = manifestPathList(manifest.interface[field], false);
      if (paths === null) return null;
      addPathComponents(components, "other", id, paths);
    }
    const screenshots = manifestPathList(manifest.interface.screenshots, true);
    if (screenshots === null) return null;
    addPathComponents(components, "other", "interface-screenshot", screenshots);
  }
  return components;
}

function addPathComponents(
  components: ManifestComponent[],
  kind: PluginResource["kind"],
  id: string,
  paths: readonly string[],
): void {
  for (const [index, relativePath] of paths.entries()) {
    components.push({
      kind,
      id: paths.length === 1 ? id : `${id}-${String(index + 1)}`,
      relativePath,
    });
  }
}

function manifestPathList(
  value: unknown,
  allowArray = true,
): readonly string[] | null {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (
    allowArray &&
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  ) {
    return value;
  }
  return null;
}

async function locateSkills(
  root: string,
  manifest: PluginManifest,
  commandRunner: InventoryCommandRunner,
): Promise<readonly LocatedSkill[]> {
  const roots = new Map<string, string>();
  if (manifest.skillRoots.length === 0) {
    const defaultRoot = join(root, "skills");
    roots.set(pathKey(defaultRoot), defaultRoot);
  } else {
    for (const configured of manifest.skillRoots) {
      const resolved = safeManifestPath(root, configured);
      if (resolved !== null) roots.set(pathKey(resolved), resolved);
    }
  }
  if (manifest.format === "legacy") {
    const migrated = join(root, ".codex-plugin", "migrated-command-skills");
    roots.set(pathKey(migrated), migrated);
  }
  const skills = new Map<string, LocatedSkill>();
  for (const skillRoot of roots.values()) {
    const candidates =
      manifest.format === "legacy"
        ? await recursiveSkillDirectories(skillRoot)
        : await directSkillDirectories(skillRoot);
    for (const skillPath of candidates) {
      const location = await artifactLocation(skillPath, commandRunner);
      if (location !== null)
        skills.set(pathKey(skillPath), { path: skillPath, location });
    }
  }
  return [...skills.values()].sort((left, right) =>
    compareText(left.path, right.path),
  );
}

async function directSkillDirectories(
  root: string,
): Promise<readonly string[]> {
  const rootStats = await lstat(root).catch(() => null);
  if (rootStats === null) return [];
  if ((await lstat(join(root, "SKILL.md")).catch(() => null)) !== null) {
    return [root];
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => {
        const path = join(root, entry.name);
        return (await lstat(join(path, "SKILL.md")).catch(() => null)) === null
          ? null
          : path;
      }),
  );
  return candidates.filter((path): path is string => path !== null);
}

async function recursiveSkillDirectories(
  root: string,
): Promise<readonly string[]> {
  const candidates: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const stats = await lstat(path).catch(() => null);
    if (stats === null) return;
    if ((await lstat(join(path, "SKILL.md")).catch(() => null)) !== null) {
      candidates.push(path);
      return;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (entry.isDirectory() || entry.isSymbolicLink())
        await visit(join(path, entry.name));
    }
  };
  await visit(root);
  return candidates;
}

async function scanSourceTree(input: {
  readonly root: string;
  readonly sourceId: string;
  readonly commandRunner: InventoryCommandRunner;
}): Promise<readonly NonInstallationFinding[]> {
  const stats = await lstat(input.root).catch(() => null);
  if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
    return [];
  }
  const canonicalRoot = await realpath(input.root).catch(() => null);
  if (canonicalRoot === null) return [];
  const manifest = await readPluginManifest(input.root, input.commandRunner);
  if (manifest.invalid || manifest.document === null) return [];
  const skills = await locateSkills(input.root, manifest, input.commandRunner);
  const findings: NonInstallationFinding[] = [];
  for (const skill of skills) {
    if (
      skill.location.canonicalPath === null ||
      !pathIsWithin(canonicalRoot, skill.location.canonicalPath)
    ) {
      continue;
    }
    findings.push(
      await sourceFinding({
        path: skill.path,
        location: skill.location,
        sourceId: input.sourceId,
        sourceRoot: input.root,
        classification: "source-artifact",
        scope: { kind: "user" },
        state: "marketplace-source",
        commandRunner: input.commandRunner,
      }),
    );
  }
  return findings;
}

async function scanUnownedCaches(input: {
  readonly cacheRoot: string;
  readonly commandRunner: InventoryCommandRunner;
  readonly installedKeys: ReadonlySet<string>;
  readonly state: ListState["kind"];
}): Promise<readonly NonInstallationFinding[]> {
  const cacheRootStats = await lstat(input.cacheRoot).catch(() => null);
  if (
    cacheRootStats === null ||
    !cacheRootStats.isDirectory() ||
    cacheRootStats.isSymbolicLink()
  ) {
    return [];
  }
  const findings: NonInstallationFinding[] = [];
  for (const marketplace of await directDirectories(input.cacheRoot)) {
    if (!safeMarketplaceName.test(marketplace.name)) continue;
    const marketplacePath = join(input.cacheRoot, marketplace.name);
    for (const plugin of await directDirectories(marketplacePath)) {
      if (!isSafePluginName(plugin.name)) continue;
      const pluginId = `${plugin.name}@${marketplace.name}`;
      if (input.installedKeys.has(pluginId)) continue;
      const pluginPath = join(marketplacePath, plugin.name);
      for (const version of await directDirectories(pluginPath)) {
        if (!isSafeVersion(version.name)) continue;
        const versionPath = join(pluginPath, version.name);
        const location = await artifactLocation(
          versionPath,
          input.commandRunner,
        );
        if (location === null) continue;
        findings.push(
          await sourceFinding({
            path: versionPath,
            location,
            sourceId: pluginId,
            sourceRoot: pluginPath,
            classification: "cache-or-vendor-artifact",
            scope: { kind: "user" },
            state: input.state,
            commandRunner: input.commandRunner,
            readMetadata: false,
            fallbackName: `${plugin.name}@${marketplace.name}:${version.name}`,
          }),
        );
        const manifest = await readPluginManifest(
          versionPath,
          input.commandRunner,
        );
        if (manifest.invalid) continue;
        const canonicalRoot = location.canonicalPath;
        for (const skill of await locateSkills(
          versionPath,
          manifest,
          input.commandRunner,
        )) {
          if (
            canonicalRoot === null ||
            skill.location.canonicalPath === null ||
            !pathIsWithin(canonicalRoot, skill.location.canonicalPath)
          ) {
            continue;
          }
          findings.push(
            await sourceFinding({
              path: skill.path,
              location: skill.location,
              sourceId: pluginId,
              sourceRoot: pluginPath,
              classification: "cache-or-vendor-artifact",
              scope: { kind: "user" },
              state: input.state,
              commandRunner: input.commandRunner,
            }),
          );
        }
      }
    }
  }
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.classification}:${pathKey(finding.location.path)}`,
        finding,
      ]),
    ).values(),
  ];
}

async function sourceFinding(input: {
  readonly path: string;
  readonly location: ArtifactLocation;
  readonly sourceId: string;
  readonly sourceRoot: string;
  readonly classification: "source-artifact" | "cache-or-vendor-artifact";
  readonly scope: Scope;
  readonly state: string;
  readonly commandRunner: InventoryCommandRunner;
  readonly readMetadata?: boolean;
  readonly fallbackName?: string;
}): Promise<NonInstallationFinding> {
  const fallbackName = input.fallbackName ?? basename(input.path);
  const metadata =
    isBroken(input.location) || input.readMetadata === false
      ? null
      : await readSkillMetadata(join(input.path, "SKILL.md"), fallbackName);
  const name = metadata?.skill.name ?? fallbackName;
  return {
    id: stableId(
      "finding",
      CODEX_PLUGIN_ADAPTER_ID,
      input.classification,
      input.sourceId,
      pathKey(input.path),
    ) as FindingId,
    classification: input.classification,
    skill: metadata?.skill ?? { name, description: null },
    identity: {
      strongEvidence: [],
      weakEvidence: [
        {
          strength: "weak",
          kind: "name",
          normalizedName: name.normalize("NFKC").toLowerCase(),
        },
      ],
    },
    source: { id: input.sourceId, url: null },
    plugin: null,
    manager: null,
    adapterId: CODEX_PLUGIN_ADAPTER_ID,
    agentId,
    scope: input.scope,
    location: input.location,
    contentHash: null,
    modifiedAt: await modificationTime(input.path),
    ownership: { kind: "unknown", confidence: "unknown" },
    protection: await protectionFor(input.location, input.commandRunner),
    tags: ["codex", "plugin", input.classification],
    metadata: {
      "codex-plugin": {
        state: input.state,
        sourceRoot: input.sourceRoot,
        removalAuthority: false,
      },
    },
  };
}

async function manifestPathSafetyIssue(
  root: string,
  rootLocation: ArtifactLocation,
  manifest: PluginManifest,
  commandRunner: InventoryCommandRunner,
): Promise<string | null> {
  if (rootLocation.canonicalPath === null) {
    return "the Codex plugin root has no stable canonical path";
  }
  const paths = [
    ...manifest.skillRoots,
    ...manifest.components.flatMap((component) =>
      component.relativePath === null ? [] : [component.relativePath],
    ),
  ];
  for (const relativePath of paths) {
    const path = safeManifestPath(root, relativePath);
    if (path === null) {
      return "the Codex plugin manifest contains an escaping path";
    }
    const location = await artifactLocation(path, commandRunner, true);
    if (location === null) continue;
    if (
      location.canonicalPath === null ||
      !pathIsWithin(rootLocation.canonicalPath, location.canonicalPath)
    ) {
      return "a Codex plugin manifest path resolves outside the plugin root";
    }
  }
  return null;
}

async function cacheSafetyIssue(input: {
  readonly home: string;
  readonly cacheRoot: string;
  readonly cacheBase: string;
  readonly activeRoot: string;
  readonly cacheBaseLocation: ArtifactLocation | null;
  readonly activeRootLocation: ArtifactLocation | null;
}): Promise<string | null> {
  if (
    !pathIsWithin(input.cacheRoot, input.cacheBase) ||
    !pathIsWithin(input.cacheBase, input.activeRoot)
  ) {
    return "the derived Codex plugin cache path escapes its configured root";
  }
  const requiredDirectories = [
    input.home,
    join(input.home, "plugins"),
    input.cacheRoot,
    dirname(input.cacheBase),
    input.cacheBase,
    input.activeRoot,
  ];
  for (const path of requiredDirectories) {
    const stats = await lstat(path).catch(() => null);
    if (stats === null || !stats.isDirectory() || stats.isSymbolicLink()) {
      return `the Codex plugin cache hierarchy is missing, linked, or not a directory: ${path}`;
    }
  }
  if (
    input.cacheBaseLocation === null ||
    input.activeRootLocation === null ||
    input.cacheBaseLocation.artifactType.kind !== "directory" ||
    input.activeRootLocation.artifactType.kind !== "directory"
  ) {
    return "the Codex plugin cache boundary is not an ordinary directory";
  }
  const canonicalCacheRoot = await realpath(input.cacheRoot).catch(() => null);
  if (
    canonicalCacheRoot === null ||
    input.cacheBaseLocation.canonicalPath === null ||
    input.activeRootLocation.canonicalPath === null ||
    !pathIsWithin(canonicalCacheRoot, input.cacheBaseLocation.canonicalPath) ||
    !pathIsWithin(
      input.cacheBaseLocation.canonicalPath,
      input.activeRootLocation.canonicalPath,
    )
  ) {
    return "the Codex plugin cache resolves outside its configured boundary";
  }
  return null;
}

async function readStableJson(
  path: string,
  commandRunner: InventoryCommandRunner,
): Promise<StableJsonDocument | null> {
  const initialStats = await lstat(path).catch(() => null);
  if (initialStats === null) return null;
  const file = await readStableRegularFile(path, initialStats);
  if (file === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (
    tree === undefined ||
    errors.length > 0 ||
    hasDuplicateKeys(tree) ||
    !isRecord(value)
  ) {
    return null;
  }
  const location: ArtifactLocation = {
    path,
    canonicalPath: file.canonicalPath,
    artifactType: { kind: "file" },
  };
  return {
    path,
    location,
    protection: await protectionFor(location, commandRunner),
    value,
  };
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
    return {
      path,
      canonicalPath: followed === null ? null : await realpath(path),
      artifactType: {
        kind: await linkArtifactType(path, target, commandRunner),
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
  target: string,
  commandRunner: InventoryCommandRunner,
): Promise<"symbolic-link" | "junction"> {
  if (process.platform !== "win32") return "symbolic-link";
  const result = await commandRunner.run({
    executable: "fsutil",
    arguments: ["reparsepoint", "query", path],
  });
  if (result.exitCode === 0) {
    return parseWindowsReparseKind(result.stdout) ?? "symbolic-link";
  }
  return target.startsWith("\\\\?\\") || target.startsWith("\\??\\")
    ? "junction"
    : "symbolic-link";
}

async function protectionFor(
  location: ArtifactLocation,
  commandRunner: InventoryCommandRunner,
  absent = false,
): Promise<ProtectionStatus> {
  const writablePath =
    absent || isLink(location)
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

function safeManifestPath(root: string, value: string): string | null {
  if (
    !value.startsWith("./") ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    return null;
  }
  const candidate = resolve(root, value);
  return pathIsWithin(root, candidate) ? candidate : null;
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

function resolvesOutsideRoot(
  root: ArtifactLocation | null,
  child: ArtifactLocation,
): boolean {
  return (
    root?.canonicalPath !== null &&
    root?.canonicalPath !== undefined &&
    child.canonicalPath !== null &&
    !pathIsWithin(root.canonicalPath, child.canonicalPath)
  );
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function emptyManifest(): PluginManifest {
  return {
    format: "legacy",
    name: null,
    description: null,
    version: null,
    skillRoots: [],
    components: [],
    document: null,
    overlayDocument: null,
    invalid: false,
  };
}

function pluginDataPath(
  home: string,
  entry: CodexPluginEntry,
  format: PluginManifest["format"],
): string {
  const dataRoot = join(home, "plugins", "data");
  if (format === "legacy") {
    return join(dataRoot, `${entry.name}-${entry.marketplaceName}`);
  }
  const namespace = createHash("sha256")
    .update(entry.marketplaceName)
    .update("\0")
    .update(entry.name)
    .digest("hex")
    .slice(0, 32);
  return join(dataRoot, "agent-plugins", namespace);
}

function absentDirectoryLocation(path: string): ArtifactLocation {
  return {
    path,
    canonicalPath: null,
    artifactType: { kind: "directory" },
  };
}

function absentFileLocation(path: string): ArtifactLocation {
  return {
    path,
    canonicalPath: null,
    artifactType: { kind: "file" },
  };
}

function codexHome(environment: InventoryScanEnvironment): string {
  return resolve(
    environment.agentHomeDirectories?.[agentId] ??
      join(environment.homeDirectory, ".codex"),
  );
}

/**
 * The marketplace locations Codex manages for the Plugins it ships itself.
 *
 * Two are in use: the runtime cache it unpacks into, and the bundled
 * marketplaces it stages inside its own home. A Plugin whose declared
 * marketplace source resolves inside either was supplied by the runtime rather
 * than added by the user. Matching on the managed location survives the runtime
 * adding or renaming a marketplace, which a list of names would not.
 */
function isRuntimeMarketplace(
  marketplaceSource: string | null,
  runtimeRoots: readonly string[],
): boolean {
  if (marketplaceSource === null) return false;
  return runtimeRoots.some((root) => pathIsWithin(root, marketplaceSource));
}

function codexRuntimeMarketplaceRoots(
  environment: InventoryScanEnvironment,
): readonly string[] {
  return [
    resolve(
      join(
        environment.cacheDirectory ?? join(environment.homeDirectory, ".cache"),
        "codex-runtimes",
      ),
    ),
    resolve(join(codexHome(environment), ".tmp", "bundled-marketplaces")),
  ];
}

async function directDirectories(path: string) {
  return (await readdir(path, { withFileTypes: true }).catch(() => [])).filter(
    (entry) => entry.isDirectory(),
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isSafeVersion(value: string): boolean {
  return value !== "." && value !== ".." && safeVersion.test(value);
}

function isSafePluginName(value: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..")
  );
}

function isSafeAgentPluginName(value: string): boolean {
  return (
    value.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
    !value.includes("--") &&
    !value.includes("..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function optionalFieldsAreStrings(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
}

function isBroken(location: ArtifactLocation): boolean {
  return (
    (location.artifactType.kind === "symbolic-link" ||
      location.artifactType.kind === "junction") &&
    location.artifactType.broken
  );
}

function isLink(location: ArtifactLocation): boolean {
  return (
    location.artifactType.kind === "symbolic-link" ||
    location.artifactType.kind === "junction"
  );
}

async function modificationTime(path: string): Promise<string | null> {
  return lstat(path)
    .then((stats) => stats.mtime.toISOString())
    .catch(() => null);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

function compareInstallation(left: Installation, right: Installation): number {
  return compareText(left.location.path, right.location.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
