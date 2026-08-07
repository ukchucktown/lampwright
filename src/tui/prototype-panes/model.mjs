// PROTOTYPE — pure navigation state for the three-pane terminal inventory.
//
// QUESTION: does a Section/Skill/Detail pane model actually feel right to drive?
// Specifically: where does focus live and how does it move; is selection global
// across bundles or scoped to one; does typing filter everything or only the
// focused pane; and what happens when a section holds nothing selectable.
//
// Pure: no I/O, no terminal codes. The shell calls in; nothing flows back out.

export const SECTION_KINDS = {
  bundle: "bundle",
  loose: "loose",
  runtime: "runtime",
  system: "system",
};

export function createState(sections) {
  return {
    sections,
    focus: "sections", // "sections" | "skills"
    sectionIndex: 0,
    skillIndex: 0,
    query: "",
    typing: false,
    selected: [], // skill keys, deliberately global across sections
    notice: "",
    reviewOpen: false,
  };
}

// ── derived ────────────────────────────────────────────────────────────────

export function matches(skill, query) {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const hay = [
    skill.name,
    skill.description,
    skill.bundle,
    ...skill.exposedTo,
    ...skill.paths,
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
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

// ── reducer ────────────────────────────────────────────────────────────────

export function reduce(state, action) {
  const next = { ...state, notice: "" };
  switch (action.type) {
    case "focus-sections":
      return clamp({ ...next, focus: "sections", reviewOpen: false });
    case "focus-skills": {
      const section = currentSection(next);
      if (section && section.skills.length === 0)
        return { ...next, notice: "That section is empty." };
      return clamp({ ...next, focus: "skills", reviewOpen: false });
    }
    case "move":
      return clamp(move(next, action.delta));
    case "type":
      return clamp({
        ...next,
        typing: true,
        query: next.query + action.value,
        skillIndex: 0,
        reviewOpen: false,
      });
    case "backspace":
      return clamp({
        ...next,
        query: [...next.query].slice(0, -1).join(""),
        skillIndex: 0,
      });
    case "clear-query":
      return clamp({ ...next, query: "", typing: false, skillIndex: 0 });
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
        return clamp({ ...next, query: "", typing: false, skillIndex: 0 });
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
      sectionIndex: wrap(state.sectionIndex, sections.length, delta),
      skillIndex: 0,
      reviewOpen: false,
    };
  }
  return {
    ...state,
    skillIndex: wrap(state.skillIndex, currentSkills(state).length, delta),
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

function clamp(state) {
  const sections = visibleSections(state);
  const sectionIndex = clampIndex(state.sectionIndex, sections.length);
  const skills = sections[sectionIndex]?.skills ?? [];
  return {
    ...state,
    sectionIndex,
    skillIndex: clampIndex(state.skillIndex, skills.length),
    focus: skills.length === 0 ? "sections" : state.focus,
  };
}

function wrap(index, length, delta) {
  return length === 0 ? 0 : (index + delta + length) % length;
}

function clampIndex(index, length) {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}
