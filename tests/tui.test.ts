import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createBrowseModel,
  createSearchModel,
  createNightfallTheme,
  createNodeTuiTerminal,
  createTuiSections,
  detectTuiColorMode,
  layout,
  matches,
  mouseAction,
  parseLineTuiAction,
  parseMouseReport,
  parseMouseReports,
  plainTuiTheme,
  plan,
  reduceBrowse,
  reduceSearch,
  renderBrowseLines,
  renderTui,
  runTui,
  searchLayout,
  searchRows,
  selectionTargets,
  styleTui,
  TuiController,
  type ApprovalRequirement,
  type ExecutionReport,
  type Installation,
  type Inventory,
  type RemovalEvidence,
  type RemovalPlan,
  type TuiAction,
  type TuiState,
  type TuiTerminal,
} from "../src/index.js";
import { MouseReportFramer, parseRawTuiAction } from "../src/tui/terminal.js";
import {
  buildExecutionReport,
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
  buildSystemSkillFinding,
} from "../src/testing/index.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
const visibleWidth = (value: string): number =>
  [...value.replace(ansi, "")].length;

class ScriptedTerminal implements TuiTerminal {
  readonly frames: string[] = [];
  closed = false;

  constructor(private readonly actions: TuiAction[]) {}

  render(state: TuiState): void {
    this.frames.push(renderTui(state));
  }

  async readAction(): Promise<TuiAction> {
    return this.actions.shift() ?? { kind: "quit" };
  }

  close(): void {
    this.closed = true;
  }
}

function managedInstallation(
  overrides: Parameters<typeof buildInstallation>[0] = {},
): Installation {
  const removal: RemovalEvidence = {
    managed: {
      adapterId: "fixture-adapter",
      operationId: "remove",
      availability: { kind: "available" },
      trust: { kind: "trusted" },
      externalId: "managed-skill",
      invocation: {
        kind: "direct",
        command: {
          executable: "fixture-manager",
          arguments: ["remove", "managed-skill"],
        },
      },
      effects: [],
      verifications: [],
    },
    fallback: { kind: "available", requiresSeparateConfirmation: true },
    recordCleanups: [],
  };
  return buildInstallation({
    manager: { id: "fixture-manager" },
    ownership: {
      kind: "manager",
      managerId: "fixture-manager",
      confidence: "declared",
    },
    removal,
    ...overrides,
  });
}

function groupedInventory(
  names: readonly string[] = ["alpha", "beta"],
): Inventory {
  const members = names.map((name) =>
    managedInstallation({
      id: `installation-${name}`,
      skill: { name, description: `${name} description` },
      source: { id: "acme/toolkit", url: null },
      exposedTo: ["claude-code", "codex"],
      location: {
        path: `/fixtures/skills/${name}`,
        canonicalPath: `/fixtures/skills/${name}`,
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: `/fixtures/skills/${name}`,
          },
        ],
        weakEvidence: [],
      },
    }),
  );
  return buildInventory({
    installations: members,
    logicalSkills: members.map((installation, index) =>
      buildLogicalSkill({
        id: `logical-${String(index)}`,
        skill: installation.skill,
        identity: {
          strongEvidence: [installation.identity.strongEvidence[0]!],
          weakEvidence: [],
        },
        installationIds: [installation.id],
        groupId: "installation-group-1",
        spansGroups: false,
      }),
    ),
    groups: [
      {
        id: "installation-group-1",
        label: "acme/toolkit",
        tier: "declared",
        evidence: {
          tier: "declared",
          kind: "manager-source",
          managerId: "fixture-manager",
          sourceId: "acme/toolkit",
        },
        scope: { kind: "user" },
        installationIds: members.map((installation) => installation.id),
      },
    ],
  });
}

describe("terminal theme", () => {
  const context = (
    environment: Readonly<Record<string, string | undefined>>,
    overrides: { readonly isTTY?: boolean; readonly platform?: string } = {},
  ) => ({
    isTTY: overrides.isTTY ?? true,
    platform: overrides.platform ?? "linux",
    environment,
  });

  it("selects the strongest portable color mode and honors NO_COLOR", () => {
    expect(detectTuiColorMode(context({}, { isTTY: false }))).toBe("none");
    expect(
      detectTuiColorMode(context({ NO_COLOR: "", COLORTERM: "truecolor" })),
    ).toBe("none");
    expect(detectTuiColorMode(context({ TERM: "dumb" }))).toBe("none");
    expect(detectTuiColorMode(context({ COLORTERM: "truecolor" }))).toBe(
      "truecolor",
    );
    expect(detectTuiColorMode(context({ TERM_PROGRAM: "Ghostty" }))).toBe(
      "truecolor",
    );
    expect(detectTuiColorMode(context({ TERM: "xterm-256color" }))).toBe(
      "ansi256",
    );
    expect(
      detectTuiColorMode(
        context({ WT_SESSION: "terminal" }, { platform: "win32" }),
      ),
    ).toBe("truecolor");
    expect(detectTuiColorMode(context({ TERM: "xterm" }))).toBe("ansi16");
  });

  it("uses the Nightfall semantic palette without painting a base background", () => {
    const theme = createNightfallTheme("truecolor");
    expect(styleTui(theme, "title", "title")).toContain(
      "\u001B[1;38;2;130;214;214m",
    );
    expect(styleTui(theme, "border", "│")).toContain("\u001B[38;2;43;46;72m");
    expect(styleTui(theme, "focus", "row")).toContain("48;2;72;78;91");
    expect(theme.styles.title.background).toBeUndefined();
    expect(theme.styles.border.background).toBeUndefined();
    expect(styleTui(createNightfallTheme("ansi256"), "active", "x")).toContain(
      "\u001B[1;38;5;",
    );
  });

  it("keeps the same text and frame geometry with color disabled", () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const colored = renderTui(state, createNightfallTheme("truecolor"));
    const plain = renderTui(state, plainTuiTheme);

    expect(colored).toContain("\u001B[38;2;43;46;72m");
    expect(colored.replace(ansi, "")).toBe(plain);
    expect(plain).not.toContain(String.fromCharCode(27));
    expect(plain).toContain("[ ]");
    expect(plain).toContain("│");
  });

  it("distinguishes header keys from their action descriptions", () => {
    const inventory = groupedInventory();
    const model = createBrowseModel(createTuiSections(inventory), {
      rows: 24,
      columns: 100,
    });
    const state: TuiState = { screen: "browse", inventory, model };
    const theme = createNightfallTheme("truecolor");
    const colored = renderBrowseLines(state, theme)[1]!;
    const plain = renderBrowseLines(state, plainTuiTheme)[1]!;

    expect(colored).toContain(styleTui(theme, "title", "↑↓/wheel"));
    expect(colored).toContain(styleTui(theme, "title", "click"));
    expect(colored).toContain(styleTui(theme, "title", "space/dbl-click"));
    expect(colored).toContain(styleTui(theme, "muted", " move · "));
    expect(colored.replace(ansi, "")).toBe(plain);
    expect(plain).toContain("↑↓/wheel move · click focus");
    expect(plain).toContain("space/dbl-click select");
    expect(plain).toContain("q quit");
    expect(visibleWidth(colored)).toBe(99);

    const narrow = renderBrowseLines(
      {
        ...state,
        model: reduceBrowse(model, {
          kind: "viewport",
          viewport: { rows: 14, columns: 62 },
        }),
      },
      theme,
    )[1]!;
    expect(narrow).toContain(styleTui(theme, "title", "↑↓/wheel"));
    expect(visibleWidth(narrow)).toBe(61);
  });

  it("shows detail scrolling and resizing controls when detail has focus", () => {
    const inventory = groupedInventory();
    const model = reduceBrowse(
      createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
      { kind: "focus", pane: "detail" },
    );
    const line = renderBrowseLines(
      { screen: "browse", inventory, model },
      plainTuiTheme,
    )[1]!;

    expect(line).toContain("↑↓/wheel scroll");
    expect(line).toContain("PgUp/PgDn page");
    expect(line).toContain("⇧↑↓ resize");
    expect(line).toContain("tab/⇧tab pane");
  });

  it("keeps line-oriented terminal output monochrome", () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      { theme: createNightfallTheme("truecolor") },
    );

    terminal.render(state);
    terminal.close();
    expect(written).not.toContain(String.fromCharCode(27));
    expect(written).toContain("skill-cleaner");
  });
});

