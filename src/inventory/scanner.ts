import { constants, type Dirent } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { parseWindowsReparseKind } from "../filesystem/windows-reparse.js";
import { stringifyModel } from "../model/json.js";
import type {
  ArtifactLocation,
  ArtifactType,
  FilesystemProtection,
  FindingId,
  Installation,
  InstallationId,
  Inventory,
  InventoryId,
  NonInstallationFinding,
  Ownership,
  PluginBoundary,
  ProtectionStatus,
  Scope,
  SkillIdentity,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
} from "../model/types.js";
import { parseInventory } from "../model/validation.js";
import { hashSkillDirectory } from "./content-hash.js";
import { inspectGitProtection } from "./git-protection.js";
import {
  createWeakIdentityHints,
  groupInstallations,
  stableId,
} from "./identity.js";
import { readSkillMetadata, type ParsedSkillMetadata } from "./metadata.js";
import { systemCommandRunner } from "./process.js";
import { parseScanRequest } from "./request-schema.js";
import {
  InventoryScanError,
  type DiscoveryRoot,
  type InventoryCommandRunner,
  type InventoryScanner,
  type InventoryScannerOptions,
  type ScanRequest,
} from "./types.js";

const skillDefinitionName = "SKILL.md";
const genericAgentId = "agent-skills";

interface Candidate {
  readonly root: DiscoveryRoot;
  readonly path: string;
  readonly canonicalPath: string | null;
  readonly artifactType: ArtifactType;
  readonly broken: boolean;
  readonly skillFilePath: string | null;
}

export function createInventoryScanner(
  options: InventoryScannerOptions,
): InventoryScanner {
  return {
    async scan(request: ScanRequest): Promise<Inventory> {
      return scanWithOptions(request, options);
    },
  };
}

export async function scan(request: ScanRequest = {}): Promise<Inventory> {
  return scanWithOptions(request, {
    now: () => new Date(),
    environment: {
      homeDirectory: homedir(),
      workspaceDirectory: process.cwd(),
    },
    commandRunner: systemCommandRunner,
  });
}

async function scanWithOptions(
  request: ScanRequest,
  options: InventoryScannerOptions,
): Promise<Inventory> {
  const roots = validateAndNormalizeRequest(request, options);
  if (typeof options?.now !== "function") {
    throw new InventoryScanError(
      "invalid-request",
      "inventory scanner requires a clock",
    );
  }
  const scanDate = options.now();
  if (!(scanDate instanceof Date) || !Number.isFinite(scanDate.getTime())) {
    throw new InventoryScanError(
      "invalid-request",
      "inventory scanner clock returned an invalid date",
    );
  }
  const scannedAt = scanDate.toISOString();

  const candidatesByPath = new Map<string, Candidate>();
  for (const root of roots) {
    const candidates = await discoverRoot(root, options.commandRunner);
    for (const candidate of candidates) {
      const key = await candidateComparisonKey(candidate);
      const existing = candidatesByPath.get(key);
      if (
        existing !== undefined &&
        !(await rootsDescribeSameBoundary(existing.root, candidate.root))
      ) {
        throw new InventoryScanError(
          "invalid-request",
          `overlapping discovery roots classify ${candidate.path} differently`,
          candidate.path,
        );
      }
      if (existing === undefined) {
        candidatesByPath.set(key, candidate);
      }
    }
  }

  const records = await Promise.all(
    [...candidatesByPath.values()]
      .sort((left, right) => compareText(left.path, right.path))
      .map((candidate) =>
        materializeCandidate(candidate, options.commandRunner),
      ),
  );
  const installations = records.filter(isInstallation).sort(compareRecordPath);
  const otherFindings = records.filter(isOtherFinding).sort(compareRecordPath);
  const logicalSkills = groupInstallations(installations);
  const identityHints = createWeakIdentityHints(installations, logicalSkills);
  const plugins = await createPluginBoundaries(
    installations,
    roots,
    options.commandRunner,
  );
  const snapshot = {
    installations,
    otherFindings,
    logicalSkills,
    identityHints,
    plugins,
    dependencies: [],
  };
  const inventoryId = stableId(
    "inventory",
    stringifyModel(snapshot, 0),
  ) as InventoryId;

  return parseInventory({
    schemaVersion: 1,
    id: inventoryId,
    scannedAt,
    ...snapshot,
  });
}

