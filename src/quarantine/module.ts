import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import { inspectGitProtection } from "../inventory/git-protection.js";
import { systemCommandRunner } from "../inventory/process.js";
import { stringifyModel } from "../model/json.js";
import type { ArtifactType, Sha256Digest } from "../model/types.js";
import { defaultLocalStateRoot } from "../state/index.js";
import { nodeQuarantineFileSystem } from "./filesystem.js";
import {
  applyRestorationMetadata,
  copyArtifact,
  hashArtifact,
  inspectArtifact,
  mergeDirectoryArtifact,
  removeArtifact,
} from "./integrity.js";
import {
  parseQuarantineEntry,
  parseQuarantineRequest,
  parseQuarantineSelection,
  parseRestoreResolution,
} from "./schema.js";
import type {
  PurgeEntryResult,
  PurgeOperationPreview,
  PurgeOperationResult,
  QuarantineEntry,
  QuarantineEntryId,
  QuarantineFileSystem,
  QuarantineGitProtectionInspector,
  QuarantineModule,
  QuarantineModuleOptions,
  QuarantineOperation,
  QuarantineRequest,
  QuarantineResult,
  PurgePreview,
  QuarantineSelection,
  RestorePreview,
  RestoreOperationPreview,
  RestoreOperationResult,
  RestoreResult,
} from "./types.js";
import { QuarantineError } from "./types.js";

const manifestName = "manifest.json";
const payloadName = "payload";
const transactionName = "transaction.json";
const restoreIntentName = "restore-intent.json";
const retentionMilliseconds = 30 * 24 * 60 * 60 * 1000;
const entryIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface StateLayout {
  readonly base: string;
  readonly entries: string;
  readonly staging: string;
  readonly purging: string;
}

interface CaptureTransaction {
  readonly schemaVersion: 1;
  readonly kind: "capture";
  readonly transfer: "copy" | "move" | "snapshot";
  readonly sourcePath: string;
  readonly pendingPath: string | null;
  readonly integrity: Sha256Digest;
  readonly artifactType: ArtifactType;
}

interface RestoreTransaction {
  readonly schemaVersion: 1;
  readonly kind: "restore";
  readonly destination: string;
  readonly temporaryPath: string;
  readonly backupPath: string | null;
  readonly integrity: Sha256Digest;
  readonly artifactType: ArtifactType;
}

interface RestoreIntent {
  readonly schemaVersion: 1;
  readonly entryId: QuarantineEntryId;
  readonly resolution: "alternate" | "original" | "replace-record-postimage";
  readonly destination: string;
}

type Transaction = CaptureTransaction | RestoreTransaction;

interface LoadedEntry {
  readonly entry: QuarantineEntry;
  readonly directory: string;
  readonly payload: string;
}

const transactionDigestSchema = z.strictObject({
  algorithm: z.literal("sha256"),
  digest: z.string().regex(/^[a-f\d]{64}$/i),
});
const transactionArtifactTypeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({ kind: z.literal("directory") }),
  z.strictObject({
    kind: z.literal("symbolic-link"),
    target: z.string().min(1),
    broken: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("junction"),
    target: z.string().min(1),
    broken: z.boolean(),
  }),
]);
const absoluteTransactionPath = z.string().refine(isAbsolute);
const transactionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("capture"),
    transfer: z.enum(["copy", "move", "snapshot"]),
    sourcePath: absoluteTransactionPath,
    pendingPath: absoluteTransactionPath.nullable(),
    integrity: transactionDigestSchema,
    artifactType: transactionArtifactTypeSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("restore"),
    destination: absoluteTransactionPath,
    temporaryPath: absoluteTransactionPath,
    backupPath: absoluteTransactionPath.nullable(),
    integrity: transactionDigestSchema,
    artifactType: transactionArtifactTypeSchema,
  }),
]);
const restoreIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entryId: z.string().regex(entryIdPattern),
  resolution: z.enum(["alternate", "original", "replace-record-postimage"]),
  destination: absoluteTransactionPath,
});

