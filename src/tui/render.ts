import type {
  ApprovalRequirement,
  ExecutableCommand,
  ManagedRemovalInvocation,
  PlanBlock,
  PlanWarning,
  RemovalAction,
  RemovalPlan,
  RemovalTarget,
  VerificationCheck,
} from "../model/types.js";
import {
  currentEntry,
  currentSection,
  layout,
  panes,
  sharedExposure,
  sharedPathCount,
} from "./browse.js";
import {
  nightfallTheme,
  styleTui,
  type TuiStyleRole,
  type TuiTheme,
} from "./theme.js";
import type {
  TuiBrowseState,
  TuiEntry,
  TuiPaneView,
  TuiPlanState,
  TuiReportState,
  TuiSection,
  TuiState,
} from "./types.js";

export function renderTui(
  state: TuiState,
  theme: TuiTheme = nightfallTheme,
): string {
  const style = createPaint(theme);
  if (state.screen === "loading")
    return `${style.title("skill-cleaner")}\n\n${style.info("Scanning known skill roots…")}\n`;
  if (state.screen === "error")
    return `${style.title("skill-cleaner")}\n\n${style.error(`Unable to continue: ${state.message}`)}\n\n${style.muted("Press q or Ctrl-C to exit.")}\n`;
  if (state.screen === "done") return "";
  if (state.screen === "browse") return renderBrowse(state, theme);
  if (state.screen === "plan") return renderPlan(state, style);
  return renderReport(state, style);
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

export function renderBrowseLines(
  state: TuiBrowseState,
  theme: TuiTheme = nightfallTheme,
): readonly string[] {
  const style = createPaint(theme);
  const model = state.model;
  const grid = layout(model);
  const { rows, columns, usable, paneRows, detailRows, leftWidth, rightWidth } =
    grid;
  if (rows < 7 || columns < 4) return renderCompactBrowse(rows, usable, style);
  const view = panes(model);
  const section = currentSection(model);
  const entry = currentEntry(model);
  const out: string[] = [];

  const selected = model.selected.size;
  out.push(
    `${style.title("skill-cleaner")} ${style.muted("inventory")}  ${
      selected > 0
        ? style.selected(`${String(selected)} selected`)
        : style.muted("nothing selected")
    }`,
  );
  out.push(
    fitStyledSegments(
      [
        { text: "↑↓/wheel", paint: style.title },
        { text: " move · ", paint: style.muted },
        { text: "click", paint: style.title },
        { text: " focus · ", paint: style.muted },
        { text: "space/dbl-click", paint: style.title },
        { text: " select · ", paint: style.muted },
        { text: "←→", paint: style.title },
        { text: " pane · ", paint: style.muted },
        { text: "enter", paint: style.title },
        { text: " review · ", paint: style.muted },
        { text: "esc", paint: style.title },
        { text: " back · ", paint: style.muted },
        { text: "q", paint: style.title },
        { text: " quit", paint: style.muted },
      ],
      usable,
      style.muted,
    ),
  );
  out.push(
    model.query === ""
      ? style.muted(fit("filter: names, sections, agents, paths", usable))
      : `filter ${style.active(model.query)} ${style.muted(`· ${String(view.entries.total)} here`)}`,
  );
  out.push(
    style.border(
      `${"─".repeat(leftWidth)}┬${"─".repeat(usable - leftWidth - 1)}`,
    ),
  );

  for (let row = 0; row < paneRows; row += 1) {
    out.push(
      `${sectionCell(model, view.sections, row, leftWidth, style)}${style.border("│")}${entryCell(
        model,
        view.entries,
        section,
        row,
        rightWidth,
        style,
      )}${scrollMark(view.entries, row, style)}`,
    );
  }

  out.push(
    style.border(
      `${"─".repeat(leftWidth)}┴${"─".repeat(usable - leftWidth - 1)}`,
    ),
  );

  const detail: { text: string; style: (value: string) => string }[] = [];
  if (entry !== null) {
    detail.push({
      text: `${entry.name}   ${entry.owner}${entry.note === null ? "" : ` · ${entry.note}`}`,
      style: style.active,
    });
    for (const line of wrap(entry.description ?? "", usable - 2))
      detail.push({ text: `  ${line}`, style: plain });
    if (entry.paths.length > 0) detail.push({ text: "", style: plain });
    for (const path of entry.paths)
      detail.push({ text: `  ${path}`, style: style.path });
  }
  for (let row = 0; row < detailRows; row += 1) {
    const line = detail[row];
    out.push(
      line === undefined
        ? " ".repeat(usable)
        : line.style(fit(line.text, usable)),
    );
  }

  out.push(
    model.notice === null
      ? style.muted(
          fit(
            `focus=${model.focus} section=${String(model.sectionIndex + 1)}/${String(view.sections.total)} entry=${String(view.entries.total === 0 ? 0 : model.entryIndex + 1)}/${String(view.entries.total)}`,
            usable,
          ),
        )
      : style.info(fit(`! ${model.notice}`, usable)),
  );

  return out.map((line) => fit(line, usable));
}

function sectionCell(
  model: TuiBrowseState["model"],
  view: TuiPaneView<TuiSection>,
  row: number,
  width: number,
  style: TuiPaint,
): string {
  const item = view.items[row];
  if (item === undefined) return " ".repeat(width);
  const index = view.offset + row;
  const focused = index === model.sectionIndex;
  const taken = item.entries.filter((entry) =>
    model.selected.has(entry.key),
  ).length;
  const marker = !item.selectable
    ? " - "
    : taken === 0
      ? "[ ]"
      : taken === item.entries.length
        ? "[x]"
        : "[~]";
  const count =
    taken > 0
      ? `${String(taken)}/${String(item.entries.length)}`
      : String(item.entries.length);
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
): string {
  if (width <= 0) return "";
  if (row === 0) {
    if (section === null) return " ".repeat(width);
    const exposure = sharedExposure(section);
    const paths = sharedPathCount(section);
    const detail = [
      `${String(section.entries.length)} entries`,
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
  const marker =
    section !== null && !section.selectable
      ? " - "
      : model.selected.has(entry.key)
        ? "[x]"
        : "[ ]";
  if (width < 11) {
    const compact = fit(`${marker} ${entry.name}`, width);
    if (focused) return style.focus(compact);
    return model.selected.has(entry.key) ? style.selected(compact) : compact;
  }
  const exposure = section === null ? null : sharedExposure(section);
  const differs = exposure === null || entry.exposedTo.join(" ") !== exposure;
  const note = entry.note ?? (differs ? entry.exposedTo.join(" ") : "");
  const nameWidth = Math.max(6, Math.min(44, width - 22));
  const head = `${marker} ${fit(entry.name, nameWidth)} `;
  const tail = fit(note, Math.max(0, width - nameWidth - 5));
  if (focused) return style.focus(fit(head + tail, width));
  const styledHead = model.selected.has(entry.key)
    ? style.selected(fit(head, nameWidth + 5))
    : fit(head, nameWidth + 5);
  return `${styledHead}${style.muted(tail)}`;
}

function renderCompactBrowse(
  rows: number,
  usable: number,
  style: TuiPaint,
): readonly string[] {
  const lines = [
    style.title("skill-cleaner"),
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
    ? style.active("█")
    : style.border("│");
}

/** Greedy word wrap, so a long description reads instead of being cut off. */
function wrap(text: string, width: number): readonly string[] {
  if (text === "" || width <= 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
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

/** Fits to an exact visible width. Styling is applied after, never before. */
function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const length = visibleLength(value);
  if (length === width) return value;
  if (length < width) return value + " ".repeat(width - length);
  return `${[...stripAnsi(value)].slice(0, Math.max(0, width - 1)).join("")}…`;
}

function renderPlan(state: TuiPlanState, style: TuiPaint): string {
  const removalPlan = state.plan;
  const lines = [
    style.title(
      `skill-cleaner — ${removalPlan.intent.mode === "brute-force" ? "Separate fallback plan" : "Removal plan"}`,
    ),
    "",
    `Selection: ${style.active(state.label)}`,
    style.muted(`Plan: ${removalPlan.id}`),
    style.active(`Targets (${removalPlan.targets.length}):`),
    ...indented(removalPlan.targets.map(describeTarget)),
    style.active(`Actions (${removalPlan.actions.length}):`),
    ...indented(removalPlan.actions.map(describeAction)),
    (removalPlan.blocks.length === 0 ? style.active : style.error)(
      `Blocks (${removalPlan.blocks.length}):`,
    ),
    ...indented(
      removalPlan.blocks.length === 0
        ? [style.muted("none")]
        : removalPlan.blocks.map(describeBlock).map(style.error),
    ),
    (removalPlan.warnings.length === 0 ? style.active : style.warning)(
      `Warnings (${removalPlan.warnings.length}):`,
    ),
    ...indented(
      removalPlan.warnings.length === 0
        ? [style.muted("none")]
        : removalPlan.warnings.map(describeWarning).map(style.warning),
    ),
    style.active(`Verification (${removalPlan.verificationChecks.length}):`),
    ...indented(
      orNone(removalPlan.verificationChecks.map(describeVerification)),
    ),
    style.info("Approvals shown by this plan:"),
    ...indented(
      orNone(planApprovals(removalPlan).map(describeApproval)).map(style.info),
    ),
    "",
  ];
  if (removalPlan.blocks.length === 0) {
    lines.push(
      style.success(
        "Nothing has been changed. Press y to grant the exact approvals above and execute this plan.",
      ),
      removalPlan.intent.mode === "brute-force"
        ? style.warning(
            "This brute-force action quarantines files and is separate from the failed managed removal.",
          )
        : style.muted(
            "A failed managed removal will stop; any brute-force fallback must be reviewed and confirmed separately.",
          ),
      style.active("y confirm") +
        style.muted("   n/Esc cancel   q/Ctrl-C quit"),
    );
  } else if (removalPlan.blocks.every((block) => block.overridable)) {
    lines.push(
      style.warning("This plan is blocked and cannot execute as shown."),
      style.active("f create a force-override plan") +
        style.muted("   n/Esc cancel   q/Ctrl-C quit"),
    );
  } else {
    lines.push(
      style.error(
        "This plan contains a non-overridable block and cannot execute.",
      ),
      style.muted("n/Esc return to inventory   q/Ctrl-C quit"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderReport(state: TuiReportState, style: TuiPaint): string {
  const report = state.report;
  const statusStyle =
    report.status === "succeeded"
      ? style.success
      : report.status === "partial"
        ? style.warning
        : style.error;
  const lines = [
    style.title("skill-cleaner — ") + statusStyle(`Execution ${report.status}`),
    "",
    style.muted(`Plan: ${report.planId}`),
    `Final inventory: ${style.info(report.finalInventoryId ?? "unavailable")}`,
    ...(report.rescanError === null
      ? []
      : [
          style.error(
            `Rescan error: ${report.rescanError.code}: ${report.rescanError.message}`,
          ),
        ]),
    style.active(`Targets (${report.targetResults.length}):`),
    ...indented(
      orNone(
        report.targetResults.map(
          (result) =>
            `${describeTarget(result.target)} — ${result.status}${"reason" in result ? `: ${result.reason}` : ""}`,
        ),
      ),
    ),
    style.active(`Actions (${report.actionResults.length}):`),
    ...indented(
      orNone(
        report.actionResults.map(
          (result) =>
            `${result.actionId} — ${result.status}${"reason" in result ? `: ${result.reason}` : ""}${"error" in result ? `: ${result.error.code}: ${result.error.message}` : ""}`,
        ),
      ),
    ),
    style.active(`Verification (${report.verificationResults.length}):`),
    ...indented(
      orNone(
        report.verificationResults.map(
          (result) =>
            `${result.checkId} — ${result.status}${"reason" in result ? `: ${result.reason}` : ""}${"error" in result ? `: ${result.error.code}: ${result.error.message}` : ""}`,
        ),
      ),
    ),
    style.warning(
      `Separate brute-force fallbacks (${report.fallbackPlans.length}):`,
    ),
  ];
  if (report.fallbackPlans.length === 0) lines.push(style.muted("  none"));
  else
    report.fallbackPlans.forEach((fallback, index) => {
      const line = `${index === state.fallbackCursor ? ">" : " "} ${index + 1}. ${fallback.id} — ${fallback.targets.length} target(s), ${fallback.actions.length} action(s), ${fallback.blocks.length} block(s)`;
      lines.push(
        index === state.fallbackCursor ? style.focus(line) : style.muted(line),
      );
    });
  lines.push(
    "",
    report.fallbackPlans.length > 0
      ? style.active("↑/↓ choose fallback   f review selected fallback") +
          style.muted("   Esc/q finish")
      : style.muted("Esc/q finish"),
    style.muted("Fallback plans are never executed automatically."),
  );
  return `${lines.join("\n")}\n`;
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
