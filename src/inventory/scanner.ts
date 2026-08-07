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
import type { CompiledAdapter, CompiledAdapterRoot } from "../adapter/types.js";
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
import { applyAdapterManifests } from "./adapter-runtime.js";
import { inspectGitProtection } from "./git-protection.js";
import {
  createWeakIdentityHints,
  groupInstallations,
  stableId,
} from "./identity.js";
import { readSkillMetadata, type ParsedSkillMetadata } from "./metadata.js";
import { systemCommandRunner } from "./process.js";
import { parseScanRequest } from "./request-schema.js";
import { scanClaudeCodePlugins } from "./claude-code-plugins.js";
import { scanCodexPlugins } from "./codex-plugins.js";
import { scanGeminiCli } from "./gemini-cli.js";
import { scanVercelSkills } from "./vercel-skills.js";
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
  const homeDirectory = homedir();
  return scanWithOptions(request, {
    now: () => new Date(),
    environment: {
      homeDirectory,
      workspaceDirectory: process.cwd(),
      configDirectory:
        process.env.XDG_CONFIG_HOME || join(homeDirectory, ".config"),
      stateDirectory: process.env.XDG_STATE_HOME || null,
      nodeVersion: process.versions.node,
      agentHomeDirectories: Object.fromEntries(
        [
          ["autohand-code", process.env.AUTOHAND_HOME],
          ["claude-code", process.env.CLAUDE_CONFIG_DIR],
          ["codex", process.env.CODEX_HOME],
          ["grok", process.env.GROK_HOME],
          ["hermes-agent", process.env.HERMES_HOME],
          ["mistral-vibe", process.env.VIBE_HOME],
        ].flatMap(([agentId, path]) =>
          typeof path === "string" && path.trim().length > 0
            ? [[agentId, path]]
            : [],
        ),
      ),
    },
    commandRunner: systemCommandRunner,
  });
}

