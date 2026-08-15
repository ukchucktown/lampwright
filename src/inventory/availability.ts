import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { parse as parseToml } from "@iarna/toml";
import { parseTree, type ParseError } from "jsonc-parser";

import {
  CLAUDE_CODE_PLUGIN_ADAPTER_ID,
  CODEX_PLUGIN_ADAPTER_ID,
  GEMINI_CLI_ADAPTER_ID,
} from "../adapter/built-ins.js";
import type {
  HarnessExposure,
  HarnessExposureControl,
  Installation,
  NativeControlDocumentEvidence,
  NativeControlSelectorValue,
  PluginAvailability,
  PluginBoundary,
} from "../model/types.js";
import { hasDuplicateKeys, pathKey } from "./evidence.js";
import { readAvailabilityDocument } from "./availability-evidence.js";
import type {
  InventoryCommandRunner,
  InventoryScanEnvironment,
} from "./types.js";

type AvailabilityDocumentReader = (
  path: string,
  format: NativeControlDocumentEvidence["format"],
  scope: NativeControlDocumentEvidence["scope"],
  documentScope: NativeControlDocumentEvidence["documentScope"],
  applies: NativeControlDocumentEvidence["applies"],
) => ReturnType<typeof readAvailabilityDocument>;

const codexHarness = "codex";
const claudeHarness = "claude-code";
const geminiHarness = "gemini-cli";
const unsupportedReason =
  "this harness exposure has no supported native availability control";

/**
 * Materializes only documented native controls.  The scanner owns parsing so
 * Planning receives complete immutable evidence and never reads config files.
 */
export async function materializeHarnessExposures(
  installation: Installation,
  environment: InventoryScanEnvironment,
  commandRunner: InventoryCommandRunner,
  readDocument = createAvailabilityDocumentReader(commandRunner),
): Promise<readonly HarnessExposure[]> {
  return Promise.all(
    [...new Set(installation.exposedTo)].sort().map(async (harnessId) => {
      if (
        installation.ownership.kind === "plugin" ||
        installation.protection.system.kind !== "none"
      ) {
        return unsupported(harnessId);
      }
      if (harnessId === codexHarness)
        return codexExposure(installation, environment, readDocument);
      if (harnessId === claudeHarness)
        return claudeExposure(installation, environment, readDocument);
      if (harnessId === geminiHarness)
        return geminiExposure(installation, environment, readDocument);
      return unsupported(harnessId);
    }),
  );
}

/** A scan-scoped immutable document snapshot: the first read is reused verbatim. */
export function createAvailabilityDocumentReader(
  commandRunner: InventoryCommandRunner,
): AvailabilityDocumentReader {
  const snapshots = new Map<
    string,
    ReturnType<typeof readAvailabilityDocument>
  >();
  return (path, format, scope, documentScope, applies) => {
    const key = JSON.stringify([path, format, scope, documentScope, applies]);
    const existing = snapshots.get(key);
    if (existing !== undefined) return existing;
    const snapshot = readAvailabilityDocument(
      path,
      format,
      scope,
      documentScope,
      applies,
      commandRunner,
    );
    snapshots.set(key, snapshot);
    return snapshot;
  };
}

