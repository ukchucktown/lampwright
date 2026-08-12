import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

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
  const preimage = await readRegularFile(mutation.path);
  if (mutation.exists) {
    if (preimage === null || mutation.expectedPreimageHash === null)
      throw new Error("native configuration disappeared since planning");
    if (digest(preimage) !== mutation.expectedPreimageHash.digest.toLowerCase())
      throw new Error("native configuration changed since planning");
  } else if (preimage !== null || mutation.expectedPreimageHash !== null) {
    throw new Error("native configuration became occupied since planning");
  }
  let text = preimage?.toString("utf8") ?? emptyDocument(mutation);
  for (const candidate of mutations) text = mutate(text, candidate);
  return Buffer.from(text, "utf8");
}

export async function commitAvailabilityMutation(
  mutation: NativeConfigurationMutation,
  postimage: Buffer,
): Promise<void> {
  if (!mutation.exists) {
    const handle = await open(mutation.path, "wx");
    try {
      await writeComplete(handle, postimage);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const before = await lstat(mutation.path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error("native configuration is not a single-link regular file");
  const handle = await open(
    mutation.path,
    constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    requireSameFile(before, opened);
    await requirePathStillOpenedFile(mutation.path, opened);
    const current = await handle.readFile();
    if (
      mutation.expectedPreimageHash === null ||
      digest(current) !== mutation.expectedPreimageHash.digest.toLowerCase()
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
function emptyDocument(mutation: NativeConfigurationMutation): string {
  return mutation.format === "toml" ? "" : "{}\n";
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
