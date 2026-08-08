import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";

import { layout, panes } from "./browse.js";
import { searchLayout } from "./search.js";
import { renderTui } from "./render.js";
import {
  createNightfallTheme,
  detectTuiColorMode,
  plainTuiTheme,
  type TuiTheme,
} from "./theme.js";
import type { TuiAction, TuiState, TuiTerminal, TuiViewport } from "./types.js";

/**
 * The alternate screen, then click, drag, and SGR coordinate reporting.
 *
 * The alternate screen is not decoration: on the normal buffer a terminal
 * treats the wheel as its own scrollback and never forwards it, so the pane
 * cannot scroll however the app is configured. Leaving it also restores
 * whatever was on screen before, instead of burying it.
 */
const SCREEN_ON = "\u001B[?1049h";
const SCREEN_OFF = "\u001B[?1049l";
const MOUSE_ON = "\u001B[?1000h\u001B[?1002h\u001B[?1006h";
const MOUSE_OFF = "\u001B[?1006l\u001B[?1002l\u001B[?1000l";
const SGR_MOUSE = new RegExp(
  `${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
  "u",
);
const SGR_MOUSE_INCOMPLETE = new RegExp(
  `${String.fromCharCode(27)}\\[<\\d*(?:;\\d*(?:;\\d*)?)?$`,
  "u",
);
const DOUBLE_CLICK_MS = 400;

/** Rows above browse panes: title, hints, filter, and top rule. */
const BROWSE_PANE_TOP = 4;

interface MouseReport {
  readonly button: number;
  readonly column: number;
  readonly row: number;
  readonly pressed: boolean;
}

interface PointerRow {
  readonly pane: "sections" | "entries";
  readonly index: number;
}

type PointerPane = PointerRow["pane"] | "detail";
type DragTarget = false | "panes" | "detail";

export function parseMouseReport(sequence: string): MouseReport | null {
  const match = SGR_MOUSE.exec(sequence);
  if (match === null) return null;
  return {
    button: Number(match[1]),
    column: Number(match[2]),
    row: Number(match[3]),
    pressed: match[4] === "M",
  };
}

/**
 * Every mouse report in one read.
 *
 * Reports must be taken from the raw stream, not from keypress events: Node's
 * readline splits `ESC[<0;12;7M` into eight separate keypresses, so no single
 * event ever carries a whole report, and the leftover digits would be typed
 * into the filter. A wheel spin also delivers several reports at once.
 */
export function parseMouseReports(chunk: string): readonly MouseReport[] {
  const pattern = new RegExp(SGR_MOUSE.source, "gu");
  return [...chunk.matchAll(pattern)].map((match) => ({
    button: Number(match[1]),
    column: Number(match[2]),
    row: Number(match[3]),
    pressed: match[4] === "M",
  }));
}

/** Frames SGR reports when terminal data events split them arbitrarily. */
export class MouseReportFramer {
  private buffer = "";

  push(chunk: string): readonly MouseReport[] {
    const input = this.buffer + chunk;
    const pattern = new RegExp(SGR_MOUSE.source, "gu");
    const reports: MouseReport[] = [];
    let end = 0;
    for (const match of input.matchAll(pattern)) {
      reports.push({
        button: Number(match[1]),
        column: Number(match[2]),
        row: Number(match[3]),
        pressed: match[4] === "M",
      });
      end = (match.index ?? 0) + match[0].length;
    }
    const tail = input.slice(end);
    this.buffer = pendingSgrPrefix(tail) ? tail : "";
    return reports;
  }

  get pending(): boolean {
    return this.buffer.length > 0;
  }
}

function pendingSgrPrefix(value: string): boolean {
  const prefix = `${String.fromCharCode(27)}[<`;
  // Do not hold Esc or an ordinary CSI sequence: raw-terminal cancellation
  // must remain responsive. Once the SGR sentinel is complete, retain only a
  // syntactically possible unfinished report.
  return value.startsWith(prefix) && SGR_MOUSE_INCOMPLETE.test(value);
}

/**
 * Maps a pointer report onto the browse grid.
 *
 * Bit 6 marks a wheel report and bit 0 its direction; bit 5 marks motion.
 * Testing the bits rather than the whole code keeps this working when a
 * modifier is held. Motion is ignored unless a divider drag is in progress,
 * because otherwise every twitch of the pointer re-selects the row beneath it.
 */
export function mouseAction(
  state: TuiState,
  report: MouseReport,
  context: { dragging: DragTarget; doubleClick: boolean },
): TuiAction {
  if (state.screen === "plan")
    return (report.button & 64) !== 0
      ? { kind: "move", delta: (report.button & 1) === 0 ? -1 : 1 }
      : { kind: "noop" };
  if (state.screen === "search") {
    const grid = searchLayout(state.model.viewport);
    if (grid.compact) return { kind: "noop" };
    if ((report.button & 64) !== 0)
      return report.column >= 1 && report.column <= grid.leftWidth
        ? { kind: "move", delta: (report.button & 1) === 0 ? -1 : 1 }
        : { kind: "noop" };
    const row = report.row - grid.resultStartRow;
    if (
      !report.pressed ||
      report.column < 1 ||
      report.column > grid.leftWidth ||
      row < 0 ||
      row >= grid.resultRows
    )
      return { kind: "noop" };
    const index = state.model.scroll + row;
    if (index >= state.model.results.length) return { kind: "noop" };
    if (context.doubleClick)
      return { kind: "point-toggle", pane: "entries", index };
    return { kind: "point-search-result", index };
  }
  if (state.screen !== "browse") return { kind: "noop" };
  const grid = layout(state.model);
  const { leftWidth, columns, paneRows, rows } = grid;
  const detailDividerRow = BROWSE_PANE_TOP + paneRows + 1;

  if ((report.button & 64) !== 0) {
    const pane = pointerPane(state, report);
    if (pane === null) return { kind: "noop" };
    return {
      kind: "move-pane",
      pane,
      delta: (report.button & 1) === 0 ? -1 : 1,
    };
  }

  if (!report.pressed) return { kind: "noop" };
  if ((report.button & 3) !== 0) return { kind: "noop" };

  if (context.dragging === "detail" || report.row === detailDividerRow)
    return {
      kind: "set-detail-rows",
      rows: rows - report.row - 2,
    };

  if (
    context.dragging === "panes" ||
    (report.column === leftWidth + 1 &&
      report.row > BROWSE_PANE_TOP &&
      report.row < detailDividerRow)
  )
    return {
      kind: "set-left-percent",
      percent: Math.round((report.column / columns) * 100),
    };

  if ((report.button & 32) !== 0) return { kind: "noop" };

  if (pointerPane(state, report) === "detail")
    return { kind: "focus", pane: "detail" };

  const target = pointedRow(state, report);
  if (target === null) return { kind: "noop" };
  if (context.doubleClick) return { kind: "point-toggle", ...target };
  return target.pane === "sections"
    ? { kind: "point-section", index: target.index }
    : { kind: "point-entry", index: target.index };
}

function pointerPane(state: TuiState, report: MouseReport): PointerPane | null {
  if (state.screen !== "browse") return null;
  const { paneRows, detailRows, leftWidth, usable } = layout(state.model);
  const paneRow = report.row - BROWSE_PANE_TOP - 1;
  if (paneRow >= 0 && paneRow < paneRows) {
    if (report.column >= 1 && report.column <= leftWidth) return "sections";
    if (report.column > leftWidth + 1 && report.column <= usable)
      return "entries";
    return null;
  }
  const detailRow = report.row - (BROWSE_PANE_TOP + paneRows + 2);
  if (
    detailRow >= 0 &&
    detailRow < detailRows &&
    report.column >= 1 &&
    report.column <= usable
  )
    return "detail";
  return null;
}

function pointedRow(state: TuiState, report: MouseReport): PointerRow | null {
  if (state.screen !== "browse") return null;
  const pane = pointerPane(state, report);
  if (pane === null || pane === "detail") return null;
  const paneRow = report.row - BROWSE_PANE_TOP - 1;
  const view = panes(state.model);
  if (pane === "sections") {
    const index = view.sections.offset + paneRow;
    return index < view.sections.total ? { pane, index } : null;
  }
  if (paneRow === 0) return null; // section header row
  const index = view.entries.offset + paneRow - 1;
  return index < view.entries.total ? { pane, index } : null;
}

type TerminalInput = NodeJS.ReadStream;
type TerminalOutput = NodeJS.WriteStream;

export interface NodeTuiTerminalOptions {
  readonly theme?: TuiTheme;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
}

export function createNodeTuiTerminal(
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
  options: NodeTuiTerminalOptions = {},
): TuiTerminal {
  return input.isTTY && output.isTTY
    ? new RawTuiTerminal(
        input,
        output,
        options.theme ??
          createNightfallTheme(
            detectTuiColorMode({
              isTTY: true,
              platform: options.platform ?? process.platform,
              environment: options.environment ?? process.env,
            }),
          ),
      )
    : new LineTuiTerminal(input, output);
}

export function parseLineTuiAction(state: TuiState, line: string): TuiAction {
  const value = line.trim();
  if (state.screen === "browse") {
    if (value === "") return { kind: "select" };
    if (value === "up" || value === "k") return { kind: "move", delta: -1 };
    if (value === "down" || value === "j") return { kind: "move", delta: 1 };
    if (value === "in" || value === "l")
      return { kind: "focus", pane: "entries" };
    if (value === "out" || value === "h")
      return { kind: "focus", pane: "sections" };
    if (value === "detail") return { kind: "focus", pane: "detail" };
    if (value === "pageup") return { kind: "page", delta: -1 };
    if (value === "pagedown") return { kind: "page", delta: 1 };
    if (value === "grow-detail") return { kind: "resize-detail", delta: 1 };
    if (value === "shrink-detail") return { kind: "resize-detail", delta: -1 };
    if (value === "take" || value === "space") return { kind: "toggle-select" };
    if (value === "none") return { kind: "clear-selection" };
    if (value === "select" || value === "open" || value === "review")
      return { kind: "select" };
    if (value === "clear") return { kind: "clear-selection" };
    if (value === "backspace") return { kind: "delete-query" };
    if (value === "quit" || value === "q") return { kind: "quit" };
    if (value.startsWith("search "))
      return { kind: "append-query", value: value.slice("search ".length) };
    if (value.startsWith("/"))
      return { kind: "append-query", value: value.slice(1) };
    return { kind: "append-query", value };
  }
  if (state.screen === "search") {
    if (value === "up" || value === "k") return { kind: "move", delta: -1 };
    if (value === "down" || value === "j") return { kind: "move", delta: 1 };
    if (value === "take" || value === "space") return { kind: "toggle-select" };
    if (value === "all") return { kind: "stage-all-search" };
    if (value === "clear") return { kind: "clear-selection" };
    if (value === "done") return { kind: "apply-search" };
    if (value === "cancel") return { kind: "cancel" };
    return { kind: "append-query", value };
  }
  if (state.screen === "plan") {
    if (value === "details" || value === "d") return { kind: "toggle-details" };
    if (value === "up" || value === "k") return { kind: "move", delta: -1 };
    if (value === "down" || value === "j") return { kind: "move", delta: 1 };
    if (value === "pageup") return { kind: "page", delta: -1 };
    if (value === "pagedown") return { kind: "page", delta: 1 };
    if (value === "yes" || value === "y") return { kind: "confirm" };
    if (value === "force" || value === "f") return { kind: "force" };
    if (value === "quit" || value === "q") return { kind: "quit" };
    if (value === "no" || value === "n" || value === "back")
      return { kind: "cancel" };
    return { kind: "noop" };
  }
  if (state.screen === "report") {
    if (value === "up" || value === "k") return { kind: "move", delta: -1 };
    if (value === "down" || value === "j") return { kind: "move", delta: 1 };
    if (value === "fallback" || value === "f") return { kind: "fallback" };
    if (value === "quit" || value === "q" || value === "done")
      return { kind: "quit" };
    return { kind: "noop" };
  }
  if (state.screen === "error") return { kind: "quit" };
  return { kind: "noop" };
}

class RawTuiTerminal implements TuiTerminal {
  private dragging: DragTarget = false;
  private ignoringKeys = false;
  private lastClick = { target: "", at: 0 };
  private readonly mouse: MouseReport[] = [];
  private readonly mouseFramer = new MouseReportFramer();
  private readonly pending: { readonly text: string; readonly key: Key }[] = [];
  private resized: TuiViewport | null = null;
  private waiter: (() => void) | null = null;
  private readonly onKeypress = (text: string, key: Key): void => {
    if (this.ignoringKeys) return;
    this.pending.push({ text, key });
    this.wake();
  };
  private readonly onResize = (): void => {
    this.resized = viewportOf(this.output);
    this.wake();
  };

  private wake(): void {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter();
  }

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
    private readonly theme: TuiTheme,
  ) {
    // Registered before readline attaches its own reader, so a chunk carrying
    // mouse reports is claimed here and the keypresses readline shreds it into
    // are ignored rather than typed into the filter.
    input.on("data", this.onData);
    emitKeypressEvents(input);
    input.on("keypress", this.onKeypress);
    output.on("resize", this.onResize);
    input.setRawMode(true);
    input.resume();
    output.write(`${SCREEN_ON}\u001B[?25l${MOUSE_ON}`);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const wasPending = this.mouseFramer.pending;
    const reports = this.mouseFramer.push(chunk.toString("utf8"));
    if (reports.length === 0 && !this.mouseFramer.pending) {
      // A continuation proved the held prefix was not mouse input. Release it
      // before readline emits keypresses for this same data event.
      if (wasPending) this.ignoringKeys = false;
      return;
    }
    this.ignoringKeys = true;
    queueMicrotask(() => {
      if (!this.mouseFramer.pending) this.ignoringKeys = false;
    });
    for (const report of reports) this.mouse.push(report);
    this.wake();
  };

  render(state: TuiState): void {
    this.output.write(`\u001B[2J\u001B[H${renderTui(state, this.theme)}`);
  }

  async readAction(state: TuiState): Promise<TuiAction> {
    for (;;) {
      const resized = this.resized;
      if (resized !== null) {
        this.resized = null;
        return { kind: "viewport", viewport: resized };
      }

      const report = this.mouse.shift();
      if (report !== undefined) {
        const doubleClick = this.registerClick(state, report);
        const action = mouseAction(state, report, {
          dragging: this.dragging,
          doubleClick,
        });
        this.dragging = !report.pressed
          ? false
          : action.kind === "set-left-percent"
            ? "panes"
            : action.kind === "set-detail-rows"
              ? "detail"
              : false;
        if (action.kind !== "noop") return action;
        continue;
      }

      const next = this.pending.shift();
      if (next !== undefined) {
        this.dragging = false;
        return parseRawTuiAction(state, next.text, next.key);
      }

      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  /** A second primary-button press on the same pane row shortly after the first. */
  private registerClick(state: TuiState, report: MouseReport): boolean {
    if (
      !report.pressed ||
      (report.button & 96) !== 0 ||
      (report.button & 3) !== 0
    )
      return false;
    if (state.screen === "search" && searchLayout(state.model.viewport).compact)
      return false;
    const pointed = pointedRow(state, report);
    const searchRow =
      state.screen === "search" &&
      report.column >= 1 &&
      report.column <= searchLayout(state.model.viewport).leftWidth
        ? report.row -
          searchLayout(state.model.viewport).resultStartRow +
          state.model.scroll
        : -1;
    if (
      pointed === null &&
      (searchRow < 0 ||
        state.screen !== "search" ||
        searchRow >= state.model.results.length)
    )
      return false;
    const target =
      pointed === null
        ? `search:${String(searchRow)}`
        : `${pointed.pane}:${String(pointed.index)}`;
    const now = Date.now();
    const repeat =
      target === this.lastClick.target &&
      now - this.lastClick.at < DOUBLE_CLICK_MS;
    this.lastClick = { target, at: repeat ? 0 : now };
    return repeat;
  }

  close(): void {
    this.output.off("resize", this.onResize);
    this.input.off("keypress", this.onKeypress);
    this.input.setRawMode(false);
    this.input.pause();
    this.input.off("data", this.onData);
    this.output.write(`${MOUSE_OFF}\u001B[?25h${SCREEN_OFF}`);
  }
}

class LineTuiTerminal implements TuiTerminal {
  private readonly lines;

  constructor(
    input: TerminalInput,
    private readonly output: TerminalOutput,
  ) {
    this.lines = createInterface({ input, output, terminal: false });
  }

  render(state: TuiState): void {
    this.output.write(`${renderTui(state, plainTuiTheme)}\n`);
  }

  async readAction(state: TuiState): Promise<TuiAction> {
    try {
      return parseLineTuiAction(state, await this.lines.question("> "));
    } catch {
      return { kind: "quit" };
    }
  }

  close(): void {
    this.lines.close();
  }
}

/** Maps a decoded raw-terminal key into a semantic action. */
export function parseRawTuiAction(
  state: TuiState,
  text: string,
  key: Key,
): TuiAction {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (state.screen !== "search" && !key.ctrl && !key.meta && text === "q")
    return { kind: "quit" };
  if (key.name === "up" && !key.shift) return { kind: "move", delta: -1 };
  if (key.name === "down" && !key.shift) return { kind: "move", delta: 1 };
  if (state.screen === "browse") {
    if (key.name === "escape") return { kind: "cancel" };
    if (key.name === "return" || key.name === "enter")
      return { kind: "select" };
    if (key.name === "right" && key.shift)
      return { kind: "resize-panes", delta: 2 };
    if (key.name === "left" && key.shift)
      return { kind: "resize-panes", delta: -2 };
    if (key.name === "up" && key.shift)
      return { kind: "resize-detail", delta: -1 };
    if (key.name === "down" && key.shift)
      return { kind: "resize-detail", delta: 1 };
    if (key.name === "tab") {
      const panes = ["sections", "entries", "detail"] as const;
      const index = panes.indexOf(state.model.focus);
      const delta = key.shift ? -1 : 1;
      return {
        kind: "focus",
        pane: panes[(index + delta + panes.length) % panes.length]!,
      };
    }
    if (key.name === "right") return { kind: "focus", pane: "entries" };
    if (key.name === "left") return { kind: "focus", pane: "sections" };
    if (key.name === "pageup") return { kind: "page", delta: -1 };
    if (key.name === "pagedown") return { kind: "page", delta: 1 };
    if (key.name === "space" || text === " ") return { kind: "toggle-select" };
    if (key.ctrl && key.name === "a") return { kind: "clear-selection" };
    if (key.name === "backspace") return { kind: "delete-query" };
    if (key.ctrl && key.name === "u") return { kind: "clear-selection" };
    if (text === "/") return { kind: "open-search" };
    if (!key.ctrl && !key.meta && text.length > 0)
      return { kind: "append-query", value: text };
    return { kind: "noop" };
  }
  if (state.screen === "search") {
    if (key.name === "escape") return { kind: "cancel" };
    if (key.name === "return" || key.name === "enter")
      return { kind: "apply-search" };
    if (key.name === "pageup") return { kind: "page", delta: -1 };
    if (key.name === "pagedown") return { kind: "page", delta: 1 };
    if (key.name === "space" || text === " ") return { kind: "toggle-select" };
    if (key.ctrl && key.name === "a") return { kind: "stage-all-search" };
    if (key.ctrl && key.name === "u") return { kind: "clear-selection" };
    if (key.name === "backspace") return { kind: "delete-query" };
    if (!key.ctrl && !key.meta && text.length > 0)
      return { kind: "append-query", value: text };
    return { kind: "noop" };
  }
  if (state.screen === "plan") {
    if (key.name === "escape" || text === "n") return { kind: "cancel" };
    if (text === "d") return { kind: "toggle-details" };
    if (key.name === "pageup") return { kind: "page", delta: -1 };
    if (key.name === "pagedown") return { kind: "page", delta: 1 };
    if (text === "y") return { kind: "confirm" };
    if (text === "f") return { kind: "force" };
    return { kind: "noop" };
  }
  if (state.screen === "report") {
    if (key.name === "escape" || text === "q") return { kind: "quit" };
    if (text === "f") return { kind: "fallback" };
    return { kind: "noop" };
  }
  if (state.screen === "error") return { kind: "quit" };
  return { kind: "noop" };
}

function viewportOf(output: TerminalOutput): TuiViewport {
  return {
    rows: positiveDimension(output.rows, 30),
    columns: positiveDimension(output.columns, 100),
  };
}

function positiveDimension(
  value: number | undefined,
  fallback: number,
): number {
  return value === undefined || !Number.isFinite(value) || value < 1
    ? fallback
    : Math.floor(value);
}
