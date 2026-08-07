// PROTOTYPE — pure navigation state for the three-pane terminal inventory.
//
// QUESTION: does a Section/Skill/Detail pane model actually feel right to drive?
// Specifically: where does focus live and how does it move; is selection global
// across bundles or scoped to one; does typing filter everything or only the
// focused pane; and what happens when a section holds nothing selectable.
//
// The layout is fixed: panes never grow to fit their contents. Each pane owns a
// viewport that scrolls under a stationary frame, so the detail area below stays
// where it is. Pane width and detail height are user-resizable.
//
// Pure: no I/O, no terminal codes. The shell calls in; nothing flows back out.

export const SECTION_KINDS = {
  bundle: "bundle",
  loose: "loose",
  runtime: "runtime",
  system: "system",
};

// Six drawn rows — title, filter, two rules, hints, status — plus one row left
// unused. A frame that fills the terminal exactly scrolls it by one on the
// final newline, which is what made the panes appear to drift.
const CHROME_ROWS = 7;
const MIN_PANE_ROWS = 3;
const SCROLL_MARGIN = 1;

export function createState(sections, viewport = { rows: 30, columns: 100 }) {
  return {
    sections,
    viewport,
    focus: "sections", // "sections" | "skills"
    sectionIndex: 0,
    skillIndex: 0,
    sectionScroll: 0,
    skillScroll: 0,
    leftPercent: 32,
    detailRows: 6,
    query: "",
    selected: [],
    notice: "",
    reviewOpen: false,
  };
}

// ── layout ─────────────────────────────────────────────────────────────────

export function layout(state) {
  const rows = Math.max(12, state.viewport.rows);
  const columns = Math.max(60, state.viewport.columns);
  const detailRows = Math.min(
    Math.max(3, state.detailRows),
    Math.max(3, rows - CHROME_ROWS - MIN_PANE_ROWS),
  );
  const paneRows = Math.max(MIN_PANE_ROWS, rows - CHROME_ROWS - detailRows);
  const leftWidth = Math.round(
    (columns * clampPercent(state.leftPercent)) / 100,
  );
  return {
    rows,
    columns,
    paneRows,
    detailRows,
    leftWidth,
    rightWidth: Math.max(20, columns - leftWidth - 3),
  };
}

function clampPercent(percent) {
  return Math.min(55, Math.max(18, percent));
}

/** Keeps the cursor inside its viewport without recentring on every step. */
function scrollFor(offset, index, height, length) {
  if (length <= height) return 0;
  const margin = height > 2 * SCROLL_MARGIN + 1 ? SCROLL_MARGIN : 0;
  const low = Math.max(0, index - margin);
  const high = Math.min(length - 1, index + margin);
  let next = offset;
  if (low < next) next = low;
  if (high > next + height - 1) next = high - height + 1;
  return Math.min(Math.max(0, next), Math.max(0, length - height));
}

// ── derived ────────────────────────────────────────────────────────────────

/**
 * Name-first matching.
 *
 * Descriptions are deliberately excluded: they are ordinary English, so a
 * two-letter query matched almost every Skill through words like "can" and
 * "because", which made search feel broken. A term matches a Skill's name as a
 * subsequence, or its bundle, agents, or paths as a substring.
 */
export function matches(skill, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const name = skill.name.toLowerCase();
  const rest = [skill.bundle, ...skill.exposedTo, ...skill.paths]
    .join(" ")
    .toLowerCase();
  return q
    .split(/\s+/)
    .every((term) => subsequence(term, name) || rest.includes(term));
}

