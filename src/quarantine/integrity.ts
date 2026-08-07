import { createHash, type Hash } from "node:crypto";
import { basename, join } from "node:path";

import type { ArtifactType, Sha256Digest } from "../model/types.js";
import type {
  QuarantineFileStats,
  QuarantineFileSystem,
  QuarantineLink,
  RestorationMetadata,
} from "./types.js";
import { QuarantineError } from "./types.js";

export interface InspectedArtifact {
  readonly integrity: Sha256Digest;
  readonly stats: QuarantineFileStats;
  readonly restoration: RestorationMetadata;
}

export async function inspectArtifact(
  fileSystem: QuarantineFileSystem,
  path: string,
  expectedType: ArtifactType,
): Promise<InspectedArtifact> {
  const stats = await fileSystem.lstat(path);
  await assertExpectedType(fileSystem, path, stats, expectedType);
  const digest = await hashArtifact(fileSystem, path, expectedType);
  return {
    integrity: { algorithm: "sha256", digest },
    stats,
    restoration:
      stats.kind === "file" || stats.kind === "directory"
        ? {
            mode: stats.mode,
            modifiedAt: validDate(stats.modifiedAt)
              ? stats.modifiedAt.toISOString()
              : null,
          }
        : { mode: null, modifiedAt: null },
  };
}

export async function hashArtifact(
  fileSystem: QuarantineFileSystem,
  path: string,
  expectedType?: ArtifactType,
): Promise<string> {
  const stats = await fileSystem.lstat(path);
  if (stats.kind === "file") {
    return createHash("sha256")
      .update(await fileSystem.readFile(path))
      .digest("hex");
  }
  const hash = createHash("sha256");
  if (stats.kind === "directory") {
    await hashDirectory(fileSystem, path, "", hash);
    return hash.digest("hex");
  }
  if (stats.kind === "symbolic-link") {
    const link = await fileSystem.readLink(path);
    updateField(hash, expectedType?.kind ?? link.kind);
    updateField(hash, link.target);
    return hash.digest("hex");
  }
  throw unsupported(path);
}

export async function copyArtifact(
  fileSystem: QuarantineFileSystem,
  source: string,
  destination: string,
  expectedType: ArtifactType,
): Promise<void> {
  const stats = await fileSystem.lstat(source);
  await assertExpectedType(fileSystem, source, stats, expectedType);
  await copyNode(fileSystem, source, destination, stats, expectedType, true);
}

export async function mergeDirectoryArtifact(
  fileSystem: QuarantineFileSystem,
  source: string,
  destination: string,
  allowedDestinationEntry: string,
): Promise<void> {
  const sourceStats = await fileSystem.lstat(source);
  const destinationStats = await fileSystem.lstat(destination);
  if (
    sourceStats.kind !== "directory" ||
    destinationStats.kind !== "directory"
  ) {
    throw changed(destination);
  }
  await mergeDirectory(
    fileSystem,
    source,
    destination,
    allowedDestinationEntry,
  );
  await applyRestorationMetadata(fileSystem, destination, {
    mode: sourceStats.mode,
    modifiedAt: validDate(sourceStats.modifiedAt)
      ? sourceStats.modifiedAt.toISOString()
      : null,
  });
}

export async function removeArtifact(
  fileSystem: QuarantineFileSystem,
  path: string,
): Promise<void> {
  const stats = await fileSystem.lstat(path);
  if (stats.kind === "directory") {
    const children = [...(await fileSystem.readdir(path))].sort(compareText);
    for (const child of children) {
      await removeArtifact(fileSystem, join(path, child));
    }
    await fileSystem.rmdir(path);
    return;
  }
  await fileSystem.unlink(path);
}

export async function applyRestorationMetadata(
  fileSystem: QuarantineFileSystem,
  path: string,
  metadata: RestorationMetadata,
): Promise<void> {
  if (metadata.mode !== null) {
    await fileSystem.chmod(path, metadata.mode);
  }
  if (metadata.modifiedAt !== null) {
    const modifiedAt = new Date(metadata.modifiedAt);
    await fileSystem.utimes(path, modifiedAt, modifiedAt);
  }
}

async function hashDirectory(
  fileSystem: QuarantineFileSystem,
  path: string,
  relativePath: string,
  hash: Hash,
): Promise<void> {
  updateField(hash, "directory");
  updateField(hash, relativePath);
  const children = [...(await fileSystem.readdir(path))].sort(compareText);
  for (const child of children) {
    const childPath = join(path, child);
    const childRelativePath =
      relativePath.length === 0 ? child : `${relativePath}/${child}`;
    const stats = await fileSystem.lstat(childPath);
    if (stats.kind === "directory") {
      await hashDirectory(fileSystem, childPath, childRelativePath, hash);
    } else if (stats.kind === "file") {
      updateField(hash, "file");
      updateField(hash, childRelativePath);
      updateBuffer(hash, await fileSystem.readFile(childPath));
    } else if (stats.kind === "symbolic-link") {
      const link = await fileSystem.readLink(childPath);
      updateField(hash, link.kind);
      updateField(hash, childRelativePath);
      updateField(hash, link.target);
    } else {
      throw unsupported(childPath);
    }
  }
}

