import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createBrowseModel,
  createTuiSections,
  layout,
  matches,
  createNodeTuiTerminal,
  mouseAction,
  parseLineTuiAction,
  parseMouseReport,
  parseMouseReports,
  reduceBrowse,
  renderBrowseLines,
  selectionTargets,
  plan,
  renderTui,
  runTui,
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
import { MouseReportFramer } from "../src/tui/terminal.js";
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

function groupedInventory(): Inventory {
  const members = ["alpha", "beta"].map((name) =>
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

describe("terminal removal interactions", () => {
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
    expect(terminal.frames.join("\n")).toContain("git-protection");
    expect(terminal.frames.join("\n")).toContain("cannot execute");
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
      "Nothing has been changed",
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
    expect(frames).toContain("Separate fallback plan");
    expect(frames).toContain("quarantines files");
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
    expect(
      parseLineTuiAction(
        {
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
          returnReport: null,
        },
        "yes",
      ),
    ).toEqual({ kind: "confirm" });
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
  const idle = { dragging: false, doubleClick: false };
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
    ).toEqual({ kind: "toggle-select" });
  });

  it("moves one row per wheel report, whichever way and with modifiers", () => {
    expect(mouseAction(browse, press(4, 6, 64), idle)).toEqual({
      kind: "move",
      delta: -1,
    });
    expect(mouseAction(browse, press(4, 6, 65), idle)).toEqual({
      kind: "move",
      delta: 1,
    });
    // Bit 2 is a modifier; the wheel still reports through bits 6 and 0.
    expect(mouseAction(browse, press(4, 6, 69), idle)).toEqual({
      kind: "move",
      delta: 1,
    });
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
        dragging: true,
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
