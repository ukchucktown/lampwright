import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { builtInAdapterSources } from "./built-ins.js";
import { validateCommandSafety } from "./commands.js";
import { compileAdapter, createCatalog } from "./compile.js";
import { parseJsoncAdapter } from "./jsonc.js";
import { validateAdapterDefinition } from "./schema.js";
import type {
  AdapterCatalog,
  AdapterDefinitionV1,
  AdapterLoadRequest,
  AdapterPathBase,
  AdapterPathBases,
  AdapterPlatform,
  AdapterTrustApproval,
  AdapterTrustRequirement,
  CompiledAdapter,
  CompiledAdapterSource,
} from "./types.js";
import { AdapterLoadError, AdapterTrustRequiredError } from "./types.js";

interface LoadedDefinition {
  readonly definition: AdapterDefinitionV1;
  readonly source: CompiledAdapterSource;
}

const adapterPlatforms = new Set<AdapterPlatform>(["darwin", "linux", "win32"]);
const pathBaseNames: readonly AdapterPathBase[] = [
  "home",
  "workspace",
  "config",
  "state",
  "cache",
  "temporary",
];

export async function loadAdapters(
  request: AdapterLoadRequest,
): Promise<AdapterCatalog> {
  const normalized = normalizeRequest(request);
  const loaded = await loadDefinitions(normalized.localAdapterPaths);
  rejectDuplicateAdapterIds(loaded);

  const adapters: CompiledAdapter[] = [];
  const trustRequirements: AdapterTrustRequirement[] = [];
  for (const item of loaded) {
    validateCommandSafety(item.definition, sourcePath(item.source));
    const adapter = compileAdapter({
      definition: item.definition,
      source: item.source,
      platform: normalized.platform,
      pathBases: normalized.pathBases,
      approvals: normalized.approvals,
    });
    if (adapter === null) {
      continue;
    }
    if (
      adapter.commandCapable &&
      adapter.source.kind === "local" &&
      adapter.trust.kind !== "approved"
    ) {
      trustRequirements.push({
        adapterId: adapter.id,
        contentHash: adapter.source.contentHash,
        path: adapter.source.path,
      });
    }
    adapters.push(adapter);
  }

  if (trustRequirements.length > 0) {
    throw new AdapterTrustRequiredError(
      trustRequirements.sort((left, right) =>
        compareText(
          `${left.adapterId}\0${left.path}`,
          `${right.adapterId}\0${right.path}`,
        ),
      ),
    );
  }
  return createCatalog(normalized.platform, adapters);
}

interface NormalizedRequest {
  readonly localAdapterPaths: readonly string[];
  readonly platform: AdapterPlatform;
  readonly pathBases: AdapterPathBases;
  readonly approvals: readonly AdapterTrustApproval[];
}

function normalizeRequest(request: AdapterLoadRequest): NormalizedRequest {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new AdapterLoadError(
      "invalid-request",
      "adapter load request must be an object",
    );
  }
  const platform = request.platform ?? currentAdapterPlatform();
  if (!adapterPlatforms.has(platform)) {
    throw new AdapterLoadError(
      "invalid-request",
      `unsupported adapter platform: ${String(platform)}`,
    );
  }

  const localAdapterPaths = request.localAdapterPaths ?? [];
  if (
    !Array.isArray(localAdapterPaths) ||
    localAdapterPaths.some(
      (path) => typeof path !== "string" || path.trim().length === 0,
    )
  ) {
    throw new AdapterLoadError(
      "invalid-request",
      "localAdapterPaths must contain nonblank filesystem paths",
    );
  }
  const approvals = request.approvals ?? [];
  if (
    !Array.isArray(approvals) ||
    approvals.some(
      (approval) =>
        typeof approval !== "object" ||
        approval === null ||
        typeof approval.adapterId !== "string" ||
        approval.adapterId.trim().length === 0 ||
        typeof approval.contentHash !== "string" ||
        !/^[a-f\d]{64}$/.test(approval.contentHash),
    )
  ) {
    throw new AdapterLoadError(
      "invalid-request",
      "approvals must contain adapter IDs and lowercase SHA-256 hashes",
    );
  }

  return {
    localAdapterPaths,
    platform,
    pathBases: resolvePathBases(platform, request.pathBases),
    approvals,
  };
}