async function copyNode(
  fileSystem: QuarantineFileSystem,
  source: string,
  destination: string,
  stats: QuarantineFileStats,
  expectedType?: ArtifactType,
  topLevel = false,
): Promise<void> {
  if (stats.kind === "file") {
    try {
      await fileSystem.writeFile(
        destination,
        await fileSystem.readFile(source),
        { exclusive: true },
      );
    } catch (error: unknown) {
      throw destinationError(error, destination, topLevel);
    }
    await fileSystem.syncFile(destination);
    await applyRestorationMetadata(fileSystem, destination, {
      mode: stats.mode,
      modifiedAt: validDate(stats.modifiedAt)
        ? stats.modifiedAt.toISOString()
        : null,
    });
    return;
  }
  if (stats.kind === "directory") {
    try {
      await fileSystem.mkdir(destination);
    } catch (error: unknown) {
      throw destinationError(error, destination, topLevel);
    }
    const children = [...(await fileSystem.readdir(source))].sort(compareText);
    for (const child of children) {
      const childSource = join(source, child);
      const childStats = await fileSystem.lstat(childSource);
      await copyNode(
        fileSystem,
        childSource,
        join(destination, basename(childSource)),
        childStats,
        undefined,
        false,
      );
    }
    await applyRestorationMetadata(fileSystem, destination, {
      mode: stats.mode,
      modifiedAt: validDate(stats.modifiedAt)
        ? stats.modifiedAt.toISOString()
        : null,
    });
    await fileSystem.syncDirectory(destination);
    return;
  }
  if (stats.kind === "symbolic-link") {
    const link = await fileSystem.readLink(source);
    try {
      await createLink(fileSystem, destination, link, expectedType);
    } catch (error: unknown) {
      throw destinationError(error, destination, topLevel);
    }
    return;
  }
  throw unsupported(source);
}

async function mergeDirectory(
  fileSystem: QuarantineFileSystem,
  source: string,
  destination: string,
  allowedDestinationEntry: string | null,
): Promise<void> {
  const sourceChildren = [...(await fileSystem.readdir(source))].sort(
    compareText,
  );
  const sourceNames = new Set(sourceChildren);
  const destinationChildren = [...(await fileSystem.readdir(destination))].sort(
    compareText,
  );
  for (const child of destinationChildren) {
    if (child !== allowedDestinationEntry && !sourceNames.has(child)) {
      throw changed(join(destination, child));
    }
  }
  for (const child of sourceChildren) {
    const childSource = join(source, child);
    const childDestination = join(destination, child);
    const sourceStats = await fileSystem.lstat(childSource);
    const destinationStats = await lstatIfAvailable(
      fileSystem,
      childDestination,
    );
    if (destinationStats === null) {
      await copyNode(
        fileSystem,
        childSource,
        childDestination,
        sourceStats,
        undefined,
        true,
      );
      continue;
    }
    if (
      sourceStats.kind === "directory" &&
      destinationStats.kind === "directory"
    ) {
      await mergeDirectory(fileSystem, childSource, childDestination, null);
      await applyRestorationMetadata(fileSystem, childDestination, {
        mode: sourceStats.mode,
        modifiedAt: validDate(sourceStats.modifiedAt)
          ? sourceStats.modifiedAt.toISOString()
          : null,
      });
      continue;
    }
    if (
      sourceStats.kind !== destinationStats.kind ||
      (await hashArtifact(fileSystem, childSource)) !==
        (await hashArtifact(fileSystem, childDestination))
    ) {
      throw changed(childDestination);
    }
  }
}

async function lstatIfAvailable(
  fileSystem: QuarantineFileSystem,
  path: string,
): Promise<QuarantineFileStats | null> {
  try {
    return await fileSystem.lstat(path);
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
}

function destinationError(
  error: unknown,
  path: string,
  topLevel: boolean,
): unknown {
  if (
    topLevel &&
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  ) {
    return new QuarantineError(
      "entry-exists",
      `destination became occupied: ${path}`,
      path,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return error;
}

async function createLink(
  fileSystem: QuarantineFileSystem,
  path: string,
  link: QuarantineLink,
  expectedType?: ArtifactType,
): Promise<void> {
  const kind =
    expectedType?.kind === "junction" || link.kind === "junction"
      ? "junction"
      : process.platform === "win32"
        ? "dir"
        : undefined;
  await fileSystem.symlink(link.target, path, kind);
}

async function assertExpectedType(
  fileSystem: QuarantineFileSystem,
  path: string,
  stats: QuarantineFileStats,
  expectedType: ArtifactType,
): Promise<void> {
  if (expectedType.kind === "file" && stats.kind === "file") {
    return;
  }
  if (expectedType.kind === "directory" && stats.kind === "directory") {
    return;
  }
  if (
    (expectedType.kind === "symbolic-link" ||
      expectedType.kind === "junction") &&
    stats.kind === "symbolic-link"
  ) {
    const actual = await fileSystem.readLink(path);
    if (
      actual.kind !== expectedType.kind ||
      actual.target !== expectedType.target
    ) {
      throw new QuarantineError(
        "source-changed",
        `link identity changed before quarantine: ${path}`,
        path,
      );
    }
    return;
  }
  if (stats.kind === "other") {
    throw unsupported(path);
  }
  throw new QuarantineError(
    "source-changed",
    `artifact type changed before quarantine: ${path}`,
    path,
  );
}

function updateField(hash: Hash, value: string): void {
  updateBuffer(hash, Buffer.from(value, "utf8"));
}

function updateBuffer(hash: Hash, value: Buffer): void {
  hash.update(String(value.byteLength));
  hash.update(":");
  hash.update(value);
}

function unsupported(path: string): QuarantineError {
  return new QuarantineError(
    "unsupported-artifact",
    `unsupported filesystem artifact: ${path}`,
    path,
  );
}

function changed(path: string): QuarantineError {
  return new QuarantineError(
    "source-changed",
    `directory restore claim changed during publication: ${path}`,
    path,
  );
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
