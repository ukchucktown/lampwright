import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { stringifyModel } from "../model/json.js";
import {
  parseExecutionApprovals,
  parseExecutionReport,
  parseRemovalPlan,
} from "../model/validation.js";
import type { ExecutionAuditWriter, PackageTrustStore } from "./types.js";
import { ExecutionModuleError } from "./types.js";
import {
  parseAvailabilityPlan,
  parseAvailabilityReport,
} from "../availability/validation.js";
import type { AvailabilityExecutionAuditWriter } from "./types.js";

export function createFileExecutionAuditWriter(
  stateRoot: string,
): ExecutionAuditWriter {
  requireAbsoluteStateRoot(stateRoot);
  return {
    async write(record) {
      const plan = parseRemovalPlan(record.plan);
      const approvals = parseExecutionApprovals(record.approvals);
      const report = parseExecutionReport(record.report);
      if (
        record.schemaVersion !== 1 ||
        report.planId !== plan.id ||
        report.inventoryId !== plan.inventoryId ||
        !sameValues(
          report.actionResults.map((result) => result.actionId),
          plan.actions.map((action) => action.id),
        ) ||
        !sameValues(
          report.targetResults.map((result) => result.target),
          plan.targets,
        ) ||
        (report.rescanError === null
          ? !sameValues(
              report.verificationResults.map((result) => result.checkId),
              plan.verificationChecks.map((check) => check.id),
            )
          : report.verificationResults.length !== 0)
      ) {
        throw new ExecutionModuleError(
          "audit-failed",
          "audit record does not match its Removal Plan",
        );
      }
      const parsed = { schemaVersion: 1 as const, plan, approvals, report };
      const directory = join(stateRoot, "audit", "v1");
      await ensureStateDirectory(stateRoot, ["audit", "v1"]);
      const timestamp = report.completedAt.replaceAll(/[^0-9]/g, "");
      const path = join(directory, `${timestamp}-${randomUUID()}.json`);
      await writeFile(path, `${stringifyModel(parsed)}\n`, { flag: "wx" });
    },
  };
}

export function createFileAvailabilityExecutionAuditWriter(
  stateRoot: string,
): AvailabilityExecutionAuditWriter {
  requireAbsoluteStateRoot(stateRoot);
  return {
    async write(record) {
      const plan = parseAvailabilityPlan(record.plan);
      const approvals = parseExecutionApprovals(record.approvals);
      const report = parseAvailabilityReport(record.report);
      if (
        record.schemaVersion !== 1 ||
        report.planId !== plan.id ||
        report.inventoryId !== plan.inventoryId ||
        !sameValues(
          report.actionResults.map((result) => result.actionId),
          plan.actions.map((action) => action.id),
        ) ||
        !sameValues(
          report.targetResults.map((result) => result.target),
          plan.targets,
        ) ||
        (report.rescanError === null
          ? !sameValues(
              report.verificationResults.map((result) => result.checkId),
              plan.verificationChecks.map((check) => check.id),
            )
          : report.verificationResults.length !== 0)
      )
        throw new ExecutionModuleError(
          "audit-failed",
          "audit record does not match its Availability Plan",
        );
      const parsed = { schemaVersion: 1 as const, plan, approvals, report };
      const directory = join(stateRoot, "audit", "availability-v1");
      await ensureStateDirectory(stateRoot, ["audit", "availability-v1"]);
      const timestamp = report.completedAt.replaceAll(/[^0-9]/g, "");
      const path = join(directory, `${timestamp}-${randomUUID()}.json`);
      await writeFile(path, `${stringifyModel(parsed)}\n`, { flag: "wx" });
    },
  };
}

export function createFilePackageTrustStore(
  stateRoot: string,
): PackageTrustStore {
  requireAbsoluteStateRoot(stateRoot);
  const directory = join(stateRoot, "trust", "v1", "packages");
  return {
    async isTrusted(requirement) {
      if (
        !(await stateDirectoryAvailable(stateRoot, ["trust", "v1", "packages"]))
      ) {
        return false;
      }
      const path = join(directory, `${trustKey(requirement)}.json`);
      try {
        const stats = await lstat(path);
        if (!stats.isFile() || stats.isSymbolicLink()) return false;
        const stored = JSON.parse(await readFile(path, "utf8")) as unknown;
        return stringifyModel(stored, 0) === stringifyModel(requirement, 0);
      } catch (error: unknown) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async trust(requirement) {
      await ensureStateDirectory(stateRoot, ["trust", "v1", "packages"]);
      const path = join(directory, `${trustKey(requirement)}.json`);
      try {
        await writeFile(path, `${stringifyModel(requirement)}\n`, {
          flag: "wx",
        });
      } catch (error: unknown) {
        if (!isExists(error) || !(await this.isTrusted(requirement))) {
          throw error;
        }
      }
    },
  };
}

export async function prepareEphemeralExecutionState(
  stateRoot: string,
): Promise<{
  readonly cwd: string;
  readonly cache: string;
  cleanup(): Promise<void>;
}> {
  requireAbsoluteStateRoot(stateRoot);
  const base = join(stateRoot, "execution", "v1");
  const cache = join(base, "npm-cache");
  await ensureStateDirectory(stateRoot, ["execution", "v1", "npm-cache"]);
  const cwd = await mkdtemp(join(tmpdir(), "skill-cleaner-execution-"));
  return {
    cwd,
    cache,
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

export async function prepareIsolatedExecutionWorkingDirectory(): Promise<{
  readonly cwd: string;
  cleanup(): Promise<void>;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "skill-cleaner-owner-"));
  return {
    cwd,
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function sameValues(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return stringifyModel(left, 0) === stringifyModel(right, 0);
}

function trustKey(value: object): string {
  return createHash("sha256").update(stringifyModel(value, 0)).digest("hex");
}

function requireAbsoluteStateRoot(stateRoot: string): void {
  if (!isAbsolute(stateRoot)) {
    throw new ExecutionModuleError(
      "invalid-options",
      `execution state root must be absolute: ${stateRoot}`,
    );
  }
}

async function ensureStateDirectory(
  stateRoot: string,
  segments: readonly string[],
): Promise<void> {
  await ensureDirectory(stateRoot, true);
  let current = stateRoot;
  for (const segment of segments) {
    current = join(current, segment);
    await ensureDirectory(current, false);
  }
}

async function stateDirectoryAvailable(
  stateRoot: string,
  segments: readonly string[],
): Promise<boolean> {
  let current = stateRoot;
  for (const segment of ["", ...segments]) {
    if (segment.length > 0) current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error: unknown) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ExecutionModuleError(
        "invalid-options",
        `execution state path is not a safe directory: ${current}`,
      );
    }
  }
  return true;
}

async function ensureDirectory(
  path: string,
  recursive: boolean,
): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ExecutionModuleError(
        "invalid-options",
        `execution state path is not a safe directory: ${path}`,
      );
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    try {
      await mkdir(path, { recursive });
    } catch (mkdirError: unknown) {
      if (!isExists(mkdirError)) throw mkdirError;
    }
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ExecutionModuleError(
        "invalid-options",
        `execution state path is not a safe directory: ${path}`,
      );
    }
  }
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR");
}

function isExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
