import type {
  ApprovalRequirement,
  ExecutableCommand,
  ManagedRemovalInvocation,
  PlanBlock,
  PlanWarning,
  RemovalAction,
  RemovalTarget,
  RemovalPlan,
  VerificationCheck,
} from "../model/types.js";
import type {
  UpdateAction,
  UpdateBlock,
  UpdateTarget,
  UpdateWarning,
} from "../update/types.js";
import {
  currentSection,
  detailPane,
  layout,
  panes,
  sharedExposure,
  sharedPathCount,
} from "./browse.js";
import { searchLayout } from "./search.js";
import {
  nightfallTheme,
  plainTuiTheme,
  styleTui,
  type TuiStyleRole,
  type TuiTheme,
} from "./theme.js";
import type {
  TuiBrowseState,
  TuiAvailabilityPlanState,
  TuiAvailabilityReportState,
  TuiExecutingState,
  TuiEntry,
  TuiPaneView,
  TuiPlanState,
  TuiReportState,
  TuiSearchState,
  TuiSection,
  TuiState,
  TuiUpdatePlanState,
  TuiUpdateReportState,
} from "./types.js";

export function renderTui(
  state: TuiState,
  theme: TuiTheme = nightfallTheme,
): string {
  const style = createPaint(theme);
  if (state.screen === "loading")
    return `${style.title("Lampwright")}\n\n${style.info("Scanning known skill roots…")}\n`;
  if (state.screen === "error")
    return `${style.title("Lampwright")}\n\n${style.error(`Unable to continue: ${state.message}`)}\n\n${style.muted("Press q or ctrl-c to exit.")}\n`;
  if (state.screen === "done") return "";
  if (state.screen === "browse") return renderBrowse(state, theme);
  if (state.screen === "search") return renderSearch(state, theme);
  if (state.screen === "plan") return renderPlan(state, style);
  if (state.screen === "executing") return renderExecuting(state, style);
  if (state.screen === "availability-plan")
    return renderAvailabilityPlan(state, style);
  if (state.screen === "availability-executing")
    return renderAvailabilityExecuting(state, style);
  if (state.screen === "availability-report")
    return renderAvailabilityReport(state, style);
  if (state.screen === "update-plan") return renderUpdatePlan(state, style);
  if (state.screen === "update-executing")
    return renderUpdateExecuting(state, style);
  if (state.screen === "update-report") return renderUpdateReport(state, style);
  if (state.screen === "trash-review") return renderTrashReview(state, style);
  if (state.screen === "trash-executing")
    return `${style.title("Lampwright — Trash")}\n\n${style.info(`${state.kind === "restore" ? "Restoring" : "Permanently purging"} ${state.operation.displayNames.join(", ")}…`)}\n`;
  if (state.screen === "trash-report") return renderTrashReport(state, style);
  return renderReport(state, style);
}

function renderTrashReport(
  state: Extract<TuiState, { screen: "trash-report" }>,
  style: TuiPaint,
): string {
  return renderTrashScrollable(
    trashReportBodyLines(state, style),
    trashReportFooterLines(state, style),
    state.scrollOffset,
    state.browse.model.viewport,
    "result",
  );
}

function renderTrashReview(
  state: Extract<TuiState, { screen: "trash-review" }>,
  style: TuiPaint,
): string {
  return renderTrashScrollable(
    trashReviewBodyLines(state, style),
    trashReviewFooterLines(state, style),
    state.scrollOffset,
    state.browse.model.viewport,
  );
}

function renderTrashScrollable(
  body: readonly string[],
  footer: readonly string[],
  offset: number,
  viewport: TuiBrowseState["model"]["viewport"],
  rangeLabel = "review",
): string {
  const width = Math.max(1, viewport.columns - 1);
  const metrics = trashScrollMetricsFor(viewport, body.length, footer.length);
  const clamped = Math.min(Math.max(0, offset), metrics.maximumOffset);
  const visible = body.slice(clamped, clamped + metrics.pageRows);
  const range =
    metrics.maximumOffset === 0
      ? []
      : [
          `${rangeLabel} ${String(clamped + 1)}-${String(Math.min(body.length, clamped + metrics.pageRows))}/${String(body.length)}  ↑↓/PgUp/PgDn scroll`,
        ];
  return `${[...visible, ...range, ...footer]
    .slice(0, Math.max(0, viewport.rows - 1))
    .map((line) => fit(line, width))
    .join("\n")}\n`;
}

function trashReviewBodyLines(
  state: Extract<TuiState, { screen: "trash-review" }>,
  style: TuiPaint,
): readonly string[] {
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const entries = new Map(
    state.operation.entries.map((entry) => [entry.id, entry]),
  );
  const restore =
    state.kind === "restore"
      ? (state.preview as import("../quarantine/types.js").RestoreOperationPreview)
      : null;
  const lines = [
    style.title(
      `Lampwright — ${state.kind === "restore" ? "Restore review" : "Permanent purge review"}`,
    ),
    "",
    ...wrapPlanLine(state.operation.displayNames.join(", "), width).map(
      style.active,
    ),
    ...wrapPlanLine(
      `${String(state.operation.entries.length)} item(s) · expires ${state.operation.expiresAt}`,
      width,
    ),
    state.kind === "purge"
      ? style.warning("Permanent purge cannot be undone.")
      : restore?.status === "blocked"
        ? style.error("Known conflicts block this whole restore.")
        : style.success(
            "Every item will be restored without overwriting destinations.",
          ),
    "",
    ...state.preview.entries.flatMap((preview) => {
      const entry = entries.get(preview.entryId);
      const location =
        entry?.originalLocation.path ?? "an unavailable original location";
      if (preview.status === "would-restore")
        return wrapPlanLine(`✓ Restore ${location}`, width).map(style.success);
      if (preview.status === "would-purge")
        return wrapPlanLine(
          `! Permanently delete recoverable content from ${location}`,
          width,
        ).map(style.warning);
      return wrapPlanLine(
        `! ${location}: ${preview.reason.replaceAll("-", " ")}`,
        width,
      ).map(style.error);
    }),
  ];
  if (state.technicalDetails)
    lines.push(
      "",
      ...wrapPlanLine(`Operation ID: ${state.operation.id}`, width).map(
        style.muted,
      ),
      ...state.preview.entries.flatMap((preview) =>
        wrapPlanLine(`Entry ID: ${preview.entryId}`, width).map(style.muted),
      ),
    );
  return lines;
}

function trashReviewFooterLines(
  state: Extract<TuiState, { screen: "trash-review" }>,
  style: TuiPaint,
): readonly string[] {
  const blocked =
    state.kind === "restore" &&
    (state.preview as import("../quarantine/types.js").RestoreOperationPreview)
      .status === "blocked";
  return [
    state.message === null
      ? blocked
        ? style.error("Blocked — Esc returns to Trash.")
        : style.muted(
            "y confirm · d technical details · Esc returns to Trash · q quits",
          )
      : style.error(state.message),
  ];
}

function trashReportBodyLines(
  state: Extract<TuiState, { screen: "trash-report" }>,
  style: TuiPaint,
): readonly string[] {
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const entries = new Map(
    state.operation.entries.map((entry) => [entry.id, entry]),
  );
  const status =
    state.kind === "restore"
      ? (
          state.result as import("../quarantine/types.js").RestoreOperationResult
        ).status
      : state.result.entries.every((entry) => entry.status === "purged")
        ? "purged"
        : state.result.entries.some((entry) => entry.status === "purged")
          ? "partial"
          : "blocked";
  const heading =
    state.kind === "restore"
      ? status === "restored"
        ? "Restored"
        : status === "partial"
          ? "Restored with concerns"
          : "Could not restore"
      : status === "purged"
        ? "Permanently purged"
        : status === "partial"
          ? "Permanently purged with concerns"
          : "Could not permanently purge";
  const lines = [
    style.title("Lampwright — Trash result"),
    "",
    status === "restored" || status === "purged"
      ? style.success(heading)
      : style.warning(heading),
    ...state.result.entries.flatMap((result) => {
      const location =
        entries.get(result.entryId)?.originalLocation.path ??
        "an unavailable original location";
      if (result.status === "restored")
        return wrapPlanLine(`✓ Restored ${location}`, width).map(style.success);
      if (result.status === "purged")
        return wrapPlanLine(`✓ Permanently purged ${location}`, width).map(
          style.success,
        );
      if (result.status === "not-attempted")
        return wrapPlanLine(
          `– Did not restore ${location}: ${result.reason.replaceAll("-", " ")}`,
          width,
        ).map(style.warning);
      return wrapPlanLine(
        `! ${location}: ${result.reason.replaceAll("-", " ")}`,
        width,
      ).map(style.error);
    }),
  ];
  if (state.technicalDetails)
    lines.push(
      "",
      ...wrapPlanLine(`Operation ID: ${state.operation.id}`, width).map(
        style.muted,
      ),
      ...state.result.entries.flatMap((entry) =>
        wrapPlanLine(`Entry ID: ${entry.entryId}`, width).map(style.muted),
      ),
    );
  return lines;
}

function trashReportFooterLines(
  state: Extract<TuiState, { screen: "trash-report" }>,
  style: TuiPaint,
): readonly string[] {
  return [style.muted("d technical details · Esc returns to Trash · q quits")];
}

export function trashReviewScrollMetrics(
  state: Extract<TuiState, { screen: "trash-review" }>,
): { readonly pageRows: number; readonly maximumOffset: number } {
  return trashScrollMetricsFor(
    state.browse.model.viewport,
    trashReviewBodyLines(state, createPaint(plainTuiTheme)).length,
    trashReviewFooterLines(state, createPaint(plainTuiTheme)).length,
  );
}

export function trashReportScrollMetrics(
  state: Extract<TuiState, { screen: "trash-report" }>,
): { readonly pageRows: number; readonly maximumOffset: number } {
  return trashScrollMetricsFor(
    state.browse.model.viewport,
    trashReportBodyLines(state, createPaint(plainTuiTheme)).length,
    trashReportFooterLines(state, createPaint(plainTuiTheme)).length,
  );
}

function trashScrollMetricsFor(
  viewport: TuiBrowseState["model"]["viewport"],
  bodyRows: number,
  footerRows: number,
): { readonly pageRows: number; readonly maximumOffset: number } {
  const usableRows = Math.max(0, viewport.rows - 1);
  const overflows = bodyRows + footerRows > usableRows;
  const pageRows = Math.max(
    0,
    usableRows - Math.min(footerRows, usableRows) - (overflows ? 1 : 0),
  );
  return { pageRows, maximumOffset: Math.max(0, bodyRows - pageRows) };
}

function renderAvailabilityPlan(
  state: TuiAvailabilityPlanState,
  style: TuiPaint,
): string {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return renderCompactAvailability(state.browse.model.viewport, style);
  return renderTrashScrollable(
    availabilityPlanBodyLines(state, style),
    availabilityPlanFooterLines(state, style),
    state.scrollOffset,
    state.browse.model.viewport,
  );
}

