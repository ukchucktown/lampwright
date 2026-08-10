import type {
  TuiBrowseModel,
  TuiEntry,
  TuiLayout,
  TuiPaneView,
  TuiSection,
  TuiViewport,
} from "./types.js";

/**
 * Pane navigation over the section projection.
 *
 * The layout is fixed: panes never grow to fit their contents. Each owns a
 * viewport that scrolls under a stationary frame, so the detail area below
 * never moves. Every function here is pure; the terminal calls in and nothing
 * flows back out.
 */

/**
 * Seven drawn rows — four header rows, two rules, and status — plus one row
 * left unused. A frame that fills the terminal exactly scrolls it by one on
 * the final newline, which reads as the panes drifting.
 */
const HEADER_ROWS = 4;
const CHROME_ROWS = 8;
const MIN_PANE_ROWS = 3;
const MIN_DETAIL_ROWS = 3;
const SCROLL_MARGIN = 1;

export function createBrowseModel(
  sections: readonly TuiSection[],
  viewport: TuiViewport,
): TuiBrowseModel {
  return settle({
    sections,
    viewport,
    focus: "sections",
    sectionIndex: 0,
    entryIndex: 0,
    sectionScroll: 0,
    entryScroll: 0,
    detailScroll: 0,
    leftPercent: 32,
    detailRows: 6,
    query: "",
    selected: new Set(),
    notice: null,
  });
}

export function layout(model: TuiBrowseModel): TuiLayout {
  const rows = dimension(model.viewport.rows);
  const columns = dimension(model.viewport.columns);
  const availableRows = Math.max(0, rows - CHROME_ROWS);
  const reservedPaneRows = Math.min(MIN_PANE_ROWS, availableRows);
  const detailRows = Math.min(
    Math.max(MIN_DETAIL_ROWS, model.detailRows),
    Math.max(0, availableRows - reservedPaneRows),
  );
  const paneRows = Math.max(0, availableRows - detailRows);
  const usable = Math.max(0, columns - 1);
  const maximumLeft = Math.max(0, usable - 2);
  const leftWidth = Math.min(
    maximumLeft,
    Math.max(
      maximumLeft === 0 ? 0 : 1,
      Math.round((columns * clampPercent(model.leftPercent)) / 100),
    ),
  );
  return {
    rows,
    columns,
    headerRows: HEADER_ROWS,
    usable,
    paneRows,
    entryRows: Math.max(1, paneRows - 1),
    detailRows,
    leftWidth,
    rightWidth: Math.max(0, usable - leftWidth - 2),
  };
}

function dimension(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/**
 * Name-first matching.
 *
 * Descriptions are excluded: they are ordinary English, so a two-letter query
 * matched almost every Skill through words like "can" and "because", which made
 * search useless. A term matches a name as a subsequence, or the section label,
 * agents, or paths as a substring.
 */
export function matches(
  entry: TuiEntry,
  section: TuiSection,
  query: string,
): boolean {
  const trimmed = query.trim().toLocaleLowerCase("en-US");
  if (trimmed === "") return true;
  const name = entry.name.toLocaleLowerCase("en-US");
  const rest = [section.label, ...entry.exposedTo, ...entry.paths]
    .join(" ")
    .toLocaleLowerCase("en-US");
  return trimmed
    .split(/\s+/u)
    .every((term) => subsequence(term, name) || rest.includes(term));
}

export function visibleSections(model: TuiBrowseModel): readonly TuiSection[] {
  if (model.query.trim() === "") return model.sections;
  return model.sections.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) =>
      matches(entry, section, model.query),
    ),
  }));
}

export function currentSection(model: TuiBrowseModel): TuiSection | null {
  const sections = visibleSections(model);
  return sections[Math.min(model.sectionIndex, sections.length - 1)] ?? null;
}

export function currentEntries(model: TuiBrowseModel): readonly TuiEntry[] {
  return currentSection(model)?.entries ?? [];
}

export function currentEntry(model: TuiBrowseModel): TuiEntry | null {
  const entries = currentEntries(model);
  return entries[Math.min(model.entryIndex, entries.length - 1)] ?? null;
}

export interface TuiDetailLine {
  readonly kind: "heading" | "description" | "blank" | "path";
  readonly text: string;
}

/** The complete, wrapped detail projection before its viewport is applied. */
export function detailLines(model: TuiBrowseModel): readonly TuiDetailLine[] {
  const entry = currentEntry(model);
  if (entry === null) return [];
  const lines: TuiDetailLine[] = [
    {
      kind: "heading",
      text: `${entry.name}   ${entry.owner}${entry.note === null ? "" : ` · ${entry.note}`}`,
    },
  ];
  // Two columns indent detail text and one carries its scrollbar.
  for (const line of wrap(entry.description ?? "", layout(model).usable - 3))
    lines.push({ kind: "description", text: `  ${line}` });
  if (entry.paths.length > 0) lines.push({ kind: "blank", text: "" });
  for (const path of entry.paths)
    lines.push({ kind: "path", text: `  ${path}` });
  return lines;
}