async function scanWithOptions(
  request: ScanRequest,
  options: InventoryScannerOptions,
): Promise<Inventory> {
  const { roots: requestRoots, explicitRootKeys } =
    await validateAndNormalizeRequest(request, options);
  if (
    options.adapterCatalog?.adapters.some((adapter) =>
      requestRoots.some((root) => root.adapterId === adapter.id),
    )
  ) {
    throw new InventoryScanError(
      "invalid-request",
      "scan request roots cannot claim adapter catalog provenance",
    );
  }
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
  const adapterRoots = await adapterDiscoveryRoots(options);
  const roots = validateAndNormalizeAdapterRoots(
    [...requestRoots, ...adapterRoots.roots],
    options,
  );

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
        const preferred = moreSpecificRoot(
          existing.root,
          candidate.root,
          explicitRootKeys,
        );
        if (preferred === null) {
          throw new InventoryScanError(
            "invalid-request",
            `overlapping discovery roots classify ${candidate.path} differently`,
            candidate.path,
          );
        }
        if (preferred === candidate.root) {
          candidatesByPath.set(key, candidate);
        }
        continue;
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
  const genericInstallations = records
    .filter(isInstallation)
    .sort(compareRecordPath);
  const otherFindings = records.filter(isOtherFinding).sort(compareRecordPath);
  const vercel = await scanVercelSkills(
    options.environment,
    options.commandRunner,
  );
  const claudeCode = await scanClaudeCodePlugins(
    options.environment,
    options.commandRunner,
  );
  const codex = await scanCodexPlugins(
    options.environment,
    options.commandRunner,
  );
  const gemini = await scanGeminiCli(
    options.environment,
    options.commandRunner,
  );
  const geminiInstallations = gemini.installations.filter(
    (installation) =>
      !vercel.invalidCanonicalRoots.some((root) =>
        pathIsWithin(root, installation.location.path),
      ) &&
      !vercel.installations.some(
        (claimed) =>
          pathComparisonKey(claimed.location.path) ===
            pathComparisonKey(installation.location.path) ||
          (claimed.location.canonicalPath !== null &&
            installation.location.canonicalPath !== null &&
            pathComparisonKey(claimed.location.canonicalPath) ===
              pathComparisonKey(installation.location.canonicalPath)),
      ),
  );
  const reconciledGenericInstallations = genericInstallations.map(
    (installation) =>
      vercel.invalidCanonicalRoots.some((root) =>
        pathIsWithin(root, installation.location.path),
      )
        ? blockForInvalidVercelLock(installation)
        : installation,
  );
  const claimedPaths = new Set(
    [
      ...vercel.installations,
      ...claudeCode.installations,
      ...codex.installations,
      ...geminiInstallations,
    ].flatMap((installation) => [
      pathComparisonKey(installation.location.path),
      ...(installation.removal.supplementalArtifacts ?? []).map((artifact) =>
        pathComparisonKey(artifact.location.path),
      ),
    ]),
  );
  const adapterEvidence = await applyAdapterManifests(
    [
      ...reconciledGenericInstallations.filter(
        (installation) =>
          !claimedPaths.has(pathComparisonKey(installation.location.path)),
      ),
      ...vercel.installations,
      ...claudeCode.installations,
      ...codex.installations,
      ...geminiInstallations,
    ].sort(compareRecordPath),
    options.adapterCatalog,
    options.commandRunner,
    adapterRoots.probes,
    adapterRoots.rootIds,
  );
  const installations = adapterEvidence.installations;
  const logicalSkills = groupInstallations(installations);
  const identityHints = createWeakIdentityHints(installations, logicalSkills);
  const adapterPluginInstallationIds = new Set(
    [
      ...claudeCode.installations,
      ...codex.installations,
      ...geminiInstallations,
    ].map((installation) => installation.id),
  );
  const genericPlugins = await createPluginBoundaries(
    installations.filter(
      (installation) => !adapterPluginInstallationIds.has(installation.id),
    ),
    roots,
    options.commandRunner,
  );
  const plugins = [
    ...genericPlugins,
    ...claudeCode.plugins,
    ...codex.plugins,
    ...gemini.plugins,
  ].sort((left, right) => compareText(left.id, right.id));
  const snapshot = {
    installations,
    otherFindings: [
      ...otherFindings,
      ...claudeCode.otherFindings,
      ...codex.otherFindings,
    ].sort(compareRecordPath),
    logicalSkills,
    identityHints,
    plugins,
    dependencies: adapterEvidence.dependencies,
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

function blockForInvalidVercelLock(installation: Installation): Installation {
  return {
    ...installation,
    status: "unresolved",
    manager: null,
    plugin: null,
    adapterId: null,
    pluginBoundaryId: null,
    ownership: { kind: "unknown", confidence: "unknown" },
    removal: {
      managed: null,
      fallback: {
        kind: "unavailable",
        reason: "the Vercel skills lock is invalid or unsafe to read",
      },
      supplementalArtifacts: [],
      recordCleanups: [],
    },
    metadata: {
      ...installation.metadata,
      "vercel-skills": { lockState: "invalid" },
    },
  };
}

/**
 * Resolves two roots that classify one path differently.
 *
 * A root declared strictly inside another describes a narrower boundary and
 * wins, which is how a marked runtime subtree overrides the ordinary agent root
 * containing it. Roots that do not contain one another remain a contradiction
 * the caller must fix, so the overlap check keeps its meaning.
 */
function moreSpecificRoot(
  left: DiscoveryRoot,
  right: DiscoveryRoot,
  explicitRootKeys: ReadonlySet<string>,
): DiscoveryRoot | null {
  if (pathComparisonKey(left.path) === pathComparisonKey(right.path)) {
    return null;
  }
  const [outer, inner] = pathIsWithin(left.path, right.path)
    ? ([left, right] as const)
    : pathIsWithin(right.path, left.path)
      ? ([right, left] as const)
      : ([null, null] as const);
  if (outer === null || inner === null) {
    return null;
  }
  // A declared root may narrow only toward protection. Widening what is
  // removable requires a root the caller supplied for this invocation.
  if (
    !explicitRootKeys.has(pathComparisonKey(inner.path)) &&
    rootWithholdsRemoval(outer) &&
    !rootWithholdsRemoval(inner)
  ) {
    return null;
  }
  return inner;
}

/** Whether a root's findings are kept outside ordinary removal candidates. */
function rootWithholdsRemoval(root: DiscoveryRoot): boolean {
  return (
    root.kind === "source" ||
    root.kind === "cache-or-vendor" ||
    root.kind === "system" ||
    root.kind === "unknown"
  );
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

interface NormalizedRequestRoots {
  readonly roots: readonly DiscoveryRoot[];
  /** Paths the caller supplied for this invocation, not declared evidence. */
  readonly explicitRootKeys: ReadonlySet<string>;
}

async function validateAndNormalizeRequest(
  request: ScanRequest,
  options: InventoryScannerOptions,
): Promise<NormalizedRequestRoots> {
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
    ...(await defaultDiscoveryRoots(options.environment)),
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

  return {
    roots: roots.sort((left, right) =>
      compareText(
        `${pathComparisonKey(left.path)}\0${left.kind}`,
        `${pathComparisonKey(right.path)}\0${right.kind}`,
      ),
    ),
    explicitRootKeys: new Set(
      (parsedRequest.roots ?? []).map((root) => pathComparisonKey(root.path)),
    ),
  };
}

function validateEnvironment(options: InventoryScannerOptions): void {
  if (
    options.environment === undefined ||
    !isAbsolute(options.environment.homeDirectory) ||
    !isAbsolute(options.environment.workspaceDirectory) ||
    (options.environment.configDirectory !== undefined &&
      !isAbsolute(options.environment.configDirectory)) ||
    (options.environment.stateDirectory !== undefined &&
      options.environment.stateDirectory !== null &&
      !isAbsolute(options.environment.stateDirectory)) ||
    Object.values(options.environment.agentHomeDirectories ?? {}).some(
      (path) => !isAbsolute(path),
    )
  ) {
    throw new InventoryScanError(
      "invalid-request",
      "inventory scanner requires absolute configured environment directories",
    );
  }
  if (typeof options.commandRunner?.run !== "function") {
    throw new InventoryScanError(
      "invalid-request",
      "inventory scanner requires a command runner",
    );
  }
}

/**
 * Skills that Codex ships with its own runtime.
 *
 * Codex marks the subtree itself, so the boundary is declared by the runtime
 * rather than inferred from a directory name. Without the marker the subtree
 * stays an ordinary part of the agent root: a missing marker must never hide a
 * user's own Skills.
 */
const codexSystemSkillsDirectoryName = ".system";
const codexSystemSkillsMarkerName = ".codex-system-skills.marker";

async function defaultDiscoveryRoots(
  environment: InventoryScannerOptions["environment"],
): Promise<readonly DiscoveryRoot[]> {
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
  const codexRoot: DiscoveryRoot = {
    kind: "agent",
    path: join(
      environment.agentHomeDirectories?.codex ??
        join(environment.homeDirectory, ".codex"),
      "skills",
    ),
    agentId: "codex",
    adapterId: null,
  };
  const claudeConfigDirectory =
    environment.agentHomeDirectories?.["claude-code"] ??
    join(environment.homeDirectory, ".claude");
  const claudeUserRoot: DiscoveryRoot = {
    kind: "agent",
    path: join(claudeConfigDirectory, "skills"),
    agentId: "claude-code",
    adapterId: null,
  };
  const claudeWorkspaceRoot: DiscoveryRoot = {
    kind: "workspace",
    path: join(environment.workspaceDirectory, ".claude", "skills"),
    workspacePath: environment.workspaceDirectory,
    agentId: "claude-code",
    adapterId: null,
  };
  const codexSystemPath = join(codexRoot.path, codexSystemSkillsDirectoryName);
  const codexSystemRoots: readonly DiscoveryRoot[] = (await isRegularFile(
    join(codexSystemPath, codexSystemSkillsMarkerName),
  ))
    ? [
        {
          kind: "system",
          path: codexSystemPath,
          agentId: "codex",
          adapterId: null,
        },
      ]
    : [];
  const genericRoots =
    pathComparisonKey(userRoot.path) === pathComparisonKey(workspaceRoot.path)
      ? [workspaceRoot]
      : [userRoot, workspaceRoot];
  return [
    ...genericRoots,
    codexRoot,
    ...codexSystemRoots,
    claudeUserRoot,
    claudeWorkspaceRoot,
  ];
}

/**
 * A marker must be a regular file, never a link, so a planted link cannot make
 * the scanner treat a user's Skills as inseparable runtime content.
 */
async function isRegularFile(path: string): Promise<boolean> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  return stats !== null && stats.isFile();
}

async function adapterDiscoveryRoots(
  options: InventoryScannerOptions,
): Promise<{
  readonly roots: readonly DiscoveryRoot[];
  readonly probes: ReadonlyMap<string, ReadonlySet<string>>;
  /** Roots admitted by probe and canonical-boundary checks. */
  readonly rootIds: ReadonlyMap<string, ReadonlySet<string>>;
}> {
  const catalog = options.adapterCatalog;
  if (catalog === undefined)
    return { roots: [], probes: new Map(), rootIds: new Map() };
  const roots: DiscoveryRoot[] = [];
  const probeResults = new Map<string, ReadonlySet<string>>();
  const activeRootIds = new Map<string, ReadonlySet<string>>();
  const catalogRootPaths = new Set<string>();
  const canonicalCatalogRootPaths = new Set<string>();
  for (const adapter of catalog.adapters) {
    const adapterRootIds = new Set<string>();
    const probes = await adapterProbeResults(
      adapter,
      options.commandRunner,
      options.executablePresent ?? executablePresent,
    );
    probeResults.set(adapter.id, probes);
    for (const root of adapter.roots) {
      if (!(root.requiresProbes ?? []).every((id) => probes.has(id))) continue;
      const key = pathComparisonKey(root.path);
      if (catalogRootPaths.has(key)) {
        throw new InventoryScanError(
          "invalid-request",
          `duplicate adapter discovery root: ${root.path}`,
          root.path,
        );
      }
      catalogRootPaths.add(key);
      // Preserve root.path for discovery and contextual command values, while
      // rejecting a parent link/junction that takes this declared root outside
      // of the path-template base selected at compilation time.
      if (!(await canonicallyWithinAdapterBase(root.path, root.pathBase)))
        continue;
      const canonicalPath = pathComparisonKey(await realpath(root.path));
      if (canonicalCatalogRootPaths.has(canonicalPath)) {
        throw new InventoryScanError(
          "invalid-request",
          `duplicate canonical adapter discovery root: ${root.path}`,
          root.path,
        );
      }
      canonicalCatalogRootPaths.add(canonicalPath);
      const converted = adapterRoot(root, adapter.id);
      if (converted !== null) {
        const overlap = roots.find(
          (existing) =>
            pathIsWithin(existing.path, converted.path) ||
            pathIsWithin(converted.path, existing.path),
        );
        if (overlap !== undefined) {
          throw new InventoryScanError(
            "invalid-request",
            `overlapping adapter discovery roots: ${overlap.path} and ${root.path}`,
            root.path,
          );
        }
        roots.push(converted);
        adapterRootIds.add(root.id);
      }
    }
    activeRootIds.set(adapter.id, adapterRootIds);
  }
  return { roots, probes: probeResults, rootIds: activeRootIds };
}

async function adapterProbeResults(
  adapter: CompiledAdapter,
  commandRunner: InventoryCommandRunner,
  executableExists: (executable: string) => Promise<boolean>,
): Promise<ReadonlySet<string>> {
  const available = new Set<string>();
  for (const probe of adapter.probes) {
    if (probe.kind === "path") {
      const stats = await lstatIfAvailable(probe.path);
      if (
        stats !== null &&
        (probe.pathType === "directory" ? stats.isDirectory() : stats.isFile())
      ) {
        available.add(probe.id);
      }
      continue;
    }
    if (probe.kind === "executable") {
      if (await executableExists(probe.executable)) available.add(probe.id);
      continue;
    }
    // Probe commands cannot consume installation values. The adapter compiler
    // has already rejected unsafe command structure; value placeholders remain
    // unavailable in this pre-discovery context and therefore fail closed.
    if (probe.command.arguments.some((argument) => argument.kind === "value")) {
      continue;
    }
    const result = await commandRunner.run({
      executable: probe.command.executable,
      arguments: probe.command.arguments.map((argument) =>
        argument.kind === "literal" ? argument.value : "",
      ),
    });
    if (probe.successExitCodes.includes(result.exitCode ?? -1)) {
      available.add(probe.id);
    }
  }
  return available;
}

async function canonicallyWithinAdapterBase(
  path: string,
  base: string,
): Promise<boolean> {
  try {
    return pathIsWithin(await realpath(base), await realpath(path));
  } catch {
    return false;
  }
}

async function executablePresent(executable: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of pathValue.split(
    process.platform === "win32" ? ";" : ":",
  )) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      try {
        await access(
          join(directory, `${executable}${extension}`),
          constants.X_OK,
        );
        return true;
      } catch {
        /* continue */
      }
    }
  }
  return false;
}

