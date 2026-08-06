import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export async function hashSkillDirectory(
  directoryPath: string,
): Promise<string> {
  const hash = createHash("sha256");
  await hashDirectory(directoryPath, directoryPath, hash);
  return hash.digest("hex");
}

async function hashDirectory(
  rootPath: string,
  directoryPath: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    const relativePath = relative(rootPath, entryPath).split(sep).join("/");
    const stats = await lstat(entryPath);

    if (stats.isSymbolicLink()) {
      updateField(hash, "link");
      updateField(hash, relativePath);
      updateField(hash, await readlink(entryPath));
    } else if (stats.isDirectory()) {
      updateField(hash, "directory");
      updateField(hash, relativePath);
      await hashDirectory(rootPath, entryPath, hash);
    } else if (stats.isFile()) {
      const content = await readFile(entryPath);
      updateField(hash, "file");
      updateField(hash, relativePath);
      updateBuffer(hash, content);
    } else {
      updateField(hash, "other");
      updateField(hash, relativePath);
    }
  }
}

function updateField(hash: ReturnType<typeof createHash>, value: string): void {
  const content = Buffer.from(value, "utf8");
  updateBuffer(hash, content);
}

function updateBuffer(
  hash: ReturnType<typeof createHash>,
  value: Buffer,
): void {
  hash.update(String(value.byteLength));
  hash.update(":");
  hash.update(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
