import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseTree, type ParseError } from "jsonc-parser";

import {
  VERCEL_SKILLS_ADAPTER_HASH,
  VERCEL_SKILLS_ADAPTER_ID,
  VERCEL_SKILLS_EXECUTABLE,
  VERCEL_SKILLS_PACKAGE_NAME,
  VERCEL_SKILLS_PACKAGE_VERSION,
  vercelSkillsRemovalArguments,
} from "../adapter/built-ins.js";
import { parseWindowsReparseKind } from "../filesystem/windows-reparse.js";
import { resolvedArgumentSafetyIssue } from "../model/command-safety.js";
import { stringifyModel } from "../model/json.js";
import type {
  ArtifactLocation,
  Installation,
  InstallationId,
  JsonObject,
  ManagedRemovalEvidence,
  ProtectionStatus,
  Scope,
  Sha256Digest,
  StrongIdentityEvidence,
  SupplementalRemovalArtifact,
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
import {
  vercelAgentPaths,
  vercelCanonicalPath,
} from "./vercel-skills-paths.js";
import type {
  InventoryCommandRunner,
  InventoryScanEnvironment,
} from "./types.js";

const managerId = "vercel-skills";
const skillFileName = "SKILL.md";

interface LockDocument {
  readonly path: string;
  readonly format: "global" | "project";
  /** Whether the manager itself resolves this lock in the current environment. */
  readonly managerVisible: boolean;
  readonly scope: Scope;
  readonly bytes: Buffer;
  readonly location: ArtifactLocation;
  readonly value: Record<string, unknown>;
  readonly skills: Readonly<Record<string, Record<string, unknown>>>;
}

type LockReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly canonicalSkillsRoot: string }
  | { readonly kind: "valid"; readonly document: LockDocument };

interface LocatedArtifact {
  readonly agentId: string;
  readonly location: ArtifactLocation;
  readonly protection: ProtectionStatus;
}

export interface VercelSkillsScanResult {
  readonly installations: readonly Installation[];
  readonly invalidCanonicalRoots: readonly string[];
}

export async function scanVercelSkills(
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner,
): Promise<VercelSkillsScanResult> {
  const lockResults = await Promise.all([
    readGlobalLockDocument(environment),
    readLockDocument(
      join(environment.workspaceDirectory, "skills-lock.json"),
      "project",
      {
        kind: "workspace",
        workspacePath: environment.workspaceDirectory,
      },
      dirname(vercelCanonicalPath("project", environment, "placeholder")),
    ),
  ]);
  const locks = lockResults.flatMap((result) =>
    result.kind === "valid" ? [result.document] : [],
  );
  const invalidCanonicalRoots = lockResults.flatMap((result) =>
    result.kind === "invalid" ? [result.canonicalSkillsRoot] : [],
  );
  if (locks.length === 0) {
    return { installations: [], invalidCanonicalRoots };
  }

  const managerAvailable = await probeManager(commandRunner);
  const installations: Installation[] = [];
  for (const lock of locks) {
    const collisions = sanitizedCollisions(Object.keys(lock.skills));
    const lockLocation = lock.location;
    const lockProtection = await protectionFor(lockLocation, commandRunner);
    const expectedFileHash = digest(lock.bytes);
    for (const [lockKey, entry] of Object.entries(lock.skills).sort(
      ([left], [right]) => compareText(left, right),
    )) {
      installations.push(
        await materializeLockEntry({
          environment,
          commandRunner,
          managerAvailable,
          lock,
          lockLocation,
          lockProtection,
          expectedFileHash,
          lockKey,
          entry,
          collision: collisions.has(sanitizeInstallName(lockKey)),
        }),
      );
    }
  }
  return {
    installations: installations.sort(compareInstallation),
    invalidCanonicalRoots,
  };
}

