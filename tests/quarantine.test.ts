import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createQuarantineModule,
  defaultLocalStateRoot,
  nodeQuarantineFileSystem,
  QuarantineError,
  type ArtifactLocation,
  type InstallationId,
  type QuarantineEntry,
  type QuarantineFileSystem,
  type QuarantineGitProtectionInspector,
  type QuarantineModule,
  type QuarantineProvenance,
  type RemovalActionId,
  type Sha256Digest,
} from "../src/index.js";
import { syncRegularFile } from "../src/quarantine/filesystem.js";
import { junctionTargetForCreation } from "../src/quarantine/integrity.js";
import { parseWindowsReparseKind } from "../src/filesystem/windows-reparse.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const retentionMilliseconds = 30 * 24 * 60 * 60 * 1000;

it("opens regular files with write access before syncing for Windows", async () => {
  let openedWith: "r" | "r+" | undefined;
  let synced = false;
  let closed = false;

  await syncRegularFile("C:\\state\\manifest.json", async (_path, flags) => {
    openedWith = flags;
    if (flags === "r") {
      throw Object.assign(new Error("operation not permitted, fsync"), {
        code: "EPERM",
      });
    }
    return {
      async sync() {
        synced = true;
      },
      async close() {
        closed = true;
      },
    };
  });

  expect(openedWith).toBe("r+");
  expect(synced).toBe(true);
  expect(closed).toBe(true);
});

it("removes Windows namespaces before asking Node to create a junction", () => {
  expect(junctionTargetForCreation("\\\\?\\C:\\skills\\target")).toBe(
    "C:\\skills\\target",
  );
  expect(junctionTargetForCreation("\\\\?\\UNC\\server\\share\\target")).toBe(
    "\\\\server\\share\\target",
  );
  expect(junctionTargetForCreation("\\??\\C:\\skills\\target")).toBe(
    "C:\\skills\\target",
  );
  expect(junctionTargetForCreation("\\??\\UNC\\server\\share\\target")).toBe(
    "\\\\server\\share\\target",
  );
  expect(junctionTargetForCreation("C:\\skills\\target")).toBe(
    "C:\\skills\\target",
  );
  expect(junctionTargetForCreation("\\\\?\\Volume{guid}\\skills\\target")).toBe(
    "\\\\?\\Volume{guid}\\skills\\target",
  );
  expect(junctionTargetForCreation("\\??\\Volume{guid}\\skills\\target")).toBe(
    "\\\\?\\Volume{guid}\\skills\\target",
  );
});

it("classifies Windows links from their reparse tags", () => {
  expect(parseWindowsReparseKind("Reparse Tag Value : 0xA0000003")).toBe(
    "junction",
  );
  expect(parseWindowsReparseKind("Reparse Tag Value : 0xA000000C")).toBe(
    "symbolic-link",
  );
  expect(parseWindowsReparseKind("unrecognized output")).toBeNull();
  expect(
    parseWindowsReparseKind(
      [
        "Reparse Tag Value : 0xA000000C",
        "Print Name: C:\\skills\\0xA0000003",
      ].join("\n"),
    ),
  ).toBe("symbolic-link");
  expect(
    parseWindowsReparseKind("Print Name: C:\\skills\\0xA0000003"),
  ).toBeNull();
});

it("distinguishes and recreates Windows junctions across supported Node versions", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const environment = await createTestEnvironment();
  const target = join(environment.workspace, "junction-target");
  const original = join(environment.home, "original-junction");
  const recreated = join(environment.home, "recreated-junction");
  const symbolic = join(environment.home, "directory-symbolic-link");
  const symbolicTrailing = join(
    environment.home,
    "trailing-directory-symbolic-link",
  );
  await mkdir(target, { recursive: true });
  await symlink(target, original, "junction");
  await symlink(target, symbolic, "dir");
  await symlink(`${target}\\`, symbolicTrailing, "dir");
  const originalLink = await nodeQuarantineFileSystem.readLink(original);
  expect(originalLink.kind).toBe("junction");
  await expect(
    nodeQuarantineFileSystem.readLink(symbolic),
  ).resolves.toMatchObject({ kind: "symbolic-link" });
  await expect(
    nodeQuarantineFileSystem.readLink(symbolicTrailing),
  ).resolves.toMatchObject({ kind: "symbolic-link" });

  await nodeQuarantineFileSystem.symlink(
    junctionTargetForCreation(originalLink.target),
    recreated,
    "junction",
  );

  await expect(nodeQuarantineFileSystem.readLink(recreated)).resolves.toEqual(
    originalLink,
  );
});

function createHarness(
  stateRoot: string,
  options: {
    readonly fileSystem?: QuarantineFileSystem;
    readonly inspectGitProtection?: QuarantineGitProtectionInspector;
    readonly initialTime?: Date;
  } = {},
): {
  readonly quarantine: QuarantineModule;
  setTime(value: Date): void;
} {
  let now = options.initialTime ?? new Date("2026-02-03T04:05:06.000Z");
  let nextId = 1;
  return {
    quarantine: createQuarantineModule({
      stateRoot,
      now: () => now,
      createId: () => `entry-${nextId++}`,
      fileSystem: options.fileSystem ?? nodeQuarantineFileSystem,
      ...(options.inspectGitProtection === undefined
        ? {}
        : { inspectGitProtection: options.inspectGitProtection }),
    }),
    setTime(value) {
      now = value;
    },
  };
}