async function loadDefinitions(
  localAdapterPaths: readonly string[],
): Promise<readonly LoadedDefinition[]> {
  const loaded: LoadedDefinition[] = [];
  for (const builtIn of [...builtInAdapterSources].sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    loaded.push({
      definition: await parseAndValidate(builtIn.content, null),
      source: { kind: "built-in", name: builtIn.name },
    });
  }

  const paths = await normalizeLocalPaths(localAdapterPaths);
  for (const path of paths) {
    let content: Buffer;
    try {
      const pathStats = await stat(path);
      if (!pathStats.isFile()) {
        throw new Error("adapter source is not a regular file");
      }
      content = await readFile(path);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AdapterLoadError(
        "read-failed",
        `cannot read local adapter ${path}: ${detail}`,
        path,
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new AdapterLoadError(
        "parse-failed",
        "local adapter must be valid UTF-8 JSONC",
        path,
      );
    }
    loaded.push({
      definition: await parseAndValidate(text, path),
      source: {
        kind: "local",
        path,
        contentHash: createHash("sha256").update(content).digest("hex"),
      },
    });
  }
  return loaded;
}

async function normalizeLocalPaths(
  paths: readonly string[],
): Promise<readonly string[]> {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    rejectRemoteOrExecutableSource(candidate);
    const absolutePath = resolve(candidate);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AdapterLoadError(
        "read-failed",
        `cannot resolve local adapter ${absolutePath}: ${detail}`,
        absolutePath,
      );
    }
    const key =
      process.platform === "win32"
        ? canonicalPath.toLowerCase()
        : canonicalPath;
    if (seen.has(key)) {
      throw new AdapterLoadError(
        "invalid-request",
        `duplicate local adapter path: ${canonicalPath}`,
        canonicalPath,
      );
    }
    seen.add(key);
    normalized.push(canonicalPath);
  }
  return normalized.sort(compareText);
}

function rejectRemoteOrExecutableSource(candidate: string): void {
  const windowsDrivePath = /^[A-Za-z]:[\\/]/.test(candidate);
  const windowsExtendedDrivePath = /^\\\\\?\\[A-Za-z]:[\\/]/.test(candidate);
  if (
    (candidate.startsWith("\\\\") && !windowsExtendedDrivePath) ||
    (!windowsDrivePath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(candidate))
  ) {
    throw new AdapterLoadError(
      "unsupported-source",
      `remote adapter sources are not supported: ${candidate}`,
      candidate,
    );
  }
  if (extname(candidate).toLowerCase() !== ".jsonc") {
    throw new AdapterLoadError(
      "unsupported-source",
      `local adapters must be JSONC files: ${candidate}`,
      candidate,
    );
  }
}

async function parseAndValidate(
  content: string,
  path: string | null,
): Promise<AdapterDefinitionV1> {
  return validateAdapterDefinition(parseJsoncAdapter(content, path), path);
}

function rejectDuplicateAdapterIds(loaded: readonly LoadedDefinition[]): void {
  const ids = new Map<string, CompiledAdapterSource>();
  for (const item of loaded) {
    const previous = ids.get(item.definition.id);
    if (previous !== undefined) {
      throw new AdapterLoadError(
        "duplicate-id",
        `duplicate adapter id: ${item.definition.id}`,
        sourcePath(item.source),
      );
    }
    ids.set(item.definition.id, item.source);
  }
}

function resolvePathBases(
  platform: AdapterPlatform,
  overrides: Partial<AdapterPathBases> | undefined,
): AdapterPathBases {
  if (
    overrides !== undefined &&
    (typeof overrides !== "object" ||
      overrides === null ||
      Array.isArray(overrides))
  ) {
    throw new AdapterLoadError(
      "invalid-request",
      "pathBases must be an object",
    );
  }
  for (const key of Object.keys(overrides ?? {})) {
    if (!pathBaseNames.includes(key as AdapterPathBase)) {
      throw new AdapterLoadError(
        "invalid-request",
        `unknown adapter path base: ${key}`,
      );
    }
  }

  const defaults = defaultPathBases(platform);
  const result = { ...defaults, ...overrides };
  for (const name of pathBaseNames) {
    const value = result[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new AdapterLoadError(
        "invalid-request",
        `adapter path base ${name} must be a nonblank path`,
      );
    }
  }
  return result;
}

function defaultPathBases(platform: AdapterPlatform): AdapterPathBases {
  const home = homedir();
  if (platform === "win32") {
    return {
      home,
      workspace: process.cwd(),
      config: process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      state: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      cache: process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      temporary: tmpdir(),
    };
  }
  if (platform === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support");
    return {
      home,
      workspace: process.cwd(),
      config: applicationSupport,
      state: applicationSupport,
      cache: join(home, "Library", "Caches"),
      temporary: tmpdir(),
    };
  }
  return {
    home,
    workspace: process.cwd(),
    config: process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
    state: process.env.XDG_STATE_HOME ?? join(home, ".local", "state"),
    cache: process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
    temporary: tmpdir(),
  };
}

function currentAdapterPlatform(): AdapterPlatform {
  if (adapterPlatforms.has(process.platform as AdapterPlatform)) {
    return process.platform as AdapterPlatform;
  }
  throw new AdapterLoadError(
    "invalid-request",
    `unsupported runtime platform: ${process.platform}`,
  );
}

function sourcePath(source: CompiledAdapterSource): string | null {
  return source.kind === "local" ? source.path : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