async function materializeLockEntry(input: {
  readonly environment: InventoryScanEnvironment;
  readonly commandRunner: InventoryCommandRunner;
  readonly managerAvailable: boolean;
  readonly lock: LockDocument;
  readonly lockLocation: ArtifactLocation;
  readonly lockProtection: ProtectionStatus;
  readonly expectedFileHash: Sha256Digest;
  readonly lockKey: string;
  readonly entry: Record<string, unknown>;
  readonly collision: boolean;
}): Promise<Installation> {
  const sanitizedName = sanitizeInstallName(input.lockKey);
  const canonicalPath = vercelCanonicalPath(
    input.lock.format,
    input.environment,
    sanitizedName,
  );
  const artifacts = await locateArtifacts(
    input.lock.format,
    input.environment,
    canonicalPath,
    sanitizedName,
    input.commandRunner,
  );
  const topologyIssue = await unexpectedArtifactTopology(
    artifacts,
    canonicalPath,
    input.lock.format === "project"
      ? stringField(input.entry.computedHash)
      : null,
  );
  const artifactUnsafeReason = input.collision
    ? "sanitized Vercel skill keys collide on one artifact path"
    : topologyIssue;
  const selectorIssue = nativeSelectorIssue(input.lockKey);
  const managedUnsafeReason = artifactUnsafeReason ?? selectorIssue;
  const canonicalArtifact = artifacts.find(
    (artifact) => pathKey(artifact.location.path) === pathKey(canonicalPath),
  );
  const primary =
    (canonicalArtifact !== undefined && !isBroken(canonicalArtifact.location)
      ? canonicalArtifact
      : undefined) ??
    artifacts.find((artifact) => !isBroken(artifact.location)) ??
    canonicalArtifact ??
    artifacts[0];
  const primaryLocation =
    primary?.location ??
    ({
      path: canonicalPath,
      canonicalPath: null,
      artifactType: { kind: "directory" },
    } satisfies ArtifactLocation);
  const primaryProtection =
    primary?.protection ??
    (await protectionFor(primaryLocation, input.commandRunner, true));
  const supplementalArtifacts: SupplementalRemovalArtifact[] = artifacts
    .filter((artifact) => artifact !== primary)
    .map(({ location, protection }) => ({ location, protection }));
  const fallbackSkillName =
    input.lockKey.trim().length > 0 ? input.lockKey : sanitizedName;
  const metadata =
    artifactUnsafeReason === null
      ? await skillMetadata(primaryLocation, fallbackSkillName)
      : null;
  const sourceType = stringField(input.entry.sourceType);
  const sourceId = normalizedSourceId(
    stringField(input.entry.source),
    sourceType,
    input.lock,
    input.environment,
  );
  const sourceUrl = urlField(input.entry.sourceUrl);
  const skillPath = stringField(input.entry.skillPath);
  const pluginName = stringField(input.entry.pluginName);
  const status =
    artifactUnsafeReason !== null || metadata?.status === "unresolved"
      ? "unresolved"
      : primary === undefined || isBroken(primary.location)
        ? "broken"
        : "active";
  const strongEvidence: StrongIdentityEvidence[] = [];
  if (sourceId !== null && skillPath !== null) {
    strongEvidence.push({
      strength: "strong",
      kind: "source",
      sourceId,
      skillPath,
    });
  }
  if (primaryLocation.canonicalPath !== null) {
    strongEvidence.push({
      strength: "strong",
      kind: "canonical-target",
      canonicalPath: primaryLocation.canonicalPath,
    });
  }
  const weakEvidence: WeakIdentityEvidence[] = [
    {
      strength: "weak",
      kind: "name",
      normalizedName: (metadata?.skill.name ?? fallbackSkillName)
        .normalize("NFKC")
        .toLowerCase(),
    },
  ];
  const contentHash =
    artifactUnsafeReason !== null ||
    primary === undefined ||
    isBroken(primary.location)
      ? null
      : await hashSkillDirectory(primary.location.path);
  if (contentHash !== null) {
    weakEvidence.push({
      strength: "weak",
      kind: "content-hash",
      algorithm: "sha256",
      digest: contentHash,
    });
  }
  const recordPointer = `/skills/${escapePointer(input.lockKey)}`;
  const recordCleanup = {
    id: stableId(
      "vercel-skills-lock-record",
      pathKey(input.lock.path),
      input.lockKey,
    ),
    location: input.lockLocation,
    adapterId: VERCEL_SKILLS_ADAPTER_ID,
    format: "json" as const,
    recordPointer,
    expectedFileHash: input.expectedFileHash,
    expectedRecordHash: digest(
      Buffer.from(stringifyModel(input.entry, 0), "utf8"),
    ),
    protection: input.lockProtection,
  };
  const allArtifactPaths = [
    primaryLocation.path,
    ...supplementalArtifacts.map((artifact) => artifact.location.path),
  ];
  const managed = managedRemoval({
    environment: input.environment,
    scope: input.lock.format,
    lockVersion: numberField(input.lock.value.version)!,
    lockManagerVisible: input.lock.managerVisible,
    managerAvailable: input.managerAvailable,
    unsafeReason: managedUnsafeReason,
    externalId: input.lockKey,
    invocationExternalId:
      selectorIssue === null ? input.lockKey : sanitizedName,
    artifactPaths: allArtifactPaths,
    artifactProtections: new Map([
      [pathKey(primaryLocation.path), primaryProtection],
      ...supplementalArtifacts.map(
        (artifact) =>
          [pathKey(artifact.location.path), artifact.protection] as const,
      ),
    ]),
    lockPath: input.lock.path,
    lockProtection: input.lockProtection,
    recordPointer,
  });
  const agents = [
    ...new Set([
      ...artifacts.map((artifact) => artifact.agentId),
      ...declaredEveAgents(input.entry),
    ]),
  ];

  return {
    id: stableId(
      "installation",
      VERCEL_SKILLS_ADAPTER_ID,
      input.lock.format,
      input.lockKey,
    ) as InstallationId,
    classification: "active-installation",
    status,
    skill: metadata?.skill ?? { name: fallbackSkillName, description: null },
    identity: { strongEvidence, weakEvidence },
    source: sourceId === null ? null : { id: sourceId, url: sourceUrl },
    plugin: null,
    manager: { id: managerId },
    adapterId: VERCEL_SKILLS_ADAPTER_ID,
    pluginBoundaryId: null,
    agentId: managerId,
    scope: input.lock.scope,
    location: primaryLocation,
    contentHash,
    modifiedAt: await modifiedAt(primaryLocation),
    ownership: {
      kind: "manager",
      managerId,
      confidence: "declared",
    },
    protection: primaryProtection,
    removal: {
      managed,
      fallback:
        artifactUnsafeReason !== null
          ? {
              kind: "unavailable",
              reason: artifactUnsafeReason,
            }
          : { kind: "available", requiresSeparateConfirmation: true },
      primaryArtifactPresent: primary !== undefined,
      supplementalArtifacts,
      recordCleanups: artifactUnsafeReason === null ? [recordCleanup] : [],
    },
    tags: [sourceType, pluginName].filter(
      (value): value is string => value !== null,
    ),
    metadata: vercelMetadata({
      input,
      agents,
      sourceId,
      sourceUrl,
      sourceType,
      pluginName,
      skillPath,
      lockKey: input.lockKey,
      sanitizedName,
      stale: primary === undefined || isBroken(primary.location),
      mode: installationMode(artifacts, canonicalPath),
      topologyIssue,
    }),
  };
}

