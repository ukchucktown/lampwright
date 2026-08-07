// PROTOTYPE — throwaway terminal shell. Drives the pure model in model.mjs.
// Read-only: it scans, it renders, it selects. It cannot plan or remove.
//
// The frame is a fixed grid. Every line is clipped one column short of the
// terminal width: writing into the last cell makes an auto-margin terminal wrap,
// which silently adds a row and shifts everything below it.

import process from "node:process";

import { loadSections } from "./inventory.mjs";
import { render, PANE_TOP } from "./frame.mjs";
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

function draw() {
  process.stdout.write(`${ESC}[H${ESC}[2J${render(state)}`);
}

// ── mouse ──────────────────────────────────────────────────────────────────

const MOUSE_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`;
const SGR = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`);

let dragging = false;

function onMouse(button, column, row, pressed) {
  const { paneRows, leftWidth, columns } = layout(state);
  const view = panes(state);

  if (button === 64 || button === 65) {
    state = reduce(state, {
      type: "scroll",
      pane: column <= leftWidth ? "sections" : "skills",
      delta: button === 64 ? -3 : 3,
    });
    return;
  }

  if (!pressed) {
    dragging = false;
    return;
  }

  const onDivider = Math.abs(column - (leftWidth + 1)) <= 1;
  if (dragging || (onDivider && button < 32)) {
    dragging = true;
    state = reduce(state, {
      type: "set-left-percent",
      percent: Math.round((column / columns) * 100),
    });
    return;
  }

  const paneRow = row - PANE_TOP - 1;
  if (paneRow < 0 || paneRow >= paneRows) return;

  if (column <= leftWidth) {
    const index = view.sections.offset + paneRow;
    if (index < view.sections.total)
      state = reduce(state, { type: "point-section", index });
    return;
  }

  if (paneRow === 0) return; // section header row
  const index = view.skills.offset + paneRow - 1;
  if (index >= view.skills.total) return;
  state = reduce(state, { type: "point-skill", index });
  if (column >= leftWidth + 2 && column <= leftWidth + 4)
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

  const mouse = SGR.exec(chunk);
  if (mouse) {
    onMouse(
      Number(mouse[1]),
      Number(mouse[2]),
      Number(mouse[3]),
      mouse[4] === "M",
    );
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