export function createQuarantineModule(
  options: QuarantineModuleOptions = {
    stateRoot: defaultLocalStateRoot(),
    now: () => new Date(),
    createId: randomUUID,
    fileSystem: nodeQuarantineFileSystem,
  },
): QuarantineModule {
  if (!isAbsolute(options.stateRoot)) {
    throw new QuarantineError(
      "invalid-request",
      `quarantine state root must be absolute: ${options.stateRoot}`,
      options.stateRoot,
    );
  }
  if (
    typeof options.now !== "function" ||
    typeof options.createId !== "function" ||
    typeof options.fileSystem?.lstat !== "function"
  ) {
    throw new QuarantineError(
      "invalid-request",
      "quarantine requires a clock, ID source, and filesystem",
    );
  }

  const fileSystem = options.fileSystem;
  const layout = createLayout(resolve(options.stateRoot));
  const inspectProtection: QuarantineGitProtectionInspector =
    options.inspectGitProtection ??
    ((path, artifactType) =>
      inspectGitProtection(
        path,
        artifactType.kind === "directory",
        systemCommandRunner,
      ));

  const module: QuarantineModule = {
    async list(): Promise<readonly QuarantineEntry[]> {
      if (!(await ensureLayout(fileSystem, layout, false))) {
        return [];
      }
      const entries: QuarantineEntry[] = [];
      for (const name of [...(await fileSystem.readdir(layout.entries))].sort(
        compareText,
      )) {
        if (!entryIdPattern.test(name)) {
          throw new QuarantineError(
            "invalid-entry",
            `invalid entry directory name: ${name}`,
            join(layout.entries, name),
          );
        }
        const loaded = await loadEntry(
          fileSystem,
          layout,
          name as QuarantineEntryId,
        );
        if (loaded === null) {
          continue;
        }
        if (
          (await lstatIfAvailable(
            fileSystem,
            join(loaded.directory, transactionName),
          )) !== null
        ) {
          throw new QuarantineError(
            "recovery-failed",
            `entry requires recovery before it can be listed: ${name}`,
            loaded.directory,
          );
        }
        if (!(await entryIntegrityMatches(fileSystem, loaded))) {
          throw new QuarantineError(
            "invalid-entry",
            `quarantine entry failed integrity verification: ${name}`,
            loaded.directory,
          );
        }
        entries.push(loaded.entry);
      }
      return entries;
    },

    async listOperations(): Promise<readonly QuarantineOperation[]> {
      return groupOperations(await module.list());
    },

    async previewRestoreOperation(operation): Promise<RestoreOperationPreview> {
      const entries = await Promise.all(
        operation.entries.map((entry) =>
          module.previewRestore(entry, restoreResolutionFor(entry)),
        ),
      );
      return {
        schemaVersion: 1,
        operationId: operation.id,
        entries,
        status: entries.every((entry) => entry.status === "would-restore")
          ? "would-restore"
          : "blocked",
      };
    },

    async restoreOperation(operation): Promise<RestoreOperationResult> {
      // A known collision or integrity failure blocks the whole operation;
      // individual restores are deliberately not attempted in that case.
      const preview = await module.previewRestoreOperation(operation);
      if (preview.status === "blocked") {
        return {
          operationId: operation.id,
          entries: preview.entries.map((entry) =>
            entry.status === "blocked"
              ? {
                  status: "blocked" as const,
                  entryId: entry.entryId,
                  reason: entry.reason,
                  path: entry.path,
                }
              : {
                  status: "not-attempted" as const,
                  entryId: entry.entryId,
                  reason: "known-conflict" as const,
                },
          ),
          status: "blocked",
        };
      }
      const entries: RestoreOperationResult["entries"][number][] = [];
      for (let index = 0; index < operation.entries.length; index += 1) {
        const entry = operation.entries[index]!;
        const result = await module.restore(entry, restoreResolutionFor(entry));
        entries.push(result);
        if (result.status === "blocked") {
          for (const unattempted of operation.entries.slice(index + 1)) {
            entries.push({
              status: "not-attempted",
              entryId: unattempted.id,
              reason: "prior-entry-failed",
            });
          }
          break;
        }
      }
      return {
        operationId: operation.id,
        entries,
        status: entries.every((entry) => entry.status === "restored")
          ? "restored"
          : entries.some((entry) => entry.status === "restored")
            ? "partial"
            : "blocked",
      };
    },

    async previewPurgeOperation(operation): Promise<PurgeOperationPreview> {
      return {
        operationId: operation.id,
        ...(await module.previewPurge({
          kind: "entries",
          entryIds: operation.entries.map((entry) => entry.id),
        })),
      };
    },

    async purgeOperation(operation): Promise<PurgeOperationResult> {
      return {
        operationId: operation.id,
        ...(await module.purge({
          kind: "entries",
          entryIds: operation.entries.map((entry) => entry.id),
        })),
      };
    },

    async quarantine(requestInput): Promise<QuarantineResult> {
      const request = parseQuarantineRequest(requestInput);
      if (
        (await lstatIfAvailable(fileSystem, request.location.path)) === null
      ) {
        await recoverTransactions(fileSystem, layout, inspectProtection);
        if (
          (await lstatIfAvailable(fileSystem, request.location.path)) === null
        ) {
          return { status: "already-absent", path: request.location.path };
        }
      }

      const createdAt = readTime(options.now);
      const id = readId(options.createId);
      const initial = await inspectSource(fileSystem, request);
      assertPreimageHash(request, initial.integrity);

      await recoverTransactions(fileSystem, layout, inspectProtection);
      const current = await inspectSource(fileSystem, request);
      if (!sameDigest(initial.integrity, current.integrity)) {
        throw changed(request.location.path);
      }
      assertPreimageHash(request, current.integrity);
      await assertGitMutationAllowed(
        inspectProtection,
        request.location.path,
        request.location.artifactType,
      );

      const entry = createEntry(request, id, createdAt, current);
      await ensureLayout(fileSystem, layout, true);
      const stage = join(layout.staging, entry.id);
      const destination = join(layout.entries, entry.id);
      await assertPathMissing(fileSystem, stage, "entry-exists");
      await assertPathMissing(fileSystem, destination, "entry-exists");
      await fileSystem.mkdir(stage);

      try {
        await writeJson(fileSystem, join(stage, manifestName), entry);
        if (request.kind === "record-cleanup-preimage") {
          if (entry.kind !== "record-cleanup-preimage") {
            throw new QuarantineError(
              "invalid-entry",
              "record preimage request produced the wrong entry kind",
            );
          }
          await captureSnapshot(fileSystem, request, entry, stage, destination);
        } else {
          if (entry.kind !== "displaced-artifact") {
            throw new QuarantineError(
              "invalid-entry",
              "displaced artifact request produced the wrong entry kind",
            );
          }
          await displaceArtifact(
            fileSystem,
            request,
            entry,
            stage,
            destination,
          );
        }
      } catch (error: unknown) {
        await rollbackKnownCapture(
          fileSystem,
          inspectProtection,
          layout,
          stage,
          destination,
          error,
        );
        throw asQuarantineError(error, request.location.path);
      }

      return { status: "quarantined", entry };
    },

    async restore(entryInput, resolutionInput): Promise<RestoreResult> {
      const requestedEntry = parseQuarantineEntry(entryInput);
      const resolution =
        resolutionInput === undefined
          ? undefined
          : parseRestoreResolution(resolutionInput);
      const restoredAt = readTime(options.now).toISOString();
      await recoverTransactions(fileSystem, layout, inspectProtection);
      const loaded = await loadEntry(fileSystem, layout, requestedEntry.id);
      if (loaded === null) {
        return {
          status: "blocked",
          entryId: requestedEntry.id,
          reason: "entry-not-found",
          path: requestedEntry.originalLocation.path,
        };
      }
      if (
        stringifyModel(loaded.entry, 0) !== stringifyModel(requestedEntry, 0)
      ) {
        return blocked(requestedEntry, "integrity-failed");
      }
      if (!(await entryIntegrityMatches(fileSystem, loaded))) {
        return blocked(requestedEntry, "integrity-failed");
      }

      if (resolution?.kind === "replace-record-postimage") {
        if (loaded.entry.kind !== "record-cleanup-preimage") {
          throw new QuarantineError(
            "invalid-request",
            "postimage replacement is only valid for a record preimage",
            loaded.entry.originalLocation.path,
          );
        }
        return restoreRecordPostimage(
          fileSystem,
          inspectProtection,
          loaded,
          restoredAt,
        );
      }

      const destination =
        resolution?.kind === "alternate-destination"
          ? resolve(resolution.path)
          : loaded.entry.originalLocation.path;
      if (
        resolution?.kind === "alternate-destination" &&
        (await pathResolvesInside(fileSystem, layout.base, destination))
      ) {
        throw new QuarantineError(
          "invalid-request",
          `alternate restore destination cannot be inside quarantine state: ${destination}`,
          destination,
        );
      }
      if ((await lstatIfAvailable(fileSystem, destination)) !== null) {
        return {
          status: "blocked",
          entryId: loaded.entry.id,
          reason: "destination-occupied",
          path: destination,
        };
      }
      await assertSafeDestinationParent(fileSystem, destination);
      const protectionBlock = await blockedByGitProtection(
        inspectProtection,
        loaded.entry,
        destination,
      );
      if (protectionBlock !== null) {
        return protectionBlock;
      }
      const temporaryProtectionBlock = await blockedByGitProtection(
        inspectProtection,
        loaded.entry,
        restoreTemporaryPath(destination, loaded.entry.id),
      );
      if (temporaryProtectionBlock !== null) {
        return temporaryProtectionBlock;
      }
      if (!(await restoreToFreeDestination(fileSystem, loaded, destination))) {
        return {
          status: "blocked",
          entryId: loaded.entry.id,
          reason: "destination-occupied",
          path: destination,
        };
      }
      return {
        status: "restored",
        entryId: loaded.entry.id,
        destination,
        restoredAt,
      };
    },

    async previewRestore(entryInput, resolutionInput): Promise<RestorePreview> {
      const entry = parseQuarantineEntry(entryInput);
      const resolution =
        resolutionInput === undefined
          ? undefined
          : parseRestoreResolution(resolutionInput);
      const loaded = await loadEntry(fileSystem, layout, entry.id);
      if (loaded === null) {
        return {
          schemaVersion: 1,
          status: "blocked",
          entryId: entry.id,
          reason: "entry-not-found",
          path: entry.originalLocation.path,
        };
      }
      if (
        stringifyModel(loaded.entry, 0) !== stringifyModel(entry, 0) ||
        !(await entryIntegrityMatches(fileSystem, loaded))
      )
        return {
          schemaVersion: 1,
          status: "blocked",
          entryId: entry.id,
          reason: "integrity-failed",
          path: entry.originalLocation.path,
        };
      if (resolution?.kind === "replace-record-postimage") {
        if (loaded.entry.kind !== "record-cleanup-preimage")
          throw new QuarantineError(
            "invalid-request",
            "postimage replacement is only valid for a record preimage",
            entry.originalLocation.path,
          );
        const stats = await lstatIfAvailable(
          fileSystem,
          entry.originalLocation.path,
        );
        if (
          stats?.kind !== "file" ||
          !(await pathMatchesDigest(
            fileSystem,
            entry.originalLocation.path,
            loaded.entry.expectedPostimageHash,
          ))
        )
          return {
            schemaVersion: 1,
            status: "blocked",
            entryId: entry.id,
            reason: "destination-changed",
            path: entry.originalLocation.path,
          };
      }
      const destination =
        resolution?.kind === "alternate-destination"
          ? resolve(resolution.path)
          : entry.originalLocation.path;
      if (
        resolution?.kind === "alternate-destination" &&
        (await pathResolvesInside(fileSystem, layout.base, destination))
      )
        throw new QuarantineError(
          "invalid-request",
          `alternate restore destination cannot be inside quarantine state: ${destination}`,
          destination,
        );
      if (
        resolution?.kind !== "replace-record-postimage" &&
        (await lstatIfAvailable(fileSystem, destination)) !== null
      ) {
        return {
          schemaVersion: 1,
          status: "blocked",
          entryId: entry.id,
          reason: "destination-occupied",
          path: destination,
        };
      }
      await assertSafeDestinationParent(fileSystem, destination);
      const paths =
        resolution?.kind === "replace-record-postimage"
          ? [
              destination,
              restoreTemporaryPath(destination, entry.id),
              restoreBackupPath(destination, entry.id),
            ]
          : [destination, restoreTemporaryPath(destination, entry.id)];
      for (const path of paths) {
        const protection = await blockedByGitProtection(
          inspectProtection,
          entry,
          path,
        );
        if (protection !== null && protection.status === "blocked")
          return {
            schemaVersion: 1,
            status: "blocked",
            entryId: protection.entryId,
            reason: protection.reason,
            path: protection.path,
          };
      }
      for (const path of paths.slice(1)) {
        if ((await lstatIfAvailable(fileSystem, path)) !== null) {
          throw new QuarantineError(
            "recovery-failed",
            `path is already occupied: ${path}`,
            path,
          );
        }
      }
      return {
        schemaVersion: 1,
        status: "would-restore",
        entryId: entry.id,
        destination,
      };
    },

    async purge(selectionInput): Promise<{
      readonly purgedAt: string;
      readonly entries: readonly PurgeEntryResult[];
    }> {
      const selection = parseQuarantineSelection(selectionInput);
      const purgedAt = readTime(options.now);
      if (selection.kind === "entries" && selection.entryIds.length === 0) {
        return { purgedAt: purgedAt.toISOString(), entries: [] };
      }
      if (!(await ensureLayout(fileSystem, layout, false))) {
        return {
          purgedAt: purgedAt.toISOString(),
          entries:
            selection.kind === "entries"
              ? selectedMissingResults(selection.entryIds).map((entry) => ({
                  entryId: entry.entryId,
                  status: "unchanged" as const,
                  reason: "entry-not-found" as const,
                }))
              : [],
        };
      }
      await recoverTransactions(fileSystem, layout, inspectProtection);
      const ids = await selectedEntryIds(fileSystem, layout, selection);
      const results: PurgeEntryResult[] = [];
      for (const id of ids) {
        let loaded: LoadedEntry | null;
        try {
          loaded = await loadEntry(fileSystem, layout, id);
        } catch (error: unknown) {
          if (isIntegrityError(error)) {
            results.push({
              entryId: id,
              status: "blocked",
              reason: "integrity-failed",
            });
            continue;
          }
          throw error;
        }
        if (loaded === null) {
          if (selection.kind === "entries") {
            results.push({
              entryId: id,
              status: "unchanged",
              reason: "entry-not-found",
            });
          }
          continue;
        }
        if (
          selection.kind === "expired" &&
          Date.parse(loaded.entry.expiresAt) > purgedAt.getTime()
        ) {
          continue;
        }
        if (!(await entryIntegrityMatches(fileSystem, loaded))) {
          results.push({
            entryId: id,
            status: "blocked",
            reason: "integrity-failed",
          });
          continue;
        }
        const purgePath = join(layout.purging, id);
        await assertPathMissing(fileSystem, purgePath, "recovery-failed");
        await fileSystem.rename(loaded.directory, purgePath);
        await fileSystem.syncDirectory(layout.entries);
        await removeArtifact(fileSystem, purgePath);
        await fileSystem.syncDirectory(layout.purging);
        results.push({ entryId: id, status: "purged" });
      }
      return { purgedAt: purgedAt.toISOString(), entries: results };
    },
    async previewPurge(selectionInput): Promise<PurgePreview> {
      const selection = parseQuarantineSelection(selectionInput);
      const now = readTime(options.now);
      if (!(await ensureLayout(fileSystem, layout, false)))
        return {
          schemaVersion: 1,
          entries:
            selection.kind === "entries"
              ? selectedMissingResults(selection.entryIds).map((entry) => ({
                  entryId: entry.entryId,
                  status: "unchanged" as const,
                  reason: "entry-not-found" as const,
                }))
              : [],
        };
      const ids = await selectedEntryIds(fileSystem, layout, selection);
      const results: PurgePreview["entries"][number][] = [];
      for (const entryId of ids) {
        let loaded: LoadedEntry | null;
        try {
          loaded = await loadEntry(fileSystem, layout, entryId);
        } catch (error: unknown) {
          if (isIntegrityError(error)) {
            results.push({
              entryId,
              status: "blocked",
              reason: "integrity-failed",
            });
            continue;
          }
          throw error;
        }
        if (loaded === null) {
          if (selection.kind === "entries")
            results.push({
              entryId,
              status: "unchanged",
              reason: "entry-not-found",
            });
          continue;
        }
        if (
          selection.kind === "expired" &&
          Date.parse(loaded.entry.expiresAt) > now.getTime()
        )
          continue;
        if (!(await entryIntegrityMatches(fileSystem, loaded))) {
          results.push({
            entryId,
            status: "blocked",
            reason: "integrity-failed",
          });
          continue;
        }
        results.push({ entryId, status: "would-purge" });
      }
      return {
        schemaVersion: 1,
        entries: results,
      };
    },
  };
  return module;
}