function managedRemoval(input: {
  readonly environment: InventoryScanEnvironment;
  readonly scope: "global" | "project";
  readonly lockVersion: number;
  readonly lockManagerVisible: boolean;
  readonly managerAvailable: boolean;
  readonly unsafeReason: string | null;
  readonly externalId: string;
  readonly invocationExternalId: string;
  readonly artifactPaths: readonly string[];
  readonly artifactProtections: ReadonlyMap<string, ProtectionStatus>;
  readonly lockPath: string;
  readonly lockProtection: ProtectionStatus;
  readonly recordPointer: string;
}): ManagedRemovalEvidence {
  const unavailableReason =
    input.unsafeReason !== null
      ? input.unsafeReason
      : !managerSupportsLockVersion(input.scope, input.lockVersion)
        ? `${input.scope} lock version ${String(input.lockVersion)} is not supported by skills@${VERCEL_SKILLS_PACKAGE_VERSION}`
        : !input.lockManagerVisible
          ? `the ${input.scope} lock is not the location skills@${VERCEL_SKILLS_PACKAGE_VERSION} resolves in this environment`
          : input.scope === "project" && !input.managerAvailable
            ? "project removal requires an installed skills manager"
            : input.scope === "global" &&
                !input.managerAvailable &&
                !supportsPinnedPackage(input.environment.nodeVersion)
              ? `skills@${VERCEL_SKILLS_PACKAGE_VERSION} requires Node.js 22.20 or newer`
              : null;
  const availability =
    unavailableReason === null
      ? ({ kind: "available" } as const)
      : ({ kind: "unavailable", reason: unavailableReason } as const);
  const invocation = input.managerAvailable
    ? {
        kind: "direct" as const,
        command: {
          executable: VERCEL_SKILLS_EXECUTABLE,
          arguments: vercelSkillsRemovalArguments(
            input.scope,
            input.invocationExternalId,
          ),
        },
        workingDirectory:
          input.scope === "project"
            ? {
                kind: "exact" as const,
                path: input.environment.workspaceDirectory,
              }
            : { kind: "isolated-temporary" as const },
      }
    : input.scope === "project"
      ? {
          kind: "direct" as const,
          command: {
            executable: VERCEL_SKILLS_EXECUTABLE,
            arguments: vercelSkillsRemovalArguments(
              input.scope,
              input.invocationExternalId,
            ),
          },
          workingDirectory: {
            kind: "exact" as const,
            path: input.environment.workspaceDirectory,
          },
        }
      : {
          kind: "ephemeral-package" as const,
          packageExecution: {
            runner: "npx" as const,
            packageName: VERCEL_SKILLS_PACKAGE_NAME,
            packageVersion: VERCEL_SKILLS_PACKAGE_VERSION,
            adapterHash: VERCEL_SKILLS_ADAPTER_HASH,
            mayDownload: true as const,
          },
          packageArguments: vercelSkillsRemovalArguments(
            input.scope,
            input.invocationExternalId,
          ),
        };
  const effects = [
    ...input.artifactPaths.map((path) => ({
      kind: "remove-path" as const,
      path,
      protection: input.artifactProtections.get(pathKey(path))!,
    })),
    {
      kind: "modify-path" as const,
      path: input.lockPath,
      protection: input.lockProtection,
    },
  ];
  return {
    adapterId: VERCEL_SKILLS_ADAPTER_ID,
    operationId: `remove-${input.scope}-skill`,
    availability,
    trust: { kind: "trusted" },
    externalId: input.externalId,
    invocation,
    effects,
    verifications: [
      ...input.artifactPaths.map((path) => ({
        kind: "path-absent" as const,
        path,
      })),
      {
        kind: "record-absent" as const,
        path: input.lockPath,
        format: "json" as const,
        recordPointer: input.recordPointer,
      },
    ],
  };
}