function subsequence(needle, haystack) {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** Sections keep their identity while searching; only their contents shrink. */
export function visibleSections(state) {
  return state.sections.map((section) => ({
    ...section,
    skills: section.skills.filter((skill) => matches(skill, state.query)),
  }));
}

export function currentSection(state) {
  const sections = visibleSections(state);
  return sections[Math.min(state.sectionIndex, sections.length - 1)] ?? null;
}

export function currentSkills(state) {
  return currentSection(state)?.skills ?? [];
}

export function currentSkill(state) {
  const skills = currentSkills(state);
  return skills[Math.min(state.skillIndex, skills.length - 1)] ?? null;
}

export function selectableIn(section) {
  return section.selectable ? section.skills : [];
}

export function selectionSummary(state) {
  const bySection = new Map();
  for (const section of state.sections) {
    for (const skill of section.skills) {
      if (!state.selected.includes(skill.key)) continue;
      bySection.set(section.label, (bySection.get(section.label) ?? 0) + 1);
    }
  }
  return [...bySection.entries()].map(([label, count]) => ({ label, count }));
}

/**
 * The exposure every Skill in a section shares, or null when they differ.
 *
 * A bundle installed by one Manager exposes every member to the same agents, so
 * repeating that on each row is noise. Shown once on the header instead, and per
 * row only where a Skill departs from it.
 */
export function sharedExposure(section) {
  const first = section.skills[0];
  if (first === undefined) return null;
  const key = first.exposedTo.join(" ");
  return section.skills.every((skill) => skill.exposedTo.join(" ") === key)
    ? key
    : null;
}

/** The right pane spends its first row on the section header. */
export function skillRows(state) {
  return Math.max(1, layout(state).paneRows - 1);
}

/** What each pane should draw, already scrolled. */
export function panes(state) {
  const { paneRows } = layout(state);
  const rows = skillRows(state);
  const sections = visibleSections(state);
  const skills = currentSkills(state);
  return {
    sections: {
      items: sections.slice(
        state.sectionScroll,
        state.sectionScroll + paneRows,
      ),
      offset: state.sectionScroll,
      total: sections.length,
      height: paneRows,
    },
    skills: {
      items: skills.slice(state.skillScroll, state.skillScroll + rows),
      offset: state.skillScroll,
      total: skills.length,
      height: rows,
    },
  };
}

// ── reducer ────────────────────────────────────────────────────────────────

export function reduce(state, action) {
  const next = { ...state, notice: "" };
  switch (action.type) {
    case "viewport":
      return settle({ ...next, viewport: action.viewport });
    case "resize-panes":
      return settle({
        ...next,
        leftPercent: clampPercent(next.leftPercent + action.delta),
      });
    case "resize-detail":
      return settle({
        ...next,
        detailRows: Math.max(3, next.detailRows + action.delta),
      });
    case "focus-sections":
      return settle({ ...next, focus: "sections", reviewOpen: false });
    case "focus-skills": {
      const section = currentSection(next);
      if (section && section.skills.length === 0)
        return { ...next, notice: "That section is empty." };
      return settle({ ...next, focus: "skills", reviewOpen: false });
    }
    case "move":
      return settle(move(next, action.delta));
    case "point-section":
      return settle({
        ...next,
        focus: "sections",
        sectionIndex: action.index,
        skillIndex: 0,
        skillScroll: 0,
        reviewOpen: false,
      });
    case "point-skill":
      return settle({
        ...next,
        focus: "skills",
        skillIndex: action.index,
        reviewOpen: false,
      });
    case "scroll": {
      const rows =
        action.pane === "sections" ? layout(next).paneRows : skillRows(next);
      const total =
        action.pane === "sections"
          ? visibleSections(next).length
          : currentSkills(next).length;
      const key = action.pane === "sections" ? "sectionScroll" : "skillScroll";
      const offset = Math.min(
        Math.max(0, next[key] + action.delta),
        Math.max(0, total - rows),
      );
      const indexKey =
        action.pane === "sections" ? "sectionIndex" : "skillIndex";
      const index = Math.min(
        Math.max(next[indexKey], offset),
        Math.max(offset, offset + rows - 1),
      );
      return {
        ...next,
        [key]: offset,
        [indexKey]: Math.min(index, Math.max(0, total - 1)),
      };
    }
    case "set-left-percent":
      return settle({ ...next, leftPercent: action.percent });
    case "page":
      return settle(
        move(
          next,
          action.delta *
            (next.focus === "sections"
              ? layout(next).paneRows
              : skillRows(next)),
        ),
      );
    case "type":
      return settle({
        ...next,
        query: next.query + action.value,
        skillIndex: 0,
        skillScroll: 0,
        reviewOpen: false,
      });
    case "backspace":
      return settle({
        ...next,
        query: [...next.query].slice(0, -1).join(""),
        skillIndex: 0,
        skillScroll: 0,
      });
    case "toggle-select":
      return toggleSelect(next);
    case "toggle-select-section":
      return toggleSection(next);
    case "clear-selection":
      return { ...next, selected: [], reviewOpen: false };
    case "review":
      return next.selected.length === 0
        ? { ...next, notice: "Nothing selected." }
        : { ...next, reviewOpen: true };
    case "escape":
      if (next.reviewOpen) return { ...next, reviewOpen: false };
      if (next.query !== "")
        return settle({
          ...next,
          query: "",
          skillIndex: 0,
          skillScroll: 0,
        });
      if (next.focus === "skills") return { ...next, focus: "sections" };
      return next;
    default:
      return next;
  }
}

function move(state, delta) {
  if (state.focus === "sections") {
    const sections = visibleSections(state);
    return {
      ...state,
      sectionIndex: step(state.sectionIndex, sections.length, delta),
      skillIndex: 0,
      skillScroll: 0,
      reviewOpen: false,
    };
  }
  return {
    ...state,
    skillIndex: step(state.skillIndex, currentSkills(state).length, delta),
    reviewOpen: false,
  };
}

function toggleSelect(state) {
  const section = currentSection(state);
  if (section === null) return state;
  if (!section.selectable)
    return { ...state, notice: `${section.label} cannot be removed here.` };
  if (state.focus === "sections")
    return {
      ...state,
      notice: "Use → to enter the section, or S to take all.",
    };
  const skill = currentSkill(state);
  if (skill === null) return state;
  const selected = state.selected.includes(skill.key)
    ? state.selected.filter((key) => key !== skill.key)
    : [...state.selected, skill.key];
  return { ...state, selected, reviewOpen: false };
}

function toggleSection(state) {
  const section = currentSection(state);
  if (section === null) return state;
  if (!section.selectable)
    return { ...state, notice: `${section.label} cannot be removed here.` };
  const keys = selectableIn(section).map((skill) => skill.key);
  const all = keys.every((key) => state.selected.includes(key));
  const selected = all
    ? state.selected.filter((key) => !keys.includes(key))
    : [...new Set([...state.selected, ...keys])];
  return {
    ...state,
    selected,
    reviewOpen: false,
    notice: all
      ? `Cleared ${String(keys.length)} from ${section.label}.`
      : `Took all ${String(keys.length)} in ${section.label}.`,
  };
}

/** Clamps indices to current contents, then brings both viewports into range. */
function settle(state) {
  const { paneRows } = layout(state);
  const sections = visibleSections(state);
  const sectionIndex = clampIndex(state.sectionIndex, sections.length);
  const skills = sections[sectionIndex]?.skills ?? [];
  const skillIndex = clampIndex(state.skillIndex, skills.length);
  return {
    ...state,
    sectionIndex,
    skillIndex,
    focus: skills.length === 0 ? "sections" : state.focus,
    sectionScroll: scrollFor(
      state.sectionScroll,
      sectionIndex,
      paneRows,
      sections.length,
    ),
    skillScroll: scrollFor(
      state.skillScroll,
      skillIndex,
      Math.max(1, paneRows - 1),
      skills.length,
    ),
  };
}

function step(index, length, delta) {
  if (length === 0) return 0;
  return Math.min(Math.max(index + delta, 0), length - 1);
}

function clampIndex(index, length) {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}