function restoreResolutionFor(entry: QuarantineEntry) {
  return entry.kind === "record-cleanup-preimage"
    ? ({ kind: "replace-record-postimage" } as const)
    : undefined;
}

function createLayout(stateRoot: string): StateLayout {
  const base = join(stateRoot, "quarantine", "v1");
  return {
    base,
    entries: join(base, "entries"),
    staging: join(base, "staging"),
    purging: join(base, "purging"),
  };
}

async function inspectSource(
  fileSystem: QuarantineFileSystem,
  request: QuarantineRequest,
) {
  try {
    return await inspectArtifact(
      fileSystem,
      request.location.path,
      request.location.artifactType,
    );
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw new QuarantineError(
        "source-not-found",
        `quarantine source no longer exists: ${request.location.path}`,
        request.location.path,
        { cause: error },
      );
    }
    throw error;
  }
}

function createEntry(
  request: QuarantineRequest,
  id: QuarantineEntryId,
  createdAt: Date,
  inspected: Awaited<ReturnType<typeof inspectSource>>,
): QuarantineEntry {
  const timestamp = createdAt.toISOString();
  const common = {
    schemaVersion: 1 as const,
    id,
    createdAt: timestamp,
    expiresAt: new Date(
      createdAt.getTime() + retentionMilliseconds,
    ).toISOString(),
    originalLocation: request.location,
    integrity: normalizeDigest(inspected.integrity),
    provenance: request.provenance,
    restoration: inspected.restoration,
  };
  return parseQuarantineEntry(
    request.kind === "record-cleanup-preimage"
      ? {
          ...common,
          kind: request.kind,
          capturedAt: timestamp,
          expectedPreimageHash: normalizeDigest(request.expectedPreimageHash),
          expectedPostimageHash: normalizeDigest(request.expectedPostimageHash),
        }
      : { ...common, kind: request.kind, removedAt: timestamp },
  );
}

async function captureSnapshot(
  fileSystem: QuarantineFileSystem,
  request: Extract<QuarantineRequest, { kind: "record-cleanup-preimage" }>,
  entry: Extract<QuarantineEntry, { kind: "record-cleanup-preimage" }>,
  stage: string,
  destination: string,
): Promise<void> {
  const transaction: CaptureTransaction = {
    schemaVersion: 1,
    kind: "capture",
    transfer: "snapshot",
    sourcePath: request.location.path,
    pendingPath: null,
    integrity: entry.integrity,
    artifactType: entry.originalLocation.artifactType,
  };
  await writeJson(fileSystem, join(stage, transactionName), transaction);
  await copyArtifact(
    fileSystem,
    request.location.path,
    join(stage, payloadName),
    request.location.artifactType,
  );
  await requireDigest(fileSystem, join(stage, payloadName), entry);
  const liveHash = await hashArtifact(
    fileSystem,
    request.location.path,
    request.location.artifactType,
  );
  if (liveHash !== entry.integrity.digest) {
    throw changed(request.location.path);
  }
  await commitStage(fileSystem, stage, destination);
}

