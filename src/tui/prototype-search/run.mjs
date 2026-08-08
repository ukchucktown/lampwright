// PROTOTYPE — throwaway, synthetic-data-only global Skill search overlay.
//
// QUESTION: when the Inventory is large, should search retain categories,
// promote a Skill/preview split, or become a minimal quick picker — and should
// Enter select all visible matches, staged matches, or only the focused match?
//
// This file cannot import Inventory, Planning, Execution, or Quarantine.

import process from "node:process";

const ESC = String.fromCharCode(27);
const ALT_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALT_OFF = `${ESC}[?25h${ESC}[?1049l`;
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");

const variants = [
  { key: "A", name: "Categories + matches" },
  { key: "B", name: "Results + preview" },
  { key: "C", name: "Quick picker" },
];

const palette = {
  title: [1, 38, 2, 130, 214, 214],
  active: [1, 38, 2, 255, 210, 102],
  muted: [38, 2, 127, 127, 127],
  border: [38, 2, 43, 46, 72],
  focus: [1, 38, 2, 255, 255, 255, 48, 2, 72, 78, 91],
  selected: [1, 38, 2, 255, 210, 102],
  info: [38, 2, 137, 188, 239],
  path: [38, 2, 130, 214, 214],
};

const paint = Object.fromEntries(
  Object.entries(palette).map(([role, codes]) => [
    role,
    (value) =>
      process.env.NO_COLOR !== undefined || value === ""
        ? value
        : `${ESC}[${codes.join(";")}m${value}${ESC}[0m`,
  ]),
);

const skills = [
  skill(
    "ai-sdk",
    "mattpocock/skills",
    "Build type-safe streaming AI features with the Vercel AI SDK, including tools, structured output, and provider switching.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "react-best-practices",
    "mattpocock/skills",
    "Review React components for predictable state, accessible interactions, and rendering patterns that remain easy to maintain.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "typescript-generics",
    "mattpocock/skills",
    "Design and debug TypeScript generic APIs with useful inference, constraints, conditional types, and readable error messages.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "typescript-performance",
    "mattpocock/skills",
    "Diagnose slow TypeScript builds and expensive type relationships without weakening the public type contract.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "nextjs-app-router",
    "mattpocock/skills",
    "Build Next.js App Router flows with clear server/client boundaries, cache behavior, metadata, and error handling.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "composition-patterns",
    "mattpocock/skills",
    "Prefer composable component APIs over boolean-prop growth and make extension points explicit.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "web-design-guidelines",
    "mattpocock/skills",
    "Evaluate web interfaces for hierarchy, rhythm, interaction feedback, responsive behavior, and accessibility.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "vitest",
    "mattpocock/skills",
    "Write focused Vitest suites with meaningful seams, deterministic fixtures, and failures that explain behavior.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "zod",
    "mattpocock/skills",
    "Model runtime validation with Zod while keeping inferred TypeScript types aligned with accepted inputs.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "frontend-testing",
    "mattpocock/skills",
    "Test frontend behavior from the user's perspective with resilient selectors and representative interaction flows.",
    "vercel-skills",
    ["claude-code", "codex"],
  ),
  skill(
    "skill-creator",
    "OpenAI system skills",
    "Guide the creation of focused, maintainable Skills with clear triggers, workflows, references, and safety boundaries.",
    "agent runtime",
    ["codex"],
    false,
  ),
  skill(
    "skill-installer",
    "OpenAI system skills",
    "Install curated or repository-hosted Skills into Codex's configured Skill directory.",
    "agent runtime",
    ["codex"],
    false,
  ),
  skill(
    "openai-docs",
    "OpenAI system skills",
    "Answer current OpenAI product and API questions using official documentation and local product context.",
    "agent runtime",
    ["codex"],
    false,
  ),
  skill(
    "pdf",
    "OpenAI bundled tools",
    "Read, create, render, and verify PDF documents where page geometry and visual fidelity matter.",
    "codex plugin",
    ["codex"],
  ),
  skill(
    "presentations",
    "OpenAI bundled tools",
    "Create and revise slide decks with deliberate information hierarchy and rendered visual verification.",
    "codex plugin",
    ["codex"],
  ),
  skill(
    "spreadsheets",
    "OpenAI bundled tools",
    "Create, analyze, and verify spreadsheet workbooks with formulas, formatting, and useful summaries.",
    "codex plugin",
    ["codex"],
  ),
  skill(
    "documents",
    "OpenAI bundled tools",
    "Create and edit Word documents with a render-and-verify workflow for polished page layout.",
    "codex plugin",
    ["codex"],
  ),
  skill(
    "camunda-bpmn",
    "Camunda agent skills",
    "Create and validate Camunda 8 BPMN process diagrams with Zeebe extensions and portable process structure.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "camunda-feel",
    "Camunda agent skills",
    "Write and debug FEEL expressions for gateways, mappings, timers, forms, decisions, and connectors.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "camunda-dmn",
    "Camunda agent skills",
    "Author and validate DMN decisions with appropriate hit policies and behavior-focused scenarios.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "camunda-forms",
    "Camunda agent skills",
    "Create Camunda Form schemas with validation, layout, conditional visibility, and process-variable bindings.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "code-review",
    "Personal skills",
    "Review a branch against repository standards and the originating product specification.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "diagnosing-bugs",
    "Personal skills",
    "Build a deterministic reproduction, rank falsifiable hypotheses, and fix the demonstrated cause.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "prototype",
    "Personal skills",
    "Build throwaway logic or interface experiments that answer one design question before production work begins.",
    "filesystem",
    ["claude-code", "codex"],
  ),
  skill(
    "research",
    "Personal skills",
    "Investigate a bounded question using high-trust primary sources and preserve the findings in the repository.",
    "filesystem",
    ["claude-code", "codex"],
  ),
];

