#!/usr/bin/env node

// PROTOTYPE: a disposable terminal shell for evaluating Source Group navigation.

import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";

import {
  createState,
  fuzzyResults,
  groups,
  reduce,
  stateSummary,
  treeRows,
  variants,
} from "./model.mjs";

const realMode = process.argv.includes("--real");
let inventoryLabel = "Synthetic Inventory · read-only";
if (realMode) {
  process.stdout.write("Scanning bounded skill roots for live Inventory…\n");
  const { loadRealGroups } = await import("./real-inventory.mjs");
  const realGroups = await loadRealGroups();
  groups.splice(0, groups.length, ...realGroups);
  inventoryLabel = `${groups.flatMap((group) => group.skills).length} live Installations · read-only scan`;
}

const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  inverse: "\u001B[7m",
};

if (process.argv.includes("--snapshot") || !process.stdin.isTTY) {
  for (const variant of variants) {
    process.stdout.write(`${render(createState(variant.key))}\n`);
  }
  process.exit(0);
}

let state = createState();
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\u001B[?25l");
renderFrame();

process.stdin.on("keypress", (text, key) => {
  if ((key.ctrl && key.name === "c") || (text === "q" && !typing(state)))
    return close();
  const action = keyToAction(text, key, state);
  if (action !== null) state = reduce(state, action);
  renderFrame();
});

function renderFrame() {
  process.stdout.write(`\u001B[2J\u001B[H${render(state)}`);
}

function close() {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\u001B[?25h\n");
  process.exit(0);
}

function keyToAction(text, key, current) {
  if (["1", "2", "3"].includes(text))
    return { type: "variant", variant: variants[Number(text) - 1].key };
  if (
    key.name === "up" ||
    (text === "k" && !typing(current)) ||
    (key.ctrl && (key.name === "k" || key.name === "p"))
  )
    return { type: "move", delta: -1 };
  if (
    key.name === "down" ||
    (text === "j" && !typing(current)) ||
    (key.ctrl && (key.name === "j" || key.name === "n"))
  )
    return { type: "move", delta: 1 };
  if (key.name === "left" || (text === "h" && !typing(current)))
    return { type: "left" };
  if (key.name === "right" || (text === "l" && !typing(current)))
    return { type: "right" };
  if (key.name === "return" || key.name === "enter") return { type: "accept" };
  if (key.name === "escape") return { type: "escape" };
  if (key.name === "backspace") return { type: "delete-query" };
  if (key.ctrl && key.name === "u") return { type: "clear-query" };
  if (key.name === "tab" || (text === " " && !typing(current)))
    return { type: "toggle-selected" };
  if (text === "/") return { type: "search" };
  if (text === "e" && current.variant === "C" && !typing(current))
    return { type: "toggle-expanded" };
  if (typing(current) && !key.ctrl && !key.meta && text.length > 0)
    return { type: "append-query", value: text };
  return null;
}

function typing(current) {
  return current.searchActive || current.variant === "B";
}

function render(current) {
  const header = renderHeader(current);
  const body = current.reviewOpen
    ? renderReview(current)
    : current.searchActive && current.variant !== "B"
      ? renderFuzzy(current, true)
      : current.variant === "A"
        ? renderNavigator(current)
        : current.variant === "B"
          ? renderFuzzy(current, false)
          : renderTree(current);
  return [header, body, renderState(current), renderKeys(current)].join("\n");
}

function renderHeader(current) {
  const variant = variants.find(
    (candidate) => candidate.key === current.variant,
  );
  return [
    `${ansi.bold}${ansi.cyan}skill-cleaner navigation prototype${ansi.reset}  ${ansi.yellow}${variant.key} — ${variant.name}${ansi.reset}`,
    `${ansi.dim}${inventoryLabel}${ansi.reset}`,
    `${ansi.dim}Variants: [1] three-pane  [2] fzf-first  [3] tree${ansi.reset}`,
    rule(),
  ].join("\n");
}

function renderNavigator(current) {
  const group = groups[current.groupIndex];
  const item = group.skills[current.itemIndex];
  const left = [
    title("SOURCE GROUPS", current.focus === "groups"),
    ...groups.map((candidate, index) =>
      row(
        `${candidate.kind === "Plugin" ? "◆" : candidate.kind === "Source Group" ? "▣" : "·"} ${candidate.name} (${candidate.skills.length})`,
        current.focus === "groups" && index === current.groupIndex,
      ),
    ),
  ];
  const middle = [
    title(group.name.toUpperCase(), current.focus === "skills"),
    `${ansi.dim}${group.kind} · ${group.owner}${ansi.reset}`,
    "",
    ...group.skills.map((candidate, index) =>
      row(
        `${mark(current, candidate)} ${candidate.name}`,
        current.focus === "skills" && index === current.itemIndex,
      ),
    ),
  ];
  return columns(left, middle, preview(group, item), navigatorWidths());
}

function renderFuzzy(current, overlay) {
  const results = fuzzyResults(current);
  const active = results[current.rowIndex];
  const left = [
    title(overlay ? "GLOBAL FUZZY OVERLAY" : "FZF-FIRST INVENTORY", true),
    `${ansi.cyan}>${ansi.reset} ${current.query}${ansi.inverse} ${ansi.reset}`,
    `${ansi.dim}${results.length}/${groups.flatMap((group) => group.skills).length} matches · ${current.selectedIds.length} selected${ansi.reset}`,
    "",
    ...windowed(results, current.rowIndex, 10).map(({ value, index }) =>
      row(
        `${mark(current, value.skill)} ${value.skill.name.padEnd(18)} ${ansi.dim}${value.group.name} / ${value.group.owner}${ansi.reset}`,
        index === current.rowIndex,
      ),
    ),
  ];
  return columns(
    left,
    preview(active?.group, active?.skill),
    [],
    finderWidths(),
  );
}

function renderTree(current) {
  const rows = treeRows(current);
  const active = rows[current.rowIndex];
  const list = [
    title("INSTALLATION SOURCES", true),
    `${ansi.dim}Groups stay navigational; only Installation rows can be marked.${ansi.reset}`,
    "",
    ...windowed(rows, current.rowIndex, 12).map(({ value, index }) => {
      const expanded = current.expandedGroupIds.includes(value.group.id);
      const text =
        value.kind === "group"
          ? `${expanded ? "▾" : "▸"} ${value.group.name}  ${ansi.dim}${value.group.kind} · ${value.group.skills.length}${ansi.reset}`
          : `    ${mark(current, value.skill)} ${value.skill.name.padEnd(18)} ${ansi.dim}${value.skill.status}${ansi.reset}`;
      return row(text, index === current.rowIndex);
    }),
  ];
  const lower = [
    rule(),
    ...(active?.kind === "group"
      ? groupPreview(active.group)
      : preview(active?.group, active?.skill)),
  ];
  return [...list, ...lower].join("\n");
}

function renderReview(current) {
  const selected = groups
    .flatMap((group) => group.skills.map((skill) => ({ group, skill })))
    .filter(({ skill }) => current.selectedIds.includes(skill.id));
  return [
    title("PROPOSED PLAN REVIEW TRANSITION", true),
    "",
    `${ansi.bold}${selected.length} Installation target(s)${ansi.reset}`,
    ...selected.map(
      ({ group, skill }) =>
        `  ${ansi.green}✓${ansi.reset} ${skill.name}  ${ansi.dim}${group.name} / ${skill.status}${ansi.reset}`,
    ),
    "",
    `${ansi.yellow}No plan was created and nothing can execute in this prototype.${ansi.reset}`,
    "The production UI would now request one complete Removal Plan for these exact Installation IDs.",
    "Press Esc to return and adjust the selection.",
  ].join("\n");
}

function preview(group, item) {
  if (group === undefined) return [title("PREVIEW", false), "No match"];
  if (item === undefined) return groupPreview(group);
  return [
    title("PREVIEW", false),
    `${ansi.bold}${item.name}${ansi.reset}`,
    item.description,
    "",
    label("Group", group.name),
    label("Group kind", group.kind),
    label("Owner", group.owner),
    label("Source", group.source),
    label("Scope", group.scope),
    label("Removal", item.status),
    label("Path", item.path),
    ...(item.tags.length === 0
      ? []
      : [label("Protection", item.tags.join(", "))]),
  ];
}

function groupPreview(group) {
  return [
    title("GROUP EVIDENCE", false),
    `${ansi.bold}${group.name}${ansi.reset}`,
    label("Kind", group.kind),
    label("Owner", group.owner),
    label("Source", group.source),
    label("Scope", group.scope),
    label("Evidence", group.evidence),
    label(
      "Removal target",
      group.removalBoundary ? "yes — Plugin boundary" : "no — navigation only",
    ),
  ];
}

function renderState(current) {
  const summary = stateSummary(current);
  return [
    rule(),
    `${ansi.bold}STATE${ansi.reset} ${ansi.dim}variant=${summary.variant} mode=${summary.mode} focus=${summary.focus} query=${JSON.stringify(summary.query)}${ansi.reset}`,
    `${ansi.dim}group=${summary.group ?? "none"} cursor=${summary.cursor ?? "none"}${ansi.reset}`,
    `${ansi.dim}selected=[${summary.selected.join(", ")}]${ansi.reset}`,
    ...wrapState(`expanded=[${summary.expanded.join(", ")}]`),
    ...(current.notice === ""
      ? []
      : [`${ansi.yellow}${current.notice}${ansi.reset}`]),
  ].join("\n");
}

function renderKeys(current) {
  const search = typing(current)
    ? "type query · Ctrl-J/K move · Tab select · Ctrl-U clear · Esc back"
    : "/ fuzzy search";
  return [
    `${ansi.bold}↑↓/jk${ansi.reset} move  ${ansi.bold}←→/hl${ansi.reset} browse  ${ansi.bold}Tab/Space${ansi.reset} select  ${ansi.bold}Enter${ansi.reset} review`,
    `${ansi.bold}${search}${ansi.reset}  ${ansi.bold}Ctrl-C${ansi.reset} quit`,
    "",
  ].join("\n");
}

function columns(first, second, third, widths) {
  const columns = [first, second, third];
  const height = Math.max(...columns.map((column) => column.length));
  return Array.from({ length: height }, (_, index) =>
    columns
      .map((column, columnIndex) =>
        pad(column[index] ?? "", widths[columnIndex]),
      )
      .filter((_, columnIndex) => widths[columnIndex] > 0)
      .join(`${ansi.dim}│${ansi.reset} `),
  ).join("\n");
}

function windowed(values, cursor, limit) {
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(limit / 2), values.length - limit),
  );
  return values
    .slice(start, start + limit)
    .map((value, offset) => ({ value, index: start + offset }));
}

