import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

import { parse as parseToml } from "@iarna/toml";
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";

import type { NativeConfigurationMutation } from "../availability/types.js";
import type {
  SessionSetupConfigurationRequest,
  SessionSetupConfigurationWriter,
} from "../session-setup/types.js";

interface NativeDocumentEvidence {
  readonly path: string;
  readonly format: "toml" | "json" | "jsonc";
  readonly exists: boolean;
  readonly expectedPreimageHash: {
    readonly algorithm: "sha256";
    readonly digest: string;
  } | null;
}

export interface SessionSetupConfigurationEditor {
  edit(document: string, request: SessionSetupConfigurationRequest): string;
}

/**
 * Creates a Session setup writer on the same checked preimage and file-commit
 * primitives used by legacy native Availability.
 */
export function createSessionSetupConfigurationWriter(
  editor: SessionSetupConfigurationEditor,
): SessionSetupConfigurationWriter {
  let sequence = 0;
  const pending = new Map<
    string,
    { readonly evidence: NativeDocumentEvidence; readonly postimage: Buffer }
  >();
  return {
    async prepare(request) {
      const evidence: NativeDocumentEvidence = {
        path: request.path,
        format: request.format,
        exists: request.exists,
        expectedPreimageHash: request.expectedPreimage,
      };
      const prepared = await prepareNativeDocument(evidence, (document) =>
        editor.edit(document, request),
      );
      const token = `session-setup-write-${++sequence}`;
      if (prepared.changed)
        pending.set(token, { evidence, postimage: prepared.postimage });
      return {
        token,
        status: prepared.changed ? "changed" : "unchanged",
      };
    },
    async commit(prepared) {
      if (prepared.status === "unchanged") return;
      const value = pending.get(prepared.token);
      if (!value)
        throw new Error("prepared native configuration is unavailable");
      pending.delete(prepared.token);
      await commitNativeDocument(value.evidence, value.postimage);
    },
    async discard(prepared) {
      pending.delete(prepared.token);
    },
  };
}

/** Checked native TOML edits for the qualified Codex Session setup profile. */
export function createCodexSessionSetupConfigurationEditor(): SessionSetupConfigurationEditor {
  return { edit: (text, request) => editCodexToml(text, request) };
}

export const createCodexSessionSetupConfigurationWriter = () =>
  createSessionSetupConfigurationWriter(
    createCodexSessionSetupConfigurationEditor(),
  );

function editCodexToml(
  text: string,
  request: SessionSetupConfigurationRequest,
): string {
  parseToml(text);
  let updated = text;
  for (const mutation of request.mutations) {
    const selector = request.selectors.find(
      (item) => item.id === mutation.selectorId,
    );
    if (!selector)
      throw new Error(
        "Codex mutation selector is absent from its checked request",
      );
    const path =
      selector.kind === "skill-path"
        ? ["skills", "config"]
        : selector.kind === "plugin-id"
          ? ["plugins", selector.pluginId]
          : selector.kind === "mcp-server-key"
            ? selector.policyOwner.kind === "plugin"
              ? [
                  "plugins",
                  selector.policyOwner.pluginId,
                  "mcp_servers",
                  selector.serverKey,
                ]
              : ["mcp_servers", selector.serverKey]
            : ["apps", selector.connectorId];
    updated = setCodexTomlEnabled(
      updated,
      path,
      mutation.policy === "enabled",
      selector.kind === "skill-path" ? selector.path : null,
    );
  }
  parseToml(updated);
  return updated;
}

