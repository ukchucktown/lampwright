import { stringifyModel } from "../model/json.js";
import type {
  AvailabilityPlan,
  AvailabilityTarget,
} from "../availability/types.js";
import type {
  ApprovalRequirement,
  Inventory,
  RemovalPlan,
  RemovalPlanIntent,
} from "../model/types.js";
import type { UpdateTarget } from "../update/types.js";
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
  availabilityPlanScrollMetrics,
  availabilityReportScrollMetrics,
  planScrollMetrics,
  reportScrollMetrics,
  trashReportScrollMetrics,
  trashReviewScrollMetrics,
  updatePlanScrollMetrics,
  updateReportScrollMetrics,
} from "./render.js";
import {
  createDisabledSections,
  disabledSelectionTargets,
} from "./disabled.js";
import { createTuiSections, selectionTargets } from "./sections.js";
import { createTrashSections, type TrashRestoreReadiness } from "./trash.js";
import { createSearchModel, reduceSearch } from "./search.js";
import { createSetupSections, selectedSetupTargetIds } from "./setup.js";
import type {
  TuiAction,
  TuiAvailabilityPlanState,
  TuiAvailabilityReportState,
  TuiBrowseState,
  TuiBrowseSnapshot,
  TuiDependencies,
  TuiExecutingState,
  TuiPlanState,
  TuiReportState,
  TuiUpdatePlanState,
  TuiUpdateReportState,
  TuiTrashReviewState,
  TuiSearchState,
  TuiState,
  TuiViewSnapshot,
} from "./types.js";