describe("terminal section projection", () => {
  it("builds sections from declared evidence and keeps System Skills unselectable", () => {
    const sections = createTuiSections(
      buildInventory({
        installations: [buildInstallation()],
        otherFindings: [buildSystemSkillFinding()],
        logicalSkills: [buildLogicalSkill()],
        plugins: [buildPluginBoundary()],
      }),
    );

    expect(
      sections.map((section) => [section.label, section.selectable]),
    ).toEqual([
      ["No shared source", true],
      ["Plugins", true],
      ["System skills", false],
    ]);
    expect(
      sections.at(-1)?.entries.every((entry) => entry.target === null),
    ).toBe(true);
  });

  it("collapses a fully selected Group into one Source Group target", () => {
    const sections = createTuiSections(groupedInventory());
    const bundle = sections[0]!;
    const every = new Set(bundle.entries.map((entry) => entry.key));

    expect(selectionTargets(sections, every)).toEqual([
      { kind: "source-group", groupId: "installation-group-1" },
    ]);
    expect(
      selectionTargets(sections, new Set([bundle.entries[0]!.key])),
    ).toEqual([{ kind: "logical-skill", logicalSkillId: "logical-0" }]);
  });

  it("represents an Installation that belongs to no Logical Skill", () => {
    const sections = createTuiSections(
      buildInventory({ installations: [buildInstallation()] }),
    );

    expect(sections[0]?.entries[0]?.target).toEqual({
      kind: "installation",
      installationId: "installation-1",
    });
  });

  it("offers a Plugin as its own boundary rather than its owned Skills", () => {
    const sections = createTuiSections(
      buildInventory({ installations: [], plugins: [buildPluginBoundary()] }),
    );

    expect(sections[0]?.entries[0]?.target).toEqual({
      kind: "plugin",
      pluginBoundaryId: "fixture-plugin",
    });
  });
});

