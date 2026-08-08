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
import type {
  TuiBrowseState,
  TuiEntry,
  TuiPaneView,
  TuiPlanState,
  TuiReportState,
  TuiSection,
  TuiState,
} from "./types.js";

export function renderTui(state: TuiState): string {
  if (state.screen === "loading")
    return "skill-cleaner\n\nScanning known skill roots…\n";
  if (state.screen === "error")
    return `skill-cleaner\n\nUnable to continue: ${state.message}\n\nPress Esc or Ctrl-C to exit.\n`;
  if (state.screen === "done") return "";
  if (state.screen === "browse") return renderBrowse(state);
  if (state.screen === "plan") return renderPlan(state);
  return renderReport(state);
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
function renderBrowse(state: TuiBrowseState): string {
  return renderBrowseLines(state).join("\n");
}

export function renderBrowseLines(state: TuiBrowseState): readonly string[] {
  const model = state.model;
  const { usable, paneRows, detailRows, leftWidth, rightWidth } = layout(model);
  const view = panes(model);
  const section = currentSection(model);
  const entry = currentEntry(model);
  const out: string[] = [];

  const selected = model.selected.size;
  out.push(
    `${bold("skill-cleaner")} ${dim("inventory")}  ${
      selected > 0
        ? accent(`${String(selected)} selected`)
        : dim("nothing selected")
    }`,
  );
  out.push(
    dim(
      fit(
        "arrows/click/wheel move · space select (a section takes all) · enter review · esc back · ^c quit",
        usable,
      ),
    ),
  );
  out.push(
    model.query === ""
      ? dim(fit("filter: names, sections, agents, paths", usable))
      : `filter ${bold(model.query)} ${dim(`· ${String(view.entries.total)} here`)}`,
  );
  out.push(`${"─".repeat(leftWidth)}┬${"─".repeat(usable - leftWidth - 1)}`);

  for (let row = 0; row < paneRows; row += 1) {
    out.push(
      `${sectionCell(model, view.sections, row, leftWidth)}│${entryCell(
        model,
        view.entries,
        section,
        row,
        rightWidth,
      )}${dim(scrollMark(view.entries, row))}`,
    );
  }

  out.push(`${"─".repeat(leftWidth)}┴${"─".repeat(usable - leftWidth - 1)}`);

  const detail: { text: string; style: (value: string) => string }[] = [];
  if (entry !== null) {
    detail.push({
      text: `${entry.name}   ${entry.owner}${entry.note === null ? "" : ` · ${entry.note}`}`,
      style: bold,
    });
    for (const line of wrap(entry.description ?? "", usable - 2))
      detail.push({ text: `  ${line}`, style: plain });
    if (entry.paths.length > 0) detail.push({ text: "", style: plain });
    for (const path of entry.paths)
      detail.push({ text: `  ${path}`, style: dim });
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
      ? dim(
          fit(
            `focus=${model.focus} section=${String(model.sectionIndex + 1)}/${String(view.sections.total)} entry=${String(view.entries.total === 0 ? 0 : model.entryIndex + 1)}/${String(view.entries.total)}`,
            usable,
          ),
        )
      : accent(fit(`! ${model.notice}`, usable)),
  );

  return out.map((line) => fit(line, usable));
}

function sectionCell(
  model: TuiBrowseState["model"],
  view: TuiPaneView<TuiSection>,
  row: number,
  width: number,
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
  if (focused && model.focus === "sections") return inverse(fit(text, width));
  return focused ? bold(fit(text, width)) : fit(text, width);
}

function entryCell(
  model: TuiBrowseState["model"],
  view: TuiPaneView<TuiEntry>,
  section: TuiSection | null,
  row: number,
  width: number,
): string {
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
    return `${bold(fit(section.label, label))}${dim(fit(` ${detail}`, width - label))}`;
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
  const exposure = section === null ? null : sharedExposure(section);
  const differs = exposure === null || entry.exposedTo.join(" ") !== exposure;
  const note = entry.note ?? (differs ? entry.exposedTo.join(" ") : "");
  const nameWidth = Math.max(6, Math.min(44, width - 22));
  const head = `${marker} ${fit(entry.name, nameWidth)} `;
  const tail = fit(note, Math.max(0, width - nameWidth - 5));
  if (focused) return inverse(fit(head + tail, width));
  return `${fit(head, nameWidth + 5)}${dim(tail)}`;
}

function scrollMark(pane: TuiPaneView<unknown>, row: number): string {
  if (pane.total <= pane.height) return " ";
  const span = Math.max(
    1,
    Math.round((pane.height / pane.total) * pane.height),
  );
  const start = Math.round((pane.offset / pane.total) * pane.height);
  return row >= start && row < start + span ? "█" : "│";
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
const bold = (value: string): string => `${escape}[1m${value}${escape}[0m`;
const dim = (value: string): string => `${escape}[2m${value}${escape}[0m`;
const inverse = (value: string): string => `${escape}[7m${value}${escape}[0m`;
const accent = (value: string): string => `${escape}[36m${value}${escape}[0m`;

/** Fits to an exact visible width. Styling is applied after, never before. */
function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const length = visibleLength(value);
  if (length === width) return value;
  if (length < width) return value + " ".repeat(width - length);
  return `${[...stripAnsi(value)].slice(0, Math.max(0, width - 1)).join("")}…`;
}

function renderPlan(state: TuiPlanState): string {
  const removalPlan = state.plan;
  const lines = [
    `skill-cleaner — ${removalPlan.intent.mode === "brute-force" ? "Separate fallback plan" : "Removal plan"}`,
    "",
    `Selection: ${state.label}`,
    `Plan: ${removalPlan.id}`,
    `Targets (${removalPlan.targets.length}):`,
    ...indented(removalPlan.targets.map(describeTarget)),
    `Actions (${removalPlan.actions.length}):`,
    ...indented(removalPlan.actions.map(describeAction)),
    `Blocks (${removalPlan.blocks.length}):`,
    ...indented(orNone(removalPlan.blocks.map(describeBlock))),
    `Warnings (${removalPlan.warnings.length}):`,
    ...indented(orNone(removalPlan.warnings.map(describeWarning))),
    `Verification (${removalPlan.verificationChecks.length}):`,
    ...indented(
      orNone(removalPlan.verificationChecks.map(describeVerification)),
    ),
    "Approvals shown by this plan:",
    ...indented(orNone(planApprovals(removalPlan).map(describeApproval))),
    "",
  ];
  if (removalPlan.blocks.length === 0) {
    lines.push(
      "Nothing has been changed. Press y to grant the exact approvals above and execute this plan.",
      removalPlan.intent.mode === "brute-force"
        ? "This brute-force action quarantines files and is separate from the failed managed removal."
        : "A failed managed removal will stop; any brute-force fallback must be reviewed and confirmed separately.",
      "y confirm   n/Esc cancel   Ctrl-C quit",
    );
  } else if (removalPlan.blocks.every((block) => block.overridable)) {
    lines.push(
      "This plan is blocked and cannot execute as shown.",
      "f create a force-override plan   n/Esc cancel   Ctrl-C quit",
    );
  } else {
    lines.push(
      "This plan contains a non-overridable block and cannot execute.",
      "n/Esc return to inventory   Ctrl-C quit",
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderReport(state: TuiReportState): string {
  const report = state.report;
  const lines = [
    `skill-cleaner — Execution ${report.status}`,
    "",
    `Plan: ${report.planId}`,
    `Final inventory: ${report.finalInventoryId ?? "unavailable"}`,
    ...(report.rescanError === null
      ? []
      : [
          `Rescan error: ${report.rescanError.code}: ${report.rescanError.message}`,
        ]),
    `Targets (${report.targetResults.length}):`,
    ...indented(
      orNone(
        report.targetResults.map(
          (result) =>
            `${describeTarget(result.target)} — ${result.status}${"reason" in result ? `: ${result.reason}` : ""}`,
        ),
      ),
    ),
    `Actions (${report.actionResults.length}):`,
    ...indented(
      orNone(
        report.actionResults.map(
          (result) =>
            `${result.actionId} — ${result.status}${"reason" in result ? `: ${result.reason}` : ""}${"error" in result ? `: ${result.error.code}: ${result.error.message}` : ""}`,
        ),
      ),
    ),
    `Verification (${report.verificationResults.length}):`,
    ...indented(
      orNone(
        report.verificationResults.map(
          (result) =>
            `${result.checkId} — ${result.status}${"reason" in result ? `: ${result.reason}` : ""}${"error" in result ? `: ${result.error.code}: ${result.error.message}` : ""}`,
        ),
      ),
    ),
    `Separate brute-force fallbacks (${report.fallbackPlans.length}):`,
  ];
  if (report.fallbackPlans.length === 0) lines.push("  none");
  else
    report.fallbackPlans.forEach((fallback, index) => {
      lines.push(
        `${index === state.fallbackCursor ? ">" : " "} ${index + 1}. ${fallback.id} — ${fallback.targets.length} target(s), ${fallback.actions.length} action(s), ${fallback.blocks.length} block(s)`,
      );
    });
  lines.push(
    "",
    report.fallbackPlans.length > 0
      ? "↑/↓ choose fallback   f review selected fallback   Esc/q finish"
      : "Esc/q finish",
    "Fallback plans are never executed automatically.",
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
