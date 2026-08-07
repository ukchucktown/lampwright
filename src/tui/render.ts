import type {
  ApprovalRequirement,
  Dependency,
  ExecutableCommand,
  Inventory,
  ManagedRemovalInvocation,
  Ownership,
  PlanBlock,
  PlanWarning,
  ProtectionStatus,
  RemovalAction,
  RemovalPlan,
  RemovalTarget,
  Scope,
  VerificationCheck,
} from "../model/types.js";
import type {
  TuiBrowseState,
  TuiPlanState,
  TuiReportState,
  TuiRow,
  TuiState,
} from "./types.js";

export interface TuiRenderOptions {
  readonly maxRows?: number;
}

export function renderTui(
  state: TuiState,
  options: TuiRenderOptions = {},
): string {
  if (state.screen === "loading")
    return "skill-cleaner\n\nScanning known skill roots…\n";
  if (state.screen === "error")
    return `skill-cleaner\n\nUnable to continue: ${state.message}\n\nPress Esc or Ctrl-C to exit.\n`;
  if (state.screen === "done") return "";
  if (state.screen === "browse")
    return renderBrowse(state, options.maxRows ?? 12);
  if (state.screen === "plan") return renderPlan(state);
  return renderReport(state);
}

function renderBrowse(state: TuiBrowseState, maxRows: number): string {
  const lines = [
    "skill-cleaner — Inventory",
    "",
    `Search: ${state.query || "(type to fuzzy-search; filters: plugin: agent: scope: source: manager: status:)"}`,
    "",
  ];
  const { start, end } = visibleWindow(
    state.cursor,
    state.rows.length,
    maxRows,
  );
  if (start > 0) lines.push(`  … ${start} earlier result(s)`);
  for (let index = start; index < end; index += 1) {
    const row = state.rows[index]!;
    const selected = index === state.cursor ? ">" : " ";
    const indent = row.depth === 1 ? "  " : "";
    const expansion = row.childCount > 0 ? (row.expanded ? "▾" : "▸") : " ";
    const count = row.childCount > 0 ? ` (${row.childCount})` : "";
    lines.push(
      `${selected} ${indent}${expansion} [${rowLabel(row)}] ${row.name}${count} — ${row.summaryStatus}`,
    );
  }
  if (end < state.rows.length)
    lines.push(`  … ${state.rows.length - end} later result(s)`);
  if (state.rows.length === 0) lines.push("  No matching inventory records.");
  lines.push("", ...selectedDetails(state));
  lines.push(
    "",
    "↑/↓ move   Enter review plan   →/Tab expand   Esc quit",
    "Typing edits the search query; Backspace removes a character.",
    "Source-only findings appear only with a status: inspection filter.",
  );
  return `${lines.join("\n")}\n`;
}