function adapterRoot(
  root: CompiledAdapterRoot,
  adapterId: string,
): DiscoveryRoot | null {
  const scope = root.scope ?? null;
  const agentId = root.agentId;
  switch (root.kind) {
    case "user":
    case "agent":
      return agentId === null || agentId === undefined
        ? null
        : { kind: root.kind, path: root.path, agentId, adapterId };
    case "workspace":
      return agentId === null ||
        agentId === undefined ||
        root.workspacePath === undefined
        ? null
        : {
            kind: "workspace",
            path: root.path,
            workspacePath: root.workspacePath,
            agentId,
            adapterId,
          };
    case "plugin":
      return agentId === null ||
        agentId === undefined ||
        root.plugin === undefined ||
        scope === null
        ? null
        : {
            kind: "plugin",
            path: root.path,
            agentId,
            scope,
            plugin: root.plugin,
            independentlySelectable: root.independentlySelectable ?? false,
            adapterId,
          };
    case "source":
      return root.source === undefined
        ? null
        : {
            kind: "source",
            path: root.path,
            agentId: agentId ?? null,
            scope,
            source: root.source,
            adapterId,
          };
    case "cache-or-vendor":
    case "unknown":
      return {
        kind: root.kind,
        path: root.path,
        agentId: agentId ?? null,
        scope,
        adapterId,
      };
    case "system":
      return agentId === null || agentId === undefined
        ? null
        : { kind: "system", path: root.path, agentId, adapterId };
  }
}