async function displaceArtifact(
  fileSystem: QuarantineFileSystem,
  request: Extract<QuarantineRequest, { kind: "displaced-artifact" }>,
  entry: Extract<QuarantineEntry, { kind: "displaced-artifact" }>,
  stage: string,
  destination: string,
): Promise<void> {
  const source = request.location.path;
  const payload = join(stage, payloadName);
  let transaction: CaptureTransaction = {
    schemaVersion: 1,
    kind: "capture",
    transfer: "move",
    sourcePath: source,
    pendingPath: null,
    integrity: entry.integrity,
    artifactType: entry.originalLocation.artifactType,
  };
  await writeJson(fileSystem, join(stage, transactionName), transaction);
  try {
    await fileSystem.rename(source, payload);
  } catch (error: unknown) {
    if (!isCode(error, "EXDEV")) {
      throw error;
    }
    const pending = pendingSourcePath(source, entry.id);
    await assertPathMissing(fileSystem, pending, "entry-exists");
    transaction = { ...transaction, transfer: "copy", pendingPath: pending };
    await writeJson(
      fileSystem,
      join(stage, transactionName),
      transaction,
      false,
    );
    await copyArtifact(
      fileSystem,
      source,
      payload,
      request.location.artifactType,
    );
    await requireDigest(fileSystem, payload, entry);
    const sourceHash = await hashArtifact(
      fileSystem,
      source,
      request.location.artifactType,
    );
    if (sourceHash !== entry.integrity.digest) {
      throw changed(source);
    }
    await fileSystem.rename(source, pending);
    const pendingHash = await hashArtifact(
      fileSystem,
      pending,
      request.location.artifactType,
    );
    if (pendingHash !== entry.integrity.digest) {
      throw changed(source);
    }
  }

  await requireDigest(fileSystem, payload, entry);
  await commitStage(fileSystem, stage, destination);
  const committedTransaction = join(destination, transactionName);
  if (transaction.pendingPath !== null) {
    await removeArtifact(fileSystem, transaction.pendingPath);
  }
  await fileSystem.unlink(committedTransaction);
  await fileSystem.syncDirectory(destination);
}

async function commitStage(
  fileSystem: QuarantineFileSystem,
  stage: string,
  destination: string,
): Promise<void> {
  await fileSystem.syncDirectory(stage);
  await fileSystem.rename(stage, destination);
  await fileSystem.syncDirectory(dirname(destination));
  const transactionPath = join(destination, transactionName);
  if ((await lstatIfAvailable(fileSystem, transactionPath)) !== null) {
    const transaction = await readTransaction(fileSystem, transactionPath);
    if (transaction.kind === "capture" && transaction.transfer === "snapshot") {
      await fileSystem.unlink(transactionPath);
      await fileSystem.syncDirectory(destination);
    }
  }
}

async function restoreToFreeDestination(
  fileSystem: QuarantineFileSystem,
  loaded: LoadedEntry,
  destination: string,
): Promise<boolean> {
  const temporaryPath = restoreTemporaryPath(destination, loaded.entry.id);
  await assertPathMissing(fileSystem, temporaryPath, "recovery-failed");
  const intent: RestoreIntent = {
    schemaVersion: 1,
    entryId: loaded.entry.id,
    resolution:
      destination === loaded.entry.originalLocation.path
        ? "original"
        : "alternate",
    destination,
  };
  const transaction: RestoreTransaction = {
    schemaVersion: 1,
    kind: "restore",
    destination,
    temporaryPath,
    backupPath: null,
    integrity: loaded.entry.integrity,
    artifactType: loaded.entry.originalLocation.artifactType,
  };
  await writeRestoreState(fileSystem, loaded, intent, transaction);
  await copyArtifact(
    fileSystem,
    loaded.payload,
    temporaryPath,
    loaded.entry.originalLocation.artifactType,
  );
  await requireDigestAt(fileSystem, temporaryPath, loaded.entry);
  if (
    !(await publishStagedArtifact(
      fileSystem,
      temporaryPath,
      destination,
      loaded.entry,
    ))
  ) {
    await removeArtifact(fileSystem, temporaryPath);
    await clearRestoreState(fileSystem, loaded);
    return false;
  }
  await requireDigestAt(fileSystem, destination, loaded.entry);
  await applyRestorationMetadata(
    fileSystem,
    destination,
    loaded.entry.restoration,
  );
  await removeArtifact(fileSystem, loaded.directory);
  await fileSystem.syncDirectory(dirname(loaded.directory));
  return true;
}

async function restoreRecordPostimage(
  fileSystem: QuarantineFileSystem,
  inspectProtection: QuarantineGitProtectionInspector,
  loaded: LoadedEntry,
  restoredAt: string,
): Promise<RestoreResult> {
  const entry = loaded.entry;
  if (entry.kind !== "record-cleanup-preimage") {
    throw new QuarantineError(
      "invalid-request",
      "postimage replacement is only valid for a record preimage",
      entry.originalLocation.path,
    );
  }
  const destination = entry.originalLocation.path;
  const destinationStats = await lstatIfAvailable(fileSystem, destination);
  if (destinationStats?.kind !== "file") {
    return {
      status: "blocked",
      entryId: entry.id,
      reason: "destination-changed",
      path: destination,
    };
  }
  if (
    !(await pathMatchesDigest(
      fileSystem,
      destination,
      entry.expectedPostimageHash,
    ))
  ) {
    return {
      status: "blocked",
      entryId: entry.id,
      reason: "destination-changed",
      path: destination,
    };
  }
  await assertSafeDestinationParent(fileSystem, destination);
  const protectionBlock = await blockedByGitProtection(
    inspectProtection,
    entry,
    destination,
  );
  if (protectionBlock !== null) {
    return protectionBlock;
  }
  const temporaryPath = restoreTemporaryPath(destination, entry.id);
  const backupPath = restoreBackupPath(destination, entry.id);
  for (const internalPath of [temporaryPath, backupPath]) {
    const internalProtectionBlock = await blockedByGitProtection(
      inspectProtection,
      entry,
      internalPath,
    );
    if (internalProtectionBlock !== null) {
      return internalProtectionBlock;
    }
  }
  await assertPathMissing(fileSystem, temporaryPath, "recovery-failed");
  await assertPathMissing(fileSystem, backupPath, "recovery-failed");
  const intent: RestoreIntent = {
    schemaVersion: 1,
    entryId: entry.id,
    resolution: "replace-record-postimage",
    destination,
  };
  const transaction: RestoreTransaction = {
    schemaVersion: 1,
    kind: "restore",
    destination,
    temporaryPath,
    backupPath,
    integrity: entry.integrity,
    artifactType: entry.originalLocation.artifactType,
  };
  await writeRestoreState(fileSystem, loaded, intent, transaction);
  await copyArtifact(
    fileSystem,
    loaded.payload,
    temporaryPath,
    entry.originalLocation.artifactType,
  );
  await requireDigestAt(fileSystem, temporaryPath, entry);
  try {
    await copyArtifact(
      fileSystem,
      destination,
      backupPath,
      entry.originalLocation.artifactType,
    );
  } catch (error: unknown) {
    await removeArtifact(fileSystem, temporaryPath);
    await clearRestoreState(fileSystem, loaded);
    throw error;
  }
  if (
    !(await pathMatchesDigest(
      fileSystem,
      backupPath,
      entry.expectedPostimageHash,
    ))
  ) {
    await abandonRecordRestore(fileSystem, loaded, temporaryPath, backupPath);
    throw new QuarantineError(
      "recovery-failed",
      `record restoration backup failed integrity verification: ${backupPath}`,
      backupPath,
    );
  }
  if (
    !(await pathMatchesDigest(
      fileSystem,
      destination,
      entry.expectedPostimageHash,
    ))
  ) {
    await abandonRecordRestore(fileSystem, loaded, temporaryPath, backupPath);
    return {
      status: "blocked",
      entryId: entry.id,
      reason: "destination-changed",
      path: destination,
    };
  }
  const freshProtectionBlock = await blockedByGitProtection(
    inspectProtection,
    entry,
    destination,
  );
  if (freshProtectionBlock !== null) {
    await abandonRecordRestore(fileSystem, loaded, temporaryPath, backupPath);
    return freshProtectionBlock;
  }
  await fileSystem.unlink(destination);
  if (
    !(await publishStagedArtifact(
      fileSystem,
      temporaryPath,
      destination,
      entry,
    ))
  ) {
    try {
      if ((await lstatIfAvailable(fileSystem, destination)) === null) {
        await copyArtifact(
          fileSystem,
          backupPath,
          destination,
          entry.originalLocation.artifactType,
        );
      }
      await abandonRecordRestore(fileSystem, loaded, temporaryPath, backupPath);
    } catch (rollbackError: unknown) {
      throw new QuarantineError(
        "recovery-failed",
        `record restoration rollback failed: ${destination}`,
        destination,
        { cause: rollbackError instanceof Error ? rollbackError : undefined },
      );
    }
    return {
      status: "blocked",
      entryId: entry.id,
      reason: "destination-changed",
      path: destination,
    };
  }
  await requireDigestAt(fileSystem, destination, entry);
  await applyRestorationMetadata(fileSystem, destination, entry.restoration);
  await removeArtifact(fileSystem, backupPath);
  await removeArtifact(fileSystem, loaded.directory);
  await fileSystem.syncDirectory(dirname(loaded.directory));
  return {
    status: "restored",
    entryId: entry.id,
    destination,
    restoredAt,
  };
}

