import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { VERCEL_SKILLS_GLOBAL_AGENT_IDS } from "../adapter/built-ins.js";
import type { InventoryScanEnvironment } from "./types.js";

interface AgentPathDefinition {
  readonly agentId: string;
  readonly project: readonly string[];
  /**
   * False for an agent that uses the shared project directory but does not
   * read the shared global directory, so the Manager links its global path.
   */
  readonly globalReadsCanonical?: false;
  readonly global?:
    | {
        readonly base: "home" | "home-config" | "config";
        readonly path: readonly string[];
      }
    | { readonly base: "agent-home"; readonly path: readonly string[] };
}

export interface VercelAgentPath {
  readonly agentId: string;
  readonly path: string;
}

// Pinned to the path registry shipped by skills@1.9.0. This is data rather
// than discovery logic: every probe remains bounded to a manager-known path.
const definitions: readonly AgentPathDefinition[] = [
  path("aider-desk", [".aider-desk", "skills"]),
  path("amp", [".agents", "skills"], "config", ["agents", "skills"]),
  ownGlobalPath(
    "antigravity",
    [".agents", "skills"],
    [".gemini", "config", "skills"],
  ),
  ownGlobalPath(
    "antigravity-cli",
    [".agents", "skills"],
    [".gemini", "config", "skills"],
  ),
  path("astrbot", ["data", "skills"], "home", [".astrbot", "data", "skills"]),
  agentHomePath("autohand-code", [".autohand", "skills"], ["skills"]),
  path("augment", [".augment", "skills"]),
  path("bob", [".bob", "skills"]),
  agentHomePath("claude-code", [".claude", "skills"], ["skills"]),
  path("openclaw", ["skills"], "home", [".openclaw", "skills"]),
  path("cline", [".agents", "skills"], "home", [".agents", "skills"]),
  path("codearts-agent", [".codeartsdoer", "skills"]),
  path("codebuddy", [".codebuddy", "skills"]),
  path("codemaker", [".codemaker", "skills"]),
  path("codestudio", [".codestudio", "skills"]),
  path("codex", [".agents", "skills"], "home", [".agents", "skills"]),
  path("command-code", [".commandcode", "skills"]),
  path("continue", [".continue", "skills"]),
  path("cortex", [".cortex", "skills"], "home", [
    ".snowflake",
    "cortex",
    "skills",
  ]),
  path("crush", [".crush", "skills"], "home-config", ["crush", "skills"]),
  path("cursor", [".agents", "skills"], "home", [".cursor", "skills"]),
  path("deepagents", [".agents", "skills"], "home", [
    ".deepagents",
    "agent",
    "skills",
  ]),
  path("devin", [".devin", "skills"], "config", ["devin", "skills"]),
  path("dexto", [".agents", "skills"], "home", [".agents", "skills"]),
  path("droid", [".agents", "skills"], "home", [".factory", "skills"]),
  projectOnly("eve", ["agent", "skills"]),
  path("firebender", [".agents", "skills"], "home", [".firebender", "skills"]),
  path("forgecode", [".forge", "skills"]),
  path("fx", [".agents", "skills"], "home", [".agents", "skills"]),
  path("gemini-cli", [".agents", "skills"], "home", [".gemini", "skills"]),
  path("github-copilot", [".agents", "skills"], "home", [".copilot", "skills"]),
  path("goose", [".goose", "skills"], "config", ["goose", "skills"]),
  agentHomePath("grok", [".grok", "skills"], ["skills"]),
  agentHomePath("hermes-agent", [".hermes", "skills"], ["skills"]),
  path("inference-sh", [".inferencesh", "skills"]),
  path("jazz", [".jazz", "skills"]),
  path("junie", [".junie", "skills"]),
  path("iflow-cli", [".iflow", "skills"]),
  path("kilo", [".agents", "skills"], "home", [".kilo", "skills"]),
  path("kimchi", [".kimchi", "skills"], "home-config", [
    "kimchi",
    "harness",
    "skills",
  ]),
  path("kimi-code-cli", [".agents", "skills"], "home", [".agents", "skills"]),
  path("kiro-cli", [".kiro", "skills"]),
  path("kode", [".kode", "skills"]),
  path("lingma", [".lingma", "skills"]),
  path("loaf", [".agents", "skills"], "home", [".agents", "skills"]),
  path("mcpjam", [".mcpjam", "skills"]),
  path("minimax-code", [".minimax", "skills"]),
  agentHomePath("mistral-vibe", [".vibe", "skills"], ["skills"]),
  path("moxby", [".moxby", "skills"]),
  path("mux", [".mux", "skills"]),
  path("opencode", [".agents", "skills"], "config", ["opencode", "skills"]),
  path("openhands", [".openhands", "skills"]),
  path("ona", [".ona", "skills"]),
  path("pi", [".agents", "skills"], "home", [".agents", "skills"]),
  path("posit-assistant", [".posit", "assistant", "skills"]),
  path("qoder", [".qoder", "skills"]),
  path("qoder-cn", [".qoder", "skills"], "home", [".qoder-cn", "skills"]),
  path("qwen-code", [".qwen", "skills"]),
  path("replit", [".agents", "skills"], "config", ["agents", "skills"]),
  agentHomePath("reasonix", [".reasonix", "skills"], ["skills"]),
  path("rovodev", [".rovodev", "skills"]),
  path("roo", [".roo", "skills"]),
  path("sarvam-code", [".agents", "skills"], "home", [".agents", "skills"]),
  path("tabnine-cli", [".tabnine", "agent", "skills"]),
  path("terramind", [".terramind", "skills"]),
  path("tinycloud", [".tinycloud", "skills"]),
  path("trae", [".trae", "skills"]),
  path("trae-cn", [".trae", "skills"], "home", [".trae-cn", "skills"]),
  path("warp", [".agents", "skills"], "home", [".agents", "skills"]),
  path("windsurf", [".windsurf", "skills"], "home", [
    ".codeium",
    "windsurf",
    "skills",
  ]),
  path("zed", [".agents", "skills"], "home", [".agents", "skills"]),
  path("zcode", [".zcode", "skills"]),
  path("zencoder", [".zencoder", "skills"]),
  path("zenflow", [".zencoder", "skills"]),
  path("neovate", [".neovate", "skills"]),
  path("pochi", [".pochi", "skills"]),
  projectOnly("promptscript", [".agents", "skills"]),
  path("adal", [".adal", "skills"]),
  path("universal", [".agents", "skills"], "config", ["agents", "skills"]),
];

