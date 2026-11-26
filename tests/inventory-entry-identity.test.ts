import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";

import { createInventoryScanner } from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

// The links, metadata and canonical paths are real. Supply only the file IDs
// that the test filesystem cannot allocate on demand, in Node's requested precision.
const fileIds = vi.hoisted(() => new Map<string, bigint>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async lstat(...args: Parameters<typeof fs.lstat>) {
      const stats = await fs.lstat(...args);
      const id = typeof args[0] === "string" ? fileIds.get(args[0]) : undefined;
      if (id !== undefined)
        stats.ino = typeof stats.ino === "bigint" ? id : Number(id);
      return stats;
    },
  };
});

const environment = createIsolatedTestEnvironmentFixture();

it.each(["full precision", "unavailable"] as const)(
  "preserves distinct links to one Skill when file IDs are %s",
  async (identity) => {
    const { home, workspace } = await environment();
    const directory = join(home, "sources");
    const root = join(directory, "skills");
    const alias = join(home, "alias");
    const target = join(workspace, "skill");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await mkdir(root, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, "SKILL.md"), "---\nname: shared\n---\n");
    await symlink(directory, alias, linkType);
    const roots =
      identity === "full precision" ? [root, join(alias, "skills")] : [root];
    const first = 2n ** 53n;
    expect(Number(first)).toBe(Number(first + 1n));
    for (const [index, name] of ["first", "second"].entries()) {
      await symlink(target, join(root, name), linkType);
      for (const path of roots)
        fileIds.set(
          join(path, name),
          identity === "full precision" ? first + BigInt(index) : 0n,
        );
    }
    try {
      const inventory = await createInventoryScanner({
        environment: { homeDirectory: home, workspaceDirectory: workspace },
        commandRunner: { run: async () => ({ exitCode: null, stdout: "" }) },
        now: () => new Date("2026-01-01T00:00:00Z"),
      }).scan({
        roots: roots.map((path) => ({
          kind: "user",
          path,
          agentId: "fixture",
          adapterId: null,
        })),
      });
      expect(
        inventory.installations
          .map((item) => basename(item.location.path))
          .sort(),
      ).toEqual(["first", "second"]);
      expect(inventory.logicalSkills).toHaveLength(1);
      expect([...inventory.logicalSkills[0]!.installationIds].sort()).toEqual(
        inventory.installations.map((item) => item.id).sort(),
      );
    } finally {
      fileIds.clear();
    }
  },
);