function availabilityPlanBodyLines(
  state: TuiAvailabilityPlanState,
  style: TuiPaint,
): readonly string[] {
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const operation = state.plan.intent.operation;
  const lines: string[] = [
    style.title(`Lampwright — Review ${operation}`),
    "",
    style.title(
      `${operation === "disable" ? "Disable" : "Enable"} ${state.label}?`,
    ),
    state.plan.blocks.length === 0
      ? style.success(`READY TO ${operation.toUpperCase()}`)
      : style.error(`CANNOT ${operation.toUpperCase()}`),
    "",
  ];
  const ordinaryActionGroups: Array<
    Array<(typeof state.plan.actions)[number]>
  > = [];
  for (const action of state.plan.actions) {
    const previous = ordinaryActionGroups.at(-1);
    const previousAction = previous?.[0];
    const sameSuspensionOwner =
      action.kind === "suspended-disable" &&
      previousAction?.kind === "suspended-disable" &&
      JSON.stringify(action.request.ownership) ===
        JSON.stringify(previousAction.request.ownership);
    if (sameSuspensionOwner) previous!.push(action);
    else ordinaryActionGroups.push([action]);
  }
  for (const actions of ordinaryActionGroups) {
    const action = actions[0]!;
    if (actions.length > 1 && action.kind === "suspended-disable") {
      const suspensionActions = actions as readonly Extract<
        (typeof state.plan.actions)[number],
        { kind: "suspended-disable" }
      >[];
      const artifactCount = suspensionActions.reduce(
        (total, candidate) =>
          total +
          ("artifacts" in candidate.request
            ? candidate.request.artifacts.length
            : 1),
        0,
      );
      lines.push(
        ...wrapPlanLine(
          `Suspended: move ${String(suspensionActions.length)} selected Skills (${String(artifactCount)} artifacts) to non-expiring Disabled Storage as separate recoverable operations.`,
          width,
        ).map(style.active),
      );
      if (action.request.ownership.kind === "manager")
        lines.push(
          ...wrapPlanLine(
            "Manager records remain unchanged. Running the Manager may recreate displaced artifacts and block Enable until those conflicts are resolved.",
            width,
          ).map(style.warning),
        );
      continue;
    }
    if (action.kind === "native-control") {
      const harnesses = [
        ...new Set(action.effects.map((effect) => effect.harnessId)),
      ].sort();
      const pluginEffects = action.effects.filter(
        (effect) => "pluginBoundaryId" in effect,
      );
      if (pluginEffects.length > 0) {
        const plugins = pluginEffects.flatMap((effect) => {
          const plugin = state.browse.inventory.plugins.find(
            (candidate) => candidate.id === effect.pluginBoundaryId,
          );
          return plugin === undefined ? [] : [plugin];
        });
        const ownedSkills = new Set(
          plugins.flatMap((plugin) =>
            plugin.installationIds.flatMap((id) => {
              const installation = state.browse.inventory.installations.find(
                (candidate) => candidate.id === id,
              );
              return installation === undefined
                ? []
                : [installation.skill.name];
            }),
          ),
        );
        const resources = plugins.reduce(
          (total, plugin) => total + plugin.resources.length,
          0,
        );
        lines.push(
          ...wrapPlanLine(
            `Native Plugin: ${operation} ${plugins.map((plugin) => plugin.pluginId).join(", ")} in ${harnesses.join(", ")} by changing harness configuration. ${String(ownedSkills.size)} owned Skill${ownedSkills.size === 1 ? "" : "s"} and ${String(resources)} other known resource${resources === 1 ? "" : "s"} remain installed and change availability together.`,
            width,
          ).map(style.active),
        );
        if (pluginEffects.length === action.effects.length) continue;
      }
      const skills = [
        ...new Set(
          action.effects.flatMap((effect) =>
            "installationId" in effect
              ? [
                  state.browse.inventory.installations.find(
                    (installation) => installation.id === effect.installationId,
                  )?.skill.name ?? effect.installationId,
                ]
              : [],
          ),
        ),
      ].sort();
      lines.push(
        ...wrapPlanLine(
          `Native: ${operation === "disable" ? "hide" : "show"} ${skills.join(", ")} ${operation === "disable" ? "from" : "in"} ${harnesses.join(", ")} by changing harness configuration; the Skill remains installed.`,
          width,
        ).map(style.active),
      );
    } else if (action.kind === "suspended-disable") {
      const paths =
        "artifacts" in action.request
          ? action.request.artifacts.map((artifact) => artifact.location.path)
          : [action.request.location.path];
      const manager = action.request.ownership.kind === "manager";
      lines.push(
        ...wrapPlanLine(
          `Suspended: move ${action.request.operation.displayNames.join(", ")} (${String(paths.length)} artifact${paths.length === 1 ? "" : "s"}) to non-expiring Disabled Storage. It does not enter Trash and can be restored to ${paths.join(", ")}.`,
          width,
        ).map(style.active),
      );
      if (manager)
        lines.push(
          ...wrapPlanLine(
            "Manager records remain unchanged. Running the Manager may recreate a displaced artifact and block Enable until that conflict is resolved.",
            width,
          ).map(style.warning),
        );
    } else {
      const paths =
        action.entry.schemaVersion === 1
          ? [action.entry.originalLocation.path]
          : action.entry.artifacts.map(
              (artifact) => artifact.originalLocation.path,
            );
      lines.push(
        ...wrapPlanLine(
          `Suspended: restore ${action.entry.operation.displayNames.join(", ")} from Disabled Storage to ${String(paths.length)} exact original path${paths.length === 1 ? "" : "s"} without overwriting anything. This enables ${[...new Set(action.entry.harnessExposures.map((x) => x.harnessId))].sort().join(", ") || "its recorded harnesses"}.`,
          width,
        ).map(style.active),
      );
    }
  }
  const blockGroups = new Map<
    string,
    {
      readonly kind: (typeof state.plan.blocks)[number]["kind"];
      readonly reason: string;
      count: number;
    }
  >();
  for (const block of state.plan.blocks) {
    const reason = "reason" in block ? block.reason : block.dependency.reason;
    const key = `${block.kind}\u0000${reason}`;
    const group = blockGroups.get(key) ?? {
      kind: block.kind,
      reason,
      count: 0,
    };
    group.count += 1;
    blockGroups.set(key, group);
  }
  for (const group of blockGroups.values())
    lines.push(
      ...wrapPlanLine(
        `Blocked (${group.kind}, ${String(group.count)} block occurrence${group.count === 1 ? "" : "s"}): ${group.reason}`,
        width,
      ).map(style.error),
    );
  for (const warning of state.plan.warnings)
    lines.push(
      ...wrapPlanLine(`Warning: ${warning.reference.evidence}`, width).map(
        style.warning,
      ),
    );
  if (state.technicalDetails) {
    const technical = (value: string): void => {
      lines.push(...wrapPlanLine(value, width).map(style.muted));
    };
    lines.push("");
    technical(`Plan ID: ${state.plan.id}`);
    technical(`Inventory ID: ${state.plan.inventoryId}`);
    technical(`Created: ${state.plan.createdAt}`);
    for (const target of state.plan.targets)
      technical(`Target: ${JSON.stringify(target)}`);
    for (const id of state.plan.disabledEntryIds)
      technical(`Disabled entry ID: ${id}`);
    for (const block of state.plan.blocks)
      technical(`Block ${block.kind}: ${JSON.stringify(block)}`);
    for (const action of state.plan.actions) {
      technical(`Action ${action.id}: ${action.kind}`);
      technical(`  Targets: ${JSON.stringify(action.targets)}`);
      technical(`  Depends on: ${action.dependsOn.join(", ") || "none"}`);
      technical(`  Approvals: ${JSON.stringify(action.approvals)}`);
      if (action.kind === "native-control") {
        for (const effect of action.effects)
          technical(
            `  Effect: ${"installationId" in effect ? effect.installationId : effect.pluginBoundaryId} · ${effect.harnessId} · ${effect.operation}`,
          );
        for (const mutation of action.mutations)
          technical(
            `  Config: ${mutation.path} · ${mutation.format} · ${mutation.documentScope} · preimage ${mutation.expectedPreimageHash?.digest ?? "absent"}`,
          );
      } else if (action.kind === "suspended-enable") {
        technical(`  Disabled entry ID: ${action.entry.id}`);
        const paths =
          action.entry.schemaVersion === 1
            ? [action.entry.originalLocation.path]
            : action.entry.artifacts.map(
                (artifact) => artifact.originalLocation.path,
              );
        for (const path of paths) technical(`  Stored path: ${path}`);
      } else {
        const paths =
          "artifacts" in action.request
            ? action.request.artifacts.map((artifact) => artifact.location.path)
            : [action.request.location.path];
        for (const path of paths) technical(`  Original path: ${path}`);
      }
    }
    for (const check of state.plan.verificationChecks) {
      technical(`Check ${check.id}: ${check.kind}`);
      technical(`  Target: ${JSON.stringify(check.target)}`);
      technical(`  Action: ${check.actionId ?? "none"}`);
    }
  }
  return lines;
}

function availabilityPlanFooterLines(
  state: TuiAvailabilityPlanState,
  style: TuiPaint,
): readonly string[] {
  if (state.plan.blocks.some((block) => !block.overridable))
    return [style.error("Blocked — Esc returns without changing anything.")];
  if (state.plan.blocks.length > 0)
    return [
      style.muted(
        "f force dependency risks · d technical details · Esc back · q quit",
      ),
    ];
  return [style.muted("y confirm · d technical details · Esc back · q quit")];
}

export function availabilityPlanScrollMetrics(
  state: TuiAvailabilityPlanState,
): { readonly pageRows: number; readonly maximumOffset: number } {
  const style = createPaint(plainTuiTheme);
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return { pageRows: 0, maximumOffset: 0 };
  return trashScrollMetricsFor(
    state.browse.model.viewport,
    availabilityPlanBodyLines(state, style).length,
    availabilityPlanFooterLines(state, style).length,
  );
}

function renderAvailabilityExecuting(
  state: Extract<TuiState, { screen: "availability-executing" }>,
  style: TuiPaint,
): string {
  const verb =
    state.plan.intent.operation === "disable" ? "Disabling" : "Enabling";
  return `${style.title(`Lampwright — ${verb}`)}\n\n${style.info(`${verb} ${state.label}…`)}\n${style.muted(`${String(state.plan.targets.length)} approved target(s) · ${String(state.plan.actions.length)} approved action(s)`)}\n${style.muted("The final scan and verification must finish before results appear.")}\n`;
}

function renderAvailabilityReport(
  state: TuiAvailabilityReportState,
  style: TuiPaint,
): string {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return renderCompactAvailability(state.browse.model.viewport, style);
  return renderTrashScrollable(
    availabilityReportBodyLines(state, style),
    [
      style.muted(
        "d technical details · Esc returns to the previous view · q quits",
      ),
    ],
    state.scrollOffset,
    state.browse.model.viewport,
    "report",
  );
}