describe("terminal pane navigation", () => {
  const viewport = { rows: 24, columns: 100 };

  it("scrolls a focused detail independently and resets for another entry", () => {
    const sections = createTuiSections(groupedInventory());
    const detailed = sections.map((section, sectionIndex) =>
      sectionIndex === 0
        ? {
            ...section,
            entries: section.entries.map((entry) => ({
              ...entry,
              description: "wrapped detail ".repeat(80),
            })),
          }
        : section,
    );
    const initial = createBrowseModel(detailed, { rows: 18, columns: 50 });
    const focused = reduceBrowse(initial, { kind: "focus", pane: "detail" });
    const scrolled = reduceBrowse(focused, { kind: "move", delta: 2 });

    expect(scrolled.focus).toBe("detail");
    expect(scrolled.detailScroll).toBe(2);
    expect(scrolled.sectionIndex).toBe(initial.sectionIndex);
    expect(scrolled.entryIndex).toBe(initial.entryIndex);

    const changed = reduceBrowse(scrolled, { kind: "point-entry", index: 1 });
    expect(changed.detailScroll).toBe(0);

    const keyboardChanged = reduceBrowse(
      reduceBrowse(scrolled, { kind: "focus", pane: "entries" }),
      { kind: "move", delta: 1 },
    );
    expect(keyboardChanged.detailScroll).toBe(0);
  });

  it("renders the visible detail range and leaves later content reachable", () => {
    const inventory = groupedInventory();
    const sections = createTuiSections(inventory);
    const detailed = sections.map((section, sectionIndex) =>
      sectionIndex === 0
        ? {
            ...section,
            entries: section.entries.map((entry, entryIndex) =>
              entryIndex === 0
                ? {
                    ...entry,
                    description: null,
                    paths: Array.from(
                      { length: 10 },
                      (_, index) => `/detail/path-${String(index + 1)}`,
                    ),
                  }
                : entry,
            ),
          }
        : section,
    );
    let model = createBrowseModel(detailed, viewport);
    model = reduceBrowse(model, { kind: "focus", pane: "detail" });
    model = reduceBrowse(model, { kind: "move", delta: 2 });

    const rendered = renderBrowseLines(
      { screen: "browse", inventory, model },
      plainTuiTheme,
    ).join("\n");

    expect(rendered).toContain("/detail/path-1");
    expect(rendered).toContain("/detail/path-6");
    expect(rendered).not.toContain("/detail/path-7");
    expect(rendered).toContain("detail=3-8/12");
    expect(rendered).toContain("█");
  });

  it("keeps the detail pane read-only and backs out to entries", async () => {
    const inventory = groupedInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      viewport,
    );
    await controller.start();
    await controller.dispatch({ kind: "focus", pane: "detail" });
    await controller.dispatch({ kind: "toggle-select" });

    if (controller.state.screen !== "browse")
      throw new Error("expected browse");
    expect(controller.state.model.selected.size).toBe(0);
    expect(controller.state.model.focus).toBe("detail");

    await controller.dispatch({ kind: "cancel" });
    if (controller.state.screen !== "browse")
      throw new Error("expected browse");
    expect(controller.state.model.focus).toBe("entries");
  });

  it("renders a frame of constant height that never reaches the last column", () => {
    const inventory = groupedInventory();
    const base = createBrowseModel(createTuiSections(inventory), viewport);
    for (const size of [
      { rows: 24, columns: 100 },
      { rows: 14, columns: 62 },
      { rows: 50, columns: 200 },
    ]) {
      const model = reduceBrowse(base, { kind: "viewport", viewport: size });
      const lines = renderBrowseLines({ screen: "browse", inventory, model });
      expect(lines).toHaveLength(size.rows - 1);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns - 1);
    }
  });

  it("keeps every divider intact through repeated terminal and pane resizing", () => {
    const inventory = groupedInventory();
    let model = createBrowseModel(createTuiSections(inventory), viewport);
    const commands = [
      { kind: "viewport", viewport: { rows: 16, columns: 72 } },
      { kind: "set-left-percent", percent: 55 },
      { kind: "resize-detail", delta: 3 },
      { kind: "viewport", viewport: { rows: 32, columns: 140 } },
      { kind: "resize-panes", delta: -12 },
      { kind: "resize-detail", delta: -4 },
    ] as const;

    for (const command of commands) {
      model = reduceBrowse(model, command);
      const lines = renderBrowseLines({ screen: "browse", inventory, model });
      const grid = layout(model);
      const plain = lines.map((line) => line.replace(ansi, ""));

      expect(lines).toHaveLength(model.viewport.rows - 1);
      expect(plain[3]?.[grid.leftWidth]).toBe("┬");
      for (let row = 4; row < 4 + grid.paneRows; row += 1)
        expect(plain[row]?.[grid.leftWidth]).toBe("│");
      expect(plain[4 + grid.paneRows]?.[grid.leftWidth]).toBe("┴");
      for (const line of lines) expect(visibleWidth(line)).toBe(grid.usable);
    }
  });

  it("clamps the requested detail height to the current terminal", () => {
    const sections = createTuiSections(groupedInventory());
    const initial = createBrowseModel(sections, viewport);
    const enlarged = reduceBrowse(initial, {
      kind: "resize-detail",
      delta: 100,
    });

    expect(enlarged.detailRows).toBe(14);
    expect(layout(enlarged).detailRows).toBe(14);

    const taller = reduceBrowse(enlarged, {
      kind: "viewport",
      viewport: { rows: 50, columns: 100 },
    });
    expect(layout(taller).detailRows).toBe(14);
  });

  it("never draws beyond a terminal that is temporarily too small", () => {
    const inventory = groupedInventory();
    const base = createBrowseModel(createTuiSections(inventory), viewport);
    for (const size of [
      { rows: 8, columns: 40 },
      { rows: 12, columns: 20 },
      { rows: 4, columns: 2 },
    ]) {
      const model = reduceBrowse(base, { kind: "viewport", viewport: size });
      const lines = renderBrowseLines({ screen: "browse", inventory, model });
      expect(lines.length).toBeLessThanOrEqual(size.rows - 1);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns - 1);
    }
  });

  it("advances one row at a time and scrolls only at the viewport margin", () => {
    const sections = createTuiSections(groupedInventory());
    let model = reduceBrowse(
      createBrowseModel(sections, { rows: 14, columns: 90 }),
      { kind: "focus", pane: "entries" },
    );

    let previousScroll = model.entryScroll;
    for (let index = 0; index < 4; index += 1) {
      const next = reduceBrowse(model, { kind: "move", delta: 1 });
      expect(next.entryIndex - model.entryIndex).toBeLessThanOrEqual(1);
      expect(next.entryScroll).toBeGreaterThanOrEqual(previousScroll);
      previousScroll = next.entryScroll;
      model = next;
    }
  });

  it("renders the same focused row after equivalent keyboard and click movement", () => {
    const inventory = groupedInventory();
    const sections = createTuiSections(inventory);
    const initial = createBrowseModel(sections, viewport);
    const keyboard = reduceBrowse(
      reduceBrowse(initial, { kind: "focus", pane: "entries" }),
      { kind: "move", delta: 1 },
    );
    const clicked = reduceBrowse(initial, { kind: "point-entry", index: 1 });

    expect(clicked.focus).toBe("entries");
    expect(clicked.entryIndex).toBe(1);
    expect(renderTui({ screen: "browse", inventory, model: clicked })).toBe(
      renderTui({ screen: "browse", inventory, model: keyboard }),
    );
    expect(
      renderTui({ screen: "browse", inventory, model: clicked }),
    ).toContain("48;2;72;78;91");

    const doubleClicked = reduceBrowse(initial, {
      kind: "point-toggle",
      pane: "entries",
      index: 1,
    });
    expect(doubleClicked.focus).toBe("entries");
    expect(doubleClicked.entryIndex).toBe(1);
    expect(doubleClicked.selected).toContain(sections[0]!.entries[1]!.key);
  });

  it("takes a whole section from the section pane and refuses a protected one", () => {
    const sections = createTuiSections(groupedInventory());
    const model = createBrowseModel(sections, viewport);

    const taken = reduceBrowse(model, { kind: "toggle-select" });
    expect(taken.selected.size).toBe(sections[0]!.entries.length);
    expect(reduceBrowse(taken, { kind: "toggle-select" }).selected.size).toBe(
      0,
    );

    const refused = reduceBrowse(
      createBrowseModel(
        createTuiSections(
          buildInventory({
            installations: [],
            otherFindings: [buildSystemSkillFinding()],
          }),
        ),
        viewport,
      ),
      { kind: "toggle-select" },
    );
    expect(refused.selected.size).toBe(0);
    expect(refused.notice).toContain("cannot be removed");
  });

  it("matches names as a subsequence and ignores descriptions", () => {
    const sections = createTuiSections(groupedInventory());
    const section = sections[0]!;

    expect(matches(section.entries[0]!, section, "apa")).toBe(true);
    expect(matches(section.entries[0]!, section, "zzz")).toBe(false);
    expect(matches(section.entries[0]!, section, "description")).toBe(false);
    expect(matches(section.entries[0]!, section, "acme")).toBe(true);
  });

  it("plans the selection, collapsing a whole bundle into its Group", async () => {
    const inventory = groupedInventory();
    const planned: RemovalPlan["targets"][] = [];
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan: (current, intent) => {
          const removalPlan = plan(current, intent);
          planned.push(removalPlan.targets);
          return removalPlan;
        },
        execute: async () => buildExecutionReport(),
      },
      viewport,
    );

    await controller.start();
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "select" });

    expect(planned[0]).toEqual([
      { kind: "source-group", groupId: "installation-group-1" },
    ]);
  });

  it("retains terminal resizes received during plan and report screens", async () => {
    const inventory = groupedInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      viewport,
    );

    await controller.start();
    await controller.dispatch({ kind: "select" });
    expect(controller.state.screen).toBe("plan");

    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 18, columns: 76 },
    });
    if (controller.state.screen !== "plan") throw new Error("expected plan");
    expect(controller.state.browse.model.viewport).toEqual({
      rows: 18,
      columns: 76,
    });

    await controller.dispatch({ kind: "cancel" });
    const returned = controller.state as TuiState;
    if (returned.screen !== "browse") throw new Error("expected browse");
    expect(returned.model.viewport).toEqual({ rows: 18, columns: 76 });

    const reportController = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      viewport,
    );
    await reportController.start();
    await reportController.dispatch({ kind: "select" });
    await reportController.dispatch({ kind: "confirm" });
    expect(reportController.state.screen).toBe("report");
    await reportController.dispatch({
      kind: "viewport",
      viewport: { rows: 20, columns: 84 },
    });
    const resizedReport = reportController.state as TuiState;
    if (resizedReport.screen !== "report") throw new Error("expected report");
    expect(resizedReport.browse.model.viewport).toEqual({
      rows: 20,
      columns: 84,
    });
  });
});

