import { describe, expect, it, vi } from "vitest";

import { plan, TuiController, renderTui } from "../src/index.js";
import { mouseAction, parseRawTuiAction } from "../src/tui/terminal.js";
import {
  buildInventory,
  buildSessionSetupPlan,
  buildSessionSetupReport,
  buildSessionSetupSnapshot,
} from "../src/testing/index.js";

function twoHarnessSnapshot() {
  const snapshot = buildSessionSetupSnapshot();
  const target = snapshot.targets[0]!;
  return {
    ...snapshot,
    harnesses: ["codex", "claude-code"] as const,
    targets: [
      target,
      {
        ...target,
        id: "claude-target",
        harnessId: "claude-code" as const,
        name: "claude-skill",
      },
    ],
    sources: [
      ...snapshot.sources,
      {
        ...snapshot.sources[0]!,
        source: { sourceId: "claude-source", path: null },
        harnessId: "claude-code" as const,
        targetIds: ["claude-target"],
        collateralTargetIds: ["claude-target"],
      },
    ],
  } as typeof snapshot;
}

describe("Session setup terminal area", () => {
  it("opens an explicit unavailable area when the host has no setup provider", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    expect(controller.state.screen).toBe("browse");
    expect(renderTui(controller.state)).toContain("Claude Code");
    expect(renderTui(controller.state)).toContain(
      "Session setup is unavailable",
    );
  });
  it("keeps setup browse state separate, reviews native disable, and refreshes its report", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const execute = vi.fn(async () => buildSessionSetupReport());
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => snapshot,
      planSessionSetup: () => buildSessionSetupPlan(),
      executeSessionSetup: execute,
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    expect(renderTui(controller.state)).toContain("Session setup");
    expect(renderTui(controller.state)).toContain("Codex");
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "disable-review" });
    expect(controller.state.screen).toBe("setup-plan");
    await controller.dispatch({ kind: "confirm" });
    await controller.waitForSetupExecution();
    expect(controller.state.screen).toBe("setup-report");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("cycles only setup views with Ctrl-T and switches the area with Ctrl-O", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => buildSessionSetupSnapshot(),
    });
    await controller.start();
    expect(
      parseRawTuiAction(controller.state, "", { ctrl: true, name: "o" }),
    ).toEqual({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    expect(
      parseRawTuiAction(controller.state, "", { ctrl: true, name: "t" }),
    ).toEqual({ kind: "switch-view", view: "disabled" });
  });

  it("renders and clicks both area labels", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => buildSessionSetupSnapshot(),
    });
    await controller.start();
    expect(renderTui(controller.state)).toContain("Skills & plugins");
    expect(
      mouseAction(
        controller.state,
        { button: 0, column: 34, row: 1, pressed: true },
        { dragging: false, doubleClick: false },
      ),
    ).toEqual({ kind: "switch-area", area: "setup" });
  });

  it("does not carry Codex selection into a first Claude visit", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => twoHarnessSnapshot(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "toggle-select" });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model.selected.size).toBe(1);
    await controller.dispatch({ kind: "focus", pane: "sections" });
    await controller.dispatch({ kind: "move", delta: 1 });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model.selected.size).toBe(0);
    await controller.dispatch({ kind: "move", delta: -1 });
    expect(controller.state.model.selected.size).toBe(1);
  });

  it("keeps search scoped to the active setup harness and stages additively", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => twoHarnessSnapshot(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "open-search" });
    await controller.dispatch({ kind: "append-query", value: "example" });
    await controller.dispatch({ kind: "append-query", value: "-skill" });
    expect(controller.state.screen).toBe("search");
    if (controller.state.screen !== "search") throw new Error();
    expect(
      controller.state.model.results.every(
        (result) => result.entry.exposedTo[0] === "codex",
      ),
    ).toBe(true);
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "apply-search" });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model.selected.size).toBe(1);
  });

  it("does not apply invalid or empty-match setup expressions", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => twoHarnessSnapshot(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "open-search" });
    await controller.dispatch({ kind: "append-query", value: "(" });
    if (controller.state.screen !== "search") throw new Error();
    expect(controller.state.model.matchError).not.toBeNull();
    await controller.dispatch({ kind: "apply-search" });
    expect(controller.state.screen).toBe("search");
  });

  it("restores independent harness and view browse models without setup Trash", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => twoHarnessSnapshot(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "resize-panes", delta: 9 });
    await controller.dispatch({ kind: "resize-detail", delta: 2 });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "toggle-select" });
    if (controller.state.screen !== "browse") throw new Error();
    const codex = controller.state.model;
    await controller.dispatch({ kind: "focus", pane: "sections" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "resize-panes", delta: -4 });
    if (controller.state.screen !== "browse") throw new Error();
    const claude = controller.state.model;
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    if (controller.state.screen !== "browse") throw new Error();
    const disabled = controller.state.model;
    expect(controller.state.view).not.toBe("trash");
    await controller.dispatch({ kind: "switch-view", view: "inventory" });
    await controller.dispatch({ kind: "focus", pane: "sections" });
    await controller.dispatch({ kind: "move", delta: -1 });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model.leftPercent).toBe(codex.leftPercent);
    expect(controller.state.model.selected).toEqual(codex.selected);
    await controller.dispatch({ kind: "move", delta: 1 });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model.leftPercent).toBe(claude.leftPercent);
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model.leftPercent).toBe(disabled.leftPercent);
  });

  it("selects only selectable setup rows with Ctrl-A and clears with Ctrl-U", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => buildSessionSetupSnapshot(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    if (controller.state.screen !== "browse") throw new Error();
    await controller.dispatch(
      parseRawTuiAction(controller.state, "", { ctrl: true, name: "a" }),
    );
    expect(
      [...controller.state.model.selected].every(
        (key) => key.startsWith("setup:") && !key.startsWith("setup-heading:"),
      ),
    ).toBe(true);
    expect(controller.state.model.selected.size).toBe(1);
    await controller.dispatch(
      parseRawTuiAction(controller.state, "", { ctrl: true, name: "u" }),
    );
    expect(controller.state.model.selected.size).toBe(0);
  });

  it("keeps all harnesses visible when setup scanning throws", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => {
        throw new Error("fixture failure");
      },
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    const output = renderTui(controller.state);
    expect(output).toContain("Codex");
    expect(output).toContain("Claude Code");
    expect(output).toContain("Gemini CLI");
    expect(output).toContain("sources are unavailable");
  });

  it("renders setup target details without claiming account or live state", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => buildSessionSetupSnapshot(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "select" });
    const output = renderTui(controller.state);
    expect(output).toContain("Source:");
    expect(output).toContain("Owner:");
    expect(output).toContain("Policy:");
    expect(output).toContain("Effective");
    expect(output).toContain("Account: unknown");
    expect(output).toContain("Live session: unknown");
  });
});