function availabilityReportBodyLines(
  state: TuiAvailabilityReportState,
  style: TuiPaint,
): readonly string[] {
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const lines: string[] = [
    style.title("Lampwright — Availability result"),
    "",
    state.report.status === "succeeded"
      ? style.success(`${state.label}: completed`)
      : state.report.status === "partial"
        ? style.warning(`${state.label}: completed only in part`)
        : style.error(`${state.label}: ${state.report.status}`),
    "",
  ];
  for (const result of state.report.targetResults)
    lines.push(
      ...wrapPlanLine(
        `${result.status === "enabled" || result.status === "disabled" ? "✓" : "!"} ${availabilityTargetLabel(state, result.target)}: ${result.status}${result.reason === null ? "" : ` — ${result.reason}`}`,
        width,
      ).map(
        result.status === "enabled" || result.status === "disabled"
          ? style.success
          : style.warning,
      ),
    );
  for (const result of state.report.actionResults) {
    if (result.status !== "failed") continue;
    lines.push(
      ...wrapPlanLine(`Action failed: ${result.error.message}`, width).map(
        style.error,
      ),
    );
  }
  for (const result of state.report.verificationResults) {
    if (result.status !== "failed") continue;
    lines.push(
      ...wrapPlanLine(
        `Verification failed: ${result.error.message}`,
        width,
      ).map(style.error),
    );
  }
  if (state.technicalDetails) {
    const technical = (value: string): void => {
      lines.push(...wrapPlanLine(value, width).map(style.muted));
    };
    lines.push(
      "",
      style.muted(`Plan ID: ${state.report.planId}`),
      style.muted(`Inventory ID: ${state.report.inventoryId}`),
      style.muted(
        `Final Inventory ID: ${state.report.finalInventoryId ?? "unavailable"}`,
      ),
      style.muted(`Started: ${state.report.startedAt}`),
      style.muted(`Completed: ${state.report.completedAt}`),
    );
    for (const result of state.report.actionResults) {
      technical(`Action ${result.actionId}: ${result.status}`);
      if (result.status === "failed")
        technical(
          `Raw error ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
        );
    }
    for (const result of state.report.verificationResults) {
      technical(`Check ${result.checkId}: ${result.status}`);
      if (result.status === "failed")
        technical(
          `Raw error ${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details)}`,
        );
    }
    if (state.report.rescanError !== null)
      technical(
        `Rescan error ${state.report.rescanError.code}: ${state.report.rescanError.message} ${JSON.stringify(state.report.rescanError.details)}`,
      );
  }
  return lines;
}

function availabilityTargetLabel(
  state: TuiAvailabilityReportState,
  target: import("../availability/types.js").AvailabilityTarget,
): string {
  if (target.kind === "installation") {
    const installation = state.browse.inventory.installations.find(
      (x) => x.id === target.installationId,
    );
    if (installation === undefined) {
      const stored = state.browse.disabledEntries?.find((entry) =>
        entry.installationIds.includes(target.installationId),
      );
      return stored?.operation.displayNames.join(", ") ?? target.installationId;
    }
    const harnesses = installation.harnessExposures
      .map((exposure) => exposure.harnessId)
      .sort();
    return `${installation.skill.name}${harnesses.length === 0 ? "" : ` (${harnesses.join(", ")})`}`;
  }
  if (target.kind === "logical-skill")
    return (
      state.browse.inventory.logicalSkills.find(
        (x) => x.id === target.logicalSkillId,
      )?.skill.name ?? target.logicalSkillId
    );
  if (target.kind === "plugin") {
    const plugin = state.browse.inventory.plugins.find(
      (x) => x.id === target.pluginBoundaryId,
    );
    return plugin === undefined
      ? target.pluginBoundaryId
      : `${plugin.pluginId} (${plugin.exposedTo.join(", ")})`;
  }
  return (
    state.browse.inventory.groups.find((x) => x.id === target.groupId)?.label ??
    target.groupId
  );
}

export function availabilityReportScrollMetrics(
  state: TuiAvailabilityReportState,
): { readonly pageRows: number; readonly maximumOffset: number } {
  const style = createPaint(plainTuiTheme);
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return { pageRows: 0, maximumOffset: 0 };
  return trashScrollMetricsFor(
    state.browse.model.viewport,
    availabilityReportBodyLines(state, style).length,
    1,
  );
}

function renderUpdatePlan(state: TuiUpdatePlanState, style: TuiPaint): string {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return renderCompactAvailability(state.browse.model.viewport, style);
  return renderTrashScrollable(
    updatePlanBodyLines(state, style),
    updatePlanFooterLines(state, style),
    state.scrollOffset,
    state.browse.model.viewport,
  );
}

function updatePlanBodyLines(
  state: TuiUpdatePlanState,
  style: TuiPaint,
): readonly string[] {
  const { plan } = state;
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const lines: string[] = [
    style.title(`Lampwright - Update ${state.label}`),
    "",
  ];
  if (plan.blocks.length > 0) {
    const groups = groupUpdateBlocks(plan.blocks);
    lines.push(
      style.title("Why Update cannot run"),
      ...groups.flatMap((group) =>
        wrapPlanLine(`! ${describeUpdateBlockGroup(group)}`, width).map(
          style.error,
        ),
      ),
      "",
    );
  }
  if (plan.warnings.length > 0) {
    const groups = groupUpdateWarnings(plan.warnings);
    lines.push(
      style.title("Review these warnings"),
      ...groups.flatMap((group) =>
        wrapPlanLine(
          `! ${describeUpdateWarningGroup(group, state)}`,
          width,
        ).map(style.warning),
      ),
      "",
    );
  }
  if (plan.actions.length > 0) {
    lines.push(
      style.title("Planned updates"),
      ...groupUpdateActions(plan.actions, plan.warnings).flatMap((group) =>
        updateActionGroupLines(group, state).flatMap((line) =>
          wrapPlanLine(line, width).map(style.muted),
        ),
      ),
      "",
    );
    const approvals = uniqueUpdateApprovals(plan.actions).filter(
      (approval) => approval.kind === "package-trust",
    );
    if (approvals.length > 0)
      lines.push(
        style.title("Before update"),
        ...approvals.flatMap((approval) =>
          wrapPlanLine(`• ${describeUpdateApproval(approval)}`, width).map(
            style.muted,
          ),
        ),
        "",
      );
  }
  if (plan.verificationChecks.length > 0) {
    lines.push(
      style.title("After the update"),
      ...groupUpdateVerificationChecks(plan.verificationChecks).flatMap(
        (group) =>
          updateVerificationGroupLines(
            group,
            state,
            state.technicalDetails,
          ).flatMap((line) => wrapPlanLine(line, width).map(style.muted)),
      ),
      "",
    );
  }
  lines.push(
    ...wrapPlanLine("Lampwright cannot undo this update for you.", width).map(
      style.warning,
    ),
  );
  if (state.technicalDetails) {
    lines.push(
      "",
      style.title("Exact Update evidence"),
      ...wrapPlanLine(`Plan ID: ${plan.id}`, width).map(style.muted),
      ...wrapPlanLine(`Inventory ID: ${plan.inventoryId}`, width).map(
        style.muted,
      ),
      ...wrapPlanLine(
        `Target: ${describeUpdateTarget(plan.intent.target)}`,
        width,
      ).map(style.muted),
    );
    if (plan.blocks.length > 0)
      lines.push(
        style.title("Exact blocks"),
        ...plan.blocks.flatMap((block) =>
          wrapPlanLine(`• ${JSON.stringify(block)}`, width).map(style.muted),
        ),
        "",
      );
    if (plan.warnings.length > 0)
      lines.push(
        style.title("Exact warnings"),
        ...plan.warnings.flatMap((warning) =>
          wrapPlanLine(`• ${JSON.stringify(warning)}`, width).map(style.muted),
        ),
        "",
      );
    for (const action of plan.actions)
      lines.push(
        style.title(`Action ID: ${action.id}`),
        ...updateActionLines(action).flatMap((line) =>
          wrapPlanLine(line, width).map(style.muted),
        ),
        ...action.selectedInstallations.flatMap((installation) =>
          [
            `• Selected Installation ID: ${installation.id}`,
            `  Location: ${installation.location.path}`,
            `  Canonical path: ${installation.location.canonicalPath}`,
            `  Artifact type: ${JSON.stringify(installation.location.artifactType)}`,
            `  Strong identity: ${JSON.stringify(installation.strongEvidence)}`,
            `  Lifecycle facts: ${JSON.stringify(installation.lifecycle)}`,
          ].flatMap((line) => wrapPlanLine(line, width).map(style.muted)),
        ),
        ...(action.selectedPlugin === null
          ? []
          : [
              `• Selected Plugin boundary: ${JSON.stringify(action.selectedPlugin)}`,
            ].flatMap((line) => wrapPlanLine(line, width).map(style.muted))),
        "",
      );
    for (const check of plan.verificationChecks)
      lines.push(
        style.title(`Check ID: ${check.id}`),
        ...[
          `• Action ID: ${check.actionId}`,
          `• Target: ${describeUpdateTarget(check.target)}`,
          `• Installation ID: ${check.installationId ?? "none"}`,
          `• Plugin boundary ID: ${check.pluginBoundaryId ?? "none"}`,
          `• Strong identity: ${JSON.stringify(check.identity)}`,
          `• Source: ${JSON.stringify(check.source)}`,
          `• Ref: ${check.ref ?? "none"}`,
          `• Scope: ${JSON.stringify(check.scope)}`,
          `• Owner: ${JSON.stringify(check.owner)}`,
          `• Current revision: ${check.currentRevision.map(describeUpdateRevision).join(" · ")}`,
          ...describeUpdateAvailabilityExpectation(
            check.availabilityExpectation,
          ),
        ].flatMap((line) => wrapPlanLine(line, width).map(style.muted)),
        "",
      );
  }
  return lines;
}

interface UpdateActionGroup {
  readonly actions: readonly [UpdateAction, ...UpdateAction[]];
}

interface UpdateWarningGroup {
  readonly warnings: readonly [UpdateWarning, ...UpdateWarning[]];
}

interface UpdateBlockGroup {
  readonly blocks: readonly [UpdateBlock, ...UpdateBlock[]];
}

type UpdateVerificationCheck =
  TuiUpdatePlanState["plan"]["verificationChecks"][number];

interface UpdateVerificationGroup {
  readonly checks: readonly [
    UpdateVerificationCheck,
    ...UpdateVerificationCheck[],
  ];
}

function affectedUpdateInstallationIds(
  actions: readonly UpdateAction[],
): readonly string[] {
  return [
    ...new Set(actions.flatMap((action) => action.affectedInstallationIds)),
  ];
}

function affectedUpdateSkillCount(
  state: TuiUpdatePlanState,
  actions = state.plan.actions,
): number {
  const target = state.plan.intent.target;
  if (target.kind === "plugin") return 1;
  const fromActions = affectedUpdateInstallationIds(actions);
  if (fromActions.length > 0)
    return affectedSkillCountForInstallationIds(state, fromActions);
  if (target.kind === "installation") return 1;
  if (target.kind === "source-group")
    return affectedSkillCountForInstallationIds(
      state,
      state.browse.inventory.groups.find((group) => group.id === target.groupId)
        ?.installationIds ?? [],
    );
  return 1;
}

function affectedSkillCountForInstallationIds(
  state: TuiUpdatePlanState,
  installationIds: readonly string[],
): number {
  const installationToSkill: ReadonlyMap<string, string> = new Map(
    state.browse.inventory.logicalSkills.flatMap((skill) =>
      skill.installationIds.map(
        (installationId) => [installationId, skill.id] as const,
      ),
    ),
  );
  return new Set(installationIds.map((id) => installationToSkill.get(id) ?? id))
    .size;
}

function groupValues<Value>(
  values: readonly Value[],
  keyFor: (value: Value) => string,
): readonly (readonly [Value, ...Value[]])[] {
  const groups = new Map<string, Value[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [value]);
    else group.push(value);
  }
  return [...groups.values()].map((group) => [group[0]!, ...group.slice(1)]);
}

function updateRiskKey(
  action: UpdateAction,
  warnings: readonly UpdateWarning[],
): string {
  const actionWarnings = warnings
    .filter((warning) => updateWarningAppliesToAction(warning, action))
    .map((warning) => describeUpdateWarning(warning))
    .sort();
  return JSON.stringify({
    localChanges: action.operation.localChanges,
    packageDownload: action.operation.packageDownload,
    availability: updateAvailabilityKey(action.availabilityExpectation),
    warnings: actionWarnings,
  });
}

function updateWarningAppliesToAction(
  warning: UpdateWarning,
  action: UpdateAction,
): boolean {
  if ("actionId" in warning) return warning.actionId === action.id;
  if (warning.kind === "local-change-unavailable")
    return (
      warning.installationId === null ||
      action.affectedInstallationIds.includes(warning.installationId)
    );
  if (warning.kind === "hard-dependency")
    return action.affectedInstallationIds.includes(
      warning.dependency.dependentInstallationId,
    );
  if (warning.kind === "soft-reference")
    return (
      warning.reference.referringRecord.kind === "finding" ||
      action.affectedInstallationIds.includes(
        warning.reference.referringRecord.installationId,
      )
    );
  return warning.installationIds.some((id) =>
    action.affectedInstallationIds.includes(id),
  );
}

function updateAvailabilityKey(
  expectation: UpdateAction["availabilityExpectation"],
): Readonly<Record<string, unknown>> {
  return {
    harnessStatuses: expectation.harnessStatuses
      .map(({ harnessId, status }) => ({ harnessId, status }))
      .sort((left, right) =>
        `${left.harnessId}\u0000${left.status}`.localeCompare(
          `${right.harnessId}\u0000${right.status}`,
        ),
      ),
    pluginStatus: expectation.pluginStatus,
  };
}

function updateActionGroupKey(
  action: UpdateAction,
  warnings: readonly UpdateWarning[],
): string {
  const operation = action.operation;
  return JSON.stringify({
    targetKind: action.target.kind,
    pluginBoundary: action.selectedPlugin?.id ?? null,
    owner: operation.owner,
    source: operation.source,
    ref: operation.ref,
    scope: operation.scope,
    invocation: updateInvocationPattern(operation),
    trust: operation.trust,
    approvals: action.approvals.filter(
      (approval) => approval.kind !== "confirmation",
    ),
    network: operation.network,
    risk: updateRiskKey(action, warnings),
  });
}

function groupUpdateActions(
  actions: readonly UpdateAction[],
  warnings: readonly UpdateWarning[],
): readonly UpdateActionGroup[] {
  return groupValues(actions, (action) =>
    updateActionGroupKey(action, warnings),
  ).map((group) => ({ actions: group }));
}

function updateActionGroupLines(
  group: UpdateActionGroup,
  state: TuiUpdatePlanState,
): readonly string[] {
  const action = group.actions[0];
  const operation = action.operation;
  const skillCount = affectedUpdateSkillCount(state, group.actions);
  return [
    action.target.kind === "plugin"
      ? `• Plugin ${action.target.pluginBoundaryId}`
      : `• ${countLabel(skillCount, "skill")} from ${operation.source.id}`,
  ];
}

function uniqueUpdateApprovals(
  actions: readonly UpdateAction[],
): readonly ApprovalRequirement[] {
  const approvals = actions
    .flatMap((action) => action.approvals)
    .filter((approval) => approval.kind !== "confirmation");
  return approvals.filter(
    (approval, index) =>
      approvals.findIndex(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(approval),
      ) === index,
  );
}

function updateInvocationPattern(
  operation: UpdateAction["operation"],
): UpdateAction["operation"]["invocation"] {
  const replaceSelector = (argument: string): string =>
    argument === operation.externalId ? "…" : argument;
  const invocation = operation.invocation;
  if (invocation.kind === "direct")
    return {
      ...invocation,
      command: {
        ...invocation.command,
        arguments: invocation.command.arguments.map(replaceSelector),
      },
    };
  return {
    ...invocation,
    packageArguments: invocation.packageArguments.map(replaceSelector),
  };
}

function groupUpdateWarnings(
  warnings: readonly UpdateWarning[],
): readonly UpdateWarningGroup[] {
  return groupValues(warnings, describeUpdateWarning).map((group) => ({
    warnings: group,
  }));
}

function describeUpdateWarningGroup(
  group: UpdateWarningGroup,
  state: TuiUpdatePlanState,
): string {
  const description = describeUpdateWarning(group.warnings[0]);
  if (group.warnings.length === 1) return description;
  const actions = state.plan.actions.filter((action) =>
    group.warnings.some((warning) =>
      updateWarningAppliesToAction(warning, action),
    ),
  );
  const target = group.warnings[0].target;
  const count = affectedUpdateSkillCount(state, actions);
  return `${description} — ${countLabel(count, target.kind === "plugin" ? "plugin" : "skill")}`;
}

function groupUpdateBlocks(
  blocks: readonly UpdateBlock[],
): readonly UpdateBlockGroup[] {
  return groupValues(blocks, (block) =>
    JSON.stringify({ kind: block.kind, reason: block.reason }),
  ).map((group) => ({ blocks: group }));
}

function describeUpdateBlockGroup(group: UpdateBlockGroup): string {
  if (group.blocks.length === 1) return describeUpdateBlock(group.blocks[0]);
  const block = group.blocks[0];
  return `${block.kind}: ${block.reason} — ${countLabel(group.blocks.length, "affected boundary")} (not overridable)`;
}

function groupUpdateVerificationChecks(
  checks: readonly UpdateVerificationCheck[],
): readonly UpdateVerificationGroup[] {
  return groupValues(checks, (check) =>
    JSON.stringify({
      targetKind: check.target.kind,
      pluginBoundaryId: check.pluginBoundaryId,
      source: check.source,
      ref: check.ref,
      scope: check.scope,
      owner: check.owner,
      revisionShape: check.currentRevision.map(updateRevisionShape),
      availability: updateAvailabilityKey(check.availabilityExpectation),
    }),
  ).map((group) => ({ checks: group }));
}

function updateRevisionShape(
  revision: UpdateVerificationCheck["currentRevision"][number],
): Readonly<Record<string, unknown>> {
  if (revision.kind === "content-hash")
    return { kind: revision.kind, algorithm: revision.digest.algorithm };
  return { kind: revision.kind, format: revision.format };
}

function updateVerificationGroupLines(
  group: UpdateVerificationGroup,
  state: TuiUpdatePlanState,
  technicalDetails = false,
): readonly string[] {
  const check = group.checks[0];
  if (!technicalDetails) {
    const hasPlugin = group.checks.some(
      (item) => item.pluginBoundaryId !== null,
    );
    const skillCount = affectedSkillCountForInstallationIds(
      state,
      group.checks.flatMap((item) =>
        item.installationId === null ? [] : [item.installationId],
      ),
    );
    return [
      hasPlugin
        ? "• The plugin stays installed, and it keeps its prior on/off setting."
        : `• The same ${skillCount === 1 ? "skill stays" : `${skillCount} skills stay`} installed, and each app keeps its prior on/off setting.`,
    ];
  }
  if (group.checks.length === 1)
    return [
      `• ${describeUpdateTarget(check.target)} keeps its strong identity, Owner, source, ref, Scope, boundary, and availability.`,
      ...describeUpdateAvailabilityExpectation(check.availabilityExpectation),
    ];
  const installationCount = new Set(
    group.checks.flatMap((item) =>
      item.installationId === null ? [] : [item.installationId],
    ),
  ).size;
  return [
    `• ${countLabel(installationCount, "Installation")} will be verified for strong identity, Owner, source, ref, Scope, boundary, and availability.`,
    ...summarizeUpdateAvailability(group.checks),
  ];
}

function summarizeUpdateAvailability(
  checks: readonly UpdateVerificationCheck[],
): readonly string[] {
  const harnesses = checks.flatMap(
    (check) => check.availabilityExpectation.harnessStatuses,
  );
  const statuses = new Map<string, number>();
  for (const harness of harnesses) {
    const key = `${harness.harnessId}\u0000${harness.status}`;
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }
  const lines = [...statuses].map(([key, count]) => {
    const [harnessId, status] = key.split("\u0000");
    return `  ${countLabel(count, `${status ?? "recorded"} ${harnessId ?? "Harness"} exposure`)} must remain unchanged.`;
  });
  const pluginStatuses = [
    ...new Set(
      checks.flatMap((check) =>
        check.availabilityExpectation.pluginStatus === null
          ? []
          : [check.availabilityExpectation.pluginStatus],
      ),
    ),
  ];
  lines.push(
    ...pluginStatuses.map((status) => `  Plugin must remain ${status}.`),
  );
  return lines.length === 0
    ? ["  No Harness or Plugin availability state is recorded."]
    : lines;
}

function updateActionLines(action: UpdateAction): readonly string[] {
  const operation = action.operation;
  const owner =
    operation.owner.kind === "manager"
      ? `Manager ${operation.owner.managerId}`
      : `Plugin ${operation.owner.pluginId}`;
  const network =
    operation.network.kind === "required"
      ? `required — ${operation.network.reason}`
      : "not required by the reviewed operation";
  const packageUse =
    operation.packageDownload.kind === "possible"
      ? `${operation.packageDownload.packageName}@${operation.packageDownload.packageVersion} may download or use a cache`
      : "none";
  return [
    `• Owner: ${owner}`,
    `• Authority: Adapter ${operation.adapterId} · operation ${operation.operationId} · selector ${operation.externalId}`,
    `• Invocation: ${describeUpdateInvocation(operation.invocation)}`,
    `• Source: ${operation.source.id}${operation.source.url === null ? "" : ` (${operation.source.url})`}`,
    `• Ref: ${operation.ref ?? "not pinned"}`,
    `• Scope: ${describeUpdateScope(operation.scope)}`,
    "• Current local revision evidence:",
    ...operation.currentRevision.map(
      (revision) => `  - ${describeUpdateRevision(revision)}`,
    ),
    `• Owner record digest: ${operation.ownerRecordDigest.algorithm}:${operation.ownerRecordDigest.digest}`,
    "• Affected lifecycle boundary:",
    ...operation.effects.map(
      (effect) =>
        `  - ${effect.kind} ${effect.path} · ${effect.exists ? "present" : "absent"} · ${describeUpdateProtection(effect.protection)}`,
    ),
    `• Network: ${network}`,
    `• Ephemeral package: ${packageUse}`,
    `• Adapter trust: ${operation.trust.kind === "trusted" ? "trusted" : `blocked ${operation.trust.adapterId}:${operation.trust.contentHash}`}`,
    `• Local changes: ${operation.localChanges.kind}${operation.localChanges.kind === "unavailable" ? ` — ${operation.localChanges.reason}` : ` at ${operation.localChanges.path}`}`,
    "• Required approvals:",
    ...action.approvals.map((approval) => `  - ${describeApproval(approval)}`),
    "• Approved verification evidence:",
    ...operation.verifications.map(
      (verification) => `  - ${describeUpdateVerification(verification)}`,
    ),
  ];
}

function updatePlanFooterLines(
  state: TuiUpdatePlanState,
  style: TuiPaint,
): readonly string[] {
  if (state.plan.blocks.length > 0)
    return [style.error("Blocked — Esc returns without changing anything.")];
  const details = state.technicalDetails
    ? "hide technical details"
    : "technical details";
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  return [
    fitStyledSegments(
      [
        { text: "y", paint: style.title },
        { text: " update · ", paint: style.muted },
        { text: "d", paint: style.title },
        { text: ` ${details} · `, paint: style.muted },
        { text: "Esc", paint: style.title },
        { text: " returns to the previous view · ", paint: style.muted },
        { text: "q", paint: style.title },
        { text: " quits", paint: style.muted },
      ],
      width,
      style.muted,
    ),
  ];
}

export function updatePlanScrollMetrics(state: TuiUpdatePlanState): {
  readonly pageRows: number;
  readonly maximumOffset: number;
} {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return { pageRows: 0, maximumOffset: 0 };
  const style = createPaint(plainTuiTheme);
  return trashScrollMetricsFor(
    state.browse.model.viewport,
    updatePlanBodyLines(state, style).length,
    updatePlanFooterLines(state, style).length,
  );
}

function renderUpdateExecuting(
  state: Extract<TuiState, { screen: "update-executing" }>,
  style: TuiPaint,
): string {
  return `${style.title("Lampwright — Updating")}\n\n${style.info(`Updating ${state.label}…`)}\n${style.muted(`${String(state.plan.actions.length)} approved Owner action(s)`)}\n${style.muted("The final Inventory scan and verification must finish before results appear.")}\n`;
}

function renderUpdateReport(
  state: TuiUpdateReportState,
  style: TuiPaint,
): string {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return renderCompactAvailability(state.browse.model.viewport, style);
  return renderTrashScrollable(
    updateReportBodyLines(state, style),
    updateReportFooterLines(state, style),
    state.scrollOffset,
    state.browse.model.viewport,
    "report",
  );
}

function updateReportBodyLines(
  state: TuiUpdateReportState,
  style: TuiPaint,
): readonly string[] {
  const { report } = state;
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const updated = report.verificationResults.filter(
    (result) => result.status === "passed" && result.changed,
  ).length;
  const unchanged = report.verificationResults.filter(
    (result) => result.status === "passed" && !result.changed,
  ).length;
  const targetStatus =
    report.targetResults.length === 1
      ? report.targetResults[0]!.status.replace(
          "partially-updated",
          "partially updated",
        )
      : report.status;
  const lines: string[] = [
    style.title(`Lampwright - Update ${state.label}`),
    "",
    (report.status === "succeeded"
      ? style.success
      : report.status === "partial"
        ? style.warning
        : style.error)(
      `${state.label}: ${String(updated)} updated, ${String(unchanged)} unchanged${report.status === "succeeded" ? "" : ` (${targetStatus})`}`,
    ),
  ];
  if (state.technicalDetails)
    lines.push(
      "",
      style.title("Technical details"),
      ...wrapPlanLine(`Plan ID: ${report.planId}`, width).map(style.muted),
      ...wrapPlanLine(`Inventory ID: ${report.inventoryId}`, width).map(
        style.muted,
      ),
      ...wrapPlanLine(
        `Final Inventory ID: ${report.finalInventoryId ?? "unavailable"}`,
        width,
      ).map(style.muted),
      ...report.actionResults.flatMap((result) =>
        wrapPlanLine(`Action ${result.actionId}: ${result.status}`, width).map(
          style.muted,
        ),
      ),
      ...report.verificationResults.flatMap((result) =>
        wrapPlanLine(`Check ${result.checkId}: ${result.status}`, width).map(
          style.muted,
        ),
      ),
      ...report.targetResults.flatMap((result) =>
        wrapPlanLine(
          `Target ${describeUpdateTarget(result.target)}: ${result.status}${result.reason === null ? "" : ` — ${result.reason}`}`,
          width,
        ).map(style.muted),
      ),
      ...report.actionResults.flatMap((result) =>
        "error" in result
          ? wrapPlanLine(
              `Action ${result.actionId} error: ${result.error.message}`,
              width,
            ).map(style.error)
          : "reason" in result
            ? wrapPlanLine(
                `Action ${result.actionId} reason: ${result.reason}`,
                width,
              ).map(style.warning)
            : [],
      ),
      ...report.verificationResults.flatMap((result) =>
        result.status === "passed"
          ? []
          : wrapPlanLine(
              `Check ${result.checkId}: ${"error" in result ? result.error.message : result.reason}`,
              width,
            ).map(result.status === "failed" ? style.error : style.warning),
      ),
      report.rescanError === null
        ? style.muted("Final Inventory scan completed.")
        : style.error(
            `Final Inventory scan failed: ${report.rescanError.message}`,
          ),
    );
  return lines;
}

function updateReportFooterLines(
  state: TuiUpdateReportState,
  style: TuiPaint,
): readonly string[] {
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const details = state.technicalDetails
    ? "hide technical details"
    : "technical details";
  return [
    "",
    fitStyledSegments(
      [
        { text: "d", paint: style.title },
        { text: ` ${details} · `, paint: style.muted },
        { text: "Esc", paint: style.title },
        { text: " refreshes Inventory · ", paint: style.muted },
        { text: "q", paint: style.title },
        { text: " quits", paint: style.muted },
      ],
      width,
      style.muted,
    ),
  ];
}

export function updateReportScrollMetrics(state: TuiUpdateReportState): {
  readonly pageRows: number;
  readonly maximumOffset: number;
} {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return { pageRows: 0, maximumOffset: 0 };
  const style = createPaint(plainTuiTheme);
  return trashScrollMetricsFor(
    state.browse.model.viewport,
    updateReportBodyLines(state, style).length,
    updateReportFooterLines(state, style).length,
  );
}

function describeUpdateBlock(block: UpdateBlock): string {
  return `${block.kind}${block.path === null ? "" : ` at ${block.path}`}: ${block.reason} (not overridable)`;
}

function describeUpdateWarning(warning: UpdateWarning): string {
  if (warning.kind === "package-download")
    return `Lampwright may download ${warning.packageName}@${warning.packageVersion} before the update.`;
  if (warning.kind === "soft-reference")
    return `Soft reference: ${warning.reference.evidence} — Update does not change the reference, so it can become stale`;
  if (warning.kind === "hard-dependency")
    return `Hard dependency: ${warning.dependency.reason} — Lampwright preserves the required action order`;
  if (warning.kind === "plugin-impact")
    return `Plugin impact: Plugin ${warning.pluginId} and ${String(warning.installationIds.length)} owned Installation(s) can change together`;
  if (warning.kind === "local-change-unavailable")
    return "Lampwright cannot check for edits, so this update may overwrite them.";
  return "This update needs internet access.";
}

function describeUpdateInvocation(
  invocation: UpdateAction["operation"]["invocation"],
): string {
  const directory =
    invocation.workingDirectory.kind === "exact"
      ? ` from ${invocation.workingDirectory.path}`
      : " from an isolated temporary directory";
  if (invocation.kind === "direct")
    return `${describeCommand(invocation.command)}${directory}`;
  const use = invocation.packageExecution;
  return `${use.runner} ${use.packageName}@${use.packageVersion} ${invocation.packageArguments.map(quoteArgument).join(" ")}${directory} · approval ${use.adapterHash}`;
}

function describeUpdateScope(
  scope: UpdateAction["operation"]["scope"],
): string {
  if (scope.kind === "workspace") return `workspace ${scope.workspacePath}`;
  if (scope.kind === "agent") return `agent ${scope.agentId}`;
  return scope.kind;
}

function describeUpdateRevision(
  revision: UpdateAction["operation"]["currentRevision"][number],
): string {
  if (revision.kind === "content-hash")
    return `content digest ${revision.digest.digest} at ${revision.path}`;
  return `${revision.format} value ${String(revision.value)} at ${revision.path} ${revision.recordPointer}`;
}

function describeUpdateProtection(
  protection: UpdateAction["operation"]["effects"][number]["protection"],
): string {
  return `Git ${protection.git.kind} · System ${protection.system.kind} · filesystem ${protection.filesystem.kind}`;
}

function describeUpdateVerification(
  verification: UpdateAction["operation"]["verifications"][number],
): string {
  if (verification.kind === "command-succeeds")
    return `command succeeds: ${describeCommand(verification.command)} with exit ${verification.successExitCodes.join(", ")}`;
  if (verification.kind === "owner-state-present")
    return `Owner state present: ${verification.externalId}`;
  if (verification.kind === "record-present")
    return `record present: ${verification.format} ${verification.path} ${verification.recordPointer}`;
  if (verification.kind === "revision-manifest-value")
    return `revision manifest value: ${verification.format} ${String(verification.value)} at ${verification.path} ${verification.recordPointer}`;
  if (verification.kind === "revision-content-hash")
    return `revision content hash at ${verification.path}`;
  return `path present: ${verification.path}`;
}

function describeUpdateAvailabilityExpectation(
  expectation: UpdateAction["availabilityExpectation"],
): readonly string[] {
  const lines = expectation.harnessStatuses.map(
    (item) =>
      `  Harness ${item.harnessId} for Installation ${item.installationId} must remain ${item.status}.`,
  );
  if (expectation.pluginStatus !== null)
    lines.push(`  Plugin must remain ${expectation.pluginStatus}.`);
  return lines.length === 0
    ? ["  No Harness or Plugin availability state is recorded."]
    : lines;
}

function describeUpdateTarget(target: UpdateTarget): string {
  if (target.kind === "installation")
    return `Installation ${target.installationId}`;
  if (target.kind === "logical-skill")
    return `Logical Skill ${target.logicalSkillId}`;
  if (target.kind === "source-group")
    return `Installation Group ${target.groupId}`;
  return `Plugin ${target.pluginBoundaryId}`;
}

function renderCompactAvailability(
  viewport: TuiBrowseState["model"]["viewport"],
  style: TuiPaint,
): string {
  const width = Math.max(0, viewport.columns - 1);
  return `${[
    style.title("Lampwright"),
    style.warning("Resize the terminal"),
    style.muted("q quit"),
  ]
    .slice(0, Math.max(0, viewport.rows - 1))
    .map((line) => fit(line, width))
    .join("\n")}\n`;
}

function renderExecuting(state: TuiExecutingState, style: TuiPaint): string {
  const width = Math.max(0, state.browse.model.viewport.columns - 1);
  const rows = Math.max(0, state.browse.model.viewport.rows - 1);
  const lines = [
    { text: "Lampwright — Removing", paint: style.title },
    { text: "", paint: style.muted },
    { text: `Removing ${state.label}`, paint: style.active },
    {
      text: `${countLabel(state.plan.targets.length, "approved target")} · ${countLabel(state.plan.actions.length, "approved action")}`,
      paint: style.muted,
    },
    { text: "", paint: style.muted },
    { text: "The approved removal is running.", paint: style.info },
    {
      text: "Verification and the final inventory scan must finish before results appear.",
      paint: style.muted,
    },
  ];
  return `${lines
    .flatMap(({ text, paint }) =>
      wrapPlanLine(text, Math.max(1, width)).map((line) => ({ line, paint })),
    )
    .slice(0, rows)
    .map(({ line, paint }) => paint(fit(line, width)))
    .join("\n")}\n`;
}

function countLabel(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function renderSearch(state: TuiSearchState, theme: TuiTheme): string {
  const style = createPaint(theme);
  const { model } = state;
  const grid = searchLayout(model.viewport);
  const { usable, resultRows: rows, leftWidth: left, rightWidth: right } = grid;
  if (grid.compact)
    return [
      style.title(fit("Lampwright", usable)),
      style.warning(fit("Resize the terminal", usable)),
    ]
      .slice(0, Math.max(0, model.viewport.rows - 1))
      .join("\n");
  const focused = model.results[model.index];
  const preview =
    focused === undefined
      ? []
      : [
          `Owner: ${focused.entry.owner}`,
          `Category: ${focused.category}`,
          `Exposure: ${focused.entry.exposedTo.join(", ") || "none"}`,
          "",
          ...wrapPlanLine(
            focused.entry.description ?? "No description.",
            right,
          ),
          "",
          ...focused.entry.paths.flatMap((path) =>
            wrapPlanLine(`Path: ${path}`, right),
          ),
        ];
  const out = [
    fitStyledSegments(
      [
        { text: "Lampwright", paint: style.title },
        { text: " search  ", paint: style.muted },
        {
          text:
            model.staged.size === 0
              ? "nothing staged"
              : `${String(model.staged.size)} staged`,
          paint: model.staged.size === 0 ? style.muted : style.selected,
        },
      ],
      usable,
      style.muted,
    ),
    fitStyledSegments(
      [
        { text: "↑↓", paint: style.title },
        { text: " move · ", paint: style.muted },
        { text: "space", paint: style.title },
        { text: " stage · ", paint: style.muted },
        { text: "ctrl-a", paint: style.title },
        { text: " all · ", paint: style.muted },
        { text: "enter", paint: style.title },
        { text: " done · ", paint: style.muted },
        { text: "esc", paint: style.title },
        { text: " cancel · ", paint: style.muted },
        { text: "ctrl-u", paint: style.title },
        { text: " clear · ", paint: style.muted },
        { text: "ctrl-c", paint: style.title },
        { text: " quit", paint: style.muted },
      ],
      usable,
      style.muted,
    ),
    style.border(`┌${"─".repeat(Math.max(0, usable - 2))}┐`),
    `${style.border("│")}${fitStyledSegments(
      [
        { text: "> ", paint: style.title },
        ...(model.query === ""
          ? [{ text: "type a name regex", paint: style.muted }]
          : [{ text: model.query, paint: style.active }]),
      ],
      Math.max(0, usable - 2),
      style.muted,
    )}${style.border("│")}`,
    style.border(`├${"─".repeat(left)}┬${"─".repeat(right)}┤`),
  ];
  for (let row = 0; row < rows; row += 1) {
    const index = model.scroll + row;
    const result = model.results[index];
    const marker =
      result === undefined
        ? "   "
        : !result.selectable
          ? " - "
          : result.existing
            ? "[x]"
            : model.staged.has(result.entry.key)
              ? "[+]"
              : "[ ]";
    const text = result === undefined ? "" : `${marker} ${result.entry.name}`;
    const leftCell =
      index === model.index
        ? style.focus(fit(text, left))
        : result !== undefined && model.staged.has(result.entry.key)
          ? style.selected(fit(text, left))
          : fit(text, left);
    const rightCell =
      row === 0 && focused !== undefined
        ? style.active(fit(focused.entry.name, right))
        : row > 0 && preview[row - 1] !== undefined
          ? style.muted(fit(preview[row - 1]!, right))
          : fit("", right);
    out.push(
      `${style.border("│")}${leftCell}${style.border("│")}${rightCell}${style.border("│")}`,
    );
  }
  out.push(style.border(`└${"─".repeat(left)}┴${"─".repeat(right)}┘`));
  out.push(
    model.matchError === null
      ? style.muted(
          fit(
            model.notice ??
              `matching ${String(model.results.length)} ${
                model.results.length === 1 ? "Skill" : "Skills"
              }${model.query === "" ? " · all Skills" : ""} · result=${String(model.results.length === 0 ? 0 : model.index + 1)}/${String(model.results.length)}`,
            usable,
          ),
        )
      : style.warning(fit(model.matchError, usable)),
  );
  return out.join("\n");
}

/**
 * The browse frame is a fixed grid.
 *
 * Two rules keep it still. Every line is clipped one column short of the
 * width, because writing into the last cell makes an auto-margin terminal wrap
 * and silently add a row. And text is fitted before it is styled, because
 * fitting strips escape codes when it truncates, which would leave the same
 * column dim on one row and plain on the next.
 */
function renderBrowse(state: TuiBrowseState, theme: TuiTheme): string {
  return renderBrowseLines(state, theme).join("\n");
}

/** 1-based columns for pointer handling, derived from the rendered header. */
export function browseTabHitboxes(state: TuiBrowseState): {
  readonly inventory: readonly [number, number];
  readonly disabled: readonly [number, number];
  readonly trash: readonly [number, number];
} {
  const inventoryStart = "Lampwright ".length + 1;
  const inventoryEnd = inventoryStart + "Inventory".length - 1;
  const disabledStart = inventoryEnd + 4;
  const disabledEnd =
    disabledStart + `Disabled (${String(disabledCount(state))})`.length - 1;
  const trashStart = disabledEnd + 4; // " | " separates the labels.
  const trashEnd =
    trashStart + `Trash (${String(state.operations?.size ?? 0)})`.length - 1;
  return {
    inventory: [inventoryStart, inventoryEnd],
    disabled: [disabledStart, disabledEnd],
    trash: [trashStart, trashEnd],
  };
}

export function renderBrowseLines(
  state: TuiBrowseState,
  theme: TuiTheme = nightfallTheme,
): readonly string[] {
  const style = createPaint(theme);
  const model = state.model;
  const grid = layout(model);
  const { rows, columns, usable, paneRows, detailRows, leftWidth, rightWidth } =
    grid;
  if (rows < grid.headerRows + 4 || columns < 9)
    return renderCompactBrowse(rows, usable, style);
  const view = panes(model);
  const section = currentSection(model);
  const out: string[] = [];
  const isTrash = state.view === "trash";
  const isDisabled = state.view === "disabled";

  const selected = model.selected.size;
  const trashCount = state.operations?.size ?? 0;
  const paneControls = [
    { text: "click", paint: style.title },
    { text: " focus · ", paint: style.muted },
    { text: "tab/shift+tab", paint: style.title },
    { text: " pane · ", paint: style.muted },
    { text: "shift+←→", paint: style.title },
    { text: " width · ", paint: style.muted },
    { text: "shift+↑↓", paint: style.title },
    { text: " height", paint: style.muted },
  ] as const;
  const globalControls = [
    { text: "ctrl-t", paint: style.title },
    { text: " view · ", paint: style.muted },
    { text: "esc", paint: style.title },
    { text: isTrash ? " Inventory · " : " back · ", paint: style.muted },
    { text: "q", paint: style.title },
    { text: " quit", paint: style.muted },
  ] as const;
  const navigationControls = [
    { text: "↑↓/wheel", paint: style.title },
    { text: " move · ", paint: style.muted },
    { text: "space/dbl-click", paint: style.title },
    { text: " select", paint: style.muted },
  ];
  const updateControls = [
    { text: "u", paint: style.title },
    { text: " update", paint: style.muted },
  ] as const;
  const lifecycleControls = isDisabled
    ? updateControls
    : [
        { text: "enter", paint: style.title },
        { text: " remove · ", paint: style.muted },
        ...updateControls,
      ];
  out.push(
    `${style.title("Lampwright")} ${state.view === "inventory" || state.view === undefined ? style.selected("Inventory") : style.muted("Inventory")} ${style.muted("|")} ${isDisabled ? style.selected(`Disabled (${String(disabledCount(state))})`) : style.muted(`Disabled (${String(disabledCount(state))})`)} ${style.muted("|")} ${state.view === "trash" ? style.selected(`Trash (${String(trashCount)})`) : style.muted(`Trash (${String(trashCount)})`)}  ${
      isTrash
        ? style.muted("read-only recovery")
        : selected > 0
          ? style.selected(`${String(selected)} selected`)
          : style.muted("nothing selected")
    }`,
  );
  out.push(
    isTrash
      ? fitStyledSegments(
          [
            { text: "↑↓/wheel", paint: style.title },
            { text: " move · ", paint: style.muted },
            { text: "enter/dbl-click", paint: style.title },
            { text: " restore · ", paint: style.muted },
            { text: "p", paint: style.title },
            { text: " purge", paint: style.muted },
          ],
          usable,
          style.muted,
        )
      : model.focus === "detail"
        ? fitStyledSegments(
            [
              { text: "↑↓/wheel", paint: style.title },
              { text: " scroll · ", paint: style.muted },
              { text: "PgUp/PgDn", paint: style.title },
              { text: " page", paint: style.muted },
            ],
            usable,
            style.muted,
          )
        : fitPrioritizedStyledSegments(
            [
              ...navigationControls,
              ...(isDisabled
                ? []
                : [
                    { text: " · enter", paint: style.title },
                    { text: " remove", paint: style.muted },
                  ]),
              { text: " · u", paint: style.title },
              { text: " update", paint: style.muted },
            ],
            navigationControls,
            lifecycleControls,
            updateControls,
            usable,
            { text: " · ", paint: style.muted },
            style.muted,
          ),
  );
  out.push(fitStyledSegments(paneControls, usable, style.muted));
  out.push(
    isTrash
      ? fitStyledSegments(
          [
            ...globalControls,
            { text: " · recoverable · reviews read-only", paint: style.muted },
          ],
          usable,
          style.muted,
        )
      : model.query === ""
        ? fitStyledSegments(
            [
              ...globalControls,
              { text: " · ", paint: style.muted },
              ...(isDisabled
                ? [
                    { text: "e", paint: style.title },
                    { text: " enable · ", paint: style.muted },
                  ]
                : [
                    { text: "d", paint: style.title },
                    { text: " disable · ", paint: style.muted },
                  ]),
              { text: "/", paint: style.title },
              { text: " regex search · ", paint: style.muted },
              { text: "ctrl-u", paint: style.title },
              { text: " clear", paint: style.muted },
            ],
            usable,
            style.muted,
          )
        : fitStyledSegments(
            [
              ...globalControls,
              { text: " · filter ", paint: style.muted },
              { text: model.query, paint: style.active },
              {
                text: ` · ${String(view.entries.total)} here`,
                paint: style.muted,
              },
            ],
            usable,
            style.muted,
          ),
  );
  out.push(
    style.border(
      `${"─".repeat(leftWidth)}┬${"─".repeat(usable - leftWidth - 1)}`,
    ),
  );

  for (let row = 0; row < paneRows; row += 1) {
    out.push(
      `${sectionCell(model, view.sections, row, leftWidth, style, isTrash)}${style.border("│")}${entryCell(
        model,
        view.entries,
        section,
        row,
        rightWidth,
        style,
        isTrash,
      )}${scrollMark(view.entries, row, style)}`,
    );
  }

  out.push(
    (model.focus === "detail" ? style.title : style.border)(
      `${"─".repeat(leftWidth)}┴${"─".repeat(usable - leftWidth - 1)}`,
    ),
  );

  const detail = detailPane(model);
  for (let row = 0; row < detailRows; row += 1) {
    const line = detail.items[row];
    const paint =
      line?.kind === "heading"
        ? style.active
        : line?.kind === "path"
          ? style.path
          : plain;
    out.push(
      `${line === undefined ? " ".repeat(Math.max(0, usable - 1)) : paint(fit(line.text, Math.max(0, usable - 1)))}${scrollMark(detail, row, style)}`,
    );
  }

  out.push(
    model.notice === null ? "" : style.info(fit(`! ${model.notice}`, usable)),
  );

  return out.map((line) => fit(line, usable));
}

function sectionCell(
  model: TuiBrowseState["model"],
  view: TuiPaneView<TuiSection>,
  row: number,
  width: number,
  style: TuiPaint,
  isTrash = false,
): string {
  const item = view.items[row];
  if (item === undefined) return " ".repeat(width);
  const index = view.offset + row;
  const focused = index === model.sectionIndex;
  const counted = item.entries.filter(
    (entry) => entry.rowKind !== "plugin-skill",
  );
  const selectable = counted.filter(
    (entry) => entry.selectable ?? entry.target !== null,
  );
  const taken = selectable.filter((entry) =>
    model.selected.has(entry.key),
  ).length;
  const marker = isTrash
    ? " • "
    : !item.selectable
      ? " - "
      : taken === 0
        ? "[ ]"
        : taken === selectable.length
          ? "[x]"
          : "[~]";
  const count =
    taken > 0
      ? `${String(taken)}/${String(selectable.length)}`
      : String(counted.length);
  const text = `${marker} ${fit(item.label, width - 12)} ${fit(count, 6)} `;
  if (focused && model.focus === "sections")
    return style.focus(fit(text, width));
  if (focused) return style.active(fit(text, width));
  return taken > 0 ? style.selected(fit(text, width)) : fit(text, width);
}

function entryCell(
  model: TuiBrowseState["model"],
  view: TuiPaneView<TuiEntry>,
  section: TuiSection | null,
  row: number,
  width: number,
  style: TuiPaint,
  isTrash = false,
): string {
  if (width <= 0) return "";
  if (row === 0) {
    if (section === null) return " ".repeat(width);
    const exposure = sharedExposure(section);
    const paths = sharedPathCount(section);
    const pluginSkills = section.entries.filter(
      (entry) => entry.rowKind === "plugin-skill",
    ).length;
    const boundaries = section.entries.length - pluginSkills;
    const entrySummary =
      pluginSkills === 0
        ? `${String(section.entries.length)} entries`
        : `${String(boundaries)} ${boundaries === 1 ? "Plugin" : "Plugins"} · ${String(pluginSkills)} Skills`;
    const detail = [
      entrySummary,
      section.detail,
      paths === null || paths <= 1 ? null : `${String(paths)} paths each`,
      exposure === null || exposure === "" ? null : exposure,
    ]
      .filter((value): value is string => value !== null)
      .join(" · ");
    const label = Math.min(24, width);
    return `${style.title(fit(section.label, label))}${style.muted(fit(` ${detail}`, width - label))}`;
  }

  const entry = view.items[row - 1];
  if (entry === undefined) return " ".repeat(width);
  const index = view.offset + row - 1;
  const focused = index === model.entryIndex && model.focus === "entries";
  const selectable = entry.selectable ?? entry.target !== null;
  const marker =
    entry.rowKind === "plugin-skill"
      ? "   "
      : isTrash
        ? " • "
        : section !== null && (!section.selectable || !selectable)
          ? " - "
          : model.selected.has(entry.key)
            ? "[x]"
            : "[ ]";
  const displayName =
    entry.rowKind === "plugin-skill"
      ? `${entry.treeBranch === "last" ? "└─" : "├─"} ${entry.name}`
      : entry.name;
  if (width < 11) {
    const compact = fit(`${marker} ${displayName}`, width);
    if (focused) return style.focus(compact);
    return model.selected.has(entry.key) ? style.selected(compact) : compact;
  }
  const exposure = section === null ? null : sharedExposure(section);
  const differs = exposure === null || entry.exposedTo.join(" ") !== exposure;
  const exposureNote = entry.exposedTo.join(" ");
  const note =
    entry.showNoteInRow === false
      ? ""
      : [
          entry.note,
          differs && !(entry.note?.includes(exposureNote) ?? false)
            ? exposureNote
            : null,
        ]
          .filter((value): value is string => value !== null && value !== "")
          .join(" · ");
  const nameWidth = Math.max(6, Math.min(44, width - 22));
  const head = `${marker} ${fit(displayName, nameWidth)} `;
  const tail = fit(note, Math.max(0, width - nameWidth - 5));
  if (focused) return style.focus(fit(head + tail, width));
  const styledHead = model.selected.has(entry.key)
    ? style.selected(fit(head, nameWidth + 5))
    : fit(head, nameWidth + 5);
  return `${styledHead}${style.muted(tail)}`;
}

function disabledCount(state: TuiBrowseState): number {
  if (state.view === "disabled") return disabledRows(state.model.sections);
  const snapshot = state.viewSnapshots?.disabled;
  if (snapshot !== undefined) return disabledRows(snapshot.model.sections);
  const native = state.inventory.installations.reduce(
    (count, installation) =>
      count +
      installation.harnessExposures.filter(
        (exposure) => exposure.status === "disabled",
      ).length,
    0,
  );
  const plugins = state.inventory.plugins.filter(
    (plugin) => plugin.availability.status === "disabled",
  ).length;
  return native + plugins + (state.disabledEntries?.length ?? 0);
}

function disabledRows(sections: readonly TuiSection[]): number {
  const disabled = sections
    .filter((section) => section.key.startsWith("disabled-"))
    .reduce((count, section) => count + section.entries.length, 0);
  const plugins =
    sections
      .find((section) => section.key === "plugins")
      ?.entries.filter((entry) => entry.rowKind !== "plugin-skill").length ?? 0;
  return disabled + plugins;
}

function renderCompactBrowse(
  rows: number,
  usable: number,
  style: TuiPaint,
): readonly string[] {
  const lines = [
    style.title("Lampwright"),
    style.warning("Resize the terminal"),
    style.muted("q quit"),
  ];
  return lines.slice(0, Math.max(0, rows - 1)).map((line) => fit(line, usable));
}

function scrollMark(
  pane: TuiPaneView<unknown>,
  row: number,
  style: TuiPaint,
): string {
  if (pane.total <= pane.height) return " ";
  const span = Math.max(
    1,
    Math.round((pane.height / pane.total) * pane.height),
  );
  const start = Math.round((pane.offset / pane.total) * pane.height);
  return row >= start && row < start + span
    ? style.path("▕")
    : style.border("│");
}

const escape = String.fromCharCode(27);
const ansi = new RegExp(`${escape}\\[[0-9;]*m`, "gu");
const stripAnsi = (value: string): string => value.replace(ansi, "");
const visibleLength = (value: string): number => [...stripAnsi(value)].length;
const plain = (value: string): string => value;

type TuiPaint = Readonly<Record<TuiStyleRole, (value: string) => string>>;

function createPaint(theme: TuiTheme): TuiPaint {
  const paint =
    (role: TuiStyleRole) =>
    (value: string): string =>
      styleTui(theme, role, value);
  return {
    title: paint("title"),
    active: paint("active"),
    muted: paint("muted"),
    border: paint("border"),
    focus: paint("focus"),
    selected: paint("selected"),
    success: paint("success"),
    info: paint("info"),
    warning: paint("warning"),
    error: paint("error"),
    path: paint("path"),
  };
}

function fitStyledSegments(
  segments: readonly {
    readonly text: string;
    readonly paint: (value: string) => string;
  }[],
  width: number,
  paintEllipsis: (value: string) => string,
): string {
  if (width <= 0) return "";
  const length = segments.reduce(
    (total, segment) => total + [...segment.text].length,
    0,
  );
  const truncated = length > width;
  let remaining = truncated ? width - 1 : width;
  let result = "";
  for (const segment of segments) {
    if (remaining <= 0) break;
    const characters = [...segment.text];
    const visible = characters.slice(0, remaining).join("");
    result += segment.paint(visible);
    remaining -= Math.min(characters.length, remaining);
  }
  if (truncated) return result + paintEllipsis("…");
  return result + " ".repeat(remaining);
}

function fitPrioritizedStyledSegments(
  wideSegments: readonly {
    readonly text: string;
    readonly paint: (value: string) => string;
  }[],
  secondarySegments: readonly {
    readonly text: string;
    readonly paint: (value: string) => string;
  }[],
  lifecycleSegments: readonly {
    readonly text: string;
    readonly paint: (value: string) => string;
  }[],
  requiredSegments: readonly {
    readonly text: string;
    readonly paint: (value: string) => string;
  }[],
  width: number,
  separator: {
    readonly text: string;
    readonly paint: (value: string) => string;
  },
  paintEllipsis: (value: string) => string,
): string {
  const wideLength = wideSegments.reduce(
    (total, segment) => total + [...segment.text].length,
    0,
  );
  if (wideLength <= width)
    return fitStyledSegments(wideSegments, width, paintEllipsis);

  const lifecycleLength = lifecycleSegments.reduce(
    (total, segment) => total + [...segment.text].length,
    0,
  );
  if (width < lifecycleLength)
    return fitStyledSegments(requiredSegments, width, paintEllipsis);

  const separatorLength = [...separator.text].length;
  if (width < lifecycleLength + separatorLength + 1)
    return fitStyledSegments(lifecycleSegments, width, paintEllipsis);
  const secondaryWidth = width - lifecycleLength - separatorLength;
  return `${fitStyledSegments(
    lifecycleSegments,
    lifecycleLength,
    paintEllipsis,
  )}${separator.paint(separator.text)}${fitStyledSegments(
    secondarySegments,
    secondaryWidth,
    paintEllipsis,
  )}`;
}

/** Fits to an exact visible width. Styling is applied after, never before. */
function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const length = visibleLength(value);
  if (length === width) return value;
  if (length < width) return value + " ".repeat(width - length);
  return `${[...stripAnsi(value)].slice(0, Math.max(0, width - 1)).join("")}…`;
}

function renderPlan(state: TuiPlanState, style: TuiPaint): string {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return renderCompactPlan(state, style);
  const body = planBodyLines(state, style);
  const footer = planFooterLines(state, style);
  const metrics = planScrollMetricsFor(state, body.length, footer.length);
  const offset = Math.min(
    Math.max(0, state.scrollOffset),
    metrics.maximumOffset,
  );
  const overflow = metrics.maximumOffset > 0;
  const visibleBody = overflow
    ? body.slice(offset, offset + metrics.pageRows)
    : body;
  const range = overflow
    ? [
        style.muted(
          `review ${String(offset + 1)}-${String(Math.min(body.length, offset + metrics.pageRows))}/${String(body.length)}  ↑↓/PgUp/PgDn scroll`,
        ),
      ]
    : [];
  const width = Math.max(0, state.browse.model.viewport.columns - 1);
  return `${[...visibleBody, ...range, ...footer]
    .slice(0, Math.max(0, state.browse.model.viewport.rows - 1))
    .map((line) => fit(line, width))
    .join("\n")}\n`;
}

function renderCompactPlan(state: TuiPlanState, style: TuiPaint): string {
  const rows = Math.max(0, state.browse.model.viewport.rows - 1);
  const width = Math.max(0, state.browse.model.viewport.columns - 1);
  return `${[
    style.title("Lampwright"),
    style.warning("Resize the terminal"),
    style.muted("q quit"),
  ]
    .slice(0, rows)
    .map((line) => fit(line, width))
    .join("\n")}\n`;
}

function planBodyLines(state: TuiPlanState, style: TuiPaint): string[] {
  const removalPlan = state.plan;
  const ready = removalPlan.blocks.length === 0;
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const lines = [
    style.title("Lampwright — Review removal"),
    "",
    style.title(`Remove ${state.label}?`),
    "",
    !ready
      ? style.error("CANNOT REMOVE")
      : removalPlan.warnings.length > 0
        ? style.warning("REVIEW BEFORE REMOVING")
        : style.success("READY TO REMOVE"),
    ...(ready && removalPlan.warnings.length === 0
      ? [style.muted("No blockers or warnings were found.")]
      : []),
    "",
    ...(removalPlan.blocks.length === 0
      ? []
      : [
          style.error("Why it cannot be removed"),
          ...wrapPlanLines(
            removalPlan.blocks.flatMap(describePlainBlock),
            width,
          ).map(style.error),
          "",
        ]),
    ...(removalPlan.warnings.length === 0
      ? []
      : [
          style.warning(
            removalPlan.warnings.length === 1
              ? "Review this warning"
              : "Review these warnings",
          ),
          ...removalPlan.warnings
            .flatMap(describePlainWarning)
            .flatMap((line) => wrapPlanLine(line, width))
            .map(style.warning),
          "",
        ]),
    ...(removalPlan.actions.length === 0
      ? []
      : [
          style.title("What will happen"),
          ...plainActionGroups(removalPlan.actions).flatMap((actions, index) =>
            wrapPlanLines(describePlainActions(state, actions, index), width),
          ),
          "",
        ]),
    ...(removalPlan.verificationChecks.length === 0
      ? []
      : [
          style.title("After removal, Lampwright will verify"),
          ...plainVerificationGroups(removalPlan.verificationChecks).flatMap(
            (checks) =>
              wrapPlanLine(
                `  • ${describePlainVerifications(state, checks)}`,
                width,
              ),
          ),
          "",
        ]),
  ];
  if (state.technicalDetails)
    lines.push(...technicalPlanLines(removalPlan, style, width), "");
  return lines;
}

function planFooterLines(state: TuiPlanState, style: TuiPaint): string[] {
  const removalPlan = state.plan;
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const lines: string[] = [];
  if (removalPlan.blocks.length === 0) {
    const hasManagedRemoval = removalPlan.actions.some(
      (action) => action.kind === "managed-removal",
    );
    const hasRecoverableRemoval = removalPlan.actions.some(
      (action) => action.kind === "quarantine",
    );
    const recoveryMessage =
      removalPlan.intent.mode === "brute-force"
        ? "This is a separate recoverable removal after the managed attempt failed."
        : hasManagedRemoval
          ? "Managed removal is not recoverable by Lampwright and will not enter Trash. A failed managed removal will stop; any brute-force fallback must be reviewed and confirmed separately."
          : hasRecoverableRemoval
            ? "Files are not permanently deleted. They can be restored from Trash."
            : "No filesystem content will be permanently deleted.";
    const recoveryStyle =
      removalPlan.intent.mode === "brute-force" ? style.warning : style.muted;
    lines.push(
      style.success("Nothing has changed yet."),
      ...wrapPlanLine(recoveryMessage, width).map(recoveryStyle),
      ...planControlLines(state, style, "ready"),
    );
  } else if (removalPlan.blocks.every((block) => block.overridable)) {
    lines.push(
      style.warning("This plan is blocked and cannot execute as shown."),
      ...planControlLines(state, style, "force"),
    );
  } else {
    lines.push(
      style.error(
        "This plan contains a non-overridable block and cannot execute.",
      ),
      ...planControlLines(state, style, "blocked"),
    );
  }
  return lines;
}

function planControlLines(
  state: TuiPlanState,
  style: TuiPaint,
  kind: "ready" | "force" | "blocked",
): readonly string[] {
  const details = state.technicalDetails
    ? "hide technical details"
    : "technical details";
  if (kind === "ready") {
    const first =
      style.title("y") +
      style.muted(" remove   ") +
      style.title("Esc") +
      style.muted(" go back");
    const second =
      style.title("d") +
      style.muted(` ${details}   `) +
      style.title("q") +
      style.muted(" quit");
    return state.browse.model.viewport.columns < 72
      ? [first, second]
      : [first + style.muted("   ") + second];
  }
  if (kind === "force")
    return [
      style.title("f") + style.muted(" review removal despite these risks"),
      style.title("d") + style.muted(` ${details}`),
      style.title("Esc") +
        style.muted(" go back   ") +
        style.title("q") +
        style.muted(" quit"),
    ];
  return [
    style.title("d") + style.muted(` ${details}`),
    style.title("Esc") +
      style.muted(" return to inventory   ") +
      style.title("q") +
      style.muted(" quit"),
  ];
}

export function planScrollMetrics(state: TuiPlanState): {
  readonly pageRows: number;
  readonly maximumOffset: number;
} {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return { pageRows: 0, maximumOffset: 0 };
  const style = createPaint(plainTuiTheme);
  return planScrollMetricsFor(
    state,
    planBodyLines(state, style).length,
    planFooterLines(state, style).length,
  );
}

function planScrollMetricsFor(
  state: TuiPlanState,
  bodyRows: number,
  footerRows: number,
): { readonly pageRows: number; readonly maximumOffset: number } {
  const usableRows = Math.max(0, state.browse.model.viewport.rows - 1);
  const overflows = bodyRows + footerRows > usableRows;
  const pageRows = Math.max(
    0,
    usableRows - Math.min(footerRows, usableRows) - (overflows ? 1 : 0),
  );
  return {
    pageRows,
    maximumOffset: Math.max(0, bodyRows - pageRows),
  };
}

function technicalPlanLines(
  plan: RemovalPlan,
  style: TuiPaint,
  width: number,
): readonly string[] {
  return [
    style.info("Technical details"),
    ...wrapPlanLine(`Plan: ${plan.id}`, width).map(style.muted),
    style.info(`Targets (${plan.targets.length}):`),
    ...wrapPlanLines(indented(plan.targets.map(describeTarget)), width),
    style.info(`Actions (${plan.actions.length}):`),
    ...wrapPlanLines(indented(plan.actions.map(describeAction)), width),
    style.info(`Blocks (${plan.blocks.length}):`),
    ...wrapPlanLines(indented(orNone(plan.blocks.map(describeBlock))), width),
    style.info(`Warnings (${plan.warnings.length}):`),
    ...wrapPlanLines(
      indented(orNone(plan.warnings.map(describeWarning))),
      width,
    ),
    style.info(`Verification (${plan.verificationChecks.length}):`),
    ...wrapPlanLines(
      indented(orNone(plan.verificationChecks.map(describeVerification))),
      width,
    ),
    style.info("Approvals:"),
    ...wrapPlanLines(
      indented(orNone(planApprovals(plan).map(describeApproval))),
      width,
    ),
  ];
}

function wrapPlanLines(
  lines: readonly string[],
  width: number,
): readonly string[] {
  return lines.flatMap((line) => wrapPlanLine(line, width));
}

function wrapPlanLine(value: string, width: number): readonly string[] {
  if (width <= 0 || [...value].length <= width) return [value];
  const indentation = value.match(/^\s*/u)?.[0] ?? "";
  const result: string[] = [];
  let remaining = value;

  while ([...remaining].length > width) {
    const characters = [...remaining];
    const candidate = characters.slice(0, width).join("");
    const lastSpace = candidate.search(/\s+\S*$/u);
    const lastPathSeparator = Math.max(
      candidate.lastIndexOf("/") + 1,
      candidate.lastIndexOf("\\") + 1,
    );
    const minimumUsefulBreak = Math.max(
      indentation.length + 1,
      Math.floor(width / 2),
    );
    const preferredBreak = Math.max(lastSpace, lastPathSeparator);
    const cut = preferredBreak >= minimumUsefulBreak ? preferredBreak : width;
    result.push(characters.slice(0, cut).join("").trimEnd());
    remaining = `${indentation}${characters.slice(cut).join("").trimStart()}`;
  }
  result.push(remaining);
  return result;
}

function plainActionGroups(
  actions: readonly RemovalAction[],
): readonly (readonly RemovalAction[])[] {
  const groups: RemovalAction[][] = [];
  let previousKey: string | null = null;
  for (const action of actions) {
    const key = plainActionGroupKey(action);
    const group = groups.at(-1);
    if (group === undefined || key !== previousKey) groups.push([action]);
    else group.push(action);
    previousKey = key;
  }
  return groups;
}

function plainActionGroupKey(action: RemovalAction): string {
  if (action.kind === "quarantine") return action.kind;
  if (action.kind === "record-cleanup")
    return `${action.kind}:${action.format}`;
  const owner =
    action.owner.kind === "manager"
      ? `manager:${action.owner.managerId}`
      : `plugin:${action.owner.pluginId}`;
  return `${action.kind}:${owner}`;
}

function describePlainActions(
  state: TuiPlanState,
  actions: readonly RemovalAction[],
  index: number,
): readonly string[] {
  const action = actions[0]!;
  if (actions.length === 1) return describePlainAction(state, action, index);
  const prefix = `  ${String(index + 1)}. `;
  const count = affectedInstallationCount(actions);
  const capabilities = `${String(count)} selected ${count === 1 ? "capability" : "capabilities"}`;
  if (action.kind === "quarantine")
    return [
      `${prefix}Move ${capabilities} to Trash`,
      stylelessDetail(
        `From ${String(actions.length)} original ${actions.length === 1 ? "location" : "locations"}.`,
      ),
      stylelessDetail("You can restore them later."),
    ];
  if (action.kind === "managed-removal") {
    const owner =
      action.owner.kind === "manager"
        ? action.owner.managerId
        : `Plugin ${action.owner.pluginId}`;
    return [
      `${prefix}Ask ${owner} to remove ${capabilities}`,
      stylelessDetail(`Uses ${owner}'s supported removal commands.`),
      stylelessDetail(
        "This managed removal will not enter Trash and cannot be restored by Lampwright.",
      ),
    ];
  }
  const records = actions.reduce(
    (total, candidate) =>
      total +
      (candidate.kind === "record-cleanup" ? candidate.records.length : 0),
    0,
  );
  return [
    `${prefix}Update ${String(records)} installation record ${records === 1 ? "entry" : "entries"}`,
    stylelessDetail(
      `Across ${String(actions.length)} record ${actions.length === 1 ? "file" : "files"}.`,
    ),
  ];
}

function affectedInstallationCount(actions: readonly RemovalAction[]): number {
  const installationIds = new Set(
    actions.flatMap((action) => action.affectedInstallationIds),
  );
  return installationIds.size > 0 ? installationIds.size : actions.length;
}

function describePlainAction(
  state: TuiPlanState,
  action: RemovalAction,
  index: number,
): readonly string[] {
  const prefix = `  ${String(index + 1)}. `;
  if (action.kind === "quarantine")
    return [
      `${prefix}Move ${targetLabel(state, action.target)} to Trash`,
      stylelessDetail(`From: ${action.location.path}`),
      stylelessDetail("You can restore it later."),
    ];
  if (action.kind === "managed-removal") {
    const owner =
      action.owner.kind === "manager"
        ? action.owner.managerId
        : `Plugin ${action.owner.pluginId}`;
    return [
      `${prefix}Ask ${owner} to remove ${targetLabel(state, action.target)}`,
      stylelessDetail(`Uses ${owner}'s supported removal command.`),
      stylelessDetail(
        "This managed removal will not enter Trash and cannot be restored by Lampwright.",
      ),
    ];
  }
  return [
    `${prefix}Update the installation record`,
    stylelessDetail(`Record: ${action.location.path}`),
  ];
}

function describePlainBlock(block: PlanBlock): readonly string[] {
  if (block.kind === "hard-dependency")
    return [
      `  • Another installed capability requires this: ${block.dependency.reason}`,
      "    A force override can bypass this dependency block.",
    ];
  if (block.kind === "ambiguous-ownership")
    return [
      `  • Lampwright cannot determine who owns it: ${block.reason}`,
      "    A force override can bypass this ownership block.",
    ];
  if (block.kind === "git-protection")
    return [
      `  • Protected project file: ${block.path}`,
      "    This protection cannot be bypassed.",
    ];
  if (block.kind === "system-skill")
    return [
      `  • This is a built-in System Skill supplied by ${block.agentId}.`,
      "    System Skills cannot be removed.",
    ];
  if (block.kind === "runtime-default-plugin")
    return [
      `  • Plugin ${block.pluginId} is supplied by ${block.exposedTo.join(", ") || "its agent harness"}.`,
      "    Runtime-default Plugins cannot be removed.",
    ];
  if (block.kind === "filesystem-permission")
    return [
      `  • Lampwright cannot modify ${block.path}: ${block.reason}`,
      "    Fix the filesystem permission before trying again.",
    ];
  if (block.kind === "cleanup-conflict")
    return [
      `  • The removal record changed at ${block.path}: ${block.reason}`,
      "    Scan again before trying to remove it.",
    ];
  if (block.kind === "adapter-trust")
    return [
      `  • The local adapter ${block.adapterId} is not trusted to run removal commands.`,
    ];
  if (block.kind === "plugin-boundary")
    return [
      `  • This capability belongs to Plugin ${block.pluginId}. Select that Plugin to review its full impact.`,
    ];
  return [
    `  • The managing tool cannot remove this capability: ${block.reason}`,
  ];
}

function describePlainWarning(warning: PlanWarning): readonly string[] {
  if (warning.kind === "soft-reference")
    return [
      `  • Another installed capability may refer to this: ${warning.reference.evidence}`,
    ];
  if (warning.kind === "plugin-impact")
    return [
      `  • Removing Plugin ${warning.pluginId} also affects: ${warning.affectedResources.map(describePluginResource).join(", ") || "other Plugin resources"}`,
    ];
  if (warning.kind === "ephemeral-download") {
    const item = warning.packageExecution;
    return [
      `  • May download ${item.packageName}@${item.packageVersion} using ${item.runner}.`,
      `    Adapter identity: ${item.adapterHash}`,
    ];
  }
  return [
    `  • The managing tool may still list this capability after removal: ${warning.reason}`,
  ];
}

function describePluginResource(resource: string): string {
  if (resource.startsWith("skill:")) {
    const nameEnd = resource.indexOf(":", "skill:".length);
    const name =
      nameEnd === -1
        ? resource.slice("skill:".length)
        : resource.slice(6, nameEnd);
    return `Skill ${name}`;
  }
  const separator = resource.indexOf(":");
  if (separator === -1) return resource;
  const kind = resource.slice(0, separator);
  const id = resource.slice(separator + 1);
  const label =
    kind === "agent"
      ? "Agent"
      : kind === "command"
        ? "Command"
        : kind === "hook"
          ? "Hook"
          : kind === "configuration"
            ? "Configuration"
            : kind === "plugin"
              ? "Plugin"
              : "Other resource";
  return `${label} ${id}`;
}

function stylelessDetail(value: string): string {
  return `     ${value}`;
}

function describePlainVerification(
  state: TuiPlanState,
  check: VerificationCheck,
): string {
  if (
    check.kind === "target-unavailable" &&
    check.target.kind === "source-group" &&
    /^\d+ selected capabilities$/u.test(state.label)
  )
    return `All ${state.label} are no longer available to agents`;
  if (check.kind === "target-unavailable")
    return `${targetLabel(state, check.target)} is no longer available to agents`;
  if (check.kind === "path-absent")
    return `The original location is no longer active: ${check.path}`;
  if (check.kind === "owner-state-absent")
    return "The managing tool no longer reports the capability as installed";
  if (check.kind === "record-absent")
    return "The installation record no longer lists the capability";
  return "The removal command succeeds";
}

function plainVerificationGroups(
  checks: readonly VerificationCheck[],
): readonly (readonly VerificationCheck[])[] {
  const groups = new Map<VerificationCheck["kind"], VerificationCheck[]>();
  for (const check of checks) {
    const group = groups.get(check.kind);
    if (group === undefined) groups.set(check.kind, [check]);
    else group.push(check);
  }
  return [...groups.values()];
}

function describePlainVerifications(
  state: TuiPlanState,
  checks: readonly VerificationCheck[],
): string {
  const check = checks[0]!;
  if (checks.length === 1) return describePlainVerification(state, check);
  const count = String(checks.length);
  if (check.kind === "path-absent")
    return `All ${count} original locations are no longer active`;
  if (check.kind === "target-unavailable")
    return `All ${count} selected capabilities are no longer available to agents`;
  if (check.kind === "owner-state-absent")
    return `Managing tools no longer report ${count} selected capabilities as installed`;
  if (check.kind === "record-absent")
    return `All ${count} installation record entries no longer list the selected capabilities`;
  return `All ${count} removal verification commands succeed`;
}

function targetLabel(state: TuiPlanState, target: RemovalTarget): string {
  const inventory = state.browse.inventory;
  if (target.kind === "installation")
    return (
      inventory.installations.find(
        (installation) => installation.id === target.installationId,
      )?.skill.name ?? state.label
    );
  if (target.kind === "logical-skill")
    return (
      inventory.logicalSkills.find(
        (logicalSkill) => logicalSkill.id === target.logicalSkillId,
      )?.skill.name ?? state.label
    );
  if (target.kind === "source-group")
    return (
      inventory.groups.find((group) => group.id === target.groupId)?.label ??
      state.label
    );
  return (
    inventory.plugins.find((plugin) => plugin.id === target.pluginBoundaryId)
      ?.pluginId ?? state.label
  );
}

function renderReport(state: TuiReportState, style: TuiPaint): string {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return renderCompactReport(state, style);
  const body = reportBodyLines(state, style);
  const footer = reportFooterLines(state, style);
  const metrics = reportScrollMetricsFor(state, body.length, footer.length);
  const offset = Math.min(
    Math.max(0, state.scrollOffset),
    metrics.maximumOffset,
  );
  const visible =
    metrics.maximumOffset > 0
      ? body.slice(offset, offset + metrics.pageRows)
      : body;
  const range =
    metrics.maximumOffset > 0
      ? [
          style.muted(
            `report ${String(offset + 1)}-${String(Math.min(body.length, offset + metrics.pageRows))}/${String(body.length)}  ↑↓/PgUp/PgDn scroll`,
          ),
        ]
      : [];
  const width = Math.max(0, state.browse.model.viewport.columns - 1);
  return `${[...visible, ...range, ...footer]
    .slice(0, Math.max(0, state.browse.model.viewport.rows - 1))
    .map((line) => fit(line, width))
    .join("\n")}\n`;
}

export function reportScrollMetrics(state: TuiReportState): {
  readonly pageRows: number;
  readonly maximumOffset: number;
} {
  if (
    state.browse.model.viewport.rows < 7 ||
    state.browse.model.viewport.columns < 20
  )
    return { pageRows: 0, maximumOffset: 0 };
  const style = createPaint(plainTuiTheme);
  return reportScrollMetricsFor(
    state,
    reportBodyLines(state, style).length,
    reportFooterLines(state, style).length,
  );
}

function reportScrollMetricsFor(
  state: TuiReportState,
  bodyRows: number,
  footerRows: number,
): { readonly pageRows: number; readonly maximumOffset: number } {
  const usableRows = Math.max(0, state.browse.model.viewport.rows - 1);
  const overflows = bodyRows + footerRows > usableRows;
  const pageRows = Math.max(
    0,
    usableRows - Math.min(footerRows, usableRows) - (overflows ? 1 : 0),
  );
  return { pageRows, maximumOffset: Math.max(0, bodyRows - pageRows) };
}

function reportBodyLines(state: TuiReportState, style: TuiPaint): string[] {
  const { report } = state;
  const width = Math.max(1, state.browse.model.viewport.columns - 1);
  const outcome =
    report.status === "succeeded"
      ? "Completed"
      : report.status === "partial"
        ? "Completed with concerns"
        : report.status === "blocked"
          ? "Blocked"
          : "Could not complete";
  const outcomeStyle =
    report.status === "succeeded"
      ? style.success
      : report.status === "partial"
        ? style.warning
        : style.error;
  const removed = report.targetResults.filter(
    (item) => item.status === "removed",
  ).length;
  const unchanged = report.targetResults.filter(
    (item) => item.status === "unchanged",
  ).length;
  const unresolved = report.targetResults.filter(
    (item) => item.status !== "removed" && item.status !== "unchanged",
  );
  const actionSuccess = report.actionResults.filter(
    (item) => item.status === "succeeded" || item.status === "unchanged",
  ).length;
  const trashRetention = report.actionResults
    .map((item) => ("details" in item ? item.details : undefined))
    .filter((details) => details?.enteredTrash === true)
    .map((details) => details?.retentionExpiresAt)
    .filter((value): value is string => typeof value === "string");
  const checkPass = report.verificationResults.filter(
    (item) => item.status === "passed",
  ).length;
  const concerns = [
    ...condenseTargetConcerns(state, unresolved),
    ...condenseReportConcerns(
      report.actionResults
        .filter(
          (item) => item.status !== "succeeded" && item.status !== "unchanged",
        )
        .map(
          (item) =>
            `An approved removal ${item.status}: ${actionResultReason(item)}`,
        ),
    ),
    ...condenseReportConcerns(
      report.verificationResults
        .filter((item) => item.status !== "passed")
        .map(
          (item) =>
            `Verification ${item.status}: ${verificationResultReason(item)}`,
        ),
    ),
    ...(report.rescanError === null
      ? []
      : [`• Final scan could not finish: ${report.rescanError.message}`]),
  ];
  const lines = [
    style.title("Lampwright — Final report"),
    "",
    outcomeStyle(outcome),
    ...wrapPlanLine(
      removed > 0
        ? removed === 1
          ? `${state.label} removed.`
          : `${countLabel(removed, "capability")} removed.`
        : "No capabilities were removed.",
      width,
    ).map(removed > 0 ? style.success : outcomeStyle),
    ...(unchanged > 0
      ? [
          style.muted(
            unchanged === 1
              ? `${state.label} remained unchanged.`
              : `${countLabel(unchanged, "capability")} remained unchanged.`,
          ),
        ]
      : []),
    report.rescanError === null
      ? style.success("Final scan completed.")
      : style.error("Final scan could not be completed."),
    ...(report.verificationResults.length === 0
      ? []
      : [
          style.muted(
            `${String(checkPass)} of ${String(report.verificationResults.length)} verification checks passed.`,
          ),
        ]),
    ...(actionSuccess === 0
      ? []
      : [
          style.muted(
            `${countLabel(actionSuccess, "approved removal")} finished.`,
          ),
        ]),
    ...(trashRetention.length === 0
      ? []
      : [
          style.info(
            `Content entered Trash and is recoverable until ${trashRetention.sort()[0]}.`,
          ),
        ]),
    ...(concerns.length === 0
      ? []
      : [
          "",
          style.warning("What still needs attention"),
          ...wrapPlanLines(concerns, width).map(style.warning),
        ]),
  ];
  if (state.technicalDetails)
    lines.push("", ...technicalReportLines(state, style, width));
  return lines;
}

function condenseReportConcerns(values: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) =>
    count === 1 ? `• ${value}` : `• ${String(count)} items: ${value}`,
  );
}

