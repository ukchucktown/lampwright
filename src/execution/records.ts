import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { parseDocument } from "yaml";

import { stringifyModel } from "../model/json.js";
import type {
  DeclarativeDocumentFormat,
  RecordCleanupAction,
  Sha256Digest,
  VerificationCheck,
} from "../model/types.js";

export type PreparedRecordCleanup =
  | { readonly status: "already-absent" }
  | {
      readonly status: "ready";
      readonly postimage: Buffer;
      readonly preimageHash: Sha256Digest;
      readonly postimageHash: Sha256Digest;
    };

export async function prepareRecordCleanup(
  action: RecordCleanupAction,
): Promise<PreparedRecordCleanup> {
  const preimage = await readRegularFile(action.location.path);
  if (preimage === null) return { status: "already-absent" };
  const preimageHash = digest(preimage);
  requireDigest(preimageHash, action.expectedFileHash, "record document");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(preimage);
  const values = parseDocumentValues(text, action.format);
  for (const record of action.records) {
    const value = values.get(record.recordPointer);
    if (value === missingRecord) {
      throw new Error(`record is absent: ${record.recordPointer}`);
    }
    requireDigest(
      digest(Buffer.from(stringifyModel(value, 0), "utf8")),
      record.expectedRecordHash,
      `record ${record.recordPointer}`,
    );
  }
  const postimage = Buffer.from(
    removeRecords(
      text,
      action.format,
      action.records.map((record) => record.recordPointer),
    ),
    "utf8",
  );
  return {
    status: "ready",
    postimage,
    preimageHash,
    postimageHash: digest(postimage),
  };
}

export async function commitRecordCleanup(
  path: string,
  expectedPreimage: Sha256Digest,
  postimage: Buffer,
): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("record document is not a single-link regular file");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDWR | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1
    ) {
      throw new Error("record document changed before mutation");
    }
    await requirePathStillOpenedFile(path, opened, "before mutation");
    const current = await handle.readFile();
    requireDigest(digest(current), expectedPreimage, "record document");
    let offset = 0;
    while (offset < postimage.length) {
      const { bytesWritten } = await handle.write(
        postimage,
        offset,
        postimage.length - offset,
        offset,
      );
      if (bytesWritten === 0) {
        throw new Error("record document write made no progress");
      }
      offset += bytesWritten;
    }
    await handle.truncate(postimage.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyRecordAbsent(
  check: Extract<VerificationCheck, { kind: "record-absent" }>,
): Promise<boolean> {
  const content = await readRegularFile(check.path);
  if (content === null) return true;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const values = parseDocumentValues(text, check.format);
  const value = values.get(check.recordPointer);
  if (value === missingRecord) return true;
  return (
    check.expectedRecordHash !== null &&
    values.parentKind(check.recordPointer) === "array" &&
    digest(Buffer.from(stringifyModel(value, 0), "utf8")).digest !==
      check.expectedRecordHash.digest.toLowerCase()
  );
}

const missingRecord = Symbol("missing-record");

function parseDocumentValues(
  text: string,
  format: DeclarativeDocumentFormat,
): Map<string, unknown | typeof missingRecord> & {
  get(pointer: string): unknown | typeof missingRecord;
  parentKind(pointer: string): "array" | "object" | null;
} {
  const root = parseDocumentRoot(text, format);
  const cache = new Map<string, unknown | typeof missingRecord>();
  return Object.assign(cache, {
    get(pointer: string): unknown | typeof missingRecord {
      if (cache.has(pointer)) return Map.prototype.get.call(cache, pointer);
      const value = valueAtPointer(root, pointer);
      cache.set(pointer, value);
      return value;
    },
    parentKind(pointer: string): "array" | "object" | null {
      const parent = valueAtSegments(
        root,
        pointerSegments(pointer).slice(0, -1),
      );
      if (Array.isArray(parent)) return "array";
      return typeof parent === "object" && parent !== null ? "object" : null;
    },
  });
}

function parseDocumentRoot(
  text: string,
  format: DeclarativeDocumentFormat,
): unknown {
  if (format === "yaml") {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    return document.toJS({ maxAliasCount: 0 });
  } else {
    const errors: ParseError[] = [];
    const root = parse(text, errors, {
      allowTrailingComma: format === "jsonc",
      disallowComments: format === "json",
    });
    if (errors.length > 0) throw new Error("record document is invalid JSON");
    const treeErrors: ParseError[] = [];
    const tree = parseTree(text, treeErrors, {
      allowTrailingComma: format === "jsonc",
      disallowComments: format === "json",
    });
    if (tree === undefined || treeErrors.length > 0 || hasDuplicateKeys(tree)) {
      throw new Error("record document has ambiguous duplicate keys");
    }
    return root;
  }
}

function removeRecords(
  text: string,
  format: DeclarativeDocumentFormat,
  pointers: readonly string[],
): string {
  if (format === "yaml") {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    const root = document.toJS({ maxAliasCount: 0 });
    for (const pointer of removalOrder(pointers, root)) {
      document.deleteIn(containerAwarePointerSegments(root, pointer));
    }
    return document.toString();
  }
  let updated = text;
  const root = parseDocumentRoot(text, format);
  for (const pointer of removalOrder(pointers, root)) {
    updated = applyEdits(
      updated,
      modify(
        updated,
        containerAwarePointerSegments(
          parseDocumentRoot(updated, format),
          pointer,
        ),
        undefined,
        {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: text.includes("\r\n") ? "\r\n" : "\n",
          },
        },
      ),
    );
  }
  return updated;
}

