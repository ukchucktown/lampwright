import type {
  Inventory,
  PluginReference,
  Scope,
  SourceReference,
} from "../model/types.js";

interface DiscoveryRootBase {
  readonly path: string;
  readonly adapterId: string | null;
}

export type DiscoveryRoot =
  | (DiscoveryRootBase & {
      readonly kind: "user";
      readonly agentId: string;
    })
  | (DiscoveryRootBase & {
      readonly kind: "agent";
      readonly agentId: string;
    })
  | (DiscoveryRootBase & {
      readonly kind: "workspace";
      readonly agentId: string;
      readonly workspacePath: string;
    })
  | (DiscoveryRootBase & {
      readonly kind: "plugin";
      readonly agentId: string;
      readonly scope: Scope;
      readonly plugin: PluginReference;
      readonly independentlySelectable: boolean;
    })
  | (DiscoveryRootBase & {
      readonly kind: "source";
      readonly agentId: string | null;
      readonly scope: Scope | null;
      readonly source: SourceReference;
    })
  | (DiscoveryRootBase & {
      readonly kind: "cache-or-vendor" | "unknown";
      readonly agentId: string | null;
      readonly scope: Scope | null;
    })
  | (DiscoveryRootBase & {
      readonly kind: "system";
      readonly agentId: string;
    });

export interface ScanRequest {
  readonly roots?: readonly DiscoveryRoot[];
}

export interface InventoryScanner {
  scan(request: ScanRequest): Promise<Inventory>;
}

export interface InventoryScannerOptions {
  readonly now: () => Date;
  readonly environment: InventoryScanEnvironment;
  readonly commandRunner: InventoryCommandRunner;
}

export interface InventoryScanEnvironment {
  readonly homeDirectory: string;
  readonly workspaceDirectory: string;
}

export interface InventoryCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface InventoryCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface InventoryCommandRunner {
  run(command: InventoryCommand): Promise<InventoryCommandResult>;
}

export type InventoryScanErrorCode =
  "invalid-request" | "filesystem-unavailable";

export class InventoryScanError extends Error {
  readonly code: InventoryScanErrorCode;
  readonly path: string | null;

  constructor(
    code: InventoryScanErrorCode,
    message: string,
    path: string | null = null,
  ) {
    super(message);
    this.name = "InventoryScanError";
    this.code = code;
    this.path = path;
  }
}