function condenseTargetConcerns(
  state: TuiReportState,
  results: readonly import("../model/types.js").TargetResult[],
): readonly string[] {
  const groups = new Map<string, string[]>();
  for (const result of results) {
    const reason = targetResultReason(result);
    const names = groups.get(reason) ?? [];
    names.push(reportTargetLabel(state, result.target));
    groups.set(reason, names);
  }
  return [...groups].map(([reason, names]) =>
    names.length === 1
      ? `• ${names[0]}: ${reason}`
      : `• ${String(names.length)} capabilities: ${reason}`,
  );
}

function renderCompactReport(state: TuiReportState, style: TuiPaint): string {
  const rows = Math.max(0, state.browse.model.viewport.rows - 1);
  const width = Math.max(0, state.browse.model.viewport.columns - 1);
  return `${[
    style.title("Lampwright"),
    style.warning("Resize the terminal"),
    style.muted("q quit"),
  ]
    .slice(0, rows)
    .map((line) => fit(line, width))
    .join("\n")}\n`;
}

function targetResultReason(
  result: import("../model/types.js").TargetResult,
): string {
  return "reason" in result ? result.reason : "did not finish";
}

function actionResultReason(
  result: import("../model/types.js").ActionResult,
): string {
  return "error" in result
    ? result.error.message
    : "reason" in result
      ? result.reason
      : "did not finish";
}