describe("global name-regex search", () => {
  it("matches names only, shows all Skills when blank, and refuses empty-matching expressions", () => {
    const inventory = groupedInventory(["camel", "alpha"]);
    const browse = createBrowseModel(createTuiSections(inventory), {
      rows: 24,
      columns: 100,
    });
    const typed = reduceSearch(createSearchModel(browse), browse.sections, {
      kind: "type",
      value: "^c.*",
    });
    expect(typed.results.map((result) => result.entry.name)).toEqual(["camel"]);
    const blank = reduceSearch(typed, browse.sections, { kind: "clear" });
    expect(blank.matchError).toBeNull();
    expect(blank.results.map((result) => result.entry.name)).toEqual([
      "alpha",
      "camel",
    ]);
    const refused = reduceSearch(blank, browse.sections, {
      kind: "type",
      value: "^c*",
    });
    expect(refused.matchError).toContain("matches empty text");
    expect(refused.results).toEqual([]);
    const malformed = reduceSearch(blank, browse.sections, {
      kind: "type",
      value: "[",
    });
    expect(malformed.matchError).toContain("Invalid regular expression");
  });

  it("adds staged matches only on done and leaves System Skills visible but protected", async () => {
    const regular = groupedInventory(["alpha"]);
    const system = buildSystemSkillFinding({
      skill: { name: "system-alpha", description: "runtime" },
    });
    const inventory = buildInventory({
      installations: regular.installations,
      logicalSkills: regular.logicalSkills,
      groups: regular.groups,
      otherFindings: [system],
    });
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 24, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "open-search", value: "alpha" });
    const opened = controller.state;
    if (opened.screen !== "search") throw new Error("expected search");
    expect(opened.model.results).toHaveLength(2);
    await controller.dispatch({ kind: "stage-all-search" });
    const staged = controller.state;
    if (staged.screen !== "search") throw new Error("expected search");
    expect(staged.model.staged.size).toBe(1);
    await controller.dispatch({ kind: "cancel" });
    const cancelled = controller.state;
    if (cancelled.screen !== "browse") throw new Error("expected browse");
    expect(cancelled.model.selected.size).toBe(0);
    await controller.dispatch({ kind: "open-search", value: "alpha" });
    await controller.dispatch({ kind: "stage-all-search" });
    await controller.dispatch({ kind: "apply-search" });
    const applied = controller.state;
    if (applied.screen !== "browse") throw new Error("expected browse");
    expect(applied.model.selected.size).toBe(1);
  });

  it("keeps existing selection out of staging and toggles the visible new matches", () => {
    const inventory = groupedInventory(["alpha", "beta"]);
    const browse = createBrowseModel(createTuiSections(inventory), {
      rows: 24,
      columns: 100,
    });
    const selected = { ...browse, selected: new Set(["skill:logical-0"]) };
    const search = reduceSearch(
      createSearchModel(selected),
      selected.sections,
      {
        kind: "stage-all",
      },
    );
    expect(
      search.results.find((result) => result.entry.name === "alpha")?.existing,
    ).toBe(true);
    expect(search.staged).toEqual(new Set(["skill:logical-1"]));
    expect(
      reduceSearch(search, selected.sections, { kind: "stage-all" }).staged,
    ).toEqual(new Set());
  });

  it("returns from blank search without moving the prior browse position", async () => {
    const regular = groupedInventory(["alpha"]);
    const inventory = buildInventory({
      installations: regular.installations,
      logicalSkills: regular.logicalSkills,
      groups: regular.groups,
      otherFindings: [buildSystemSkillFinding()],
    });
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 24, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "move", delta: 1 });
    const before = controller.state;
    if (before.screen !== "browse") throw new Error("expected browse");
    await controller.dispatch({ kind: "open-search" });
    await controller.dispatch({ kind: "apply-search" });
    const returned = controller.state;
    if (returned.screen !== "browse") throw new Error("expected browse");
    expect(returned.model).toEqual(before.model);
  });

  it("resizes both saved browse and search viewports, then restores the resized browse", async () => {
    const inventory = groupedInventory(["alpha", "beta"]);
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 24, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "open-search", value: "alpha" });
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 12, columns: 40 },
    });
    const resized = controller.state;
    if (resized.screen !== "search") throw new Error("expected search");
    expect(resized.model.viewport).toEqual({ rows: 12, columns: 40 });
    expect(resized.browse.model.viewport).toEqual({ rows: 12, columns: 40 });
    const frame = renderTui(resized, plainTuiTheme).split("\n");
    expect(frame.length).toBeLessThanOrEqual(11);
    expect(frame.every((line) => line.length <= 39)).toBe(true);
    await controller.dispatch({ kind: "apply-search" });
    const returned = controller.state;
    if (returned.screen !== "browse") throw new Error("expected browse");
    expect(returned.model.viewport).toEqual({ rows: 12, columns: 40 });
  });

  it("renders a wrapped preview and ignores preview-pane clicks", () => {
    const inventory = groupedInventory(["alpha"]);
    const browse = {
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 16,
        columns: 48,
      }),
    };
    const state: TuiState = {
      screen: "search",
      browse,
      model: reduceSearch(
        createSearchModel(browse.model),
        browse.model.sections,
        {
          kind: "type",
          value: "alpha",
        },
      ),
    };
    const rendered = renderTui(state, plainTuiTheme);
    const lines = rendered.split("\n");
    expect(lines[0]).toContain("skill-cleaner search");
    expect(lines[1]).toContain("↑↓ move");
    expect(lines[1]).toContain("ctrl-a");
    expect(lines[2]!.trimEnd()).toMatch(/^┌─+┐$/u);
    expect(lines[3]!.trimEnd()).toMatch(/^│> alpha +│$/u);
    expect(lines[4]!.trimEnd()).toMatch(/^├─+┬─+┤$/u);
    expect(lines.at(-2)!.trimEnd()).toMatch(/^└─+┴─+┘$/u);
    expect(lines.at(-1)).toContain("matching 1 Skill");
    expect(rendered).toContain("Category: acme/toolkit");
    expect(rendered).toContain("Path:");
    const click = { button: 0, row: 6, pressed: true };
    const pointer = { dragging: false as const, doubleClick: false };
    expect(mouseAction(state, { ...click, column: 40 }, pointer)).toEqual({
      kind: "noop",
    });
    expect(mouseAction(state, { ...click, column: 4 }, pointer)).toEqual({
      kind: "point-search-result",
      index: 0,
    });
    const raw = (name: string, text = "", ctrl = false) =>
      parseRawTuiAction(state, text, {
        name,
        ctrl,
        meta: false,
        shift: false,
        sequence: text,
      } as Parameters<typeof parseRawTuiAction>[2]);
    const browseState: TuiState = { screen: "browse", ...browse };
    const browseRaw = (name: string, text = "") =>
      parseRawTuiAction(browseState, text, {
        name,
        ctrl: false,
        meta: false,
        shift: false,
        sequence: text,
      } as Parameters<typeof parseRawTuiAction>[2]);
    expect(browseRaw("/", "/")).toEqual({ kind: "open-search" });
    expect(browseRaw("x", "x")).toEqual({ kind: "append-query", value: "x" });
    expect(raw("q", "q")).toEqual({ kind: "append-query", value: "q" });
    expect(raw("return")).toEqual({ kind: "apply-search" });
    expect(raw("escape")).toEqual({ kind: "cancel" });
    expect(raw("a", "", true)).toEqual({ kind: "stage-all-search" });
    expect(raw("u", "", true)).toEqual({ kind: "clear-selection" });
    expect(raw("c", "", true)).toEqual({ kind: "quit" });
    expect(parseLineTuiAction(state, "all")).toEqual({
      kind: "stage-all-search",
    });
    expect(parseLineTuiAction(state, "done")).toEqual({ kind: "apply-search" });
    expect(parseLineTuiAction(state, "cancel")).toEqual({ kind: "cancel" });
    const compact: TuiState = {
      ...state,
      model: { ...state.model, viewport: { rows: 5, columns: 10 } },
    };
    expect(
      renderTui(compact, plainTuiTheme)
        .split("\n")
        .every((line) => line.length <= 9),
    ).toBe(true);
    expect(mouseAction(compact, { ...click, column: 2 }, pointer)).toEqual({
      kind: "noop",
    });
  });

  it("makes the prompt clear in color and plain themes, including at narrow widths", () => {
    const inventory = groupedInventory(["alpha"]);
    const browse = {
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 12,
        columns: 40,
      }),
    };
    const blank: TuiState = {
      screen: "search",
      browse,
      model: createSearchModel(browse.model),
    };
    const theme = createNightfallTheme("truecolor");
    const colored = renderTui(blank, theme);
    const plain = renderTui(blank, plainTuiTheme);
    expect(colored.replace(ansi, "")).toBe(plain);
    expect(colored).toContain(styleTui(theme, "muted", "type a name regex"));
    expect(plain.split("\n")[3]!.trimEnd()).toMatch(
      /^│> type a name regex +│$/u,
    );
    expect(plain.split("\n").at(-1)).toContain("matching 1 Skill");
    const grid = searchLayout(blank.model.viewport);
    for (const frame of [plain, colored].map((rendered) =>
      rendered.replace(ansi, "").split("\n").slice(2, -1),
    )) {
      expect(frame.every((line) => [...line].length === grid.usable)).toBe(
        true,
      );
      for (const row of frame.slice(3, -1)) {
        expect(row[grid.leftWidth + 1]).toBe("│");
        expect(row.at(-1)).toBe("│");
      }
    }
    const wide = renderTui(
      {
        ...blank,
        model: { ...blank.model, viewport: { rows: 12, columns: 100 } },
      },
      plainTuiTheme,
    );
    expect(wide.split("\n")[1]).toContain("ctrl-a");
    expect(wide.split("\n")[1]).toContain("ctrl-u");
    expect(wide.split("\n")[1]).toContain("ctrl-c");
    const invalid = renderTui(
      {
        ...blank,
        model: reduceSearch(blank.model, browse.model.sections, {
          kind: "type",
          value: "[",
        }),
      },
      plainTuiTheme,
    );
    expect(invalid.split("\n").at(-1)).toContain("Invalid regular expression");

    const pluralInventory = groupedInventory(["alpha", "beta"]);
    const pluralBrowse = createBrowseModel(createTuiSections(pluralInventory), {
      rows: 12,
      columns: 40,
    });
    expect(
      renderTui(
        {
          screen: "search",
          browse: { inventory: pluralInventory, model: pluralBrowse },
          model: createSearchModel(pluralBrowse),
        },
        plainTuiTheme,
      )
        .split("\n")
        .at(-1),
    ).toContain("matching 2 Skills");

    const typed: TuiState = {
      ...blank,
      model: reduceSearch(blank.model, browse.model.sections, {
        kind: "type",
        value: "alpha",
      }),
    };
    expect(renderTui(typed, theme)).toContain(
      styleTui(theme, "active", "alpha"),
    );
    const narrow = renderTui(
      {
        ...typed,
        model: {
          ...typed.model,
          viewport: { rows: 12, columns: 20 },
        },
      },
      plainTuiTheme,
    ).split("\n");
    expect(narrow[3]!.trimEnd()).toMatch(/^│> alpha +│$/u);
    expect(narrow.every((line) => line.length <= 19)).toBe(true);
  });

  it("keeps search paging and pointer rows aligned after a resize", () => {
    const inventory = groupedInventory(["alpha", "beta", "camel", "delta"]);
    const browse = {
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 16,
        columns: 48,
      }),
    };
    const state: TuiState = {
      screen: "search",
      browse,
      model: createSearchModel(browse.model),
    };
    expect(searchLayout(state.model.viewport)).toMatchObject({
      compact: false,
      resultStartRow: 6,
      resultRows: 8,
    });
    expect(searchRows(state.model.viewport)).toBe(8);
    const resized: TuiState = {
      ...state,
      model: reduceSearch(state.model, browse.model.sections, {
        kind: "viewport",
        viewport: { rows: 11, columns: 48 },
      }),
    };
    expect(searchLayout(resized.model.viewport)).toMatchObject({
      compact: false,
      resultStartRow: 6,
      resultRows: 3,
    });
    expect(searchRows(resized.model.viewport)).toBe(3);
    expect(
      mouseAction(
        resized,
        {
          button: 0,
          column: 4,
          row: searchLayout(resized.model.viewport).resultStartRow + 2,
          pressed: true,
        },
        { dragging: false, doubleClick: false },
      ),
    ).toEqual({ kind: "point-search-result", index: 2 });
  });
});