assertGlobalAgentRegistry();

// Paths that an earlier pinned `skills` version used and skills@1.9.0 does not
// visit. A Skill that the earlier version installed can still have a link or a
// copy there, and the `remove` command of skills@1.9.0 leaves it in place.
// Discovery keeps these paths so such an Installation stays complete.
const legacyDefinitions: readonly AgentPathDefinition[] = [
  path("antigravity", [".agents", "skills"], "home", [
    ".gemini",
    "antigravity",
    "skills",
  ]),
  path("antigravity-cli", [".agents", "skills"], "home", [
    ".gemini",
    "antigravity-cli",
    "skills",
  ]),
  agentHomePath("codex", [".agents", "skills"], ["skills"]),
  path("droid", [".factory", "skills"]),
  path("kilo", [".kilocode", "skills"]),
  path("pi", [".pi", "skills"], "home", [".pi", "agent", "skills"]),
];

export async function vercelAgentPaths(
  scope: "global" | "project",
  environment: InventoryScanEnvironment,
  sanitizedName: string,
): Promise<readonly VercelAgentPath[]> {
  const paths = definitions.flatMap((definition) => {
    if (scope === "project") {
      return [
        {
          agentId: definition.agentId,
          path: join(
            environment.workspaceDirectory,
            ...definition.project,
            sanitizedName,
          ),
        },
      ];
    }
    if (definition.global === undefined) return [];
    return [
      {
        agentId: definition.agentId,
        path: globalPath(definition, environment, sanitizedName),
      },
    ];
  });
  if (scope === "project") return paths;

  const openClawRoot = await firstExistingPath(
    [".openclaw", ".clawdbot", ".moltbot"].map((name) =>
      join(environment.homeDirectory, name),
    ),
  );
  return paths.map((candidate) =>
    candidate.agentId === "openclaw"
      ? {
          agentId: candidate.agentId,
          path: join(openClawRoot, "skills", sanitizedName),
        }
      : candidate,
  );
}