function validateAndNormalizeRequest(
  request: ScanRequest,
  options: InventoryScannerOptions,
): readonly DiscoveryRoot[] {
  let parsedRequest: ScanRequest;
  try {
    parsedRequest = parseScanRequest(request);
  } catch (error: unknown) {
    throw new InventoryScanError(
      "invalid-request",
      error instanceof Error ? error.message : "invalid scan request",
    );
  }

  validateEnvironment(options);
  const declaredRoots = [
    ...defaultDiscoveryRoots(options.environment),
    ...(parsedRequest.roots ?? []),
  ];
  const seen = new Map<string, DiscoveryRoot>();
  const roots = declaredRoots.flatMap((root) => {
    if (!isAbsolute(root.path)) {
      throw new InventoryScanError(
        "invalid-request",
        `discovery root must be absolute: ${root.path}`,
        root.path,
      );
    }
    if (
      "scope" in root &&
      root.scope?.kind === "agent" &&
      root.agentId !== root.scope.agentId
    ) {
      throw new InventoryScanError(
        "invalid-request",
        "agent scope must match the discovery root agent",
        root.path,
      );
    }

    const path = resolve(root.path);
    const normalized =
      root.kind === "workspace"
        ? normalizeWorkspaceRoot(root, path)
        : ({ ...root, path } satisfies DiscoveryRoot);
    const key = pathComparisonKey(path);
    const existing = seen.get(key);
    if (existing !== undefined) {
      if (
        rootClassificationKey(existing) === rootClassificationKey(normalized)
      ) {
        return [];
      }
      throw new InventoryScanError(
        "invalid-request",
        `duplicate discovery root: ${path}`,
        path,
      );
    }
    seen.set(key, normalized);
    return [normalized];
  });

  return roots.sort((left, right) =>
    compareText(
      `${pathComparisonKey(left.path)}\0${left.kind}`,
      `${pathComparisonKey(right.path)}\0${right.kind}`,
    ),
  );
}

function validateEnvironment(options: InventoryScannerOptions): void {
  if (
    options.environment === undefined ||
    !isAbsolute(options.environment.homeDirectory) ||
    !isAbsolute(options.environment.workspaceDirectory)
  ) {
    throw new InventoryScanError(
      "invalid-request",
      "inventory scanner requires absolute home and workspace directories",
    );
  }
  if (typeof options.commandRunner?.run !== "function") {
    throw new InventoryScanError(
      "invalid-request",
      "inventory scanner requires a command runner",
    );
  }
}

function defaultDiscoveryRoots(
  environment: InventoryScannerOptions["environment"],
): readonly DiscoveryRoot[] {
  const userRoot: DiscoveryRoot = {
    kind: "user",
    path: join(environment.homeDirectory, ".agents", "skills"),
    agentId: genericAgentId,
    adapterId: null,
  };
  const workspaceRoot: DiscoveryRoot = {
    kind: "workspace",
    path: join(environment.workspaceDirectory, ".agents", "skills"),
    workspacePath: environment.workspaceDirectory,
    agentId: genericAgentId,
    adapterId: null,
  };
  return pathComparisonKey(userRoot.path) ===
    pathComparisonKey(workspaceRoot.path)
    ? [workspaceRoot]
    : [userRoot, workspaceRoot];
}

