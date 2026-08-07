import type {
  ApprovalRequirement,
  ExecutionReport,
  Installation,
  Inventory,
  LogicalSkill,
  NonInstallationFinding,
  PluginBoundary,
  RemovalPlan,
  RemovalPlanIntent,
  RemovalTarget,
} from "../model/types.js";

export interface TuiDependencies {
  readonly scan: () => Promise<Inventory>;
  readonly plan: (
    inventory: Inventory,
    intent: RemovalPlanIntent,
  ) => RemovalPlan;
  readonly execute: (
    plan: RemovalPlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<ExecutionReport>;
}

export type TuiRowKind =
  "logical-skill" | "installation" | "plugin" | "finding";

export type TuiSummaryStatus =
  "removable" | "protected" | "unresolved" | "source-only";

export interface TuiSearchFields {
  readonly all: readonly string[];
  readonly plugin: readonly string[];
  readonly agent: readonly string[];
  readonly scope: readonly string[];
  readonly source: readonly string[];
  readonly manager: readonly string[];
  readonly status: readonly string[];
}

export interface TuiRow {
  readonly key: string;
  readonly kind: TuiRowKind;
  readonly name: string;
  readonly description: string | null;
  readonly summaryStatus: TuiSummaryStatus;
  readonly target: RemovalTarget | null;
  readonly depth: 0 | 1;
  readonly childCount: number;
  readonly hiddenByDefault: boolean;
  readonly search: TuiSearchFields;
  readonly installation: Installation | null;
  readonly logicalSkill: LogicalSkill | null;
  readonly plugin: PluginBoundary | null;
  readonly finding: NonInstallationFinding | null;
}

export interface TuiCatalogGroup {
  readonly row: TuiRow;
  readonly children: readonly TuiRow[];
}

export interface TuiVisibleRow extends TuiRow {
  readonly expanded: boolean;
}

export interface TuiBrowseSnapshot {
  readonly inventory: Inventory;
  readonly query: string;
  readonly expandedKeys: ReadonlySet<string>;
  readonly rows: readonly TuiVisibleRow[];
  readonly cursor: number;
}

export interface TuiLoadingState {
  readonly screen: "loading";
}

export interface TuiBrowseState extends TuiBrowseSnapshot {
  readonly screen: "browse";
}

export interface TuiPlanState {
  readonly screen: "plan";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: RemovalPlan;
  readonly label: string;
  readonly returnReport: TuiReportState | null;
}

export interface TuiReportState {
  readonly screen: "report";
  readonly browse: TuiBrowseSnapshot;
  readonly report: ExecutionReport;
  readonly fallbackCursor: number;
}

export interface TuiErrorState {
  readonly screen: "error";
  readonly message: string;
}

export interface TuiDoneState {
  readonly screen: "done";
  readonly report: ExecutionReport | null;
}

export type TuiState =
  | TuiLoadingState
  | TuiBrowseState
  | TuiPlanState
  | TuiReportState
  | TuiErrorState
  | TuiDoneState;

export type TuiAction =
  | { readonly kind: "noop" }
  | { readonly kind: "set-query"; readonly value: string }
  | { readonly kind: "append-query"; readonly value: string }
  | { readonly kind: "delete-query" }
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "toggle-expand" }
  | { readonly kind: "select" }
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
  | { readonly kind: "force" }
  | { readonly kind: "fallback" }
  | { readonly kind: "quit" };

export type TuiOutcome =
  | { readonly status: "completed"; readonly report: ExecutionReport }
  | { readonly status: "cancelled"; readonly report: ExecutionReport | null }
  | { readonly status: "failed"; readonly message: string };

export interface TuiTerminal {
  render(state: TuiState): void;
  readAction(state: TuiState): Promise<TuiAction>;
  close(): void;
}