describe("terminal removal interactions", () => {
  it("presents a ready recoverable plan in plain language", async () => {
    const inventory = buildInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 30, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "select" });
    const rendered = renderTui(controller.state, plainTuiTheme);

    expect(rendered).toContain("Remove example-skill?");
    expect(rendered).toContain("READY TO REMOVE");
    expect(rendered).toContain("What will happen");
    expect(rendered).toContain("Move example-skill to the recovery area");
    expect(rendered).toContain("You can restore it later.");
    expect(rendered).toContain("Files are not permanently deleted.");
    expect(rendered).not.toContain("failed managed removal");
    expect(rendered).not.toContain("removal-plan-");
    expect(rendered).not.toContain("action-");
    expect(rendered).not.toContain("Blocks (0)");
    expect(rendered).not.toContain("ordinary confirmation");
  });

  it("summarizes repeated actions and checks for a large selected Group", async () => {
    const names = Array.from(
      { length: 22 },
      (_, index) => `skill-${String(index + 1)}`,
    );
    const inventory = groupedInventory(names);
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 80, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "select" });

    const summary = renderTui(controller.state, plainTuiTheme);
    expect(summary).toContain(
      "Ask fixture-manager to remove 22 selected capabilities",
    );
    expect(summary).toContain(
      "All 22 selected capabilities are no longer available to agents",
    );
    expect(summary.match(/Ask fixture-manager to remove/gu)).toHaveLength(1);

    await controller.dispatch({ kind: "toggle-details" });
    const details = renderTui(controller.state, plainTuiTheme);
    expect(details).toContain("Actions (22)");
    expect(details).toContain("Verification (1)");
  });

  it("summarizes repeated location checks for a recoverable Group removal", async () => {
    const names = Array.from(
      { length: 22 },
      (_, index) => `skill-${String(index + 1)}`,
    );
    const inventory = groupedInventory(names);
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan: (current, intent) =>
          plan(current, { ...intent, mode: "brute-force" }),
        execute: async () => buildExecutionReport(),
      },
      { rows: 80, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "select" });

    const summary = renderTui(controller.state, plainTuiTheme);
    expect(summary).toContain(
      "Move 22 selected capabilities to the recovery area",
    );
    expect(summary).toContain("All 22 original locations are no longer active");
    expect(summary.match(/original locations?/gu)).toHaveLength(2);

    await controller.dispatch({ kind: "toggle-details" });
    const details = renderTui(controller.state, plainTuiTheme);
    expect(details).toContain("Actions (22)");
    expect(details).toContain("Verification (23)");
  });

  it("explains an executable download warning before the actions", async () => {
    const inventory = buildInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan: (current, intent) => ({
          ...plan(current, intent),
          warnings: [
            {
              kind: "ephemeral-download" as const,
              target: {
                kind: "installation" as const,
                installationId: inventory.installations[0]!.id,
              },
              packageExecution: {
                runner: "npx" as const,
                packageName: "fixture-manager",
                packageVersion: "1.2.3",
                adapterHash: "sha256:fixture",
                mayDownload: true as const,
              },
            },
          ],
        }),
        execute: async () => buildExecutionReport(),
      },
      { rows: 30, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "select" });
    const rendered = renderTui(controller.state, plainTuiTheme);

    expect(rendered).toContain("REVIEW BEFORE REMOVING");
    expect(rendered).toContain("May download fixture-manager@1.2.3 using npx");
    expect(rendered).toContain("Adapter identity: sha256:fixture");
    expect(rendered).toContain("Review this warning");
    expect(rendered).not.toContain("ephemeral-download");
  });

  it("reveals exact plan records only when technical details are requested", async () => {
    const inventory = buildInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 50, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "select" });
    const summary = renderTui(controller.state, plainTuiTheme);

    await controller.dispatch({ kind: "toggle-details" });
    const details = renderTui(controller.state, plainTuiTheme);

    expect(summary).not.toContain("removal-plan-");
    expect(details).toContain("Technical details");
    expect(details).toContain("Plan: removal-plan-");
    expect(details).toContain("Installation installation-1");
    expect(details).toContain("ordinary confirmation");
    expect(details).toContain("d hide technical details");
  });

  it("scrolls an overflowing plan inside the terminal with controls pinned", async () => {
    const inventory = buildInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 14, columns: 60 },
    );
    await controller.start();
    await controller.dispatch({ kind: "select" });
    await controller.dispatch({ kind: "toggle-details" });
    const first = renderTui(controller.state, plainTuiTheme);

    await controller.dispatch({ kind: "page", delta: 1 });
    await controller.dispatch({ kind: "page", delta: 1 });
    const second = renderTui(controller.state, plainTuiTheme);

    expect(first.split("\n").length - 1).toBeLessThanOrEqual(13);
    expect(second.split("\n").length - 1).toBeLessThanOrEqual(13);
    expect(first).toContain("review 1-");
    expect(second).toContain("Technical details");
    expect(second).toContain("y remove");
    expect(second).not.toBe(first);
  });

  it("uses a compact plan prompt when the terminal is too small", async () => {
    const inventory = buildInventory();
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 4, columns: 20 },
    );
    await controller.start();
    await controller.dispatch({ kind: "select" });

    const rendered = renderTui(controller.state, plainTuiTheme);
    expect(rendered.split("\n").length - 1).toBeLessThanOrEqual(3);
    expect(rendered).toContain("Resize the terminal");
    expect(rendered).toContain("q quit");
    expect(rendered).not.toContain("review 1-0");
  });

  it("keeps the end of a long affected path reachable on a narrow terminal", async () => {
    const path =
      "/fixtures/a-very-long-skill-location/with/several/directories/important-tail";
    const inventory = buildInventory({
      installations: [
        buildInstallation({
          location: {
            path,
            canonicalPath: path,
            artifactType: { kind: "directory" },
          },
        }),
      ],
    });
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: async () => buildExecutionReport(),
      },
      { rows: 14, columns: 42 },
    );
    await controller.start();
    await controller.dispatch({ kind: "select" });

    const pages: string[] = [];
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      pages.push(renderTui(controller.state, plainTuiTheme));
      await controller.dispatch({ kind: "page", delta: 1 });
    }
    expect(pages.join("\n")).toContain("important-tail");
  });

  it("renders blocked plans and cannot execute them", async () => {
    const inventory = buildInventory({
      installations: [
        buildInstallation({
          protection: {
            git: { kind: "protected", worktreeRoot: "/fixtures/project" },
            system: { kind: "none" },
            filesystem: { kind: "writable" },
          },
        }),
      ],
    });
    const execute = vi.fn();
    const terminal = new ScriptedTerminal([
      { kind: "select" },
      { kind: "confirm" },
      { kind: "quit" },
    ]);

    const outcome = await runTui(
      { scan: async () => inventory, plan, execute },
      terminal,
    );

    expect(outcome.status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
    const frames = terminal.frames.join("\n");
    expect(frames).toContain("CANNOT REMOVE");
    expect(frames).toContain("Protected project file");
    expect(frames).toContain("/fixtures/skills/example-skill");
    expect(frames).toContain("This protection cannot be bypassed");
    expect(frames.replace(ansi, "")).toContain("d technical details");
    expect(frames).not.toContain("git-protection");
  });

  it("does not mutate on cancellation and executes only after plan confirmation", async () => {
    const inventory = buildInventory();
    const cancelledExecute = vi.fn();
    const cancelledTerminal = new ScriptedTerminal([
      { kind: "select" },
      { kind: "cancel" },
      { kind: "quit" },
    ]);
    await runTui(
      { scan: async () => inventory, plan, execute: cancelledExecute },
      cancelledTerminal,
    );
    expect(cancelledExecute).not.toHaveBeenCalled();

    const calls: {
      readonly plan: RemovalPlan;
      readonly approvals: readonly ApprovalRequirement[];
    }[] = [];
    const execute = vi.fn(
      async (
        removalPlan: RemovalPlan,
        approvals: readonly ApprovalRequirement[],
      ) => {
        calls.push({ plan: removalPlan, approvals });
        return buildExecutionReport({
          planId: removalPlan.id,
          inventoryId: removalPlan.inventoryId,
          finalInventoryId: removalPlan.inventoryId,
        });
      },
    );
    const confirmedTerminal = new ScriptedTerminal([
      { kind: "select" },
      { kind: "confirm" },
      { kind: "quit" },
    ]);
    const outcome = await runTui(
      { scan: async () => inventory, plan, execute },
      confirmedTerminal,
    );

    expect(outcome.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.approvals).toContainEqual({ kind: "confirmation" });
    expect(confirmedTerminal.frames.join("\n")).toContain(
      "Nothing has changed yet",
    );
    expect(confirmedTerminal.frames.join("\n")).toContain(
      "Execution succeeded",
    );
  });

  it("requires a separate review and confirmation for a managed-removal fallback", async () => {
    const inventory = buildInventory({
      installations: [managedInstallation()],
    });
    const calls: {
      readonly plan: RemovalPlan;
      readonly approvals: readonly ApprovalRequirement[];
    }[] = [];
    const execute = vi.fn(
      async (
        removalPlan: RemovalPlan,
        approvals: readonly ApprovalRequirement[],
      ): Promise<ExecutionReport> => {
        calls.push({ plan: removalPlan, approvals });
        if (calls.length === 1) {
          const fallback = plan(inventory, {
            kind: "targets",
            targets: removalPlan.targets,
            force: false,
            mode: "brute-force",
          });
          return buildExecutionReport({
            planId: removalPlan.id,
            inventoryId: removalPlan.inventoryId,
            finalInventoryId: removalPlan.inventoryId,
            status: "failed",
            actionResults: removalPlan.actions.map((action) => ({
              actionId: action.id,
              startedAt: "2026-01-01T00:02:00.000Z",
              completedAt: "2026-01-01T00:02:01.000Z",
              status: "failed" as const,
              error: {
                code: "manager-failed",
                message: "manager command failed",
                details: {},
              },
            })),
            targetResults: removalPlan.targets.map((target) => ({
              target,
              status: "failed" as const,
              actionIds: removalPlan.actions.map((action) => action.id),
              reason: "managed removal failed",
            })),
            fallbackPlans: [fallback],
          });
        }
        return buildExecutionReport({
          planId: removalPlan.id,
          inventoryId: removalPlan.inventoryId,
          finalInventoryId: removalPlan.inventoryId,
        });
      },
    );
    const terminal = new ScriptedTerminal([
      { kind: "select" },
      { kind: "confirm" },
      { kind: "fallback" },
      { kind: "confirm" },
      { kind: "quit" },
    ]);

    const outcome = await runTui(
      { scan: async () => inventory, plan, execute },
      terminal,
    );

    expect(outcome.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.plan.intent.mode).toBe("managed-first");
    expect(calls[1]?.plan.intent.mode).toBe("brute-force");
    expect(calls[1]?.approvals).toContainEqual({
      kind: "brute-force-confirmation",
    });
    const frames = terminal.frames.join("\n");
    expect(frames).toContain("Fallback plans are never executed automatically");
    expect(frames).toContain("Remove example-skill?");
    expect(frames).toContain(
      "This is a separate recoverable removal after the managed attempt failed",
    );
    expect(frames).not.toContain("Remove Brute-force fallback");
  });

  it("supports command-oriented input when raw terminal controls are unavailable", () => {
    const inventory = buildInventory();
    const browse: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };

    expect(parseLineTuiAction(browse, "search alpha")).toEqual({
      kind: "append-query",
      value: "alpha",
    });
    expect(parseLineTuiAction(browse, "take")).toEqual({
      kind: "toggle-select",
    });
    expect(parseLineTuiAction(browse, "in")).toEqual({
      kind: "focus",
      pane: "entries",
    });
    expect(parseLineTuiAction(browse, "detail")).toEqual({
      kind: "focus",
      pane: "detail",
    });
    expect(parseLineTuiAction(browse, "pageup")).toEqual({
      kind: "page",
      delta: -1,
    });
    expect(parseLineTuiAction(browse, "grow-detail")).toEqual({
      kind: "resize-detail",
      delta: 1,
    });
    const removalPlan: TuiState = {
      screen: "plan",
      browse,
      plan: plan(inventory, {
        kind: "targets",
        targets: [
          {
            kind: "installation",
            installationId: inventory.installations[0]!.id,
          },
        ],
        force: false,
        mode: "managed-first",
      }),
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
      returnReport: null,
    };
    expect(parseLineTuiAction(removalPlan, "yes")).toEqual({
      kind: "confirm",
    });
    expect(parseLineTuiAction(removalPlan, "details")).toEqual({
      kind: "toggle-details",
    });
    expect(parseLineTuiAction(removalPlan, "pagedown")).toEqual({
      kind: "page",
      delta: 1,
    });
  });
});

