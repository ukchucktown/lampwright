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

export interface TuiViewport {
  readonly rows: number;
  readonly columns: number;
}

export interface TuiLayout {
  readonly rows: number;
  readonly columns: number;
  /** One column short of the width; the last cell wraps on auto-margin. */
  readonly usable: number;
  readonly paneRows: number;
  readonly entryRows: number;
  readonly detailRows: number;
  readonly leftWidth: number;
  readonly rightWidth: number;
}

export interface TuiPaneView<Item> {
  readonly items: readonly Item[];
  readonly offset: number;
  readonly total: number;
  readonly height: number;
}

/** One selectable thing: a Logical Skill, a Plugin boundary, or a finding. */
export interface TuiEntry {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly exposedTo: readonly string[];
  readonly paths: readonly string[];
  readonly owner: string;
  /** Shown only when this entry departs from what its section already says. */
  readonly note: string | null;
  readonly target: RemovalTarget | null;
}

export interface TuiSection {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly selectable: boolean;
  /** Present when the section itself is a Removal Target, such as a Group. */
  readonly target: RemovalTarget | null;
  readonly entries: readonly TuiEntry[];
}

export interface TuiBrowseModel {
  readonly sections: readonly TuiSection[];
  readonly viewport: TuiViewport;
  readonly focus: "sections" | "entries" | "detail";
  readonly sectionIndex: number;
  readonly entryIndex: number;
  readonly sectionScroll: number;
  readonly entryScroll: number;
  readonly detailScroll: number;
  readonly leftPercent: number;
  readonly detailRows: number;
  readonly query: string;
  readonly selected: ReadonlySet<string>;
  readonly notice: string | null;
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
  readonly model: TuiBrowseModel;
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
  | { readonly kind: "append-query"; readonly value: string }
  | { readonly kind: "delete-query" }
  | { readonly kind: "move"; readonly delta: number }
  | {
      readonly kind: "move-pane";
      readonly pane: "sections" | "entries" | "detail";
      readonly delta: number;
    }
  | { readonly kind: "page"; readonly delta: number }
  | {
      readonly kind: "focus";
      readonly pane: "sections" | "entries" | "detail";
    }
  | { readonly kind: "point-section"; readonly index: number }
  | { readonly kind: "point-entry"; readonly index: number }
  | {
      readonly kind: "point-toggle";
      readonly pane: "sections" | "entries";
      readonly index: number;
    }
  | { readonly kind: "resize-panes"; readonly delta: number }
  | { readonly kind: "set-left-percent"; readonly percent: number }
  | { readonly kind: "resize-detail"; readonly delta: number }
  | { readonly kind: "set-detail-rows"; readonly rows: number }
  | { readonly kind: "viewport"; readonly viewport: TuiViewport }
  | { readonly kind: "toggle-select" }
  | { readonly kind: "clear-selection" }
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
