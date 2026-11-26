import {
  layout,
  scrollFor,
  clampPercent,
  clampDetailRows,
  type PaneGrid,
} from "./browse.js";
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
                note: "Inspect files for the checked items or the focused entry.",
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
          label: "Focus next pane",
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
          label: "Switch views",
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
          label: "Choose a theme",
          note: "Preview a theme. Press Enter in the picker to save it.",
        },
        {
          key: "shift+←→",
          label: "Resize section pane",
          note: "Change the width of the section list.",
          mouse: "Drag the vertical divider.",
        },
        {
          key: "shift+↑↓",
          label: "Resize detail pane",
          note: "Change the height of the detail pane.",
          mouse: "Drag the horizontal divider.",
        },
        {
          key: "esc",
          label: "Go back",
          note:
            view === "disabled" || view === "trash"
              ? "Return to Inventory."
              : "Clear the filter, step back a pane, clear the selection, or exit, in that order.",
        },
        { key: "q", label: "Quit Lampwright", note: "Exit Lampwright." },
      ],
    },
  ];
}

interface DetailLine {
  readonly text: string;
  readonly role?: "active" | "muted" | "warning";
}

function shortcutDetail(
  shortcut: Shortcut,
  width: number,
  singleRow: boolean,
): DetailLine[] {
  const indent = !singleRow && width >= 16 ? "  " : "";
  const wrap = (text: string, padding = "") =>
    wrapTerminalLine(text, Math.max(1, width - padding.length), "words").map(
      (line) => padding + line,
    );
  const heading = shortcut.key + "  " + shortcut.label;
  const role = shortcut.warning ? "warning" : "active";
  const mouse = shortcut.mouse ? "Mouse: " + shortcut.mouse : "";
  const titleLines: DetailLine[] = wrap(heading).map((text) => ({
    text,
    role,
  }));
  const noteLines: DetailLine[] = wrap(shortcut.note, indent).map((text) => ({
    text,
  }));
  const mouseLines: DetailLine[] = mouse
    ? wrap(mouse, indent).map((text) => ({ text, role: "muted" }))
    : [];
  if (!singleRow) return [...titleLines, ...noteLines, ...mouseLines];

  const explanation = mouse ? shortcut.note + "  " + mouse : shortcut.note;
  const complete = heading + " · " + explanation;
  if (complete.length <= width) return [{ text: complete, role }];
  if (explanation.length <= width)
    return [{ text: explanation }, ...titleLines];
  return [...noteLines, ...mouseLines, ...titleLines];
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

interface ShortcutRow {
  readonly index: number;
  readonly key: string;
  readonly definition: string;
}

/** Each physical row identifies the shortcut that owns it, including wrapped definitions. */
function shortcutList(
  shortcuts: readonly Shortcut[],
  width: number,
  height: number,
  selected: number,
  first: number,
) {
  const inline = shortcuts.filter(
    ({ key, label }) => key.length + 2 + label.length <= width,
  );
  const keyWidth = Math.max(0, ...inline.map((item) => item.key.length));
  const rows: ShortcutRow[] = [];
  const starts: number[] = [];
  for (const [index, { key, label }] of shortcuts.entries()) {
    starts.push(rows.length);
    if (key.length + 2 + label.length <= width) {
      const column = Math.min(keyWidth + 2, width - label.length);
      rows.push({ index, key: key.padEnd(column), definition: label });
    } else {
      rows.push({ index, key, definition: "" });
      for (const line of wrapTerminalLine(label, Math.max(1, width), "words"))
        rows.push({ index, key: "", definition: line });
    }
  }
  const start = starts[selected]!;
  const end = starts[selected + 1] ?? rows.length;
  // Keep the whole item visible when it fits. An oversized item pages within its own lines.
  const low = Math.min(start, end - height);
  const high = Math.max(start, end - height);
  const offset =
    end === start + 1
      ? scrollFor(first, start, height, rows.length)
      : Math.max(
          0,
          Math.min(rows.length - height, Math.max(low, Math.min(first, high))),
        );
  const view: TuiPaneView<ShortcutRow> = {
    items: rows.slice(offset, offset + height),
    offset,
    total: rows.length,
    height,
  };
  return { view, rows, starts };
}

const shortSectionLabels: Readonly<Record<string, string>> = {
  Inventory: "Inv",
  Disabled: "Dis",
  Trash: "Trash",
  "Move and select": "Move",
  App: "App",
};

export function helpSectionLabel(label: string, width: number): string {
  if (label.length <= width) return label;
  const short = shortSectionLabels[label] ?? label;
  return short.length <= width ? short : short.slice(0, Math.max(1, width));
}

export function helpLayout(state: TuiHelpState) {
  const { model } = state.browse;
  const base = layout(
    {
      viewport: model.viewport,
      leftPercent: state.leftPercent ?? model.leftPercent,
      detailRows: state.detailRows ?? layout(model).detailRows,
    },
    0,
  );
  const allSections = helpSections(state);
  const sectionWidth = Math.max(
    ...allSections.map((section) => section.label.length),
  );
  const summaryWidth = Math.max(
    ...allSections.map(
      (section) =>
        (section.label + " · " + section.shortcuts.length + " keys").length,
    ),
  );
  const { rows: drawableRows } = fullPaneSize(model.viewport);
  // Keep at least a short section label and the longest complete chord visible.
  const chordWidth = Math.max(
    ...allSections.flatMap((s) => s.shortcuts.map((k) => k.key.length)),
  );
  const minLeft = "Inv".length;
  const availableWidth = base.usable - 2; // Divider and key scrollbar.
  const visible = availableWidth >= minLeft + chordWidth && drawableRows >= 3;
  const fullLabels = availableWidth >= sectionWidth + summaryWidth;
  const minimumLeft = fullLabels ? sectionWidth : minLeft;
  const maximumLeft = availableWidth - (fullLabels ? summaryWidth : chordWidth);
  const leftWidth = Math.max(
    minimumLeft,
    Math.min(base.leftWidth, maximumLeft),
  );
  // At the minimum height the summary carries the Escape hint in place of the footer.
  const footerRows = drawableRows <= 3 ? 0 : 1;
  const listRows = Math.max(
    2,
    Math.min(allSections.length, drawableRows - footerRows - 1),
  );
  const spareRows = drawableRows - listRows - footerRows - 1;
  const compactHeight = spareRows < 2 || (!fullLabels && base.detailRows === 1);
  const grid: PaneGrid = {
    ...base,
    leftWidth,
    rightWidth: Math.max(0, availableWidth - leftWidth),
    ...(compactHeight
      ? {
          paneRows: listRows,
          entryRows: listRows - 1,
          detailRows: Math.max(1, 1 + spareRows - (spareRows > 0 ? 1 : 0)),
          hideTopRule: true,
          hideDetailRule: spareRows <= 0,
        }
      : {}),
  };
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
  const sections = keyList(
    allSections,
    sectionIndex,
    state.sectionScroll ?? 0,
    grid.paneRows,
  );
  const shortcuts = shortcutList(
    current.shortcuts,
    grid.rightWidth,
    grid.entryRows,
    keyIndex,
    state.entryScroll ?? 0,
  );
  const keys = shortcuts.view;
  const height = grid.detailRows;
  const lines = shortcutDetail(shortcut, grid.usable - 1, height === 1);
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
    visible,
    footerRows,
    keyCount,
    focus,
    sections,
    current,
    sectionIndex,
    keys,
    shortcuts,
    keyIndex,
    detail,
  };
}

