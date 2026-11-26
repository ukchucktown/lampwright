import { searchLayout, searchPosition } from "./search.js";
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

export function agentPickerLayout(
  state: Extract<TuiAddAgentState, { stage: "selection" }>,
) {
  const grid = searchLayout(state.browse.model.viewport);
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
  const { index, scroll } = searchPosition(
    picker.index,
    picker.scroll ?? 0,
    matches.length,
    grid.resultRows,
    0,
  );
  return { matches, installedMatches, emptyMessage, grid, index, scroll };
}

export function addAgentEntry(state: TuiBrowseState) {
  const selected = state.model.selected;
  if (!selected.size) return currentEntry(state.model);
  if (selected.size !== 1) return null;
  return state.model.sections
    .flatMap((section) => section.entries)
    .find((entry) => selected.has(entry.key));
}