function provenance(
  overrides: Partial<QuarantineProvenance> = {},
): QuarantineProvenance {
  return {
    actionId: "action-1" as RemovalActionId,
    targets: [
      {
        kind: "installation",
        installationId: "installation-1" as InstallationId,
      },
    ],
    affectedInstallationIds: ["installation-1" as InstallationId],
    subjects: [
      {
        installationIds: ["installation-1" as InstallationId],
        ownership: { kind: "filesystem", confidence: "declared" },
        adapterId: null,
        source: null,
        plugin: null,
        manager: null,
      },
    ],
    ...overrides,
  };
}

function digest(content: string | Buffer): Sha256Digest {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

function ordinaryLocation(
  path: string,
  kind: "directory" | "file",
): ArtifactLocation {
  return { path, canonicalPath: path, artifactType: { kind } };
}

type LinkedLocation = ArtifactLocation & {
  readonly artifactType:
    | {
        readonly kind: "symbolic-link";
        readonly target: string;
        readonly broken: boolean;
      }
    | {
        readonly kind: "junction";
        readonly target: string;
        readonly broken: boolean;
      };
};

async function linkedLocation(path: string): Promise<LinkedLocation> {
  const link = await nodeQuarantineFileSystem.readLink(path);
  return {
    path,
    canonicalPath: null,
    artifactType: { ...link, broken: false },
  };
}

async function brokenLinkedLocation(path: string): Promise<LinkedLocation> {
  const location = await linkedLocation(path);
  return {
    ...location,
    artifactType: { ...location.artifactType, broken: true },
  };
}

function expectEntry(
  result: Awaited<ReturnType<QuarantineModule["quarantine"]>>,
): QuarantineEntry {
  expect(result.status).toBe("quarantined");
  if (result.status !== "quarantined") {
    throw new Error("expected a committed quarantine entry");
  }
  return result.entry;
}

function missing(path: string): Promise<void> {
  return expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function exdevOnceFor(sourcePath: string): QuarantineFileSystem {
  let injected = false;
  return {
    ...nodeQuarantineFileSystem,
    async rename(source, destination) {
      if (
        !injected &&
        source === sourcePath &&
        destination.endsWith("payload")
      ) {
        injected = true;
        const error = new Error(
          "cross-device fixture",
        ) as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      }
      await nodeQuarantineFileSystem.rename(source, destination);
    },
  };
}

describe("Quarantine module", () => {
  it("accepts source-group provenance from an approved group plan", async () => {
    const environment = await createTestEnvironment();
    const source = join(environment.workspace, "source-group-skill");
    await writeFile(source, "skill", "utf8");
    const { quarantine } = createHarness(join(environment.state, "lampwright"));

    await expect(
      quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance({
          targets: [{ kind: "source-group", groupId: "group-1" as never }],
        }),
      }),
    ).resolves.toMatchObject({ status: "quarantined" });
  });
  it("lists and reports missing sources without creating state", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "missing-skill");
    const { quarantine } = createHarness(stateRoot);

    await expect(quarantine.list()).resolves.toEqual([]);
    await expect(quarantine.listOperations()).resolves.toEqual([]);
    await expect(
      quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "directory"),
        provenance: provenance(),
      }),
    ).resolves.toEqual({ status: "already-absent", path: source });
    await expect(
      quarantine.purge({ kind: "entries", entryIds: [] }),
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      quarantine.purge({
        kind: "entries",
        entryIds: ["missing-entry" as QuarantineEntry["id"]],
      }),
    ).resolves.toMatchObject({
      entries: [
        {
          entryId: "missing-entry",
          status: "unchanged",
          reason: "entry-not-found",
        },
      ],
    });
    await expect(
      quarantine.previewPurge({
        kind: "entries",
        entryIds: ["missing-entry" as QuarantineEntry["id"]],
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      entries: [
        {
          entryId: "missing-entry",
          status: "unchanged",
          reason: "entry-not-found",
        },
      ],
    });
    await missing(stateRoot);
  });

  it("quarantines, lists, and restores a file", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "standalone.txt");
    await writeFile(source, "recover me", "utf8");
    const { quarantine } = createHarness(stateRoot);

    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );

    await missing(source);
    await expect(quarantine.list()).resolves.toEqual([entry]);
    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "restored",
      destination: source,
    });
    await expect(readFile(source, "utf8")).resolves.toBe("recover me");
    await expect(quarantine.list()).resolves.toEqual([]);
  });

  it("groups only persisted removal-operation provenance and previews it without mutation", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const first = join(environment.home, "first.txt");
    const second = join(environment.home, "second.txt");
    await writeFile(first, "first", "utf8");
    await writeFile(second, "second", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const grouped = provenance({
      operation: { id: "plan-1", displayNames: ["Alpha skill"] },
    });
    const firstEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(first, "file"),
        provenance: grouped,
      }),
    );
    const secondEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(second, "file"),
        provenance: { ...grouped, actionId: "action-2" as RemovalActionId },
      }),
    );
    const operations = await quarantine.listOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      id: "plan-1",
      displayNames: ["Alpha skill"],
      entries: [{ id: firstEntry.id }, { id: secondEntry.id }],
    });
    await expect(
      quarantine.previewRestoreOperation(operations[0]!),
    ).resolves.toMatchObject({
      status: "would-restore",
      entries: [{ entryId: firstEntry.id }, { entryId: secondEntry.id }],
    });
    await missing(first);
    await missing(second);
  });

  it("restores a grouped directory, link, and guarded record preimage", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const directory = join(environment.home, "skill-directory");
    const target = join(environment.workspace, "link-target");
    const link = join(environment.home, "skill-link");
    const record = join(environment.home, "manager.json");
    const before = '{"skills":["one","two"]}\n';
    const after = '{"skills":["two"]}\n';
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "# grouped", "utf8");
    await mkdir(target, { recursive: true });
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const originalLinkTarget = await readlink(link);
    await writeFile(record, before, "utf8");
    const { quarantine } = createHarness(stateRoot);
    const grouped = provenance({
      operation: { id: "plan-restore", displayNames: ["Grouped skill"] },
    });
    expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(directory, "directory"),
        provenance: grouped,
      }),
    );
    expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: await linkedLocation(link),
        provenance: { ...grouped, actionId: "link-action" as RemovalActionId },
      }),
    );
    expectEntry(
      await quarantine.quarantine({
        kind: "record-cleanup-preimage",
        location: ordinaryLocation(record, "file") as ArtifactLocation & {
          artifactType: { kind: "file" };
        },
        provenance: {
          ...grouped,
          actionId: "record-action" as RemovalActionId,
        },
        expectedPreimageHash: digest(before),
        expectedPostimageHash: digest(after),
      }),
    );
    await writeFile(record, after, "utf8");
    const operation = (await quarantine.listOperations())[0]!;
    await expect(
      quarantine.previewRestoreOperation(operation),
    ).resolves.toMatchObject({ status: "would-restore" });
    await expect(quarantine.restoreOperation(operation)).resolves.toMatchObject(
      { status: "restored" },
    );
    await expect(readFile(join(directory, "SKILL.md"), "utf8")).resolves.toBe(
      "# grouped",
    );
    await expect(readlink(link)).resolves.toBe(originalLinkTarget);
    await expect(readFile(record, "utf8")).resolves.toBe(before);
  });

  it("reports known conflicts and unattempted entries without inventing a race", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const first = join(environment.home, "first.txt");
    const second = join(environment.home, "second.txt");
    await writeFile(first, "first", "utf8");
    await writeFile(second, "second", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const grouped = provenance({
      operation: { id: "plan-conflict", displayNames: ["Conflict"] },
    });
    const firstEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(first, "file"),
        provenance: grouped,
      }),
    );
    const secondEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(second, "file"),
        provenance: {
          ...grouped,
          actionId: "second-action" as RemovalActionId,
        },
      }),
    );
    await writeFile(first, "occupied", "utf8");
    const result = await quarantine.restoreOperation(
      (await quarantine.listOperations())[0]!,
    );
    expect(result).toMatchObject({
      status: "blocked",
      entries: [
        {
          entryId: firstEntry.id,
          status: "blocked",
          reason: "destination-occupied",
        },
        {
          entryId: secondEntry.id,
          status: "not-attempted",
          reason: "known-conflict",
        },
      ],
    });
    await missing(second);
  });

  it("reports a partial restore when a destination appears after the group preview", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const first = join(environment.home, "first-race.txt");
    const second = join(environment.home, "second-race.txt");
    await writeFile(first, "first", "utf8");
    await writeFile(second, "second", "utf8");
    let firstEntryDirectory: string | null = null;
    let raced = false;
    const fileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async rmdir(path) {
        await nodeQuarantineFileSystem.rmdir(path);
        if (!raced && path === firstEntryDirectory) {
          raced = true;
          await writeFile(second, "racer", "utf8");
        }
      },
    };
    const { quarantine } = createHarness(stateRoot, { fileSystem });
    const grouped = provenance({
      operation: { id: "plan-race", displayNames: ["Race"] },
    });
    const firstEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(first, "file"),
        provenance: grouped,
      }),
    );
    const secondEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(second, "file"),
        provenance: {
          ...grouped,
          actionId: "second-race-action" as RemovalActionId,
        },
      }),
    );
    firstEntryDirectory = join(
      stateRoot,
      "quarantine",
      "v1",
      "entries",
      firstEntry.id,
    );
    const result = await quarantine.restoreOperation(
      (await quarantine.listOperations())[0]!,
    );
    expect(result).toMatchObject({
      status: "partial",
      entries: [
        { entryId: firstEntry.id, status: "restored" },
        {
          entryId: secondEntry.id,
          status: "blocked",
          reason: "destination-occupied",
        },
      ],
    });
    await expect(readFile(second, "utf8")).resolves.toBe("racer");
  });

  it("keeps legacy entries as separate operations", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const first = join(environment.home, "legacy-one.txt");
    const second = join(environment.home, "legacy-two.txt");
    await writeFile(first, "one", "utf8");
    await writeFile(second, "two", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const firstEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(first, "file"),
        provenance: provenance(),
      }),
    );
    const secondEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(second, "file"),
        provenance: provenance({ actionId: "legacy-two" as RemovalActionId }),
      }),
    );
    await expect(quarantine.listOperations()).resolves.toMatchObject([
      { id: `legacy:${firstEntry.id}`, entries: [{ id: firstEntry.id }] },
      { id: `legacy:${secondEntry.id}`, entries: [{ id: secondEntry.id }] },
    ]);
  });

  it("previews and permanently purges every entry in a grouped operation", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const first = join(environment.home, "purge-one.txt");
    const second = join(environment.home, "purge-two.txt");
    await writeFile(first, "one", "utf8");
    await writeFile(second, "two", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const grouped = provenance({
      operation: { id: "plan-purge", displayNames: ["Purge"] },
    });
    const firstEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(first, "file"),
        provenance: grouped,
      }),
    );
    const secondEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(second, "file"),
        provenance: { ...grouped, actionId: "purge-two" as RemovalActionId },
      }),
    );
    const operation = (await quarantine.listOperations())[0]!;
    await expect(
      quarantine.previewPurgeOperation(operation),
    ).resolves.toMatchObject({
      entries: [
        { entryId: firstEntry.id, status: "would-purge" },
        { entryId: secondEntry.id, status: "would-purge" },
      ],
    });
    await expect(quarantine.purgeOperation(operation)).resolves.toMatchObject({
      entries: [
        { entryId: firstEntry.id, status: "purged" },
        { entryId: secondEntry.id, status: "purged" },
      ],
    });
    await expect(quarantine.listOperations()).resolves.toEqual([]);
  });

  it("previews restore and purge without changing source or Quarantine state", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "preview.txt");
    await writeFile(source, "preview me", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    const entryDirectory = join(
      stateRoot,
      "quarantine",
      "v1",
      "entries",
      entry.id,
    );
    const manifestPath = join(entryDirectory, "manifest.json");
    const payloadPath = join(entryDirectory, "payload");
    const before = {
      entries: await readdir(dirname(entryDirectory)),
      manifest: await readFile(manifestPath, "utf8"),
      payload: await readFile(payloadPath, "utf8"),
    };

    await expect(quarantine.previewRestore(entry)).resolves.toMatchObject({
      schemaVersion: 1,
      status: "would-restore",
      destination: source,
    });
    await expect(
      quarantine.previewPurge({ kind: "entries", entryIds: [entry.id] }),
    ).resolves.toEqual({
      schemaVersion: 1,
      entries: [{ entryId: entry.id, status: "would-purge" }],
    });
    const operation = (await quarantine.listOperations())[0]!;
    await expect(
      quarantine.previewRestoreOperation(operation),
    ).resolves.toMatchObject({
      operationId: operation.id,
      status: "would-restore",
    });
    await expect(
      quarantine.previewPurgeOperation(operation),
    ).resolves.toMatchObject({
      operationId: operation.id,
      entries: [{ entryId: entry.id, status: "would-purge" }],
    });

    await missing(source);
    await expect(quarantine.list()).resolves.toEqual([entry]);
    await expect(readdir(dirname(entryDirectory))).resolves.toEqual(
      before.entries,
    );
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(before.manifest);
    await expect(readFile(payloadPath, "utf8")).resolves.toBe(before.payload);
  });

  it("uses an EXDEV copy without following a nested external link", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "directory-skill");
    const external = join(environment.workspace, "external-target");
    await mkdir(source, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# skill", "utf8");
    await writeFile(join(external, "sentinel.txt"), "untouched", "utf8");
    await symlink(
      external,
      join(source, "external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const originalLinkTarget = await readlink(join(source, "external-link"));
    const { quarantine } = createHarness(stateRoot, {
      fileSystem: exdevOnceFor(source),
    });

    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "directory"),
        provenance: provenance(),
      }),
    );

    await missing(source);
    await expect(
      readFile(join(external, "sentinel.txt"), "utf8"),
    ).resolves.toBe("untouched");
    await quarantine.restore(entry);
    await expect(readlink(join(source, "external-link"))).resolves.toBe(
      originalLinkTarget,
    );
    await expect(
      readFile(join(external, "sentinel.txt"), "utf8"),
    ).resolves.toBe("untouched");
  });

  it("round-trips a link and a broken link without changing their targets", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const target = join(environment.workspace, "link-target");
    const missingTarget = join(environment.workspace, "missing-target");
    const link = join(environment.home, "linked-skill");
    const broken = join(environment.home, "broken-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "sentinel.txt"), "target stays", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(target, link, linkType);
    await symlink(missingTarget, broken, linkType);
    const originalLinkTarget = await readlink(link);
    const originalBrokenTarget = await readlink(broken);
    const { quarantine } = createHarness(stateRoot);

    const linkedEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: await linkedLocation(link),
        provenance: provenance(),
      }),
    );
    const brokenEntry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: await brokenLinkedLocation(broken),
        provenance: provenance({ actionId: "action-2" as RemovalActionId }),
      }),
    );

    await expect(readFile(join(target, "sentinel.txt"), "utf8")).resolves.toBe(
      "target stays",
    );
    await quarantine.restore(linkedEntry);
    await quarantine.restore(brokenEntry);
    await expect(readlink(link)).resolves.toBe(originalLinkTarget);
    await expect(readlink(broken)).resolves.toBe(originalBrokenTarget);
    await expect(readFile(join(target, "sentinel.txt"), "utf8")).resolves.toBe(
      "target stays",
    );
  });

  it("round-trips an absolute Windows symbolic link as a symbolic link", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const target = join(environment.workspace, "symbolic-target");
    const link = join(environment.home, "symbolic-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# linked", "utf8");
    await symlink(target, link, "dir");
    const originalTarget = await readlink(link);
    const location = await linkedLocation(link);
    expect(location.artifactType.kind).toBe("symbolic-link");
    const { quarantine } = createHarness(stateRoot);

    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location,
        provenance: provenance(),
      }),
    );
    await quarantine.restore(entry);

    await expect(nodeQuarantineFileSystem.readLink(link)).resolves.toEqual({
      kind: "symbolic-link",
      target: originalTarget,
    });
  });

  it("never overwrites an occupied destination and supports a free alternate", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "conflict.txt");
    const alternate = join(environment.home, "restored.txt");
    await writeFile(source, "quarantined", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    await writeFile(source, "new occupant", "utf8");

    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(
      quarantine.restore(entry, {
        kind: "alternate-destination",
        path: alternate,
      }),
    ).resolves.toMatchObject({ status: "restored", destination: alternate });
    await expect(readFile(source, "utf8")).resolves.toBe("new occupant");
    await expect(readFile(alternate, "utf8")).resolves.toBe("quarantined");
  });

  it("blocks listing, restore, and purge after payload tampering", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "tamper.txt");
    await writeFile(source, "original", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    const payload = join(
      stateRoot,
      "quarantine",
      "v1",
      "entries",
      entry.id,
      "payload",
    );
    await writeFile(payload, "tampered", "utf8");

    await expect(quarantine.list()).rejects.toMatchObject({
      code: "invalid-entry",
    });
    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "integrity-failed",
    });
    await expect(
      quarantine.purge({ kind: "entries", entryIds: [entry.id] }),
    ).resolves.toMatchObject({
      entries: [{ status: "blocked", reason: "integrity-failed" }],
    });
    await expect(readFile(payload, "utf8")).resolves.toBe("tampered");
  });

  it("purges selected and exactly 30-day-old entries", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const start = new Date("2026-01-01T00:00:00.000Z");
    const first = join(environment.home, "first.txt");
    const second = join(environment.home, "second.txt");
    await writeFile(first, "first", "utf8");
    await writeFile(second, "second", "utf8");
    const harness = createHarness(stateRoot, { initialTime: start });
    const firstEntry = expectEntry(
      await harness.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(first, "file"),
        provenance: provenance(),
      }),
    );
    const secondEntry = expectEntry(
      await harness.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(second, "file"),
        provenance: provenance({ actionId: "action-2" as RemovalActionId }),
      }),
    );

    harness.setTime(new Date(start.getTime() + retentionMilliseconds - 1));
    await expect(
      harness.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({ entries: [] });
    await expect(
      harness.quarantine.purge({
        kind: "entries",
        entryIds: [secondEntry.id, "missing-entry" as typeof secondEntry.id],
      }),
    ).resolves.toMatchObject({
      entries: [
        { entryId: secondEntry.id, status: "purged" },
        { entryId: "missing-entry", status: "unchanged" },
      ],
    });
    harness.setTime(new Date(start.getTime() + retentionMilliseconds));
    await expect(
      harness.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({
      entries: [{ entryId: firstEntry.id, status: "purged" }],
    });
  });

  it("captures a record preimage and restores only its exact postimage", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "manager.jsonc");
    const preimage =
      '{\n  // retained formatting\n  "skills": ["one", "two"]\n}\n';
    const postimage = '{\n  // retained formatting\n  "skills": ["two"]\n}\n';
    await writeFile(source, preimage, "utf8");
    const { quarantine } = createHarness(stateRoot);
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "record-cleanup-preimage",
        location: ordinaryLocation(source, "file") as ArtifactLocation & {
          artifactType: { kind: "file" };
        },
        provenance: provenance({
          subjects: [
            {
              installationIds: ["installation-1" as InstallationId],
              ownership: {
                kind: "manager",
                managerId: "fixture-manager",
                confidence: "declared",
              },
              adapterId: "fixture-adapter",
              source: null,
              plugin: null,
              manager: { id: "fixture-manager" },
            },
          ],
        }),
        expectedPreimageHash: digest(preimage),
        expectedPostimageHash: digest(postimage),
      }),
    );

    await expect(readFile(source, "utf8")).resolves.toBe(preimage);
    await writeFile(source, postimage, "utf8");
    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(
      quarantine.restore(entry, { kind: "replace-record-postimage" }),
    ).resolves.toMatchObject({ status: "restored", destination: source });
    await expect(readFile(source, "utf8")).resolves.toBe(preimage);
  });

  it("preserves every owner represented by a global record cleanup", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "global-record.json");
    const content = '{"skills":["one","two"]}\n';
    const first = "installation-1" as InstallationId;
    const second = "installation-2" as InstallationId;
    await writeFile(source, content, "utf8");
    const { quarantine } = createHarness(stateRoot);

    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "record-cleanup-preimage",
        location: ordinaryLocation(source, "file") as ArtifactLocation & {
          artifactType: { kind: "file" };
        },
        provenance: provenance({
          targets: [
            { kind: "installation", installationId: first },
            { kind: "installation", installationId: second },
          ],
          affectedInstallationIds: [first, second],
          subjects: [
            {
              installationIds: [first],
              ownership: {
                kind: "manager",
                managerId: "manager-one",
                confidence: "declared",
              },
              adapterId: "adapter-one",
              source: { id: "source-one", url: null },
              plugin: null,
              manager: { id: "manager-one" },
            },
            {
              installationIds: [second],
              ownership: {
                kind: "plugin",
                pluginId: "plugin-two",
                independentlySelectable: true,
                confidence: "declared",
              },
              adapterId: "adapter-two",
              source: null,
              plugin: { id: "plugin-two", version: "2.0.0" },
              manager: null,
            },
          ],
        }),
        expectedPreimageHash: digest(content),
        expectedPostimageHash: digest("{}\n"),
      }),
    );

    expect(entry.provenance.subjects).toHaveLength(2);
    await expect(quarantine.list()).resolves.toEqual([entry]);
  });

  it("does not overwrite a record created during explicit replacement", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "record-race.json");
    const preimage = '{"skill":"one"}\n';
    const postimage = "{}\n";
    const racer = '{"unrelated":"racer"}\n';
    await writeFile(source, preimage, "utf8");
    let raceOnReplacement = false;
    const racingFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async unlink(path) {
        await nodeQuarantineFileSystem.unlink(path);
        if (path === source && raceOnReplacement) {
          raceOnReplacement = false;
          await writeFile(source, racer, "utf8");
        }
      },
    };
    const { quarantine } = createHarness(stateRoot, {
      fileSystem: racingFileSystem,
    });
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "record-cleanup-preimage",
        location: ordinaryLocation(source, "file") as ArtifactLocation & {
          artifactType: { kind: "file" };
        },
        provenance: provenance(),
        expectedPreimageHash: digest(preimage),
        expectedPostimageHash: digest(postimage),
      }),
    );
    await writeFile(source, postimage, "utf8");
    raceOnReplacement = true;

    await expect(
      quarantine.restore(entry, { kind: "replace-record-postimage" }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-changed",
    });
    await expect(readFile(source, "utf8")).resolves.toBe(racer);
    await expect(quarantine.list()).resolves.toEqual([entry]);
  });

  it("preserves a record preimage when the live document diverges", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "records.json");
    const alternate = join(environment.home, "records-original.json");
    const preimage = '{"skill":"one"}\n';
    const postimage = "{}\n";
    await writeFile(source, preimage, "utf8");
    const { quarantine } = createHarness(stateRoot);
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "record-cleanup-preimage",
        location: ordinaryLocation(source, "file") as ArtifactLocation & {
          artifactType: { kind: "file" };
        },
        provenance: provenance(),
        expectedPreimageHash: digest(preimage),
        expectedPostimageHash: digest(postimage),
      }),
    );
    await writeFile(source, '{"unrelated":"change"}\n', "utf8");

    await expect(
      quarantine.restore(entry, { kind: "replace-record-postimage" }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-changed",
    });
    await expect(
      quarantine.restore(entry, {
        kind: "alternate-destination",
        path: alternate,
      }),
    ).resolves.toMatchObject({ status: "restored" });
    await expect(readFile(source, "utf8")).resolves.toBe(
      '{"unrelated":"change"}\n',
    );
    await expect(readFile(alternate, "utf8")).resolves.toBe(preimage);
  });

  it("rolls back a failed commit and recovers an interrupted rollback", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "recover-transaction.txt");
    await writeFile(source, "transactional", "utf8");
    let commitFailed = false;
    let rollbackFailed = false;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async rename(from, to) {
        if (
          !commitFailed &&
          from.includes(`${join("staging", "entry-1")}`) &&
          to.includes("entries")
        ) {
          commitFailed = true;
          throw Object.assign(new Error("commit fault"), { code: "EIO" });
        }
        await nodeQuarantineFileSystem.rename(from, to);
      },
      async writeFile(path, data, options) {
        if (commitFailed && !rollbackFailed && path === source) {
          rollbackFailed = true;
          throw Object.assign(new Error("rollback interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.writeFile(path, data, options);
      },
    };
    const interrupted = createHarness(stateRoot, {
      fileSystem: faultFileSystem,
    });

    await expect(
      interrupted.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    ).rejects.toMatchObject({ code: "recovery-failed" });
    await missing(source);

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({ entries: [] });
    await expect(readFile(source, "utf8")).resolves.toBe("transactional");
    await expect(recovered.quarantine.list()).resolves.toEqual([]);
  });

  it("does not overwrite a destination created during restore", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "restore-race.txt");
    await writeFile(source, "quarantined", "utf8");
    let raced = false;
    const racingFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async link(existingPath, newPath) {
        if (newPath === source && !raced) {
          raced = true;
          await writeFile(source, "racer", "utf8");
        }
        await nodeQuarantineFileSystem.link(existingPath, newPath);
      },
    };
    const { quarantine } = createHarness(stateRoot, {
      fileSystem: racingFileSystem,
    });
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );

    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("racer");
    await expect(quarantine.list()).resolves.toEqual([entry]);
  });

  it("does not replace an empty directory created during publication", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "directory-race");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# quarantined", "utf8");
    let raced = false;
    const racingFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async mkdir(path, options) {
        if (path === source && !raced) {
          raced = true;
          await mkdir(source);
        }
        await nodeQuarantineFileSystem.mkdir(path, options);
      },
    };
    const { quarantine } = createHarness(stateRoot, {
      fileSystem: racingFileSystem,
    });
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "directory"),
        provenance: provenance(),
      }),
    );

    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(readdir(source)).resolves.toEqual([]);
    await expect(quarantine.list()).resolves.toEqual([entry]);
  });

  it("resumes an interrupted claimed-directory publication", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "directory-recovery");
    await mkdir(source);
    await writeFile(join(source, "a.txt"), "a", "utf8");
    await writeFile(join(source, "b.txt"), "b", "utf8");
    let interrupted = false;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async writeFile(path, data, options) {
        if (path === join(source, "b.txt") && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("directory publication interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.writeFile(path, data, options);
      },
    };
    const failing = createHarness(stateRoot, { fileSystem: faultFileSystem });
    const entry = expectEntry(
      await failing.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "directory"),
        provenance: provenance(),
      }),
    );

    await expect(failing.quarantine.restore(entry)).rejects.toThrow(
      "directory publication interruption",
    );
    await expect(readFile(join(source, "a.txt"), "utf8")).resolves.toBe("a");
    await missing(join(source, "b.txt"));

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({ entries: [] });
    await expect(readFile(join(source, "a.txt"), "utf8")).resolves.toBe("a");
    await expect(readFile(join(source, "b.txt"), "utf8")).resolves.toBe("b");
    await expect(recovered.quarantine.list()).resolves.toEqual([]);
  });

  it("preserves staged recovery when a directory claim marker is interrupted", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "directory-claim-gap");
    const temporaryPath = join(
      dirname(source),
      `.${basename(source)}.lampwright-entry-1.restore`,
    );
    const claimPath = join(source, ".lampwright-entry-1.claim");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# recoverable", "utf8");
    let interrupted = false;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async writeFile(path, data, options) {
        if (path === claimPath && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("claim marker interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.writeFile(path, data, options);
      },
    };
    const failing = createHarness(stateRoot, { fileSystem: faultFileSystem });
    const entry = expectEntry(
      await failing.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "directory"),
        provenance: provenance(),
      }),
    );

    await expect(failing.quarantine.restore(entry)).rejects.toThrow(
      "claim marker interruption",
    );
    await expect(readdir(source)).resolves.toEqual([]);
    await expect(
      readFile(join(temporaryPath, "SKILL.md"), "utf8"),
    ).resolves.toBe("# recoverable");

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).rejects.toMatchObject({ code: "recovery-failed" });
    await expect(
      readFile(join(temporaryPath, "SKILL.md"), "utf8"),
    ).resolves.toBe("# recoverable");
    await nodeQuarantineFileSystem.rmdir(source);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({ entries: [] });
    await expect(readFile(join(source, "SKILL.md"), "utf8")).resolves.toBe(
      "# recoverable",
    );
    await expect(recovered.quarantine.list()).resolves.toEqual([]);
  });

  it("clears an interrupted staged copy without occupying the destination", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "partial.txt");
    const temporaryPath = join(
      dirname(source),
      `.${basename(source)}.lampwright-entry-1.restore`,
    );
    await writeFile(source, "complete", "utf8");
    let interrupted = false;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async writeFile(path, data, options) {
        if (path === temporaryPath && !interrupted) {
          interrupted = true;
          await nodeQuarantineFileSystem.writeFile(path, "partial", options);
          throw Object.assign(new Error("staged copy interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.writeFile(path, data, options);
      },
    };
    const failing = createHarness(stateRoot, { fileSystem: faultFileSystem });
    const entry = expectEntry(
      await failing.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );

    await expect(failing.quarantine.restore(entry)).rejects.toThrow(
      "staged copy interruption",
    );
    await missing(source);

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({ entries: [] });
    await missing(source);
    await missing(temporaryPath);
    await expect(recovered.quarantine.list()).resolves.toEqual([entry]);
  });

  it("rejects alternate restores inside quarantine state", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "state-alternate.txt");
    await writeFile(source, "quarantined", "utf8");
    const { quarantine } = createHarness(stateRoot);
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    const insideEntry = join(
      stateRoot,
      "quarantine",
      "v1",
      "entries",
      entry.id,
      "restored.txt",
    );

    await expect(
      quarantine.restore(entry, {
        kind: "alternate-destination",
        path: insideEntry,
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    const entryDirectory = dirname(insideEntry);
    const redirectedParent = join(environment.temporary, "state-redirect");
    await symlink(
      entryDirectory,
      redirectedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      quarantine.restore(entry, {
        kind: "alternate-destination",
        path: join(redirectedParent, "redirected.txt"),
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(quarantine.list()).resolves.toEqual([entry]);
  });

  it("blocks a restore when its destination becomes Git-protected", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.workspace, "protected-restore.txt");
    await writeFile(source, "quarantined", "utf8");
    let protectedNow = false;
    const { quarantine } = createHarness(stateRoot, {
      inspectGitProtection: async () =>
        protectedNow
          ? { kind: "protected", worktreeRoot: environment.workspace }
          : { kind: "outside-worktree" },
    });
    const entry = expectEntry(
      await quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    protectedNow = true;

    await expect(quarantine.restore(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "git-protected",
    });
    await missing(source);
    await expect(quarantine.list()).resolves.toEqual([entry]);
  });

  it("rejects a redirected recovery journal without touching its path", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "journal-source.txt");
    const redirected = join(environment.workspace, "redirected.txt");
    await writeFile(source, "transactional", "utf8");
    let commitFailed = false;
    let rollbackFailed = false;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async rename(from, to) {
        if (!commitFailed && to.includes("entries")) {
          commitFailed = true;
          throw Object.assign(new Error("commit fault"), { code: "EIO" });
        }
        await nodeQuarantineFileSystem.rename(from, to);
      },
      async writeFile(path, data, options) {
        if (commitFailed && !rollbackFailed && path === source) {
          rollbackFailed = true;
          throw Object.assign(new Error("rollback interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.writeFile(path, data, options);
      },
    };
    const interrupted = createHarness(stateRoot, {
      fileSystem: faultFileSystem,
    });
    await expect(
      interrupted.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    ).rejects.toMatchObject({ code: "recovery-failed" });
    const journalPath = join(
      stateRoot,
      "quarantine",
      "v1",
      "staging",
      "entry-1",
      "transaction.json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      journalPath,
      `${JSON.stringify({ ...journal, sourcePath: redirected })}\n`,
      "utf8",
    );

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).rejects.toMatchObject({ code: "recovery-failed" });
    await missing(redirected);
    await missing(source);
  });

  it("binds an interrupted restore journal to its persisted intent", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "restore-journal.txt");
    const redirected = join(environment.workspace, "same-content.txt");
    await writeFile(source, "same content", "utf8");
    await writeFile(redirected, "same content", "utf8");
    let interrupted = false;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async link(existingPath, newPath) {
        if (newPath === source && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("publication interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.link(existingPath, newPath);
      },
    };
    const failing = createHarness(stateRoot, { fileSystem: faultFileSystem });
    const entry = expectEntry(
      await failing.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    await expect(failing.quarantine.restore(entry)).rejects.toThrow(
      "publication interruption",
    );
    const journalPath = join(
      stateRoot,
      "quarantine",
      "v1",
      "entries",
      entry.id,
      "transaction.json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      journalPath,
      `${JSON.stringify({ ...journal, destination: redirected })}\n`,
      "utf8",
    );

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).rejects.toMatchObject({ code: "recovery-failed" });
    await expect(readFile(redirected, "utf8")).resolves.toBe("same content");
    await missing(source);
  });

  it("reapplies restoration metadata before completing crash recovery", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const source = join(environment.home, "metadata.txt");
    const originalTime = new Date("2020-01-02T03:04:05.000Z");
    await writeFile(source, "metadata", "utf8");
    await chmod(source, 0o640);
    await nodeQuarantineFileSystem.utimes(source, originalTime, originalTime);
    let destinationChmodCalls = 0;
    const faultFileSystem: QuarantineFileSystem = {
      ...nodeQuarantineFileSystem,
      async chmod(path, mode) {
        if (path === source && ++destinationChmodCalls === 1) {
          await nodeQuarantineFileSystem.chmod(path, 0o600);
          throw Object.assign(new Error("metadata interruption"), {
            code: "EIO",
          });
        }
        await nodeQuarantineFileSystem.chmod(path, mode);
      },
    };
    const interrupted = createHarness(stateRoot, {
      fileSystem: faultFileSystem,
    });
    const entry = expectEntry(
      await interrupted.quarantine.quarantine({
        kind: "displaced-artifact",
        location: ordinaryLocation(source, "file"),
        provenance: provenance(),
      }),
    );
    await expect(interrupted.quarantine.restore(entry)).rejects.toThrow(
      "metadata interruption",
    );

    const recovered = createHarness(stateRoot);
    await expect(
      recovered.quarantine.purge({ kind: "expired" }),
    ).resolves.toMatchObject({ entries: [] });
    const restoredStats = await lstat(source);
    if (process.platform !== "win32") {
      expect(restoredStats.mode & 0o777).toBe(0o640);
    }
    expect(restoredStats.mtime.toISOString()).toBe(originalTime.toISOString());
    await expect(readFile(source, "utf8")).resolves.toBe("metadata");
    await expect(recovered.quarantine.list()).resolves.toEqual([]);
  });

  it("rejects symlinked state roots", async () => {
    const environment = await createTestEnvironment();
    const physicalState = join(environment.temporary, "physical-state");
    const stateRoot = join(environment.temporary, "linked-state");
    await mkdir(physicalState, { recursive: true });
    await symlink(
      physicalState,
      stateRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const { quarantine } = createHarness(stateRoot);

    await expect(quarantine.list()).rejects.toBeInstanceOf(QuarantineError);
    await expect(realpath(stateRoot)).resolves.toBe(
      await realpath(physicalState),
    );
    await missing(join(physicalState, "quarantine"));
  });
});