function mark(current, item) {
  return current.selectedIds.includes(item.id)
    ? `${ansi.green}[x]${ansi.reset}`
    : "[ ]";
}

function row(value, selected) {
  return selected ? `${ansi.inverse}> ${value}${ansi.reset}` : `  ${value}`;
}

function title(value, active) {
  return `${active ? ansi.cyan : ansi.dim}${ansi.bold}${value}${ansi.reset}`;
}

function label(name, value) {
  return `${ansi.dim}${name}:${ansi.reset} ${value}`;
}

function rule() {
  return `${ansi.dim}${"─".repeat(terminalWidth())}${ansi.reset}`;
}

function pad(value, width) {
  if (width <= 0) return "";
  const visible = stripVTControlCharacters(value);
  if (visible.length > width) return truncateAnsi(value, width);
  return `${value}${" ".repeat(width - visible.length)}`;
}

function truncateAnsi(value, width) {
  let result = "";
  let visibleLength = 0;
  for (let index = 0; index < value.length;) {
    if (value.charCodeAt(index) === 27) {
      const end = value.indexOf("m", index);
      if (end < 0) break;
      result += value.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(index));
    if (visibleLength >= width - 1) break;
    result += character;
    visibleLength += 1;
    index += character.length;
  }
  return `${result}…${ansi.reset}`;
}

function navigatorWidths() {
  const usable = terminalWidth() - 4;
  const groupsWidth = Math.floor(usable * 0.28);
  const skillsWidth = Math.floor(usable * 0.31);
  return [groupsWidth, skillsWidth, usable - groupsWidth - skillsWidth];
}

function finderWidths() {
  const usable = terminalWidth() - 2;
  const resultsWidth = Math.floor(usable * 0.62);
  return [resultsWidth, usable - resultsWidth, 0];
}

function terminalWidth() {
  return Math.max(72, Math.min(process.stdout.columns || 120, 140));
}

function wrapState(value) {
  const width = terminalWidth();
  const lines = [];
  let current = "";
  for (const word of value.split(" ")) {
    if (current.length > 0 && current.length + word.length + 1 > width) {
      lines.push(`${ansi.dim}${current}${ansi.reset}`);
      current = word;
    } else current = current.length === 0 ? word : `${current} ${word}`;
  }
  if (current.length > 0) lines.push(`${ansi.dim}${current}${ansi.reset}`);
  return lines;
}
