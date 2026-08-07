import { createHash } from "node:crypto";

export interface BuiltInAdapterSource {
  readonly name: string;
  readonly content: string;
}

export const VERCEL_SKILLS_ADAPTER_ID = "vercel.skills";
export const VERCEL_SKILLS_EXECUTABLE = "skills";
export const VERCEL_SKILLS_PACKAGE_NAME = "skills";
export const VERCEL_SKILLS_PACKAGE_VERSION = "1.5.22";
export const VERCEL_SKILLS_GLOBAL_AGENT_IDS = [
  "aider-desk",
  "amp",
  "antigravity",
  "antigravity-cli",
  "astrbot",
  "autohand-code",
  "augment",
  "bob",
  "claude-code",
  "openclaw",
  "cline",
  "codearts-agent",
  "codebuddy",
  "codemaker",
  "codestudio",
  "codex",
  "command-code",
  "continue",
  "cortex",
  "crush",
  "cursor",
  "deepagents",
  "devin",
  "dexto",
  "droid",
  "firebender",
  "forgecode",
  "gemini-cli",
  "github-copilot",
  "goose",
  "grok",
  "hermes-agent",
  "inference-sh",
  "jazz",
  "junie",
  "iflow-cli",
  "kilo",
  "kimchi",
  "kimi-code-cli",
  "kiro-cli",
  "kode",
  "lingma",
  "loaf",
  "mcpjam",
  "minimax-code",
  "mistral-vibe",
  "moxby",
  "mux",
  "opencode",
  "openhands",
  "ona",
  "pi",
  "qoder",
  "qoder-cn",
  "qwen-code",
  "replit",
  "reasonix",
  "rovodev",
  "roo",
  "tabnine-cli",
  "terramind",
  "tinycloud",
  "trae",
  "trae-cn",
  "warp",
  "windsurf",
  "zed",
  "zcode",
  "zencoder",
  "zenflow",
  "neovate",
  "pochi",
  "adal",
  "universal",
] as const;

export const CLAUDE_CODE_PLUGIN_ADAPTER_ID = "claude-code.plugins";
export const CLAUDE_CODE_EXECUTABLE = "claude";

export const CODEX_PLUGIN_ADAPTER_ID = "codex.plugins";
export const CODEX_EXECUTABLE = "codex";

function codexPluginRemoveArgumentTemplates() {
  return [
    { kind: "literal" as const, value: "plugin" },
    { kind: "literal" as const, value: "remove" },
    { kind: "value" as const, from: "externalId" as const },
    { kind: "literal" as const, value: "--json" },
  ];
}

export function codexPluginRemoveArguments(
  externalId: string,
): readonly string[] {
  return codexPluginRemoveArgumentTemplates().map((argument) =>
    argument.kind === "literal" ? argument.value : externalId,
  );
}

const codexPlugins = {
  schemaVersion: 1,
  id: CODEX_PLUGIN_ADAPTER_ID,
  name: "Codex plugins",
  platforms: ["darwin", "linux", "win32"],
  probes: [
    {
      id: "codex-executable",
      kind: "executable",
      executable: { default: CODEX_EXECUTABLE },
    },
  ],
  actions: [
    {
      id: "remove-user-plugin",
      kind: "managed",
      ownerKind: "plugin",
      operationId: "remove-user-plugin",
      requiresProbes: ["codex-executable"],
      command: {
        default: {
          executable: CODEX_EXECUTABLE,
          arguments: codexPluginRemoveArgumentTemplates(),
        },
      },
    },
  ],
} as const;

export type ClaudeCodePluginScope = "user" | "project" | "local";

function claudePluginUninstallArgumentTemplates(scope: ClaudeCodePluginScope) {
  return [
    { kind: "literal" as const, value: "plugin" },
    { kind: "literal" as const, value: "uninstall" },
    { kind: "value" as const, from: "externalId" as const },
    { kind: "literal" as const, value: "--scope" },
    { kind: "literal" as const, value: scope },
    { kind: "literal" as const, value: "--yes" },
  ];
}

export function claudeCodePluginUninstallArguments(
  scope: ClaudeCodePluginScope,
  externalId: string,
): readonly string[] {
  return claudePluginUninstallArgumentTemplates(scope).map((argument) =>
    argument.kind === "literal" ? argument.value : externalId,
  );
}