describe("defaultLocalStateRoot", () => {
  it("uses the same XDG state convention on Linux and macOS", () => {
    expect(
      defaultLocalStateRoot({
        platform: "linux",
        homeDirectory: "/home/tester",
        variables: { XDG_STATE_HOME: "/state" },
      }),
    ).toBe(posix.join("/state", "lampwright"));
    expect(
      defaultLocalStateRoot({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        variables: { XDG_STATE_HOME: "/state" },
      }),
    ).toBe(posix.join("/state", "lampwright"));
    expect(
      defaultLocalStateRoot({
        platform: "linux",
        homeDirectory: "/home/tester",
        variables: {},
      }),
    ).toBe(posix.join("/home/tester", ".local", "state", "lampwright"));
    expect(
      defaultLocalStateRoot({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        variables: {},
      }),
    ).toBe(posix.join("/Users/tester", ".local", "state", "lampwright"));
  });

  it("uses Windows state-directory precedence and the Lampwright name", () => {
    expect(
      defaultLocalStateRoot({
        platform: "win32",
        homeDirectory: "C:\\Users\\tester",
        variables: {
          LOCALAPPDATA: "C:\\State",
          APPDATA: "C:\\Roaming",
        },
      }),
    ).toBe(win32.join("C:\\State", "lampwright"));
    expect(
      defaultLocalStateRoot({
        platform: "win32",
        homeDirectory: "C:\\Users\\tester",
        variables: { APPDATA: "C:\\Roaming" },
      }),
    ).toBe(win32.join("C:\\Roaming", "lampwright"));
    expect(
      defaultLocalStateRoot({
        platform: "win32",
        homeDirectory: "C:\\Users\\tester",
        variables: {},
      }),
    ).toBe(win32.join("C:\\Users\\tester", "AppData", "Local", "lampwright"));
  });

  it("uses an explicit absolute override", () => {
    expect(
      defaultLocalStateRoot({
        platform: process.platform,
        homeDirectory: dirname(process.cwd()),
        variables: {},
        override: process.cwd(),
      }),
    ).toBe(process.cwd());
  });
});