describe("terminal pointer input", () => {
  const inventory = groupedInventory();
  const browse: TuiState = {
    screen: "browse",
    inventory,
    model: createBrowseModel(createTuiSections(inventory), {
      rows: 24,
      columns: 100,
    }),
  };
  const idle = { dragging: false, doubleClick: false } as const;
  const press = (column: number, row: number, button = 0) => ({
    button,
    column,
    row,
    pressed: true,
  });

  it("parses an SGR report and ignores anything else", () => {
    expect(parseMouseReport(`${String.fromCharCode(27)}[<0;12;7M`)).toEqual({
      button: 0,
      column: 12,
      row: 7,
      pressed: true,
    });
    expect(
      parseMouseReport(`${String.fromCharCode(27)}[<0;12;7m`)?.pressed,
    ).toBe(false);
    expect(parseMouseReport(`${String.fromCharCode(27)}[A`)).toBeNull();
  });

  it("scrolls a removal review with the wheel without changing it", () => {
    const simpleInventory = buildInventory();
    const planState: TuiState = {
      screen: "plan",
      browse: {
        inventory: simpleInventory,
        model: createBrowseModel(createTuiSections(simpleInventory), {
          rows: 24,
          columns: 100,
        }),
      },
      plan: plan(simpleInventory, {
        kind: "targets",
        targets: [
          {
            kind: "installation",
            installationId: simpleInventory.installations[0]!.id,
          },
        ],
        force: false,
        mode: "managed-first",
      }),
      label: "example-skill",
      technicalDetails: true,
      scrollOffset: 0,
      returnReport: null,
    };

    expect(mouseAction(planState, press(4, 8, 65), idle)).toEqual({
      kind: "move",
      delta: 1,
    });
  });

  it("maps a click to the row beneath it in either pane", () => {
    const { leftWidth } = layout(browse.model);
    expect(mouseAction(browse, press(4, 5), idle)).toEqual({
      kind: "point-section",
      index: 0,
    });
    expect(mouseAction(browse, press(leftWidth + 8, 7), idle)).toEqual({
      kind: "point-entry",
      index: 1,
    });
  });

  it("selects on a double click rather than a single one", () => {
    expect(
      mouseAction(browse, press(4, 5), { dragging: false, doubleClick: true }),
    ).toEqual({ kind: "point-toggle", pane: "sections", index: 0 });
  });

  it("moves the pane under the wheel and ignores non-pane wheel input", () => {
    const { leftWidth } = layout(browse.model);
    expect(mouseAction(browse, press(4, 6, 64), idle)).toEqual({
      kind: "move-pane",
      pane: "sections",
      delta: -1,
    });
    expect(mouseAction(browse, press(leftWidth + 8, 6, 65), idle)).toEqual({
      kind: "move-pane",
      pane: "entries",
      delta: 1,
    });
    // Bit 2 is a modifier; the wheel still reports through bits 6 and 0.
    expect(mouseAction(browse, press(4, 6, 69), idle)).toEqual({
      kind: "move-pane",
      pane: "sections",
      delta: 1,
    });
    expect(mouseAction(browse, press(leftWidth + 1, 6, 65), idle)).toEqual({
      kind: "noop",
    });
    expect(mouseAction(browse, press(4, 23, 65), idle)).toEqual({
      kind: "noop",
    });
    const moved = reduceBrowse(browse.model, {
      kind: "move-pane",
      pane: "entries",
      delta: 1,
    });
    expect(moved.focus).toBe("entries");
    expect(moved.entryIndex).toBe(1);
    expect(moved.sectionIndex).toBe(browse.model.sectionIndex);
  });

  it("focuses and scrolls detail content and drags its horizontal divider", () => {
    const grid = layout(browse.model);
    const dividerRow = 5 + grid.paneRows;
    const detailRow = dividerRow + 1;

    expect(mouseAction(browse, press(4, detailRow), idle)).toEqual({
      kind: "focus",
      pane: "detail",
    });
    expect(mouseAction(browse, press(4, detailRow, 65), idle)).toEqual({
      kind: "move-pane",
      pane: "detail",
      delta: 1,
    });
    expect(mouseAction(browse, press(4, dividerRow), idle)).toEqual({
      kind: "set-detail-rows",
      rows: grid.detailRows,
    });
    expect(
      mouseAction(browse, press(4, dividerRow - 2, 32), {
        dragging: "detail",
        doubleClick: false,
      }),
    ).toEqual({ kind: "set-detail-rows", rows: grid.detailRows + 2 });
  });

  it("resizes from the divider and ignores motion that is not a drag", () => {
    const { leftWidth } = layout(browse.model);
    expect(mouseAction(browse, press(leftWidth + 1, 8), idle).kind).toBe(
      "set-left-percent",
    );
    expect(mouseAction(browse, press(30, 8, 32), idle)).toEqual({
      kind: "noop",
    });
    expect(
      mouseAction(browse, press(30, 8, 32), {
        dragging: "panes",
        doubleClick: false,
      }).kind,
    ).toBe("set-left-percent");
  });

  it("ignores clicks on chrome, the section header, and empty rows", () => {
    const { leftWidth } = layout(browse.model);
    expect(mouseAction(browse, press(4, 2), idle)).toEqual({ kind: "noop" });
    expect(mouseAction(browse, press(leftWidth + 8, 5), idle)).toEqual({
      kind: "noop",
    });
    expect(mouseAction(browse, press(4, 90), idle)).toEqual({ kind: "noop" });
    expect(mouseAction(browse, press(4, 5, 2), idle)).toEqual({ kind: "noop" });
  });
});