async function locateArtifacts(
  scope: "global" | "project",
  environment: InventoryScanEnvironment,
  canonicalPath: string,
  sanitizedName: string,
  commandRunner: InventoryCommandRunner,
): Promise<readonly LocatedArtifact[]> {
  const paths = new Map<string, { path: string; agentId: string }>();
  paths.set(pathKey(canonicalPath), {
    path: canonicalPath,
    agentId: "universal",
  });
  for (const candidate of await vercelAgentPaths(
    scope,
    environment,
    sanitizedName,
  )) {
    if (!paths.has(pathKey(candidate.path))) {
      paths.set(pathKey(candidate.path), candidate);
    }
  }
  if (scope === "project") {
    const subagentsRoot = join(
      environment.workspaceDirectory,
      "agent",
      "subagents",
    );
    const subagents = await readdir(subagentsRoot, {
      withFileTypes: true,
    }).catch(() => []);
    for (const subagent of subagents) {
      if (!subagent.isDirectory()) continue;
      const path = join(subagentsRoot, subagent.name, "skills", sanitizedName);
      paths.set(pathKey(path), { path, agentId: `eve:${subagent.name}` });
    }
  }

  const artifacts: LocatedArtifact[] = [];
  for (const candidate of [...paths.values()].sort((left, right) =>
    compareText(left.path, right.path),
  )) {
    const location = await artifactLocation(candidate.path, commandRunner);
    if (location === null) continue;
    artifacts.push({
      agentId: candidate.agentId,
      location,
      protection: await protectionFor(location, commandRunner),
    });
  }
  return artifacts;
}

