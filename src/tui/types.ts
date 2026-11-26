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
import type {
  QuarantineModule,
  QuarantineOperation,
  PurgeOperationPreview,
  PurgeOperationResult,
  RestoreOperationPreview,
  RestoreOperationResult,
} from "../quarantine/types.js";
import type {
  AvailabilityIntent,
  AvailabilityPlan,
  AvailabilityReport,
  AvailabilityTarget,
} from "../availability/types.js";
import type {
  DisabledEntry,
  EnablePreview,
} from "../disabled-storage/types.js";
import type {
  UpdateIntent,
  UpdatePlan,
  UpdateReport,
} from "../update/types.js";
import type {
  AddAgentModule,
  AddAgentBatchReport,
} from "../execution/add-agent.js";
import type { AddAgentBatchPlan } from "../planning/add-agent.js";
import type { TuiThemeDefinition } from "./theme.js";

/** One row of the theme picker. A choice with a problem cannot be applied. */
export interface TuiThemeChoice {
  readonly name: string;
  readonly source: "built-in" | "custom";
  readonly path: string | null;
  readonly theme: TuiThemeDefinition | null;
  readonly problem: string | null;
}

/** Theme choices and the one write that the picker can cause. */
export interface TuiThemeDependencies {
  /** The theme in use when the terminal UI starts. */
  readonly current: TuiThemeDefinition;
  /** Shown once after the first scan, for a preference that had no effect. */
  readonly notice?: string | null;
  readonly list: () => Promise<readonly TuiThemeChoice[]>;
  /** Saves the selection; called only when the user confirms a theme. */
  readonly select: (name: string) => Promise<void>;
}

