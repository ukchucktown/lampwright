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
import { systemCommandRunner } from "../inventory/process.js";
import { parseWindowsReparseKind } from "./windows-reparse.js";

/** Generic filesystem seam shared by recoverable artifact stores. */
export interface ArtifactFileStats {
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly mode: number;
  readonly modifiedAt: Date;
}
export interface ArtifactLink {
  readonly kind: "symbolic-link" | "junction";
  readonly target: string;
}
export interface ArtifactFileSystem {
  lstat(path: string): Promise<ArtifactFileStats>;
  readdir(path: string): Promise<readonly string[]>;
  readFile(path: string): Promise<Buffer>;
  readLink(path: string): Promise<ArtifactLink>;
  realpath(path: string): Promise<string>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<void>;
  writeFile(
    path: string,
    data: string | Buffer,
    options?: { readonly exclusive?: boolean },
  ): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, accessedAt: Date, modifiedAt: Date): Promise<void>;
  symlink(
    target: string,
    path: string,
    type?: "file" | "dir" | "junction",
  ): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}
export const nodeArtifactFileSystem: ArtifactFileSystem = {
  async lstat(path) {
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
  readdir,
  readFile,
  realpath,
  async readLink(path) {
    const target = await readlink(path);
    if (process.platform !== "win32") return { kind: "symbolic-link", target };
    const result = await systemCommandRunner.run({
      executable: "fsutil",
      arguments: ["reparsepoint", "query", path],
    });
    const kind =
      result.exitCode === 0 ? parseWindowsReparseKind(result.stdout) : null;
    if (kind === null)
      throw new Error(`unable to classify Windows reparse point: ${path}`);
    return { kind, target };
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: options?.recursive ?? false });
  },
  async writeFile(path, data, options) {
    await writeFile(path, data, { flag: options?.exclusive ? "wx" : "w" });
  },
  link,
  rename,
  unlink,
  rmdir,
  chmod,
  utimes,
  symlink,
  async syncFile(path) {
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async syncDirectory(path) {
    if (process.platform === "win32") return;
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};
