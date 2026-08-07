import type {
  ArtifactType,
  ApprovalRequirement,
  ExecutableCommand,
  ExecutionApprovals,
  ExecutionReport,
  GitProtection,
  Inventory,
  RemovalPlan,
  RemovalPlanIntent,
} from "../model/types.js";
import type { QuarantineModule } from "../quarantine/types.js";

export type Approvals = ExecutionApprovals;

export interface ExecutionModule {
  execute(plan: RemovalPlan, approvals: Approvals): Promise<ExecutionReport>;
}

export interface ExecutionProcessRequest {
  readonly command: ExecutableCommand;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ExecutionProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecutionProcessRunner {
  run(request: ExecutionProcessRequest): Promise<ExecutionProcessResult>;
}

export type ExecutionGitProtectionInspector = (
  path: string,
  artifactType?: ArtifactType,
) => Promise<GitProtection>;

export interface ExecutionAuditRecord {
  readonly schemaVersion: 1;
  readonly plan: RemovalPlan;
  readonly approvals: ExecutionApprovals;
  readonly report: ExecutionReport;
}

export interface ExecutionAuditWriter {
  write(record: ExecutionAuditRecord): Promise<void>;
}

export type PackageTrustDecision = Omit<
  Extract<ApprovalRequirement, { kind: "package-trust" }>,
  "kind"
>;

export interface PackageTrustStore {
  isTrusted(requirement: PackageTrustDecision): Promise<boolean>;
  trust(requirement: PackageTrustDecision): Promise<void>;
}

export interface ExecutionModuleOptions {
  readonly scan: () => Promise<Inventory>;
  readonly replan: (
    inventory: Inventory,
    intent: RemovalPlanIntent,
  ) => RemovalPlan;
  readonly quarantine: QuarantineModule;
  readonly processRunner: ExecutionProcessRunner;
  readonly inspectGitProtection: ExecutionGitProtectionInspector;
  readonly auditWriter: ExecutionAuditWriter;
  readonly packageTrustStore: PackageTrustStore;
  readonly now: () => Date;
  readonly stateRoot: string;
  readonly maxConcurrency?: number;
}

export type ExecutionErrorCode =
  "audit-failed" | "invalid-options" | "record-cleanup-failed" | "scan-failed";

export class ExecutionModuleError extends Error {
  readonly code: ExecutionErrorCode;

  constructor(
    code: ExecutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionModuleError";
    this.code = code;
  }
}
