import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { GitProtection } from "../model/types.js";
import { runCommand } from "./process.js";

export async function inspectGitProtection(
  artifactPath: string,
): Promise<GitProtection> {
  const workingDirectory = dirname(artifactPath);
  const worktree = await findWorktree(workingDirectory);
  if (worktree === null) {
    return { kind: "outside-worktree" };
  }

  const relativeArtifactPath = relative(worktree, artifactPath)
    .split(sep)
    .join("/");
  const result = await runCommand("git", [
    "-C",
    worktree,
    "check-ignore",
    "--quiet",
    "--",
    relativeArtifactPath.length === 0 ? "." : relativeArtifactPath,
  ]);

  return result.exitCode === 0
    ? { kind: "ignored", worktreeRoot: worktree }
    : { kind: "protected", worktreeRoot: worktree };
}

async function findWorktree(startPath: string): Promise<string | null> {
  const result = await runCommand("git", [
    "-C",
    startPath,
    "rev-parse",
    "--show-toplevel",
  ]);
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