function setCodexTomlEnabled(
  text: string,
  path: readonly string[],
  enabled: boolean,
  skillPath: string | null,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const header = `[${path
    .map((part) =>
      /^[A-Za-z0-9_-]+$/u.test(part) ? part : JSON.stringify(part),
    )
    .join(".")}]`;
  let start = lines.findIndex((line) => sameTomlTablePath(line, path));
  if (skillPath !== null) {
    const candidates: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.trim() !== "[[skills.config]]") continue;
      let end = lines.length;
      for (let next = index + 1; next < lines.length; next += 1)
        if (/^\s*\[/u.test(lines[next]!)) {
          end = next;
          break;
        }
      if (
        lines
          .slice(index + 1, end)
          .some((candidate) => tomlPathValue(candidate) === skillPath)
      )
        candidates.push(index);
    }
    if (candidates.length > 1) throw new Error("Codex Skill path is ambiguous");
    start = candidates[0] ?? -1;
  }
  if (start < 0) {
    const suffix = text.length === 0 || text.endsWith("\n") ? "" : eol;
    const table =
      skillPath === null
        ? `${header}${eol}`
        : `[[skills.config]]${eol}path = ${JSON.stringify(skillPath)}${eol}`;
    return `${text}${suffix}${table}enabled = ${enabled}${eol}`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1)
    if (/^\s*\[/u.test(lines[index]!)) {
      end = index;
      break;
    }
  const matches: number[] = [];
  for (let index = start + 1; index < end; index += 1)
    if (/^\s*enabled\s*=/u.test(lines[index]!)) matches.push(index);
  if (matches.length > 1) throw new Error("Codex enabled setting is ambiguous");
  if (matches.length === 1)
    lines[matches[0]!] = lines[matches[0]!]!.replace(
      /^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?)$/u,
      `$1${enabled}$3`,
    );
  else lines.splice(start + 1, 0, `enabled = ${enabled}`);
  return lines.join(eol);
}
function tomlPathValue(line: string): string | null {
  try {
    const value = parseToml(line);
    return typeof value.path === "string" ? value.path : null;
  } catch {
    return null;
  }
}

function sameTomlTablePath(line: string, path: readonly string[]): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return false;
  try {
    const parsed = parseToml(`${trimmed}\nvalue = true\n`);
    let current: unknown = parsed;
    for (const part of path) {
      if (typeof current !== "object" || current === null) return false;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "object" && current !== null;
  } catch {
    return false;
  }
}

export async function prepareAvailabilityMutation(
  mutation: NativeConfigurationMutation,
): Promise<Buffer> {
  return prepareAvailabilityMutations([mutation]);
}

export async function prepareAvailabilityMutations(
  mutations: readonly [
    NativeConfigurationMutation,
    ...NativeConfigurationMutation[],
  ],
): Promise<Buffer> {
  const mutation = mutations[0];
  for (const candidate of mutations) {
    if (
      candidate.path !== mutation.path ||
      candidate.exists !== mutation.exists ||
      candidate.expectedPreimageHash?.digest !==
        mutation.expectedPreimageHash?.digest
    )
      throw new Error("grouped native mutations do not share one preimage");
  }
  const prepared = await prepareNativeDocument(mutation, (document) => {
    let text = document;
    for (const candidate of mutations) text = mutate(text, candidate);
    return text;
  });
  return prepared.postimage;
}

export async function commitAvailabilityMutation(
  mutation: NativeConfigurationMutation,
  postimage: Buffer,
): Promise<void> {
  await commitNativeDocument(mutation, postimage);
}

async function prepareNativeDocument(
  evidence: NativeDocumentEvidence,
  edit: (document: string) => string,
): Promise<{ readonly postimage: Buffer; readonly changed: boolean }> {
  const preimage = await readRegularFile(evidence.path);
  if (evidence.exists) {
    if (preimage === null || evidence.expectedPreimageHash === null)
      throw new Error("native configuration disappeared since planning");
    if (digest(preimage) !== evidence.expectedPreimageHash.digest.toLowerCase())
      throw new Error("native configuration changed since planning");
  } else if (preimage !== null || evidence.expectedPreimageHash !== null) {
    throw new Error("native configuration became occupied since planning");
  }
  const original = preimage?.toString("utf8") ?? emptyDocument(evidence.format);
  const updated = edit(original);
  return {
    postimage: Buffer.from(updated, "utf8"),
    changed: updated !== original,
  };
}

