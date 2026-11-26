import { layout, scrollFor, clampPercent, clampDetailRows } from "./browse.js";
import { fullPaneSize } from "./overlay.js";
import { wrapTerminalLine } from "./text.js";
import type { TuiAction, TuiHelpState, TuiPaneView } from "./types.js";

interface Shortcut {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly mouse?: string;
  readonly warning?: boolean;
}

interface HelpSection {
  readonly label: string;
  readonly shortcuts: readonly Shortcut[];
}

function helpSections({ browse }: TuiHelpState): readonly HelpSection[] {
  const { view, inventory } = browse;
  const update = {
    key: "u",
    label: "Review update",
    note: "Choose one eligible target to see its update plan.",
  };
  const current: HelpSection =
    view === "trash"
      ? {
          label: "Trash",
          shortcuts: [
            {
              key: "enter",
              label: "Review restore",
              note: "See where Lampwright would restore the focused operation’s files.",
              mouse: "Double-click the entry.",
            },
            {
              key: "p",
              label: "Review purge",
              note: "Check which files a purge would permanently delete.",
              warning: true,
            },
          ],
        }
      : view === "disabled"
        ? {
            label: "Disabled",
            shortcuts: [
              {
                key: "e",
                label: "Review enable",
                note: "See how to enable the checked items or the focused entry.",
              },
              update,
            ],
          }
        : {
            label: "Inventory",
            shortcuts: [
              {
                key: "enter",
                label: "Review removal",
                note: "Check what would be removed for the checked items or the focused entry.",
                warning: true,
              },
              ...(inventory.installations.some(
                (item) => item.agentDestinations?.length,
              )
                ? [
                    {
                      key: "+",
                      label: "Add agents",
                      note: "Choose agents for one installed Skill, then review their destinations.",
                    },
                  ]
                : []),
              update,
              {
                key: "d",
                label: "Review disable",
                note: "See how to disable the checked items or the focused entry.",
              },
            ],
          };
  return [
    current,
    {
      label: "Move and select",
      shortcuts: [
        {
          key: "↑↓",
          label: "Move one row",
          note: "Move the highlight or scroll the focused detail pane.",
          mouse: "Scroll the wheel over a pane.",
        },
        {
          key: "PgUp PgDn",
          label: "Move one page",
          note: "Move by the number of rows in the focused pane.",
        },
        {
          key: "tab",
          label: "Next pane",
          note: "Cycle through sections, entries and details. Shift+Tab goes back.",
          mouse: "Click a pane.",
        },
        {
          key: "←→",
          label: "Focus a list",
          note: "Left focuses sections. Right focuses entries.",
        },
        ...(view === "trash"
          ? []
          : [
              {
                key: "space",
                label: "Toggle selection",
                note: "Check or uncheck the focused row.",
                mouse: "Double-click a row.",
              },
              {
                key: "ctrl+u",
                label: "Clear selection",
                note: "Uncheck every selected row.",
              },
              {
                key: "/",
                label: "Search",
                note: "Search the current view. Typing a name also opens search.",
              },
            ]),
        {
          key: "ctrl+t",
          label: "Next view",
          note: "Cycle through Inventory, Disabled and Trash.",
          mouse: "Click a view tab.",
        },
      ],
    },
    {
      label: "App",
      shortcuts: [
        {
          key: "ctrl+p",
          label: "Theme",
          note: "Preview a theme. Press Enter in the picker to save it.",
        },
        {
          key: "shift+←→",
          label: "Pane width",
          note: "Change the width of the section list.",
          mouse: "Drag the vertical divider.",
        },
        {
          key: "shift+↑↓",
          label: "Detail height",
          note: "Change the height of the detail pane.",
          mouse: "Drag the horizontal divider.",
        },
        {
          key: "esc",
          label: "Back",
          note:
            view === "disabled" || view === "trash"
              ? "Return to Inventory."
              : "Clear the filter, step back a pane, clear the selection, or exit, in that order.",
        },
        { key: "q", label: "Quit", note: "Exit Lampwright." },
      ],
    },
  ];
}

interface DetailLine {
  readonly text: string;
  readonly role?: "active" | "muted" | "warning";
}

function shortcutDetail(shortcut: Shortcut, width: number): DetailLine[] {
  const indent = width >= 16 ? "  " : "";
  const wrap = (text: string) =>
    wrapTerminalLine(text, Math.max(1, width - indent.length), "words");
  return [
    ...wrapTerminalLine(
      shortcut.key + "  " + shortcut.label,
      Math.max(1, width),
      "words",
    ).map((text) => ({
      text,
      role: shortcut.warning ? ("warning" as const) : ("active" as const),
    })),
    ...wrap(shortcut.note).map((text) => ({ text: indent + text })),
    ...(shortcut.mouse
      ? wrap("Mouse: " + shortcut.mouse).map((text) => ({
          text: indent + text,
          role: "muted" as const,
        }))
      : []),
  ];
}

function keyList<T>(
  items: readonly T[],
  index: number,
  first: number,
  height: number,
): TuiPaneView<T> {
  const offset = scrollFor(first, index, height, items.length);
  return {
    items: items.slice(offset, offset + height),
    offset,
    height,
    total: items.length,
  };
}

