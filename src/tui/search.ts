import type {
  TuiBrowseModel,
  TuiSearchModel,
  TuiSearchResult,
  TuiSection,
  TuiViewport,
} from "./types.js";

const SCROLL_MARGIN = 1;
/** Header, top border, prompt, split rule, a result, bottom border, and status. */
const SEARCH_RESULT_START_ROW = 6;
const MINIMUM_SEARCH_ROWS = 8;

export interface TuiSearchLayout {
  readonly rows: number;
  readonly columns: number;
  readonly usable: number;
  readonly leftWidth: number;
  readonly rightWidth: number;
  /** One-based terminal row for the first matching Skill. */
  readonly resultStartRow: number;
  /** The overlay cannot draw one result row plus its footer below this size. */
  readonly compact: boolean;
  readonly resultRows: number;
}

export type TuiSearchCommand =
  | { readonly kind: "type"; readonly value: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "clear" }
  | { readonly kind: "move"; readonly delta: number }
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "page"; readonly delta: number }
  | { readonly kind: "toggle" }
  | { readonly kind: "toggle-at"; readonly index: number }
  | { readonly kind: "stage-all" }
  | { readonly kind: "viewport"; readonly viewport: TuiViewport };

export function createSearchModel(
  browse: TuiBrowseModel,
  viewport = browse.viewport,
): TuiSearchModel {
  return settle({
    results: searchResults(browse.sections, "", browse.selected),
    viewport,
    query: "",
    matchError: null,
    index: 0,
    scroll: 0,
    staged: new Set(),
    existing: browse.selected,
    notice: null,
  });
}

/** Search matching is deliberately name-only; preview metadata never matches. */
export function searchResults(
  sections: readonly TuiSection[],
  query: string,
  existing: ReadonlySet<string> = new Set(),
): readonly TuiSearchResult[] {
  if (query === "") return projectResults(sections, existing, () => true);
  const expression = compileExpression(query);
  if (expression === null) return [];
  return projectResults(sections, existing, (name) => expression.test(name));
}

function projectResults(
  sections: readonly TuiSection[],
  existing: ReadonlySet<string>,
  matches: (name: string) => boolean,
): readonly TuiSearchResult[] {
  return sections.flatMap((section) =>
    section.entries
      // Plugin boundaries are removable UI entries, but are not Skills and
      // therefore do not participate in a Skill-name search.
      .filter((entry) => entry.target?.kind !== "plugin")
      .filter((entry) => matches(entry.name))
      .map((entry) => ({
        entry,
        category: section.label,
        selectable:
          section.selectable && (entry.selectable ?? entry.target !== null),
        existing: existing.has(entry.key),
      })),
  );
}

export function searchError(query: string): string | null {
  if (query === "") return null;
  try {
    const expression = new RegExp(query, "iu");
    return expression.test("")
      ? "This expression matches empty text. Try ^c or ^c.* instead of ^c*."
      : null;
  } catch (error: unknown) {
    return error instanceof Error
      ? `Invalid regular expression: ${error.message}`
      : "Invalid regular expression.";
  }
}

export function reduceSearch(
  model: TuiSearchModel,
  sections: readonly TuiSection[],
  command: TuiSearchCommand,
): TuiSearchModel {
  const next = { ...model, notice: null };
  switch (command.kind) {
    case "type":
      return replaceQuery(next, sections, `${next.query}${command.value}`);
    case "backspace":
      return replaceQuery(
        next,
        sections,
        [...next.query].slice(0, -1).join(""),
      );
    case "clear":
      return replaceQuery(next, sections, "");
    case "viewport":
      return settle({ ...next, viewport: command.viewport });
    case "move":
      return settle({
        ...next,
        index: step(next.index, next.results.length, command.delta),
      });
    case "focus":
      return settle({ ...next, index: command.index }, 0);
    case "page":
      return settle({
        ...next,
        index: step(
          next.index,
          next.results.length,
          command.delta * searchRows(next.viewport),
        ),
      });
    case "toggle":
      return toggle(next, next.index);
    case "toggle-at":
      return toggle(next, command.index);
    case "stage-all": {
      if (next.matchError !== null) return { ...next, notice: next.matchError };
      const keys = next.results
        .filter((result) => result.selectable && !result.existing)
        .map((result) => result.entry.key);
      const staged = new Set(next.staged);
      const everyStaged = keys.every((key) => staged.has(key));
      for (const key of keys) {
        if (everyStaged) staged.delete(key);
        else staged.add(key);
      }
      return { ...next, staged };
    }
  }
}