function normalizeWorkspaceRoot(
  root: Extract<DiscoveryRoot, { kind: "workspace" }>,
  path: string,
): DiscoveryRoot {
  if (!isAbsolute(root.workspacePath)) {
    throw new InventoryScanError(
      "invalid-request",
      `workspace path must be absolute: ${root.workspacePath}`,
      root.workspacePath,
    );
  }

  const workspacePath = resolve(root.workspacePath);
  const pathFromWorkspace = relative(workspacePath, path);
  if (
    pathFromWorkspace === ".." ||
    pathFromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(pathFromWorkspace)
  ) {
    throw new InventoryScanError(
      "invalid-request",
      `workspace discovery root is outside its workspace: ${path}`,
      path,
    );
  }
  return { ...root, path, workspacePath };
}

async function discoverRoot(
  root: DiscoveryRoot,
  commandRunner: InventoryCommandRunner,
): Promise<readonly Candidate[]> {
  const stats = await lstatIfAvailable(root.path);
  if (stats === null) {
    return [];
  }

  if (stats.isSymbolicLink()) {
    const linkedCandidate = await inspectLinkedCandidate(
      root.path,
      root,
      commandRunner,
    );
    return linkedCandidate === null ? [] : [linkedCandidate];
  }

  if (!stats.isDirectory()) {
    return [];
  }
  return walkDirectory(root.path, root, commandRunner);
}

async function walkDirectory(
  directoryPath: string,
  root: DiscoveryRoot,
  commandRunner: InventoryCommandRunner,
): Promise<readonly Candidate[]> {
  const skillFilePath = await findSkillFile(directoryPath);
  if (skillFilePath !== null) {
    return [
      {
        root,
        path: directoryPath,
        canonicalPath: await canonicalPath(directoryPath),
        artifactType: { kind: "directory" },
        broken: false,
        skillFilePath,
      },
    ];
  }

  const entries = await readdirWithContext(directoryPath);
  const candidates: Candidate[] = [];
  for (const entry of entries.sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    if (entry.name === ".git") {
      continue;
    }
    const entryPath = join(directoryPath, entry.name);
    const stats = await lstatWithContext(entryPath);
    if (stats.isSymbolicLink()) {
      const candidate = await inspectLinkedCandidate(
        entryPath,
        root,
        commandRunner,
      );
      if (candidate !== null) {
        candidates.push(candidate);
      }
    } else if (stats.isDirectory()) {
      candidates.push(...(await walkDirectory(entryPath, root, commandRunner)));
    }
  }
  return candidates;
}

async function inspectLinkedCandidate(
  linkPath: string,
  root: DiscoveryRoot,
  commandRunner: InventoryCommandRunner,
): Promise<Candidate | null> {
  const target = await readlinkWithContext(linkPath);
  const targetStats = await statIfAvailable(linkPath);
  const artifactType = await linkedArtifactType(
    target,
    linkPath,
    commandRunner,
  );

  if (targetStats === null) {
    return {
      root,
      path: linkPath,
      canonicalPath: null,
      artifactType: { ...artifactType, broken: true },
      broken: true,
      skillFilePath: null,
    };
  }
  if (!targetStats.isDirectory()) {
    return null;
  }

  const skillFilePath = await findSkillFile(linkPath);
  if (skillFilePath === null) {
    return null;
  }
  return {
    root,
    path: linkPath,
    canonicalPath: await canonicalPath(linkPath),
    artifactType: { ...artifactType, broken: false },
    broken: false,
    skillFilePath,
  };
}

async function linkedArtifactType(
  target: string,
  linkPath: string,
  commandRunner: InventoryCommandRunner,
): Promise<Omit<Extract<ArtifactType, { target: string }>, "broken">> {
  if (process.platform !== "win32") {
    return { kind: "symbolic-link", target };
  }

  const result = await commandRunner.run({
    executable: "fsutil",
    arguments: ["reparsepoint", "query", linkPath],
  });
  const reparseKind =
    result.exitCode === 0 ? parseWindowsReparseKind(result.stdout) : null;
  if (reparseKind !== null) {
    return { kind: reparseKind, target };
  }
  const junction =
    result.exitCode !== 0 &&
    (target.startsWith("\\\\?\\") ||
      target.startsWith("\\??\\") ||
      win32.isAbsolute(target));
  return junction
    ? { kind: "junction", target }
    : { kind: "symbolic-link", target };
}