function validateAndNormalizeAdapterRoots(
  roots: readonly DiscoveryRoot[],
  options: InventoryScannerOptions,
): readonly DiscoveryRoot[] {
  const seen = new Map<string, DiscoveryRoot>();
  for (const root of roots) {
    const key = pathComparisonKey(root.path);
    const existing = seen.get(key);
    // An adapter may replace the equivalent generic default boundary. Keep the
    // adapter root so its bounded manifest can strengthen the already-generic
    // discovery; two adapters are still an explicit conflict.
    if (
      existing !== undefined &&
      existing.adapterId === null &&
      root.adapterId !== null &&
      equivalentRootBoundary(existing, root)
    ) {
      seen.set(key, root);
      continue;
    }
    if (
      existing !== undefined &&
      (rootClassificationKey(existing) !== rootClassificationKey(root) ||
        (existing.adapterId !== null && root.adapterId !== null))
    ) {
      throw new InventoryScanError(
        "invalid-request",
        `conflicting adapter discovery root: ${root.path}`,
        root.path,
      );
    }
    if (existing === undefined) seen.set(key, root);
  }
  void options;
  return [...seen.values()].sort((left, right) =>
    compareText(
      `${pathComparisonKey(left.path)}\0${left.kind}`,
      `${pathComparisonKey(right.path)}\0${right.kind}`,
    ),
  );
}

function equivalentRootBoundary(
  left: DiscoveryRoot,
  right: DiscoveryRoot,
): boolean {
  return (
    rootClassificationKey({ ...left, adapterId: null }) ===
    rootClassificationKey({ ...right, adapterId: null })
  );
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
      supplementalArtifacts: [],
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
        supplementalArtifacts: [],
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