function verificationResultReason(
  result: import("../model/types.js").VerificationResult,
): string {
  return "error" in result
    ? result.error.message
    : "reason" in result
      ? result.reason
      : "did not finish";
}

function reportFooterLines(state: TuiReportState, style: TuiPaint): string[] {
  const fallbacks = state.report.fallbackPlans;
  const details = state.technicalDetails
    ? "hide technical details"
    : "technical details";
  const lines: string[] = [""];
  if (fallbacks.length > 0) {
    const selected = fallbacks[state.fallbackCursor]!;
    lines.push(
      style.warning(
        `${countLabel(fallbacks.length, "separate recoverable fallback")} available.`,
      ),
    );
    lines.push(
      style.focus(
        `Fallback ${String(state.fallbackCursor + 1)}/${String(fallbacks.length)}: ${countLabel(selected.targets.length, "target")} · ${countLabel(selected.actions.length, "action")}`,
      ),
    );
    lines.push(
      style.active("←/→ choose fallback   f review selected fallback") +
        style.muted("   Esc/q finish"),
    );
    lines.push(
      style.muted(
        "Fallbacks are never executed automatically; review and confirm each separately.",
      ),
    );
  } else lines.push(style.muted("Esc/q finish"));
  lines.push(style.title("d") + style.muted(` ${details}`));
  return lines;
}

