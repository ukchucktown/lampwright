// PROTOTYPE — throwaway terminal shell. Drives the pure model in model.mjs.
// Read-only: it scans, it renders, it selects. It cannot plan or remove.

import process from "node:process";

import { loadSections } from "./inventory.mjs";
import {
  createState,
  currentSection,
  currentSkill,
  currentSkills,
  reduce,
  selectionSummary,
  visibleSections,
} from "./model.mjs";

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;
const INV = (s) => `\x1b[7m${s}\x1b[0m`;

const LEFT = 30;

function width() {
  return Math.max(80, process.stdout.columns ?? 100);
}
function height() {
  return Math.max(24, process.stdout.rows ?? 30);
}

const pad = (s, n) =>
  [...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s.padEnd(n);

function render(state) {
  const w = width();
  const sections = visibleSections(state);
  const section = currentSection(state);
  const skills = currentSkills(state);
  const skill = currentSkill(state);
  const lines = [];

  const totalSelected = state.selected.length;
  lines.push(
    `${B("skill-cleaner")}  ${D("prototype — three panes")}   ${totalSelected > 0 ? B(`${totalSelected} selected`) : D("nothing selected")}`,
  );
  lines.push(
    state.query === ""
      ? D("search: (type to filter everything)")
      : `search: ${B(state.query)}  ${D(`${sections.reduce((n, s) => n + s.skills.length, 0)} matching`)}`,
  );
  lines.push("─".repeat(w));

  const bodyRows = Math.max(8, height() - 16);
  const left = [];
  sections.forEach((s, i) => {
    const focused = i === state.sectionIndex;
    const marker = focused && state.focus === "sections" ? ">" : " ";
    const count = String(s.skills.length).padStart(3);
    const label = pad(s.label, LEFT - 8);
    const row = `${marker} ${label}${count}${s.selectable ? "" : D(" ⃠")}`;
    left.push(focused ? INV(pad(stripAnsi(row), LEFT)) : row);
  });

  const right = [];
  if (section) {
    right.push(B(section.label));
    right.push(D(section.detail));
    right.push("");
    skills.slice(0, bodyRows - 3).forEach((s, i) => {
      const focused = i === state.skillIndex && state.focus === "skills";
      const box = state.selected.includes(s.key) ? "[x]" : "[ ]";
      const row = `${box} ${pad(s.name, 26)} ${pad(s.exposedTo.join(" "), 24)}${s.paths.length > 1 ? `${s.paths.length} paths` : ""}`;
      right.push(focused ? INV(row) : row);
    });
    if (skills.length > bodyRows - 3)
      right.push(D(`… ${skills.length - (bodyRows - 3)} more`));
  }

  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i += 1) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    lines.push(
      `${l}${" ".repeat(Math.max(0, LEFT - visibleLength(l)))} │ ${r}`,
    );
  }

  lines.push("─".repeat(w));
  if (skill) {
    lines.push(
      `${B(skill.name)}  ${D(`${skill.owner} · ${skill.bundle}${skill.spansGroups ? " · SPANS GROUPS" : ""}`)}`,
    );
    lines.push(D(`  ${skill.description.slice(0, w - 4)}`));
    for (const p of skill.paths.slice(0, 4)) lines.push(`  ${p}`);
  }

  if (state.reviewOpen) {
    lines.push("");
    lines.push(B("REVIEW — would request a Removal Plan for:"));
    for (const { label, count } of selectionSummary(state))
      lines.push(`  ${String(count).padStart(3)}  ${label}`);
    lines.push(D("  (prototype stops here; it cannot plan or execute)"));
  }

  lines.push("");
  if (state.notice) lines.push(B(`! ${state.notice}`));
  lines.push(
    D(
      "↑↓ move   ←→ switch pane   space select   S select section   a clear selection   enter review   esc back   ctrl-c quit",
    ),
  );
  lines.push(
    D(
      `state: focus=${state.focus} section=${state.sectionIndex} skill=${state.skillIndex} query=${JSON.stringify(state.query)} selected=${state.selected.length}`,
    ),
  );
  return lines.join("\n");
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function stripAnsi(s) {
  return s.replace(ANSI, "");
}
function visibleLength(s) {
  return [...stripAnsi(s)].length;
}

const sections = await loadSections();
let state = createState(sections);

function draw() {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(render(state) + "\n");
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
draw();

const KEYS = new Map([
  ["\u0003", "quit"],
  ["\u001b[A", { type: "move", delta: -1 }],
  ["\u001b[B", { type: "move", delta: 1 }],
  ["\u001b[D", { type: "focus-sections" }],
  ["\u001b[C", { type: "focus-skills" }],
  ["\r", { type: "review" }],
  ["\n", { type: "review" }],
  ["\u001b", { type: "escape" }],
  ["\u007f", { type: "backspace" }],
  ["\b", { type: "backspace" }],
  [" ", { type: "toggle-select" }],
  ["S", { type: "toggle-select-section" }],
  ["\u0001", { type: "clear-selection" }],
]);

process.stdin.on("data", (key) => {
  const mapped = KEYS.get(key);
  if (mapped === "quit") {
    process.stdout.write("\u001b[2J\u001b[H");
    process.exit(0);
  }
  const action =
    mapped ??
    (key.length === 1 && key >= " " && key <= "~"
      ? { type: "type", value: key }
      : null);
  if (action) state = reduce(state, action);
  draw();
});

process.stdout.on("resize", draw);
