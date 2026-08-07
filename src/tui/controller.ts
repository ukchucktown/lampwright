import { stringifyModel } from "../model/json.js";
import type {
  ApprovalRequirement,
  RemovalPlan,
  RemovalPlanIntent,
} from "../model/types.js";
import { createTuiCatalog, visibleTuiRows } from "./catalog.js";
import type {
  TuiAction,
  TuiBrowseSnapshot,
  TuiBrowseState,
  TuiDependencies,
  TuiPlanState,
  TuiReportState,
  TuiState,
} from "./types.js";

export class TuiController {
  private stateValue: TuiState = { screen: "loading" };
  private catalog: ReturnType<typeof createTuiCatalog> = [];

  constructor(private readonly dependencies: TuiDependencies) {}

  get state(): TuiState {
    return this.stateValue;
  }

  async start(): Promise<void> {
    try {
      const inventory = await this.dependencies.scan();
      this.catalog = createTuiCatalog(inventory);
      this.stateValue = {
        screen: "browse",
        ...this.createBrowse(inventory, "", new Set(), 0),
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
    if (action.kind === "quit" || action.kind === "cancel") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "move") {
      this.stateValue = {
        ...state,
        cursor: movedCursor(state.cursor, state.rows.length, action.delta),
      };
      return;
    }
    if (
      action.kind === "set-query" ||
      action.kind === "append-query" ||
      action.kind === "delete-query"
    ) {
      const query = updatedQuery(state.query, action);
      const selectedKey = state.rows[state.cursor]?.key;
      const next = this.createBrowse(
        state.inventory,
        query,
        state.expandedKeys,
        0,
      );
      const preserved = next.rows.findIndex((row) => row.key === selectedKey);
      this.stateValue = {
        screen: "browse",
        ...next,
        cursor: preserved >= 0 ? preserved : 0,
      };
      return;
    }
    const selected = state.rows[state.cursor];
    if (selected === undefined) return;
    if (action.kind === "toggle-expand") {
      if (selected.childCount === 0 || selected.depth !== 0) return;
      const expanded = new Set(state.expandedKeys);
      if (expanded.has(selected.key)) expanded.delete(selected.key);
      else expanded.add(selected.key);
      const next = this.createBrowse(
        state.inventory,
        state.query,
        expanded,
        state.cursor,
      );
      this.stateValue = { screen: "browse", ...next };
      return;
    }
    if (action.kind === "select" && selected.target !== null) {
      const removalPlan = this.dependencies.plan(state.inventory, {
        kind: "targets",
        targets: [selected.target],
        force: false,
        mode: "managed-first",
      });
      this.stateValue = {
        screen: "plan",
        browse: snapshot(state),
        plan: removalPlan,
        label: selected.name,
        returnReport: null,
      };
    }
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

  private createBrowse(
    inventory: TuiBrowseSnapshot["inventory"],
    query: string,
    expandedKeys: ReadonlySet<string>,
    cursor: number,
  ): TuiBrowseSnapshot {
    const rows = visibleTuiRows(this.catalog, expandedKeys, query);
    return {
      inventory,
      query,
      expandedKeys,
      rows,
      cursor: clampCursor(cursor, rows.length),
    };
  }

  private fail(error: unknown): void {
    this.stateValue = {
      screen: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
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

function snapshot(state: TuiBrowseState): TuiBrowseSnapshot {
  return {
    inventory: state.inventory,
    query: state.query,
    expandedKeys: state.expandedKeys,
    rows: state.rows,
    cursor: state.cursor,
  };
}

function updatedQuery(
  query: string,
  action: Extract<
    TuiAction,
    { kind: "set-query" | "append-query" | "delete-query" }
  >,
): string {
  if (action.kind === "set-query") return action.value;
  if (action.kind === "append-query") return `${query}${action.value}`;
  return Array.from(query).slice(0, -1).join("");
}

function movedCursor(current: number, length: number, delta: -1 | 1): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}

function clampCursor(cursor: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(cursor, 0), length - 1);
}
