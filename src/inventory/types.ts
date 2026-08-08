import type {
  Inventory,
  PluginReference,
  Scope,
  SourceReference,
} from "../model/types.js";
import type { AdapterCatalog } from "../adapter/types.js";

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
  /** Already validated and trusted compiled adapter declarations. */
  readonly adapterCatalog?: AdapterCatalog;
  readonly executablePresent?: (executable: string) => Promise<boolean>;
}

export interface InventoryScanEnvironment {
  readonly homeDirectory: string;
  readonly workspaceDirectory: string;
  readonly configDirectory?: string;
  /**
   * The value of `XDG_STATE_HOME`, or `null` when it is unset.
   *
   * This is the environment variable itself, not a resolved state location.
   * Managers branch on whether a user set it: Vercel `skills` reads its global
   * lock from `<XDG_STATE_HOME>/skills/.skill-lock.json` when it is set and
   * from `<home>/.agents/.skill-lock.json` when it is not. Substituting a
   * conventional default such as `~/.local/state` makes the unset branch
   * unreachable and hides real installations. skill-cleaner's own state root is
   * unrelated and lives behind `state/root.ts`.
   */
  readonly stateDirectory?: string | null;
  /**
   * The cache location an agent runtime unpacks itself into, following
   * `XDG_CACHE_HOME` and defaulting to `<home>/.cache`. Used to recognize a
   * marketplace the runtime manages rather than one a user added.
   */
  readonly cacheDirectory?: string;
  readonly nodeVersion?: string;
  readonly agentHomeDirectories?: Readonly<Record<string, string>>;
}

export interface InventoryCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
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
