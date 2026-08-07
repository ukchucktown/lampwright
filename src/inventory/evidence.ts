import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { Node as JsonNode } from "jsonc-parser";

import type { Sha256Digest } from "../model/types.js";

export async function readStableRegularFile(
  path: string,
  initialStats: Stats,
): Promise<{ readonly bytes: Buffer; readonly canonicalPath: string } | null> {
  if (
    !initialStats.isFile() ||
    initialStats.isSymbolicLink() ||
    initialStats.nlink !== 1
  ) {
    return null;
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch(() => null);
  if (handle === null) return null;
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.nlink !== 1 ||
      !sameFile(initialStats, openedStats)
    ) {
      return null;
    }
    const bytes = await handle.readFile();
    const finalStats = await handle.stat();
    const pathStats = await lstat(path).catch(() => null);
    const canonicalPath = await realpath(path).catch(() => null);
    const confirmedStats = await lstat(path).catch(() => null);
    if (
      pathStats === null ||
      confirmedStats === null ||
      canonicalPath === null ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      pathStats.nlink !== 1 ||
      !sameFile(openedStats, finalStats) ||
      !sameFile(finalStats, pathStats) ||
      !sameFile(pathStats, confirmedStats) ||
      openedStats.size !== finalStats.size ||
      openedStats.mtimeMs !== finalStats.mtimeMs ||
      openedStats.ctimeMs !== finalStats.ctimeMs
    ) {
      return null;
    }
    return { bytes, canonicalPath };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export function digest(bytes: Buffer): Sha256Digest {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function hasDuplicateKeys(node: JsonNode): boolean {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string" || seen.has(key)) return true;
      seen.add(key);
    }
  }
  return (node.children ?? []).some(hasDuplicateKeys);
}

export function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
