import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { GitProtection } from "../model/types.js";
import type { InventoryCommandRunner } from "./types.js";

export async function inspectGitProtection(
  artifactPath: string,
  artifactIsDirectory: boolean,
  commandRunner: InventoryCommandRunner,
): Promise<GitProtection> {
  const worktree = await resolveWorktree(
    artifactIsDirectory ? artifactPath : dirname(artifactPath),
    await pathState(artifactPath),
    commandRunner,
  );
  if (worktree.kind === "outside-worktree") return { kind: "outside-worktree" };
  if (worktree.kind === "protected")
    return { kind: "protected", worktreeRoot: worktree.path };

  const relativeArtifactPath = relative(worktree.path, artifactPath)
    .split(sep)
    .join("/");
  const result = await commandRunner.run({
    executable: "git",
    arguments: [
      "-C",
      worktree.path,
      "check-ignore",
      "--quiet",
      "--",
      relativeArtifactPath.length === 0 ? "." : relativeArtifactPath,
    ],
  });

  return result.exitCode === 0
    ? { kind: "ignored", worktreeRoot: worktree.path }
    : { kind: "protected", worktreeRoot: worktree.path };
}

type PathState = "exists" | "absent" | "uncertain";

type WorktreeResolution =
  | { readonly kind: "outside-worktree" }
  | { readonly kind: "classify"; readonly path: string }
  | { readonly kind: "protected"; readonly path: string };

async function resolveWorktree(
  startPath: string,
  requestedPathState: PathState,
  commandRunner: InventoryCommandRunner,
): Promise<WorktreeResolution> {
  const marker = await findWorktreeMarker(startPath);
  if (marker.kind === "outside-worktree") return marker;
  if (marker.kind === "worktree")
    return { kind: "classify", path: marker.path };
  if (requestedPathState !== "exists")
    return { kind: "protected", path: marker.path };

  const result = await commandRunner.run({
    executable: "git",
    arguments: ["-C", startPath, "rev-parse", "--show-toplevel"],
  });
  if (result.exitCode === 0) {
    const output = result.stdout.replace(/\r?\n$/, "");
    return {
      kind: "classify",
      path: output.length === 0 ? marker.path : resolve(output),
    };
  }

  return { kind: "classify", path: marker.path };
}

type WorktreeMarkerResult =
  | { readonly kind: "outside-worktree" }
  | { readonly kind: "worktree"; readonly path: string }
  | { readonly kind: "uncertain"; readonly path: string };

async function findWorktreeMarker(
  startPath: string,
): Promise<WorktreeMarkerResult> {
  let currentPath = resolve(startPath);
  while (true) {
    try {
      const current = await lstat(currentPath);
      if (!current.isDirectory() || current.isSymbolicLink())
        return { kind: "uncertain", path: currentPath };
    } catch (error: unknown) {
      if (!isMissingPathError(error))
        return { kind: "uncertain", path: currentPath };
    }

    try {
      const marker = await lstat(join(currentPath, ".git"));
      return marker.isDirectory() || marker.isFile()
        ? { kind: "worktree", path: currentPath }
        : { kind: "uncertain", path: currentPath };
    } catch (error: unknown) {
      if (!isMissingPathError(error))
        return { kind: "uncertain", path: currentPath };
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return { kind: "outside-worktree" };
    currentPath = parentPath;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function pathState(path: string): Promise<PathState> {
  try {
    await lstat(path);
    return "exists";
  } catch (error: unknown) {
    return isMissingPathError(error) ? "absent" : "uncertain";
  }
}
