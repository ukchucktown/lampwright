import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { VERCEL_SKILLS_GLOBAL_AGENT_IDS } from "../adapter/built-ins.js";
import type { InventoryScanEnvironment } from "./types.js";

interface AgentPathDefinition {
  readonly agentId: string;
  readonly project: readonly string[];
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

// Pinned to the path registry shipped by skills@1.5.22. This is data rather
// than discovery logic: every probe remains bounded to a manager-known path.
const definitions: readonly AgentPathDefinition[] = [
  path("aider-desk", [".aider-desk", "skills"]),
  path("amp", [".agents", "skills"], "config", ["agents", "skills"]),
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
  agentHomePath("codex", [".agents", "skills"], ["skills"]),
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
  path("droid", [".factory", "skills"]),
  projectOnly("eve", ["agent", "skills"]),
  path("firebender", [".agents", "skills"], "home", [".firebender", "skills"]),
  path("forgecode", [".forge", "skills"]),
  path("gemini-cli", [".agents", "skills"], "home", [".gemini", "skills"]),
  path("github-copilot", [".agents", "skills"], "home", [".copilot", "skills"]),
  path("goose", [".goose", "skills"], "config", ["goose", "skills"]),
  agentHomePath("grok", [".grok", "skills"], ["skills"]),
  agentHomePath("hermes-agent", [".hermes", "skills"], ["skills"]),
  path("inference-sh", [".inferencesh", "skills"]),
  path("jazz", [".jazz", "skills"]),
  path("junie", [".junie", "skills"]),
  path("iflow-cli", [".iflow", "skills"]),
  path("kilo", [".kilocode", "skills"]),
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
  path("pi", [".pi", "skills"], "home", [".pi", "agent", "skills"]),
  path("qoder", [".qoder", "skills"]),
  path("qoder-cn", [".qoder", "skills"], "home", [".qoder-cn", "skills"]),
  path("qwen-code", [".qwen", "skills"]),
  path("replit", [".agents", "skills"], "config", ["agents", "skills"]),
  path("reasonix", [".reasonix", "skills"]),
  path("rovodev", [".rovodev", "skills"]),
  path("roo", [".roo", "skills"]),
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
    const base =
      definition.global.base === "home"
        ? environment.homeDirectory
        : definition.global.base === "home-config"
          ? join(environment.homeDirectory, ".config")
          : definition.global.base === "config"
            ? configDirectory(environment)
            : agentHomeDirectory(environment, definition.agentId);
    return [
      {
        agentId: definition.agentId,
        path: join(base, ...definition.global.path, sanitizedName),
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

export function vercelCanonicalPath(
  scope: "global" | "project",
  environment: InventoryScanEnvironment,
  sanitizedName: string,
): string {
  return scope === "project"
    ? join(environment.workspaceDirectory, ".agents", "skills", sanitizedName)
    : join(environment.homeDirectory, ".agents", "skills", sanitizedName);
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
  const defaults: Readonly<Record<string, string>> = {
    "autohand-code": ".autohand",
    "claude-code": ".claude",
    codex: ".codex",
    grok: ".grok",
    "hermes-agent": ".hermes",
    "mistral-vibe": ".vibe",
  };
  return join(environment.homeDirectory, defaults[agentId] ?? `.${agentId}`);
}

function path(
  agentId: string,
  project: readonly string[],
  base: "home" | "home-config" | "config" = "home",
  global: readonly string[] = project,
): AgentPathDefinition {
  return { agentId, project, global: { base, path: global } };
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
