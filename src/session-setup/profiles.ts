import type { SessionSetupSourceProfile } from "./types.js";
import { parseSessionSetupSourceProfile } from "./validation.js";

/** Recovered offline baselines. Codex has qualified local-only evidence. */
const recoveredProfiles: readonly SessionSetupSourceProfile[] = [
  {
    id: "codex-0.154.0",
    harnessId: "codex",
    clientSurface: "cli",
    sourceVersion: "0.154.0",
    sourceSignature: "config.toml-native-availability",
    qualification: "qualified",
    definitionScopes: ["user", "workspace", "agent"],
    precedence: ["trusted-workspace", "user"],
    trust: "unknown",
    offlineProbe: "metadata-only",
    activation: "new-session",
    fixtureCoverage: [
      "skill",
      "plugin",
      "mcp",
      "app",
      "shared-connector",
      "owner-gate",
      "trusted-workspace-precedence",
      "native-enable-disable",
      "checked-writer-preservation-race",
    ],
    supportedTargetKinds: [
      "skill-exposure",
      "plugin",
      "mcp-registration",
      "app-binding",
    ],
    controlScopeKinds: ["user", "workspace"],
    selectorEffects: [
      { targetKind: "skill-exposure", authority: "exact-target" },
      { targetKind: "plugin", authority: "exact-target" },
      { targetKind: "mcp-registration", authority: "exact-target" },
      { targetKind: "app-binding", authority: "shared-connector" },
    ],
  },
  {
    id: "claude-code-2.1.270",
    harnessId: "claude-code",
    clientSurface: "cli",
    sourceVersion: "2.1.270",
    sourceSignature: "claude-native-preferences",
    qualification: "fixture-only",
    definitionScopes: ["user", "workspace", "agent"],
    precedence: ["workspace", "user"],
    trust: "unknown",
    offlineProbe: "metadata-only",
    activation: "restart",
    fixtureCoverage: ["skill", "plugin", "mcp", "unavailable-account-source"],
    supportedTargetKinds: ["skill-exposure", "plugin", "mcp-registration"],
    controlScopeKinds: ["user", "workspace"],
    selectorEffects: [
      { targetKind: "skill-exposure", authority: "exact-target" },
      { targetKind: "plugin", authority: "exact-target" },
      { targetKind: "mcp-registration", authority: "exact-target" },
    ],
  },
  {
    id: "gemini-cli-0.59.0",
    harnessId: "gemini-cli",
    clientSurface: "cli",
    sourceVersion: "0.59.0",
    sourceSignature: "settings.json-native-availability",
    qualification: "fixture-only",
    definitionScopes: ["user", "workspace", "agent"],
    precedence: ["trusted-workspace", "user"],
    trust: "unknown",
    offlineProbe: "metadata-only",
    activation: "new-session",
    fixtureCoverage: ["skill", "plugin", "mcp", "unavailable-account-source"],
    supportedTargetKinds: ["skill-exposure", "plugin", "mcp-registration"],
    controlScopeKinds: ["user", "workspace"],
    selectorEffects: [
      { targetKind: "skill-exposure", authority: "exact-target" },
      { targetKind: "plugin", authority: "exact-target" },
      { targetKind: "mcp-registration", authority: "exact-target" },
    ],
  },
] as const;

export const recoveredSourceProfiles: readonly SessionSetupSourceProfile[] =
  Object.freeze(recoveredProfiles.map(parseSessionSetupSourceProfile));