async function materializeCandidate(
  candidate: Candidate,
  commandRunner: InventoryCommandRunner,
): Promise<Installation | NonInstallationFinding> {
  const metadata = await metadataForCandidate(candidate);
  const contentHash = candidate.broken
    ? null
    : await withFilesystemContext(
        candidate.path,
        hashSkillDirectory(candidate.path),
      );
  const modifiedAt = await modificationTime(candidate);
  const identity = createIdentity(candidate, metadata.skill.name, contentHash);
  const location: ArtifactLocation = {
    path: candidate.path,
    canonicalPath: candidate.canonicalPath,
    artifactType: candidate.artifactType,
  };
  const protection: ProtectionStatus = {
    git: await inspectGitProtection(
      candidate.path,
      candidate.artifactType.kind === "directory",
      commandRunner,
    ),
    system:
      candidate.root.kind === "system"
        ? { kind: "system-skill", agentId: candidate.root.agentId }
        : { kind: "none" },
    filesystem: await inspectFilesystemProtection(candidate),
  };

  if (isInstallationRoot(candidate.root)) {
    return createInstallation(
      candidate,
      metadata,
      identity,
      location,
      protection,
      contentHash,
      modifiedAt,
    );
  }
  return createOtherFinding(
    candidate,
    metadata,
    identity,
    location,
    protection,
    contentHash,
    modifiedAt,
  );
}

function createInstallation(
  candidate: Candidate,
  metadata: ParsedSkillMetadata,
  identity: SkillIdentity,
  location: ArtifactLocation,
  protection: ProtectionStatus,
  contentHash: string | null,
  modifiedAt: string | null,
): Installation {
  const root = candidate.root as Extract<
    DiscoveryRoot,
    { kind: "user" | "agent" | "workspace" | "plugin" }
  >;
  const plugin = root.kind === "plugin" ? root.plugin : null;
  return {
    id: stableId(
      "installation",
      pathComparisonKey(candidate.path),
    ) as InstallationId,
    classification:
      root.kind === "workspace"
        ? "standalone-project-skill"
        : root.kind === "plugin"
          ? "managed-plugin-resource"
          : "active-installation",
    status: candidate.broken ? "broken" : metadata.status,
    skill: metadata.skill,
    identity,
    source: null,
    plugin,
    manager: null,
    adapterId: root.adapterId,
    pluginBoundaryId:
      root.kind === "plugin" ? pluginBoundaryIdForRoot(root) : null,
    agentId: root.agentId,
    scope: scopeForInstallationRoot(root),
    location,
    contentHash,
    modifiedAt,
    ownership: ownershipForRoot(root),
    protection,
    removal: {
      managed: null,
      fallback: {
        kind: "available",
        requiresSeparateConfirmation: true,
      },
      recordCleanups: [],
    },
    tags: metadata.tags,
    metadata: metadata.metadata,
  };
}