function reportTargetLabel(
  state: TuiReportState,
  target: RemovalTarget,
): string {
  const inventory = state.browse.inventory;
  if (target.kind === "installation")
    return (
      inventory.installations.find((item) => item.id === target.installationId)
        ?.skill.name ?? "selected capability"
    );
  if (target.kind === "logical-skill")
    return (
      inventory.logicalSkills.find((item) => item.id === target.logicalSkillId)
        ?.skill.name ?? "selected capability"
    );
  if (target.kind === "source-group")
    return (
      inventory.groups.find((item) => item.id === target.groupId)?.label ??
      "selected group"
    );
  return (
    inventory.plugins.find((item) => item.id === target.pluginBoundaryId)
      ?.pluginId ?? "selected Plugin"
  );
}

function technicalReportLines(
  state: TuiReportState,
  style: TuiPaint,
  width: number,
): string[] {
  const { report } = state;
  return [
    style.info("Technical details"),
    style.info("Report"),
    ...wrapPlanLine(`Status: ${report.status}`, width).map(style.muted),
    ...wrapPlanLine(`Plan: ${report.planId}`, width).map(style.muted),
    ...wrapPlanLine(`Source inventory: ${report.inventoryId}`, width).map(
      style.muted,
    ),
    ...wrapPlanLine(`Started: ${report.startedAt}`, width).map(style.muted),
    ...wrapPlanLine(`Completed: ${report.completedAt}`, width).map(style.muted),
    ...wrapPlanLine(
      `Final inventory: ${report.finalInventoryId ?? "unavailable"}`,
      width,
    ).map(style.muted),
    style.info(`Targets (${String(report.targetResults.length)})`),
    ...report.targetResults.flatMap((item) =>
      wrapPlanLine(
        `Target ${describeTarget(item.target)} — ${item.status}${"reason" in item ? `: ${item.reason}` : ""}`,
        width,
      ).map(style.muted),
    ),
    style.info(`Actions (${String(report.actionResults.length)})`),
    ...report.actionResults.flatMap((item) => [
      ...wrapPlanLine(
        `Action ${item.actionId} — ${item.status}${"error" in item ? `: ${item.error.code}: ${item.error.message}` : "reason" in item ? `: ${item.reason}` : ""}`,
        width,
      ).map(style.muted),
      ...wrapPlanLine(`  Started: ${item.startedAt}`, width).map(style.muted),
      ...wrapPlanLine(`  Completed: ${item.completedAt}`, width).map(
        style.muted,
      ),
    ]),
    style.info(`Verification (${String(report.verificationResults.length)})`),
    ...report.verificationResults.flatMap((item) =>
      wrapPlanLine(
        `Check ${item.checkId} — ${item.status}${"error" in item ? `: ${item.error.code}: ${item.error.message}` : "reason" in item ? `: ${item.reason}` : ""}`,
        width,
      ).map(style.muted),
    ),
    ...(report.rescanError === null
      ? []
      : [
          style.info("Rescan error"),
          ...wrapPlanLine(
            `${report.rescanError.code}: ${report.rescanError.message}`,
            width,
          ).map(style.muted),
        ]),
    style.info(`Fallback plans (${String(report.fallbackPlans.length)})`),
    ...report.fallbackPlans.flatMap((plan) =>
      wrapPlanLine(`Fallback plan: ${plan.id}`, width).map(style.muted),
    ),
  ];
}