async function commitNativeDocument(
  evidence: NativeDocumentEvidence,
  postimage: Buffer,
): Promise<void> {
  if (!evidence.exists) {
    await requireSafeParent(evidence.path);
    const handle = await open(evidence.path, "wx");
    try {
      await writeComplete(handle, postimage);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const before = await lstat(evidence.path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("native configuration is not a single-link regular file");
  const handle = await open(
    evidence.path,
    constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireSameFile(before, opened);
    await requirePathStillOpenedFile(evidence.path, opened);
    const current = await handle.readFile();
    if (
      evidence.expectedPreimageHash === null ||
      digest(current) !== evidence.expectedPreimageHash.digest.toLowerCase()
    )
      throw new Error("native configuration changed before mutation");
    await writeComplete(handle, postimage);
    await handle.truncate(postimage.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function mutate(text: string, mutation: NativeConfigurationMutation): string {
  if (mutation.operation.kind === "codex-skills-config") {
    parseToml(text.length === 0 ? "" : text);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const separator = text.length === 0 || text.endsWith("\n") ? "" : eol;
    return `${text}${separator}[[skills.config]]${eol}path = ${JSON.stringify(mutation.operation.selectorPath)}${eol}enabled = ${mutation.operation.enabled ? "true" : "false"}${eol}`;
  }
  if (mutation.operation.kind === "codex-plugin-enabled")
    return mutateCodexPlugin(
      text,
      mutation.operation.pluginId,
      mutation.operation.enabled,
    );
  const root = parseJson(text, mutation.format === "jsonc");
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
  if (mutation.operation.kind === "claude-skill-overrides") {
    return applyEdits(
      text,
      modify(
        text,
        ["skillOverrides", mutation.operation.skillName],
        mutation.operation.mode,
        { formattingOptions },
      ),
    );
  }
  if (mutation.operation.kind === "claude-enabled-plugins") {
    return applyEdits(
      text,
      modify(
        text,
        ["enabledPlugins", mutation.operation.pluginId],
        mutation.operation.enabled,
        { formattingOptions },
      ),
    );
  }
  if (mutation.operation.kind === "gemini-extension-enablement") {
    const entry = objectValue(root, mutation.operation.pluginId);
    const rawOverrides = objectValue(entry, "overrides");
    const overrides = Array.isArray(rawOverrides)
      ? rawOverrides.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const next = updateGeminiOverrides(
      overrides,
      mutation.operation.scopePath,
      mutation.operation.enabled,
    );
    return applyEdits(
      text,
      modify(text, [mutation.operation.pluginId, "overrides"], next, {
        formattingOptions,
      }),
    );
  }
  const skills = objectValue(root, "skills");
  const disabled = Array.isArray(objectValue(skills, "disabled"))
    ? (objectValue(skills, "disabled") as unknown[])
    : [];
  if (mutation.operation.disabled) {
    if (disabled.includes(mutation.operation.skillName)) return text;
    return applyEdits(
      text,
      modify(
        text,
        ["skills", "disabled", disabled.length],
        mutation.operation.skillName,
        { formattingOptions, isArrayInsertion: true },
      ),
    );
  }
  let updated = text;
  for (let index = disabled.length - 1; index >= 0; index -= 1) {
    if (disabled[index] !== mutation.operation.skillName) continue;
    updated = applyEdits(
      updated,
      modify(updated, ["skills", "disabled", index], undefined, {
        formattingOptions,
      }),
    );
  }
  return updated;
}

function mutateCodexPlugin(
  text: string,
  pluginId: string,
  enabled: boolean,
): string {
  parseToml(text.length === 0 ? "" : text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  let tableStart = -1;
  let tableEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed.startsWith("[")) continue;
    if (tableStart >= 0) {
      tableEnd = index;
      break;
    }
    if (trimmed.startsWith("[[")) continue;
    try {
      const parsed = parseToml(`${trimmed}${eol}`) as Record<string, unknown>;
      const plugins = objectValue(parsed, "plugins");
      if (
        typeof plugins === "object" &&
        plugins !== null &&
        Object.hasOwn(plugins, pluginId)
      )
        tableStart = index;
    } catch {
      // The complete document was already validated. A non-table line that
      // resembles a header is simply not the Plugin table we are looking for.
    }
  }
  if (tableStart < 0) {
    const separator = text.length === 0 || text.endsWith("\n") ? "" : eol;
    const result = `${text}${separator}[plugins.${JSON.stringify(pluginId)}]${eol}enabled = ${enabled ? "true" : "false"}${eol}`;
    parseToml(result);
    return result;
  }
  const assignments: number[] = [];
  for (let index = tableStart + 1; index < tableEnd; index += 1)
    if (/^\s*enabled\s*=/u.test(lines[index]!)) assignments.push(index);
  if (assignments.length > 1)
    throw new Error("Codex Plugin enabled setting is ambiguous");
  if (assignments.length === 1) {
    const index = assignments[0]!;
    lines[index] = lines[index]!.replace(
      /^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?)$/u,
      `$1${enabled ? "true" : "false"}$3`,
    );
    const result = lines.join(eol);
    parseToml(result);
    return result;
  }
  lines.splice(tableEnd, 0, `enabled = ${enabled ? "true" : "false"}`);
  const result = lines.join(eol);
  parseToml(result);
  return result;
}

function updateGeminiOverrides(
  overrides: readonly string[],
  scopePath: string,
  enabled: boolean,
): string[] {
  const intended = geminiOverride(scopePath, true, !enabled);
  const remaining = overrides.filter((raw) => {
    const existing = parseGeminiOverride(raw);
    if (
      existing.base === intended.base &&
      (existing.includeSubdirs !== intended.includeSubdirs ||
        existing.disabled !== intended.disabled)
    )
      return false;
    if (
      existing.base === intended.base &&
      existing.includeSubdirs === intended.includeSubdirs &&
      existing.disabled === intended.disabled
    )
      return false;
    return !(
      intended.includeSubdirs &&
      geminiOverrideRegex(intended).test(existing.base)
    );
  });
  return [...remaining, renderGeminiOverride(intended)];
}

interface GeminiOverride {
  readonly base: string;
  readonly includeSubdirs: boolean;
  readonly disabled: boolean;
}

function geminiOverride(
  path: string,
  includeSubdirs: boolean,
  disabled: boolean,
): GeminiOverride {
  let base = path.replaceAll("\\", "/");
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return { base, includeSubdirs, disabled };
}

function parseGeminiOverride(raw: string): GeminiOverride {
  const disabled = raw.startsWith("!");
  let path = disabled ? raw.slice(1) : raw;
  const includeSubdirs = path.endsWith("*");
  if (includeSubdirs) path = path.slice(0, -1);
  return geminiOverride(path, includeSubdirs, disabled);
}

function renderGeminiOverride(value: GeminiOverride): string {
  return `${value.disabled ? "!" : ""}${value.base}${value.includeSubdirs ? "*" : ""}`;
}

function geminiOverrideRegex(value: GeminiOverride): RegExp {
  const source = `${value.base}${value.includeSubdirs ? "*" : ""}`
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/(\/?)\*/g, "($1.*)?");
  return new RegExp(`^${source}$`);
}

function parseJson(text: string, allowComments: boolean): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: allowComments,
    disallowComments: !allowComments,
  });
  const treeErrors: ParseError[] = [];
  const tree = parseTree(text, treeErrors, {
    allowTrailingComma: allowComments,
    disallowComments: !allowComments,
  });
  if (
    errors.length > 0 ||
    tree === undefined ||
    treeErrors.length > 0 ||
    tree.type !== "object" ||
    hasDuplicateKeys(tree)
  )
    throw new Error("native configuration is malformed or ambiguous");
  return value;
}

function hasDuplicateKeys(node: JsonNode): boolean {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string" || keys.has(key)) return true;
      keys.add(key);
    }
  }
  return (node.children ?? []).some(hasDuplicateKeys);
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
function emptyDocument(format: NativeDocumentEvidence["format"]): string {
  return format === "toml" ? "" : "{}\n";
}
async function readRegularFile(path: string): Promise<Buffer | null> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("native configuration is not a single-link regular file");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireSameFile(before, opened);
    await requirePathStillOpenedFile(path, opened);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
function requireSameFile(before: Stats, opened: Stats): void {
  if (
    !opened.isFile() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.nlink !== 1
  )
    throw new Error("native configuration changed before mutation");
}
async function requirePathStillOpenedFile(
  path: string,
  opened: Stats,
): Promise<void> {
  const current = await lstat(path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    current.nlink !== 1
  )
    throw new Error("native configuration changed before mutation");
}
async function requireSafeParent(path: string): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("native configuration parent is unsafe");
}
async function writeComplete(
  handle: Awaited<ReturnType<typeof open>>,
  content: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesWritten === 0)
      throw new Error("native configuration write made no progress");
    offset += bytesWritten;
  }
}
function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