function skill(name, category, description, owner, agents, removable = true) {
  return {
    key: `${category}:${name}`,
    name,
    category,
    description,
    owner,
    agents,
    removable,
    path: `~/.config/agents/skills/${name}`,
  };
}

let state = {
  screen: "search",
  variant: 1,
  query: "",
  cursor: 0,
  selected: new Set(),
  staged: new Set(),
  category: "All matches",
  categoryCursor: 0,
  categoryFocus: "results",
  notice: "Type to search synthetic Skills.",
};

function rankedMatches() {
  const ranked = skills
    .map((candidate, index) => ({
      candidate,
      index,
      score: matchScore(candidate, state.query),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((item) => item.candidate);
  return state.variant === 0 && state.category !== "All matches"
    ? ranked.filter((candidate) => candidate.category === state.category)
    : ranked;
}

function allRankedMatches() {
  return skills
    .map((candidate, index) => ({
      candidate,
      index,
      score: matchScore(candidate, state.query),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((item) => item.candidate);
}

function matchScore(candidate, query) {
  const terms = query
    .trim()
    .toLocaleLowerCase("en-US")
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return 0;
  const name = candidate.name.toLocaleLowerCase("en-US");
  const category = candidate.category.toLocaleLowerCase("en-US");
  let total = 0;
  for (const term of terms) {
    const direct = name.indexOf(term);
    if (direct >= 0) {
      total += direct * 2 + name.length - term.length;
      continue;
    }
    const fuzzy = subsequenceScore(term, name);
    if (Number.isFinite(fuzzy)) {
      total += 25 + fuzzy;
      continue;
    }
    const categoryIndex = category.indexOf(term);
    if (categoryIndex >= 0) {
      total += 100 + categoryIndex;
      continue;
    }
    return Number.POSITIVE_INFINITY;
  }
  return total;
}

function subsequenceScore(needle, haystack) {
  let position = -1;
  let gaps = 0;
  for (const character of needle) {
    const next = haystack.indexOf(character, position + 1);
    if (next < 0) return Number.POSITIVE_INFINITY;
    if (position >= 0) gaps += next - position - 1;
    position = next;
  }
  return gaps + position;
}

function categories() {
  const counts = new Map();
  for (const candidate of allRankedMatches())
    counts.set(candidate.category, (counts.get(candidate.category) ?? 0) + 1);
  return [
    { label: "All matches", count: allRankedMatches().length },
    ...[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, count]) => ({ label, count })),
  ];
}

function current() {
  const matches = rankedMatches();
  return matches[Math.min(state.cursor, matches.length - 1)] ?? null;
}

function settle() {
  const categoryItems = categories();
  state.categoryCursor = clamp(state.categoryCursor, categoryItems.length);
  if (!categoryItems.some((item) => item.label === state.category)) {
    state.category = "All matches";
    state.categoryCursor = 0;
  }
  state.cursor = clamp(state.cursor, rankedMatches().length);
}

function clamp(index, length) {
  return length === 0 ? 0 : Math.min(Math.max(0, index), length - 1);
}

function openSearch() {
  state.screen = "search";
  state.query = "";
  state.cursor = 0;
  state.category = "All matches";
  state.categoryCursor = 0;
  state.categoryFocus = "results";
  state.staged = new Set();
  state.notice = "Type to search synthetic Skills.";
}

function closeSearch(message) {
  state.screen = "main";
  state.notice = message;
}

function cycleVariant(delta) {
  state.variant = (state.variant + delta + variants.length) % variants.length;
  state.cursor = 0;
  state.category = "All matches";
  state.categoryCursor = 0;
  state.categoryFocus = "results";
  state.staged = new Set();
  state.notice = `Switched to ${variants[state.variant].key}: ${variants[state.variant].name}.`;
  settle();
}

function move(delta) {
  if (state.variant === 0 && state.categoryFocus === "categories") {
    const items = categories();
    state.categoryCursor = clamp(state.categoryCursor + delta, items.length);
    state.category = items[state.categoryCursor]?.label ?? "All matches";
    state.cursor = 0;
  } else state.cursor = clamp(state.cursor + delta, rankedMatches().length);
  settle();
}

function toggleStaged() {
  const candidate = current();
  if (candidate === null || !candidate.removable) {
    state.notice = "That System Skill is visible but cannot be selected.";
    return;
  }
  if (state.selected.has(candidate.key)) {
    state.notice = `${candidate.name} is already selected in the main pane.`;
    return;
  }
  if (state.staged.has(candidate.key)) state.staged.delete(candidate.key);
  else state.staged.add(candidate.key);
  state.notice = `${state.staged.has(candidate.key) ? "Staged" : "Unstaged"} ${candidate.name}.`;
}

function toggleAllStaged() {
  const available = rankedMatches().filter(
    (candidate) => candidate.removable && !state.selected.has(candidate.key),
  );
  const all = available.every((candidate) => state.staged.has(candidate.key));
  for (const candidate of available) {
    if (all) state.staged.delete(candidate.key);
    else state.staged.add(candidate.key);
  }
  state.notice = `${all ? "Unstaged" : "Staged"} ${available.length} visible matches.`;
}

function enter() {
  if (state.screen === "main") {
    openSearch();
    return;
  }
  if (state.variant === 0) {
    if (state.categoryFocus === "categories") {
      state.categoryFocus = "results";
      state.notice = `Showing ${state.category}.`;
      return;
    }
    if (state.query.trim() === "") {
      state.notice = "Type a query before selecting all matches.";
      return;
    }
    const available = rankedMatches().filter(
      (candidate) => candidate.removable,
    );
    if (available.length === 0) {
      state.notice = "No removable matching Skills to add.";
      return;
    }
    const previousSize = state.selected.size;
    state.selected = new Set([
      ...state.selected,
      ...available.map((candidate) => candidate.key),
    ]);
    const added = state.selected.size - previousSize;
    closeSearch(
      `Added ${added} new ${added === 1 ? "Skill" : "Skills"}; ${state.selected.size} selected total.`,
    );
    return;
  }
  if (state.variant === 1) {
    const added = state.staged.size;
    state.selected = new Set([...state.selected, ...state.staged]);
    closeSearch(
      `Added ${added} new ${added === 1 ? "Skill" : "Skills"}; ${state.selected.size} selected total.`,
    );
    return;
  }
  const candidate = current();
  if (candidate === null) {
    state.notice = "No matching Skill.";
    return;
  }
  if (!candidate.removable) {
    state.notice = "That System Skill is visible but cannot be selected.";
    return;
  }
  state.selected.add(candidate.key);
  closeSearch(`Selected ${candidate.name}.`);
}

function onKey(chunk) {
  if (chunk === "\u0003") quit();
  if (chunk === "[") {
    cycleVariant(-1);
    return;
  }
  if (chunk === "]") {
    cycleVariant(1);
    return;
  }
  if (chunk === `${ESC}[A`) {
    move(-1);
    return;
  }
  if (chunk === `${ESC}[B`) {
    move(1);
    return;
  }
  if (chunk === `${ESC}[D` && state.variant === 0) {
    state.categoryFocus = "categories";
    return;
  }
  if (chunk === `${ESC}[C` && state.variant === 0) {
    state.categoryFocus = "results";
    return;
  }
  if (chunk === "\r" || chunk === "\n") {
    enter();
    return;
  }
  if (chunk === ESC) {
    if (state.screen === "main") return;
    if (state.query !== "") {
      state.query = "";
      state.cursor = 0;
      state.category = "All matches";
      state.categoryCursor = 0;
      state.notice = "Search cleared.";
    } else closeSearch("Search closed without changing the main selection.");
    settle();
    return;
  }
  if (chunk === "\u007f" || chunk === "\b") {
    if (state.screen === "search") {
      state.query = [...state.query].slice(0, -1).join("");
      state.cursor = 0;
      state.category = "All matches";
      state.categoryCursor = 0;
      settle();
    }
    return;
  }
  if (chunk === "/" && state.screen === "main") {
    openSearch();
    return;
  }
  if (chunk === "q" && state.screen === "main") quit();
  if (state.screen !== "search") return;
  if (chunk === " " && state.variant === 1) {
    toggleStaged();
    return;
  }
  if (chunk === "\u0001" && state.variant === 1) {
    toggleAllStaged();
    return;
  }
  if (/^[ -~]+$/u.test(chunk)) {
    state.query += chunk;
    state.cursor = 0;
    state.category = "All matches";
    state.categoryCursor = 0;
    state.notice = "";
    settle();
  }
}

function viewport() {
  return {
    rows: Math.max(1, process.stdout.rows ?? 30),
    columns: Math.max(1, process.stdout.columns ?? 100),
  };
}

function render() {
  const { rows, columns } = viewport();
  const width = columns - 1;
  const contentRows = rows - 1;
  if (rows < 16 || columns < 50)
    return Array.from({ length: Math.max(0, contentRows) }, (_, index) =>
      fit(
        [
          paint.title("skill-cleaner search prototype"),
          paint.info("Resize the terminal to at least 50 × 16"),
          paint.muted("Ctrl-C quit"),
        ][index] ?? "",
        Math.max(0, width),
      ),
    );
  const lines =
    state.screen === "main"
      ? renderMain(width, contentRows)
      : renderSearch(width, contentRows);
  return Array.from({ length: contentRows }, (_, index) =>
    fit(lines[index] ?? "", width),
  );
}

function header(width) {
  return [
    paint.title(fit("skill-cleaner", 13)) +
      paint.muted(" inventory  ") +
      (state.selected.size > 0
        ? paint.selected(`${state.selected.size} selected`)
        : paint.muted("nothing selected")),
    paint.muted(
      fit(
        state.screen === "search"
          ? state.variant === 0
            ? "type search · ←→ pane · ↑↓ move · enter add matches + return · esc clear/close · ctrl-c quit"
            : state.variant === 1
              ? "type search · ↑↓ move · space stage · ctrl-a all · enter add + return · esc close"
              : "type search · ↑↓ move · enter add current + return · esc clear/close · ctrl-c quit"
          : "/ search · [ ] compare variants · q/ctrl-c quit",
        width,
      ),
    ),
  ];
}

function renderMain(width, rows) {
  const lines = [...header(width), paint.border("─".repeat(width))];
  lines.push(paint.title("Selected Skills"));
  const selected = skills.filter((candidate) =>
    state.selected.has(candidate.key),
  );
  if (selected.length === 0)
    lines.push(paint.muted("  Nothing selected. Press / to search."));
  else {
    for (const candidate of selected.slice(0, Math.max(1, rows - 9)))
      lines.push(
        `  ${paint.selected("[x]")} ${fit(candidate.name, 34)} ${paint.muted(candidate.category)}`,
      );
  }
  while (lines.length < rows - 3) lines.push("");
  lines.push(
    state.notice === "" ? "" : paint.info(fit(`! ${state.notice}`, width)),
  );
  lines.push(variantSwitcher(width));
  lines.push(stateLine(width));
  return lines;
}

function renderSearch(width, rows) {
  const lines = [...header(width)];
  lines.push(
    paint.border("╭") +
      paint.title(" Search Skills ") +
      paint.border("─".repeat(Math.max(0, width - 17))) +
      paint.border("╮"),
  );
  lines.push(
    paint.border("│") +
      fit(`  > ${state.query}`, Math.max(0, width - 2)) +
      paint.border("│"),
  );
  lines.push(
    paint.border("├") +
      paint.border("─".repeat(Math.max(0, width - 2))) +
      paint.border("┤"),
  );
  const fixed = 9;
  const bodyRows = Math.max(3, rows - fixed);
  if (state.variant === 0) lines.push(...renderVariantA(width, bodyRows));
  else if (state.variant === 1) lines.push(...renderVariantB(width, bodyRows));
  else lines.push(...renderVariantC(width, bodyRows));
  lines.push(
    paint.border("╰") +
      paint.border("─".repeat(Math.max(0, width - 2))) +
      paint.border("╯"),
  );
  lines.push(variantSwitcher(width));
  lines.push(stateLine(width));
  return lines;
}

function renderVariantA(width, bodyRows) {
  const left = Math.max(18, Math.round(width * 0.3));
  const right = Math.max(20, width - left - 3);
  const previewRows = Math.min(7, Math.max(4, Math.floor(bodyRows * 0.45)));
  const listRows = Math.max(2, bodyRows - previewRows - 1);
  const items = categories();
  const matches = rankedMatches();
  const categoryView = windowed(items, state.categoryCursor, listRows);
  const matchView = windowed(matches, state.cursor, listRows);
  const lines = [];
  for (let row = 0; row < listRows; row += 1) {
    const category = categoryView.items[row];
    const candidate = matchView.items[row];
    const categoryIndex = categoryView.offset + row;
    const matchIndex = matchView.offset + row;
    const leftText =
      category === undefined
        ? ""
        : `${fit(category.label, Math.max(1, left - 5))}${String(category.count).padStart(4)}`;
    const rightText = candidate === undefined ? "" : resultText(candidate);
    const leftCell =
      categoryIndex === state.categoryCursor &&
      state.categoryFocus === "categories"
        ? paint.focus(fit(leftText, left))
        : categoryIndex === state.categoryCursor
          ? paint.active(fit(leftText, left))
          : fit(leftText, left);
    const rightCell =
      matchIndex === state.cursor && state.categoryFocus === "results"
        ? paint.focus(fit(rightText, right))
        : matchIndex === state.cursor
          ? paint.active(fit(rightText, right))
          : fit(rightText, right);
    lines.push(
      `${paint.border("│")}${leftCell}${paint.border("│")}${rightCell}${paint.border("│")}`,
    );
  }
  lines.push(
    `${paint.border("├")}${paint.border("─".repeat(Math.max(0, width - 2)))}${paint.border("┤")}`,
  );
  lines.push(
    ...previewLines(current(), width - 2, previewRows).map(
      (line) => `${paint.border("│")}${line}${paint.border("│")}`,
    ),
  );
  return lines.slice(0, bodyRows);
}

function renderVariantB(width, bodyRows) {
  const left = Math.max(24, Math.round(width * 0.43));
  const right = Math.max(20, width - left - 3);
  const matches = rankedMatches();
  const view = windowed(matches, state.cursor, bodyRows);
  const preview = previewLines(current(), right, bodyRows);
  const lines = [];
  for (let row = 0; row < bodyRows; row += 1) {
    const candidate = view.items[row];
    const index = view.offset + row;
    const marker =
      candidate === undefined
        ? ""
        : !candidate.removable
          ? " - "
          : state.selected.has(candidate.key)
            ? "[x]"
            : state.staged.has(candidate.key)
              ? "[x]"
              : "[ ]";
    const text = candidate === undefined ? "" : `${marker} ${candidate.name}`;
    const listCell =
      index === state.cursor
        ? paint.focus(fit(text, left))
        : state.staged.has(candidate?.key) || state.selected.has(candidate?.key)
          ? paint.selected(fit(text, left))
          : fit(text, left);
    lines.push(
      `${paint.border("│")}${listCell}${paint.border("│")}${preview[row] ?? " ".repeat(right)}${paint.border("│")}`,
    );
  }
  return lines;
}

function renderVariantC(width, bodyRows) {
  const previewRows = Math.min(5, Math.max(3, Math.floor(bodyRows * 0.25)));
  const listRows = Math.max(2, bodyRows - previewRows - 1);
  const matches = rankedMatches();
  const view = windowed(matches, state.cursor, listRows);
  const lines = [];
  for (let row = 0; row < listRows; row += 1) {
    const candidate = view.items[row];
    const index = view.offset + row;
    const text =
      candidate === undefined
        ? ""
        : `  ${candidate.name.padEnd(34)} ${candidate.category}`;
    lines.push(
      `${paint.border("│")}${index === state.cursor ? paint.focus(fit(text, width - 2)) : fit(text, width - 2)}${paint.border("│")}`,
    );
  }
  lines.push(
    `${paint.border("├")}${paint.border("─".repeat(Math.max(0, width - 2)))}${paint.border("┤")}`,
  );
  lines.push(
    ...previewLines(current(), width - 2, previewRows).map(
      (line) => `${paint.border("│")}${line}${paint.border("│")}`,
    ),
  );
  return lines.slice(0, bodyRows);
}

function resultText(candidate) {
  const marker = !candidate.removable
    ? " - "
    : state.selected.has(candidate.key)
      ? "[x]"
      : "[ ]";
  return `${marker} ${candidate.name}`;
}

function windowed(items, cursor, height) {
  const offset = Math.min(
    Math.max(0, cursor - Math.floor(height / 2)),
    Math.max(0, items.length - height),
  );
  return { items: items.slice(offset, offset + height), offset };
}

function previewLines(candidate, width, height) {
  if (candidate === null)
    return [paint.muted(fit("  No matching Skill", width))];
  const lines = [
    paint.title(fit(`  ${candidate.name}`, width)),
    paint.active(fit(`  Category: ${candidate.category}`, width)),
    paint.muted(
      fit(
        `  Owner: ${candidate.owner} · Available to: ${candidate.agents.join(", ")}`,
        width,
      ),
    ),
    "",
    ...wrap(candidate.description, Math.max(1, width - 4)).map((line) =>
      fit(`  ${line}`, width),
    ),
    "",
    paint.path(fit(`  ${candidate.path}`, width)),
    ...(candidate.removable
      ? []
      : [paint.muted(fit("  Visible System Skill · not removable", width))]),
  ];
  return Array.from({ length: height }, (_, index) =>
    fit(lines[index] ?? "", width),
  );
}

function variantSwitcher(width) {
  const variant = variants[state.variant];
  return paint.muted(
    fit(`[ / ] switch prototype  ·  ${variant.key} — ${variant.name}`, width),
  );
}

function stateLine(width) {
  const matchCount = rankedMatches().length;
  return paint.info(
    fit(
      `state screen=${state.screen} variant=${variants[state.variant].key} query=${JSON.stringify(state.query)} cursor=${matchCount === 0 ? 0 : state.cursor + 1}/${matchCount} staged=${state.staged.size} selected=${state.selected.size}${state.notice === "" ? "" : ` · ${state.notice}`}`,
      width,
    ),
  );
}

function wrap(value, width) {
  if (width <= 0) return [];
  const lines = [];
  let line = "";
  for (const word of value.split(/\s+/u).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + word.length + 1 <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function fit(value, width) {
  if (width <= 0) return "";
  const plain = value.replace(ANSI, "");
  const length = [...plain].length;
  if (length === width) return value;
  if (length < width) return value + " ".repeat(width - length);
  return [...plain].slice(0, Math.max(0, width - 1)).join("") + "…";
}

function draw() {
  process.stdout.write(
    `${ESC}[H${render()
      .map((line) => `${line}${ESC}[K`)
      .join("\n")}${ESC}[J`,
  );
}

let restored = false;
function restoreTerminal() {
  if (restored) return;
  restored = true;
  process.stdout.write(ALT_OFF);
}

function quit() {
  restoreTerminal();
  process.exit(0);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write(ALT_ON);
process.on("exit", restoreTerminal);
process.stdin.on("data", (chunk) => {
  onKey(chunk);
  draw();
});
process.stdout.on("resize", draw);
settle();
draw();