function describeAction(action: RemovalAction): string {
  if (action.kind === "quarantine")
    return `${action.id}: quarantine ${action.location.path}`;
  if (action.kind === "record-cleanup")
    return `${action.id}: update ${action.format} record(s) in ${action.location.path}`;
  return `${action.id}: managed removal via ${describeInvocation(action.invocation)}; effects: ${action.effects.map((effect) => `${effect.kind} ${effect.path}`).join(", ") || "owner-defined"}`;
}

function describeInvocation(invocation: ManagedRemovalInvocation): string {
  if (invocation.kind === "direct") return describeCommand(invocation.command);
  const packageUse = invocation.packageExecution;
  return `${packageUse.runner} ${packageUse.packageName}@${packageUse.packageVersion} ${invocation.packageArguments.join(" ")} (may download/cache)`;
}

function describeCommand(command: ExecutableCommand): string {
  return [command.executable, ...command.arguments.map(quoteArgument)].join(
    " ",
  );
}

function quoteArgument(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}

function describeBlock(block: PlanBlock): string {
  const suffix = block.overridable
    ? " (force-overridable)"
    : " (not overridable)";
  if (block.kind === "hard-dependency")
    return `${block.kind}: ${block.dependency.reason}${suffix}`;
  if (block.kind === "ambiguous-ownership")
    return `${block.kind}: ${block.reason}${suffix}`;
  if (block.kind === "git-protection")
    return `${block.kind}: ${block.path}${suffix}`;
  if (block.kind === "system-skill")
    return `${block.kind}: supplied by ${block.agentId}${suffix}`;
  if (block.kind === "runtime-default-plugin")
    return `${block.kind}: Plugin ${block.pluginId}; harnesses ${block.exposedTo.join(", ") || "unknown"}${suffix}`;
  if (
    block.kind === "filesystem-permission" ||
    block.kind === "cleanup-conflict"
  )
    return `${block.kind}: ${block.path}: ${block.reason}${suffix}`;
  if (block.kind === "adapter-trust")
    return `${block.kind}: ${block.adapterId}:${block.contentHash}${suffix}`;
  if (block.kind === "plugin-boundary")
    return `${block.kind}: select Plugin ${block.pluginId} explicitly${suffix}`;
  return `${block.kind}: ${block.reason}; fallback ${block.fallback.kind}${suffix}`;
}

