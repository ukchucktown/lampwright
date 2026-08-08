import { stringifyModel } from "../model/json.js";
import type {
  ApprovalRequirement,
  RemovalPlan,
  RemovalPlanIntent,
} from "../model/types.js";
import type {
  PurgeOperationPreview,
  QuarantineModule,
  QuarantineOperation,
  RestoreOperationPreview,
} from "../quarantine/types.js";
import {
  createBrowseModel,
  currentEntry,
  reduceBrowse,
  type TuiBrowseCommand,
} from "./browse.js";
import {
  planScrollMetrics,
  reportScrollMetrics,
  trashReportScrollMetrics,
  trashReviewScrollMetrics,
} from "./render.js";
import { createTuiSections, selectionTargets } from "./sections.js";
import { createTrashSections, type TrashRestoreReadiness } from "./trash.js";
import { createSearchModel, reduceSearch } from "./search.js";
import type {
  TuiAction,
  TuiBrowseState,
  TuiBrowseSnapshot,
  TuiDependencies,
  TuiExecutingState,
  TuiPlanState,
  TuiReportState,
  TuiTrashReviewState,
  TuiSearchState,
  TuiState,
} from "./types.js";

export class TuiController {
  private stateValue: TuiState = { screen: "loading" };
  private execution: Promise<void> | null = null;
  private trashExecution: Promise<void> | null = null;

  constructor(
    private readonly dependencies: TuiDependencies,
    private readonly viewport = { rows: 30, columns: 100 },
  ) {}

  get state(): TuiState {
    return this.stateValue;
  }

