import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { inspectGitProtection } from "../inventory/git-protection.js";
import { systemCommandRunner } from "../inventory/process.js";
import { stringifyModel } from "../model/json.js";
import type { ArtifactLocation, Sha256Digest } from "../model/types.js";
import { defaultLocalStateRoot } from "../state/index.js";
import { nodeArtifactFileSystem } from "../filesystem/artifact-filesystem.js";
import {
  applyRestorationMetadata,
  copyArtifact,
  hashArtifact,
  inspectArtifact,
  mergeDirectoryArtifact,
  removeArtifact,
} from "../filesystem/artifact-integrity.js";
import { parseDisabledEntry, parseSuspendRequest } from "./schema.js";
import type {
  DisabledBlockReason,
  DisabledEntry,
  DisabledEntryId,
  DisabledStorageModule,
  DisabledStorageModuleOptions,
  EnablePreview,
  EnableResult,
  SuspendRequest,
  SuspendResult,
} from "./types.js";

const manifestName = "manifest.json";
const payloadName = "payload";
const transactionName = "transaction.json";
const restoreIntentName = "restore-intent.json";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface Layout {
  readonly base: string;
  readonly entries: string;
  readonly staging: string;
}

interface Transaction {
  readonly schemaVersion: 1;
  readonly kind: "suspend" | "enable";
  readonly source: string;
  readonly payload: string;
  readonly destination: string;
  readonly temporary: string | null;
  readonly transfer: "move" | "copy" | "restore";
  readonly integrity: Sha256Digest;
}

interface LoadedEntry {
  readonly entry: DisabledEntry;
  readonly directory: string;
  readonly payload: string;
}