/**
 * The paths of earlier pinned `skills` versions that the current pin does not
 * visit. The canonical path is not one of them.
 */
export function vercelLegacyAgentPaths(
  scope: "global" | "project",
  environment: InventoryScanEnvironment,
  sanitizedName: string,
): readonly VercelAgentPath[] {
  return legacyDefinitions.map((definition) => ({
    agentId: definition.agentId,
    path:
      scope === "project"
        ? join(
            environment.workspaceDirectory,
            ...definition.project,
            sanitizedName,
          )
        : globalPath(definition, environment, sanitizedName),
  }));
}

/** Every bounded agent path the pinned nested `add` operation may select. */
export async function vercelUpdateCandidatePaths(
  scope: "global" | "project",
  environment: InventoryScanEnvironment,
  sanitizedName: string,
): Promise<readonly VercelAgentPath[]> {
  const resolved = await vercelAgentPaths(scope, environment, sanitizedName);
  if (scope === "project") return resolved;
  const resolvedByAgent = new Map(
    resolved.map((candidate) => [candidate.agentId, candidate]),
  );
  const processAgent = await selectedProcessAgent(environment);
  const detected =
    processAgent === null
      ? await detectedAgents(environment, resolvedByAgent)
      : [];
  const selected = new Set(
    processAgent !== null
      ? [processAgent, ...canonicalGlobalAgentIds()]
      : detected.length === 0
        ? definitions.map((definition) => definition.agentId)
        : [...detected, ...canonicalGlobalAgentIds()],
  );
  return resolved.filter((candidate) => {
    const definition = definitions.find(
      (entry) => entry.agentId === candidate.agentId,
    )!;
    return (
      !readsCanonicalGlobally(definition) && selected.has(candidate.agentId)
    );
  });
}

export function vercelCanonicalPath(
  scope: "global" | "project",
  environment: InventoryScanEnvironment,
  sanitizedName: string,
): string {
  return scope === "project"
    ? join(environment.workspaceDirectory, ".agents", "skills", sanitizedName)
    : join(environment.homeDirectory, ".agents", "skills", sanitizedName);
}

function globalPath(
  definition: AgentPathDefinition,
  environment: InventoryScanEnvironment,
  sanitizedName: string,
): string {
  const global = definition.global!;
  const base =
    global.base === "home"
      ? environment.homeDirectory
      : global.base === "home-config"
        ? join(environment.homeDirectory, ".config")
        : global.base === "config"
          ? configDirectory(environment)
          : agentHomeDirectory(environment, definition.agentId);
  return join(base, ...global.path, sanitizedName);
}

function configDirectory(environment: InventoryScanEnvironment): string {
  return (
    environment.configDirectory ?? join(environment.homeDirectory, ".config")
  );
}

async function firstExistingPath(paths: readonly string[]): Promise<string> {
  for (const path of paths) {
    const stats = await lstat(path).catch(() => null);
    if (stats !== null) return path;
  }
  return paths[0]!;
}

function agentHomeDirectory(
  environment: InventoryScanEnvironment,
  agentId: string,
): string {
  const configured = environment.agentHomeDirectories?.[agentId];
  if (configured !== undefined) return configured;
  if (agentId === "reasonix" && process.platform === "win32") {
    const appData = environment.agentProcessEnvironment?.APPDATA?.trim();
    return join(
      appData !== undefined && appData.length > 0
        ? appData
        : join(environment.homeDirectory, "AppData", "Roaming"),
      "reasonix",
    );
  }
  const defaults: Readonly<Record<string, string>> = {
    "autohand-code": ".autohand",
    "claude-code": ".claude",
    codex: ".codex",
    grok: ".grok",
    "hermes-agent": ".hermes",
    "mistral-vibe": ".vibe",
    "sarvam-code": ".sarvam",
  };
  return join(environment.homeDirectory, defaults[agentId] ?? `.${agentId}`);
}