function selectedDetails(state: TuiBrowseState): readonly string[] {
  const row = state.rows[state.cursor];
  if (row === undefined) return ["Details: no selection"];
  const lines = [
    `Details — ${rowLabel(row)}: ${row.name}`,
    ...(row.description === null ? [] : [`  ${row.description}`]),
  ];
  if (row.installation !== null) {
    const installation = row.installation;
    lines.push(
      `  Installation ID: ${installation.id}`,
      `  Agent / scope: ${installation.agentId} / ${describeScope(installation.scope)}`,
      `  Source: ${installation.source?.id ?? "none"}`,
      `  Manager / Plugin: ${installation.manager?.id ?? "none"} / ${installation.plugin?.id ?? "none"}`,
      `  Ownership: ${describeOwnership(installation.ownership)}`,
      `  Path: ${installation.location.path} (${installation.location.artifactType.kind})`,
      `  Protection: ${describeProtection(installation.protection)}`,
      `  Removal: ${describeRemoval(installation.removal)}`,
      ...dependencyLines(state.inventory, row),
    );
  } else if (row.logicalSkill !== null) {
    lines.push(
      `  Logical Skill ID: ${row.logicalSkill.id}`,
      `  Installations: ${row.logicalSkill.installationIds.join(", ")}`,
      "  Select this row for every Installation in this strong identity group; expand to select one physical Installation.",
      ...dependencyLines(state.inventory, row),
    );
  } else if (row.plugin !== null) {
    const plugin = row.plugin;
    lines.push(
      `  Plugin boundary ID: ${plugin.id}`,
      `  Version / adapter: ${plugin.version ?? "unknown"} / ${plugin.adapterId ?? "none"}`,
      `  Ownership: ${describeOwnership(plugin.ownership)}`,
      `  Installations: ${plugin.installationIds.join(", ") || "none"}`,
      `  Collateral resources: ${plugin.resources.map((resource) => `${resource.kind}:${resource.id}`).join(", ") || "none"}`,
      `  Removal: ${describeRemoval(plugin.removal)}`,
      ...dependencyLines(state.inventory, row),
    );
  } else if (row.finding !== null) {
    const finding = row.finding;
    lines.push(
      `  Classification: ${finding.classification}`,
      `  Path: ${finding.location.path}`,
      `  Ownership: ${describeOwnership(finding.ownership)}`,
      `  Protection: ${describeProtection(finding.protection)}`,
      "  Inspection only: this record is not an independently removable Installation.",
    );
  }
  return lines;
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

function dependencyLines(inventory: Inventory, row: TuiRow): readonly string[] {
  const dependencies = inventory.dependencies.filter((dependency) =>
    dependencyTouchesRow(dependency, row),
  );
  return dependencies.length === 0
    ? ["  Dependencies / references: none"]
    : [
        "  Dependencies / references:",
        ...dependencies.map(
          (dependency) =>
            `    - ${dependency.kind}: ${dependency.kind === "hard" ? dependency.reason : dependency.evidence}`,
        ),
      ];
}

function dependencyTouchesRow(dependency: Dependency, row: TuiRow): boolean {
  if (row.target !== null && sameTarget(dependency.target, row.target))
    return true;
  const ids =
    row.logicalSkill?.installationIds ??
    row.plugin?.installationIds ??
    (row.installation === null ? [] : [row.installation.id]);
  return (
    dependency.kind === "hard" &&
    ids.includes(dependency.dependentInstallationId)
  );
}

function sameTarget(left: RemovalTarget, right: RemovalTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "installation" && right.kind === "installation")
    return left.installationId === right.installationId;
  if (left.kind === "logical-skill" && right.kind === "logical-skill")
    return left.logicalSkillId === right.logicalSkillId;
  return (
    left.kind === "plugin" &&
    right.kind === "plugin" &&
    left.pluginBoundaryId === right.pluginBoundaryId
  );
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
  return `Plugin ${target.pluginBoundaryId}`;
}

function describeOwnership(ownership: Ownership): string {
  if (ownership.kind === "filesystem")
    return `filesystem (${ownership.confidence})`;
  if (ownership.kind === "manager")
    return `Manager ${ownership.managerId} (${ownership.confidence})`;
  if (ownership.kind === "plugin")
    return `Plugin ${ownership.pluginId} (${ownership.confidence}; ${ownership.independentlySelectable ? "independently selectable" : "boundary-only"})`;
  if (ownership.kind === "agent-runtime")
    return `agent runtime ${ownership.agentId} (${ownership.confidence})`;
  return "unknown";
}

function describeProtection(protection: ProtectionStatus): string {
  return [
    `Git ${protection.git.kind}`,
    protection.system.kind === "system-skill"
      ? `System Skill (${protection.system.agentId})`
      : "not a System Skill",
    protection.filesystem.kind === "read-only"
      ? `read-only (${protection.filesystem.reason})`
      : "writable",
  ].join("; ");
}

function describeRemoval(removal: {
  readonly managed: {
    readonly adapterId: string;
    readonly operationId: string;
    readonly availability: { readonly kind: string; readonly reason?: string };
    readonly trust: { readonly kind: string };
  } | null;
  readonly fallback: { readonly kind: string; readonly reason?: string };
}): string {
  const managed =
    removal.managed === null
      ? "no managed removal"
      : `managed by ${removal.managed.adapterId}/${removal.managed.operationId} (${removal.managed.availability.kind}, ${removal.managed.trust.kind})`;
  const fallback =
    removal.fallback.kind === "available"
      ? "separately confirmed quarantine fallback available"
      : `fallback unavailable${removal.fallback.reason === undefined ? "" : `: ${removal.fallback.reason}`}`;
  return `${managed}; ${fallback}`;
}

function describeScope(scope: Scope): string {
  if (scope.kind === "user") return "user";
  if (scope.kind === "workspace") return `workspace:${scope.workspacePath}`;
  return `agent:${scope.agentId}`;
}

function rowLabel(row: TuiRow): string {
  if (row.kind === "logical-skill") return "Logical Skill";
  if (row.kind === "installation") return "Installation";
  if (row.kind === "plugin") return "Plugin";
  return row.finding?.classification === "system-skill"
    ? "System Skill"
    : "source-only";
}

function visibleWindow(
  cursor: number,
  length: number,
  maximum: number,
): { readonly start: number; readonly end: number } {
  if (length <= maximum) return { start: 0, end: length };
  const half = Math.floor(maximum / 2);
  const start = Math.max(0, Math.min(cursor - half, length - maximum));
  return { start, end: start + maximum };
}

function indented(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  - ${line}`);
}

function orNone(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? ["none"] : lines;
}