  async start(): Promise<void> {
    try {
      const inventory = await this.dependencies.scan();
      let operations: readonly QuarantineOperation[] | undefined;
      let notice: string | null = null;
      if (this.dependencies.quarantine !== undefined) {
        try {
          operations = await this.dependencies.quarantine.listOperations();
        } catch {
          notice = "Trash is unavailable until its local state is repaired.";
        }
      }
      this.stateValue = {
        screen: "browse",
        inventory,
        model: {
          ...createBrowseModel(createTuiSections(inventory), this.viewport),
          notice,
        },
        view: "inventory",
        ...(operations === undefined
          ? {}
          : {
              operations: new Map(
                operations.map((operation) => [
                  `trash-operation:${operation.id}`,
                  operation,
                ]),
              ),
            }),
      };
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  async dispatch(action: TuiAction): Promise<void> {
    const state = this.stateValue;
    if (state.screen === "loading" || state.screen === "done") return;
    if (state.screen === "error") {
      if (action.kind === "quit" || action.kind === "cancel")
        this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "viewport") {
      if (
        state.screen === "trash-review" ||
        state.screen === "trash-report" ||
        state.screen === "trash-executing"
      ) {
        const resized = {
          ...state,
          browse: resizeBrowse(state.browse, action.viewport),
        };
        if (resized.screen === "trash-review") {
          this.stateValue = {
            ...resized,
            scrollOffset: Math.min(
              resized.scrollOffset,
              trashReviewScrollMetrics(resized).maximumOffset,
            ),
          };
        } else if (resized.screen === "trash-report") {
          this.stateValue = {
            ...resized,
            scrollOffset: Math.min(
              resized.scrollOffset,
              trashReportScrollMetrics(resized).maximumOffset,
            ),
          };
        } else this.stateValue = resized;
        return;
      }
      this.stateValue = resizeState(state, action.viewport);
      return;
    }
    if (state.screen === "executing" || state.screen === "trash-executing")
      return;
    try {
      if (state.screen === "browse") await this.browseAction(state, action);
      else if (state.screen === "search") this.searchAction(state, action);
      else if (state.screen === "plan") await this.planAction(state, action);
      else if (state.screen === "trash-review")
        await this.trashReviewAction(state, action);
      else if (state.screen === "trash-report")
        await this.trashReportAction(state, action);
      else await this.reportAction(state, action);
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  /** Waits for the one final Execution report after its feedback frame draws. */
  async waitForExecution(): Promise<void> {
    if (this.execution === null && this.stateValue.screen === "executing") {
      const state = this.stateValue;
      this.execution = Promise.resolve()
        .then(() =>
          this.dependencies.execute(state.plan, approvalGrants(state.plan)),
        )
        .then((report) => {
          this.stateValue = {
            screen: "report",
            browse: state.browse,
            report,
            label: state.label,
            fallbackCursor: 0,
            technicalDetails: false,
            scrollOffset: 0,
          };
        })
        .catch((error: unknown) => {
          this.fail(error);
        });
    }
    await this.execution;
  }

  async waitForTrashExecution(): Promise<void> {
    if (
      this.trashExecution === null &&
      this.stateValue.screen === "trash-executing"
    ) {
      const state = this.stateValue;
      const quarantine = this.dependencies.quarantine;
      if (quarantine === undefined) return;
      this.trashExecution = (async () => {
        if (state.kind === "restore") {
          const result = await quarantine.restoreOperation(state.operation);
          this.stateValue = {
            screen: "trash-report",
            browse: state.browse,
            operation: state.operation,
            kind: state.kind,
            result,
            technicalDetails: false,
            scrollOffset: 0,
          };
          return;
        }
        const result = await quarantine.purgeOperation(state.operation);
        this.stateValue = {
          screen: "trash-report",
          browse: state.browse,
          operation: state.operation,
          kind: state.kind,
          result,
          technicalDetails: false,
          scrollOffset: 0,
        };
      })().catch((error: unknown) => this.fail(error));
    }
    await this.trashExecution;
  }

  private async browseAction(
    state: TuiBrowseState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "switch-view") {
      if (action.view === (state.view ?? "inventory")) return;
      if (action.view === "inventory") {
        if (state.view === "trash" && state.returnBrowse !== undefined) {
          this.stateValue = { screen: "browse", ...state.returnBrowse };
          return;
        }
        this.stateValue = {
          screen: "browse",
          inventory: state.inventory,
          model: createBrowseModel(
            createTuiSections(state.inventory),
            state.model.viewport,
          ),
          view: "inventory",
          ...(state.operations === undefined
            ? {}
            : { operations: state.operations }),
        };
      } else await this.openTrash(state);
      return;
    }
    if (
      state.view === "trash" &&
      (action.kind === "open-search" ||
        action.kind === "append-query" ||
        action.kind === "delete-query" ||
        action.kind === "toggle-select" ||
        action.kind === "clear-selection" ||
        action.kind === "point-toggle")
    )
      return;
    if (
      state.view === "trash" &&
      (action.kind === "restore-review" ||
        action.kind === "purge-review" ||
        action.kind === "select" ||
        action.kind === "confirm")
    ) {
      const operation = state.operations?.get(
        currentEntry(state.model)?.key ?? "",
      );
      const quarantine = this.dependencies.quarantine;
      if (operation === undefined || quarantine === undefined) return;
      let preview: PurgeOperationPreview | RestoreOperationPreview;
      try {
        preview =
          action.kind === "purge-review"
            ? await previewOperationPurge(quarantine, operation)
            : await previewOperationRestore(quarantine, operation);
      } catch {
        this.stateValue = {
          ...state,
          model: {
            ...state.model,
            notice:
              "This Trash operation could not be previewed; no files were changed.",
          },
        };
        return;
      }
      this.stateValue = {
        screen: "trash-review",
        browse: state,
        operation,
        kind: action.kind === "purge-review" ? "purge" : "restore",
        preview,
        technicalDetails: false,
        scrollOffset: 0,
        message: null,
      };
      return;
    }
    if (action.kind === "cancel") {
      if (state.view === "trash") {
        this.stateValue =
          state.returnBrowse === undefined
            ? state
            : { screen: "browse", ...state.returnBrowse };
        return;
      }
      // Escape unwinds the narrowest thing first, and only leaves as a last
      // resort, so a stray keypress cannot discard a selection.
      const { model } = state;
      if (model.query !== "") {
        this.stateValue = {
          ...state,
          model: reduceBrowse(model, { kind: "clear-query" }),
        };
        return;
      }
      if (model.focus === "entries" || model.focus === "detail") {
        this.stateValue = {
          ...state,
          model: reduceBrowse(model, {
            kind: "focus",
            pane: model.focus === "detail" ? "entries" : "sections",
          }),
        };
        return;
      }
      if (model.selected.size > 0) {
        this.stateValue = {
          ...state,
          model: reduceBrowse(model, { kind: "clear-selection" }),
        };
        return;
      }
      this.stateValue = { screen: "done", report: null };
      return;
    }

    if (action.kind === "open-search" || action.kind === "append-query") {
      const value =
        action.kind === "append-query" ? action.value : (action.value ?? "");
      let model = createSearchModel(state.model);
      if (value !== "")
        model = reduceSearch(model, state.model.sections, {
          kind: "type",
          value,
        });
      this.stateValue = {
        screen: "search",
        browse: browseSnapshot(state),
        model,
      };
      return;
    }

    const command = browseCommand(action);
    if (command !== null) {
      this.stateValue = { ...state, model: reduceBrowse(state.model, command) };
      return;
    }

    if (action.kind !== "select" && action.kind !== "confirm") return;
    const targets = this.targetsFor(state);
    if (targets.length === 0) {
      this.stateValue = {
        ...state,
        model: { ...state.model, notice: "Nothing selected." },
      };
      return;
    }
    this.stateValue = {
      screen: "plan",
      browse: browseSnapshot(state),
      plan: this.dependencies.plan(state.inventory, {
        kind: "targets",
        targets,
        force: false,
        mode: "managed-first",
      }),
      label: planLabel(state),
      technicalDetails: false,
      scrollOffset: 0,
      returnReport: null,
    };
  }

  private searchAction(state: TuiSearchState, action: TuiAction): void {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "cancel") {
      this.stateValue = { screen: "browse", ...state.browse };
      return;
    }
    if (
      action.kind === "apply-search" ||
      action.kind === "select" ||
      action.kind === "confirm"
    ) {
      if (state.model.matchError !== null) {
        this.stateValue = {
          ...state,
          model: { ...state.model, notice: state.model.matchError },
        };
        return;
      }
      const selected = new Set(state.browse.model.selected);
      for (const key of state.model.staged) selected.add(key);
      this.stateValue = {
        screen: "browse",
        ...state.browse,
        model: { ...state.browse.model, selected, notice: null },
      };
      return;
    }
    const command = searchCommand(action);
    if (command === null) return;
    this.stateValue = {
      ...state,
      model: reduceSearch(state.model, state.browse.model.sections, command),
    };
  }

  /** An explicit selection, or the row under the cursor when there is none. */
  private targetsFor(state: TuiBrowseState) {
    const selected = selectionTargets(
      state.model.sections,
      state.model.selected,
    );
    if (selected.length > 0) return selected;
    const entry = currentEntry(state.model);
    return entry?.target === null || entry === null ? [] : [entry.target];
  }

  private async planAction(
    state: TuiPlanState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = {
        screen: "done",
        report: state.returnReport?.report ?? null,
      };
      return;
    }
    if (action.kind === "cancel") {
      this.stateValue = state.returnReport ?? {
        screen: "browse",
        ...state.browse,
      };
      return;
    }
    if (action.kind === "toggle-details") {
      this.stateValue = {
        ...state,
        technicalDetails: !state.technicalDetails,
        scrollOffset: 0,
      };
      return;
    }
    if (action.kind === "move" || action.kind === "page") {
      const metrics = planScrollMetrics(state);
      const distance =
        action.kind === "page" ? Math.max(1, metrics.pageRows) : 1;
      this.stateValue = {
        ...state,
        scrollOffset: Math.min(
          metrics.maximumOffset,
          Math.max(0, state.scrollOffset + action.delta * distance),
        ),
      };
      return;
    }
    if (action.kind === "force") {
      if (
        state.plan.blocks.length === 0 ||
        state.plan.blocks.some((block) => !block.overridable)
      )
        return;
      const intent: RemovalPlanIntent = {
        ...state.plan.intent,
        force: true,
      };
      this.stateValue = {
        ...state,
        plan: this.dependencies.plan(state.browse.inventory, intent),
        scrollOffset: 0,
      };
      return;
    }
    if (action.kind !== "confirm" || state.plan.blocks.length > 0) return;
    this.execution = null;
    this.stateValue = {
      screen: "executing",
      browse: state.browse,
      plan: state.plan,
      label: state.label,
    };
  }

  private async reportAction(
    state: TuiReportState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit" || action.kind === "cancel") {
      this.stateValue = { screen: "done", report: state.report };
      return;
    }
    if (action.kind === "toggle-details") {
      this.stateValue = {
        ...state,
        technicalDetails: !state.technicalDetails,
        scrollOffset: 0,
      };
      return;
    }
    if (action.kind === "move" || action.kind === "page") {
      const metrics = reportScrollMetrics(state);
      const distance =
        action.kind === "page" ? Math.max(1, metrics.pageRows) : 1;
      this.stateValue = {
        ...state,
        scrollOffset: Math.min(
          metrics.maximumOffset,
          Math.max(0, state.scrollOffset + action.delta * distance),
        ),
      };
      return;
    }
    if (action.kind === "select-fallback") {
      this.stateValue = {
        ...state,
        fallbackCursor: movedCursor(
          state.fallbackCursor,
          state.report.fallbackPlans.length,
          action.delta,
        ),
      };
      return;
    }
    if (action.kind !== "fallback") return;
    const fallbackPlan = state.report.fallbackPlans[state.fallbackCursor];
    if (fallbackPlan === undefined) return;
    this.stateValue = {
      screen: "plan",
      browse: state.browse,
      plan: fallbackPlan,
      label: browseSelectionLabel(state.browse.model),
      technicalDetails: false,
      scrollOffset: 0,
      returnReport: state,
    };
  }

