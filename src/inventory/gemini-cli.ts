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

import {
  GEMINI_CLI_ADAPTER_ID,
  GEMINI_CLI_EXECUTABLE,
  geminiExtensionUninstallArguments,
  geminiSkillUninstallArguments,
} from "../adapter/built-ins.js";
import { parseWindowsReparseKind } from "../filesystem/windows-reparse.js";
import type {
  ArtifactLocation,
  Installation,
  InstallationId,
  ManagedRemovalEvidence,
  PluginBoundary,
  PluginResource,
  ProtectionStatus,
  Scope,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
} from "../model/types.js";
import { hashSkillDirectory } from "./content-hash.js";
import { pathKey, readStableRegularFile } from "./evidence.js";
import { inspectGitProtection } from "./git-protection.js";
import { stableId } from "./identity.js";
import { readSkillMetadata } from "./metadata.js";
import type {
  InventoryCommandRunner,
  InventoryScanEnvironment,
} from "./types.js";

const agentId = "gemini-cli";
const extensionInstallFile = ".gemini-extension-install.json";
const extensionName = /^[A-Za-z0-9-]+$/;

export interface GeminiCliScanResult {
  readonly installations: readonly Installation[];
  readonly plugins: readonly PluginBoundary[];
}

interface ExtensionInstall {
  readonly source: string;
  readonly type: "git" | "local" | "link" | "github-release";
  readonly ref?: string;
  readonly releaseTag?: string;
  readonly autoUpdate?: boolean;
  readonly allowPreRelease?: boolean;
}
interface ExtensionManifest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly contextFileName?: string | readonly string[];
  readonly mcpServers?: unknown;
  readonly settings?: unknown;
  readonly themes?: unknown;
  readonly plan?: unknown;
  readonly excludeTools?: unknown;
  readonly migratedTo?: unknown;
}

