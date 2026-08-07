// PROTOTYPE — pure frame rendering. Takes state, returns one string.
// Separated from run.mjs so the geometry can be checked without a terminal.

import {
  currentSection,
  currentSkill,
  layout,
  panes,
  selectionSummary,
  sharedExposure,
} from "./model.mjs";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const B = (s) => `${ESC}[1m${s}${ESC}[0m`;
const D = (s) => `${ESC}[2m${s}${ESC}[0m`;
const INV = (s) => `${ESC}[7m${s}${ESC}[0m`;
const ACCENT = (s) => `${ESC}[36m${s}${ESC}[0m`;

const strip = (s) => s.replace(ANSI, "");
const len = (s) => [...strip(s)].length;

function fit(s, n) {
  if (n <= 0) return "";
  const visible = len(s);
  if (visible === n) return s;
  if (visible < n) return s + " ".repeat(n - visible);
  return [...strip(s)].slice(0, Math.max(0, n - 1)).join("") + "…";
}

/** Rows above the panes: title, filter, top rule. */
const PANE_TOP = 3;

function scrollMark(pane, row) {
  if (pane.total <= pane.height) return " ";
  const span = Math.max(
    1,
    Math.round((pane.height / pane.total) * pane.height),
  );
  const start = Math.round((pane.offset / pane.total) * pane.height);
  return row >= start && row < start + span ? "█" : D("│");
}

function render(state) {
  const { columns, paneRows, detailRows, leftWidth } = layout(state);
  const usable = columns - 1; // never touch the last cell
  const rightWidth = Math.max(10, usable - leftWidth - 2);
  const view = panes(state);
  const section = currentSection(state);
  const skill = currentSkill(state);
  const out = [];

  const selected = state.selected.length;
  out.push(
    `${B("skill-cleaner")} ${D("prototype")}  ${
      selected > 0 ? ACCENT(`${selected} selected`) : D("nothing selected")
    }`,
  );
  out.push(
    state.query === ""
      ? D("filter: type to match names, bundles, agents, paths")
      : `filter ${B(state.query)} ${D(`· ${view.skills.total} in this section`)}`,
  );
  out.push(`${"─".repeat(leftWidth)}┬${"─".repeat(usable - leftWidth - 1)}`);

  for (let row = 0; row < paneRows; row += 1) {
    const item = view.sections.items[row];
    let left;
    if (item) {
      const index = view.sections.offset + row;
      const focused = index === state.sectionIndex;
      const taken = item.skills.filter((entry) =>
        state.selected.includes(entry.key),
      ).length;
      const count =
        taken > 0 ? `${taken}/${item.skills.length}` : `${item.skills.length}`;
      const text = ` ${fit(item.label, leftWidth - 10)} ${fit(count, 6)} ${item.selectable ? " " : "x"}`;
      left =
        focused && state.focus === "sections"
          ? INV(fit(strip(text), leftWidth))
          : focused
            ? B(fit(strip(text), leftWidth))
            : fit(text, leftWidth);
    } else {
      left = " ".repeat(leftWidth);
    }

    let right;
    if (row === 0) {
      const shared = section === null ? null : sharedExposure(section);
      right = section
        ? fit(
            `${B(section.label)} ${D(shared === null ? section.detail : `${section.detail} · all exposed to ${shared}`)}`,
            rightWidth,
          )
        : " ".repeat(rightWidth);
    } else {
      const entry = view.skills.items[row - 1];
      if (entry) {
        const index = view.skills.offset + row - 1;
        const focused = index === state.skillIndex && state.focus === "skills";
        const box = state.selected.includes(entry.key) ? "[x]" : "[ ]";
        const paths = entry.paths.length > 1 ? `${entry.paths.length}p` : "  ";
        const shared = section === null ? null : sharedExposure(section);
        const trailing =
          shared === null || entry.exposedTo.join(" ") !== shared
            ? entry.exposedTo.join(" ")
            : D(entry.description);
        const text = `${box} ${fit(entry.name, 30)} ${fit(trailing, Math.max(6, rightWidth - 39))} ${paths}`;
        right = focused
          ? INV(fit(strip(text), rightWidth))
          : fit(text, rightWidth);
      } else {
        right = " ".repeat(rightWidth);
      }
    }

    out.push(`${left}│${right}${scrollMark(view.skills, row)}`);
  }

  out.push(`${"─".repeat(leftWidth)}┴${"─".repeat(usable - leftWidth - 1)}`);

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
    if (skill.description) detail.push(D(`  ${skill.description}`));
    for (const path of skill.paths) detail.push(`  ${path}`);
  }
  for (let row = 0; row < detailRows; row += 1)
    out.push(fit(detail[row] ?? "", usable));

  out.push(
    D(
      "arrows move · click/wheel/drag · space select · S section · ^a clear · enter review · esc back · ^c quit",
    ),
  );
  out.push(
    state.notice
      ? ACCENT(`! ${state.notice}`)
      : D(
          `focus=${state.focus} sec=${state.sectionIndex + 1}/${view.sections.total} skill=${view.skills.total === 0 ? 0 : state.skillIndex + 1}/${view.skills.total} split=${state.leftPercent}% detail=${detailRows}`,
        ),
  );

  return out.map((line) => fit(line, usable)).join("\n");
}

export { render, fit, strip, len, PANE_TOP };