async function createPluginBoundaries(
  installations: readonly Installation[],
  roots: readonly DiscoveryRoot[],
  commandRunner: InventoryCommandRunner,
): Promise<readonly PluginBoundary[]> {
  const grouped = new Map<string, Installation[]>();
  for (const installation of installations) {
    if (installation.ownership.kind !== "plugin") {
      continue;
    }
    const boundaryId = installation.pluginBoundaryId;
    if (boundaryId === null) {
      throw new InventoryScanError(
        "invalid-request",
        `plugin installation ${installation.id} has no boundary id`,
        installation.location.path,
      );
    }
    grouped.set(boundaryId, [...(grouped.get(boundaryId) ?? []), installation]);
  }

  const boundaries: PluginBoundary[] = [];
  for (const root of roots.filter(
    (candidate): candidate is Extract<DiscoveryRoot, { kind: "plugin" }> =>
      candidate.kind === "plugin",
  )) {
    const stats = await lstatIfAvailable(root.path);
    if (stats === null || (!stats.isDirectory() && !stats.isSymbolicLink())) {
      continue;
    }
    const id = pluginBoundaryIdForRoot(root);
    const members = grouped.get(id) ?? [];
    const sortedMembers = [...members].sort(compareRecordPath);
    const rootLocation = await pluginRootLocation(root, stats, commandRunner);
    const rootProtection: ProtectionStatus = {
      git: await inspectGitProtection(
        root.path,
        rootLocation.artifactType.kind === "directory",
        commandRunner,
      ),
      system: { kind: "none" },
      filesystem: await inspectPathFilesystemProtection(rootLocation),
    };
    boundaries.push({
      id,
      pluginId: root.plugin.id,
      version: root.plugin.version,
      adapterId: root.adapterId,
      ownership: {
        kind: "plugin",
        pluginId: root.plugin.id,
        independentlySelectable: root.independentlySelectable,
        confidence: "declared",
      },
      installationIds: sortedMembers.map((installation) => installation.id),
      resources: [
        {
          kind: "other",
          id: "declared-root",
          location: rootLocation,
          protection: rootProtection,
          cleanupId: null,
        },
      ],
      removal: {
        managed: null,
        fallback: {
          kind: "available",
          requiresSeparateConfirmation: true,
        },
        recordCleanups: [],
      },
    });
  }
  return boundaries.sort((left, right) => compareText(left.id, right.id));
}

async function pluginRootLocation(
  root: Extract<DiscoveryRoot, { kind: "plugin" }>,
  stats: Awaited<ReturnType<typeof lstat>>,
  commandRunner: InventoryCommandRunner,
): Promise<ArtifactLocation> {
  if (!stats.isSymbolicLink()) {
    return {
      path: root.path,
      canonicalPath: await canonicalPath(root.path),
      artifactType: { kind: "directory" },
    };
  }
  const target = await readlinkWithContext(root.path);
  const targetStats = await statIfAvailable(root.path);
  return {
    path: root.path,
    canonicalPath: targetStats === null ? null : await canonicalPath(root.path),
    artifactType: {
      ...(await linkedArtifactType(target, root.path, commandRunner)),
      broken: targetStats === null,
    },
  };
}

function pluginBoundaryIdForRoot(
  root: Extract<DiscoveryRoot, { kind: "plugin" }>,
): string {
  return stableId("plugin-boundary", pathComparisonKey(root.path));
}

function createOtherFinding(
  candidate: Candidate,
  metadata: ParsedSkillMetadata,
  identity: SkillIdentity,
  location: ArtifactLocation,
  protection: ProtectionStatus,
  contentHash: string | null,
  modifiedAt: string | null,
): NonInstallationFinding {
  const root = candidate.root as Exclude<
    DiscoveryRoot,
    { kind: "user" | "agent" | "workspace" | "plugin" }
  >;
  const classification =
    root.kind === "source"
      ? "source-artifact"
      : root.kind === "cache-or-vendor"
        ? "cache-or-vendor-artifact"
        : root.kind === "system"
          ? "system-skill"
          : "unknown";
  const common = {
    id: stableId("finding", pathComparisonKey(candidate.path)) as FindingId,
    classification,
    skill: metadata.skill,
    identity,
    source: root.kind === "source" ? root.source : null,
    plugin: null,
    manager: null,
    adapterId: root.adapterId,
    agentId: root.agentId,
    scope: scopeForFindingRoot(root),
    location,
    contentHash,
    modifiedAt,
    ownership: ownershipForRoot(root),
    protection,
    tags: metadata.tags,
    metadata: metadata.metadata,
  };

  return common as NonInstallationFinding;
}