async function detectedAgents(
  environment: InventoryScanEnvironment,
  resolvedByAgent: ReadonlyMap<string, VercelAgentPath>,
): Promise<readonly string[]> {
  const results = await Promise.all(
    definitions.map(async (definition) => ({
      agentId: definition.agentId,
      installed: await anyPathExists(
        detectionPaths(
          definition.agentId,
          environment,
          resolvedByAgent.get(definition.agentId)?.path ?? null,
        ),
      ),
    })),
  );
  return results
    .filter((result) => result.installed)
    .map((result) => result.agentId);
}

function detectionPaths(
  agentId: string,
  environment: InventoryScanEnvironment,
  candidatePath: string | null,
): readonly string[] {
  const home = environment.homeDirectory;
  const config = configDirectory(environment);
  switch (agentId) {
    case "amp":
      return [join(config, "amp")];
    case "antigravity":
      return [join(home, ".gemini", "antigravity")];
    case "antigravity-cli":
      return [join(home, ".gemini", "antigravity-cli")];
    case "cline":
      return [join(home, ".cline")];
    case "codex":
      return [agentHomeDirectory(environment, "codex"), "/etc/codex"];
    case "cursor":
      return [join(home, ".cursor")];
    case "deepagents":
      return [join(home, ".deepagents")];
    case "dexto":
      return [join(home, ".dexto")];
    case "firebender":
      return [join(home, ".firebender")];
    case "fx":
      return [join(home, ".fx")];
    case "gemini-cli":
      return [join(home, ".gemini")];
    case "github-copilot":
      return [join(home, ".copilot")];
    case "kilo":
      return [join(home, ".kilo"), join(home, ".kilocode")];
    case "kimi-code-cli":
      return [join(home, ".kimi-code"), join(home, ".kimi")];
    case "loaf":
      return [join(home, ".loaf")];
    case "opencode":
      return [join(config, "opencode")];
    case "pi":
      return [join(home, ".pi", "agent")];
    case "posit-assistant":
      return [join(home, ".posit", "assistant"), join(home, ".positai")];
    case "sarvam-code":
      return [agentHomeDirectory(environment, "sarvam-code")];
    case "replit":
      return [];
    case "warp":
      return [join(home, ".warp")];
    case "zed": {
      const processEnvironment = environment.agentProcessEnvironment ?? {};
      return [
        join(config, "zed"),
        ...(processEnvironment.APPDATA === undefined
          ? []
          : [join(processEnvironment.APPDATA, "Zed")]),
        ...(processEnvironment.FLATPAK_XDG_CONFIG_HOME === undefined
          ? []
          : [join(processEnvironment.FLATPAK_XDG_CONFIG_HOME, "zed")]),
      ];
    }
    case "universal":
      return [];
    case "promptscript":
      return [];
    case "eve":
      return [];
    case "astrbot":
      return [join(home, ".astrbot")];
    case "codebuddy":
      return [join(home, ".codebuddy")];
    case "continue":
      return [join(home, ".continue")];
    case "jazz":
      return [join(home, ".jazz")];
    case "kimchi":
      return [join(home, ".config", "kimchi")];
    case "minimax-code":
      return [join(home, ".minimax"), "/Applications/MiniMax Code.app"];
    case "tabnine-cli":
      return [join(home, ".tabnine")];
    case "zcode":
      return [join(home, ".zcode"), "/Applications/ZCode.app"];
    default:
      return candidatePath === null ? [] : [dirname(dirname(candidatePath))];
  }
}