async function artifactLocation(
  path: string,
  commandRunner: InventoryCommandRunner,
): Promise<ArtifactLocation | null> {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (pathStats.isSymbolicLink()) {
    const target = await readlink(path);
    const followed = await stat(path).catch(() => null);
    const linkKind = await linkArtifactType(path, target, commandRunner);
    return {
      path,
      canonicalPath:
        followed?.isDirectory() === true ? await realpath(path) : null,
      artifactType: {
        kind: linkKind,
        target,
        broken: followed === null,
      },
    };
  }
  if (!pathStats.isDirectory()) return null;
  return {
    path,
    canonicalPath: await realpath(path),
    artifactType: { kind: "directory" },
  };
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

async function skillMetadata(location: ArtifactLocation, fallbackName: string) {
  if (isBroken(location)) return null;
  const skillPath = join(location.path, skillFileName);
  const skillStats = await lstat(skillPath).catch(() => null);
  return skillStats?.isFile() === true
    ? readSkillMetadata(skillPath, fallbackName)
    : null;
}

async function modifiedAt(location: ArtifactLocation): Promise<string | null> {
  const pathStats = await lstat(location.path).catch(() => null);
  return pathStats === null || !Number.isFinite(pathStats.mtimeMs)
    ? null
    : pathStats.mtime.toISOString();
}

async function readLockDocument(
  path: string,
  format: LockDocument["format"],
  scope: Scope,
  canonicalSkillsRoot: string,
  managerVisible = true,
): Promise<LockReadResult> {
  const initialStats = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (initialStats === null) return { kind: "absent" };
  const file = await readStableRegularFile(path, initialStats);
  if (file === null) return { kind: "invalid", canonicalSkillsRoot };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return { kind: "invalid", canonicalSkillsRoot };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", canonicalSkillsRoot };
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (tree === undefined || errors.length > 0 || hasDuplicateKeys(tree)) {
    return { kind: "invalid", canonicalSkillsRoot };
  }
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !Number.isFinite(value.version) ||
    !isRecord(value.skills)
  ) {
    return { kind: "invalid", canonicalSkillsRoot };
  }
  const skills = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [key, entry] of Object.entries(value.skills)) {
    if (key.length === 0 || !isRecord(entry)) {
      return { kind: "invalid", canonicalSkillsRoot };
    }
    skills[key] = entry;
  }
  return {
    kind: "valid",
    document: {
      path,
      format,
      managerVisible,
      scope,
      bytes: file.bytes,
      location: {
        path,
        canonicalPath: file.canonicalPath,
        artifactType: { kind: "file" },
      },
      value,
      skills,
    },
  };
}

/**
 * Reads the first global lock present, preferring the manager-resolved one.
 *
 * A malformed lock at a candidate location is reported rather than skipped, so
 * an unreadable authoritative lock never silently promotes a stale one.
 */
async function readGlobalLockDocument(
  environment: InventoryScanEnvironment,
): Promise<LockReadResult> {
  const canonicalSkillsRoot = dirname(
    vercelCanonicalPath("global", environment, "placeholder"),
  );
  let absent: LockReadResult = { kind: "absent" };
  for (const candidate of globalLockCandidates(environment)) {
    const result = await readLockDocument(
      candidate.path,
      "global",
      { kind: "user" },
      canonicalSkillsRoot,
      candidate.managerVisible,
    );
    if (result.kind !== "absent") return result;
    absent = result;
  }
  return absent;
}