async function abandonRecordRestore(
  fileSystem: QuarantineFileSystem,
  loaded: LoadedEntry,
  temporaryPath: string,
  backupPath: string,
): Promise<void> {
  if ((await lstatIfAvailable(fileSystem, temporaryPath)) !== null) {
    await removeArtifact(fileSystem, temporaryPath);
  }
  if ((await lstatIfAvailable(fileSystem, backupPath)) !== null) {
    await removeArtifact(fileSystem, backupPath);
  }
  await clearRestoreState(fileSystem, loaded);
}

async function writeRestoreState(
  fileSystem: QuarantineFileSystem,
  loaded: LoadedEntry,
  intent: RestoreIntent,
  transaction: RestoreTransaction,
): Promise<void> {
  const intentPath = join(loaded.directory, restoreIntentName);
  await writeJson(fileSystem, intentPath, intent);
  try {
    await writeJson(
      fileSystem,
      join(loaded.directory, transactionName),
      transaction,
    );
  } catch (error: unknown) {
    await fileSystem.unlink(intentPath);
    throw error;
  }
}

async function clearRestoreState(
  fileSystem: QuarantineFileSystem,
  loaded: LoadedEntry,
): Promise<void> {
  for (const name of [transactionName, restoreIntentName]) {
    const path = join(loaded.directory, name);
    if ((await lstatIfAvailable(fileSystem, path)) !== null) {
      await fileSystem.unlink(path);
    }
  }
  await fileSystem.syncDirectory(loaded.directory);
}

async function publishStagedArtifact(
  fileSystem: QuarantineFileSystem,
  temporaryPath: string,
  destination: string,
  entry: QuarantineEntry,
): Promise<boolean> {
  const artifactType = entry.originalLocation.artifactType;
  try {
    if (artifactType.kind === "file") {
      await fileSystem.link(temporaryPath, destination);
      await fileSystem.unlink(temporaryPath);
    } else if (artifactType.kind === "directory") {
      const claimName = restoreDirectoryClaimName(entry.id);
      const claimPath = join(destination, claimName);
      const expectedClaim = restoreDirectoryClaim(entry);
      if (
        (await lstatIfAvailable(fileSystem, join(temporaryPath, claimName))) !==
        null
      ) {
        throw new QuarantineError(
          "invalid-entry",
          `quarantined directory conflicts with its restore claim: ${claimName}`,
          temporaryPath,
        );
      }
      if ((await lstatIfAvailable(fileSystem, destination)) === null) {
        try {
          await fileSystem.mkdir(destination);
        } catch (error: unknown) {
          if (isCode(error, "EEXIST")) {
            return false;
          }
          throw error;
        }
        await fileSystem.writeFile(claimPath, expectedClaim, {
          exclusive: true,
        });
        await fileSystem.syncFile(claimPath);
        await fileSystem.syncDirectory(destination);
      } else {
        const claimStats = await lstatIfAvailable(fileSystem, claimPath);
        if (
          claimStats?.kind !== "file" ||
          !(await fileSystem.readFile(claimPath)).equals(expectedClaim)
        ) {
          return false;
        }
      }
      await mergeDirectoryArtifact(
        fileSystem,
        temporaryPath,
        destination,
        claimName,
      );
      await fileSystem.unlink(claimPath);
      await removeArtifact(fileSystem, temporaryPath);
    } else {
      await copyArtifact(fileSystem, temporaryPath, destination, artifactType);
      await removeArtifact(fileSystem, temporaryPath);
    }
    await fileSystem.syncDirectory(dirname(destination));
    return true;
  } catch (error: unknown) {
    if (
      isCode(error, "EEXIST") ||
      isCode(error, "ENOTEMPTY") ||
      (error instanceof QuarantineError && error.code === "entry-exists")
    ) {
      return false;
    }
    throw error;
  }
}

async function recoverTransactions(
  fileSystem: QuarantineFileSystem,
  layout: StateLayout,
  inspectProtection: QuarantineGitProtectionInspector,
): Promise<void> {
  if (!(await ensureLayout(fileSystem, layout, false))) {
    return;
  }
  await clearPurging(fileSystem, layout);
  for (const root of [layout.staging, layout.entries]) {
    for (const name of [...(await fileSystem.readdir(root))].sort(
      compareText,
    )) {
      const directory = join(root, name);
      const stats = await fileSystem.lstat(directory);
      if (stats.kind !== "directory") {
        throw unsafe(directory);
      }
      const transactionPath = join(directory, transactionName);
      if ((await lstatIfAvailable(fileSystem, transactionPath)) === null) {
        if (root === layout.staging) {
          await removeArtifact(fileSystem, directory);
        } else {
          const staleIntent = join(directory, restoreIntentName);
          if ((await lstatIfAvailable(fileSystem, staleIntent)) !== null) {
            await fileSystem.unlink(staleIntent);
          }
        }
        continue;
      }
      requireEntryId(name);
      const entry = await readManifest(fileSystem, directory);
      if (entry.id !== name) {
        throw new QuarantineError(
          "recovery-failed",
          `transaction manifest ID does not match its directory: ${name}`,
          directory,
        );
      }
      const transaction = await readTransaction(fileSystem, transactionPath);
      if (transaction.kind === "capture") {
        assertTransactionMatchesEntry(
          transaction,
          entry,
          null,
          layout,
          transactionPath,
        );
        await rollbackCapture(
          fileSystem,
          inspectProtection,
          directory,
          transaction,
        );
      } else {
        const intent = await readRestoreIntent(
          fileSystem,
          join(directory, restoreIntentName),
        );
        if (
          intent.resolution === "alternate" &&
          (await pathResolvesInside(
            fileSystem,
            layout.base,
            intent.destination,
          ))
        ) {
          throw new QuarantineError(
            "recovery-failed",
            `alternate restore intent resolves inside quarantine state: ${intent.destination}`,
            intent.destination,
          );
        }
        assertTransactionMatchesEntry(
          transaction,
          entry,
          intent,
          layout,
          transactionPath,
        );
        await recoverRestore(
          fileSystem,
          inspectProtection,
          directory,
          entry,
          intent,
          transaction,
        );
      }
    }
  }
}

async function rollbackKnownCapture(
  fileSystem: QuarantineFileSystem,
  inspectProtection: QuarantineGitProtectionInspector,
  layout: StateLayout,
  stage: string,
  destination: string,
  originalError: unknown,
): Promise<void> {
  for (const directory of [stage, destination]) {
    const transactionPath = join(directory, transactionName);
    if ((await lstatIfAvailable(fileSystem, transactionPath)) === null) {
      continue;
    }
    try {
      const entry = await readManifest(fileSystem, directory);
      const transaction = await readTransaction(fileSystem, transactionPath);
      assertTransactionMatchesEntry(
        transaction,
        entry,
        null,
        layout,
        transactionPath,
      );
      if (transaction.kind !== "capture") {
        throw new QuarantineError(
          "recovery-failed",
          `expected a capture transaction: ${transactionPath}`,
          transactionPath,
        );
      }
      await rollbackCapture(
        fileSystem,
        inspectProtection,
        directory,
        transaction,
      );
    } catch (rollbackError: unknown) {
      throw new QuarantineError(
        "recovery-failed",
        `quarantine rollback failed at ${directory}`,
        directory,
        { cause: new AggregateError([originalError, rollbackError]) },
      );
    }
  }
}

