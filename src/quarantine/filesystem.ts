import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type {
  QuarantineFileStats,
  QuarantineFileSystem,
  QuarantineLink,
} from "./types.js";

interface SyncFileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type OpenSyncFile = (
  path: string,
  flags: "r" | "r+",
) => Promise<SyncFileHandle>;

export async function syncRegularFile(
  path: string,
  openFile: OpenSyncFile = open,
): Promise<void> {
  const handle = await openFile(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const nodeQuarantineFileSystem: QuarantineFileSystem = {
  async lstat(path): Promise<QuarantineFileStats> {
    const stats = await lstat(path);
    return {
      kind: stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : stats.isSymbolicLink()
            ? "symbolic-link"
            : "other",
      mode: stats.mode,
      modifiedAt: stats.mtime,
    };
  },
  async readdir(path) {
    return readdir(path);
  },
  async readFile(path) {
    return readFile(path);
  },
  async readLink(path): Promise<QuarantineLink> {
    const target = await readlink(path);
    const junction =
      process.platform === "win32" &&
      (target.startsWith("\\\\?\\") || target.startsWith("\\??\\"));
    return { kind: junction ? "junction" : "symbolic-link", target };
  },
  async realpath(path) {
    return realpath(path);
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: options?.recursive ?? false });
  },
  async writeFile(path, data, options) {
    await writeFile(path, data, { flag: options?.exclusive ? "wx" : "w" });
  },
  async link(existingPath, newPath) {
    await link(existingPath, newPath);
  },
  async rename(source, destination) {
    await rename(source, destination);
  },
  async unlink(path) {
    await unlink(path);
  },
  async rmdir(path) {
    await rmdir(path);
  },
  async chmod(path, mode) {
    await chmod(path, mode);
  },
  async utimes(path, accessedAt, modifiedAt) {
    await utimes(path, accessedAt, modifiedAt);
  },
  async symlink(target, path, type) {
    await symlink(target, path, type);
  },
  async syncFile(path) {
    await syncRegularFile(path);
  },
  async syncDirectory(path) {
    if (process.platform === "win32") {
      return;
    }
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};