/** Materializes whole-Plugin controls without granting child Skills control. */
export async function materializePluginAvailability(
  plugin: PluginBoundary,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<PluginAvailability> {
  if (
    plugin.adapterId === CLAUDE_CODE_PLUGIN_ADAPTER_ID &&
    plugin.availability.status === "unresolved"
  )
    return plugin.availability;
  if (plugin.adapterId === CODEX_PLUGIN_ADAPTER_ID)
    return codexPluginAvailability(plugin, environment, readDocument);
  if (plugin.adapterId === CLAUDE_CODE_PLUGIN_ADAPTER_ID)
    return claudePluginAvailability(plugin, environment, readDocument);
  if (plugin.adapterId === GEMINI_CLI_ADAPTER_ID)
    return geminiPluginAvailability(plugin, environment, readDocument);
  return plugin.availability;
}

async function codexPluginAvailability(
  plugin: PluginBoundary,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<PluginAvailability> {
  const home =
    environment.agentHomeDirectories?.codex ??
    join(environment.homeDirectory, ".codex");
  const document = await readDocument(
    join(home, "config.toml"),
    "toml",
    { kind: "user" },
    "user",
    true,
  );
  const value =
    document.unsafe || document.text === null
      ? document.unsafe
        ? null
        : parseCodexPlugin("", plugin.pluginId)
      : parseCodexPlugin(document.text, plugin.pluginId);
  const layers = [withSelector(document.evidence, value)];
  if (value === null)
    return unresolvedPlugin(
      "codex-plugin-enabled",
      plugin.pluginId,
      layers,
      [document.evidence.path],
      "the Codex Plugin configuration is malformed, linked, hard-linked, unreadable, or changed while scanning",
    );
  const status = value.enabled === false ? "disabled" : "enabled";
  if (status !== plugin.availability.status)
    return unresolvedPlugin(
      "codex-plugin-enabled",
      plugin.pluginId,
      layers,
      [document.evidence.path],
      "Codex Plugin list state disagrees with its configuration",
    );
  return nativePlugin(
    status,
    "codex-plugin-enabled",
    plugin.pluginId,
    layers,
    [document.evidence.path],
    uniformPluginAvailability(layers),
  );
}

async function claudePluginAvailability(
  plugin: PluginBoundary,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<PluginAvailability> {
  const home =
    environment.agentHomeDirectories?.[claudeHarness] ??
    join(environment.homeDirectory, ".claude");
  const workspace = environment.workspaceDirectory;
  const userSettings = join(home, "settings.json");
  const workspaceSettings = join(workspace, ".claude", "settings.json");
  const documents = await Promise.all([
    ...(pathKey(userSettings) === pathKey(workspaceSettings)
      ? []
      : [readDocument(userSettings, "json", { kind: "user" }, "user", true)]),
    readDocument(
      workspaceSettings,
      "json",
      { kind: "workspace", workspacePath: workspace },
      "shared-workspace",
      true,
    ),
    readDocument(
      join(workspace, ".claude", "settings.local.json"),
      "json",
      { kind: "workspace", workspacePath: workspace },
      "local-workspace",
      true,
    ),
  ]);
  const values = documents.map((document) =>
    document.unsafe
      ? null
      : parseClaudePlugin(document.text ?? "{}", plugin.pluginId),
  );
  const layers = documents.map((document, index) =>
    withSelector(document.evidence, values[index] ?? null),
  );
  if (values.some((value) => value === null))
    return unresolvedPlugin(
      "claude-enabled-plugins",
      plugin.pluginId,
      layers,
      claudeWritableLayerPaths(documents),
      "a Claude Code Plugin configuration layer is malformed, linked, hard-linked, unreadable, or changed while scanning",
    );
  const enabled = values
    .map((value) => value!.enabled)
    .filter((value) => value !== null)
    .at(-1);
  return nativePlugin(
    enabled === false ? "disabled" : "enabled",
    "claude-enabled-plugins",
    plugin.pluginId,
    layers,
    claudeWritableLayerPaths(documents),
    claudePluginOperationAvailability(layers),
  );
}

async function geminiPluginAvailability(
  plugin: PluginBoundary,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<PluginAvailability> {
  const home =
    environment.agentHomeDirectories?.[geminiHarness] ??
    join(environment.homeDirectory, ".gemini");
  const document = await readDocument(
    join(home, "extensions", "extension-enablement.json"),
    "json",
    { kind: "user" },
    "user",
    true,
  );
  const value = document.unsafe
    ? null
    : parseGeminiPlugin(
        document.text ?? "{}",
        plugin.pluginId,
        environment.workspaceDirectory,
        environment.homeDirectory,
      );
  const layers = [withSelector(document.evidence, value)];
  if (value === null)
    return unresolvedPlugin(
      "gemini-extension-enablement",
      plugin.pluginId,
      layers,
      [document.evidence.path],
      "the Gemini Plugin enablement document is malformed, linked, hard-linked, unreadable, or changed while scanning",
    );
  const status = value.enabled ? "enabled" : "disabled";
  if (status !== plugin.availability.status)
    return unresolvedPlugin(
      "gemini-extension-enablement",
      plugin.pluginId,
      layers,
      [document.evidence.path],
      "Gemini Plugin runtime state disagrees with its enablement document",
    );
  return nativePlugin(
    status,
    "gemini-extension-enablement",
    plugin.pluginId,
    layers,
    [document.evidence.path],
    uniformPluginAvailability(layers),
  );
}

function nativePlugin(
  status: "enabled" | "disabled",
  mechanism: Extract<
    PluginAvailability["control"],
    { readonly kind: "native" }
  >["mechanism"],
  pluginId: string,
  layers: readonly NativeControlDocumentEvidence[],
  writableLayerPaths: readonly string[],
  availability: Extract<
    PluginAvailability["control"],
    { readonly kind: "native" }
  >["availability"],
): PluginAvailability {
  return {
    status,
    control: {
      kind: "native",
      mechanism,
      availability,
      selector: { kind: "plugin-id", value: pluginId },
      layers,
      writableLayerPaths,
    },
  };
}

function unresolvedPlugin(
  mechanism: Extract<
    PluginAvailability["control"],
    { readonly kind: "native" }
  >["mechanism"],
  pluginId: string,
  layers: readonly NativeControlDocumentEvidence[],
  writableLayerPaths: readonly string[],
  reason: string,
): PluginAvailability {
  return {
    status: "unresolved",
    control: {
      kind: "native",
      mechanism,
      availability: {
        disable: { kind: "unavailable", reason },
        enable: { kind: "unavailable", reason },
      },
      selector: { kind: "plugin-id", value: pluginId },
      layers,
      writableLayerPaths,
    },
  };
}

function uniformPluginAvailability(
  layers: readonly NativeControlDocumentEvidence[],
): Extract<
  PluginAvailability["control"],
  { readonly kind: "native" }
>["availability"] {
  const result = layers.some(layerWritable)
    ? ({ kind: "available" } as const)
    : ({
        kind: "unavailable",
        reason: "the Plugin configuration document is not safe to modify",
      } as const);
  return { disable: result, enable: result };
}

function claudePluginOperationAvailability(
  layers: readonly NativeControlDocumentEvidence[],
): Extract<
  PluginAvailability["control"],
  { readonly kind: "native" }
>["availability"] {
  const user = layers.find((layer) => layer.documentScope === "user");
  const shared = layers.find(
    (layer) => layer.documentScope === "shared-workspace",
  );
  const local = layers.find(
    (layer) => layer.documentScope === "local-workspace",
  );
  const sharedValue = shared?.selectorValue;
  const localValue = local?.selectorValue;
  const userCanControl =
    user !== undefined &&
    layerWritable(user) &&
    sharedValue?.kind === "claude-enabled-plugins" &&
    sharedValue.enabled === null &&
    localValue?.kind === "claude-enabled-plugins" &&
    localValue.enabled === null;
  const available =
    (local !== undefined && layerWritable(local)) || userCanControl;
  const result = available
    ? ({ kind: "available" } as const)
    : ({
        kind: "unavailable",
        reason:
          "no writable Claude Code layer can override the effective Plugin setting",
      } as const);
  return { disable: result, enable: result };
}

function unsupported(harnessId: string): HarnessExposure {
  return {
    harnessId,
    status: "enabled",
    control: { kind: "unsupported", reason: unsupportedReason },
  };
}

async function codexExposure(
  installation: Installation,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<HarnessExposure> {
  const home =
    environment.agentHomeDirectories?.codex ??
    join(environment.homeDirectory, ".codex");
  const document = await readDocument(
    join(home, "config.toml"),
    "toml",
    { kind: "user" },
    "user",
    true,
  );
  const canonicalDirectory = installation.location.canonicalPath;
  if (canonicalDirectory === null)
    return unresolvedNative(
      codexHarness,
      "codex-skills-config",
      { kind: "path", value: installation.location.path },
      [document.evidence],
      [document.evidence.path],
      "the Skill path has no canonical location",
    );
  const selector = {
    kind: "path" as const,
    value: join(canonicalDirectory, "SKILL.md"),
  };
  const parsed = document.unsafe
    ? null
    : document.text === null
      ? await parseCodex("", selector.value, installation.skill.name)
      : await parseCodex(
          document.text,
          selector.value,
          installation.skill.name,
        );
  const layers = [withSelector(document.evidence, parsed?.value ?? null)];
  if (parsed === null)
    return unresolvedNative(
      codexHarness,
      "codex-skills-config",
      selector,
      layers,
      [document.evidence.path],
      "the Codex configuration is malformed, linked, hard-linked, unreadable, or changed while scanning",
    );
  const last = parsed.value.matchingRules.at(-1);
  return nativeExposure(
    codexHarness,
    last?.enabled === false ? "disabled" : "enabled",
    "codex-skills-config",
    selector,
    layers,
    [document.evidence.path],
    uniformAvailability(layers, [document.evidence.path]),
  );
}

async function claudeExposure(
  installation: Installation,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<HarnessExposure> {
  const home =
    environment.agentHomeDirectories?.[claudeHarness] ??
    join(environment.homeDirectory, ".claude");
  const workspace = environment.workspaceDirectory;
  const userSettings = join(home, "settings.json");
  const workspaceSettings = join(workspace, ".claude", "settings.json");
  const documents = await Promise.all([
    ...(pathKey(userSettings) === pathKey(workspaceSettings)
      ? []
      : [readDocument(userSettings, "json", { kind: "user" }, "user", true)]),
    readDocument(
      workspaceSettings,
      "json",
      { kind: "workspace", workspacePath: workspace },
      "shared-workspace",
      true,
    ),
    readDocument(
      join(workspace, ".claude", "settings.local.json"),
      "json",
      { kind: "workspace", workspacePath: workspace },
      "local-workspace",
      true,
    ),
  ]);
  const selector = { kind: "name" as const, value: installation.skill.name };
  const values = documents.map((document) =>
    document.unsafe
      ? null
      : document.text === null
        ? parseClaude("{}", selector.value)
        : parseClaude(document.text, selector.value),
  );
  const layers = documents.map((document, index) =>
    withSelector(document.evidence, values[index]?.value ?? null),
  );
  if (values.some((value) => value === null))
    return unresolvedNative(
      claudeHarness,
      "claude-skill-overrides",
      selector,
      layers,
      claudeWritableLayerPaths(documents),
      "a Claude Code configuration layer is malformed, linked, hard-linked, unreadable, or changed while scanning",
    );
  const modes = values
    .map((value) => value!.value.mode)
    .filter((mode) => mode !== null);
  const mode = modes.at(-1) ?? null;
  return nativeExposure(
    claudeHarness,
    mode === "off" ? "disabled" : "enabled",
    "claude-skill-overrides",
    selector,
    layers,
    claudeWritableLayerPaths(documents),
    claudeAvailability(layers),
  );
}

async function geminiExposure(
  installation: Installation,
  environment: InventoryScanEnvironment,
  readDocument: AvailabilityDocumentReader,
): Promise<HarnessExposure> {
  const home =
    environment.agentHomeDirectories?.[geminiHarness] ??
    join(environment.homeDirectory, ".gemini");
  const workspace = environment.workspaceDirectory;
  const documents = await Promise.all([
    readDocument(
      join(home, "settings.json"),
      "jsonc",
      { kind: "user" },
      "user",
      true,
    ),
    readDocument(
      join(workspace, ".gemini", "settings.json"),
      "jsonc",
      { kind: "workspace", workspacePath: workspace },
      "workspace",
      environment.geminiWorkspaceTrusted ?? "unresolved",
    ),
  ]);
  const selector = { kind: "name" as const, value: installation.skill.name };
  const values = documents.map((document) =>
    document.unsafe
      ? null
      : document.text === null
        ? parseGemini("{}", selector.value)
        : parseGemini(document.text, selector.value),
  );
  const layers = documents.map((document, index) =>
    withSelector(document.evidence, values[index]?.value ?? null),
  );
  if (values.some((value) => value === null))
    return unresolvedNative(
      geminiHarness,
      "gemini-disabled-skills",
      selector,
      layers,
      documents.map((document) => document.evidence.path),
      "a Gemini CLI configuration layer is malformed, linked, hard-linked, unreadable, or changed while scanning",
    );
  const workspaceDisabled = values[1]!.value.disabled;
  if (workspaceDisabled && layers[1]!.applies === "unresolved")
    return unresolvedNative(
      geminiHarness,
      "gemini-disabled-skills",
      selector,
      layers,
      documents.map((document) => document.evidence.path),
      "workspace folder trust cannot be proven from durable scan evidence",
    );
  const disabled = layers.some(
    (layer) =>
      layer.applies === true &&
      layer.selectorValue?.kind === "gemini-disabled-skills" &&
      layer.selectorValue.disabled,
  );
  return nativeExposure(
    geminiHarness,
    disabled ? "disabled" : "enabled",
    "gemini-disabled-skills",
    selector,
    layers,
    documents.map((document) => document.evidence.path),
    geminiAvailability(layers),
  );
}

function nativeExposure(
  harnessId: string,
  status: "enabled" | "disabled",
  mechanism: Extract<
    HarnessExposureControl,
    { readonly kind: "native" }
  >["mechanism"],
  selector: { readonly kind: "path" | "name"; readonly value: string },
  layers: readonly NativeControlDocumentEvidence[],
  writableLayerPaths: readonly string[],
  availability: Extract<
    HarnessExposureControl,
    { readonly kind: "native" }
  >["availability"],
): HarnessExposure {
  return {
    harnessId,
    status,
    control: {
      kind: "native",
      mechanism,
      availability,
      selector,
      layers,
      writableLayerPaths,
    },
  };
}

function uniformAvailability(
  layers: readonly NativeControlDocumentEvidence[],
  candidatePaths: readonly string[],
): Extract<
  HarnessExposureControl,
  { readonly kind: "native" }
>["availability"] {
  const candidate = layers.find(
    (layer) => candidatePaths.includes(layer.path) && layerWritable(layer),
  );
  const result =
    candidate === undefined
      ? {
          kind: "unavailable" as const,
          reason:
            "no writable native configuration candidate is safe to modify",
        }
      : { kind: "available" as const };
  return { disable: result, enable: result };
}

function claudeAvailability(
  layers: readonly NativeControlDocumentEvidence[],
): Extract<
  HarnessExposureControl,
  { readonly kind: "native" }
>["availability"] {
  const user = layers.find((layer) => layer.documentScope === "user");
  const shared = layers.find(
    (layer) => layer.documentScope === "shared-workspace",
  );
  const local = layers.find(
    (layer) => layer.documentScope === "local-workspace",
  );
  const localCanOverride = local !== undefined && layerWritable(local);
  const sharedMode = shared?.selectorValue;
  const localMode = local?.selectorValue;
  const userCanControl =
    user !== undefined &&
    layerWritable(user) &&
    sharedMode?.kind === "claude-skill-overrides" &&
    sharedMode.mode === null &&
    localMode?.kind === "claude-skill-overrides" &&
    localMode.mode === null;
  const result =
    localCanOverride || userCanControl
      ? { kind: "available" as const }
      : {
          kind: "unavailable" as const,
          reason:
            "no writable Claude Code layer can override the effective setting",
        };
  return { disable: result, enable: result };
}

function claudeWritableLayerPaths(
  documents: readonly Awaited<ReturnType<AvailabilityDocumentReader>>[],
): readonly string[] {
  return documents
    .filter((document) =>
      ["user", "local-workspace"].includes(document.evidence.documentScope),
    )
    .map((document) => document.evidence.path);
}

function geminiAvailability(
  layers: readonly NativeControlDocumentEvidence[],
): Extract<
  HarnessExposureControl,
  { readonly kind: "native" }
>["availability"] {
  const disableTarget = layers.find(
    (layer) => layer.applies === true && layerWritable(layer),
  );
  const enableTargets = layers.filter(
    (layer) =>
      layer.applies === true &&
      layer.selectorValue?.kind === "gemini-disabled-skills" &&
      layer.selectorValue.disabled,
  );
  return {
    disable:
      disableTarget === undefined
        ? {
            kind: "unavailable",
            reason: "no applied Gemini configuration layer is writable",
          }
        : { kind: "available" },
    enable: enableTargets.every(layerWritable)
      ? { kind: "available" }
      : {
          kind: "unavailable",
          reason:
            "every applied Gemini disabled-name membership must be writable to enable the Skill",
        },
  };
}

function layerWritable(layer: NativeControlDocumentEvidence): boolean {
  return (
    layer.protection.git.kind !== "protected" &&
    layer.protection.filesystem.kind === "writable"
  );
}

function unresolvedNative(
  harnessId: string,
  mechanism: Extract<
    HarnessExposureControl,
    { readonly kind: "native" }
  >["mechanism"],
  selector: { readonly kind: "path" | "name"; readonly value: string },
  layers: readonly NativeControlDocumentEvidence[],
  writableLayerPaths: readonly string[],
  reason: string,
): HarnessExposure {
  return {
    harnessId,
    status: "unresolved",
    control: {
      kind: "native",
      mechanism,
      availability: {
        disable: { kind: "unavailable", reason },
        enable: { kind: "unavailable", reason },
      },
      selector,
      layers,
      writableLayerPaths,
    },
  };
}

function withSelector(
  evidence: NativeControlDocumentEvidence,
  selectorValue: NativeControlSelectorValue | null,
): NativeControlDocumentEvidence {
  return { ...evidence, selectorValue };
}

function parseClaude(
  text: string,
  name: string,
): {
  readonly value: Extract<
    NativeControlSelectorValue,
    { readonly kind: "claude-skill-overrides" }
  >;
} | null {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (
    root === undefined ||
    errors.length > 0 ||
    hasDuplicateKeys(root) ||
    root.type !== "object"
  )
    return null;
  const value = root.children?.find(
    (property) => property.children?.[0]?.value === "skillOverrides",
  )?.children?.[1];
  if (value === undefined)
    return { value: { kind: "claude-skill-overrides", mode: null } };
  if (value.type !== "object") return null;
  const override = value.children?.find(
    (property) => property.children?.[0]?.value === name,
  )?.children?.[1];
  if (override === undefined)
    return { value: { kind: "claude-skill-overrides", mode: null } };
  if (
    override.type !== "string" ||
    !["on", "name-only", "user-invocable-only", "off"].includes(
      String(override.value),
    )
  )
    return null;
  return {
    value: {
      kind: "claude-skill-overrides",
      mode: override.value as
        "on" | "name-only" | "user-invocable-only" | "off",
    },
  };
}

function parseGemini(
  text: string,
  name: string,
): {
  readonly value: Extract<
    NativeControlSelectorValue,
    { readonly kind: "gemini-disabled-skills" }
  >;
} | null {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (
    root === undefined ||
    errors.length > 0 ||
    hasDuplicateKeys(root) ||
    root.type !== "object"
  )
    return null;
  const skills = root.children?.find(
    (property) => property.children?.[0]?.value === "skills",
  )?.children?.[1];
  if (skills === undefined)
    return { value: { kind: "gemini-disabled-skills", disabled: false } };
  if (skills.type !== "object") return null;
  const disabled = skills.children?.find(
    (property) => property.children?.[0]?.value === "disabled",
  )?.children?.[1];
  if (disabled === undefined)
    return { value: { kind: "gemini-disabled-skills", disabled: false } };
  if (
    disabled.type !== "array" ||
    !(disabled.children ?? []).every((item) => item.type === "string")
  )
    return null;
  return {
    value: {
      kind: "gemini-disabled-skills",
      disabled: (disabled.children ?? []).some((item) => item.value === name),
    },
  };
}

function parseClaudePlugin(
  text: string,
  pluginId: string,
): Extract<
  NativeControlSelectorValue,
  { readonly kind: "claude-enabled-plugins" }
> | null {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (
    root === undefined ||
    errors.length > 0 ||
    root.type !== "object" ||
    hasDuplicateKeys(root)
  )
    return null;
  const enabledPlugins = root.children?.find(
    (property) => property.children?.[0]?.value === "enabledPlugins",
  )?.children?.[1];
  if (enabledPlugins === undefined)
    return { kind: "claude-enabled-plugins", enabled: null };
  if (enabledPlugins.type !== "object") return null;
  const entry = enabledPlugins.children?.find(
    (property) => property.children?.[0]?.value === pluginId,
  )?.children?.[1];
  if (entry === undefined)
    return { kind: "claude-enabled-plugins", enabled: null };
  if (entry.type !== "boolean") return null;
  return { kind: "claude-enabled-plugins", enabled: entry.value as boolean };
}

function parseCodexPlugin(
  text: string,
  pluginId: string,
): Extract<
  NativeControlSelectorValue,
  { readonly kind: "codex-plugin-enabled" }
> | null {
  let root: Record<string, unknown>;
  try {
    root = parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (root.plugins === undefined)
    return { kind: "codex-plugin-enabled", enabled: null };
  if (!isRecord(root.plugins)) return null;
  const plugin = root.plugins[pluginId];
  if (plugin === undefined)
    return { kind: "codex-plugin-enabled", enabled: null };
  if (!isRecord(plugin)) return null;
  if (plugin.enabled === undefined)
    return { kind: "codex-plugin-enabled", enabled: null };
  if (typeof plugin.enabled !== "boolean") return null;
  return { kind: "codex-plugin-enabled", enabled: plugin.enabled };
}

function parseGeminiPlugin(
  text: string,
  pluginId: string,
  workspaceDirectory: string,
  scopePath: string,
): Extract<
  NativeControlSelectorValue,
  { readonly kind: "gemini-extension-enablement" }
> | null {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (
    root === undefined ||
    errors.length > 0 ||
    root.type !== "object" ||
    hasDuplicateKeys(root)
  )
    return null;
  for (const property of root.children ?? []) {
    const value = property.children?.[1];
    if (value?.type !== "object") return null;
    const overrides = value.children?.find(
      (child) => child.children?.[0]?.value === "overrides",
    )?.children?.[1];
    if (
      overrides?.type !== "array" ||
      !(overrides.children ?? []).every((item) => item.type === "string")
    )
      return null;
  }
  const entry = root.children?.find(
    (property) => property.children?.[0]?.value === pluginId,
  )?.children?.[1];
  if (entry === undefined)
    return {
      kind: "gemini-extension-enablement",
      overrides: [],
      enabled: true,
      scopePath,
    };
  if (entry.type !== "object") return null;
  const overridesNode = entry.children?.find(
    (property) => property.children?.[0]?.value === "overrides",
  )?.children?.[1];
  if (
    overridesNode === undefined ||
    overridesNode.type !== "array" ||
    !(overridesNode.children ?? []).every((item) => item.type === "string")
  )
    return null;
  const overrides = (overridesNode.children ?? []).map((item) =>
    String(item.value),
  );
  let enabled = true;
  const currentPath = normalizedGeminiRule(workspaceDirectory);
  for (const raw of overrides) {
    const disabled = raw.startsWith("!");
    let rule = disabled ? raw.slice(1) : raw;
    const includeSubdirs = rule.endsWith("*");
    if (includeSubdirs) rule = rule.slice(0, -1);
    const base = normalizedGeminiRule(rule);
    const expression = geminiRuleExpression(base, includeSubdirs);
    if (expression.test(currentPath)) enabled = !disabled;
  }
  return {
    kind: "gemini-extension-enablement",
    overrides,
    enabled,
    scopePath,
  };
}

function normalizedGeminiRule(value: string): string {
  let result = value.replaceAll("\\", "/");
  if (!result.startsWith("/")) result = `/${result}`;
  if (!result.endsWith("/")) result = `${result}/`;
  return result;
}

function geminiRuleExpression(base: string, includeSubdirs: boolean): RegExp {
  const source = `${base}${includeSubdirs ? "*" : ""}`
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/(\/?)\*/g, "($1.*)?");
  return new RegExp(`^${source}$`);
}

async function parseCodex(
  text: string,
  canonicalSkillPath: string,
  name: string,
): Promise<{
  readonly value: Extract<
    NativeControlSelectorValue,
    { readonly kind: "codex-skills-config" }
  >;
} | null> {
  let root: Record<string, unknown>;
  try {
    root = parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const skills = root.skills;
  if (skills === undefined)
    return { value: { kind: "codex-skills-config", matchingRules: [] } };
  if (!isRecord(skills)) return null;
  if (
    Object.keys(skills).some(
      (key) => !["config", "bundled", "include_instructions"].includes(key),
    ) ||
    (skills.bundled !== undefined && !isBundledSkillsConfig(skills.bundled)) ||
    (skills.include_instructions !== undefined &&
      typeof skills.include_instructions !== "boolean")
  )
    return null;
  const config = skills.config;
  if (config === undefined)
    return { value: { kind: "codex-skills-config", matchingRules: [] } };
  if (!Array.isArray(config)) return null;
  const matchingRules: {
    index: number;
    selector: { kind: "path" | "name"; value: string };
    enabled: boolean;
  }[] = [];
  for (const [index, rule] of config.entries()) {
    if (!isRecord(rule)) return null;
    const keys = Object.keys(rule);
    const hasPath = Object.hasOwn(rule, "path");
    const hasName = Object.hasOwn(rule, "name");
    if (
      keys.length !== 2 ||
      !Object.hasOwn(rule, "enabled") ||
      hasPath === hasName ||
      typeof rule.enabled !== "boolean"
    )
      return null;
    const kind: "path" | "name" = hasPath ? "path" : "name";
    const rawValue = rule[kind];
    if (typeof rawValue !== "string" || rawValue.length === 0) return null;
    const value =
      kind === "path"
        ? await canonicalizeCodexRulePath(rawValue)
        : rawValue.trim();
    if (value === null || value.length === 0) return null;
    if (
      (kind === "path" && value === canonicalSkillPath) ||
      (kind === "name" && value === name)
    )
      matchingRules.push({
        index,
        selector: { kind, value },
        enabled: rule.enabled,
      });
  }
  return { value: { kind: "codex-skills-config", matchingRules } };
}

async function canonicalizeCodexRulePath(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return resolve(path);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBundledSkillsConfig(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "enabled") &&
    (value.enabled === undefined || typeof value.enabled === "boolean")
  );
}