export function helpLayout(state: TuiHelpState) {
  const { model } = state.browse;
  const grid = layout(
    {
      viewport: model.viewport,
      leftPercent: state.leftPercent ?? model.leftPercent,
      detailRows: state.detailRows ?? layout(model).detailRows,
    },
    0,
  );
  const allSections = helpSections(state);
  const longestSummary = Math.max(
    ...allSections.map(
      (section) =>
        section.label.length +
        (" · " + section.shortcuts.length + " keys").length,
    ),
  );
  const split =
    grid.leftWidth >= "› Move and select".length &&
    grid.rightWidth >= longestSummary &&
    grid.detailRows > 0;
  const compact = fullPaneSize(model.viewport);
  const focus = state.focus ?? "sections";
  const sectionIndex = Math.min(
    allSections.length - 1,
    Math.max(0, state.sectionIndex ?? 0),
  );
  const current = allSections[sectionIndex]!;
  const keyIndex = Math.min(
    current.shortcuts.length - 1,
    Math.max(0, state.entryIndex ?? 0),
  );
  const shortcut = current.shortcuts[keyIndex]!;
  const keyCount =
    current.shortcuts.length +
    (current.shortcuts.length === 1 ? " key" : " keys");
  const wrapSummary =
    !split &&
    compact.bodyRows >= 2 &&
    (current.label + " · " + keyCount).length > compact.width;
  const sections = keyList(
    allSections,
    sectionIndex,
    state.sectionScroll ?? 0,
    split ? grid.paneRows : compact.bodyRows,
  );
  const keys = keyList(
    current.shortcuts,
    keyIndex,
    state.entryScroll ?? 0,
    split ? grid.entryRows : compact.bodyRows - (wrapSummary ? 1 : 0),
  );
  const height = split ? grid.detailRows : compact.bodyRows;
  const lines = shortcutDetail(
    shortcut,
    split ? grid.usable - 1 : compact.width,
  );
  const offset = Math.max(
    0,
    Math.min(state.scrollOffset ?? 0, lines.length - height),
  );
  const detail: TuiPaneView<DetailLine> = {
    items: lines.slice(offset, offset + height),
    offset,
    height,
    total: lines.length,
  };
  return {
    grid,
    split,
    compact,
    keyCount,
    wrapSummary,
    focus,
    sections,
    current,
    sectionIndex,
    keys,
    keyIndex,
    detail,
  };
}

export function settleHelp(state: TuiHelpState): TuiHelpState {
  const { sections, keys, detail } = helpLayout(state);
  return {
    ...state,
    sectionScroll: sections.offset,
    entryScroll: keys.offset,
    scrollOffset: detail.offset,
  };
}

export function navigateHelp(
  state: TuiHelpState,
  action: TuiAction,
): TuiHelpState {
  const { grid, split, focus, sections, keys, detail, sectionIndex, keyIndex } =
    helpLayout(state);
  if (action.kind === "focus") return { ...state, focus: action.pane };
  if (action.kind === "select")
    return { ...state, focus: focus === "sections" ? "entries" : "detail" };
  if (action.kind === "resize-panes" || action.kind === "set-left-percent") {
    const percent =
      action.kind === "set-left-percent"
        ? action.percent
        : (state.leftPercent ?? state.browse.model.leftPercent) + action.delta;
    return settleHelp({ ...state, leftPercent: clampPercent(percent) });
  }
  if (action.kind === "resize-detail" || action.kind === "set-detail-rows") {
    const rows =
      action.kind === "set-detail-rows"
        ? action.rows
        : grid.detailRows + action.delta;
    return settleHelp({
      ...state,
      detailRows: clampDetailRows(state.browse.model, rows, 0),
    });
  }
  if (
    action.kind === "point-section" ||
    action.kind === "point-entry" ||
    action.kind === "move" ||
    action.kind === "move-pane" ||
    action.kind === "page"
  ) {
    const pane =
      action.kind === "point-section"
        ? "sections"
        : action.kind === "point-entry"
          ? "entries"
          : action.kind === "move-pane"
            ? action.pane
            : focus;
    const view =
      pane === "sections" ? sections : pane === "entries" ? keys : detail;
    const index =
      pane === "sections"
        ? sectionIndex
        : pane === "entries"
          ? keyIndex
          : detail.offset;
    const next =
      "index" in action
        ? action.index
        : index + action.delta * (action.kind === "page" ? view.height : 1);
    if (pane === "detail")
      return settleHelp({ ...state, focus: pane, scrollOffset: next });
    const position = Math.min(view.total - 1, Math.max(0, next));
    if (pane === "sections")
      return settleHelp({
        ...state,
        focus: !split && action.kind === "point-section" ? "entries" : pane,
        sectionIndex: position,
        ...(position === sectionIndex
          ? {}
          : { entryIndex: 0, entryScroll: 0, scrollOffset: 0 }),
      });
    return settleHelp({
      ...state,
      focus: !split && action.kind === "point-entry" ? "detail" : pane,
      entryIndex: position,
      ...(position === keyIndex ? {} : { scrollOffset: 0 }),
    });
  }
  return state;
}
