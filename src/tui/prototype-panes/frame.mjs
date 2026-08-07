// PROTOTYPE — pure frame rendering. Takes state, returns an array of lines.
// Separated from run.mjs so the geometry can be checked without a terminal.
//
// Rule: fit first, style second. Styling before fitting means a string that has
// to be truncated loses its escape codes while a shorter one keeps them, so the
// same column renders dim on one row and plain on the next.

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
const PLAIN = (s) => s;

const strip = (s) => s.replace(ANSI, "");
const len = (s) => [...strip(s)].length;

/** Fits plain text to an exact width. Never receives styled input. */
function fit(text, n) {
  if (n <= 0) return "";
  const characters = [...strip(text)];
  if (characters.length === n) return characters.join("");
  if (characters.length < n)
    return characters.join("") + " ".repeat(n - characters.length);
  return characters.slice(0, Math.max(0, n - 1)).join("") + "…";
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
  return row >= start && row < start + span ? "█" : "│";
}

function sectionLine(state, view, row, leftWidth) {
  const item = view.sections.items[row];
  if (item === undefined) return { text: " ".repeat(leftWidth), style: PLAIN };
  const index = view.sections.offset + row;
  const focused = index === state.sectionIndex;
  const taken = item.skills.filter((entry) =>
    state.selected.includes(entry.key),
  ).length;
  const count =
    taken > 0 ? `${taken}/${item.skills.length}` : String(item.skills.length);
  const text =
    " " +
    fit(item.label, leftWidth - 10) +
    " " +
    fit(count, 6) +
    " " +
    (item.selectable ? " " : "x");
  const style =
    focused && state.focus === "sections" ? INV : focused ? B : PLAIN;
  return { text: fit(text, leftWidth), style };
}

function skillLine(state, view, section, row, rightWidth) {
  if (row === 0) {
    const shared = section === null ? null : sharedExposure(section);
    const detail =
      section === null
        ? ""
        : shared === null
          ? section.detail
          : `${section.detail} · all exposed to ${shared}`;
    const label = section === null ? "" : section.label;
    return [
      { text: fit(label, Math.min(24, rightWidth)), style: B },
      {
        text: fit(
          " " + detail,
          Math.max(0, rightWidth - Math.min(24, rightWidth)),
        ),
        style: D,
      },
    ];
  }

  const entry = view.skills.items[row - 1];
  if (entry === undefined)
    return [{ text: " ".repeat(rightWidth), style: PLAIN }];

  const index = view.skills.offset + row - 1;
  const focused = index === state.skillIndex && state.focus === "skills";
  const box = state.selected.includes(entry.key) ? "[x]" : "[ ]";
  const paths = entry.paths.length > 1 ? `${entry.paths.length}p` : "  ";
  const shared = section === null ? null : sharedExposure(section);
  const differs = shared === null || entry.exposedTo.join(" ") !== shared;
  // Columns are responsive: a fixed name width overflows a narrow pane, and the
  // overflow lands past the terminal edge where it wraps and shifts the frame.
  const nameWidth = Math.max(6, Math.min(30, rightWidth - 12));
  const headWidth = nameWidth + 5;
  const endWidth = 3;
  const tailWidth = Math.max(0, rightWidth - headWidth - endWidth);
  const head = `${box} ${fit(entry.name, nameWidth)} `;
  const tail = fit(
    differs ? entry.exposedTo.join(" ") : entry.description,
    tailWidth,
  );
  const end = fit(` ${paths}`, endWidth);

  if (focused)
    return [{ text: fit(head + tail + end, rightWidth), style: INV }];
  // Style the tail separately so a truncated description dims like a short one.
  return [
    { text: fit(head, headWidth), style: PLAIN },
    { text: tail, style: differs ? PLAIN : D },
    { text: end, style: PLAIN },
  ];
}

function paint(segments) {
  return segments.map(({ text, style }) => style(text)).join("");
}

export function renderLines(state) {
  const { columns, paneRows, detailRows, leftWidth } = layout(state);
  const usable = columns - 1;
  const rightWidth = Math.max(10, usable - leftWidth - 2);
  const view = panes(state);
  const section = currentSection(state);
  const skill = currentSkill(state);
  const out = [];

  const selected = state.selected.length;
  out.push(
    B("skill-cleaner") +
      " " +
      D("prototype") +
      "  " +
      (selected > 0 ? ACCENT(`${selected} selected`) : D("nothing selected")),
  );
  out.push(
    state.query === ""
      ? D(fit("filter: type to match names, bundles, agents, paths", usable))
      : "filter " +
          B(state.query) +
          " " +
          D(`· ${view.skills.total} in this section`),
  );
  out.push("─".repeat(leftWidth) + "┬" + "─".repeat(usable - leftWidth - 1));

  for (let row = 0; row < paneRows; row += 1) {
    const left = sectionLine(state, view, row, leftWidth);
    const right = skillLine(state, view, section, row, rightWidth);
    out.push(
      paint([left]) + "│" + paint(right) + D(scrollMark(view.skills, row)),
    );
  }

  out.push("─".repeat(leftWidth) + "┴" + "─".repeat(usable - leftWidth - 1));

  const detail = [];
  if (state.reviewOpen) {
    detail.push({
      text: "REVIEW — would request a Removal Plan for:",
      style: B,
    });
    for (const { label, count } of selectionSummary(state))
      detail.push({
        text: `  ${String(count).padStart(3)}  ${label}`,
        style: PLAIN,
      });
    detail.push({
      text: "  prototype stops here; it cannot plan or execute",
      style: D,
    });
  } else if (skill) {
    detail.push({ text: skill.name, style: B });
    detail.push({
      text: `  ${skill.owner} · ${skill.bundle}${skill.spansGroups ? " · SPANS GROUPS" : ""}`,
      style: D,
    });
    if (skill.description)
      detail.push({ text: `  ${skill.description}`, style: D });
    for (const path of skill.paths)
      detail.push({ text: `  ${path}`, style: PLAIN });
  }
  for (let row = 0; row < detailRows; row += 1) {
    const entry = detail[row];
    out.push(
      entry === undefined
        ? " ".repeat(usable)
        : entry.style(fit(entry.text, usable)),
    );
  }

  out.push(
    D(
      fit(
        "arrows move · click/wheel/drag · space select · S section · ^a clear · enter review · esc back · ^c quit",
        usable,
      ),
    ),
  );
  out.push(
    state.notice
      ? ACCENT(fit(`! ${state.notice}`, usable))
      : D(
          fit(
            `focus=${state.focus} sec=${state.sectionIndex + 1}/${view.sections.total} skill=${view.skills.total === 0 ? 0 : state.skillIndex + 1}/${view.skills.total} split=${state.leftPercent}% detail=${detailRows}`,
            usable,
          ),
        ),
  );

  return out;
}

export function render(state) {
  return renderLines(state).join("\n");
}

export { fit, strip, len, PANE_TOP };