async function selectedProcessAgent(
  environment: InventoryScanEnvironment,
): Promise<string | null> {
  const values = environment.agentProcessEnvironment ?? {};
  const strongCursorSignal =
    Boolean(values.CURSOR_AGENT?.trim()) ||
    values.CURSOR_EXTENSION_HOST_ROLE === "agent-exec";
  const explicit = values.AI_AGENT?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (
      (explicit === "cursor" || explicit === "cursor-cli") &&
      !strongCursorSignal
    )
      return null;
    return mappedAgentId(explicit);
  }
  if (values.CURSOR_TRACE_ID) return strongCursorSignal ? "cursor" : null;
  if (strongCursorSignal) return "cursor";
  if (values.GEMINI_CLI) return "gemini-cli";
  if (values.CODEX_SANDBOX || values.CODEX_CI || values.CODEX_THREAD_ID)
    return "codex";
  if (values.ANTIGRAVITY_AGENT) return "antigravity";
  if (values.AUGMENT_AGENT) return "augment";
  if (values.OPENCODE === "1" || values.OPENCODE_CLIENT) return "opencode";
  if (values.CLAUDECODE || values.CLAUDE_CODE) return "claude-code";
  if (values.REPL_ID) return "replit";
  if (
    values.COPILOT_MODEL ||
    values.COPILOT_ALLOW_ALL ||
    values.COPILOT_GITHUB_TOKEN
  )
    return "github-copilot";
  return (await pathMayExist("/opt/.devin")) ? "universal" : null;
}

function mappedAgentId(agentName: string): string | null {
  const mappings: Readonly<Record<string, string>> = {
    cursor: "cursor",
    "cursor-cli": "cursor",
    claude: "claude-code",
    cowork: "claude-code",
    devin: "universal",
    replit: "replit",
    gemini: "gemini-cli",
    codex: "codex",
    antigravity: "antigravity",
    "augment-cli": "augment",
    opencode: "opencode",
    "github-copilot": "github-copilot",
    "github-copilot-cli": "github-copilot",
  };
  return mappings[agentName] ?? null;
}

function canonicalGlobalAgentIds(): readonly string[] {
  return definitions
    .filter(readsCanonicalGlobally)
    .map((definition) => definition.agentId);
}

/**
 * True for an agent that reads the shared global directory. The Manager gives
 * such an agent no link of its own in the global scope.
 */
function readsCanonicalGlobally(definition: AgentPathDefinition): boolean {
  return (
    isUniversalAgent(definition) && definition.globalReadsCanonical !== false
  );
}

function isUniversalAgent(definition: AgentPathDefinition): boolean {
  return (
    definition.project.length === 2 &&
    definition.project[0] === ".agents" &&
    definition.project[1] === "skills"
  );
}

async function anyPathExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (await pathMayExist(path)) return true;
  return false;
}

async function pathMayExist(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error: unknown) => !isMissingPathError(error));
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function path(
  agentId: string,
  project: readonly string[],
  base: "home" | "home-config" | "config" = "home",
  global: readonly string[] = project,
): AgentPathDefinition {
  return { agentId, project, global: { base, path: global } };
}

function ownGlobalPath(
  agentId: string,
  project: readonly string[],
  global: readonly string[],
): AgentPathDefinition {
  return {
    agentId,
    project,
    globalReadsCanonical: false,
    global: { base: "home", path: global },
  };
}

function agentHomePath(
  agentId: string,
  project: readonly string[],
  global: readonly string[],
): AgentPathDefinition {
  return { agentId, project, global: { base: "agent-home", path: global } };
}

function projectOnly(
  agentId: string,
  project: readonly string[],
): AgentPathDefinition {
  return { agentId, project };
}

function assertGlobalAgentRegistry(): void {
  const pathAgentIds = definitions.flatMap((definition) =>
    definition.global === undefined ? [] : [definition.agentId],
  );
  if (
    pathAgentIds.length !== VERCEL_SKILLS_GLOBAL_AGENT_IDS.length ||
    pathAgentIds.some(
      (agentId, index) => agentId !== VERCEL_SKILLS_GLOBAL_AGENT_IDS[index],
    )
  ) {
    throw new Error("Vercel global command and path registries differ");
  }
}
