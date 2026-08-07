import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AdapterTrustApproval } from "../adapter/types.js";
import { stringifyModel } from "../model/json.js";

export interface AdapterTrustStore {
  isTrusted(approval: AdapterTrustApproval): Promise<boolean>;
  trust(approval: AdapterTrustApproval): Promise<void>;
}

export function createFileAdapterTrustStore(
  stateRoot: string,
): AdapterTrustStore {
  if (!isAbsolute(stateRoot))
    throw new Error("adapter trust state root must be absolute");
  const directory = join(stateRoot, "trust", "v1", "adapters");
  return {
    async isTrusted(approval) {
      validate(approval);
      const path = join(directory, `${key(approval)}.json`);
      try {
        if (!(await existingSafeChain(stateRoot, directory))) return false;
        const stats = await lstat(path);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
          return false;
        const stored = JSON.parse(await readFile(path, "utf8")) as unknown;
        return (
          valid(stored) &&
          stringifyModel(stored, 0) === stringifyModel(approval, 0) &&
          key(stored) === key(approval)
        );
      } catch (error: unknown) {
        if (missing(error)) return false;
        throw error;
      }
    },
    async trust(approval) {
      validate(approval);
      await safeDirectory(stateRoot);
      await safeDirectory(join(stateRoot, "trust"));
      await safeDirectory(join(stateRoot, "trust", "v1"));
      await safeDirectory(directory);
      const path = join(directory, `${key(approval)}.json`);
      try {
        await writeFile(path, `${stringifyModel(approval)}\n`, { flag: "wx" });
      } catch (error: unknown) {
        if (!exists(error) || !(await this.isTrusted(approval))) throw error;
      }
    },
  };
}
async function existingSafeChain(root: string, leaf: string): Promise<boolean> {
  const relative = leaf.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of ["", ...relative]) {
    if (segment.length > 0) current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink())
        throw new Error(`unsafe adapter trust state path: ${current}`);
    } catch (error: unknown) {
      if (missing(error)) return false;
      throw error;
    }
  }
  return true;
}
async function safeDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error(`unsafe adapter trust state path: ${path}`);
  } catch (error: unknown) {
    if (!missing(error)) throw error;
    try {
      await mkdir(path);
    } catch (mkdirError: unknown) {
      if (!exists(mkdirError)) throw mkdirError;
    }
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error(`unsafe adapter trust state path: ${path}`);
  }
}
function valid(value: unknown): value is AdapterTrustApproval {
  return (
    typeof value === "object" &&
    value !== null &&
    "adapterId" in value &&
    "contentHash" in value &&
    typeof value.adapterId === "string" &&
    value.adapterId.trim().length > 0 &&
    typeof value.contentHash === "string" &&
    /^[a-f\d]{64}$/.test(value.contentHash)
  );
}
function validate(value: unknown): asserts value is AdapterTrustApproval {
  if (!valid(value)) throw new Error("invalid adapter trust approval");
}
function key(value: AdapterTrustApproval): string {
  return createHash("sha256").update(stringifyModel(value, 0)).digest("hex");
}
function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
function exists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
