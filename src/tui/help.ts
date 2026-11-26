import { layout } from "./browse.js";
import { fullPaneSize } from "./overlay.js";
import { searchPosition } from "./search.js";
import { wrapTerminalLine } from "./text.js";
import type { TuiAction, TuiHelpState } from "./types.js";

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

interface ControlLine {
  readonly key?: string;
  readonly text: string;
  readonly role?: "muted" | "active" | "warning";
}

function shortcutLines(
  shortcuts: readonly Shortcut[],
  width: number,
): ControlLine[] {
  const indent = width >= 16 ? "  " : "";
  const wrapBody = (text: string) =>
    wrapTerminalLine(text, Math.max(1, width - indent.length), "words");
  return shortcuts.flatMap(({ key, label, note, mouse, warning }) => {
    const headingRole = warning ? "warning" : "active";
    const prefix = key + "  ";
    const heading: ControlLine[] =
      prefix.length + label.length <= width
        ? [{ key: prefix, text: label, role: headingRole }]
        : [
            ...wrapTerminalLine(key, Math.max(1, width)).map((text) => ({
              key: text,
              text: "",
            })),
            ...wrapTerminalLine(label, Math.max(1, width), "words").map(
              (text) => ({ text, role: headingRole }) as const,
            ),
          ];
    return [
      ...heading,
      ...wrapBody(note).map((text) => ({ text: indent + text })),
      ...(mouse
        ? wrapBody("Mouse: " + mouse).map((text) => ({
            text: indent + text,
            role: "muted" as const,
          }))
        : []),
    ];
  });
}

export function helpLayout(state: TuiHelpState) {
  const { width, rows, bodyRows } = fullPaneSize(state.browse.model.viewport);
  const { leftWidth } = layout(state.browse.model);
  const split =
    leftWidth >= "› Move and select".length && width - leftWidth - 1 >= 27;
  const focus = state.focus ?? "sections";
  const controlsWidth = split ? width - leftWidth - 1 : width;
  const sections = helpSections(state);
  const ruleRows = rows >= 7 ? 1 : 0;
  const pageRows = Math.max(0, bodyRows - ruleRows);
  const { index, scroll: sectionOffset } = searchPosition(
    state.sectionIndex ?? 0,
    0,
    sections.length,
    Math.max(1, pageRows),
    0,
  );
  const current = sections[index]!;
  const controls = shortcutLines(current.shortcuts, controlsWidth);
  const maximumOffset = Math.max(0, controls.length - pageRows);
  const offset = Math.min(maximumOffset, Math.max(0, state.scrollOffset ?? 0));
  return {
    width,
    rows,
    split,
    focus,
    leftWidth,
    current,
    sections,
    index,
    sectionOffset,
    controls,
    offset,
    maximumOffset,
    pageRows,
    firstBodyRow: 2 + ruleRows,
  };
}

export function navigateHelp(
  state: TuiHelpState,
  action: TuiAction,
): TuiHelpState {
  if (action.kind === "focus")
    return action.pane === "detail" ? state : { ...state, focus: action.pane };
  if (
    action.kind !== "point-section" &&
    action.kind !== "move-pane" &&
    action.kind !== "move" &&
    action.kind !== "page"
  )
    return state;
  const grid = helpLayout(state);
  const pane =
    action.kind === "point-section"
      ? "sections"
      : action.kind === "move-pane"
        ? action.pane
        : grid.focus;
  const delta =
    action.kind === "point-section"
      ? 0
      : action.delta *
        (action.kind === "page" ? Math.max(1, grid.pageRows) : 1);
  if (pane === "entries")
    return {
      ...state,
      focus: pane,
      scrollOffset: Math.max(
        0,
        Math.min(grid.maximumOffset, grid.offset + delta),
      ),
    };
  if (pane !== "sections") return state;
  const index = Math.min(
    grid.sections.length - 1,
    Math.max(
      0,
      action.kind === "point-section" ? action.index : grid.index + delta,
    ),
  );
  return {
    ...state,
    focus: action.kind === "point-section" && !grid.split ? "entries" : pane,
    sectionIndex: index,
    scrollOffset: index === grid.index ? grid.offset : 0,
  };
}