describe("raw terminal pointer input", () => {
  const ESC = String.fromCharCode(27);

  function fakeTty() {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: (value: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = () => undefined;
    const written: string[] = [];
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      rows: 24,
      columns: 100,
      write: (value: string) => {
        written.push(value);
        return true;
      },
    });
    return { input, output, written };
  }

  it("applies terminal color detection to raw rendering", () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const plainHost = fakeTty();
    const plainTerminal = createNodeTuiTerminal(
      plainHost.input as unknown as NodeJS.ReadStream,
      plainHost.output as unknown as NodeJS.WriteStream,
      { environment: { NO_COLOR: "", COLORTERM: "truecolor" } },
    );
    plainTerminal.render(state);
    expect(plainHost.written.at(-1)).not.toContain("[38;");
    expect(plainHost.written.at(-1)).not.toContain("[48;");
    plainTerminal.close();

    const colorHost = fakeTty();
    const colorTerminal = createNodeTuiTerminal(
      colorHost.input as unknown as NodeJS.ReadStream,
      colorHost.output as unknown as NodeJS.WriteStream,
      { environment: { COLORTERM: "truecolor" } },
    );
    colorTerminal.render(state);
    expect(colorHost.written.at(-1)).toContain("[38;2;");
    colorTerminal.close();
  });

  it("delivers terminal resizes immediately so the controller can repaint", async () => {
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    expect(output.listenerCount("resize")).toBe(1);

    const action = terminal.readAction({ screen: "loading" });
    output.rows = 16;
    output.columns = 72;
    output.emit("resize");

    await expect(
      Promise.race([
        action,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 30)),
      ]),
    ).resolves.toEqual({
      kind: "viewport",
      viewport: { rows: 16, columns: 72 },
    });
    terminal.close();
    expect(output.listenerCount("resize")).toBe(0);
  });

  it("uses q to quit from the inventory instead of adding it to the filter", async () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.write("q");
    await expect(terminal.readAction(state)).resolves.toEqual({ kind: "quit" });
    terminal.close();
  });

  it("cycles keyboard focus through the detail pane", async () => {
    const inventory = groupedInventory();
    const initial: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.write("\t");
    await expect(terminal.readAction(initial)).resolves.toEqual({
      kind: "focus",
      pane: "entries",
    });
    const entries: TuiState = {
      ...initial,
      model: reduceBrowse(initial.model, { kind: "focus", pane: "entries" }),
    };

    input.write("\t");
    await expect(terminal.readAction(entries)).resolves.toEqual({
      kind: "focus",
      pane: "detail",
    });
    const detail: TuiState = {
      ...initial,
      model: reduceBrowse(initial.model, { kind: "focus", pane: "detail" }),
    };

    input.write(`${ESC}[Z`);
    await expect(terminal.readAction(detail)).resolves.toEqual({
      kind: "focus",
      pane: "entries",
    });
    terminal.close();
  });

  it("toggles removal-plan details from the raw keyboard", async () => {
    const inventory = buildInventory();
    const browse = {
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const state: TuiState = {
      screen: "plan",
      browse,
      plan: plan(inventory, {
        kind: "targets",
        targets: [
          {
            kind: "installation",
            installationId: inventory.installations[0]!.id,
          },
        ],
        force: false,
        mode: "managed-first",
      }),
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
      returnReport: null,
    };
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.write("d");
    await expect(terminal.readAction(state)).resolves.toEqual({
      kind: "toggle-details",
    });
    input.write(`${ESC}[6~`);
    await expect(terminal.readAction(state)).resolves.toEqual({
      kind: "page",
      delta: 1,
    });
    terminal.close();
  });

  it("recognizes a double click only on the same pane row", async () => {
    const inventory = groupedInventory();
    const section = createTuiSections(inventory)[0]!;
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(
        [section, { ...section, key: "second-section", label: "Second" }],
        { rows: 24, columns: 100 },
      ),
    };
    const { leftWidth } = layout(state.model);
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.write(`${ESC}[<0;4;6M`);
    await expect(terminal.readAction(state)).resolves.toEqual({
      kind: "point-section",
      index: 1,
    });
    const sectionState: TuiState = {
      ...state,
      model: reduceBrowse(state.model, { kind: "point-section", index: 1 }),
    };

    input.write(`${ESC}[<0;${String(leftWidth + 8)};6M`);
    await expect(terminal.readAction(sectionState)).resolves.toEqual({
      kind: "point-entry",
      index: 0,
    });
    const entryState: TuiState = {
      ...sectionState,
      model: reduceBrowse(sectionState.model, {
        kind: "point-entry",
        index: 0,
      }),
    };

    input.write(`${ESC}[<0;${String(leftWidth + 8)};6M`);
    await expect(terminal.readAction(entryState)).resolves.toEqual({
      kind: "point-toggle",
      pane: "entries",
      index: 0,
    });
    terminal.close();
  });

  it("takes every report in one read, including a wheel burst", () => {
    expect(
      parseMouseReports(`${ESC}[<65;3;9M${ESC}[<65;3;10M`).map(
        (report) => report.row,
      ),
    ).toEqual([9, 10]);
    expect(parseMouseReports("no mouse here")).toEqual([]);
  });

  it("frames every report-data split after the SGR sentinel", () => {
    const report = `${ESC}[<0;4;5M`;
    // Before `ESC[<` is complete, input remains ordinary terminal input so
    // Esc/cancel cannot be held indefinitely. Every report-data boundary is
    // framed once the SGR sentinel identifies it as mouse input.
    for (let split = 3; split < report.length; split += 1) {
      const framer = new MouseReportFramer();
      expect(framer.push(report.slice(0, split))).toEqual([]);
      expect(framer.pending).toBe(true);
      expect(framer.push(report.slice(split))).toEqual([
        { button: 0, column: 4, row: 5, pressed: true },
      ]);
      expect(framer.pending).toBe(false);
    }
  });

  it("does not hold incomplete or malformed keyboard escape sequences", () => {
    const framer = new MouseReportFramer();
    expect(framer.push(ESC)).toEqual([]);
    expect(framer.pending).toBe(false);
    expect(framer.push(`${ESC}[A`)).toEqual([]);
    expect(framer.pending).toBe(false);
    expect(framer.push(`${ESC}[<x`)).toEqual([]);
    expect(framer.pending).toBe(false);
  });

  it("reads a report readline would shred, without typing its digits", async () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const { input, output, written } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    // Readline splits this into eight keypresses; none is a whole report.
    input.write(`${ESC}[<0;4;5M`);
    const action = await terminal.readAction(state);
    expect(action).toEqual({ kind: "point-section", index: 0 });

    // The digits must not have reached the filter as typed characters.
    const raced = await Promise.race([
      terminal.readAction(state),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 30)),
    ]);
    expect(raced).toBeNull();
    terminal.close();

    const codes = written.join("");
    expect(codes).toContain("[?1049h");
    expect(codes).toContain("[?1006h");
    expect(codes).toContain("[?1049l");
    expect(codes).toContain("[?1006l");
  });

  it("reads a report split after its SGR sentinel without typing fragments", async () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.write(`${ESC}[<`);
    input.write("0;4;5M");
    await expect(terminal.readAction(state)).resolves.toEqual({
      kind: "point-section",
      index: 0,
    });
    terminal.close();
  });

  it("releases a malformed held SGR prefix for ordinary keyboard input", async () => {
    const inventory = groupedInventory();
    const state: TuiState = {
      screen: "browse",
      inventory,
      model: createBrowseModel(createTuiSections(inventory), {
        rows: 24,
        columns: 100,
      }),
    };
    const { input, output } = fakeTty();
    const terminal = createNodeTuiTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.write(`${ESC}[<`);
    input.write("x");
    input.write("j");
    await expect(terminal.readAction(state)).resolves.toEqual({
      kind: "append-query",
      value: "x",
    });
    await expect(terminal.readAction(state)).resolves.toEqual({
      kind: "append-query",
      value: "j",
    });
    terminal.close();
  });
});