export function settleHelp(state: TuiHelpState): TuiHelpState {
  const { visible, sections, keys, detail } = helpLayout(state);
  if (!visible) return state;
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
  const {
    grid,
    visible,
    focus,
    sections,
    keys,
    shortcuts,
    current,
    detail,
    sectionIndex,
    keyIndex,
  } = helpLayout(state);
  if (!visible) return state;
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
    if (pane === "entries" && action.kind === "page") {
      const anchor = Math.max(shortcuts.starts[keyIndex]!, keys.offset);
      const target = Math.max(
        0,
        Math.min(keys.total - 1, anchor + action.delta * keys.height),
      );
      const entryIndex = shortcuts.rows[target]!.index;
      return settleHelp({
        ...state,
        focus: pane,
        entryIndex,
        entryScroll: target,
        ...(entryIndex === keyIndex ? {} : { scrollOffset: 0 }),
      });
    }
    const next =
      "index" in action
        ? action.index
        : index + action.delta * (action.kind === "page" ? view.height : 1);
    if (pane === "detail")
      return settleHelp({ ...state, focus: pane, scrollOffset: next });
    const count =
      pane === "entries" ? current.shortcuts.length : sections.total;
    const position = Math.min(count - 1, Math.max(0, next));
    if (pane === "sections")
      return settleHelp({
        ...state,
        focus: pane,
        sectionIndex: position,
        ...(position === sectionIndex
          ? {}
          : { entryIndex: 0, entryScroll: 0, scrollOffset: 0 }),
      });
    return settleHelp({
      ...state,
      focus: pane,
      entryIndex: position,
      ...(position === keyIndex
        ? {}
        : {
            scrollOffset: 0,
            ...(action.kind === "point-entry" &&
            keys.items.some((row) => row.index === position)
              ? {}
              : { entryScroll: shortcuts.starts[position]! }),
          }),
    });
  }
  return state;
}