export class TuiController {
  private stateValue: TuiState = { screen: "loading" };
  private execution: Promise<void> | null = null;
  private trashExecution: Promise<void> | null = null;
  private availabilityExecution: Promise<void> | null = null;
  private updateExecution: Promise<void> | null = null;
  private setupExecution: Promise<void> | null = null;

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
      let disabledEntries =
        [] as readonly import("../disabled-storage/types.js").DisabledEntry[];
      let notice: string | null = null;
      if (this.dependencies.quarantine !== undefined) {
        try {
          operations = await this.dependencies.quarantine.listOperations();
        } catch {
          notice = "Trash is unavailable until its local state is repaired.";
        }
      }
      if (this.dependencies.listDisabled !== undefined) {
        try {
          disabledEntries = await this.dependencies.listDisabled();
        } catch {
          notice =
            "Disabled Storage is unavailable until its local state is repaired.";
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
        disabledEntries,
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
        state.screen === "trash-executing" ||
        state.screen === "availability-executing" ||
        state.screen === "update-executing"
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
    if (
      state.screen === "executing" ||
      state.screen === "trash-executing" ||
      state.screen === "update-executing"
    )
      return;
    try {
      if (state.screen === "browse") await this.browseAction(state, action);
      else if (state.screen === "search") this.searchAction(state, action);
      else if (state.screen === "plan") await this.planAction(state, action);
      else if (state.screen === "availability-plan")
        await this.availabilityPlanAction(state, action);
      else if (state.screen === "availability-report")
        await this.availabilityReportAction(state, action);
      else if (state.screen === "update-plan")
        await this.updatePlanAction(state, action);
      else if (state.screen === "update-report")
        await this.updateReportAction(state, action);
      else if (state.screen === "setup-plan")
        await this.setupPlanAction(state, action);
      else if (state.screen === "setup-report")
        await this.setupReportAction(state, action);
      else if (state.screen === "trash-review")
        await this.trashReviewAction(state, action);
      else if (state.screen === "trash-report")
        await this.trashReportAction(state, action);
      else if (state.screen === "report")
        await this.reportAction(state, action);
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

  async waitForAvailabilityExecution(): Promise<void> {
    if (
      this.availabilityExecution === null &&
      this.stateValue.screen === "availability-executing"
    ) {
      const state = this.stateValue;
      const execute = this.dependencies.executeAvailability;
      if (execute === undefined) return;
      this.availabilityExecution = execute(
        state.plan,
        availabilityApprovalGrants(state.plan),
      )
        .then((report) => {
          this.stateValue = {
            screen: "availability-report",
            browse: state.browse,
            report,
            label: state.label,
            technicalDetails: false,
            scrollOffset: 0,
          };
        })
        .catch((error: unknown) => this.fail(error));
    }
    await this.availabilityExecution;
  }

  async waitForUpdateExecution(): Promise<void> {
    if (
      this.updateExecution === null &&
      this.stateValue.screen === "update-executing"
    ) {
      const state = this.stateValue;
      const execute = this.dependencies.executeUpdate;
      if (execute === undefined) return;
      this.updateExecution = execute(
        state.plan,
        updateApprovalGrants(state.plan),
      )
        .then((report) => {
          this.stateValue = {
            screen: "update-report",
            browse: state.browse,
            report,
            label: state.label,
            technicalDetails: false,
            scrollOffset: 0,
          };
        })
        .catch((error: unknown) => this.fail(error));
    }
    await this.updateExecution;
  }

  async waitForSetupExecution(): Promise<void> {
    if (
      this.setupExecution === null &&
      this.stateValue.screen === "setup-executing"
    ) {
      const state = this.stateValue;
      const execute = this.dependencies.executeSessionSetup;
      if (execute === undefined) return;
      this.setupExecution = execute(state.plan, {
        grants: state.plan.actions.flatMap((action) => action.approvals),
      })
        .then((report) => {
          this.stateValue = {
            screen: "setup-report",
            browse: state.browse,
            report,
            technicalDetails: false,
            scrollOffset: 0,
          };
        })
        .catch((error: unknown) => this.fail(error));
    }
    await this.setupExecution;
  }

  private async browseAction(
    state: TuiBrowseState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "switch-area") {
      await this.openArea(state, action.area);
      return;
    }
    if (state.area === "setup") {
      await this.setupBrowseAction(state, action);
      return;
    }
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: null };
      return;
    }
    if (action.kind === "switch-view") {
      if (action.view === (state.view ?? "inventory")) return;
      await this.openView(state, action.view);
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
      if (state.view === "disabled") {
        await this.openView(state, "inventory");
        return;
      }
      if (state.view === "trash") {
        await this.openView(state, "inventory");
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
        scope: state.model.sections,
      };
      return;
    }

    if (action.kind === "select-all") {
      const section = state.model.sections[state.model.sectionIndex];
      const selected = new Set(state.model.selected);
      for (const entry of section?.entries ?? [])
        if (entry.selectable) selected.add(entry.key);
      this.stateValue = { ...state, model: { ...state.model, selected } };
      return;
    }
    const command = browseCommand(action);
    if (command !== null) {
      const model = reduceBrowse(state.model, command);
      this.stateValue = {
        ...state,
        model:
          state.view === "disabled" &&
          model.notice?.endsWith(" cannot be removed here.") === true
            ? {
                ...model,
                notice: model.notice.replace(
                  " cannot be removed here.",
                  " cannot be enabled here.",
                ),
              }
            : model,
      };
      return;
    }

    if (
      action.kind === "disable-review" &&
      (state.view ?? "inventory") === "inventory"
    ) {
      await this.openAvailabilityReview(state, "disable");
      return;
    }
    if (action.kind === "enable-review" && state.view === "disabled") {
      await this.openAvailabilityReview(state, "enable");
      return;
    }
    if (
      action.kind === "update-review" &&
      ((state.view ?? "inventory") === "inventory" || state.view === "disabled")
    ) {
      this.openUpdateReview(state);
      return;
    }
    if (state.view !== "inventory") return;
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

  private openUpdateReview(state: TuiBrowseState): void {
    const planner = this.dependencies.planUpdate;
    if (planner === undefined) {
      this.stateValue = {
        ...state,
        model: {
          ...state.model,
          notice: "Update is unavailable in this host.",
        },
      };
      return;
    }
    const resolved = updateSelection(state);
    if (resolved.target === null) {
      this.stateValue = {
        ...state,
        model: { ...state.model, notice: resolved.notice },
      };
      return;
    }
    this.stateValue = {
      screen: "update-plan",
      browse: browseSnapshot(state),
      plan: planner(state.inventory, {
        target: resolved.target,
        force: false,
      }),
      label: updateTargetLabel(state.inventory, resolved.target),
      technicalDetails: false,
      scrollOffset: 0,
    };
  }

  private async openAvailabilityReview(
    state: TuiBrowseState,
    operation: "disable" | "enable",
  ): Promise<void> {
    const planner = this.dependencies.planAvailability;
    if (planner === undefined) {
      this.stateValue = {
        ...state,
        model: {
          ...state.model,
          notice: "Availability is unavailable in this host.",
        },
      };
      return;
    }
    const targets = this.availabilityTargetsFor(state, operation);
    if (targets.length === 0) {
      this.stateValue = {
        ...state,
        model: { ...state.model, notice: "Nothing eligible is selected." },
      };
      return;
    }
    const plan = planner(state.inventory, state.disabledEntries ?? [], {
      operation,
      targets,
      force: false,
    });
    this.stateValue = {
      screen: "availability-plan",
      browse: browseSnapshot(state),
      plan,
      label: planLabel(state),
      technicalDetails: false,
      scrollOffset: 0,
    };
  }

  private availabilityTargetsFor(
    state: TuiBrowseState,
    operation: "disable" | "enable",
  ): readonly AvailabilityTarget[] {
    if (operation === "enable") {
      const selected = disabledSelectionTargets(
        state.model.sections,
        state.model.selected,
      );
      if (selected.length > 0) return selected;
      return currentEntry(state.model)?.availabilityTargets ?? [];
    }
    return this.targetsFor(state).map((target): AvailabilityTarget => {
      switch (target.kind) {
        case "installation":
          return target;
        case "logical-skill":
          return target;
        case "source-group":
          return target;
        case "plugin":
          return target;
      }
    });
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
      model: reduceSearch(
        state.model,
        state.scope ?? state.browse.model.sections,
        command,
      ),
    };
  }

