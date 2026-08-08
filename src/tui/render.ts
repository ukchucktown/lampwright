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
  TuiExecutingState,
  TuiEntry,
  TuiPaneView,
  TuiPlanState,
  TuiReportState,
  TuiSearchState,
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
    return `${style.title("skill-cleaner")}\n\n${style.error(`Unable to continue: ${state.message}`)}\n\n${style.muted("Press q or ctrl-c to exit.")}\n`;
  if (state.screen === "done") return "";
  if (state.screen === "browse") return renderBrowse(state, theme);
  if (state.screen === "search") return renderSearch(state, theme);
  if (state.screen === "plan") return renderPlan(state, style);
  if (state.screen === "executing") return renderExecuting(state, style);
  return renderReport(state, style);
}

function renderExecuting(state: TuiExecutingState, style: TuiPaint): string {
  const width = Math.max(0, state.browse.model.viewport.columns - 1);
  const rows = Math.max(0, state.browse.model.viewport.rows - 1);
  const lines = [
    { text: "skill-cleaner — Removing", paint: style.title },
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
      style.title(fit("skill-cleaner", usable)),
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
        { text: "skill-cleaner", paint: style.title },
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
      model.focus === "detail"
        ? [
            { text: "↑↓/wheel", paint: style.title },
            { text: " scroll · ", paint: style.muted },
            { text: "PgUp/PgDn", paint: style.title },
            { text: " page · ", paint: style.muted },
            { text: "click", paint: style.title },
            { text: " focus · ", paint: style.muted },
            { text: "tab/⇧tab", paint: style.title },
            { text: " pane · ", paint: style.muted },
            { text: "⇧↑↓", paint: style.title },
            { text: " resize · ", paint: style.muted },
            { text: "esc", paint: style.title },
            { text: " back · ", paint: style.muted },
            { text: "q", paint: style.title },
            { text: " quit", paint: style.muted },
          ]
        : [
            { text: "↑↓/wheel", paint: style.title },
            { text: " move · ", paint: style.muted },
            { text: "click", paint: style.title },
            { text: " focus · ", paint: style.muted },
            { text: "space/dbl-click", paint: style.title },
            { text: " select · ", paint: style.muted },
            { text: "tab", paint: style.title },
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
      ? fitStyledSegments(
          [
            { text: "/ or type", paint: style.title },
            { text: " search names by regex · ", paint: style.muted },
            { text: "ctrl-u", paint: style.title },
            { text: " clear selection", paint: style.muted },
          ],
          usable,
          style.muted,
        )
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

  const detailStatus =
    detail.total > detail.height
      ? `detail=${String(detail.offset + 1)}-${String(Math.min(detail.total, detail.offset + detail.height))}/${String(detail.total)} `
      : "";
  out.push(
    model.notice === null
      ? style.muted(
          fit(
            `focus=${model.focus} ${detailStatus}section=${String(model.sectionIndex + 1)}/${String(view.sections.total)} entry=${String(view.entries.total === 0 ? 0 : model.entryIndex + 1)}/${String(view.entries.total)}`,
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
    style.title("skill-cleaner"),
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
    style.title("skill-cleaner — Review removal"),
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
          style.title("After removal, skill-cleaner will verify"),
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
          ? "A failed managed removal will stop; any brute-force fallback must be reviewed and confirmed separately."
          : hasRecoverableRemoval
            ? "Files are not permanently deleted. They can be restored from the recovery area."
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
      `${prefix}Move ${capabilities} to the recovery area`,
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
      `${prefix}Move ${targetLabel(state, action.target)} to the recovery area`,
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
      `  • skill-cleaner cannot determine who owns it: ${block.reason}`,
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
  if (block.kind === "filesystem-permission")
    return [
      `  • skill-cleaner cannot modify ${block.path}: ${block.reason}`,
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
      `  • Removing Plugin ${warning.pluginId} also affects: ${warning.affectedResources.join(", ") || "other Plugin resources"}`,
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
    style.title("skill-cleaner — Final report"),
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
    style.title("skill-cleaner"),
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