export interface TuiDependencies {
  readonly addAgent?: AddAgentModule;
  readonly scan: () => Promise<Inventory>;
  readonly plan: (
    inventory: Inventory,
    intent: RemovalPlanIntent,
  ) => RemovalPlan;
  readonly execute: (
    plan: RemovalPlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<ExecutionReport>;
  /** Optional to preserve embedding hosts that only provide Inventory. */
  readonly quarantine?: QuarantineModule;
  /** Availability values are optional for source compatibility with embedders. */
  readonly listDisabled?: () => Promise<readonly DisabledEntry[]>;
  /** Selects the entries that an Enable intent restores, to preview only those. */
  readonly enableEntries?: (
    inventory: Inventory,
    disabledEntries: readonly DisabledEntry[],
    intent: AvailabilityIntent,
  ) => readonly DisabledEntry[];
  /** Looks at the restore destinations of one entry and changes no state. */
  readonly previewEnable?: (entry: DisabledEntry) => Promise<EnablePreview>;
  readonly planAvailability?: (
    inventory: Inventory,
    disabledEntries: readonly DisabledEntry[],
    intent: AvailabilityIntent,
    enablePreviews?: readonly EnablePreview[],
  ) => AvailabilityPlan;
  readonly executeAvailability?: (
    plan: AvailabilityPlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<AvailabilityReport>;
  /** Update values are optional for source compatibility with embedders. */
  readonly planUpdate?: (
    inventory: Inventory,
    intent: UpdateIntent,
  ) => UpdatePlan;
  readonly executeUpdate?: (
    plan: UpdatePlan,
    approvals: readonly ApprovalRequirement[],
  ) => Promise<UpdateReport>;
  /** Injected for deterministic retention display and expiry classification. */
  readonly now?: () => Date;
  /** Optional to preserve embedding hosts that do not offer a theme picker. */
  readonly themes?: TuiThemeDependencies;
}

export interface TuiViewport {
  readonly rows: number;
  readonly columns: number;
}

export interface TuiLayout {
  readonly rows: number;
  readonly columns: number;
  /** Header rows before the top pane rule. */
  readonly headerRows: number;
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

/** One visible inventory row; informational rows have no Removal Target. */
export interface TuiEntry {
  readonly key: string;
  /** Read-only child rows provide context for a selectable parent boundary. */
  readonly rowKind?: "plugin-skill";
  /** Tree connector used when rendering a child beneath its Plugin. */
  readonly treeBranch?: "middle" | "last";
  readonly name: string;
  readonly description: string | null;
  readonly exposedTo: readonly string[];
  readonly paths: readonly string[];
  readonly owner: string;
  /** Supplemental row context, such as protection or a Plugin's harness. */
  readonly note: string | null;
  /** Detail-only notes keep hierarchical entry lists name-first. */
  readonly showNoteInRow?: boolean;
  readonly target: RemovalTarget | null;
  /**
   * Every Removal Target of a row that combines identical copies of one Skill.
   * The Inventory keeps the copies as separate records; `target` is the first.
   */
  readonly targets?: readonly RemovalTarget[];
  /** Physical Installations in this row that offer Add agent destinations. */
  readonly addAgentInstallations?: readonly Installation[];
  /** Targets used only by the Disabled/Availability workflow. */
  readonly availabilityTargets?: readonly AvailabilityTarget[];
  /** Overrides target-based selectability for non-removal projections. */
  readonly selectable?: boolean;
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

export type TuiBrowseView = "inventory" | "disabled" | "trash";

export interface TuiViewSnapshot {
  readonly inventory: Inventory;
  readonly model: TuiBrowseModel;
  readonly view?: TuiBrowseView;
  readonly operations?: ReadonlyMap<string, QuarantineOperation>;
  readonly disabledEntries?: readonly DisabledEntry[];
}

export interface TuiBrowseSnapshot extends TuiViewSnapshot {
  /** Independent browse state for peer tabs; values never contain snapshots. */
  readonly viewSnapshots?: Partial<Record<TuiBrowseView, TuiViewSnapshot>>;
}

export interface TuiLoadingState {
  readonly screen: "loading";
}

export interface TuiBrowseState extends TuiBrowseSnapshot {
  readonly screen: "browse";
  /** Inventory snapshot restored exactly when leaving the Trash projection. */
  readonly returnBrowse?: TuiBrowseSnapshot;
}

/** Trash screens retain the Inventory return state without depending on `screen`. */
export interface TuiTrashBrowseSnapshot extends TuiBrowseSnapshot {
  readonly returnBrowse?: TuiBrowseSnapshot;
}

export interface TuiTrashReviewState {
  readonly screen: "trash-review";
  /** Full Trash state retains the exact Inventory return snapshot. */
  readonly browse: TuiTrashBrowseSnapshot;
  readonly operation: QuarantineOperation;
  readonly kind: "restore" | "purge";
  readonly preview: RestoreOperationPreview | PurgeOperationPreview;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
  readonly message: string | null;
}
export interface TuiTrashExecutingState {
  readonly screen: "trash-executing";
  readonly browse: TuiTrashBrowseSnapshot;
  readonly operation: QuarantineOperation;
  readonly kind: "restore" | "purge";
}
export interface TuiTrashReportState {
  readonly screen: "trash-report";
  readonly browse: TuiTrashBrowseSnapshot;
  readonly operation: QuarantineOperation;
  readonly kind: "restore" | "purge";
  readonly result: RestoreOperationResult | PurgeOperationResult;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
}

/** A temporary, flat projection used only by the global search overlay. */
export interface TuiSearchResult {
  readonly entry: TuiEntry;
  /** The inventory section is the only available category projection in v1. */
  readonly category: string;
  readonly selectable: boolean;
  /** Already selected in browse; it remains visible but cannot be re-staged. */
  readonly existing: boolean;
}

export interface TuiSearchModel {
  readonly results: readonly TuiSearchResult[];
  readonly viewport: TuiViewport;
  readonly query: string;
  readonly matchError: string | null;
  readonly index: number;
  readonly scroll: number;
  /** Staging is local to the overlay until Enter applies it. */
  readonly staged: ReadonlySet<string>;
  readonly existing: ReadonlySet<string>;
  readonly notice: string | null;
}

export interface TuiSearchState {
  readonly screen: "search";
  /** The untouched browse position to restore on done or cancel. */
  readonly browse: TuiBrowseSnapshot;
  readonly model: TuiSearchModel;
}

export interface TuiAddAgentInstallationState {
  readonly screen: "add-agent-installation";
  readonly browse: TuiBrowseSnapshot;
  readonly installations: readonly Installation[];
  readonly index: number;
}

export interface TuiAddAgentState {
  readonly previous: TuiAddAgentInstallationState | null;
  readonly screen: "add-agent";
  readonly browse: TuiBrowseSnapshot;
  readonly installation: Installation;
  readonly agents: readonly string[];
  readonly installedAgents: readonly string[];
  readonly index: number;
  readonly query: string;
  readonly selectedAgents: ReadonlySet<string>;
  readonly plan: AddAgentBatchPlan | null;
  readonly report: AddAgentBatchReport | null;
  readonly executing: boolean;
  readonly scrollOffset: number;
}

export interface TuiThemeState {
  readonly screen: "theme";
  /** The untouched browse position to restore on apply or cancel. */
  readonly browse: TuiBrowseSnapshot;
  readonly choices: readonly TuiThemeChoice[];
  readonly index: number;
  readonly notice: string | null;
}

/** The key reference, drawn over the browse view it was opened from. */
export interface TuiHelpState {
  readonly screen: "help";
  readonly browse: TuiBrowseSnapshot;
}

export interface TuiPlanState {
  readonly screen: "plan";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: RemovalPlan;
  readonly label: string;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
  readonly returnReport: TuiReportState | null;
}

/** An approved removal is running; Execution provides only a final report. */
export interface TuiExecutingState {
  readonly screen: "executing";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: RemovalPlan;
  readonly label: string;
}

export interface TuiReportState {
  readonly screen: "report";
  readonly browse: TuiBrowseSnapshot;
  readonly report: ExecutionReport;
  readonly label: string;
  readonly fallbackCursor: number;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
}

export interface TuiAvailabilityPlanState {
  readonly screen: "availability-plan";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: AvailabilityPlan;
  readonly label: string;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
}

export interface TuiAvailabilityExecutingState {
  readonly screen: "availability-executing";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: AvailabilityPlan;
  readonly label: string;
}

export interface TuiAvailabilityReportState {
  readonly screen: "availability-report";
  readonly browse: TuiBrowseSnapshot;
  readonly report: AvailabilityReport;
  readonly label: string;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
}

export interface TuiUpdatePlanState {
  readonly screen: "update-plan";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: UpdatePlan;
  readonly label: string;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
}

export interface TuiUpdateExecutingState {
  readonly screen: "update-executing";
  readonly browse: TuiBrowseSnapshot;
  readonly plan: UpdatePlan;
  readonly label: string;
}

export interface TuiUpdateReportState {
  readonly screen: "update-report";
  readonly browse: TuiBrowseSnapshot;
  readonly report: UpdateReport;
  readonly label: string;
  readonly technicalDetails: boolean;
  readonly scrollOffset: number;
}

export interface TuiErrorState {
  readonly screen: "error";
  readonly message: string;
}

export interface TuiDoneState {
  readonly screen: "done";
  readonly report: ExecutionReport | AvailabilityReport | UpdateReport | null;
}

export type TuiState =
  | TuiLoadingState
  | TuiBrowseState
  | TuiSearchState
  | TuiAddAgentInstallationState
  | TuiAddAgentState
  | TuiThemeState
  | TuiHelpState
  | TuiPlanState
  | TuiExecutingState
  | TuiReportState
  | TuiAvailabilityPlanState
  | TuiAvailabilityExecutingState
  | TuiAvailabilityReportState
  | TuiUpdatePlanState
  | TuiUpdateExecutingState
  | TuiUpdateReportState
  | TuiTrashReviewState
  | TuiTrashExecutingState
  | TuiTrashReportState
  | TuiErrorState
  | TuiDoneState;

export type TuiAction =
  | { readonly kind: "noop" }
  | { readonly kind: "append-query"; readonly value: string }
  | { readonly kind: "delete-query" }
  | { readonly kind: "clear-query" }
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
  | { readonly kind: "point-search-result"; readonly index: number }
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
  | { readonly kind: "open-search"; readonly value?: string }
  | { readonly kind: "stage-all-search" }
  | { readonly kind: "apply-search" }
  | { readonly kind: "point-agent"; readonly index: number }
  | { readonly kind: "add-agent" }
  | { readonly kind: "open-theme-picker" }
  | { readonly kind: "open-help" }
  | { readonly kind: "toggle-details" }
  | { readonly kind: "select" }
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
  | { readonly kind: "force" }
  | { readonly kind: "fallback" }
  | { readonly kind: "select-fallback"; readonly delta: number }
  | { readonly kind: "switch-view"; readonly view: TuiBrowseView }
  | { readonly kind: "disable-review" }
  | { readonly kind: "enable-review" }
  | { readonly kind: "update-review" }
  | { readonly kind: "restore-review" }
  | { readonly kind: "purge-review" }
  | { readonly kind: "quit" };

export type TuiOutcome =
  | {
      readonly status: "completed";
      readonly report: ExecutionReport | AvailabilityReport | UpdateReport;
    }
  | {
      readonly status: "cancelled";
      readonly report:
        ExecutionReport | AvailabilityReport | UpdateReport | null;
    }
  | { readonly status: "failed"; readonly message: string };

export interface TuiTerminal {
  /** Optional: a terminal with no color support can ignore themes. */
  setTheme?(theme: TuiThemeDefinition): void;
  render(state: TuiState): void;
  readAction(state: TuiState): Promise<TuiAction>;
  close(): void;
}