export function searchRows(viewport: TuiViewport): number {
  return searchLayout(viewport).resultRows;
}

export function searchLayout(viewport: TuiViewport): TuiSearchLayout {
  const rows = dimension(viewport.rows);
  const columns = dimension(viewport.columns);
  const usable = Math.max(0, columns - 1);
  // The search grid is enclosed on both sides and divided in the middle.
  // Keep the cell widths independent from those three structural columns so
  // rendering, paging, and pointer hit-testing use the same geometry.
  const singleColumn = columns < 40;
  const paneWidth = Math.max(0, usable - (singleColumn ? 2 : 3));
  const resultStartRow =
    rows === MINIMUM_SEARCH_ROWS
      ? SEARCH_RESULT_START_ROW - 1
      : SEARCH_RESULT_START_ROW;
  const leftWidth = Math.min(
    paneWidth,
    Math.max(0, Math.floor(paneWidth * 0.45)),
  );
  return {
    rows,
    columns,
    usable,
    leftWidth: singleColumn ? paneWidth : leftWidth,
    rightWidth: singleColumn ? 0 : Math.max(0, paneWidth - leftWidth),
    resultStartRow,
    compact: rows < MINIMUM_SEARCH_ROWS || columns < 20,
    // The header, prompt frame, and footer surround the matching rows. Keep
    // this shared with paging and pointer hit-testing.
    resultRows: Math.max(1, rows - (resultStartRow + 2)),
  };
}

function replaceQuery(
  model: TuiSearchModel,
  sections: readonly TuiSection[],
  query: string,
): TuiSearchModel {
  const error = searchError(query);
  return settle({
    ...model,
    query,
    matchError: error,
    results:
      error === null ? searchResults(sections, query, model.existing) : [],
    index: 0,
    scroll: 0,
  });
}

function compileExpression(query: string): RegExp | null {
  if (searchError(query) !== null) return null;
  return new RegExp(query, "iu");
}

function toggle(model: TuiSearchModel, index: number): TuiSearchModel {
  const result = model.results[index];
  if (result === undefined) return model;
  if (!result.selectable)
    return {
      ...model,
      notice: `${result.entry.name} is a System Skill and cannot be staged.`,
    };
  if (result.existing)
    return { ...model, notice: `${result.entry.name} is already selected.` };
  const staged = new Set(model.staged);
  if (staged.has(result.entry.key)) staged.delete(result.entry.key);
  else staged.add(result.entry.key);
  return { ...model, staged };
}

function settle(model: TuiSearchModel, margin = SCROLL_MARGIN): TuiSearchModel {
  return {
    ...model,
    ...searchPosition(
      model.index,
      model.scroll,
      model.results.length,
      searchRows(model.viewport),
      margin,
    ),
  };
}

export function searchPosition(
  focus: number,
  first: number,
  count: number,
  rows: number,
  preferredMargin = SCROLL_MARGIN,
) {
  const index = step(0, count, focus);
  const maximum = Math.max(0, count - rows);
  const margin = Math.min(preferredMargin, Math.floor((rows - 1) / 2));
  let scroll = Math.min(Math.max(0, first), maximum);
  if (index < scroll + margin) scroll = Math.max(0, index - margin);
  if (index >= scroll + rows - margin)
    scroll = Math.min(maximum, index - rows + margin + 1);
  return { index, scroll };
}

function step(index: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(0, index + delta), length - 1);
}

function dimension(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}