export async function scanGeminiCli(
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner,
  executablePresent: (executable: string) => Promise<boolean>,
): Promise<GeminiCliScanResult> {
  const home =
    environment.agentHomeDirectories?.[agentId] ??
    join(environment.homeDirectory, ".gemini");
  const managerAvailable = await executablePresent(GEMINI_CLI_EXECUTABLE).catch(
    () => false,
  );
  const userGeminiSkills = join(home, "skills");
  const workspaceGeminiSkills = join(
    environment.workspaceDirectory,
    ".gemini",
    "skills",
  );
  const discoveredSkillRoots: readonly {
    path: string;
    source: "gemini" | "agents";
    scope: Scope;
    rank: number;
  }[] = [
    {
      path: userGeminiSkills,
      source: "gemini",
      scope: { kind: "user" } as Scope,
      rank: 1,
    },
    {
      path: join(homeDirectory(environment), ".agents", "skills"),
      source: "agents" as const,
      scope: { kind: "user" } as Scope,
      rank: 2,
    },
    {
      path: workspaceGeminiSkills,
      source: "gemini" as const,
      scope: {
        kind: "workspace",
        workspacePath: environment.workspaceDirectory,
      } as Scope,
      rank: 3,
    },
    {
      path: join(environment.workspaceDirectory, ".agents", "skills"),
      source: "agents" as const,
      scope: {
        kind: "workspace",
        workspacePath: environment.workspaceDirectory,
      } as Scope,
      rank: 4,
    },
  ];
  const skillRoots = [
    ...new Map(
      discoveredSkillRoots.map((root) => [pathKey(root.path), root]),
    ).values(),
  ].sort((left, right) => left.rank - right.rank);
  const entries: {
    path: string;
    source: "gemini" | "agents" | "extension";
    scope: Scope;
    rank: number;
    extension?: {
      id: string;
      boundaryId: string;
      version: string;
      name: string;
      effectiveRoot: string;
      type: string;
      source: string;
      enabled: boolean;
      install: ExtensionInstall;
      manifest: ExtensionManifest;
    };
  }[] = [];
  for (const root of skillRoots)
    for (const path of await immediateSkillDirectories(root.path))
      entries.push({
        path,
        source: root.source,
        scope: root.scope,
        rank: root.rank,
      });
  let extensions = await scanExtensions(
    home,
    environment,
    commandRunner,
    managerAvailable,
  );
  const extensionNameCounts = new Map<string, number>();
  for (const extension of extensions)
    extensionNameCounts.set(
      extension.reference.id,
      (extensionNameCounts.get(extension.reference.id) ?? 0) + 1,
    );
  extensions = extensions.map((extension) =>
    (extensionNameCounts.get(extension.reference.id) ?? 0) > 1
      ? {
          ...extension,
          reference: { ...extension.reference, enabled: false },
          boundary: {
            ...extension.boundary,
            removal: {
              ...extension.boundary.removal,
              managed:
                extension.boundary.removal.managed === null
                  ? null
                  : {
                      ...extension.boundary.removal.managed,
                      availability: {
                        kind: "unavailable" as const,
                        reason:
                          "multiple installed Gemini extensions share this manifest name",
                      },
                    },
            },
          },
        }
      : extension,
  );
  for (const extension of extensions)
    for (const path of extension.skills)
      entries.push({
        path,
        source: "extension",
        scope: { kind: "user" },
        rank: extension.reference.enabled ? 0 : -1,
        extension: extension.reference,
      });
  const names = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      metadata: await readSkillMetadata(
        join(entry.path, "SKILL.md"),
        basename(entry.path),
      ),
    })),
  );
  const winners = new Map<string, string>();
  const nativeNameCounts = new Map<string, number>();
  for (const { entry, metadata } of [...names].sort(
    (left, right) =>
      left.entry.rank - right.entry.rank ||
      left.entry.path.localeCompare(right.entry.path),
  )) {
    const key = metadata.skill.name; // Gemini precedence is case-sensitive.
    winners.set(key, entry.path);
    if (entry.source === "gemini") {
      const scopeKey = `${entry.scope.kind}:${key}`;
      nativeNameCounts.set(scopeKey, (nativeNameCounts.get(scopeKey) ?? 0) + 1);
    }
  }
  const installations: readonly (Installation | null)[] = await Promise.all(
    names.map(async ({ entry, metadata }): Promise<Installation | null> => {
      const location = await locationFor(entry.path, commandRunner);
      if (location === null) return null;
      const contentHash =
        location.artifactType.kind === "directory"
          ? await hashSkillDirectory(entry.path).catch(() => null)
          : null;
      const name = metadata.skill.name;
      const extension = entry.extension;
      const effective =
        extension && !extension.enabled
          ? false
          : winners.get(name) === entry.path;
      const strongEvidence: StrongIdentityEvidence[] =
        location.canonicalPath === null
          ? []
          : [
              {
                strength: "strong",
                kind: "canonical-target",
                canonicalPath: location.canonicalPath,
              },
            ];
      if (extension)
        strongEvidence.push({
          strength: "strong",
          kind: "plugin",
          pluginId: extension.id,
          skillId: portableRelative(extension.effectiveRoot, entry.path),
        });
      const weakEvidence: WeakIdentityEvidence[] = [
        {
          strength: "weak",
          kind: "name",
          normalizedName: name.normalize("NFKC").toLowerCase(),
        },
      ];
      if (contentHash)
        weakEvidence.push({
          strength: "weak",
          kind: "content-hash",
          algorithm: "sha256",
          digest: contentHash,
        });
      const isNative = entry.source === "gemini";
      const managed = isNative
        ? await managedSkill(
            name,
            entry.scope,
            entry.path,
            managerAvailable,
            commandRunner,
          )
        : null;
      const resolvedManaged =
        managed !== null &&
        (nativeNameCounts.get(`${entry.scope.kind}:${name}`) ?? 0) > 1
          ? {
              ...managed,
              availability: {
                kind: "unavailable" as const,
                reason:
                  "multiple Gemini native installations share this exact skill name in the same scan",
              },
            }
          : managed;
      const installationStatus =
        location.artifactType.kind === "symbolic-link" ||
        location.artifactType.kind === "junction"
          ? location.artifactType.broken
            ? "broken"
            : "active"
          : metadata.status;
      const artifactProtection = await protectionFor(location, commandRunner);
      return {
        id: stableId(
          "installation",
          GEMINI_CLI_ADAPTER_ID,
          entry.path,
        ) as InstallationId,
        classification:
          entry.source === "extension"
            ? "managed-plugin-resource"
            : entry.scope.kind === "workspace"
              ? "standalone-project-skill"
              : "active-installation",
        status: installationStatus,
        skill: metadata.skill,
        identity: { strongEvidence, weakEvidence },
        source: null,
        plugin: extension
          ? { id: extension.id, version: extension.version }
          : null,
        manager: isNative ? { id: "gemini-cli" } : null,
        adapterId: GEMINI_CLI_ADAPTER_ID,
        pluginBoundaryId: extension?.boundaryId ?? null,
        agentId,
        exposedTo: [agentId],
        harnessExposures: [],
        suspension:
          !extension && !isNative && installationStatus === "active"
            ? {
                kind: "available",
                artifacts: [{ location, protection: artifactProtection }],
                managerRecord: "not-applicable",
                managerMayRecreate: false,
              }
            : {
                kind: "unavailable",
                reason: extension
                  ? "Plugin-owned Skills cannot be suspended independently"
                  : isNative
                    ? "Gemini Manager ownership has no declared suspension authority"
                    : "only a complete active Installation can be suspended",
              },
        scope: entry.scope,
        location,
        contentHash,
        modifiedAt: await mtime(entry.path),
        ownership: extension
          ? {
              kind: "plugin" as const,
              pluginId: extension.id,
              independentlySelectable: false,
              confidence: "declared" as const,
            }
          : isNative
            ? {
                kind: "manager" as const,
                managerId: "gemini-cli",
                confidence: "declared" as const,
              }
            : { kind: "filesystem" as const, confidence: "inferred" as const },
        protection: artifactProtection,
        update: {
          kind: "unsupported" as const,
          reason: extension
            ? "Plugin-owned Skills update only through their complete Plugin boundary"
            : "Gemini standalone Skills have no supported Owner Update operation",
        },
        removal: extension
          ? {
              managed: null,
              fallback: {
                kind: "unavailable" as const,
                reason:
                  "Gemini extension skills are owned by their containing extension",
              },
              supplementalArtifacts: [],
              recordCleanups: [],
            }
          : {
              managed: await resolvedManaged,
              fallback: {
                kind: "available" as const,
                requiresSeparateConfirmation: true,
              },
              supplementalArtifacts: [],
              recordCleanups: [],
            },
        tags: [
          ...metadata.tags,
          "gemini",
          effective ? "effective" : "overridden",
        ],
        metadata: {
          ...metadata.metadata,
          "gemini-cli": {
            source: entry.source,
            precedence: entry.rank,
            effective,
            searchRoots: skillRoots.map((root) => root.path),
            link:
              location.artifactType.kind === "symbolic-link" ||
              location.artifactType.kind === "junction"
                ? location.artifactType.kind
                : "copy",
            ...(extension
              ? {
                  extensionId: extension.id,
                  independentlySelectable: false,
                  extensionType: extension.type,
                  extensionSource: extension.source,
                  extensionEnabled: extension.enabled,
                  extensionRoot: extension.effectiveRoot,
                  install: {
                    ref: extension.install.ref ?? null,
                    releaseTag: extension.install.releaseTag ?? null,
                    autoUpdate: extension.install.autoUpdate ?? null,
                    allowPreRelease: extension.install.allowPreRelease ?? null,
                  },
                  manifest: {
                    description: extension.manifest.description ?? null,
                    contextFileNames:
                      typeof extension.manifest.contextFileName === "string"
                        ? [extension.manifest.contextFileName]
                        : (extension.manifest.contextFileName ?? ["GEMINI.md"]),
                    hasMcpServers: extension.manifest.mcpServers !== undefined,
                    hasSettings: extension.manifest.settings !== undefined,
                    hasThemes: extension.manifest.themes !== undefined,
                    hasPlan: extension.manifest.plan !== undefined,
                    excludeTools: Array.isArray(extension.manifest.excludeTools)
                      ? extension.manifest.excludeTools.filter(
                          (item): item is string => typeof item === "string",
                        )
                      : null,
                    migratedTo:
                      typeof extension.manifest.migratedTo === "string"
                        ? extension.manifest.migratedTo
                        : null,
                  },
                }
              : {}),
          },
        },
      } satisfies Installation;
    }),
  );
  const present = installations
    .filter((item): item is Installation => item !== null)
    .sort((a, b) => a.location.path.localeCompare(b.location.path));
  return {
    installations: present,
    plugins: extensions
      .map((item) => ({
        ...item.boundary,
        installationIds: present
          .filter(
            (installation) =>
              installation.pluginBoundaryId === item.boundary.id,
          )
          .map((installation) => installation.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function scanExtensions(
  home: string,
  environment: InventoryScanEnvironment,
  runner: InventoryCommandRunner,
  available: boolean,
): Promise<
  {
    skills: readonly string[];
    reference: {
      id: string;
      boundaryId: string;
      version: string;
      name: string;
      effectiveRoot: string;
      type: string;
      source: string;
      enabled: boolean;
      install: ExtensionInstall;
      manifest: ExtensionManifest;
    };
    boundary: PluginBoundary;
  }[]
> {
  const root = join(home, "extensions");
  const rawEnablement = await readJson(join(root, "extension-enablement.json"));
  const enablement = validEnablement(rawEnablement) ? rawEnablement : null;
  const directories = await readdir(root, { withFileTypes: true }).catch(
    () => [],
  );
  const output = [] as {
    skills: readonly string[];
    reference: {
      id: string;
      boundaryId: string;
      version: string;
      name: string;
      effectiveRoot: string;
      type: string;
      source: string;
      enabled: boolean;
      install: ExtensionInstall;
      manifest: ExtensionManifest;
    };
    boundary: PluginBoundary;
  }[];
  for (const entry of directories) {
    if (
      entry.name === "extension-enablement.json" ||
      (!entry.isDirectory() && !entry.isSymbolicLink())
    )
      continue;
    const managementRoot = join(root, entry.name);
    const install = (await readJson(
      join(managementRoot, extensionInstallFile),
    )) as ExtensionInstall | null;
    if (!isInstall(install)) continue;
    const effectiveRoot =
      install.type === "link" ? install.source : managementRoot;
    if (!isAbsolute(effectiveRoot)) continue;
    const manifest = (await readJson(
      join(effectiveRoot, "gemini-extension.json"),
    )) as ExtensionManifest | null;
    if (!isManifest(manifest)) continue;
    if (basename(managementRoot) !== manifest.name) continue;
    const declaredContexts =
      typeof manifest.contextFileName === "string"
        ? [manifest.contextFileName]
        : (manifest.contextFileName ?? []);
    if (
      declaredContexts.some(
        (context) => safeChild(effectiveRoot, context) === null,
      )
    )
      continue;
    const rootLocation = await locationFor(managementRoot, runner);
    if (
      !rootLocation ||
      rootLocation.artifactType.kind === "symbolic-link" ||
      rootLocation.artifactType.kind === "junction"
    )
      continue;
    const boundaryId = stableId(
      "plugin-boundary",
      GEMINI_CLI_ADAPTER_ID,
      managementRoot,
    );
    const reference = {
      id: manifest.name,
      boundaryId,
      version: manifest.version,
      name: manifest.name,
      effectiveRoot,
      type: install.type,
      source: install.source,
      enabled: extensionEnabled(
        enablement,
        manifest.name,
        environment.workspaceDirectory,
      ),
      install,
      manifest,
    };
    const skillsRoot = safeChild(effectiveRoot, "skills");
    const skills = skillsRoot
      ? await immediateSkillDirectories(skillsRoot)
      : [];
    const resources: PluginResource[] = [];
    for (const [kind, id, relativePath] of [
      ["other", "management-root", null],
      ["configuration", "install-metadata", extensionInstallFile],
      ["configuration", "manifest", "gemini-extension.json"],
      ["configuration", "environment", ".env"],
      ["command", "commands", "commands"],
      ["hook", "hooks", "hooks/hooks.json"],
      ["other", "skills", "skills"],
      ["agent", "agents", "agents"],
      ["configuration", "policies", "policies"],
    ] as const) {
      const path =
        relativePath === null
          ? managementRoot
          : id === "install-metadata"
            ? join(managementRoot, extensionInstallFile)
            : id === "environment"
              ? join(managementRoot, ".env")
              : safeChild(effectiveRoot, relativePath);
      if (path === null) continue;
      const location = await locationFor(path, runner, true);
      if (location)
        resources.push({
          kind,
          id,
          location,
          protection: await protectionFor(location, runner),
          cleanupId: null,
        });
    }
    const contexts =
      typeof manifest.contextFileName === "string"
        ? [manifest.contextFileName]
        : Array.isArray(manifest.contextFileName)
          ? manifest.contextFileName
          : ["GEMINI.md"];
    for (const context of contexts) {
      const path = safeChild(effectiveRoot, context);
      if (path) {
        const location = await locationFor(path, runner, true);
        if (location)
          resources.push({
            kind: "configuration",
            id: `context:${context}`,
            location,
            protection: await protectionFor(location, runner),
            cleanupId: null,
          });
      }
    }
    for (const key of ["mcpServers", "settings", "themes", "plan"] as const)
      if (manifest[key] !== undefined) {
        const location = await locationFor(
          join(effectiveRoot, "gemini-extension.json"),
          runner,
          true,
        );
        if (location === null) continue;
        resources.push({
          kind: "configuration",
          id: `manifest:${key}`,
          location,
          protection: await protectionFor(location, runner),
          cleanupId: null,
        });
      }
    const enablementPath = join(root, "extension-enablement.json");
    const hasEnablementRecord =
      !!enablement &&
      typeof enablement === "object" &&
      Object.hasOwn(enablement, manifest.name);
    const enablementLocation = hasEnablementRecord
      ? await locationFor(enablementPath, runner, true)
      : null;
    if (enablementLocation)
      resources.push({
        kind: "configuration",
        id: "enablement",
        location: enablementLocation,
        protection: await protectionFor(enablementLocation, runner),
        cleanupId: null,
      });
    const managed = await managedExtension(
      manifest.name,
      managementRoot,
      enablementLocation === null ? null : enablementPath,
      rootLocation,
      enablementLocation,
      available,
      runner,
    );
    output.push({
      skills,
      reference,
      boundary: {
        id: boundaryId,
        pluginId: manifest.name,
        version: manifest.version,
        adapterId: GEMINI_CLI_ADAPTER_ID,
        exposedTo: [agentId],
        ownership: {
          kind: "plugin",
          pluginId: manifest.name,
          independentlySelectable: false,
          confidence: "declared",
        },
        runtimeDefault: false,
        installationIds: [],
        resources,
        availability: {
          status: reference.enabled ? "enabled" : "disabled",
          control: {
            kind: "unsupported",
            reason: "Gemini Plugin availability evidence is not materialized",
          },
        },
        update: {
          kind: "unsupported",
          reason: "Gemini extension Update support is not materialized",
        },
        removal: {
          managed,
          fallback:
            install.type === "link"
              ? {
                  kind: "unavailable",
                  reason: "linked extension source must be preserved",
                }
              : resources.some(
                    (resource) =>
                      resource.location !== null &&
                      resource.location.canonicalPath !== null &&
                      !canonicalWithin(
                        managementRoot,
                        resource.location.canonicalPath,
                      ),
                  )
                ? {
                    kind: "unavailable",
                    reason:
                      "extension resource resolves outside the management root",
                  }
                : { kind: "available", requiresSeparateConfirmation: true },
          supplementalArtifacts: [],
          recordCleanups: [],
        },
      },
    });
  }
  return output;
}

async function managedSkill(
  name: string,
  scope: Scope,
  path: string,
  available: boolean,
  runner: InventoryCommandRunner,
): Promise<ManagedRemovalEvidence> {
  const cliScope = scope.kind === "workspace" ? "workspace" : "user";
  const location = (await locationFor(path, runner)) ?? {
    path,
    canonicalPath: null,
    artifactType: { kind: "directory" as const },
  };
  return {
    adapterId: GEMINI_CLI_ADAPTER_ID,
    operationId: `uninstall-${cliScope}-skill`,
    availability: available
      ? { kind: "available" }
      : {
          kind: "unavailable",
          reason: "the Gemini CLI executable is not available",
        },
    trust: { kind: "trusted" },
    externalId: name,
    invocation: {
      kind: "direct",
      command: {
        executable: GEMINI_CLI_EXECUTABLE,
        arguments: geminiSkillUninstallArguments(cliScope, name),
      },
      workingDirectory:
        scope.kind === "workspace"
          ? { kind: "exact", path: scope.workspacePath }
          : { kind: "isolated-temporary" },
    },
    effects: [
      {
        kind: "remove-path",
        path,
        protection: await protectionFor(location, runner),
      },
    ],
    verifications: [{ kind: "path-absent", path }],
  };
}

async function managedExtension(
  name: string,
  root: string,
  enablement: string | null,
  rootLocation: ArtifactLocation,
  enablementLocation: ArtifactLocation | null,
  available: boolean,
  runner: InventoryCommandRunner,
): Promise<ManagedRemovalEvidence> {
  return {
    adapterId: GEMINI_CLI_ADAPTER_ID,
    operationId: "uninstall-extension",
    availability: available
      ? { kind: "available" }
      : {
          kind: "unavailable",
          reason: "the Gemini CLI executable is not available",
        },
    trust: { kind: "trusted" },
    externalId: name,
    invocation: {
      kind: "direct",
      command: {
        executable: GEMINI_CLI_EXECUTABLE,
        arguments: geminiExtensionUninstallArguments(name),
      },
      workingDirectory: { kind: "isolated-temporary" },
    },
    effects: [
      {
        kind: "remove-path",
        path: root,
        protection: await protectionFor(rootLocation, runner),
      },
      ...(enablement !== null && enablementLocation !== null
        ? [
            {
              kind: "modify-path" as const,
              path: enablement,
              protection: await protectionFor(enablementLocation, runner),
            },
          ]
        : []),
    ],
    verifications: [
      { kind: "path-absent", path: root },
      { kind: "owner-state-absent", externalId: name },
    ],
  };
}

function homeDirectory(environment: InventoryScanEnvironment): string {
  return environment.homeDirectory;
}
async function immediateSkillDirectories(
  root: string,
): Promise<readonly string[]> {
  const rootStats = await lstat(root).catch(() => null);
  if (rootStats?.isSymbolicLink()) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (
      await lstat(join(path, "SKILL.md"))
        .then(() => true)
        .catch(() => false)
    )
      found.push(path);
  }
  return found;
}

function canonicalWithin(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}
async function readJson(path: string): Promise<unknown | null> {
  const initial = await lstat(path).catch(() => null);
  if (initial === null) return null;
  const stable = await readStableRegularFile(path, initial);
  if (stable === null) return null;
  try {
    return JSON.parse(stable.bytes.toString("utf8"));
  } catch {
    return null;
  }
}
function isInstall(value: unknown): value is ExtensionInstall {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ExtensionInstall).source === "string" &&
    (value as ExtensionInstall).source.length > 0 &&
    ["git", "local", "link", "github-release"].includes(
      (value as ExtensionInstall).type,
    ) &&
    ["ref", "releaseTag"].every(
      (key) =>
        (value as Record<string, unknown>)[key] === undefined ||
        typeof (value as Record<string, unknown>)[key] === "string",
    ) &&
    ["autoUpdate", "allowPreRelease"].every(
      (key) =>
        (value as Record<string, unknown>)[key] === undefined ||
        typeof (value as Record<string, unknown>)[key] === "boolean",
    )
  );
}
function isManifest(value: unknown): value is ExtensionManifest {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ExtensionManifest).name === "string" &&
    extensionName.test((value as ExtensionManifest).name) &&
    typeof (value as ExtensionManifest).version === "string" &&
    (value as ExtensionManifest).version.length > 0 &&
    (typeof (value as ExtensionManifest).contextFileName === "undefined" ||
      typeof (value as ExtensionManifest).contextFileName === "string" ||
      (Array.isArray((value as ExtensionManifest).contextFileName) &&
        (
          (value as ExtensionManifest).contextFileName as readonly unknown[]
        ).every((item) => typeof item === "string"))) &&
    ((value as Record<string, unknown>).description === undefined ||
      typeof (value as Record<string, unknown>).description === "string") &&
    ((value as Record<string, unknown>).excludeTools === undefined ||
      (Array.isArray((value as Record<string, unknown>).excludeTools) &&
        (
          (value as Record<string, unknown>).excludeTools as readonly unknown[]
        ).every((item) => typeof item === "string"))) &&
    ((value as Record<string, unknown>).migratedTo === undefined ||
      typeof (value as Record<string, unknown>).migratedTo === "string")
  );
}