export function detailPane(model: TuiBrowseModel): TuiPaneView<TuiDetailLine> {
  const lines = detailLines(model);
  const height = layout(model).detailRows;
  const offset = Math.min(
    Math.max(0, model.detailScroll),
    Math.max(0, lines.length - height),
  );
  return {
    items: lines.slice(offset, offset + height),
    offset,
    total: lines.length,
    height,
  };
}

export function panes(model: TuiBrowseModel): {
  readonly sections: TuiPaneView<TuiSection>;
  readonly entries: TuiPaneView<TuiEntry>;
} {
  const { paneRows, entryRows } = layout(model);
  const sections = visibleSections(model);
  const entries = currentEntries(model);
  return {
    sections: {
      items: sections.slice(
        model.sectionScroll,
        model.sectionScroll + paneRows,
      ),
      offset: model.sectionScroll,
      total: sections.length,
      height: paneRows,
    },
    entries: {
      items: entries.slice(model.entryScroll, model.entryScroll + entryRows),
      offset: model.entryScroll,
      total: entries.length,
      height: entryRows,
    },
  };
}

/** The exposure every entry in a section shares, or null when they differ. */
export function sharedExposure(section: TuiSection): string | null {
  const first = section.entries[0];
  if (first === undefined) return null;
  const key = first.exposedTo.join(" ");
  return section.entries.every((entry) => entry.exposedTo.join(" ") === key)
    ? key
    : null;
}

/** The path count every entry shares, or null when they differ. */
export function sharedPathCount(section: TuiSection): number | null {
  const first = section.entries[0];
  if (first === undefined) return null;
  const count = first.paths.length;
  return section.entries.every((entry) => entry.paths.length === count)
    ? count
    : null;
}

export function selectionSummary(
  model: TuiBrowseModel,
): readonly { readonly label: string; readonly count: number }[] {
  return model.sections
    .map((section) => ({
      label: section.label,
      count: section.entries.filter((entry) => model.selected.has(entry.key))
        .length,
    }))
    .filter((entry) => entry.count > 0);
}

export type TuiBrowseCommand =
  | { readonly kind: "viewport"; readonly viewport: TuiViewport }
  | {
      readonly kind: "focus";
      readonly pane: "sections" | "entries" | "detail";
    }
  | { readonly kind: "move"; readonly delta: number }
  | {
      readonly kind: "move-pane";
      readonly pane: "sections" | "entries" | "detail";
      readonly delta: number;
    }
  | { readonly kind: "page"; readonly delta: number }
  | { readonly kind: "point-section"; readonly index: number }
  | { readonly kind: "point-entry"; readonly index: number }
  | {
      readonly kind: "point-toggle";
      readonly pane: "sections" | "entries";
      readonly index: number;
    }
  | { readonly kind: "resize-panes"; readonly delta: number }
  | { readonly kind: "set-left-percent"; readonly percent: number }
  | { readonly kind: "resize-detail"; readonly delta: number }
  | { readonly kind: "set-detail-rows"; readonly rows: number }
  | { readonly kind: "type"; readonly value: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "clear-query" }
  | { readonly kind: "toggle-select" }
  | { readonly kind: "clear-selection" };

export function reduceBrowse(
  model: TuiBrowseModel,
  command: TuiBrowseCommand,
): TuiBrowseModel {
  const next: TuiBrowseModel = { ...model, notice: null };
  switch (command.kind) {
    case "viewport":
      return settle({ ...next, viewport: command.viewport });
    case "focus": {
      if (command.pane === "entries" && currentEntries(next).length === 0)
        return { ...next, notice: "That section is empty." };
      return settle({ ...next, focus: command.pane });
    }
    case "move":
      return settle(move(next, command.delta));
    case "move-pane":
      return settle(move({ ...next, focus: command.pane }, command.delta));
    case "page":
      return settle(
        move(
          next,
          command.delta *
            (next.focus === "sections"
              ? layout(next).paneRows
              : next.focus === "entries"
                ? layout(next).entryRows
                : layout(next).detailRows),
        ),
      );
    case "point-section":
      return settle({
        ...next,
        focus: "sections",
        sectionIndex: command.index,
        entryIndex: 0,
        entryScroll: 0,
        detailScroll: 0,
      });
    case "point-entry":
      return settle({
        ...next,
        focus: "entries",
        entryIndex: command.index,
        detailScroll: 0,
      });
    case "point-toggle": {
      const pointed = settle(
        command.pane === "sections"
          ? {
              ...next,
              focus: "sections",
              sectionIndex: command.index,
              entryIndex: 0,
              entryScroll: 0,
              detailScroll: 0,
            }
          : {
              ...next,
              focus: "entries",
              entryIndex: command.index,
              detailScroll: 0,
            },
      );
      return toggleSelect(pointed);
    }
    case "resize-panes":
      return settle({
        ...next,
        leftPercent: clampPercent(next.leftPercent + command.delta),
      });
    case "set-left-percent":
      return settle({ ...next, leftPercent: clampPercent(command.percent) });
    case "resize-detail":
      return settle({
        ...next,
        detailRows: clampDetailRows(next, next.detailRows + command.delta),
      });
    case "set-detail-rows":
      return settle({
        ...next,
        detailRows: clampDetailRows(next, command.rows),
      });
    case "type":
      return settle({
        ...next,
        query: `${next.query}${command.value}`,
        entryIndex: 0,
        entryScroll: 0,
        detailScroll: 0,
      });
    case "backspace":
      return settle({
        ...next,
        query: [...next.query].slice(0, -1).join(""),
        entryIndex: 0,
        entryScroll: 0,
        detailScroll: 0,
      });
    case "clear-query":
      return settle({
        ...next,
        query: "",
        entryIndex: 0,
        entryScroll: 0,
        detailScroll: 0,
      });
    case "toggle-select":
      return toggleSelect(next);
    case "clear-selection":
      return { ...next, selected: new Set() };
  }
}