function createIdentity(
  candidate: Candidate,
  name: string,
  contentHash: string | null,
): SkillIdentity {
  const strongEvidence: StrongIdentityEvidence[] = [];
  if (candidate.root.kind === "source") {
    strongEvidence.push({
      strength: "strong",
      kind: "source",
      sourceId: candidate.root.source.id,
      skillPath: portableRelativePath(candidate.root.path, candidate.path),
    });
  }
  if (candidate.root.kind === "plugin") {
    strongEvidence.push({
      strength: "strong",
      kind: "plugin",
      pluginId: candidate.root.plugin.id,
      skillId: portableRelativePath(candidate.root.path, candidate.path),
    });
  }
  if (candidate.canonicalPath !== null) {
    strongEvidence.push({
      strength: "strong",
      kind: "canonical-target",
      canonicalPath: candidate.canonicalPath,
    });
  }

  const weakEvidence: WeakIdentityEvidence[] = [
    {
      strength: "weak",
      kind: "name",
      normalizedName: name.normalize("NFKC").toLowerCase(),
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
  return { strongEvidence, weakEvidence };
}

async function metadataForCandidate(
  candidate: Candidate,
): Promise<ParsedSkillMetadata> {
  if (candidate.skillFilePath === null) {
    return {
      skill: { name: fallbackSkillName(candidate.path), description: null },
      tags: [],
      status: "broken",
      metadata: { generic: { frontmatter: "unavailable" } },
    };
  }
  return withFilesystemContext(
    candidate.skillFilePath,
    readSkillMetadata(
      candidate.skillFilePath,
      fallbackSkillName(candidate.path),
    ),
  );
}

function fallbackSkillName(path: string): string {
  const name = basename(path).normalize("NFKC").trim();
  return name.length === 0 ? "unnamed-skill" : name;
}

async function modificationTime(candidate: Candidate): Promise<string | null> {
  const path = candidate.skillFilePath ?? candidate.path;
  const stats = await withFilesystemContext(path, lstat(path));
  return Number.isFinite(stats.mtimeMs) ? stats.mtime.toISOString() : null;
}

async function inspectFilesystemProtection(
  candidate: Candidate,
): Promise<FilesystemProtection> {
  const path = candidate.broken ? dirname(candidate.path) : candidate.path;
  try {
    await access(path, constants.W_OK);
    return { kind: "writable" };
  } catch {
    return {
      kind: "read-only",
      reason: "filesystem denied write access",
    };
  }
}

async function inspectPathFilesystemProtection(
  location: ArtifactLocation,
): Promise<FilesystemProtection> {
  const path =
    (location.artifactType.kind === "symbolic-link" ||
      location.artifactType.kind === "junction") &&
    location.artifactType.broken
      ? dirname(location.path)
      : location.path;
  try {
    await access(path, constants.W_OK);
    return { kind: "writable" };
  } catch {
    return {
      kind: "read-only",
      reason: "filesystem denied write access",
    };
  }
}

function scopeForInstallationRoot(
  root: Extract<
    DiscoveryRoot,
    { kind: "user" | "agent" | "workspace" | "plugin" }
  >,
): Scope {
  switch (root.kind) {
    case "user":
      return { kind: "user" };
    case "agent":
      return { kind: "agent", agentId: root.agentId };
    case "workspace":
      return { kind: "workspace", workspacePath: root.workspacePath };
    case "plugin":
      return root.scope;
  }
}

function scopeForFindingRoot(
  root: Exclude<
    DiscoveryRoot,
    { kind: "user" | "agent" | "workspace" | "plugin" }
  >,
): Scope | null {
  return root.kind === "system"
    ? { kind: "agent", agentId: root.agentId }
    : root.scope;
}

function ownershipForRoot(root: DiscoveryRoot): Ownership {
  if (root.kind === "plugin") {
    return {
      kind: "plugin",
      pluginId: root.plugin.id,
      independentlySelectable: root.independentlySelectable,
      confidence: "declared",
    };
  }
  if (root.kind === "system") {
    return {
      kind: "agent-runtime",
      agentId: root.agentId,
      confidence: "declared",
    };
  }
  if (root.kind === "unknown") {
    return { kind: "unknown", confidence: "unknown" };
  }
  return { kind: "filesystem", confidence: "inferred" };
}

function isInstallationRoot(
  root: DiscoveryRoot,
): root is Extract<
  DiscoveryRoot,
  { kind: "user" | "agent" | "workspace" | "plugin" }
> {
  return ["user", "agent", "workspace", "plugin"].includes(root.kind);
}

function isInstallation(
  record: Installation | NonInstallationFinding,
): record is Installation {
  return [
    "active-installation",
    "managed-plugin-resource",
    "standalone-project-skill",
  ].includes(record.classification);
}

function isOtherFinding(
  record: Installation | NonInstallationFinding,
): record is NonInstallationFinding {
  return !isInstallation(record);
}

async function findSkillFile(directoryPath: string): Promise<string | null> {
  const skillFilePath = join(directoryPath, skillDefinitionName);
  const stats = await lstatIfAvailable(skillFilePath);
  return stats?.isFile() === true ? skillFilePath : null;
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw filesystemError(path, error);
  }
}

async function lstatIfAvailable(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw filesystemError(path, error);
  }
}