function extensionEnabled(
  value: unknown,
  name: string,
  workspaceDirectory: string,
): boolean {
  if (!value || typeof value !== "object") return true;
  const entry = (value as Record<string, unknown>)[name];
  if (
    !entry ||
    typeof entry !== "object" ||
    !Array.isArray((entry as { overrides?: unknown }).overrides)
  )
    return true;
  let enabled = true;
  for (const raw of (entry as { overrides: unknown[] }).overrides) {
    if (typeof raw !== "string") continue;
    const rule = raw.replaceAll("\\", "/");
    const disabled = rule.startsWith("!");
    const subtree = (disabled ? rule.slice(1) : rule).endsWith("*");
    const pattern = (disabled ? rule.slice(1) : rule).replace(/\*$/, "");
    const normalize = (path: string) =>
      `/${path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")}/`;
    const target = normalize(workspaceDirectory);
    const expected = normalize(pattern);
    if (target === expected || (subtree && target.startsWith(expected)))
      enabled = !disabled;
  }
  return enabled;
}

function validEnablement(
  value: unknown,
): value is Record<string, { overrides: string[] }> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).every(
      ([name, entry]) =>
        extensionName.test(name) &&
        !!entry &&
        typeof entry === "object" &&
        Array.isArray((entry as { overrides?: unknown }).overrides) &&
        (entry as { overrides: unknown[] }).overrides.every(
          (rule) => typeof rule === "string",
        ),
    )
  );
}
function safeChild(root: string, value: string): string | null {
  if (!value || value.includes("\0") || isAbsolute(value)) return null;
  const path = resolve(root, value);
  const rel = relative(root, path);
  return rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    ? path
    : null;
}
function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
async function locationFor(
  path: string,
  runner: InventoryCommandRunner,
  file = false,
): Promise<ArtifactLocation | null> {
  const stats = await lstat(path).catch(() => null);
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    const target = await readlink(path);
    const followed = await stat(path).catch(() => null);
    const kind =
      process.platform === "win32" &&
      (
        await runner
          .run({
            executable: "fsutil",
            arguments: ["reparsepoint", "query", path],
          })
          .catch(() => ({ exitCode: 1, stdout: "" }))
      ).exitCode === 0
        ? (parseWindowsReparseKind(
            (
              await runner.run({
                executable: "fsutil",
                arguments: ["reparsepoint", "query", path],
              })
            ).stdout,
          ) ?? "symbolic-link")
        : "symbolic-link";
    return {
      path,
      canonicalPath: followed ? await realpath(path).catch(() => null) : null,
      artifactType: { kind, target, broken: !followed },
    };
  }
  if (stats.isDirectory() || (file && stats.isFile()))
    return {
      path,
      canonicalPath: await realpath(path).catch(() => null),
      artifactType: { kind: stats.isDirectory() ? "directory" : "file" },
    };
  return null;
}
async function protectionFor(
  location: ArtifactLocation,
  runner: InventoryCommandRunner,
): Promise<ProtectionStatus> {
  const writable =
    location.artifactType.kind === "symbolic-link" ||
    location.artifactType.kind === "junction"
      ? dirname(location.path)
      : location.path;
  return {
    git: await inspectGitProtection(
      location.path,
      location.artifactType.kind === "directory",
      runner,
    ),
    system: { kind: "none" },
    filesystem: await access(writable, constants.W_OK)
      .then(() => ({ kind: "writable" as const }))
      .catch(() => ({
        kind: "read-only" as const,
        reason: "filesystem denied write access",
      })),
  };
}
async function mtime(path: string): Promise<string | null> {
  return lstat(path)
    .then((s) => s.mtime.toISOString())
    .catch(() => null);
}