function valueAtPointer(
  root: unknown,
  pointer: string,
): unknown | typeof missingRecord {
  return valueAtSegments(root, pointerSegments(pointer));
}

function valueAtSegments(
  root: unknown,
  segments: readonly string[],
): unknown | typeof missingRecord {
  let value = root;
  for (const segment of segments) {
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(segment)) return missingRecord;
      const index = Number(segment);
      if (index >= value.length) return missingRecord;
      value = value[index];
    } else if (
      typeof value === "object" &&
      value !== null &&
      Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return missingRecord;
    }
  }
  return value;
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function containerAwarePointerSegments(
  root: unknown,
  pointer: string,
): (number | string)[] {
  let value = root;
  return pointerSegments(pointer).map((segment) => {
    if (Array.isArray(value) && /^\d+$/.test(segment)) {
      const index = Number(segment);
      value = value[index];
      return index;
    }
    if (typeof value === "object" && value !== null) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      value = undefined;
    }
    return segment;
  });
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

function removalOrder(
  pointers: readonly string[],
  root: unknown,
): readonly string[] {
  return [...pointers].sort((left, right) => {
    const leftSegments = containerAwarePointerSegments(root, left);
    const rightSegments = containerAwarePointerSegments(root, right);
    const length = Math.min(leftSegments.length, rightSegments.length);
    for (let index = 0; index < length; index += 1) {
      const leftSegment = leftSegments[index]!;
      const rightSegment = rightSegments[index]!;
      if (leftSegment === rightSegment) continue;
      if (typeof leftSegment === "number" && typeof rightSegment === "number") {
        return rightSegment - leftSegment;
      }
      return String(rightSegment) < String(leftSegment) ? -1 : 1;
    }
    return rightSegments.length - leftSegments.length;
  });
}

async function readRegularFile(path: string): Promise<Buffer | null> {
  let before;
  try {
    before = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("record document is not a single-link regular file");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1
    ) {
      throw new Error("record document changed before it could be read");
    }
    await requirePathStillOpenedFile(path, opened, "before it could be read");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function requirePathStillOpenedFile(
  path: string,
  opened: Stats,
  phase: string,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch {
    throw new Error(`record document changed ${phase}`);
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    current.nlink !== 1
  ) {
    throw new Error(`record document changed ${phase}`);
  }
}

function digest(content: Buffer): Sha256Digest {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

function requireDigest(
  actual: Sha256Digest,
  expected: Sha256Digest,
  label: string,
): void {
  if (actual.digest !== expected.digest.toLowerCase()) {
    throw new Error(`${label} changed since planning`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