  private async openTrash(state: TuiBrowseState): Promise<void> {
    const quarantine = this.dependencies.quarantine;
    if (quarantine === undefined) {
      this.stateValue = {
        ...state,
        model: { ...state.model, notice: "Trash is unavailable in this host." },
      };
      return;
    }
    let operations: readonly QuarantineOperation[];
    try {
      operations = await quarantine.listOperations();
    } catch {
      this.stateValue = {
        ...state,
        model: {
          ...state.model,
          notice: "Trash is unavailable until its local state is repaired.",
        },
      };
      return;
    }
    const previews = new Map<string, TrashRestoreReadiness>(
      await Promise.all(
        operations.map(async (operation) => {
          try {
            return [
              operation.id,
              await previewOperationRestore(quarantine, operation),
            ] as const;
          } catch {
            return [
              operation.id,
              {
                status: "preview-unavailable" as const,
                message:
                  "Restore preview could not inspect this Quarantine operation.",
              },
            ] as const;
          }
        }),
      ),
    );
    this.stateValue = {
      screen: "browse",
      inventory: state.inventory,
      model: createBrowseModel(
        createTrashSections(operations, previews, this.now()),
        state.model.viewport,
      ),
      view: "trash",
      operations: new Map(
        operations.map((operation) => [
          `trash-operation:${operation.id}`,
          operation,
        ]),
      ),
      ...((state.view === "trash" ? state.returnBrowse : undefined) ===
      undefined
        ? {
            returnBrowse: {
              inventory: state.inventory,
              model: state.model,
              view: "inventory" as const,
              ...(state.operations === undefined
                ? {}
                : { operations: state.operations }),
            },
          }
        : { returnBrowse: state.returnBrowse! }),
    };
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private async trashReviewAction(
    state: TuiTrashReviewState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "cancel") {
      this.stateValue = { screen: "browse", ...state.browse };
      return;
    }
    if (action.kind === "toggle-details") {
      this.stateValue = {
        ...state,
        technicalDetails: !state.technicalDetails,
        scrollOffset: 0,
      };
      return;
    }
    if (action.kind === "move" || action.kind === "page") {
      const metrics = trashReviewScrollMetrics(state);
      const distance =
        action.kind === "page" ? Math.max(1, metrics.pageRows) : 1;
      this.stateValue = {
        ...state,
        scrollOffset: Math.min(
          metrics.maximumOffset,
          Math.max(0, state.scrollOffset + action.delta * distance),
        ),
      };
      return;
    }
    if (action.kind !== "confirm") return;
    const quarantine = this.dependencies.quarantine;
    if (quarantine === undefined) return;
    if (
      state.kind === "restore" &&
      (state.preview as RestoreOperationPreview).status === "blocked"
    ) {
      this.stateValue = {
        ...state,
        message: "Restore remains blocked; no items were changed.",
      };
      return;
    }
    this.trashExecution = null;
    this.stateValue = {
      screen: "trash-executing",
      browse: state.browse,
      operation: state.operation,
      kind: state.kind,
    };
  }

