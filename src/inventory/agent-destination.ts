import { dirname } from "node:path";
import type {
  ArtifactFileSystem,
  DirectoryWriteAccess,
} from "../filesystem/artifact-filesystem.js";
import type { GitProtection, AgentDestinationPreview } from "../model/types.js";
import { pathKey } from "./evidence.js";

export interface AgentDestinationAccess {
  readonly fileSystem: ArtifactFileSystem & DirectoryWriteAccess;
  readonly inspectGit: (
    path: string,
    creatingDirectory: boolean,
  ) => Promise<GitProtection>;
}

export async function isCanonicalDirectory(
  fileSystem: Pick<ArtifactFileSystem, "lstat" | "realpath">,
  path: string,
): Promise<boolean> {
  return (
    (await fileSystem.lstat(path)).kind === "directory" &&
    pathKey(await fileSystem.realpath(path)) === pathKey(path)
  );
}

export async function inspectAgentDestination(
  source: string,
  destination: string,
  access: AgentDestinationAccess,
): Promise<AgentDestinationPreview> {
  const { fileSystem } = access;
  const directories: string[] = [];
  const blocked = (reason: string): AgentDestinationPreview => ({
    state: "blocked",
    directories,
    reason,
  });
  try {
    if (!(await isCanonicalDirectory(fileSystem, source)))
      return blocked(
        "The canonical Skill directory has a linked ancestor or has moved.",
      );
    let parent = dirname(destination);
    while (true) {
      try {
        if (!(await isCanonicalDirectory(fileSystem, parent)))
          return blocked(
            `The destination has a linked or non-directory parent: ${parent}`,
          );
        break;
      } catch (error) {
        if (!hasCode(error, "ENOENT") || dirname(parent) === parent)
          throw error;
        directories.unshift(parent);
        parent = dirname(parent);
      }
    }
    const existing = await fileSystem
      .lstat(destination)
      .catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
        return null;
      });
    if (existing !== null) {
      if (
        (pathKey(source) === pathKey(destination) ||
          existing.kind === "symbolic-link") &&
        pathKey(await fileSystem.realpath(destination)) === pathKey(source)
      )
        return { state: "linked", directories, reason: null };
      return blocked(`Another entry occupies the destination: ${destination}`);
    }
    await fileSystem.checkDirectoryWritable(parent);
    for (const path of [...directories, destination])
      if (
        (await access.inspectGit(path, path !== destination)).kind ===
        "protected"
      )
        return blocked(`Git protects ${path}.`);
    return { state: "absent", directories, reason: null };
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