/** Non-expiring storage for Suspended Disable; deliberately separate from Quarantine. */
export function createDisabledStorageModule(
  options: DisabledStorageModuleOptions = {
    stateRoot: defaultLocalStateRoot(),
    now: () => new Date(),
    createId: randomUUID,
    fileSystem: nodeArtifactFileSystem,
  },
): DisabledStorageModule {
  if (!isAbsolute(options.stateRoot)) {
    throw new TypeError("disabled storage state root must be absolute");
  }
  const fs = options.fileSystem;
  const layout: Layout = {
    base: join(resolve(options.stateRoot), "disabled-storage", "v1"),
    entries: join(
      resolve(options.stateRoot),
      "disabled-storage",
      "v1",
      "entries",
    ),
    staging: join(
      resolve(options.stateRoot),
      "disabled-storage",
      "v1",
      "staging",
    ),
  };
  const protection =
    options.inspectGitProtection ??
    ((path: string, type: ArtifactLocation["artifactType"]) =>
      inspectGitProtection(
        path,
        type.kind === "directory",
        systemCommandRunner,
      ));
  const entryPath = (id: string) => join(layout.entries, id);

  async function preview(entryInput: DisabledEntry): Promise<EnablePreview> {
    let entry: DisabledEntry;
    try {
      entry = parseDisabledEntry(entryInput);
    } catch {
      return blockedPreview(
        entryInput.id,
        entryInput.originalLocation.path,
        "integrity-failed",
      );
    }
    const loaded = await load(entry.id);
    if (loaded === null)
      return blockedPreview(
        entry.id,
        entry.originalLocation.path,
        "entry-not-found",
      );
    if (
      stringifyModel(loaded.entry, 0) !== stringifyModel(entry, 0) ||
      !(await integrityMatches(loaded))
    ) {
      return blockedPreview(
        entry.id,
        entry.originalLocation.path,
        "integrity-failed",
      );
    }
    const destination = entry.originalLocation.path;
    if ((await available(destination)) !== null)
      return blockedPreview(entry.id, destination, "destination-occupied");
    if (!(await safeParent(destination)))
      return blockedPreview(entry.id, dirname(destination), "state-unsafe");
    if (
      (await protection(destination, entry.originalLocation.artifactType))
        .kind === "protected"
    ) {
      return blockedPreview(entry.id, destination, "git-protected");
    }
    const temporary = restoreTemporaryPath(destination, entry.id);
    if ((await available(temporary)) !== null)
      return blockedPreview(entry.id, temporary, "state-unsafe");
    if (
      (await protection(temporary, entry.originalLocation.artifactType))
        .kind === "protected"
    )
      return blockedPreview(entry.id, temporary, "git-protected");
    return {
      schemaVersion: 1,
      status: "would-enable",
      entryId: entry.id,
      destination,
    };
  }

  return {
    async list(): Promise<readonly DisabledEntry[]> {
      if (!(await ensureLayout(false))) return [];
      const result: DisabledEntry[] = [];
      for (const id of [...(await fs.readdir(layout.entries))].sort(compare)) {
        if (!idPattern.test(id)) continue;
        const loaded = await load(id as DisabledEntryId);
        if (loaded === null) continue;
        // A transaction means a prior mutable operation did not finish. list is
        // read-only, so it deliberately neither repairs nor presents the entry.
        if ((await available(join(loaded.directory, transactionName))) !== null)
          continue;
        if (await integrityMatches(loaded)) result.push(loaded.entry);
      }
      return result;
    },

    async suspend(input: SuspendRequest): Promise<SuspendResult> {
      let request: SuspendRequest;
      try {
        request = parseSuspendRequest(input);
      } catch {
        return {
          status: "blocked",
          path: input.location.path,
          reason: "source-not-eligible",
        };
      }
      if (request.ownership.kind !== "filesystem") {
        return {
          status: "blocked",
          path: request.location.path,
          reason: "source-not-eligible",
        };
      }
      if (
        pathsOverlap(request.location.path, layout.base) ||
        pathsOverlap(layout.base, request.location.path)
      ) {
        return {
          status: "blocked",
          path: request.location.path,
          reason: "state-unsafe",
        };
      }
      // The absent fast path is intentionally before recovery/layout creation.
      if ((await available(request.location.path)) === null) {
        return { status: "already-absent", path: request.location.path };
      }
      if (
        (await protection(request.location.path, request.location.artifactType))
          .kind === "protected"
      ) {
        return {
          status: "blocked",
          path: request.location.path,
          reason: "git-protected",
        };
      }
      let initial;
      try {
        initial = await inspectArtifact(
          fs,
          request.location.path,
          request.location.artifactType,
        );
      } catch {
        try {
          await recover();
        } catch {
          // Recovery intentionally leaves an occupied or altered transaction
          // in place rather than discarding any potentially recoverable data.
        }
        return {
          status: "blocked",
          path: request.location.path,
          reason: "integrity-failed",
        };
      }
      try {
        await recover();
        if ((await available(request.location.path)) === null)
          return { status: "already-absent", path: request.location.path };
        const current = await inspectArtifact(
          fs,
          request.location.path,
          request.location.artifactType,
        );
        if (!sameDigest(initial.integrity, current.integrity))
          return {
            status: "blocked",
            path: request.location.path,
            reason: "integrity-failed",
          };
        if (
          (
            await protection(
              request.location.path,
              request.location.artifactType,
            )
          ).kind === "protected"
        ) {
          return {
            status: "blocked",
            path: request.location.path,
            reason: "git-protected",
          };
        }
        if (!(await ensureLayout(true)))
          return {
            status: "blocked",
            path: layout.base,
            reason: "state-unsafe",
          };
        const id = readId(options.createId);
        const stage = join(layout.staging, id);
        const destination = entryPath(id);
        if (
          (await available(stage)) !== null ||
          (await available(destination)) !== null
        ) {
          return {
            status: "blocked",
            path: destination,
            reason: "state-unsafe",
          };
        }
        await fs.mkdir(stage);
        const entry: DisabledEntry = parseDisabledEntry({
          schemaVersion: 1,
          id,
          suspendedAt: now(options.now),
          originalLocation: request.location,
          integrity: normalizeDigest(current.integrity),
          skillIdentity: request.skillIdentity,
          installationIds: request.installationIds,
          ownership: request.ownership,
          harnessExposures: request.harnessExposures,
          operation: request.operation,
          restoration: current.restoration,
        });
        await writeJson(join(stage, manifestName), entry);
        try {
          await displace(stage, destination, entry);
        } catch (error: unknown) {
          await recoverFailedDisplacement(stage, destination, entry);
          throw error;
        }
        return { status: "suspended", entry };
      } catch {
        return {
          status: "blocked",
          path: request.location.path,
          reason: "state-unsafe",
        };
      }
    },

    previewEnable: preview,

    async enable(entryInput: DisabledEntry): Promise<EnableResult> {
      try {
        const recovered = await recover();
        if (recovered.has(entryInput.id)) {
          return {
            status: "enabled",
            entryId: entryInput.id,
            destination: entryInput.originalLocation.path,
            enabledAt: now(options.now),
          };
        }
        const preflight = await preview(entryInput);
        if (preflight.status === "blocked")
          return blockedResult(entryInput.id, preflight.path, preflight.reason);
        const checked = await preview(entryInput);
        if (checked.status === "blocked")
          return blockedResult(entryInput.id, checked.path, checked.reason);
        const loaded = await load(entryInput.id);
        if (loaded === null)
          return blockedResult(
            entryInput.id,
            entryInput.originalLocation.path,
            "entry-not-found",
          );
        if (!(await restore(loaded)))
          return blockedResult(
            loaded.entry.id,
            loaded.entry.originalLocation.path,
            "destination-occupied",
          );
        return {
          status: "enabled",
          entryId: loaded.entry.id,
          destination: loaded.entry.originalLocation.path,
          enabledAt: now(options.now),
        };
      } catch {
        return blockedResult(
          entryInput.id,
          entryInput.originalLocation.path,
          "state-unsafe",
        );
      }
    },
  };

  async function displace(
    stage: string,
    destination: string,
    entry: DisabledEntry,
  ): Promise<void> {
    const payload = join(stage, payloadName);
    const source = entry.originalLocation.path;
    const pending = pendingPath(source, entry.id);
    if ((await available(pending)) !== null)
      throw new Error("pending path occupied");
    const transaction: Transaction = {
      schemaVersion: 1,
      kind: "suspend",
      source,
      payload,
      destination,
      temporary: pending,
      transfer: "copy",
      integrity: entry.integrity,
    };
    await writeJson(join(stage, transactionName), transaction);
    await copyArtifact(
      fs,
      source,
      payload,
      entry.originalLocation.artifactType,
    );
    await requireDigest(payload, entry);
    if (
      (await hashArtifact(fs, source, entry.originalLocation.artifactType)) !==
      entry.integrity.digest
    )
      throw new Error("source changed");
    if (
      (await protection(source, entry.originalLocation.artifactType)).kind ===
      "protected"
    )
      throw new Error("git protected");
    await fs.rename(source, pending);
    await requireDigest(pending, entry);
    await fs.syncDirectory(stage);
    await fs.rename(stage, destination);
    await fs.syncDirectory(layout.entries);
    if (transaction.temporary !== null)
      await removeArtifact(fs, transaction.temporary);
    await fs.unlink(join(destination, transactionName));
    await fs.syncDirectory(destination);
  }

  async function restore(loaded: LoadedEntry): Promise<boolean> {
    const destination = loaded.entry.originalLocation.path;
    const temporary = restoreTemporaryPath(destination, loaded.entry.id);
    const transaction: Transaction = {
      schemaVersion: 1,
      kind: "enable",
      source: loaded.payload,
      payload: loaded.payload,
      destination,
      temporary,
      transfer: "restore",
      integrity: loaded.entry.integrity,
    };
    const intentPath = join(loaded.directory, restoreIntentName);
    await writeJson(intentPath, {
      schemaVersion: 1,
      entryId: loaded.entry.id,
      destination,
    });
    try {
      await writeJson(join(loaded.directory, transactionName), transaction);
    } catch (error: unknown) {
      await fs.unlink(intentPath);
      await fs.syncDirectory(loaded.directory);
      throw error;
    }
    await copyArtifact(
      fs,
      loaded.payload,
      temporary,
      loaded.entry.originalLocation.artifactType,
    );
    await requireDigest(temporary, loaded.entry);
    if (!(await publish(temporary, destination, loaded.entry))) {
      if ((await available(temporary)) !== null)
        await removeArtifact(fs, temporary);
      await clearJournal(loaded.directory);
      return false;
    }
    await requireDigest(destination, loaded.entry);
    await applyRestorationMetadata(fs, destination, loaded.entry.restoration);
    await removeArtifact(fs, loaded.directory);
    await fs.syncDirectory(layout.entries);
    return true;
  }

  async function publish(
    temporary: string,
    destination: string,
    entry: DisabledEntry,
  ): Promise<boolean> {
    let claimedDirectory = false;
    try {
      if (entry.originalLocation.artifactType.kind === "file") {
        await fs.link(temporary, destination);
        await fs.unlink(temporary);
      } else if (entry.originalLocation.artifactType.kind === "directory") {
        const claim = `.skill-cleaner-${entry.id}.claim`;
        const claimPath = join(destination, claim);
        const expectedClaim = directoryClaim(entry);
        if ((await available(join(temporary, claim))) !== null)
          throw new Error("disabled payload conflicts with recovery claim");
        if ((await available(destination)) === null) {
          try {
            await fs.mkdir(destination);
            claimedDirectory = true;
          } catch (error: unknown) {
            if (hasCode(error, "EEXIST")) return false;
            throw error;
          }
          await fs.writeFile(claimPath, expectedClaim, { exclusive: true });
          await fs.syncFile(claimPath);
          await fs.syncDirectory(destination);
        } else {
          if (
            (await available(claimPath))?.kind !== "file" ||
            !(await fs.readFile(claimPath)).equals(expectedClaim)
          )
            return false;
          claimedDirectory = true;
        }
        await mergeDirectoryArtifact(fs, temporary, destination, claim);
        await fs.unlink(claimPath);
        await removeArtifact(fs, temporary);
      } else {
        await copyArtifact(
          fs,
          temporary,
          destination,
          entry.originalLocation.artifactType,
        );
        await removeArtifact(fs, temporary);
      }
      await fs.syncDirectory(dirname(destination));
      return true;
    } catch (error: unknown) {
      // Once this module has claimed a directory, a later collision can be a
      // recursive publication race. Keep its journal instead of deleting a
      // path another process may have changed.
      if (
        !claimedDirectory &&
        (hasCode(error, "EEXIST") || hasCode(error, "ENOTEMPTY"))
      )
        return false;
      throw error;
    }
  }

  async function recover(): Promise<ReadonlySet<DisabledEntryId>> {
    const enabled = new Set<DisabledEntryId>();
    if (!(await ensureLayout(false))) return enabled;
    for (const root of [layout.staging, layout.entries]) {
      for (const id of [...(await fs.readdir(root))].sort(compare)) {
        if (!idPattern.test(id)) throw new Error("unsafe entry");
        const directory = join(root, id);
        if ((await fs.lstat(directory)).kind !== "directory")
          throw new Error("unsafe entry");
        const journal = join(directory, transactionName);
        if ((await available(journal)) === null) {
          if (root === layout.staging) {
            // Before journalling, no source mutation is authorized. An empty
            // stage is therefore safe to clean; a payload is retained for
            // manual recovery rather than guessed away.
            if ((await available(join(directory, payloadName))) === null) {
              await removeArtifact(fs, directory);
              continue;
            }
            throw new Error("unjournaled staging payload");
          }
          const staleIntent = join(directory, restoreIntentName);
          if ((await available(staleIntent)) !== null) {
            await fs.unlink(staleIntent);
            await fs.syncDirectory(directory);
          }
          continue;
        }
        const loaded = await loadAt(directory, id as DisabledEntryId);
        if (loaded === null) throw new Error("incomplete transaction");
        const transaction = await readTransaction(journal);
        validateTransaction(transaction, loaded, directory, root, layout);
        if (transaction.kind === "suspend")
          await rollbackSuspend(directory, transaction, loaded.entry);
        else {
          await validateRestoreIntent(directory, loaded.entry);
          if (await rollbackEnable(directory, transaction, loaded.entry))
            enabled.add(loaded.entry.id);
        }
      }
    }
    return enabled;
  }

  async function rollbackSuspend(
    directory: string,
    transaction: Transaction,
    entry: DisabledEntry,
  ): Promise<void> {
    const payload = join(directory, payloadName);
    const sourceExists = (await available(transaction.source)) !== null;
    const pending = transaction.temporary;
    if (sourceExists) {
      const sourceMatches = await hashMatches(
        transaction.source,
        entry.originalLocation.artifactType,
        entry.integrity,
      );
      if (
        sourceMatches &&
        (pending === null || (await available(pending)) === null)
      ) {
        await removeArtifact(fs, directory);
        return;
      }
      throw new Error("source occupied during suspend recovery");
    }
    if (pending !== null && (await available(pending)) !== null) {
      try {
        await requireDigest(pending, entry);
      } catch {
        await returnChangedPending(pending, transaction.source, entry);
        throw new Error("raced source returned from pending");
      }
    }
    const present: string[] = [];
    for (const candidate of [payload, ...(pending === null ? [] : [pending])]) {
      if ((await available(candidate)) !== null) {
        await requireDigest(candidate, entry);
        present.push(candidate);
      }
    }
    if (present.length === 0)
      throw new Error("suspend recovery payload missing");
    if (
      (
        await protection(
          transaction.source,
          entry.originalLocation.artifactType,
        )
      ).kind === "protected"
    )
      throw new Error("git protected");
    await copyArtifact(
      fs,
      present[0]!,
      transaction.source,
      entry.originalLocation.artifactType,
    );
    await requireDigest(transaction.source, entry);
    if ((await available(directory)) !== null)
      await removeArtifact(fs, directory);
    if (pending !== null && (await available(pending)) !== null)
      await removeArtifact(fs, pending);
  }

  async function recoverFailedDisplacement(
    stage: string,
    destination: string,
    entry: DisabledEntry,
  ): Promise<void> {
    const transactionDirectory =
      (await available(stage)) !== null
        ? stage
        : (await available(destination)) !== null
          ? destination
          : null;
    if (transactionDirectory !== null) {
      const loaded = await loadAt(transactionDirectory, entry.id);
      if (loaded === null) throw new Error("incomplete suspend rollback");
      const transaction = await readTransaction(
        join(transactionDirectory, transactionName),
      );
      validateTransaction(
        transaction,
        loaded,
        transactionDirectory,
        transactionDirectory === stage ? layout.staging : layout.entries,
        layout,
      );
      await rollbackSuspend(transactionDirectory, transaction, entry);
      return;
    }
    const source = entry.originalLocation.path;
    const pending = pendingPath(source, entry.id);
    if ((await available(source)) !== null) return;
    if ((await available(pending)) !== null) {
      try {
        await requireDigest(pending, entry);
      } catch {
        await returnChangedPending(pending, source, entry);
        return;
      }
    }
    const payload = join(stage, payloadName);
    const candidates = [payload, pending];
    for (const candidate of candidates) {
      if ((await available(candidate)) === null) continue;
      await requireDigest(candidate, entry);
    }
    const stored = (await available(payload)) !== null ? payload : pending;
    if ((await available(stored)) === null) return;
    if (
      (await protection(source, entry.originalLocation.artifactType)).kind ===
      "protected"
    )
      throw new Error("git protected");
    await copyArtifact(fs, stored, source, entry.originalLocation.artifactType);
    await requireDigest(source, entry);
    if ((await available(stage)) !== null) await removeArtifact(fs, stage);
    if ((await available(pending)) !== null) await removeArtifact(fs, pending);
  }

  async function rollbackEnable(
    directory: string,
    transaction: Transaction,
    entry: DisabledEntry,
  ): Promise<boolean> {
    // If publication succeeded before interruption, preservation wins: retain the
    // restored artifact and remove its consumed disabled entry. Existence alone
    // is not enough: a race or a partial directory publication keeps the entry
    // and fails closed rather than claiming success.
    if (
      (await available(transaction.destination)) !== null &&
      (await hashMatches(
        transaction.destination,
        entry.originalLocation.artifactType,
        entry.integrity,
      ))
    ) {
      if (
        (
          await protection(
            transaction.destination,
            entry.originalLocation.artifactType,
          )
        ).kind === "protected"
      )
        throw new Error("git protected");
      await applyRestorationMetadata(
        fs,
        transaction.destination,
        entry.restoration,
      );
      if (
        transaction.temporary !== null &&
        (await available(transaction.temporary)) !== null
      )
        await removeArtifact(fs, transaction.temporary);
      await removeArtifact(fs, directory);
      return true;
    }
    const temporaryPresent =
      transaction.temporary !== null &&
      (await available(transaction.temporary)) !== null;
    const temporaryComplete =
      temporaryPresent &&
      (await hashMatches(
        transaction.temporary!,
        entry.originalLocation.artifactType,
        entry.integrity,
      ));
    if (temporaryComplete) {
      if (
        (
          await protection(
            transaction.destination,
            entry.originalLocation.artifactType,
          )
        ).kind === "protected"
      )
        throw new Error("git protected");
      const destinationFree =
        (await available(transaction.destination)) === null;
      if (
        (destinationFree ||
          entry.originalLocation.artifactType.kind === "directory") &&
        (await publish(transaction.temporary!, transaction.destination, entry))
      ) {
        await requireDigest(transaction.destination, entry);
        await applyRestorationMetadata(
          fs,
          transaction.destination,
          entry.restoration,
        );
        await removeArtifact(fs, directory);
        return true;
      }
    }
    if (temporaryPresent) await removeArtifact(fs, transaction.temporary!);
    await clearJournal(directory);
    return false;
  }

  async function clearJournal(directory: string): Promise<void> {
    for (const name of [transactionName, restoreIntentName]) {
      const path = join(directory, name);
      if ((await available(path)) !== null) await fs.unlink(path);
    }
    await fs.syncDirectory(directory);
  }

  async function ensureLayout(create: boolean): Promise<boolean> {
    const stateRoot = resolve(options.stateRoot);
    for (const path of [
      stateRoot,
      dirname(layout.base),
      layout.base,
      layout.entries,
      layout.staging,
    ]) {
      const stats = await available(path);
      if (stats === null) {
        if (!create) return false;
        await fs.mkdir(path, { recursive: path === stateRoot });
      } else if (stats.kind !== "directory") return false;
    }
    return true;
  }

  async function load(id: DisabledEntryId): Promise<LoadedEntry | null> {
    if (!idPattern.test(id) || !(await ensureLayout(false))) return null;
    return loadAt(entryPath(id), id);
  }

  async function loadAt(
    directory: string,
    id: DisabledEntryId,
  ): Promise<LoadedEntry | null> {
    if ((await available(directory)) === null) return null;
    if ((await fs.lstat(directory)).kind !== "directory")
      throw new Error("unsafe entry");
    const manifest = join(directory, manifestName);
    if ((await available(manifest))?.kind !== "file")
      throw new Error("unsafe manifest");
    const entry = parseDisabledEntry(
      JSON.parse((await fs.readFile(manifest)).toString("utf8")),
    );
    if (entry.id !== id) throw new Error("manifest ID mismatch");
    return { entry, directory, payload: join(directory, payloadName) };
  }

  async function integrityMatches(loaded: LoadedEntry): Promise<boolean> {
    try {
      await requireDigest(loaded.payload, loaded.entry);
      return true;
    } catch {
      return false;
    }
  }

  async function hashMatches(
    path: string,
    artifactType: ArtifactLocation["artifactType"],
    integrity: Sha256Digest,
  ): Promise<boolean> {
    try {
      return (
        (await hashArtifact(fs, path, artifactType)).toLowerCase() ===
        integrity.digest.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  async function returnChangedPending(
    pending: string,
    source: string,
    entry: DisabledEntry,
  ): Promise<void> {
    const artifactType = entry.originalLocation.artifactType;
    if ((await protection(source, artifactType)).kind === "protected")
      throw new Error("git protected");
    const changedDigest = await hashArtifact(fs, pending, artifactType);
    if (artifactType.kind === "file") {
      await fs.link(pending, source);
      await fs.unlink(pending);
      return;
    }
    await copyArtifact(fs, pending, source, artifactType);
    if ((await hashArtifact(fs, source, artifactType)) !== changedDigest)
      throw new Error("changed pending recovery failed integrity");
    await removeArtifact(fs, pending);
  }

  async function requireDigest(
    path: string,
    entry: DisabledEntry,
  ): Promise<void> {
    if (
      (
        await hashArtifact(fs, path, entry.originalLocation.artifactType)
      ).toLowerCase() !== entry.integrity.digest.toLowerCase()
    )
      throw new Error("integrity failed");
  }

  async function writeJson(path: string, value: unknown): Promise<void> {
    await fs.writeFile(path, `${stringifyModel(value)}\n`, { exclusive: true });
    await fs.syncFile(path);
    await fs.syncDirectory(dirname(path));
  }
  async function readTransaction(path: string): Promise<Transaction> {
    const value: unknown = JSON.parse(
      (await fs.readFile(path)).toString("utf8"),
    );
    if (value === null || typeof value !== "object")
      throw new Error("invalid journal");
    const transaction = value as Partial<Transaction>;
    if (
      transaction.schemaVersion !== 1 ||
      (transaction.kind !== "suspend" && transaction.kind !== "enable") ||
      typeof transaction.source !== "string" ||
      typeof transaction.payload !== "string" ||
      typeof transaction.destination !== "string" ||
      (transaction.temporary !== null &&
        typeof transaction.temporary !== "string") ||
      (transaction.transfer !== "move" &&
        transaction.transfer !== "copy" &&
        transaction.transfer !== "restore") ||
      transaction.integrity?.algorithm !== "sha256" ||
      typeof transaction.integrity.digest !== "string"
    )
      throw new Error("invalid journal");
    return transaction as Transaction;
  }
  async function validateRestoreIntent(
    directory: string,
    entry: DisabledEntry,
  ): Promise<void> {
    const path = join(directory, restoreIntentName);
    if ((await available(path))?.kind !== "file")
      throw new Error("missing restore intent");
    const value: unknown = JSON.parse(
      (await fs.readFile(path)).toString("utf8"),
    );
    if (
      value === null ||
      typeof value !== "object" ||
      (value as Record<string, unknown>).schemaVersion !== 1 ||
      (value as Record<string, unknown>).entryId !== entry.id ||
      (value as Record<string, unknown>).destination !==
        entry.originalLocation.path ||
      Object.keys(value).some(
        (key) => !["schemaVersion", "entryId", "destination"].includes(key),
      )
    )
      throw new Error("invalid restore intent");
  }
  async function available(path: string) {
    try {
      return await fs.lstat(path);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return null;
      throw error;
    }
  }
  async function safeParent(path: string): Promise<boolean> {
    return (await available(dirname(path)))?.kind === "directory";
  }
}

function blockedPreview(
  id: DisabledEntryId,
  path: string,
  reason: DisabledBlockReason,
): EnablePreview {
  return { schemaVersion: 1, status: "blocked", entryId: id, path, reason };
}
function blockedResult(
  id: DisabledEntryId,
  path: string,
  reason: DisabledBlockReason,
): EnableResult {
  return { status: "blocked", entryId: id, path, reason };
}
function normalizeDigest(value: Sha256Digest): Sha256Digest {
  return { algorithm: "sha256", digest: value.digest.toLowerCase() };
}
function sameDigest(left: Sha256Digest, right: Sha256Digest): boolean {
  return left.digest.toLowerCase() === right.digest.toLowerCase();
}
function now(clock: () => Date): string {
  const value = clock();
  if (!Number.isFinite(value.getTime())) throw new TypeError("invalid clock");
  return value.toISOString();
}
function readId(createId: () => string): DisabledEntryId {
  const id = createId();
  if (!idPattern.test(id)) throw new TypeError("invalid disabled entry id");
  return id as DisabledEntryId;
}
function pendingPath(source: string, id: string): string {
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
function directoryClaim(entry: DisabledEntry): Buffer {
  return Buffer.from(`${entry.id}\n${entry.integrity.digest}\n`, "utf8");
}
function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
function pathsOverlap(left: string, right: string): boolean {
  const difference = relative(resolve(left), resolve(right));
  return (
    difference.length === 0 ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}
function validateTransaction(
  transaction: Transaction,
  loaded: LoadedEntry,
  directory: string,
  root: string,
  layout: Layout,
): void {
  const entry = loaded.entry;
  if (
    transaction.schemaVersion !== 1 ||
    !isAbsolute(transaction.source) ||
    !isAbsolute(transaction.payload) ||
    !isAbsolute(transaction.destination) ||
    (transaction.temporary !== null && !isAbsolute(transaction.temporary)) ||
    !sameDigest(transaction.integrity, entry.integrity) ||
    !pathsOverlap(root, directory) ||
    !pathsOverlap(layout.base, directory)
  )
    throw new Error("invalid disabled-storage journal");
  if (transaction.kind === "suspend") {
    const expectedPending = pendingPath(entry.originalLocation.path, entry.id);
    const expectedPayload = join(layout.staging, entry.id, payloadName);
    if (
      transaction.source !== entry.originalLocation.path ||
      transaction.payload !== expectedPayload ||
      transaction.destination !== entryPathFor(layout, entry.id) ||
      transaction.transfer !== "copy" ||
      transaction.temporary !== expectedPending
    )
      throw new Error("forged suspend journal");
    return;
  }
  if (
    transaction.source !== loaded.payload ||
    transaction.payload !== loaded.payload ||
    transaction.destination !== entry.originalLocation.path ||
    transaction.temporary !==
      restoreTemporaryPath(entry.originalLocation.path, entry.id) ||
    transaction.transfer !== "restore" ||
    root !== layout.entries
  )
    throw new Error("forged enable journal");
}
function entryPathFor(layout: Layout, id: string): string {
  return join(layout.entries, id);
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
