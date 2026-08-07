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

function pathContains(parentPath: string, childPath: string): boolean {
  if (isWindowsPath(parentPath) !== isWindowsPath(childPath)) {
    return false;
  }
  const windows = isWindowsPath(parentPath);
  const pathModule = windows ? win32 : posix;
  const normalizedParent = normalizeForComparison(parentPath, windows);
  const normalizedChild = normalizeForComparison(childPath, windows);
  const relativePath = pathModule.relative(normalizedParent, normalizedChild);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathModule.sep}`) &&
      !pathModule.isAbsolute(relativePath))
  );
}

function isWindowsPath(path: string): boolean {
  return win32.isAbsolute(path);
}

function normalizeForComparison(path: string, windows: boolean): string {
  const normalized = (windows ? win32 : posix).normalize(path);
  return windows ? normalized.toLowerCase() : normalized;
}

function normalizedPathKey(path: string): string {
  return isWindowsPath(path)
    ? `windows:${normalizeForComparison(path, true)}`
    : `posix:${normalizeForComparison(path, false)}`;
}
