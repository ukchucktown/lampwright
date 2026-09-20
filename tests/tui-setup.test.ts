import { describe, expect, it, vi } from "vitest";

import { plan, TuiController, renderTui } from "../src/index.js";
import { parseRawTuiAction } from "../src/tui/terminal.js";
import {
  buildInventory,
  buildSessionSetupPlan,
  buildSessionSetupReport,
  buildSessionSetupSnapshot,
} from "../src/testing/index.js";

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
});