  private async refreshAfterAvailability(
    state: TuiAvailabilityReportState,
  ): Promise<void> {
    try {
      const inventory = await this.dependencies.scan();
      const disabledEntries =
        this.dependencies.listDisabled === undefined
          ? []
          : await this.dependencies.listDisabled();
      const oldSnapshots = state.browse.viewSnapshots ?? {};
      const inventoryOld =
        state.browse.view === "inventory"
          ? state.browse
          : oldSnapshots.inventory;
      const disabledOld =
        state.browse.view === "disabled" ? state.browse : oldSnapshots.disabled;
      const inventorySnapshot: TuiViewSnapshot = {
        inventory,
        model: preserveBrowseModel(
          inventoryOld?.model ?? state.browse.model,
          createTuiSections(inventory),
        ),
        view: "inventory",
        disabledEntries,
        ...(state.browse.operations === undefined
          ? {}
          : { operations: state.browse.operations }),
      };
      const disabledSnapshot: TuiViewSnapshot = {
        inventory,
        model: preserveBrowseModel(
          disabledOld?.model ?? state.browse.model,
          createDisabledSections(inventory, disabledEntries),
        ),
        view: "disabled",
        disabledEntries,
        ...(state.browse.operations === undefined
          ? {}
          : { operations: state.browse.operations }),
      };
      const viewSnapshots = {
        ...Object.fromEntries(
          Object.entries(oldSnapshots).map(([view, snapshot]) => [
            view,
            snapshot === undefined ? snapshot : { ...snapshot, inventory },
          ]),
        ),
        inventory: inventorySnapshot,
        disabled: disabledSnapshot,
      };
      const active =
        state.browse.view === "disabled" ? disabledSnapshot : inventorySnapshot;
      this.stateValue = { screen: "browse", ...active, viewSnapshots };
    } catch {
      // A successful mutation must never lead back to a stale live projection.
      this.stateValue = { screen: "done", report: state.report };
    }
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

  private async availabilityPlanAction(
    state: TuiAvailabilityPlanState,
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
      const metrics = availabilityPlanScrollMetrics(state);
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
        state.plan.intent.operation !== "disable" ||
        state.plan.blocks.length === 0 ||
        state.plan.blocks.some((block) => !block.overridable) ||
        this.dependencies.planAvailability === undefined
      )
        return;
      this.stateValue = {
        ...state,
        plan: this.dependencies.planAvailability(
          state.browse.inventory,
          state.browse.disabledEntries ?? [],
          { ...state.plan.intent, force: true },
        ),
        scrollOffset: 0,
      };
      return;
    }
    if (
      action.kind !== "confirm" ||
      state.plan.blocks.length > 0 ||
      this.dependencies.executeAvailability === undefined
    )
      return;
    this.availabilityExecution = null;
    this.stateValue = {
      screen: "availability-executing",
      browse: state.browse,
      plan: state.plan,
      label: state.label,
    };
  }

  private async availabilityReportAction(
    state: TuiAvailabilityReportState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: state.report };
      return;
    }
    if (action.kind === "cancel") {
      await this.refreshAfterAvailability(state);
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
      const metrics = availabilityReportScrollMetrics(state);
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

  private async updatePlanAction(
    state: TuiUpdatePlanState,
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
      const metrics = updatePlanScrollMetrics(state);
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
    if (
      action.kind !== "confirm" ||
      state.plan.blocks.length > 0 ||
      this.dependencies.executeUpdate === undefined
    )
      return;
    this.updateExecution = null;
    this.stateValue = {
      screen: "update-executing",
      browse: state.browse,
      plan: state.plan,
      label: state.label,
    };
  }

  private async updateReportAction(
    state: TuiUpdateReportState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: state.report };
      return;
    }
    if (action.kind === "cancel") {
      await this.refreshAfterUpdate(state);
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
      const metrics = updateReportScrollMetrics(state);
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

  private async refreshAfterUpdate(state: TuiUpdateReportState): Promise<void> {
    try {
      const inventory = await this.dependencies.scan();
      const disabledEntries =
        this.dependencies.listDisabled === undefined
          ? []
          : await this.dependencies.listDisabled();
      const inventorySnapshot: TuiViewSnapshot = {
        inventory,
        model: {
          ...createBrowseModel(
            createTuiSections(inventory),
            state.browse.model.viewport,
          ),
          notice: null,
        },
        view: "inventory",
        disabledEntries,
        ...(state.browse.operations === undefined
          ? {}
          : { operations: state.browse.operations }),
      };
      this.stateValue = {
        screen: "browse",
        ...inventorySnapshot,
      };
    } catch {
      this.stateValue = { screen: "done", report: state.report };
    }
  }

  private async openView(
    state: TuiBrowseState,
    view: import("./types.js").TuiBrowseView,
  ): Promise<void> {
    const snapshots = {
      ...(state.viewSnapshots ?? {}),
      [state.view ?? "inventory"]: viewSnapshot(state),
    };
    const existing = snapshots[view];
    if (existing !== undefined) {
      this.stateValue = {
        screen: "browse",
        ...existing,
        viewSnapshots: snapshots,
      };
      return;
    }
    if (view === "trash") {
      await this.openTrash({ ...state, viewSnapshots: snapshots });
      return;
    }
    const entries = state.disabledEntries ?? [];
    this.stateValue = {
      screen: "browse",
      inventory: state.inventory,
      model: createBrowseModel(
        view === "disabled"
          ? createDisabledSections(state.inventory, entries)
          : createTuiSections(state.inventory),
        state.model.viewport,
      ),
      view,
      disabledEntries: entries,
      ...(state.operations === undefined
        ? {}
        : { operations: state.operations }),
      viewSnapshots: snapshots,
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

  private async openArea(
    state: TuiBrowseState,
    area: "skills" | "setup",
  ): Promise<void> {
    if (area === (state.area ?? "skills")) return;
    const saved = {
      ...(state.areaSnapshots ?? {}),
      [state.area ?? "skills"]: browseSnapshot(state),
    };
    if (saved[area] !== undefined) {
      this.stateValue = {
        screen: "browse",
        ...saved[area],
        areaSnapshots: saved,
      };
      return;
    }
    if (area === "setup") {
      let setupInventory:
        import("../session-setup/types.js").SessionSetupSnapshot | undefined;
      try {
        setupInventory =
          this.dependencies.scanSessionSetup === undefined
            ? undefined
            : await this.dependencies.scanSessionSetup();
      } catch {
        this.stateValue = {
          ...state,
          model: {
            ...state.model,
            notice:
              "Session setup sources are unavailable; no setup state was changed.",
          },
        };
        return;
      }
      if (setupInventory === undefined) {
        this.stateValue = {
          ...state,
          model: {
            ...state.model,
            notice: "Session setup is unavailable in this host.",
          },
        };
        return;
      }
      this.stateValue = {
        screen: "browse",
        inventory: state.inventory,
        setupInventory,
        area: "setup",
        view: "inventory",
        model: createBrowseModel(
          createSetupSections(setupInventory, "inventory"),
          state.model.viewport,
        ),
        areaSnapshots: saved,
      };
      return;
    }
    this.stateValue = {
      screen: "browse",
      inventory: state.inventory,
      area: "skills",
      view: "inventory",
      model: createBrowseModel(
        createTuiSections(state.inventory),
        state.model.viewport,
      ),
      areaSnapshots: saved,
    };
  }

  private async setupBrowseAction(
    state: TuiBrowseState,
    action: TuiAction,
  ): Promise<void> {
    const snapshot = state.setupInventory;
    if (snapshot === undefined) return;
    if (action.kind === "switch-view") {
      const view = action.view === "disabled" ? "disabled" : "inventory";
      if (view === state.view) return;
      const snapshots = {
        ...(state.viewSnapshots ?? {}),
        [state.view ?? "inventory"]: viewSnapshot(state),
      };
      const saved = snapshots[view];
      this.stateValue =
        saved === undefined
          ? {
              ...state,
              view,
              model: createBrowseModel(
                createSetupSections(snapshot, view),
                state.model.viewport,
              ),
              viewSnapshots: snapshots,
            }
          : {
              screen: "browse",
              ...saved,
              area: "setup",
              setupInventory: snapshot,
              viewSnapshots: snapshots,
              ...(state.areaSnapshots === undefined
                ? {}
                : { areaSnapshots: state.areaSnapshots }),
            };
      return;
    }
    if (action.kind === "open-search" || action.kind === "append-query") {
      const focused = state.model.sections[state.model.sectionIndex];
      const searchBrowse =
        focused === undefined
          ? state.model
          : { ...state.model, sections: [focused] };
      let model = createSearchModel(searchBrowse);
      const value =
        action.kind === "append-query" ? action.value : (action.value ?? "");
      if (value)
        model = reduceSearch(model, searchBrowse.sections, {
          kind: "type",
          value,
        });
      this.stateValue = {
        screen: "search",
        browse: browseSnapshot(state),
        model,
        scope: searchBrowse.sections,
      };
      return;
    }
    if (action.kind === "select-all") {
      const section = state.model.sections[state.model.sectionIndex];
      const selected = new Set(state.model.selected);
      for (const entry of section?.entries ?? [])
        if (entry.selectable) selected.add(entry.key);
      this.stateValue = { ...state, model: { ...state.model, selected } };
      return;
    }
    const command = browseCommand(action);
    if (command !== null) {
      const next = reduceBrowse(state.model, command);
      const previousHarness = setupHarness(state.model);
      const nextHarness = setupHarness(next);
      if (
        previousHarness !== null &&
        nextHarness !== null &&
        previousHarness !== nextHarness
      ) {
        const view = state.view === "disabled" ? "disabled" : "inventory";
        const setupHarnessStates = {
          ...(state.setupHarnessStates ?? {}),
          [view]: {
            ...(state.setupHarnessStates?.[view] ?? {}),
            [previousHarness]: state.model,
          },
        };
        const restored = setupHarnessStates[view]?.[nextHarness];
        this.stateValue = {
          ...state,
          model:
            restored === undefined
              ? {
                  ...createBrowseModel(
                    state.model.sections,
                    state.model.viewport,
                  ),
                  sectionIndex: next.sectionIndex,
                }
              : { ...restored, sectionIndex: next.sectionIndex },
          setupHarnessStates,
        };
        return;
      }
      this.stateValue = { ...state, model: next };
      return;
    }
    if (
      action.kind !== "disable-review" &&
      action.kind !== "enable-review" &&
      action.kind !== "select"
    )
      return;
    if (action.kind === "select") return; // details is browse-only; never implies removal.
    const ids = selectedSetupTargetIds(
      state.model.sections,
      state.model.selected,
      state.model.sectionIndex,
      state.model.entryIndex,
    );
    const targets = snapshot.targets.filter((target) =>
      ids.includes(target.id),
    );
    if (new Set(targets.map((target) => target.harnessId)).size > 1) {
      this.stateValue = {
        ...state,
        model: {
          ...state.model,
          notice: "Setup actions require targets from one harness.",
        },
      };
      return;
    }
    if (!targets.length) {
      this.stateValue = {
        ...state,
        model: { ...state.model, notice: "Nothing eligible is selected." },
      };
      return;
    }
    const planner = this.dependencies.planSessionSetup;
    if (planner === undefined) {
      this.stateValue = {
        ...state,
        model: {
          ...state.model,
          notice: "Session setup planning is unavailable in this host.",
        },
      };
      return;
    }
    const refs = targets.map((target) =>
      target.kind === "skill-exposure"
        ? {
            kind: "skill-exposure" as const,
            targetId: target.id,
            installationId: target.installationId,
          }
        : target.kind === "plugin"
          ? {
              kind: "plugin" as const,
              targetId: target.id,
              pluginBoundaryId: target.pluginBoundaryId,
            }
          : target.kind === "mcp-registration"
            ? {
                kind: "mcp-registration" as const,
                targetId: target.id,
                declarationSourceId: target.declarationSource.sourceId,
                serverKey: target.serverKey,
              }
            : {
                kind: "app-binding" as const,
                targetId: target.id,
                declarationSourceId: target.declarationSource.sourceId,
                alias: target.alias,
                connectorId: target.connectorId,
              },
    );
    this.stateValue = {
      screen: "setup-plan",
      browse: browseSnapshot(state),
      plan: planner(snapshot, {
        schemaVersion: 1,
        kind: "session-setup-intent",
        action: action.kind === "disable-review" ? "disable" : "enable",
        harnessId: targets[0]!.harnessId,
        workspace: snapshot.workspace,
        targets: refs as never,
      }),
      technicalDetails: false,
      scrollOffset: 0,
    };
  }

  private async setupPlanAction(
    state: import("./types.js").TuiSetupPlanState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "cancel") {
      this.stateValue = { screen: "browse", ...state.browse };
      return;
    }
    if (action.kind === "toggle-details") {
      this.stateValue = { ...state, technicalDetails: !state.technicalDetails };
      return;
    }
    if (action.kind === "owner-review") {
      this.stateValue = {
        screen: "browse",
        ...state.browse,
        model: {
          ...state.browse.model,
          notice:
            "Select the complete owner explicitly to open its availability review.",
        },
      };
      return;
    }
    if (
      action.kind === "confirm" &&
      state.plan.blocks.length === 0 &&
      this.dependencies.executeSessionSetup !== undefined
    ) {
      this.setupExecution = null;
      this.stateValue = {
        screen: "setup-executing",
        browse: state.browse,
        plan: state.plan,
      };
    }
  }

  private async setupReportAction(
    state: import("./types.js").TuiSetupReportState,
    action: TuiAction,
  ): Promise<void> {
    if (action.kind === "quit") {
      this.stateValue = { screen: "done", report: state.report };
      return;
    }
    if (action.kind !== "cancel" && action.kind !== "select") return;
    try {
      const snapshot =
        this.dependencies.scanSessionSetup === undefined
          ? state.browse.setupInventory
          : await this.dependencies.scanSessionSetup();
      if (snapshot === undefined) throw new Error();
      const view = state.browse.view === "disabled" ? "disabled" : "inventory";
      this.stateValue = {
        screen: "browse",
        inventory: state.browse.inventory,
        setupInventory: snapshot,
        area: "setup",
        view,
        model: createBrowseModel(
          createSetupSections(snapshot, view),
          state.browse.model.viewport,
        ),
        ...(state.browse.areaSnapshots === undefined
          ? {}
          : { areaSnapshots: state.browse.areaSnapshots }),
      };
    } catch {
      this.stateValue = { screen: "done", report: state.report };
    }
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
      disabledEntries: state.disabledEntries ?? [],
      viewSnapshots: {
        ...(state.viewSnapshots ?? {}),
        [state.view ?? "inventory"]: viewSnapshot(state),
      },
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
    ...(state.area === undefined ? {} : { area: state.area }),
    ...(state.setupInventory === undefined
      ? {}
      : { setupInventory: state.setupInventory }),
    model: state.model,
    ...(state.view === undefined ? {} : { view: state.view }),
    ...(state.operations === undefined ? {} : { operations: state.operations }),
    ...(state.disabledEntries === undefined
      ? {}
      : { disabledEntries: state.disabledEntries }),
    ...(state.viewSnapshots === undefined
      ? {}
      : { viewSnapshots: state.viewSnapshots }),
    ...(state.setupHarnessStates === undefined
      ? {}
      : { setupHarnessStates: state.setupHarnessStates }),
  };
}

function viewSnapshot(state: TuiBrowseState): TuiViewSnapshot {
  return {
    inventory: state.inventory,
    ...(state.area === undefined ? {} : { area: state.area }),
    ...(state.setupInventory === undefined
      ? {}
      : { setupInventory: state.setupInventory }),
    model: state.model,
    ...(state.view === undefined ? {} : { view: state.view }),
    ...(state.operations === undefined ? {} : { operations: state.operations }),
    ...(state.disabledEntries === undefined
      ? {}
      : { disabledEntries: state.disabledEntries }),
    ...(state.setupHarnessStates === undefined
      ? {}
      : { setupHarnessStates: state.setupHarnessStates }),
  };
}

function preserveBrowseModel(
  old: TuiBrowseState["model"],
  sections: TuiBrowseState["model"]["sections"],
): TuiBrowseState["model"] {
  const keys = new Set(
    sections.flatMap((section) => section.entries.map((entry) => entry.key)),
  );
  const selected = new Set([...old.selected].filter((key) => keys.has(key)));
  return reduceBrowse(
    { ...old, sections, selected, notice: null },
    { kind: "viewport", viewport: old.viewport },
  );
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
    | TuiReportState
    | TuiAvailabilityPlanState
    | TuiAvailabilityReportState
    | import("./types.js").TuiAvailabilityExecutingState
    | TuiUpdatePlanState
    | TuiUpdateReportState
    | import("./types.js").TuiUpdateExecutingState
    | import("./types.js").TuiSetupPlanState
    | import("./types.js").TuiSetupExecutingState
    | import("./types.js").TuiSetupReportState,
  viewport: TuiBrowseState["model"]["viewport"],
):
  | TuiBrowseState
  | TuiSearchState
  | TuiPlanState
  | TuiExecutingState
  | TuiReportState
  | TuiAvailabilityPlanState
  | TuiAvailabilityReportState
  | import("./types.js").TuiAvailabilityExecutingState
  | TuiUpdatePlanState
  | TuiUpdateReportState
  | import("./types.js").TuiUpdateExecutingState
  | import("./types.js").TuiSetupPlanState
  | import("./types.js").TuiSetupExecutingState
  | import("./types.js").TuiSetupReportState {
  if (state.screen === "browse")
    return { screen: "browse", ...resizeBrowse(state, viewport) };
  if (state.screen === "search")
    return {
      ...state,
      browse: resizeBrowse(state.browse, viewport),
      model: reduceSearch(
        state.model,
        state.scope ?? state.browse.model.sections,
        {
          kind: "viewport",
          viewport,
        },
      ),
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
  if (state.screen === "availability-report") {
    const resized = { ...state, browse: resizeBrowse(state.browse, viewport) };
    return {
      ...resized,
      scrollOffset: Math.min(
        resized.scrollOffset,
        availabilityReportScrollMetrics(resized).maximumOffset,
      ),
    };
  }
  if (state.screen === "availability-plan") {
    const resized = { ...state, browse: resizeBrowse(state.browse, viewport) };
    return {
      ...resized,
      scrollOffset: Math.min(
        resized.scrollOffset,
        availabilityPlanScrollMetrics(resized).maximumOffset,
      ),
    };
  }
  if (state.screen === "availability-executing")
    return { ...state, browse: resizeBrowse(state.browse, viewport) };
  if (state.screen === "setup-plan" || state.screen === "setup-report")
    return { ...state, browse: resizeBrowse(state.browse, viewport) };
  if (state.screen === "setup-executing")
    return { ...state, browse: resizeBrowse(state.browse, viewport) };
  if (state.screen === "update-report") {
    const resized = { ...state, browse: resizeBrowse(state.browse, viewport) };
    return {
      ...resized,
      scrollOffset: Math.min(
        resized.scrollOffset,
        updateReportScrollMetrics(resized).maximumOffset,
      ),
    };
  }
  if (state.screen === "update-plan") {
    const resized = { ...state, browse: resizeBrowse(state.browse, viewport) };
    return {
      ...resized,
      scrollOffset: Math.min(
        resized.scrollOffset,
        updatePlanScrollMetrics(resized).maximumOffset,
      ),
    };
  }
  if (state.screen === "update-executing")
    return { ...state, browse: resizeBrowse(state.browse, viewport) };
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

export function availabilityApprovalGrants(
  availabilityPlan: AvailabilityPlan,
): readonly ApprovalRequirement[] {
  return availabilityPlan.actions
    .flatMap((action) => action.approvals)
    .filter(
      (approval, index, approvals) =>
        approvals.findIndex(
          (candidate) =>
            stringifyModel(candidate, 0) === stringifyModel(approval, 0),
        ) === index,
    );
}

export function updateApprovalGrants(
  updatePlan: import("../update/types.js").UpdatePlan,
): readonly ApprovalRequirement[] {
  return updatePlan.actions
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
    ...(browse.viewSnapshots === undefined
      ? {}
      : {
          viewSnapshots: Object.fromEntries(
            Object.entries(browse.viewSnapshots).map(([view, snapshot]) => [
              view,
              snapshot === undefined
                ? snapshot
                : {
                    ...snapshot,
                    model: reduceBrowse(snapshot.model, {
                      kind: "viewport",
                      viewport,
                    }),
                  },
            ]),
          ),
        }),
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
    case "select-all":
      return null;
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

function updateSelection(state: TuiBrowseState): {
  readonly target: UpdateTarget | null;
  readonly notice: string;
} {
  const entries = state.model.sections.flatMap((section) => section.entries);
  const selectedEntries = entries.filter((entry) =>
    state.model.selected.has(entry.key),
  );
  if (
    state.view === "disabled" &&
    selectedEntries.some((entry) => entry.key.startsWith("disabled-entry:"))
  )
    return {
      target: null,
      notice: "Enable a Suspended target before Update.",
    };
  if (selectedEntries.length > 0) {
    const targets =
      state.view === "disabled"
        ? disabledSelectionTargets(state.model.sections, state.model.selected)
        : selectionTargets(state.model.sections, state.model.selected);
    if (targets.length !== 1)
      return {
        target: null,
        notice: "Update requires exactly one target.",
      };
    const target = targets[0]!;
    return {
      target:
        state.view === "disabled"
          ? availabilityUpdateTarget(state.inventory, target)
          : (target as UpdateTarget),
      notice: "",
    };
  }
  const entry = currentEntry(state.model);
  if (entry === null)
    return { target: null, notice: "Nothing eligible is focused." };
  if (entry.key.startsWith("disabled-entry:"))
    return {
      target: null,
      notice: "Enable a Suspended target before Update.",
    };
  if (entry.rowKind === "plugin-skill")
    return {
      target: null,
      notice: "Plugin-owned Skills are read-only. Select the complete Plugin.",
    };
  if (entry.key.startsWith("finding:"))
    return { target: null, notice: "System Skills are read-only." };
  const target =
    state.view === "disabled"
      ? availabilityUpdateTarget(
          state.inventory,
          entry.availabilityTargets?.[0],
        )
      : entry.target;
  return target === undefined || target === null
    ? { target: null, notice: "This row is read-only for Update." }
    : { target, notice: "" };
}

function availabilityUpdateTarget(
  inventory: Inventory,
  target: AvailabilityTarget | undefined,
): UpdateTarget | null {
  if (target === undefined) return null;
  if (target.kind !== "source-group") return target;
  const group = inventory.groups.find((item) => item.id === target.groupId);
  return group === undefined
    ? null
    : { kind: "source-group", groupId: group.id };
}

function updateTargetLabel(inventory: Inventory, target: UpdateTarget): string {
  if (target.kind === "installation")
    return (
      inventory.installations.find((item) => item.id === target.installationId)
        ?.skill.name ?? "selected Installation"
    );
  if (target.kind === "logical-skill")
    return (
      inventory.logicalSkills.find((item) => item.id === target.logicalSkillId)
        ?.skill.name ?? "selected Logical Skill"
    );
  if (target.kind === "source-group")
    return (
      inventory.groups.find((item) => item.id === target.groupId)?.label ??
      "selected Installation Group"
    );
  return (
    inventory.plugins.find((item) => item.id === target.pluginBoundaryId)
      ?.pluginId ?? "selected Plugin"
  );
}

function movedCursor(current: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}

function setupHarness(
  model: TuiBrowseState["model"],
): import("../session-setup/types.js").SetupHarnessId | null {
  const key = model.sections[model.sectionIndex]?.key;
  return key === "setup:codex"
    ? "codex"
    : key === "setup:claude-code"
      ? "claude-code"
      : key === "setup:gemini-cli"
        ? "gemini-cli"
        : null;
}