async function statIfAvailable(
  path: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw filesystemError(path, error);
  }
}

async function lstatWithContext(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  return withFilesystemContext(path, lstat(path));
}

async function readlinkWithContext(path: string): Promise<string> {
  return withFilesystemContext(path, readlink(path));
}

async function readdirWithContext(path: string): Promise<Dirent[]> {
  return withFilesystemContext(path, readdir(path, { withFileTypes: true }));
}

async function withFilesystemContext<T>(
  path: string,
  operation: Promise<T>,
): Promise<T> {
  try {
    return await operation;
  } catch (error: unknown) {
    throw filesystemError(path, error);
  }
}

function filesystemError(path: string, cause: unknown): InventoryScanError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new InventoryScanError(
    "filesystem-unavailable",
    `cannot scan ${path}: ${detail}`,
    path,
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function pathComparisonKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function candidateComparisonKey(candidate: Candidate): Promise<string> {
  if (
    candidate.artifactType.kind === "directory" &&
    candidate.canonicalPath !== null
  ) {
    return `directory:${candidate.canonicalPath}`;
  }

  const stats = await lstatWithContext(candidate.path);
  if (stats.ino !== 0) {
    return `entry:${stats.dev}:${stats.ino}`;
  }
  return `entry-path:${pathComparisonKey(candidate.path)}`;
}

function rootClassificationKey(root: DiscoveryRoot): string {
  return stringifyModel({ ...root, path: "<discovery-root>" }, 0);
}

async function rootsDescribeSameBoundary(
  left: DiscoveryRoot,
  right: DiscoveryRoot,
): Promise<boolean> {
  if (rootClassificationKey(left) !== rootClassificationKey(right)) {
    return false;
  }
  if (pathComparisonKey(left.path) === pathComparisonKey(right.path)) {
    return true;
  }

  const [leftCanonicalPath, rightCanonicalPath] = await Promise.all([
    canonicalPath(left.path),
    canonicalPath(right.path),
  ]);
  return leftCanonicalPath !== null && leftCanonicalPath === rightCanonicalPath;
}

function portableRelativePath(rootPath: string, artifactPath: string): string {
  const value = relative(rootPath, artifactPath).split(sep).join("/");
  return value.length === 0 ? "." : value;
}

function compareRecordPath(
  left: Installation | NonInstallationFinding,
  right: Installation | NonInstallationFinding,
): number {
  return compareText(left.location.path, right.location.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