async function rollbackCapture(
  fileSystem: QuarantineFileSystem,
  inspectProtection: QuarantineGitProtectionInspector,
  directory: string,
  transaction: CaptureTransaction,
): Promise<void> {
  const payload = join(directory, payloadName);
  if (
    transaction.transfer === "move" &&
    (await lstatIfAvailable(fileSystem, payload)) !== null
  ) {
    await requireTransactionDigest(fileSystem, payload, transaction);
    if ((await lstatIfAvailable(fileSystem, transaction.sourcePath)) !== null) {
      throw new QuarantineError(
        "recovery-failed",
        `cannot restore occupied source during recovery: ${transaction.sourcePath}`,
        transaction.sourcePath,
      );
    }
    await assertGitMutationAllowed(
      inspectProtection,
      transaction.sourcePath,
      transaction.artifactType,
    );
    await copyArtifact(
      fileSystem,
      payload,
      transaction.sourcePath,
      transaction.artifactType,
    );
    await removeArtifact(fileSystem, payload);
  }
  if (transaction.transfer === "copy" && transaction.pendingPath !== null) {
    const pending = await lstatIfAvailable(fileSystem, transaction.pendingPath);
    if (pending !== null) {
      await requireTransactionDigest(
        fileSystem,
        transaction.pendingPath,
        transaction,
      );
      if (
        (await lstatIfAvailable(fileSystem, transaction.sourcePath)) !== null
      ) {
        throw new QuarantineError(
          "recovery-failed",
          `cannot restore occupied source during recovery: ${transaction.sourcePath}`,
          transaction.sourcePath,
        );
      }
      await assertGitMutationAllowed(
        inspectProtection,
        transaction.sourcePath,
        transaction.artifactType,
      );
      await copyArtifact(
        fileSystem,
        transaction.pendingPath,
        transaction.sourcePath,
        transaction.artifactType,
      );
      await removeArtifact(fileSystem, transaction.pendingPath);
    } else if (
      (await lstatIfAvailable(fileSystem, transaction.sourcePath)) === null &&
      (await lstatIfAvailable(fileSystem, payload)) !== null
    ) {
      await requireTransactionDigest(fileSystem, payload, transaction);
      await assertGitMutationAllowed(
        inspectProtection,
        transaction.sourcePath,
        transaction.artifactType,
      );
      await copyArtifact(
        fileSystem,
        payload,
        transaction.sourcePath,
        transaction.artifactType,
      );
    }
  }
  if ((await lstatIfAvailable(fileSystem, directory)) !== null) {
    await removeArtifact(fileSystem, directory);
  }
}

async function recoverRestore(
  fileSystem: QuarantineFileSystem,
  inspectProtection: QuarantineGitProtectionInspector,
  directory: string,
  entry: QuarantineEntry,
  intent: RestoreIntent,
  transaction: RestoreTransaction,
): Promise<void> {
  await assertGitMutationAllowed(
    inspectProtection,
    transaction.temporaryPath,
    transaction.artifactType,
  );
  if (transaction.backupPath !== null) {
    await assertGitMutationAllowed(
      inspectProtection,
      transaction.backupPath,
      transaction.artifactType,
    );
  }
  let destination = await lstatIfAvailable(fileSystem, transaction.destination);
  if (
    destination !== null &&
    (await pathMatchesDigest(
      fileSystem,
      transaction.destination,
      transaction.integrity,
    ))
  ) {
    await assertGitMutationAllowed(
      inspectProtection,
      transaction.destination,
      transaction.artifactType,
    );
    await applyRestorationMetadata(
      fileSystem,
      transaction.destination,
      entry.restoration,
    );
    if (
      transaction.backupPath !== null &&
      (await lstatIfAvailable(fileSystem, transaction.backupPath)) !== null
    ) {
      await removeArtifact(fileSystem, transaction.backupPath);
    }
    if (
      (await lstatIfAvailable(fileSystem, transaction.temporaryPath)) !== null
    ) {
      await removeArtifact(fileSystem, transaction.temporaryPath);
    }
    await removeArtifact(fileSystem, directory);
    return;
  }
  const temporary = await lstatIfAvailable(
    fileSystem,
    transaction.temporaryPath,
  );
  const temporaryIsComplete =
    temporary !== null &&
    (await pathMatchesDigest(
      fileSystem,
      transaction.temporaryPath,
      transaction.integrity,
    ));
  if (
    transaction.backupPath !== null &&
    (await lstatIfAvailable(fileSystem, transaction.backupPath)) !== null
  ) {
    if (
      entry.kind !== "record-cleanup-preimage" ||
      !(await pathMatchesDigest(
        fileSystem,
        transaction.backupPath,
        entry.expectedPostimageHash,
      ))
    ) {
      throw new QuarantineError(
        "recovery-failed",
        `restore backup failed integrity verification: ${transaction.backupPath}`,
        transaction.backupPath,
      );
    }
    if (destination === null) {
      await assertGitMutationAllowed(
        inspectProtection,
        transaction.destination,
        transaction.artifactType,
      );
      if (
        !(await publishStagedArtifact(
          fileSystem,
          transaction.backupPath,
          transaction.destination,
          entry,
        ))
      ) {
        throw new QuarantineError(
          "recovery-failed",
          `restore destination became occupied during recovery: ${transaction.destination}`,
          transaction.destination,
        );
      }
      destination = await lstatIfAvailable(fileSystem, transaction.destination);
    } else if (
      !(await pathMatchesDigest(
        fileSystem,
        transaction.destination,
        entry.expectedPostimageHash,
      ))
    ) {
      throw new QuarantineError(
        "recovery-failed",
        `restore destination changed during recovery: ${transaction.destination}`,
        transaction.destination,
      );
    }
    if ((await lstatIfAvailable(fileSystem, transaction.backupPath)) !== null) {
      await removeArtifact(fileSystem, transaction.backupPath);
    }
    if (temporary !== null) {
      await removeArtifact(fileSystem, transaction.temporaryPath);
    }
    await clearRestoreState(fileSystem, {
      entry,
      directory,
      payload: join(directory, payloadName),
    });
    return;
  }
  if (
    (await lstatIfAvailable(fileSystem, join(directory, payloadName))) === null
  ) {
    throw new QuarantineError(
      "recovery-failed",
      `restore recovery lost the quarantine payload: ${entry.id}`,
      directory,
    );
  }
  const loaded: LoadedEntry = {
    entry,
    directory,
    payload: join(directory, payloadName),
  };
  if (
    temporaryIsComplete &&
    (destination === null || transaction.artifactType.kind === "directory")
  ) {
    await assertGitMutationAllowed(
      inspectProtection,
      intent.destination,
      transaction.artifactType,
    );
    const published = await publishStagedArtifact(
      fileSystem,
      transaction.temporaryPath,
      intent.destination,
      entry,
    );
    if (published) {
      await applyRestorationMetadata(
        fileSystem,
        intent.destination,
        entry.restoration,
      );
      await removeArtifact(fileSystem, directory);
      return;
    }
    if (transaction.artifactType.kind === "directory" && destination !== null) {
      throw new QuarantineError(
        "recovery-failed",
        `directory restore claim is ambiguous; remove or resolve the occupied destination: ${intent.destination}`,
        intent.destination,
      );
    }
  }
  if (temporary !== null) {
    await removeArtifact(fileSystem, transaction.temporaryPath);
  }
  await clearRestoreState(fileSystem, loaded);
}

async function clearPurging(
  fileSystem: QuarantineFileSystem,
  layout: StateLayout,
): Promise<void> {
  for (const name of [...(await fileSystem.readdir(layout.purging))].sort(
    compareText,
  )) {
    await removeArtifact(fileSystem, join(layout.purging, name));
  }
}

