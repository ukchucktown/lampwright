import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDisabledStorageModule,
  type ArtifactLocation,
  type DisabledStorageModule,
  type InstallationId,
  type ArtifactFileSystem,
  type SuspendRequest,
} from "../src/index.js";
import { nodeArtifactFileSystem } from "../src/filesystem/artifact-filesystem.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createEnvironment = createIsolatedTestEnvironmentFixture();

function location(path: string, kind: "file" | "directory"): ArtifactLocation {
  return { path, canonicalPath: path, artifactType: { kind } };
}

function request(
  path: string,
  kind: "file" | "directory" = "file",
): SuspendRequest {
  return {
    location: location(path, kind),
    skillIdentity: {
      strongEvidence: [
        { strength: "strong", kind: "canonical-target", canonicalPath: path },
      ],
      weakEvidence: [],
    },
    installationIds: ["installation-1" as InstallationId],
    ownership: { kind: "filesystem", confidence: "declared" },
    harnessExposures: [
      {
        harnessId: "example",
        status: "enabled",
        control: { kind: "unsupported", reason: "fixture" },
      },
    ],
    operation: { id: "availability-plan-1", displayNames: ["Example skill"] },
  };
}

function harness(
  stateRoot: string,
  fileSystem: ArtifactFileSystem = nodeArtifactFileSystem,
): DisabledStorageModule {
  let id = 1;
  return createDisabledStorageModule({
    stateRoot,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    createId: () => `disabled-${id++}`,
    fileSystem,
    inspectGitProtection: async () => ({ kind: "outside-worktree" }),
  });
}

async function missing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function layout(stateRoot: string) {
  const base = join(stateRoot, "disabled-storage", "v1");
  return {
    base,
    entries: join(base, "entries"),
    staging: join(base, "staging"),
  };
}

async function suspendedEntry(
  storage: DisabledStorageModule,
  value: SuspendRequest,
) {
  const result = await storage.suspend(value);
  if (result.status !== "suspended")
    throw new Error(`expected suspension, received ${result.status}`);
  return result.entry;
}

function pendingPath(source: string, id: string): string {
  return join(
    dirname(source),
    `.${basename(source)}.skill-cleaner-${id}.pending`,
  );
}

function restorePath(source: string, id: string): string {
  return join(
    dirname(source),
    `.${basename(source)}.skill-cleaner-${id}.restore`,
  );
}

