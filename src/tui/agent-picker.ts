import { modalContentWidth, modalFrame } from "./overlay.js";
import { currentEntry } from "./browse.js";
import type { TuiAddAgentState, TuiBrowseState } from "./types.js";

export function filteredAgents(state: TuiAddAgentState): readonly string[] {
  const query = state.query.toLowerCase().trim();
  return state.agents.filter(
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
    width: modalContentWidth(viewport, 70),
    listRows: Math.max(1, Math.min(12, rows - 10)),
    reviewRows: Math.max(1, Math.min(18, rows - 8)),
  };
}

export function agentPickerLayout(state: TuiAddAgentState) {
  const { width, listRows } = agentModalSize(state);
  const matches = filteredAgents(state);
  const offset = Math.max(
    0,
    Math.min(matches.length - listRows, state.index - Math.floor(listRows / 2)),
  );
  const longHint = "↑↓ PgUp/PgDn move · space select · enter review · esc back";
  const hint =
    width >= longHint.length + 3
      ? longHint
      : width >= 30
        ? "enter review · esc back"
        : "enter review";
  const shortcuts =
    hint === longHint
      ? []
      : width >= 30
        ? [
            width >= 35
              ? "↑↓ PgUp/PgDn move · space select"
              : "↑↓ move · space select",
          ]
        : ["space select", "esc back"];
  const headers = 3;
  const frame = modalFrame(
    state.browse.model.viewport,
    width,
    headers + listRows + shortcuts.length,
  );
  return {
    width,
    listRows,
    matches,
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
