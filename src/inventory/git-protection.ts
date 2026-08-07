import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { GitProtection } from "../model/types.js";
import type { InventoryCommandRunner } from "./types.js";

export async function inspectGitProtection(
  artifactPath: string,
  artifactIsDirectory: boolean,
  commandRunner: InventoryCommandRunner,
): Promise<GitProtection> {
  const worktree = await findWorktree(
    artifactIsDirectory ? artifactPath : dirname(artifactPath),
    commandRunner,
  );
  if (worktree === null) {
    return { kind: "outside-worktree" };
  }

  const relativeArtifactPath = relative(worktree, artifactPath)
    .split(sep)
    .join("/");
  const result = await commandRunner.run({
    executable: "git",
    arguments: [
      "-C",
      worktree,
      "check-ignore",
      "--quiet",
      "--",
      relativeArtifactPath.length === 0 ? "." : relativeArtifactPath,
    ],
  });

  return result.exitCode === 0
    ? { kind: "ignored", worktreeRoot: worktree }
    : { kind: "protected", worktreeRoot: worktree };
}

async function findWorktree(
  startPath: string,
  commandRunner: InventoryCommandRunner,
): Promise<string | null> {
  const result = await commandRunner.run({
    executable: "git",
    arguments: ["-C", startPath, "rev-parse", "--show-toplevel"],
  });
  if (result.exitCode === 0) {
    const output = result.stdout.replace(/\r?\n$/, "");
    return output.length === 0
      ? findWorktreeMarker(startPath)
      : resolve(output);
  }

  return findWorktreeMarker(startPath);
}

async function findWorktreeMarker(startPath: string): Promise<string | null> {
  let currentPath = resolve(startPath);
  while (true) {
    try {
      await lstat(join(currentPath, ".git"));
      return currentPath;
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        return currentPath;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
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