  private async trashReportAction(
    state: import("./types.js").TuiTrashReportState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "cancel") {
      await this.openTrash({ screen: "browse", ...state.browse });
      return;
    }
    if (action.kind === "toggle-details") {
      this.stateValue = {
        ...state,
        technicalDetails: !state.technicalDetails,
        scrollOffset: 0,
      };
      return;
    }
    if (action.kind === "move" || action.kind === "page") {
      const metrics = trashReportScrollMetrics(state);
      const distance =
        action.kind === "page" ? Math.max(1, metrics.pageRows) : 1;
      this.stateValue = {
        ...state,
        scrollOffset: Math.min(
          metrics.maximumOffset,
          Math.max(0, state.scrollOffset + action.delta * distance),
        ),
      };
    }
  }

  private fail(error: unknown): void {
    this.stateValue = {
      screen: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function browseSnapshot(state: TuiBrowseState): TuiBrowseSnapshot {
  return {
    inventory: state.inventory,
    model: state.model,
    ...(state.view === undefined ? {} : { view: state.view }),
    ...(state.operations === undefined ? {} : { operations: state.operations }),
  };
}

async function previewOperationRestore(
  quarantine: QuarantineModule,
  operation: QuarantineOperation,
): Promise<RestoreOperationPreview> {
  return quarantine.previewRestoreOperation(operation);
}

async function previewOperationPurge(
  quarantine: QuarantineModule,
  operation: QuarantineOperation,
): Promise<PurgeOperationPreview> {
  return quarantine.previewPurgeOperation(operation);
}

function resizeState(
  state:
    | TuiBrowseState
    | TuiSearchState
    | TuiPlanState
    | TuiExecutingState
    | TuiReportState,
  viewport: TuiBrowseState["model"]["viewport"],
):
  | TuiBrowseState
  | TuiSearchState
  | TuiPlanState
  | TuiExecutingState
  | TuiReportState {
  if (state.screen === "browse")
    return {
      ...state,
      model: reduceBrowse(state.model, { kind: "viewport", viewport }),
    };
  if (state.screen === "search")
    return {
      ...state,
      browse: resizeBrowse(state.browse, viewport),
      model: reduceSearch(state.model, state.browse.model.sections, {
        kind: "viewport",
        viewport,
      }),
    };
  if (state.screen === "report") {
    const resized = { ...state, browse: resizeBrowse(state.browse, viewport) };
    return {
      ...resized,
      scrollOffset: Math.min(
        resized.scrollOffset,
        reportScrollMetrics(resized).maximumOffset,
      ),
    };
  }
  if (state.screen === "executing")
    return { ...state, browse: resizeBrowse(state.browse, viewport) };
  return {
    ...state,
    browse: resizeBrowse(state.browse, viewport),
    returnReport:
      state.returnReport === null
        ? null
        : {
            ...state.returnReport,
            browse: resizeBrowse(state.returnReport.browse, viewport),
          },
  };
}

function searchCommand(action: TuiAction) {
  switch (action.kind) {
    case "append-query":
      return { kind: "type", value: action.value } as const;
    case "delete-query":
      return { kind: "backspace" } as const;
    case "clear-selection":
      return { kind: "clear" } as const;
    case "move":
      return { kind: "move", delta: action.delta } as const;
    case "page":
      return { kind: "page", delta: action.delta } as const;
    case "toggle-select":
      return { kind: "toggle" } as const;
    case "point-search-result":
      return { kind: "focus", index: action.index } as const;
    case "point-toggle":
      return action.pane === "entries"
        ? ({ kind: "toggle-at", index: action.index } as const)
        : null;
    case "stage-all-search":
      return { kind: "stage-all" } as const;
    case "viewport":
      return { kind: "viewport", viewport: action.viewport } as const;
    default:
      return null;
  }
}

function resizeBrowse(
  browse: TuiPlanState["browse"],
  viewport: TuiBrowseState["model"]["viewport"],
): TuiPlanState["browse"] {
  return {
    ...browse,
    model: reduceBrowse(browse.model, { kind: "viewport", viewport }),
  };
}

export function approvalGrants(
  removalPlan: RemovalPlan,
): readonly ApprovalRequirement[] {
  return removalPlan.actions
    .flatMap((action) => action.approvals)
    .filter((approval) => approval.kind !== "adapter-trust")
    .filter(
      (approval, index, approvals) =>
        approvals.findIndex(
          (candidate) =>
            stringifyModel(candidate, 0) === stringifyModel(approval, 0),
        ) === index,
    );
}

/** Actions the pure browse model owns; everything else is a screen change. */
function browseCommand(action: TuiAction): TuiBrowseCommand | null {
  switch (action.kind) {
    case "append-query":
      return { kind: "type", value: action.value };
    case "delete-query":
      return { kind: "backspace" };
    case "move":
      return { kind: "move", delta: action.delta };
    case "move-pane":
      return {
        kind: "move-pane",
        pane: action.pane,
        delta: action.delta,
      };
    case "page":
      return { kind: "page", delta: action.delta };
    case "focus":
      return { kind: "focus", pane: action.pane };
    case "point-section":
      return { kind: "point-section", index: action.index };
    case "point-entry":
      return { kind: "point-entry", index: action.index };
    case "point-toggle":
      return {
        kind: "point-toggle",
        pane: action.pane,
        index: action.index,
      };
    case "resize-panes":
      return { kind: "resize-panes", delta: action.delta };
    case "set-left-percent":
      return { kind: "set-left-percent", percent: action.percent };
    case "resize-detail":
      return { kind: "resize-detail", delta: action.delta };
    case "set-detail-rows":
      return { kind: "set-detail-rows", rows: action.rows };
    case "viewport":
      return { kind: "viewport", viewport: action.viewport };
    case "toggle-select":
      return { kind: "toggle-select" };
    case "clear-selection":
      return { kind: "clear-selection" };
    default:
      return null;
  }
}

function planLabel(state: TuiBrowseState): string {
  if (state.model.selected.size === 0)
    return currentEntry(state.model)?.name ?? "selected capability";
  return browseSelectionLabel(state.model);
}

function browseSelectionLabel(model: TuiBrowseState["model"]): string {
  if (model.selected.size === 0)
    return currentEntry(model)?.name ?? "selected capability";
  if (model.selected.size === 1) {
    const key = model.selected.values().next().value;
    return (
      model.sections
        .flatMap((section) => section.entries)
        .find((entry) => entry.key === key)?.name ?? "selected capability"
    );
  }
  return `${String(model.selected.size)} selected capabilities`;
}

function movedCursor(current: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}