function describeWarning(warning: PlanWarning): string {
  if (warning.kind === "soft-reference")
    return `${warning.kind}: ${warning.reference.evidence}`;
  if (warning.kind === "plugin-impact")
    return `${warning.kind}: Plugin ${warning.pluginId}; collateral ${warning.affectedResources.join(", ") || "none"}`;
  if (warning.kind === "ephemeral-download") {
    const item = warning.packageExecution;
    return `${warning.kind}: ${item.runner} ${item.packageName}@${item.packageVersion} may download/cache; adapter ${item.adapterHash}`;
  }
  return `${warning.kind}: ${warning.reason}`;
}

function describeVerification(check: VerificationCheck): string {
  if (check.kind === "target-unavailable")
    return `${check.id}: target unavailable — ${describeTarget(check.target)}`;
  if (check.kind === "path-absent")
    return `${check.id}: path absent — ${check.path}`;
  if (check.kind === "record-absent")
    return `${check.id}: record absent — ${check.path} ${check.recordPointer}`;
  if (check.kind === "owner-state-absent")
    return `${check.id}: owner state absent — ${check.externalId}`;
  return `${check.id}: command succeeds — ${describeCommand(check.command)}`;
}

function planApprovals(plan: RemovalPlan): readonly ApprovalRequirement[] {
  const approvals = plan.actions.flatMap((action) => action.approvals);
  return approvals.filter(
    (approval, index) =>
      approvals.findIndex(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(approval),
      ) === index,
  );
}

function describeApproval(approval: ApprovalRequirement): string {
  if (approval.kind === "confirmation") return "ordinary confirmation";
  if (approval.kind === "brute-force-confirmation")
    return "separate brute-force confirmation";
  if (approval.kind === "force-override")
    return `force override: ${approval.safeguards.join(", ")}`;
  if (approval.kind === "adapter-trust")
    return `adapter trust: ${approval.adapterId}:${approval.contentHash}`;
  return `package trust: ${approval.runner}:${approval.packageName}@${approval.packageVersion}:${approval.adapterHash}`;
}

function describeUpdateApproval(approval: ApprovalRequirement): string {
  if (approval.kind === "adapter-trust")
    return `Adapter ${approval.adapterId} must be trusted before the update`;
  if (approval.kind !== "package-trust") return describeApproval(approval);
  return `Allow ${approval.runner} to run ${approval.packageName}@${approval.packageVersion}`;
}

function describeTarget(target: RemovalTarget): string {
  if (target.kind === "installation")
    return `Installation ${target.installationId}`;
  if (target.kind === "logical-skill")
    return `Logical Skill ${target.logicalSkillId}`;
  if (target.kind === "source-group") return `Source Group ${target.groupId}`;
  return `Plugin ${target.pluginBoundaryId}`;
}

function indented(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  - ${line}`);
}

function orNone(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? ["none"] : lines;
}
