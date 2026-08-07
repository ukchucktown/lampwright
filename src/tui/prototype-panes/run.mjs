// PROTOTYPE — throwaway terminal shell. Drives the pure model in model.mjs.
// Read-only: it scans, it renders, it selects. It cannot plan or remove.
//
// The frame is a fixed grid. Panes scroll under stationary borders so the
// detail area never moves.

import process from "node:process";

import { loadSections } from "./inventory.mjs";
import {
  createState,
  currentSection,
  currentSkill,
  layout,
  panes,
  reduce,
  selectionSummary,
} from "./model.mjs";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const B = (s) => `${ESC}[1m${s}${ESC}[0m`;
const D = (s) => `${ESC}[2m${s}${ESC}[0m`;
const INV = (s) => `${ESC}[7m${s}${ESC}[0m`;

const strip = (s) => s.replace(ANSI, "");
const len = (s) => [...strip(s)].length;
const pad = (s, n) =>
  len(s) > n
    ? [...strip(s)].slice(0, n - 1).join("") + "…"
    : s + " ".repeat(n - len(s));

function viewport() {
  return {
    rows: process.stdout.rows ?? 30,
    columns: process.stdout.columns ?? 100,
  };
}

function scrollbar(offset, height, total, index) {
  if (total <= height) return " ";
  const at = Math.round((index / Math.max(1, total - 1)) * (height - 1));
  return offset >= 0 ? (at === index - offset ? "█" : "│") : "│";
}

function render(state) {
  const { columns, paneRows, detailRows, leftWidth, rightWidth } =
    layout(state);
  const view = panes(state);
  const section = currentSection(state);
  const skill = currentSkill(state);
  const lines = [];

  lines.push(
    `${B("skill-cleaner")} ${D("prototype — panes")}  ${
      state.selected.length > 0
        ? B(`${state.selected.length} selected`)
        : D("nothing selected")
    }`,
  );
  lines.push(
    state.query === ""
      ? D("search: (type to filter)")
      : `search: ${B(state.query)} ${D(`${view.skills.total} here`)}`,
  );
  lines.push("─".repeat(leftWidth) + "┬" + "─".repeat(columns - leftWidth - 1));

  for (let row = 0; row < paneRows; row += 1) {
    const s = view.sections.items[row];
    let left = "";
    if (s) {
      const index = view.sections.offset + row;
      const focused = index === state.sectionIndex;
      const marker = focused && state.focus === "sections" ? "▸" : " ";
      const text = `${marker} ${pad(s.label, leftWidth - 8)}${String(s.skills.length).padStart(4)}${s.selectable ? " " : "⃠"}`;
      left = focused ? INV(pad(strip(text), leftWidth)) : pad(text, leftWidth);
    } else {
      left = " ".repeat(leftWidth);
    }

    let right = "";
    if (row === 0 && section) {
      right = `${B(pad(section.label, 30))}${D(section.detail)}`;
    } else if (row > 0 && view.skills.items[row - 1]) {
      const k = view.skills.items[row - 1];
      const index = view.skills.offset + row - 1;
      const focused = index === state.skillIndex && state.focus === "skills";
      const box = state.selected.includes(k.key) ? "▣" : "▢";
      const text = `${box} ${pad(k.name, 28)} ${pad(k.exposedTo.join(" "), 22)}${k.paths.length > 1 ? `${k.paths.length} paths` : ""}`;
      right = focused ? INV(pad(strip(text), rightWidth)) : text;
    }
    lines.push(
      `${left}│${pad(right, rightWidth)}${scrollbar(
        view.skills.offset,
        paneRows,
        view.skills.total,
        state.skillIndex,
      )}`,
    );
  }

  lines.push("─".repeat(leftWidth) + "┴" + "─".repeat(columns - leftWidth - 1));

  const detail = [];
  if (state.reviewOpen) {
    detail.push(B("REVIEW — would request a Removal Plan for:"));
    for (const { label, count } of selectionSummary(state))
      detail.push(`  ${String(count).padStart(3)}  ${label}`);
    detail.push(D("  prototype stops here; it cannot plan or execute"));
  } else if (skill) {
    detail.push(
      `${B(skill.name)}  ${D(`${skill.owner} · ${skill.bundle}${skill.spansGroups ? " · SPANS GROUPS" : ""}`)}`,
    );
    detail.push(D(`  ${skill.description}`));
    for (const p of skill.paths) detail.push(`  ${p}`);
  }
  for (let row = 0; row < detailRows; row += 1)
    lines.push(pad(detail[row] ?? "", columns));

  lines.push(
    D(
      "↑↓ move  ←→ pane  PgUp/PgDn page  space select  S section  ^a clear  enter review  esc back  ^c quit",
    ),
  );
  lines.push(
    state.notice
      ? B(`! ${state.notice}`)
      : D(
          `shift-←→ width ${String(state.leftPercent)}%  shift-↑↓ detail ${String(detailRows)}  focus=${state.focus} sec=${state.sectionIndex}/${view.sections.total} skill=${state.skillIndex}/${view.skills.total} sel=${state.selected.length}`,
        ),
  );
  return lines.join("\n");
}

const sections = await loadSections();
let state = createState(sections, viewport());

function draw() {
  process.stdout.write(`${ESC}[2J${ESC}[H${render(state)}`);
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

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
draw();

process.stdin.on("data", (key) => {
  if (key === "") {
    process.stdout.write(`${ESC}[2J${ESC}[H`);
    process.exit(0);
  }
  const action =
    KEYS.get(key) ??
    (key.length === 1 && key >= " " && key <= "~"
      ? { type: "type", value: key }
      : null);
  if (action) state = reduce(state, action);
  draw();
});

process.stdout.on("resize", () => {
  state = reduce(state, { type: "viewport", viewport: viewport() });
  draw();
});
