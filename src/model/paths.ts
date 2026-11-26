import { posix, win32 } from "node:path";

import type { ArtifactLocation } from "./types.js";

export function physicalPathKey(location: ArtifactLocation): string {
  const path = location.canonicalPath ?? location.path;
  return normalizedPathKey(path);
}

export function artifactPathKey(location: ArtifactLocation): string {
  return mutationPathKey(location.path);
}

export function mutationPathKey(path: string): string {
  return normalizedPathKey(path);
}

export function locationContains(
  parent: ArtifactLocation,
  child: ArtifactLocation,
): boolean {
  return pathContains(parent.path, child.path);
}

export function quarantineLocationContains(
  quarantine: ArtifactLocation,
  cleanupDocument: ArtifactLocation,
): boolean {
  if (locationContains(quarantine, cleanupDocument)) {
    return true;
  }
  if (
    quarantine.artifactType.kind !== "directory" ||
    quarantine.canonicalPath === null
  ) {
    return false;
  }
  return pathContains(
    quarantine.canonicalPath,
    cleanupDocument.canonicalPath ?? cleanupDocument.path,
  );
}

export function pathContains(parentPath: string, childPath: string): boolean {
  if (isWindowsPath(parentPath) !== isWindowsPath(childPath)) {
    return false;
  }
  const windows = isWindowsPath(parentPath);
  const pathModule = windows ? win32 : posix;
  const normalizedParent = normalizeForComparison(parentPath, windows);
  const normalizedChild = normalizeForComparison(childPath, windows);
  const prefix = normalizedParent.endsWith(pathModule.sep)
    ? normalizedParent
    : normalizedParent + pathModule.sep;
  return (
    normalizedChild === normalizedParent || normalizedChild.startsWith(prefix)
  );
}

function isWindowsPath(path: string): boolean {
  // win32.isAbsolute also accepts /usr/skills. Only drive, UNC or backslash-rooted
  // spellings identify a Windows path independently of the host doing the planning.
  return (
    path.startsWith("\\") ||
    /^[a-z]:[\\/]/iu.test(path) ||
    /^\/\/[^/\\]+[\\/][^/\\]+/u.test(path)
  );
}

function normalizeForComparison(path: string, windows: boolean): string {
  const flavor = windows ? win32 : posix;
  const full = flavor.normalize(path);
  const normalized =
    full.endsWith(flavor.sep) && full.length > flavor.parse(full).root.length
      ? full.slice(0, -1)
      : full;
  return windows ? normalized.toLowerCase() : normalized;
}

function normalizedPathKey(path: string): string {
  return isWindowsPath(path)
    ? `windows:${normalizeForComparison(path, true)}`
    : `posix:${normalizeForComparison(path, false)}`;
}