async function ensureLayout(
  fileSystem: QuarantineFileSystem,
  layout: StateLayout,
  create: boolean,
): Promise<boolean> {
  const stateRoot = dirname(dirname(layout.base));
  const stateStats = await lstatIfAvailable(fileSystem, stateRoot);
  if (stateStats === null) {
    if (!create) {
      return false;
    }
    await fileSystem.mkdir(stateRoot, { recursive: true });
  } else if (stateStats.kind !== "directory") {
    throw unsafe(stateRoot);
  }
  for (const path of [
    dirname(layout.base),
    layout.base,
    layout.entries,
    layout.staging,
    layout.purging,
  ]) {
    const stats = await lstatIfAvailable(fileSystem, path);
    if (stats === null) {
      if (!create) {
        return false;
      }
      await fileSystem.mkdir(path);
    } else if (stats.kind !== "directory") {
      throw unsafe(path);
    }
  }
  return true;
}

async function loadEntry(
  fileSystem: QuarantineFileSystem,
  layout: StateLayout,
  id: QuarantineEntryId,
): Promise<LoadedEntry | null> {
  requireEntryId(id);
  if (!(await ensureLayout(fileSystem, layout, false))) {
    return null;
  }
  const directory = join(layout.entries, id);
  const stats = await lstatIfAvailable(fileSystem, directory);
  if (stats === null) {
    return null;
  }
  if (stats.kind !== "directory") {
    throw unsafe(directory);
  }
  const entry = await readManifest(fileSystem, directory);
  if (entry.id !== id) {
    throw new QuarantineError(
      "invalid-entry",
      `quarantine manifest ID does not match its directory: ${id}`,
      directory,
    );
  }
  return { entry, directory, payload: join(directory, payloadName) };
}

async function readManifest(
  fileSystem: QuarantineFileSystem,
  directory: string,
): Promise<QuarantineEntry> {
  const path = join(directory, manifestName);
  const stats = await fileSystem.lstat(path);
  if (stats.kind !== "file") {
    throw unsafe(path);
  }
  try {
    return parseQuarantineEntry(
      JSON.parse((await fileSystem.readFile(path)).toString("utf8")),
    );
  } catch (error: unknown) {
    if (error instanceof QuarantineError) {
      throw error;
    }
    throw new QuarantineError(
      "invalid-entry",
      `invalid quarantine manifest: ${path}`,
      path,
      { cause: error },
    );
  }
}

async function entryIntegrityMatches(
  fileSystem: QuarantineFileSystem,
  loaded: LoadedEntry,
): Promise<boolean> {
  try {
    return (
      (await hashArtifact(
        fileSystem,
        loaded.payload,
        loaded.entry.originalLocation.artifactType,
      )) === loaded.entry.integrity.digest
    );
  } catch {
    return false;
  }
}

async function selectedEntryIds(
  fileSystem: QuarantineFileSystem,
  layout: StateLayout,
  selection: QuarantineSelection,
): Promise<QuarantineEntryId[]> {
  const names =
    selection.kind === "entries"
      ? selection.entryIds
      : (await fileSystem.readdir(layout.entries)).filter((name) =>
          entryIdPattern.test(name),
        );
  return [...new Set(names)].sort(compareText) as QuarantineEntryId[];
}

function selectedMissingResults(
  entryIds: readonly QuarantineEntryId[],
): PurgeEntryResult[] {
  return [...new Set(entryIds)].sort(compareText).map((entryId) => ({
    entryId,
    status: "unchanged" as const,
    reason: "entry-not-found" as const,
  }));
}

async function writeJson(
  fileSystem: QuarantineFileSystem,
  path: string,
  value: unknown,
  exclusive = true,
): Promise<void> {
  const temporary = `${path}.tmp`;
  if (!exclusive && (await lstatIfAvailable(fileSystem, path)) !== null) {
    await fileSystem.writeFile(temporary, `${stringifyModel(value)}\n`, {
      exclusive: true,
    });
    await fileSystem.syncFile(temporary);
    await fileSystem.rename(temporary, path);
  } else {
    await fileSystem.writeFile(path, `${stringifyModel(value)}\n`, {
      exclusive,
    });
    await fileSystem.syncFile(path);
  }
  await fileSystem.syncDirectory(dirname(path));
}

async function readTransaction(
  fileSystem: QuarantineFileSystem,
  path: string,
): Promise<Transaction> {
  const stats = await fileSystem.lstat(path);
  if (stats.kind !== "file") {
    throw unsafe(path);
  }
  let value: unknown;
  try {
    value = JSON.parse((await fileSystem.readFile(path)).toString("utf8"));
  } catch (error: unknown) {
    throw new QuarantineError(
      "recovery-failed",
      `invalid transaction journal: ${path}`,
      path,
      { cause: error },
    );
  }
  const result = transactionSchema.safeParse(value);
  if (!result.success) {
    throw new QuarantineError(
      "recovery-failed",
      `invalid transaction journal: ${path}: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      path,
    );
  }
  return result.data as Transaction;
}

async function readRestoreIntent(
  fileSystem: QuarantineFileSystem,
  path: string,
): Promise<RestoreIntent> {
  const stats = await fileSystem.lstat(path);
  if (stats.kind !== "file") {
    throw unsafe(path);
  }
  let value: unknown;
  try {
    value = JSON.parse((await fileSystem.readFile(path)).toString("utf8"));
  } catch (error: unknown) {
    throw new QuarantineError(
      "recovery-failed",
      `invalid restore intent: ${path}`,
      path,
      { cause: error },
    );
  }
  const result = restoreIntentSchema.safeParse(value);
  if (!result.success) {
    throw new QuarantineError(
      "recovery-failed",
      `invalid restore intent: ${path}: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      path,
    );
  }
  return result.data as RestoreIntent;
}

function assertTransactionMatchesEntry(
  transaction: Transaction,
  entry: QuarantineEntry,
  intent: RestoreIntent | null,
  layout: StateLayout,
  journalPath: string,
): void {
  const sameIntegrity = sameDigest(transaction.integrity, entry.integrity);
  const sameArtifactType =
    stringifyModel(transaction.artifactType, 0) ===
    stringifyModel(entry.originalLocation.artifactType, 0);
  let pathsMatch = false;
  if (transaction.kind === "capture") {
    const expectedPending = pendingSourcePath(
      entry.originalLocation.path,
      entry.id,
    );
    pathsMatch =
      transaction.sourcePath === entry.originalLocation.path &&
      ((transaction.transfer === "copy" &&
        transaction.pendingPath === expectedPending &&
        entry.kind === "displaced-artifact") ||
        (transaction.transfer === "move" &&
          transaction.pendingPath === null &&
          entry.kind === "displaced-artifact") ||
        (transaction.transfer === "snapshot" &&
          transaction.pendingPath === null &&
          entry.kind === "record-cleanup-preimage"));
  } else {
    const expectedTemporary = restoreTemporaryPath(
      transaction.destination,
      entry.id,
    );
    const intentMatches =
      intent !== null &&
      intent.entryId === entry.id &&
      intent.destination === transaction.destination &&
      ((intent.resolution === "original" &&
        intent.destination === entry.originalLocation.path &&
        transaction.backupPath === null) ||
        (intent.resolution === "alternate" &&
          intent.destination !== entry.originalLocation.path &&
          !pathContains(layout.base, intent.destination) &&
          transaction.backupPath === null) ||
        (intent.resolution === "replace-record-postimage" &&
          entry.kind === "record-cleanup-preimage" &&
          intent.destination === entry.originalLocation.path &&
          transaction.backupPath ===
            restoreBackupPath(transaction.destination, entry.id)));
    pathsMatch =
      intentMatches && transaction.temporaryPath === expectedTemporary;
  }
  if (!sameIntegrity || !sameArtifactType || !pathsMatch) {
    throw new QuarantineError(
      "recovery-failed",
      `transaction journal does not match its manifest: ${journalPath}`,
      journalPath,
    );
  }
}

