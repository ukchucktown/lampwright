import { constants, type Stats } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  FilesystemProtection,
  NativeControlDocumentScope,
  NativeControlLayerApplicability,
  NativeControlDocumentEvidence,
  Scope,
} from "../model/types.js";
import { digest, readStableRegularFile } from "./evidence.js";
import { inspectGitProtection } from "./git-protection.js";
import type { InventoryCommandRunner } from "./types.js";

/** Reads only stable ordinary documents; callers fail closed when `unsafe` is true. */
export async function readAvailabilityDocument(
  path: string,
  format: NativeControlDocumentEvidence["format"],
  scope: Scope,
  documentScope: NativeControlDocumentScope,
  applies: NativeControlLayerApplicability,
  commandRunner: InventoryCommandRunner,
): Promise<{
  readonly evidence: NativeControlDocumentEvidence;
  readonly text: string | null;
  readonly unsafe: boolean;
}> {
  const initial = await lstatKnown(path);
  const git = await inspectGitProtection(path, false, commandRunner);
  if (initial === null) {
    return {
      evidence: {
        path,
        format,
        scope,
        documentScope,
        applies,
        exists: false,
        canonicalPath: null,
        preimageHash: null,
        protection: {
          git,
          system: { kind: "none" },
          filesystem: await parentWritable(path),
        },
        selectorValue: null,
      },
      text: null,
      unsafe: false,
    };
  }
  if (initial === undefined) {
    return {
      evidence: unsafeEvidence(
        path,
        format,
        scope,
        documentScope,
        applies,
        git,
        "configuration metadata is unreadable",
      ),
      text: null,
      unsafe: true,
    };
  }
  const stable = await readStableRegularFile(path, initial);
  if (stable === null)
    return {
      evidence: {
        path,
        format,
        scope,
        documentScope,
        applies,
        exists: true,
        canonicalPath: null,
        preimageHash: null,
        protection: {
          git,
          system: { kind: "none" },
          filesystem: {
            kind: "read-only",
            reason: "configuration is linked, hard-linked, or unstable",
          },
        },
        selectorValue: null,
      },
      text: null,
      unsafe: true,
    };
  const filesystem: FilesystemProtection = await access(path, constants.W_OK)
    .then(() => ({ kind: "writable" as const }))
    .catch(() => ({
      kind: "read-only" as const,
      reason: "configuration is not writable",
    }));
  return {
    evidence: {
      path,
      format,
      scope,
      documentScope,
      applies,
      exists: true,
      canonicalPath: stable.canonicalPath,
      preimageHash: digest(stable.bytes),
      protection: { git, system: { kind: "none" }, filesystem },
      selectorValue: null,
    },
    text: stable.bytes.toString("utf8"),
    unsafe: false,
  };
}

async function lstatKnown(path: string): Promise<Stats | null | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return null;
    return undefined;
  }
}

function unsafeEvidence(
  path: string,
  format: NativeControlDocumentEvidence["format"],
  scope: Scope,
  documentScope: NativeControlDocumentScope,
  applies: NativeControlLayerApplicability,
  git: NativeControlDocumentEvidence["protection"]["git"],
  reason: string,
): NativeControlDocumentEvidence {
  return {
    path,
    format,
    scope,
    documentScope,
    applies,
    exists: true,
    canonicalPath: null,
    preimageHash: null,
    protection: {
      git,
      system: { kind: "none" },
      filesystem: { kind: "read-only", reason },
    },
    selectorValue: null,
  };
}

async function parentWritable(path: string): Promise<FilesystemProtection> {
  return access(dirname(path), constants.W_OK)
    .then(() => ({ kind: "writable" as const }))
    .catch(() => ({
      kind: "read-only" as const,
      reason: "configuration parent is not writable",
    }));
}