/**
 * The global lock locations, most authoritative first.
 *
 * `skills@1.5.22` resolves exactly one of these: the `XDG_STATE_HOME` location
 * when that variable is set, and the home-relative one when it is not. A lock
 * written under a different environment therefore remains on disk while the
 * manager cannot see it. Discovery reads either, because the Skills are really
 * installed; only the manager-resolved lock carries removal authority.
 */
function globalLockCandidates(
  environment: InventoryScanEnvironment,
): readonly { readonly path: string; readonly managerVisible: boolean }[] {
  const homeRelative = join(
    environment.homeDirectory,
    ".agents",
    ".skill-lock.json",
  );
  const stateDirectory = environment.stateDirectory;
  if (stateDirectory === undefined || stateDirectory === null) {
    return [{ path: homeRelative, managerVisible: true }];
  }
  return [
    {
      path: join(stateDirectory, "skills", ".skill-lock.json"),
      managerVisible: true,
    },
    { path: homeRelative, managerVisible: false },
  ];
}

async function probeManager(
  commandRunner: InventoryCommandRunner,
): Promise<boolean> {
  try {
    const result = await commandRunner.run({
      executable: VERCEL_SKILLS_EXECUTABLE,
      arguments: ["--version"],
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function supportsPinnedPackage(nodeVersion: string | undefined): boolean {
  const [major = 0, minor = 0] = (nodeVersion ?? process.versions.node)
    .split(".")
    .map(Number);
  return major > 22 || (major === 22 && minor >= 20);
}

function managerSupportsLockVersion(
  scope: "global" | "project",
  version: number,
): boolean {
  return scope === "global" ? version >= 3 : version >= 1;
}

function nativeSelectorIssue(lockKey: string): string | null {
  if (lockKey.startsWith("-")) {
    return "Vercel skill key would be parsed as a command option";
  }
  return resolvedArgumentSafetyIssue(lockKey);
}

function sanitizedCollisions(keys: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const sanitized = sanitizeInstallName(key);
    counts.set(sanitized, (counts.get(sanitized) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  );
}

export function sanitizeInstallName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 255) || "unnamed-skill"
  );
}

function vercelMetadata(input: {
  readonly input: {
    readonly lock: LockDocument;
    readonly entry: Record<string, unknown>;
  };
  readonly agents: readonly string[];
  readonly sourceId: string | null;
  readonly sourceUrl: string | null;
  readonly sourceType: string | null;
  readonly pluginName: string | null;
  readonly skillPath: string | null;
  readonly lockKey: string;
  readonly sanitizedName: string;
  readonly stale: boolean;
  readonly mode: string;
  readonly topologyIssue: string | null;
}): JsonObject {
  return {
    "vercel-skills": {
      lockFormat: input.input.lock.format,
      lockVersion: numberField(input.input.lock.value.version),
      lockKey: input.lockKey,
      sanitizedName: input.sanitizedName,
      scope: input.input.lock.format,
      source: input.sourceId,
      sourceUrl: input.sourceUrl,
      sourceGroupId:
        input.sourceId === null
          ? null
          : stableId(
              "vercel-source-group",
              stringifyModel(input.input.lock.scope, 0),
              input.sourceId,
            ),
      sourceType: input.sourceType,
      pluginName: input.pluginName,
      pluginGroupId:
        input.sourceId === null || input.pluginName === null
          ? null
          : stableId(
              "vercel-plugin-group",
              stringifyModel(input.input.lock.scope, 0),
              input.sourceId,
              input.pluginName,
            ),
      skillPath: input.skillPath,
      agents: [...input.agents].sort(compareText),
      installMode: input.mode,
      topologyIssue: input.topologyIssue,
      stale: input.stale,
      ref: stringField(input.input.entry.ref),
      sourceBaseUrl: stringField(input.input.entry.sourceBaseUrl),
      wellKnownDigest: stringField(input.input.entry.wellKnownDigest),
    },
  };
}

function installationMode(
  artifacts: readonly LocatedArtifact[],
  canonicalPath: string,
): string {
  const canonical = artifacts.find(
    (artifact) => pathKey(artifact.location.path) === pathKey(canonicalPath),
  );
  if (artifacts.length === 0) return "stale-lock";
  if (artifacts.every((artifact) => isBroken(artifact.location))) {
    return "broken-link";
  }
  if (canonical === undefined) return "copy";
  return artifacts.some(
    (artifact) =>
      artifact !== canonical &&
      (artifact.location.artifactType.kind === "symbolic-link" ||
        artifact.location.artifactType.kind === "junction"),
  )
    ? "link"
    : "canonical";
}

async function unexpectedArtifactTopology(
  artifacts: readonly LocatedArtifact[],
  canonicalPath: string,
  expectedCopyHash: string | null,
): Promise<string | null> {
  const resolvedCanonicalPath = await realpath(canonicalPath).catch(() => null);
  for (const artifact of artifacts) {
    const type = artifact.location.artifactType;
    if (type.kind === "symbolic-link" || type.kind === "junction") {
      const linkTarget = resolve(
        dirname(artifact.location.path),
        normalizeWindowsNamespacePath(type.target),
      );
      const targetsCanonicalPath =
        resolvedCanonicalPath !== null &&
        artifact.location.canonicalPath !== null
          ? pathKey(artifact.location.canonicalPath) ===
            pathKey(resolvedCanonicalPath)
          : pathKey(linkTarget) === pathKey(canonicalPath);
      if (
        pathKey(artifact.location.path) === pathKey(canonicalPath) ||
        !targetsCanonicalPath
      ) {
        return `unexpected Vercel-managed link target: ${artifact.location.path}`;
      }
    } else if (
      type.kind === "directory" &&
      pathKey(artifact.location.path) !== pathKey(canonicalPath) &&
      expectedCopyHash !== null
    ) {
      if (!/^[a-f\d]{64}$/i.test(expectedCopyHash)) {
        return "invalid Vercel project copy hash";
      }
      const actualHash = await hashVercelSkillCopy(artifact.location.path);
      if (actualHash !== expectedCopyHash.toLowerCase()) {
        return `Vercel project copy hash changed: ${artifact.location.path}`;
      }
    }
  }
  return null;
}

async function hashVercelSkillCopy(directoryPath: string): Promise<string> {
  const files: { relativePath: string; content: Buffer }[] = [];
  await collectVercelSkillFiles(directoryPath, directoryPath, files);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

async function collectVercelSkillFiles(
  rootPath: string,
  directoryPath: string,
  files: { relativePath: string; content: Buffer }[],
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== ".git" && entry.name !== "node_modules") {
        await collectVercelSkillFiles(rootPath, path, files);
      }
    } else if (entry.isFile()) {
      files.push({
        relativePath: relative(rootPath, path).split(sep).join("/"),
        content: await readFile(path),
      });
    }
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function declaredEveAgents(entry: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(entry.subagents)) return [];
  return entry.subagents.flatMap((value) =>
    typeof value !== "string"
      ? []
      : [value.length === 0 ? "eve" : `eve:${value}`],
  );
}

function normalizedSourceId(
  sourceId: string | null,
  sourceType: string | null,
  lock: LockDocument,
  environment: InventoryScanEnvironment,
): string | null {
  if (
    sourceId === null ||
    sourceType !== "local" ||
    lock.format !== "project" ||
    isAbsolute(sourceId)
  ) {
    return sourceId;
  }
  return resolve(environment.workspaceDirectory, sourceId);
}

function urlField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBroken(location: ArtifactLocation): boolean {
  return (
    (location.artifactType.kind === "symbolic-link" ||
      location.artifactType.kind === "junction") &&
    location.artifactType.broken
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeWindowsNamespacePath(path: string): string {
  if (process.platform !== "win32") return path;
  if (path.toLowerCase().startsWith("\\\\?\\unc\\")) {
    return `\\\\${path.slice(8)}`;
  }
  if (path.startsWith("\\\\?\\") || path.startsWith("\\??\\")) {
    return path.slice(4);
  }
  return path;
}

function compareInstallation(left: Installation, right: Installation): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
