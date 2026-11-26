import { modalContentWidth, modalFrame } from "./overlay.js";
import { currentEntry } from "./browse.js";
import type {
  TuiAddAgentState,
  TuiBrowseState,
  TuiAddAgentPickerModel,
} from "./types.js";

export function filteredAgents(
  picker: TuiAddAgentPickerModel,
): readonly string[] {
  return matchingAgents(picker.agents, picker.query);
}

function matchingAgents(agents: readonly string[], value: string) {
  const query = value.trim().toLowerCase();
  return agents.filter(
    (agent) =>
      agentLabel(agent).includes(query) ||
      agentLabel(agent).replaceAll("-", " ").includes(query),
  );
}

export function agentLabel(agent: string): string {
  return agent === "antigravity-cli" ? "antigravity-cli (agy)" : agent;
}

export function agentModalSize(state: TuiAddAgentState) {
  const viewport = state.browse.model.viewport;
  const { rows } = viewport;
  return {
    compact: rows < 8 || viewport.columns < 24,
    width: modalContentWidth(viewport, 70),
    listRows: Math.max(1, Math.min(12, rows - 10)),
    reviewRows: Math.max(1, Math.min(18, rows - 8)),
  };
}

export function agentPickerLayout(
  state: Extract<TuiAddAgentState, { stage: "selection" }>,
) {
  const { compact, width, listRows } = agentModalSize(state);
  const picker = state.picker;
  const matches = filteredAgents(picker);
  const installedMatches = picker.query.trim()
    ? matchingAgents(picker.installedAgents, picker.query)
    : [];
  let emptyMessage = "No matching agents";
  if (!picker.query.trim() && picker.agents.length === 0)
    emptyMessage = "All supported agents already have this skill.";
  else if (installedMatches.length === 1) {
    const agent = installedMatches[0]!;
    emptyMessage = `${agent === "antigravity-cli" ? "Antigravity CLI" : agent} already has this skill.`;
  } else if (installedMatches.length > 1)
    emptyMessage = `All ${installedMatches.length} matching agents already have this skill.`;
  const offset = Math.max(
    0,
    Math.min(
      matches.length - listRows,
      picker.index - Math.floor(listRows / 2),
    ),
  );
  const longHint = "↑↓ PgUp/PgDn move · space select · enter review · esc back";
  const hint = !picker.agents.length
    ? "esc back"
    : width >= longHint.length + 3
      ? longHint
      : width >= 30
        ? "enter review · esc back"
        : "enter review";
  const shortcuts =
    !picker.agents.length || hint === longHint
      ? []
      : width >= 30
        ? [
            width >= 35
              ? "↑↓ PgUp/PgDn move · space select"
              : "↑↓ move · space select",
          ]
        : ["space select", "esc back"];
  const headers = 2;
  const frame = compact
    ? null
    : modalFrame(
        state.browse.model.viewport,
        width,
        headers + listRows + shortcuts.length,
      );
  return {
    width,
    listRows,
    matches,
    installedMatches,
    emptyMessage,
    offset,
    hint,
    shortcuts,
    firstRow: frame ? frame.contentTop + headers + 1 : null,
    firstColumn: frame ? frame.contentLeft + 1 : null,
  };
}

export function addAgentEntry(state: TuiBrowseState) {
  const selected = state.model.selected;
  if (!selected.size) return currentEntry(state.model);
  if (selected.size !== 1) return null;
  return state.model.sections
    .flatMap((section) => section.entries)
    .find((entry) => selected.has(entry.key));
}