async function requireTransactionDigest(
  fileSystem: QuarantineFileSystem,
  path: string,
  transaction: Transaction,
): Promise<void> {
  try {
    if (
      (await hashArtifact(fileSystem, path, transaction.artifactType)) ===
      transaction.integrity.digest.toLowerCase()
    ) {
      return;
    }
  } catch (error: unknown) {
    throw new QuarantineError(
      "recovery-failed",
      `transaction artifact failed integrity verification: ${path}`,
      path,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  throw new QuarantineError(
    "recovery-failed",
    `transaction artifact failed integrity verification: ${path}`,
    path,
  );
}

async function requireDigest(
  fileSystem: QuarantineFileSystem,
  path: string,
  entry: QuarantineEntry,
): Promise<void> {
  await requireDigestAt(fileSystem, path, entry);
}

async function requireDigestAt(
  fileSystem: QuarantineFileSystem,
  path: string,
  entry: QuarantineEntry,
): Promise<void> {
  if (
    (await hashArtifact(
      fileSystem,
      path,
      entry.originalLocation.artifactType,
    )) !== entry.integrity.digest
  ) {
    throw new QuarantineError(
      "source-changed",
      `artifact integrity changed: ${path}`,
      path,
    );
  }
}

async function pathMatchesDigest(
  fileSystem: QuarantineFileSystem,
  path: string,
  digest: Sha256Digest,
): Promise<boolean> {
  try {
    return (
      (await hashArtifact(fileSystem, path)) === digest.digest.toLowerCase()
    );
  } catch {
    return false;
  }
}

function assertPreimageHash(
  request: QuarantineRequest,
  actual: Sha256Digest,
): void {
  if (
    request.kind === "record-cleanup-preimage" &&
    !sameDigest(request.expectedPreimageHash, actual)
  ) {
    throw changed(request.location.path);
  }
}

async function blockedByGitProtection(
  inspectProtection: QuarantineGitProtectionInspector,
  entry: QuarantineEntry,
  path: string,
): Promise<RestoreResult | null> {
  const protection = await inspectProtection(
    path,
    entry.originalLocation.artifactType,
  );
  return protection.kind === "protected"
    ? {
        status: "blocked",
        entryId: entry.id,
        reason: "git-protected",
        path,
      }
    : null;
}

async function assertGitMutationAllowed(
  inspectProtection: QuarantineGitProtectionInspector,
  path: string,
  artifactType: ArtifactType,
): Promise<void> {
  const protection = await inspectProtection(path, artifactType);
  if (protection.kind === "protected") {
    throw new QuarantineError(
      "git-protected",
      `refusing to mutate a non-ignored Git worktree path: ${path}`,
      path,
    );
  }
}

async function assertSafeDestinationParent(
  fileSystem: QuarantineFileSystem,
  destination: string,
): Promise<void> {
  const parent = dirname(destination);
  const stats = await lstatIfAvailable(fileSystem, parent);
  if (stats?.kind !== "directory") {
    throw unsafe(parent);
  }
}

async function assertPathMissing(
  fileSystem: QuarantineFileSystem,
  path: string,
  code: "entry-exists" | "recovery-failed",
): Promise<void> {
  if ((await lstatIfAvailable(fileSystem, path)) !== null) {
    throw new QuarantineError(code, `path is already occupied: ${path}`, path);
  }
}

async function lstatIfAvailable(
  fileSystem: QuarantineFileSystem,
  path: string,
) {
  try {
    return await fileSystem.lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

function blocked(
  entry: QuarantineEntry,
  reason: "integrity-failed",
): RestoreResult {
  return {
    status: "blocked",
    entryId: entry.id,
    reason,
    path: entry.originalLocation.path,
  };
}

function normalizeDigest(value: Sha256Digest): Sha256Digest {
  return { algorithm: "sha256", digest: value.digest.toLowerCase() };
}

function sameDigest(left: Sha256Digest, right: Sha256Digest): boolean {
  return left.digest.toLowerCase() === right.digest.toLowerCase();
}

function readTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new QuarantineError(
      "invalid-request",
      "quarantine clock returned an invalid date",
    );
  }
  return value;
}

function readId(createId: () => string): QuarantineEntryId {
  const value = createId();
  if (!entryIdPattern.test(value)) {
    throw new QuarantineError(
      "invalid-request",
      `invalid quarantine entry id: ${value}`,
    );
  }
  return value as QuarantineEntryId;
}

function requireEntryId(value: string): void {
  if (!entryIdPattern.test(value)) {
    throw new QuarantineError(
      "invalid-entry",
      `invalid quarantine entry id: ${value}`,
    );
  }
}

function pendingSourcePath(source: string, id: string): string {
  return join(
    dirname(source),
    `.${basename(source)}.skill-cleaner-${id}.pending`,
  );
}

function restoreTemporaryPath(destination: string, id: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.skill-cleaner-${id}.restore`,
  );
}

function restoreDirectoryClaimName(id: string): string {
  return `.skill-cleaner-${id}.claim`;
}

function restoreDirectoryClaim(entry: QuarantineEntry): Buffer {
  return Buffer.from(
    `${entry.id}\n${entry.integrity.algorithm}:${entry.integrity.digest}\n`,
    "utf8",
  );
}

function restoreBackupPath(destination: string, id: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.skill-cleaner-${id}.backup`,
  );
}

function pathContains(parent: string, child: string): boolean {
  const difference = relative(resolve(parent), resolve(child));
  return (
    difference.length === 0 ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}

async function pathResolvesInside(
  fileSystem: QuarantineFileSystem,
  parent: string,
  child: string,
): Promise<boolean> {
  const physicalParent = await fileSystem.realpath(parent);
  let existingAncestor = resolve(child);
  const missingSegments: string[] = [];
  while ((await lstatIfAvailable(fileSystem, existingAncestor)) === null) {
    const next = dirname(existingAncestor);
    if (next === existingAncestor) {
      throw unsafe(child);
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = next;
  }
  let physicalChild: string;
  try {
    physicalChild = join(
      await fileSystem.realpath(existingAncestor),
      ...missingSegments,
    );
  } catch (error: unknown) {
    throw new QuarantineError(
      "state-unsafe",
      `cannot resolve restore destination safely: ${child}`,
      child,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  return pathContains(physicalParent, physicalChild);
}

function changed(path: string): QuarantineError {
  return new QuarantineError(
    "source-changed",
    `artifact changed before quarantine: ${path}`,
    path,
  );
}

function unsafe(path: string): QuarantineError {
  return new QuarantineError(
    "state-unsafe",
    `expected a real directory or file, not a link or special artifact: ${path}`,
    path,
  );
}

function asQuarantineError(error: unknown, path: string): QuarantineError {
  if (error instanceof QuarantineError) {
    return error;
  }
  return new QuarantineError(
    "filesystem-unavailable",
    error instanceof Error
      ? error.message
      : `filesystem operation failed: ${path}`,
    path,
    error instanceof Error ? { cause: error } : undefined,
  );
}

function isIntegrityError(error: unknown): boolean {
  return (
    error instanceof QuarantineError &&
    (error.code === "invalid-entry" || error.code === "state-unsafe")
  );
}

function isMissing(error: unknown): boolean {
  return isCode(error, "ENOENT") || isCode(error, "ENOTDIR");
}

function isCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Group only by persisted approved-plan provenance. Older manifests deliberately
 * remain one-entry operations: matching paths, names, or timestamps is unsafe.
 */
function groupOperations(
  entries: readonly QuarantineEntry[],
): readonly QuarantineOperation[] {
  const groups = new Map<string, QuarantineEntry[]>();
  for (const entry of entries) {
    const operationId = entry.provenance.operation?.id ?? `legacy:${entry.id}`;
    const group = groups.get(operationId);
    if (group === undefined) groups.set(operationId, [entry]);
    else group.push(entry);
  }
  return [...groups.entries()]
    .map(([id, operationEntries]) => {
      const entriesInOrder = [...operationEntries].sort((left, right) =>
        compareText(left.id, right.id),
      ) as [QuarantineEntry, ...QuarantineEntry[]];
      const names = entriesInOrder[0].provenance.operation?.displayNames ?? [
        entriesInOrder[0].originalLocation.path,
      ];
      return {
        id,
        entries: entriesInOrder,
        displayNames: [...new Set(names)] as [string, ...string[]],
        removedAt: entriesInOrder
          .map((entry) =>
            entry.kind === "displaced-artifact"
              ? entry.removedAt
              : entry.capturedAt,
          )
          .sort(compareText)[0]!,
        // The earliest expiry makes a mixed/legacy group conservative.
        expiresAt: entriesInOrder
          .map((entry) => entry.expiresAt)
          .sort(compareText)[0]!,
      };
    })
    .sort((left, right) => compareText(right.removedAt, left.removedAt));
}
