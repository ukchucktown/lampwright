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
  GEMINI_CLI_ADAPTER_ID,
  GEMINI_CLI_EXECUTABLE,
  geminiExtensionUninstallArguments,
  geminiExtensionUpdateArguments,
  geminiSkillUninstallArguments,
} from "../adapter/built-ins.js";
import { parseWindowsReparseKind } from "../filesystem/windows-reparse.js";
import { stringifyModel } from "../model/json.js";
import type {
  ArtifactLocation,
  Installation,
  InstallationId,
  ManagedRemovalEvidence,
  ManagedUpdateEvidence,
  PluginBoundary,
  PluginResource,
  PluginSettingsRecordSnapshot,
  ProtectionStatus,
  Scope,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
} from "../model/types.js";
import { hashSkillDirectory } from "./content-hash.js";
import {
  digest,
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

interface StableJsonDocument {
  readonly path: string;
  readonly bytes: Buffer;
  readonly value: unknown;
  readonly location: ArtifactLocation;
  readonly protection: ProtectionStatus;
}

type StableJsonResult =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "invalid"; readonly path: string }
  | { readonly kind: "valid"; readonly document: StableJsonDocument };

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
            update: {
              kind: "unresolved" as const,
              reason:
                "multiple installed Gemini extensions share this manifest name",
            },
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
  const enablementPath = join(root, "extension-enablement.json");
  const enablementResult = await readStableJson(enablementPath, runner);
  const rawEnablement =
    enablementResult.kind === "valid" ? enablementResult.document.value : null;
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
    const installResult = await readStableJson(
      join(managementRoot, extensionInstallFile),
      runner,
    );
    const install =
      installResult.kind === "valid" && isInstall(installResult.document.value)
        ? installResult.document.value
        : null;
    if (!isInstall(install)) continue;
    const effectiveRoot =
      install.type === "link" ? install.source : managementRoot;
    if (!isAbsolute(effectiveRoot)) continue;
    const manifestResult = await readStableJson(
      join(effectiveRoot, "gemini-extension.json"),
      runner,
    );
    const manifest =
      manifestResult.kind === "valid" &&
      isManifest(manifestResult.document.value)
        ? manifestResult.document.value
        : null;
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
    const settingsRecords = extensionSettingsRecords(
      enablementResult,
      manifest.name,
    );
    const escapedResource = resources.find(
      (resource) =>
        resource.id !== "enablement" &&
        resource.location !== null &&
        (resource.location.artifactType.kind === "symbolic-link" ||
          resource.location.artifactType.kind === "junction" ||
          (resource.location.canonicalPath !== null &&
            !canonicalWithin(managementRoot, resource.location.canonicalPath))),
    );
    const linkedSkill = (
      await Promise.all(skills.map((path) => locationFor(path, runner)))
    ).find(
      (location) =>
        location !== null &&
        (location.artifactType.kind === "symbolic-link" ||
          location.artifactType.kind === "junction" ||
          (location.canonicalPath !== null &&
            !canonicalWithin(managementRoot, location.canonicalPath))),
    );
    const update = await managedExtensionUpdate({
      home,
      name: manifest.name,
      managementRoot,
      rootLocation,
      install,
      installDocument:
        installResult.kind === "valid" ? installResult.document : null,
      manifest,
      manifestDocument:
        manifestResult.kind === "valid" ? manifestResult.document : null,
      enablementSafe:
        enablementResult.kind === "absent" ||
        (enablementResult.kind === "valid" && enablement !== null),
      unsafeReason:
        escapedResource !== undefined || linkedSkill !== undefined
          ? "a Gemini extension resource resolves outside its management boundary"
          : null,
      available,
      runner,
    });
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
        settingsRecords,
        ...(install.type === "link"
          ? {}
          : {
              updatePolicy: {
                kind: "gemini-extension" as const,
                installType: install.type,
                autoUpdate: install.autoUpdate ?? null,
                allowPreRelease: install.allowPreRelease ?? null,
              },
            }),
        availability: {
          status: reference.enabled ? "enabled" : "disabled",
          control: {
            kind: "unsupported",
            reason: "Gemini Plugin availability evidence is not materialized",
          },
        },
        update,
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

