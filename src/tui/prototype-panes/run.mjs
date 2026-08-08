// PROTOTYPE — throwaway terminal shell. Drives the pure model in model.mjs.
// Read-only: it scans, it renders, it selects. It cannot plan or remove.
//
// The frame is a fixed grid. Every line is clipped one column short of the
// terminal width: writing into the last cell makes an auto-margin terminal wrap,
// which silently adds a row and shifts everything below it.

import process from "node:process";

import { loadSections } from "./inventory.mjs";
import { renderLines, PANE_TOP } from "./frame.mjs";
import { createState, layout, panes, reduce } from "./model.mjs";

const ESC = String.fromCharCode(27);

function viewport() {
  return {
    rows: process.stdout.rows ?? 30,
    columns: process.stdout.columns ?? 100,
  };
}

const sections = await loadSections();
let state = createState(sections, viewport());

// Repaint in place: home, then each line erased to its end. Clearing the whole
// screen every event tears visibly under a stream of mouse reports.
function draw() {
  const lines = renderLines(state, { lastMouse });
  process.stdout.write(
    `${ESC}[H` + lines.map((line) => `${line}${ESC}[K`).join("\n") + `${ESC}[J`,
  );
}

// ── mouse ──────────────────────────────────────────────────────────────────

const MOUSE_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`;
const SGR = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "g");
const X10 = new RegExp(`${ESC}\\[M([\\s\\S])([\\s\\S])([\\s\\S])`, "g");

/** Every mouse report in a chunk. A wheel spin delivers several at once. */
function mouseEvents(chunk) {
  const events = [];
  SGR.lastIndex = 0;
  for (const m of chunk.matchAll(SGR))
    events.push({
      button: Number(m[1]),
      column: Number(m[2]),
      row: Number(m[3]),
      pressed: m[4] === "M",
    });
  if (events.length > 0) return events;
  X10.lastIndex = 0;
  for (const m of chunk.matchAll(X10)) {
    const button = m[1].codePointAt(0) - 32;
    events.push({
      button: button === 3 ? 0 : button,
      column: m[2].codePointAt(0) - 32,
      row: m[3].codePointAt(0) - 32,
      pressed: button !== 3,
    });
  }
  return events;
}

let dragging = false;
let lastClick = { row: -1, column: -1, at: 0 };
const DOUBLE_CLICK_MS = 400;
/** Shown in the status line so "mouse does nothing" can be told apart from
 *  "the terminal never sent an event". */
let lastMouse = "none";

/** A second press on the same row shortly after the first. */
function doubleClick(row, column) {
  const now = Date.now();
  const repeat = row === lastClick.row && now - lastClick.at < DOUBLE_CLICK_MS;
  lastClick = { row, column, at: repeat ? 0 : now };
  return repeat;
}

function onMouse(button, column, row, pressed) {
  const { paneRows, leftWidth, columns } = layout(state);
  const view = panes(state);

  // Bit 6 marks a wheel report and bit 0 its direction; the remaining bits
  // carry modifiers, so an exact comparison misses a wheel with shift held.
  //
  // One row per report. A notch emits several reports and each is handled, so
  // any larger step here multiplies into a lurch instead of a scroll.
  if ((button & 64) !== 0) {
    const pane = column <= leftWidth ? "sections" : "skills";
    if (pane === "skills" && state.focus !== "skills")
      state = reduce(state, { type: "focus-skills" });
    if (pane === "sections" && state.focus !== "sections")
      state = reduce(state, { type: "focus-sections" });
    state = reduce(state, { type: "move", delta: (button & 1) === 0 ? -1 : 1 });
    return;
  }

  if (!pressed) {
    dragging = false;
    return;
  }

  const motion = (button & 32) !== 0;
  const onDivider = column === leftWidth + 1;

  if (dragging || (onDivider && !motion)) {
    dragging = true;
    state = reduce(state, {
      type: "set-left-percent",
      percent: Math.round((column / columns) * 100),
    });
    return;
  }

  // Motion with a button held is not a click; without this every twitch of the
  // pointer re-selects whatever row it passes over.
  if (motion) return;

  const paneRow = row - PANE_TOP - 1;
  if (paneRow < 0 || paneRow >= paneRows) return;

  if (column <= leftWidth) {
    const index = view.sections.offset + paneRow;
    if (index >= view.sections.total) return;
    state = reduce(state, { type: "point-section", index });
    if (doubleClick(row, column))
      state = reduce(state, { type: "toggle-select" });
    return;
  }

  if (paneRow === 0) return; // section header row
  const index = view.skills.offset + paneRow - 1;
  if (index >= view.skills.total) return;
  state = reduce(state, { type: "point-skill", index });
  if (doubleClick(row, column))
    state = reduce(state, { type: "toggle-select" });
}

const KEYS = new Map([
  [`${ESC}[A`, { type: "move", delta: -1 }],
  [`${ESC}[B`, { type: "move", delta: 1 }],
  [`${ESC}[D`, { type: "focus-sections" }],
  [`${ESC}[C`, { type: "focus-skills" }],
  [`${ESC}[5~`, { type: "page", delta: -1 }],
  [`${ESC}[6~`, { type: "page", delta: 1 }],
  [`${ESC}[1;2D`, { type: "resize-panes", delta: -2 }],
  [`${ESC}[1;2C`, { type: "resize-panes", delta: 2 }],
  [`${ESC}[1;2A`, { type: "resize-detail", delta: -1 }],
  [`${ESC}[1;2B`, { type: "resize-detail", delta: 1 }],
  ["\r", { type: "review" }],
  ["\n", { type: "review" }],
  [ESC, { type: "escape" }],
  ["", { type: "backspace" }],
  ["\b", { type: "backspace" }],
  [" ", { type: "toggle-select" }],
  ["S", { type: "toggle-select-section" }],
  ["", { type: "clear-selection" }],
]);

function quit() {
  process.stdout.write(`${MOUSE_OFF}${ESC}[?25h${ESC}[H${ESC}[2J`);
  process.exit(0);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write(`${MOUSE_ON}${ESC}[?25l`);
process.on("exit", () => process.stdout.write(`${MOUSE_OFF}${ESC}[?25h`));
draw();

process.stdin.on("data", (chunk) => {
  if (chunk === "") quit();

  const events = mouseEvents(chunk);
  if (events.length > 0) {
    for (const event of events) {
      lastMouse = `${event.button}@${event.column},${event.row}${event.pressed ? "" : " up"}`;
      onMouse(event.button, event.column, event.row, event.pressed);
    }
    draw();
    return;
  }

  const action =
    KEYS.get(chunk) ??
    (chunk.length === 1 && chunk >= " " && chunk <= "~"
      ? { type: "type", value: chunk }
      : null);
  if (action) state = reduce(state, action);
  draw();
});

process.stdout.on("resize", () => {
  state = reduce(state, { type: "viewport", viewport: viewport() });
  draw();
});
