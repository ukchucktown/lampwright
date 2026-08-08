import { stringifyModel } from "../model/json.js";
import type {
  ApprovalRequirement,
  RemovalPlan,
  RemovalPlanIntent,
} from "../model/types.js";
import {
  createBrowseModel,
  currentEntry,
  reduceBrowse,
  type TuiBrowseCommand,
} from "./browse.js";
import { createTuiSections, selectionTargets } from "./sections.js";
import type {
  TuiAction,
  TuiBrowseState,
  TuiDependencies,
  TuiPlanState,
  TuiReportState,
  TuiState,
} from "./types.js";

export class TuiController {
  private stateValue: TuiState = { screen: "loading" };

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
      this.stateValue = {
        screen: "browse",
        inventory,
        model: createBrowseModel(createTuiSections(inventory), this.viewport),
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
      this.stateValue = resizeState(state, action.viewport);
      return;
    }
    try {
      if (state.screen === "browse") await this.browseAction(state, action);
      else if (state.screen === "plan") await this.planAction(state, action);
      else await this.reportAction(state, action);
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  private async browseAction(
    state: TuiBrowseState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "cancel") {
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
      if (model.focus === "entries") {
        this.stateValue = {
          ...state,
          model: reduceBrowse(model, { kind: "focus", pane: "sections" }),
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
      browse: { inventory: state.inventory, model: state.model },
      plan: this.dependencies.plan(state.inventory, {
        kind: "targets",
        targets,
        force: false,
        mode: "managed-first",
      }),
      label: planLabel(state, targets.length),
      returnReport: null,
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
      };
      return;
    }
    if (action.kind !== "confirm" || state.plan.blocks.length > 0) return;
    const report = await this.dependencies.execute(
      state.plan,
      approvalGrants(state.plan),
    );
    this.stateValue = {
      screen: "report",
      browse: state.browse,
      report,
      fallbackCursor: 0,
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
    if (action.kind === "move") {
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
      label: `Brute-force fallback ${state.fallbackCursor + 1}`,
      returnReport: state,
    };
  }

  private fail(error: unknown): void {
    this.stateValue = {
      screen: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resizeState(
  state: TuiBrowseState | TuiPlanState | TuiReportState,
  viewport: TuiBrowseState["model"]["viewport"],
): TuiBrowseState | TuiPlanState | TuiReportState {
  if (state.screen === "browse")
    return {
      ...state,
      model: reduceBrowse(state.model, { kind: "viewport", viewport }),
    };
  if (state.screen === "report")
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
    case "page":
      return { kind: "page", delta: action.delta };
    case "focus":
      return { kind: "focus", pane: action.pane };
    case "point-section":
      return { kind: "point-section", index: action.index };
    case "point-entry":
      return { kind: "point-entry", index: action.index };
    case "resize-panes":
      return { kind: "resize-panes", delta: action.delta };
    case "set-left-percent":
      return { kind: "set-left-percent", percent: action.percent };
    case "resize-detail":
      return { kind: "resize-detail", delta: action.delta };
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

function planLabel(state: TuiBrowseState, targets: number): string {
  if (state.model.selected.size === 0)
    return currentEntry(state.model)?.name ?? "selection";
  return `${String(targets)} target${targets === 1 ? "" : "s"}`;
}

function movedCursor(current: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}