describe("Disabled Storage", () => {
  it("round-trips a filesystem-owned file with its complete non-expiring manifest", async () => {
    const environment = await createEnvironment();
    const state = join(environment.state, "skill-cleaner");
    const source = join(environment.home, "example-skill.md");
    await writeFile(source, "skill", "utf8");
    const storage = harness(state);

    const suspended = await storage.suspend(request(source));
    expect(suspended).toMatchObject({ status: "suspended" });
    if (suspended.status !== "suspended")
      throw new Error("expected suspended entry");
    expect(suspended.entry).toMatchObject({
      schemaVersion: 1,
      originalLocation: location(source, "file"),
      operation: { id: "availability-plan-1", displayNames: ["Example skill"] },
      skillIdentity: {
        strongEvidence: [{ kind: "canonical-target", canonicalPath: source }],
      },
    });
    expect("expiresAt" in suspended.entry).toBe(false);
    await missing(source);
    await expect(storage.list()).resolves.toEqual([suspended.entry]);
    await expect(storage.previewEnable(suspended.entry)).resolves.toMatchObject(
      { status: "would-enable" },
    );
    await expect(storage.enable(suspended.entry)).resolves.toMatchObject({
      status: "enabled",
      destination: source,
    });
    await expect(readFile(source, "utf8")).resolves.toBe("skill");
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("does not create state while listing, previewing a missing entry, or suspending an absent source", async () => {
    const environment = await createEnvironment();
    const state = join(environment.state, "skill-cleaner");
    const source = join(environment.home, "missing-skill");
    const storage = harness(state);
    await expect(storage.list()).resolves.toEqual([]);
    await expect(storage.suspend(request(source))).resolves.toEqual({
      status: "already-absent",
      path: source,
    });
    await missing(state);
  });

  it("retains shared approved-operation provenance across distinct entries", async () => {
    const environment = await createEnvironment();
    const state = join(environment.state, "skill-cleaner");
    const first = join(environment.home, "first-skill");
    const second = join(environment.home, "second-skill");
    await writeFile(first, "one", "utf8");
    await writeFile(second, "two", "utf8");
    const storage = harness(state);
    const left = await storage.suspend(request(first));
    const right = await storage.suspend(request(second));
    expect(left).toMatchObject({ status: "suspended" });
    expect(right).toMatchObject({ status: "suspended" });
    await expect(storage.list()).resolves.toMatchObject([
      {
        operation: {
          id: "availability-plan-1",
          displayNames: ["Example skill"],
        },
      },
      {
        operation: {
          id: "availability-plan-1",
          displayNames: ["Example skill"],
        },
      },
    ]);
  });

  it("fails closed for manager ownership and protected Git paths", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "owned-skill");
    await writeFile(source, "skill", "utf8");
    const managed = {
      ...request(source),
      ownership: {
        kind: "manager",
        managerId: "manager",
        confidence: "declared",
      } as const,
    };
    await expect(
      harness(join(environment.state, "state")).suspend(managed),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "source-not-eligible",
    });
    const protectedStorage = createDisabledStorageModule({
      stateRoot: join(environment.state, "protected-state"),
      now: () => new Date(),
      createId: () => "entry",
      fileSystem: nodeArtifactFileSystem,
      inspectGitProtection: async () => ({
        kind: "protected",
        worktreeRoot: environment.workspace,
      }),
    });
    await expect(
      protectedStorage.suspend(request(source)),
    ).resolves.toMatchObject({ status: "blocked", reason: "git-protected" });
    await expect(readFile(source, "utf8")).resolves.toBe("skill");
  });

  it("recovers the original source when commit crashes after the verified pending move", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "cross-device-skill");
    await writeFile(source, "skill", "utf8");
    let injected = false;
    const fs: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async rename(from, to) {
        if (
          !injected &&
          from.includes("disabled-storage") &&
          from.includes("staging") &&
          to.endsWith(join("entries", "disabled-1"))
        ) {
          injected = true;
          throw Object.assign(new Error("injected commit crash"), {
            code: "EIO",
          });
        }
        await nodeArtifactFileSystem.rename(from, to);
      },
    };
    const storage = harness(join(environment.state, "state"), fs);
    const suspended = await storage.suspend(request(source));
    expect(suspended).toMatchObject({ status: "blocked" });
    await expect(readFile(source, "utf8")).resolves.toBe("skill");
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("preserves a destination that becomes occupied after preview", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "race-skill");
    await writeFile(source, "skill", "utf8");
    const storage = harness(join(environment.state, "state"));
    const suspended = await storage.suspend(request(source));
    if (suspended.status !== "suspended")
      throw new Error("expected suspended entry");
    await expect(storage.previewEnable(suspended.entry)).resolves.toMatchObject(
      { status: "would-enable" },
    );
    await writeFile(source, "new content", "utf8");
    await expect(storage.enable(suspended.entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("new content");
    await expect(storage.list()).resolves.toEqual([suspended.entry]);
  });

  it("fails closed when stored content changes and when the configured state path is a link", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "integrity-skill");
    await writeFile(source, "skill", "utf8");
    const storage = harness(join(environment.state, "state"));
    const suspended = await storage.suspend(request(source));
    if (suspended.status !== "suspended")
      throw new Error("expected suspended entry");
    const payload = join(
      environment.state,
      "state",
      "disabled-storage",
      "v1",
      "entries",
      suspended.entry.id,
      "payload",
    );
    await writeFile(payload, "tampered", "utf8");
    await expect(storage.previewEnable(suspended.entry)).resolves.toMatchObject(
      { status: "blocked", reason: "integrity-failed" },
    );

    const linkedState = join(environment.state, "linked-state");
    await symlink(environment.state, linkedState, "dir");
    const other = join(environment.home, "linked-state-skill");
    await writeFile(other, "skill", "utf8");
    await expect(
      harness(linkedState).suspend(request(other)),
    ).resolves.toMatchObject({ status: "blocked", reason: "state-unsafe" });
    await expect(readFile(other, "utf8")).resolves.toBe("skill");
  });

  it("stores and restores a directory without following a contained broken link", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "directory-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "skill", "utf8");
    await symlink(
      join(environment.home, "missing-target"),
      join(source, "broken-link"),
    );
    const storage = harness(join(environment.state, "state"));
    const suspended = await storage.suspend(request(source, "directory"));
    expect(suspended.status).toBe("suspended");
    if (suspended.status !== "suspended") return;
    await expect(storage.enable(suspended.entry)).resolves.toMatchObject({
      status: "enabled",
    });
    await expect(lstat(join(source, "broken-link"))).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
  });

  it("round-trips a top-level broken symbolic link without following its target", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "broken-skill-link");
    const target = join(environment.home, "does-not-exist");
    await symlink(target, source);
    const linked = {
      ...request(source),
      location: {
        path: source,
        canonicalPath: null,
        artifactType: { kind: "symbolic-link" as const, target, broken: true },
      },
    };
    const storage = harness(join(environment.state, "state"));
    const suspended = await storage.suspend(linked);
    expect(suspended.status).toBe("suspended");
    if (suspended.status !== "suspended") return;
    await expect(storage.enable(suspended.entry)).resolves.toMatchObject({
      status: "enabled",
    });
    await expect(lstat(source)).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
  });

  it("round-trips a regular top-level symbolic link without changing its target", async () => {
    const environment = await createEnvironment();
    const target = join(environment.home, "linked-target");
    const source = join(environment.home, "linked-skill");
    await writeFile(target, "target content", "utf8");
    await symlink(target, source);
    const storage = harness(join(environment.state, "state"));
    const entry = await suspendedEntry(storage, {
      ...request(source),
      location: {
        path: source,
        canonicalPath: target,
        artifactType: {
          kind: "symbolic-link",
          target,
          broken: false,
        },
      },
    });

    await expect(storage.enable(entry)).resolves.toMatchObject({
      status: "enabled",
    });
    await expect(readlink(source)).resolves.toBe(target);
    await expect(readFile(target, "utf8")).resolves.toBe("target content");
  });

  it("preserves junction identity through the neutral filesystem seam", async () => {
    const environment = await createEnvironment();
    const target = join(environment.home, "junction-target");
    const source = join(environment.home, "junction-skill");
    await mkdir(target);
    await symlink(target, source, "dir");
    const createdTypes: Array<"file" | "dir" | "junction" | undefined> = [];
    const junctionFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async readLink(path) {
        return { kind: "junction", target: await readlink(path) };
      },
      async symlink(linkTarget, path, type) {
        createdTypes.push(type);
        await nodeArtifactFileSystem.symlink(linkTarget, path);
      },
    };
    const storage = harness(
      join(environment.state, "state"),
      junctionFileSystem,
    );
    const entry = await suspendedEntry(storage, {
      ...request(source),
      location: {
        path: source,
        canonicalPath: target,
        artifactType: { kind: "junction", target, broken: false },
      },
    });

    await expect(storage.enable(entry)).resolves.toMatchObject({
      status: "enabled",
    });
    expect(createdTypes).toContain("junction");
    await expect(readlink(source)).resolves.toBe(target);
  });

  it("requires nonempty, unique, sorted Harness Exposures", async () => {
    const environment = await createEnvironment();
    const source = join(environment.home, "exposure-skill");
    const exposure = (harnessId: string) => ({
      harnessId,
      status: "enabled" as const,
      control: { kind: "unsupported" as const, reason: "fixture" },
    });
    for (const harnessExposures of [
      [],
      [exposure("same"), exposure("same")],
      [exposure("zeta"), exposure("alpha")],
    ]) {
      await writeFile(source, "skill", "utf8");
      await expect(
        harness(
          join(environment.state, `state-${harnessExposures.length}`),
        ).suspend({
          ...request(source),
          harnessExposures,
        }),
      ).resolves.toMatchObject({
        status: "blocked",
        reason: "source-not-eligible",
      });
      await expect(readFile(source, "utf8")).resolves.toBe("skill");
    }
    const sorted = {
      ...request(source),
      harnessExposures: [exposure("alpha"), exposure("zeta")],
    };
    await expect(
      harness(join(environment.state, "state-sorted")).suspend(sorted),
    ).resolves.toMatchObject({ status: "suspended" });
  });

  it("performs zero writes for list and preview and exposes no purge lifecycle", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "read-only-skill");
    await writeFile(source, "skill", "utf8");
    let writes = 0;
    const observed: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async mkdir(path, options) {
        writes += 1;
        await nodeArtifactFileSystem.mkdir(path, options);
      },
      async writeFile(path, data, options) {
        writes += 1;
        await nodeArtifactFileSystem.writeFile(path, data, options);
      },
      async link(from, to) {
        writes += 1;
        await nodeArtifactFileSystem.link(from, to);
      },
      async rename(from, to) {
        writes += 1;
        await nodeArtifactFileSystem.rename(from, to);
      },
      async unlink(path) {
        writes += 1;
        await nodeArtifactFileSystem.unlink(path);
      },
      async rmdir(path) {
        writes += 1;
        await nodeArtifactFileSystem.rmdir(path);
      },
      async chmod(path, mode) {
        writes += 1;
        await nodeArtifactFileSystem.chmod(path, mode);
      },
      async utimes(path, accessedAt, modifiedAt) {
        writes += 1;
        await nodeArtifactFileSystem.utimes(path, accessedAt, modifiedAt);
      },
      async symlink(target, path, type) {
        writes += 1;
        await nodeArtifactFileSystem.symlink(target, path, type);
      },
      async syncFile(path) {
        writes += 1;
        await nodeArtifactFileSystem.syncFile(path);
      },
      async syncDirectory(path) {
        writes += 1;
        await nodeArtifactFileSystem.syncDirectory(path);
      },
    };
    const storage = harness(stateRoot, observed);
    const entry = await suspendedEntry(storage, request(source));
    writes = 0;

    await expect(storage.list()).resolves.toEqual([entry]);
    await expect(storage.previewEnable(entry)).resolves.toMatchObject({
      status: "would-enable",
    });
    expect(writes).toBe(0);
    expect("purge" in storage).toBe(false);
    expect("expiresAt" in entry).toBe(false);
    await expect(access(join(stateRoot, "quarantine"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks source/state ancestry in both directions and linked state descendants", async () => {
    const environment = await createEnvironment();
    const ancestorSource = join(environment.home, "ancestor-skill");
    await mkdir(ancestorSource);
    await writeFile(join(ancestorSource, "SKILL.md"), "skill", "utf8");
    await expect(
      harness(join(ancestorSource, "state")).suspend(
        request(ancestorSource, "directory"),
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "state-unsafe" });
    await expect(
      readFile(join(ancestorSource, "SKILL.md"), "utf8"),
    ).resolves.toBe("skill");

    const descendantState = join(environment.state, "descendant-state");
    const descendantSource = join(
      descendantState,
      "disabled-storage",
      "v1",
      "source",
    );
    await mkdir(dirname(descendantSource), { recursive: true });
    await writeFile(descendantSource, "skill", "utf8");
    await expect(
      harness(descendantState).suspend(request(descendantSource)),
    ).resolves.toMatchObject({ status: "blocked", reason: "state-unsafe" });
    await expect(readFile(descendantSource, "utf8")).resolves.toBe("skill");

    const linkedDescendantState = join(environment.state, "linked-descendant");
    await mkdir(linkedDescendantState);
    await symlink(
      environment.home,
      join(linkedDescendantState, "disabled-storage"),
      "dir",
    );
    const outside = join(environment.home, "outside-state-skill");
    await writeFile(outside, "skill", "utf8");
    await expect(
      harness(linkedDescendantState).suspend(request(outside)),
    ).resolves.toMatchObject({ status: "blocked", reason: "state-unsafe" });
    await expect(readFile(outside, "utf8")).resolves.toBe("skill");
  });

  it("recovers before enable preflight and rolls an interrupted temporary copy back to a stable retry", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "temporary-copy-skill");
    await writeFile(source, "complete payload", "utf8");
    const normal = harness(stateRoot);
    const entry = await suspendedEntry(normal, request(source));
    const temporary = restorePath(source, entry.id);
    let interrupted = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async syncFile(path) {
        await nodeArtifactFileSystem.syncFile(path);
        if (path === temporary && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("after temporary copy"), {
            code: "EIO",
          });
        }
      },
    };
    await expect(
      harness(stateRoot, faultFileSystem).enable(entry),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await missing(source);
    await expect(readFile(temporary, "utf8")).resolves.toBe("complete payload");

    const recovered = harness(stateRoot);
    await expect(recovered.enable(entry)).resolves.toMatchObject({
      status: "enabled",
      destination: source,
    });
    await expect(readFile(source, "utf8")).resolves.toBe("complete payload");
    await missing(temporary);
    await expect(recovered.list()).resolves.toEqual([]);
  });

  it("finalizes an exact published destination after a completed-publication interruption", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "published-skill");
    await writeFile(source, "published", "utf8");
    const normal = harness(stateRoot);
    const entry = await suspendedEntry(normal, request(source));
    let interrupted = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async chmod(path, mode) {
        if (path === source && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("after publication"), { code: "EIO" });
        }
        await nodeArtifactFileSystem.chmod(path, mode);
      },
    };
    await expect(
      harness(stateRoot, faultFileSystem).enable(entry),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("published");

    const recovered = harness(stateRoot);
    await expect(recovered.enable(entry)).resolves.toMatchObject({
      status: "enabled",
      destination: source,
    });
    await expect(recovered.list()).resolves.toEqual([]);
  });

  it("leaves an occupied mismatching enable destination untouched and retains its entry", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "publication-race");
    await writeFile(source, "disabled", "utf8");
    const normal = harness(stateRoot);
    const entry = await suspendedEntry(normal, request(source));
    let raced = false;
    const racingFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async link(from, to) {
        if (to === source && !raced) {
          raced = true;
          await writeFile(source, "racer", "utf8");
        }
        await nodeArtifactFileSystem.link(from, to);
      },
    };
    const racing = harness(stateRoot, racingFileSystem);
    await expect(racing.enable(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("racer");
    await expect(racing.list()).resolves.toEqual([entry]);
  });

  it("resumes an interrupted directory publication only from its validated claim", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "directory-publication");
    await mkdir(source);
    await writeFile(join(source, "a.txt"), "a", "utf8");
    await writeFile(join(source, "b.txt"), "b", "utf8");
    const normal = harness(stateRoot);
    const entry = await suspendedEntry(normal, request(source, "directory"));
    let interrupted = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async writeFile(path, data, options) {
        if (path === join(source, "b.txt") && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("mid-directory publication"), {
            code: "EIO",
          });
        }
        await nodeArtifactFileSystem.writeFile(path, data, options);
      },
    };
    await expect(
      harness(stateRoot, faultFileSystem).enable(entry),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await expect(readFile(join(source, "a.txt"), "utf8")).resolves.toBe("a");
    await missing(join(source, "b.txt"));
    await expect(
      readFile(join(source, `.skill-cleaner-${entry.id}.claim`), "utf8"),
    ).resolves.toContain(entry.id);

    const recovered = harness(stateRoot);
    await expect(recovered.enable(entry)).resolves.toMatchObject({
      status: "enabled",
    });
    await expect(readFile(join(source, "b.txt"), "utf8")).resolves.toBe("b");
    await missing(join(source, `.skill-cleaner-${entry.id}.claim`));
    await expect(recovered.list()).resolves.toEqual([]);
  });

  it("blocks an unclaimed partial directory without consuming its entry", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "unclaimed-partial");
    await mkdir(source);
    await writeFile(join(source, "a.txt"), "a", "utf8");
    await writeFile(join(source, "b.txt"), "b", "utf8");
    const normal = harness(stateRoot);
    const entry = await suspendedEntry(normal, request(source, "directory"));
    let interrupted = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async writeFile(path, data, options) {
        if (path === join(source, "b.txt") && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("mid-directory publication"), {
            code: "EIO",
          });
        }
        await nodeArtifactFileSystem.writeFile(path, data, options);
      },
    };
    await harness(stateRoot, faultFileSystem).enable(entry);
    await writeFile(
      join(source, `.skill-cleaner-${entry.id}.claim`),
      "forged claim",
      "utf8",
    );

    const recovered = harness(stateRoot);
    await expect(recovered.enable(entry)).resolves.toMatchObject({
      status: "blocked",
      reason: "destination-occupied",
    });
    await expect(readFile(join(source, "a.txt"), "utf8")).resolves.toBe("a");
    await missing(join(source, "b.txt"));
    await expect(recovered.list()).resolves.toEqual([entry]);
  });

  it("rolls back failures after pending rename and after stage commit for stable retries", async () => {
    for (const point of ["pending", "commit"] as const) {
      const environment = await createEnvironment();
      const stateRoot = join(environment.state, `state-${point}`);
      const source = join(environment.home, `${point}-skill`);
      await writeFile(source, `${point} payload`, "utf8");
      const paths = layout(stateRoot);
      const stage = join(paths.staging, "disabled-1");
      const destination = join(paths.entries, "disabled-1");
      let interrupted = false;
      let pendingReached = false;
      const faultFileSystem: ArtifactFileSystem = {
        ...nodeArtifactFileSystem,
        async rename(from, to) {
          await nodeArtifactFileSystem.rename(from, to);
          if (from === source && to === pendingPath(source, "disabled-1"))
            pendingReached = true;
        },
        async syncDirectory(path) {
          if (
            point === "pending" &&
            pendingReached &&
            path === stage &&
            !interrupted
          ) {
            interrupted = true;
            throw Object.assign(new Error("after pending rename"), {
              code: "EIO",
            });
          }
          if (point === "commit" && path === paths.entries && !interrupted) {
            interrupted = true;
            throw Object.assign(new Error("after stage commit"), {
              code: "EIO",
            });
          }
          await nodeArtifactFileSystem.syncDirectory(path);
        },
      };
      await expect(
        harness(stateRoot, faultFileSystem).suspend(request(source)),
      ).resolves.toMatchObject({
        status: "blocked",
        reason: "state-unsafe",
      });
      await expect(readFile(source, "utf8")).resolves.toBe(`${point} payload`);
      await expect(harness(stateRoot).list()).resolves.toEqual([]);
      await expect(
        harness(stateRoot).suspend(request(source)),
      ).resolves.toMatchObject({
        status: "suspended",
      });
      await missing(stage);
      await expect(readdir(destination)).resolves.toContain("payload");
    }
  });

  it("atomically returns a raced changed pending source without discarding the verified payload", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "changed-pending-skill");
    await writeFile(source, "planned payload", "utf8");
    const paths = layout(stateRoot);
    const stage = join(paths.staging, "disabled-1");
    const pending = pendingPath(source, "disabled-1");
    let interrupted = false;
    let pendingReached = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async rename(from, to) {
        await nodeArtifactFileSystem.rename(from, to);
        if (from === source && to === pending) pendingReached = true;
      },
      async syncDirectory(path) {
        if (pendingReached && path === stage && !interrupted) {
          interrupted = true;
          await writeFile(pending, "raced payload", "utf8");
          throw Object.assign(new Error("pending changed"), { code: "EIO" });
        }
        await nodeArtifactFileSystem.syncDirectory(path);
      },
    };

    await expect(
      harness(stateRoot, faultFileSystem).suspend(request(source)),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("raced payload");
    await missing(pending);
    await expect(readFile(join(stage, "payload"), "utf8")).resolves.toBe(
      "planned payload",
    );
  });

  it("never deletes payload or pending artifacts when suspend recovery finds an occupied or partial source", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "blocked-recovery-skill");
    await writeFile(source, "planned payload", "utf8");
    const paths = layout(stateRoot);
    const stage = join(paths.staging, "disabled-1");
    const payload = join(stage, "payload");
    const pending = pendingPath(source, "disabled-1");
    let pendingReached = false;
    let interrupted = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async rename(from, to) {
        await nodeArtifactFileSystem.rename(from, to);
        if (from === source && to === pending) pendingReached = true;
      },
      async syncDirectory(path) {
        if (path === stage && pendingReached && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("after pending rename"), {
            code: "EIO",
          });
        }
        await nodeArtifactFileSystem.syncDirectory(path);
      },
      async writeFile(path, data, options) {
        if (interrupted && path === source)
          throw Object.assign(new Error("rollback interrupted"), {
            code: "EIO",
          });
        await nodeArtifactFileSystem.writeFile(path, data, options);
      },
    };
    await harness(stateRoot, faultFileSystem).suspend(request(source));
    await missing(source);
    await expect(readFile(payload, "utf8")).resolves.toBe("planned payload");
    await expect(readFile(pending, "utf8")).resolves.toBe("planned payload");

    await writeFile(source, "occupied by racer", "utf8");
    const trigger = join(environment.home, "recovery-trigger");
    await writeFile(trigger, "trigger", "utf8");
    await expect(
      harness(stateRoot).suspend(request(trigger)),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await expect(readFile(source, "utf8")).resolves.toBe("occupied by racer");
    await expect(readFile(payload, "utf8")).resolves.toBe("planned payload");
    await expect(readFile(pending, "utf8")).resolves.toBe("planned payload");

    await unlink(source);
    await writeFile(payload, "partial payload", "utf8");
    await expect(
      harness(stateRoot).suspend(request(trigger)),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await expect(readFile(payload, "utf8")).resolves.toBe("partial payload");
    await expect(readFile(pending, "utf8")).resolves.toBe("planned payload");
    await missing(source);
  });

  it("rejects a forged recovery journal without touching any redirected external path", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const source = join(environment.home, "journal-source");
    const external = join(environment.workspace, "external-target");
    await writeFile(source, "planned payload", "utf8");
    await writeFile(external, "external content", "utf8");
    const paths = layout(stateRoot);
    const stage = join(paths.staging, "disabled-1");
    const journalPath = join(stage, "transaction.json");
    const pending = pendingPath(source, "disabled-1");
    let pendingReached = false;
    let interrupted = false;
    const faultFileSystem: ArtifactFileSystem = {
      ...nodeArtifactFileSystem,
      async rename(from, to) {
        await nodeArtifactFileSystem.rename(from, to);
        if (from === source && to === pending) pendingReached = true;
      },
      async syncDirectory(path) {
        if (path === stage && pendingReached && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error("after pending rename"), {
            code: "EIO",
          });
        }
        await nodeArtifactFileSystem.syncDirectory(path);
      },
      async writeFile(path, data, options) {
        if (interrupted && path === source)
          throw Object.assign(new Error("rollback interrupted"), {
            code: "EIO",
          });
        await nodeArtifactFileSystem.writeFile(path, data, options);
      },
    };
    await harness(stateRoot, faultFileSystem).suspend(request(source));
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      journalPath,
      `${JSON.stringify({ ...journal, source: external })}\n`,
      "utf8",
    );
    const trigger = join(environment.home, "forged-trigger");
    await writeFile(trigger, "trigger", "utf8");

    await expect(
      harness(stateRoot).suspend(request(trigger)),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "state-unsafe",
    });
    await expect(readFile(external, "utf8")).resolves.toBe("external content");
    await expect(readFile(join(stage, "payload"), "utf8")).resolves.toBe(
      "planned payload",
    );
    await expect(readFile(pending, "utf8")).resolves.toBe("planned payload");
  });

  it("safely removes an unjournaled stage without following its links", async () => {
    const environment = await createEnvironment();
    const stateRoot = join(environment.state, "state");
    const paths = layout(stateRoot);
    const orphan = join(paths.staging, "orphan-stage");
    const external = join(environment.workspace, "external-sentinel");
    await mkdir(orphan, { recursive: true });
    await mkdir(paths.entries, { recursive: true });
    await writeFile(external, "keep me", "utf8");
    await symlink(external, join(orphan, "sentinel-link"));
    const source = join(environment.home, "stage-cleanup-skill");
    await writeFile(source, "skill", "utf8");

    await expect(
      harness(stateRoot).suspend(request(source)),
    ).resolves.toMatchObject({
      status: "suspended",
    });
    await missing(orphan);
    await expect(readFile(external, "utf8")).resolves.toBe("keep me");
  });
});