function move(model: TuiBrowseModel, delta: number): TuiBrowseModel {
  if (model.focus === "detail")
    return {
      ...model,
      detailScroll: Math.max(0, model.detailScroll + delta),
    };
  if (model.focus === "sections")
    return {
      ...model,
      sectionIndex: step(
        model.sectionIndex,
        visibleSections(model).length,
        delta,
      ),
      entryIndex: 0,
      entryScroll: 0,
      detailScroll: 0,
    };
  return {
    ...model,
    entryIndex: step(model.entryIndex, currentEntries(model).length, delta),
    detailScroll: 0,
  };
}

function toggleSelect(model: TuiBrowseModel): TuiBrowseModel {
  if (model.focus === "detail") return model;
  const section = currentSection(model);
  if (section === null) return model;
  if (!section.selectable)
    return { ...model, notice: `${section.label} cannot be removed here.` };

  // Space on a section row takes the whole section. Refusing the obvious
  // gesture and naming another key made bulk selection undiscoverable, and a
  // 22-skill bundle is where pressing space once per row hurts most.
  const keys =
    model.focus === "sections"
      ? section.entries
          .filter((entry) => entry.selectable ?? entry.target !== null)
          .map((entry) => entry.key)
      : [currentEntry(model)]
          .filter(
            (entry): entry is TuiEntry =>
              entry !== null && (entry.selectable ?? entry.target !== null),
          )
          .map((entry) => entry.key);
  if (keys.length === 0) return model;

  const selected = new Set(model.selected);
  const everyTaken = keys.every((key) => selected.has(key));
  for (const key of keys) {
    if (everyTaken) selected.delete(key);
    else selected.add(key);
  }
  return {
    ...model,
    selected,
    notice:
      model.focus === "sections"
        ? `${everyTaken ? "Cleared" : "Selected"} ${String(keys.length)} in ${section.label}.`
        : null,
  };
}

/** Clamps indices to current contents, then brings both viewports into range. */
function settle(model: TuiBrowseModel): TuiBrowseModel {
  const { paneRows, entryRows, detailRows } = layout(model);
  const sections = visibleSections(model);
  const sectionIndex = clampIndex(model.sectionIndex, sections.length);
  const entries = sections[sectionIndex]?.entries ?? [];
  const entryIndex = clampIndex(model.entryIndex, entries.length);
  const indexed = {
    ...model,
    sectionIndex,
    entryIndex,
    focus: entries.length === 0 ? "sections" : model.focus,
    sectionScroll: scrollFor(
      model.sectionScroll,
      sectionIndex,
      paneRows,
      sections.length,
    ),
    entryScroll: scrollFor(
      model.entryScroll,
      entryIndex,
      entryRows,
      entries.length,
    ),
  };
  return {
    ...indexed,
    detailScroll: Math.min(
      Math.max(0, indexed.detailScroll),
      Math.max(0, detailLines(indexed).length - detailRows),
    ),
  };
}

/** Keeps the cursor inside its viewport without recentring on every step. */
function scrollFor(
  offset: number,
  index: number,
  height: number,
  length: number,
): number {
  if (length <= height) return 0;
  const margin = height > 2 * SCROLL_MARGIN + 1 ? SCROLL_MARGIN : 0;
  const low = Math.max(0, index - margin);
  const high = Math.min(length - 1, index + margin);
  let next = offset;
  if (low < next) next = low;
  if (high > next + height - 1) next = high - height + 1;
  return Math.min(Math.max(0, next), Math.max(0, length - height));
}

function subsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function clampPercent(percent: number): number {
  return Math.min(55, Math.max(18, percent));
}

function clampDetailRows(model: TuiBrowseModel, rows: number): number {
  const availableRows = Math.max(
    0,
    dimension(model.viewport.rows) - CHROME_ROWS,
  );
  const maximum = Math.max(MIN_DETAIL_ROWS, availableRows - MIN_PANE_ROWS);
  return Math.min(maximum, Math.max(MIN_DETAIL_ROWS, rows));
}

function step(index: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(index + delta, 0), length - 1);
}

function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}

/** Greedy word wrap, so a long description reads instead of being cut off. */
function wrap(text: string, width: number): readonly string[] {
  if (text === "" || width <= 0) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