async function managedExtensionUpdate(input: {
  readonly home: string;
  readonly name: string;
  readonly managementRoot: string;
  readonly rootLocation: ArtifactLocation;
  readonly install: ExtensionInstall;
  readonly installDocument: StableJsonDocument | null;
  readonly manifest: ExtensionManifest;
  readonly manifestDocument: StableJsonDocument | null;
  readonly enablementSafe: boolean;
  readonly unsafeReason: string | null;
  readonly available: boolean;
  readonly runner: InventoryCommandRunner;
}): Promise<PluginBoundary["update"]> {
  if (input.install.type === "link")
    return {
      kind: "unresolved",
      reason: "Gemini does not update linked extension sources",
    };
  if (input.manifest.migratedTo !== undefined)
    return {
      kind: "unresolved",
      reason:
        "a migrated Gemini extension can change its source or Plugin identity",
    };
  if (input.installDocument === null || input.manifestDocument === null)
    return {
      kind: "unresolved",
      reason: "Gemini extension install or manifest evidence is not stable",
    };
  if (!input.enablementSafe)
    return {
      kind: "unresolved",
      reason: "Gemini extension enablement evidence is malformed or unstable",
    };
  if (input.unsafeReason !== null)
    return { kind: "unresolved", reason: input.unsafeReason };
  const source = extensionUpdateSource(input.install);
  if (source === null)
    return {
      kind: "unresolved",
      reason: "the Gemini extension source type or value is unsupported",
    };
  const configurationPaths = [
    join(input.home, "extensions", "extension-enablement.json"),
    join(input.home, "extension_integrity.json"),
    join(input.home, "extension_integrity.json.tmp"),
    join(input.home, "integrity.key"),
  ];
  const configurationEffects = await Promise.all(
    configurationPaths.map((path) =>
      updateConfigurationEffect(path, input.runner),
    ),
  );
  if (configurationEffects.some((effect) => effect === null))
    return {
      kind: "unresolved",
      reason:
        "a Gemini extension configuration effect is linked or has no safe parent",
    };
  const versionRevision = {
    kind: "owner-value" as const,
    path: input.manifestDocument.path,
    format: "json" as const,
    recordPointer: "/version",
    value: input.manifest.version,
  };
  const releaseRevision =
    input.install.releaseTag === undefined
      ? []
      : [
          {
            kind: "owner-value" as const,
            path: input.installDocument.path,
            format: "json" as const,
            recordPointer: "/releaseTag",
            value: input.install.releaseTag,
          },
        ];
  const git =
    input.install.type === "git"
      ? await gitUpdateEvidence(input.managementRoot, input.runner)
      : null;
  if (input.install.type === "git" && git === null)
    return {
      kind: "unresolved",
      reason:
        "Gemini Git extension revision or dirty-state evidence is unavailable",
    };
  const revisions: ManagedUpdateEvidence["currentRevision"] = [
    versionRevision,
    ...releaseRevision,
    ...(git === null
      ? []
      : [
          {
            kind: "content-hash" as const,
            path: input.managementRoot,
            digest: git.head,
          },
        ]),
  ];
  const effects: ManagedUpdateEvidence["effects"] = [
    {
      kind: "mutation-root" as const,
      path: input.managementRoot,
      exists: true,
      protection: await protectionFor(input.rootLocation, input.runner),
    },
    ...configurationEffects.filter(
      (effect): effect is NonNullable<typeof effect> => effect !== null,
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const operation: ManagedUpdateEvidence = {
    adapterId: GEMINI_CLI_ADAPTER_ID,
    operationId: "update-extension",
    availability: input.available
      ? { kind: "available" }
      : {
          kind: "unavailable",
          reason: "the Gemini CLI executable is not available",
        },
    trust: { kind: "trusted" },
    owner: {
      kind: "plugin",
      pluginId: input.name,
      independentlySelectable: false,
      confidence: "declared",
    },
    externalId: input.name,
    invocation: {
      kind: "direct",
      command: {
        executable: GEMINI_CLI_EXECUTABLE,
        arguments: geminiExtensionUpdateArguments(input.name),
      },
      workingDirectory: { kind: "isolated-temporary" },
    },
    source,
    ref: input.install.ref ?? null,
    scope: { kind: "user" },
    currentRevision: revisions,
    ownerRecordDigest: digest(
      Buffer.concat([
        input.installDocument.bytes,
        input.manifestDocument.bytes,
      ]),
    ),
    effects,
    network:
      input.install.type === "local"
        ? { kind: "none" }
        : {
            kind: "required",
            reason: "the Gemini Owner retrieves the recorded extension source",
          },
    packageDownload: { kind: "none" },
    localChanges: git?.localChanges ?? {
      kind: "unavailable",
      reason:
        "Gemini extension metadata does not prove that local content is unchanged",
    },
    verifications: [
      {
        kind: "path-present",
        path: input.managementRoot,
      },
      {
        kind: "record-present",
        path: input.installDocument.path,
        format: "json",
        recordPointer: "/source",
      },
      {
        kind: "record-present",
        path: input.manifestDocument.path,
        format: "json",
        recordPointer: "/name",
      },
      ...revisions.map((revision) =>
        revision.kind === "content-hash"
          ? {
              kind: "revision-content-hash" as const,
              path: revision.path,
            }
          : {
              kind: "revision-manifest-value" as const,
              path: revision.path,
              format: revision.format,
              recordPointer: revision.recordPointer,
              value: revision.value,
            },
      ),
      { kind: "owner-state-present", externalId: input.name },
    ],
  };
  return { kind: "managed", operation };
}

function extensionUpdateSource(
  install: Exclude<ExtensionInstall, { readonly type: "link" }>,
): Installation["source"] {
  if (install.source.includes("\0")) return null;
  if (install.type === "local")
    return isAbsolute(install.source)
      ? { id: `gemini-extension:local:${install.source}`, url: null }
      : null;
  if (install.type === "github-release") {
    const repository = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(install.source)
      ? install.source
      : null;
    return repository === null
      ? null
      : {
          id: `gemini-extension:github-release:${repository}`,
          url: `https://github.com/${repository}`,
        };
  }
  const url = safeRemoteUrl(install.source);
  return url === null
    ? null
    : {
        id: `gemini-extension:git:${url}`,
        url:
          isScpLikeGitSource(url) || /^(?:github|gitlab):/.test(url)
            ? null
            : url,
      };
}

function safeRemoteUrl(value: string): string | null {
  if (isScpLikeGitSource(value)) return value;
  if (/^(?:github|gitlab):/.test(value)) {
    const separator = value.indexOf(":");
    const repository = value.slice(separator + 1);
    return validRepositoryPath(repository) ? value : null;
  }
  try {
    const url = new URL(value);
    return ["https:", "http:", "ssh:", "git:", "sso:"].includes(url.protocol)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isScpLikeGitSource(value: string): boolean {
  const match = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/.exec(value);
  return (
    match !== null && match[1]!.length > 0 && validRepositoryPath(match[2]!)
  );
}

function validRepositoryPath(value: string): boolean {
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._~-]+$/.test(segment),
    )
  );
}

async function gitUpdateEvidence(
  root: string,
  runner: InventoryCommandRunner,
): Promise<{
  readonly head: ReturnType<typeof digest>;
  readonly localChanges: ManagedUpdateEvidence["localChanges"];
} | null> {
  const head = await runner
    .run({ executable: "git", arguments: ["-C", root, "rev-parse", "HEAD"] })
    .catch(() => null);
  const status = await runner
    .run({
      executable: "git",
      arguments: [
        "-C",
        root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ".",
        `:(exclude,top)${extensionInstallFile}`,
      ],
    })
    .catch(() => null);
  const revision = head?.stdout.trim() ?? "";
  if (
    head?.exitCode !== 0 ||
    status?.exitCode !== 0 ||
    !/^[0-9a-fA-F]{40,64}$/.test(revision)
  )
    return null;
  const expectedDigest = digest(Buffer.alloc(0));
  const actualDigest = digest(Buffer.from(status.stdout, "utf8"));
  return {
    head: digest(Buffer.from(revision, "utf8")),
    localChanges: {
      kind: status.stdout.length === 0 ? "unchanged" : "changed",
      path: root,
      expectedDigest,
      actualDigest,
    },
  };
}

async function updateConfigurationEffect(
  path: string,
  runner: InventoryCommandRunner,
): Promise<ManagedUpdateEvidence["effects"][number] | null> {
  const stats = await lstat(path).catch(() => null);
  if (stats !== null) {
    const location = await locationFor(path, runner, true);
    if (
      location === null ||
      location.artifactType.kind !== "file" ||
      location.canonicalPath === null ||
      pathKey(location.canonicalPath) !== pathKey(path)
    )
      return null;
    return {
      kind: "configuration-path",
      path,
      exists: true,
      protection: await protectionFor(location, runner),
    };
  }
  let parent = dirname(path);
  let parentStats = await lstat(parent).catch(() => null);
  while (parentStats === null) {
    const next = dirname(parent);
    if (next === parent) return null;
    parent = next;
    parentStats = await lstat(parent).catch(() => null);
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) return null;
  const canonicalParent = await realpath(parent).catch(() => null);
  if (canonicalParent === null || pathKey(canonicalParent) !== pathKey(parent))
    return null;
  const writable = await access(parent, constants.W_OK)
    .then(() => true)
    .catch(() => false);
  return {
    kind: "configuration-path",
    path,
    exists: false,
    protection: {
      git: await inspectGitProtection(path, false, runner),
      system: { kind: "none" },
      filesystem: writable
        ? { kind: "writable" }
        : {
            kind: "read-only",
            reason: "filesystem denied write access to the nearest parent",
          },
    },
  };
}

function extensionSettingsRecords(
  result: StableJsonResult,
  name: string,
): readonly PluginSettingsRecordSnapshot[] {
  const recordPointer = `/${name}`;
  if (result.kind !== "valid" || !validEnablement(result.document.value))
    return result.kind === "absent"
      ? [
          {
            path: result.path,
            format: "json",
            recordPointer,
            present: false,
            digest: null,
          },
        ]
      : [];
  const present = Object.hasOwn(result.document.value, name);
  return [
    present
      ? {
          path: result.document.path,
          format: "json",
          recordPointer,
          present: true,
          digest: digest(
            Buffer.from(stringifyModel(result.document.value[name], 0), "utf8"),
          ),
        }
      : {
          path: result.document.path,
          format: "json",
          recordPointer,
          present: false,
          digest: null,
        },
  ];
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
async function readStableJson(
  path: string,
  runner: InventoryCommandRunner,
): Promise<StableJsonResult> {
  const initial = await lstat(path).catch(() => null);
  if (initial === null) return { kind: "absent", path };
  const stable = await readStableRegularFile(path, initial);
  if (stable === null) return { kind: "invalid", path };
  try {
    const text = stable.bytes.toString("utf8");
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, {
      allowTrailingComma: false,
      disallowComments: true,
    });
    if (tree === undefined || errors.length > 0 || hasDuplicateKeys(tree))
      return { kind: "invalid", path };
    const value: unknown = JSON.parse(text);
    const location: ArtifactLocation = {
      path,
      canonicalPath: stable.canonicalPath,
      artifactType: { kind: "file" },
    };
    return {
      kind: "valid",
      document: {
        path,
        bytes: stable.bytes,
        value,
        location,
        protection: await protectionFor(location, runner),
      },
    };
  } catch {
    return { kind: "invalid", path };
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
        (typeof (value as Record<string, unknown>)[key] === "string" &&
          ((value as Record<string, string>)[key]?.length ?? 0) > 0),
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