const claudeCodePlugins = {
  schemaVersion: 1,
  id: CLAUDE_CODE_PLUGIN_ADAPTER_ID,
  name: "Claude Code plugins",
  platforms: ["darwin", "linux", "win32"],
  probes: [
    {
      id: "claude-executable",
      kind: "executable",
      executable: { default: CLAUDE_CODE_EXECUTABLE },
    },
  ],
  actions: (["user", "project", "local"] as const).map((scope) => ({
    id: `uninstall-${scope}-plugin`,
    kind: "managed" as const,
    ownerKind: "plugin" as const,
    operationId: `uninstall-${scope}-plugin`,
    requiresProbes: ["claude-executable"],
    command: {
      default: {
        executable: CLAUDE_CODE_EXECUTABLE,
        arguments: claudePluginUninstallArgumentTemplates(scope),
      },
    },
  })),
} as const;

function removalArgumentTemplates(scope: "global" | "project") {
  return [
    { kind: "literal" as const, value: "remove" },
    { kind: "value" as const, from: "externalId" as const },
    ...(scope === "global"
      ? [
          { kind: "literal" as const, value: "--global" },
          { kind: "literal" as const, value: "--agent" },
          ...VERCEL_SKILLS_GLOBAL_AGENT_IDS.map((value) => ({
            kind: "literal" as const,
            value,
          })),
        ]
      : []),
    { kind: "literal" as const, value: "--yes" },
  ];
}

export function vercelSkillsRemovalArguments(
  scope: "global" | "project",
  externalId: string,
): readonly string[] {
  return removalArgumentTemplates(scope).map((argument) =>
    argument.kind === "literal" ? argument.value : externalId,
  );
}

const vercelSkills = {
  schemaVersion: 1,
  id: VERCEL_SKILLS_ADAPTER_ID,
  name: "Vercel skills CLI",
  platforms: ["darwin", "linux", "win32"],
  probes: [
    {
      id: "skills-executable",
      kind: "executable",
      executable: { default: VERCEL_SKILLS_EXECUTABLE },
    },
  ],
  actions: [
    {
      id: "remove-project-direct",
      kind: "managed",
      ownerKind: "manager",
      operationId: "remove-project-skill",
      requiresProbes: ["skills-executable"],
      command: {
        default: {
          executable: VERCEL_SKILLS_EXECUTABLE,
          arguments: removalArgumentTemplates("project"),
        },
      },
    },
    {
      id: "remove-global-direct",
      kind: "managed",
      ownerKind: "manager",
      operationId: "remove-global-skill",
      requiresProbes: ["skills-executable"],
      command: {
        default: {
          executable: VERCEL_SKILLS_EXECUTABLE,
          arguments: removalArgumentTemplates("global"),
        },
      },
    },
    {
      id: "remove-global-ephemeral",
      kind: "ephemeral-package",
      ownerKind: "manager",
      operationId: "remove-global-skill",
      runner: "npx",
      packageName: VERCEL_SKILLS_PACKAGE_NAME,
      packageVersion: VERCEL_SKILLS_PACKAGE_VERSION,
      mayDownload: true,
      arguments: removalArgumentTemplates("global"),
    },
  ],
} as const;

const vercelSkillsContent = `${JSON.stringify(vercelSkills, null, 2)}\n`;
export const VERCEL_SKILLS_ADAPTER_HASH = createHash("sha256")
  .update(vercelSkillsContent)
  .digest("hex");

const claudeCodePluginsContent = `${JSON.stringify(claudeCodePlugins, null, 2)}\n`;
export const CLAUDE_CODE_PLUGIN_ADAPTER_HASH = createHash("sha256")
  .update(claudeCodePluginsContent)
  .digest("hex");

const codexPluginsContent = `${JSON.stringify(codexPlugins, null, 2)}\n`;
export const CODEX_PLUGIN_ADAPTER_HASH = createHash("sha256")
  .update(codexPluginsContent)
  .digest("hex");

// Keeping the source list outside the public Adapter module prevents callers
// from marking arbitrary local content as package-trusted built-in content.
export const builtInAdapterSources: readonly BuiltInAdapterSource[] = [
  {
    name: "codex-plugins.jsonc",
    content: codexPluginsContent,
  },
  {
    name: "claude-code-plugins.jsonc",
    content: claudeCodePluginsContent,
  },
  {
    name: "vercel-skills.jsonc",
    content: vercelSkillsContent,
  },
];
