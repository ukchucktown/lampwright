import { describe, expect, it, vi } from "vitest";

import {
  plan,
  planSessionSetup,
  TuiController,
  renderTui,
} from "../src/index.js";
import type { DisabledEntry } from "../src/disabled-storage/types.js";
import type { TuiState } from "../src/tui/types.js";
import {
  mouseAction,
  parseLineTuiAction,
  parseRawTuiAction,
} from "../src/tui/terminal.js";
import { createSetupSections } from "../src/tui/setup.js";
import {
  buildInventory,
  buildSessionSetupIntent,
  buildInstallation,
  buildSessionSetupPlan,
  buildSessionSetupReport,
  buildSessionSetupSnapshot,
  buildSessionSetupTarget,
} from "../src/testing/index.js";

function codexSuspendedEntry(): DisabledEntry {
  const installation = buildInstallation({
    id: "suspended-installation",
    exposedTo: ["codex"],
    harnessExposures: [
      {
        harnessId: "codex",
        status: "disabled",
        control: { kind: "unsupported", reason: "fixture" },
      },
    ],
  });
  return {
    schemaVersion: 1,
    id: "suspended-entry" as DisabledEntry["id"],
    suspendedAt: "2026-08-21T12:00:00.000Z",
    originalLocation: installation.location,
    integrity: { algorithm: "sha256", digest: "c".repeat(64) },
    skillIdentity: installation.identity,
    installationIds: [installation.id],
    ownership: installation.ownership,
    harnessExposures: installation.harnessExposures,
    operation: { id: "suspended", displayNames: ["Suspended Skill"] },
    restoration: { mode: null, modifiedAt: null },
  };
}

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

function mixedStateSnapshot() {
  const snapshot = buildSessionSetupSnapshot();
  const enabled = snapshot.targets[0]!;
  const disabled = {
    ...enabled,
    id: "disabled-setup-target",
    name: "disabled-skill",
    state: { ...enabled.state, effectiveWorkspaceState: "disabled" as const },
  };
  return {
    ...snapshot,
    targets: [enabled, disabled],
    sources: [
      {
        ...snapshot.sources[0]!,
        targetIds: [enabled.id, disabled.id],
        collateralTargetIds: [enabled.id, disabled.id],
      },
    ],
  } as typeof snapshot;
}

function refreshSnapshots() {
  const base = twoHarnessSnapshot();
  const codex = base.targets[0]!;
  const claude = base.targets[1]!;
  const disabled = {
    ...codex,
    id: "disabled-setup-target",
    name: "disabled-skill",
    state: { ...codex.state, effectiveWorkspaceState: "disabled" as const },
  };
  const initial = {
    ...base,
    targets: [codex, claude, disabled],
    sources: [
      {
        ...base.sources[0]!,
        targetIds: [codex.id, disabled.id],
        collateralTargetIds: [codex.id, disabled.id],
      },
      base.sources[1]!,
    ],
  } as typeof base;
  return {
    initial,
    refreshed: {
      ...initial,
      id: "refreshed-setup-snapshot",
      targets: [claude, disabled],
      sources: [
        {
          ...initial.sources[0]!,
          targetIds: [disabled.id],
          collateralTargetIds: [disabled.id],
        },
        initial.sources[1]!,
      ],
      legacyInventory: buildInventory(),
    } as typeof initial,
  };
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
    const browse = controller.state as TuiState;
    if (browse.screen !== "browse") throw new Error();
    expect(browse.model.selected.size).toBe(1);
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

  it("projects an owned Skill directly beneath its Plugin heading", () => {
    const base = buildSessionSetupTarget();
    const plugin = {
      ...base,
      id: "plugin-target",
      kind: "plugin" as const,
      name: "Example Plugin",
      pluginBoundaryId: "plugin-boundary",
      pluginId: "example",
      childTargetIds: ["owned-skill"],
    };
    const child = {
      ...base,
      id: "owned-skill",
      kind: "skill-exposure" as const,
      name: "Owned Skill",
      owner: { kind: "plugin" as const, pluginBoundaryId: "plugin-boundary" },
    };
    const snapshot = {
      ...buildSessionSetupSnapshot(),
      targets: [plugin, child],
    } as ReturnType<typeof buildSessionSetupSnapshot>;
    const entries = createSetupSections(snapshot, "inventory")[0]!.entries;
    const heading = entries.findIndex((entry) => entry.name === "Plugins");
    expect(entries[heading]!.selectable).toBe(false);
    expect(entries[heading + 1]!.name).toBe("Example Plugin");
    expect(entries[heading + 2]!.rowKind).toBe("plugin-skill");
    expect(entries[heading + 2]!.selectable).toBe(false);
  });

  it("distinguishes colliding setup names with stable owner suffixes", () => {
    const base = buildSessionSetupTarget();
    const first = {
      ...base,
      id: "first-mcp",
      kind: "mcp-registration" as const,
      name: "docs",
      declarationSource: base.source,
      serverKey: "docs-first",
      requiredAppBindingId: null,
    };
    const second = {
      ...first,
      id: "second-mcp",
      serverKey: "docs-second",
      owner: { kind: "manager" as const, managerId: "team-tools" },
    };
    const snapshot = {
      ...buildSessionSetupSnapshot(),
      targets: [first, second],
    } as ReturnType<typeof buildSessionSetupSnapshot>;
    const names = createSetupSections(snapshot, "inventory")[0]!.entries.map(
      (entry) => entry.name,
    );
    expect(names).toContain("docs · standalone");
    expect(names).toContain("docs · manager:team-tools");
  });

  it("routes a suspended Codex setup row to its lifecycle Disabled entry", async () => {
    const planSessionSetup = vi.fn();
    const executeSessionSetup = vi.fn();
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      listDisabled: async () => [codexSuspendedEntry()],
      scanSessionSetup: async () => twoHarnessSnapshot(),
      planSessionSetup,
      executeSessionSetup,
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    if (controller.state.screen !== "browse") throw new Error();
    const suspendedSection = controller.state.model.sections.findIndex(
      (section) =>
        section.entries.some((entry) => entry.rowKind === "suspended-skill"),
    );
    await controller.dispatch({
      kind: "point-section",
      index: suspendedSection,
    });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    if (controller.state.screen !== "browse") throw new Error();
    const suspendedEntry = controller.state.model.sections[
      controller.state.model.sectionIndex
    ]!.entries.findIndex((entry) => entry.rowKind === "suspended-skill");
    await controller.dispatch({ kind: "point-entry", index: suspendedEntry });
    if (controller.state.screen !== "browse") throw new Error();
    expect(
      controller.state.model.sections[controller.state.model.sectionIndex]!
        .entries[controller.state.model.entryIndex]!.lifecycleDisabledKey,
    ).toBe("disabled-entry:suspended-entry");
    await controller.dispatch({ kind: "select" });

    expect(controller.state.screen).toBe("browse");
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.area ?? "skills").toBe("skills");
    expect(controller.state.view).toBe("disabled");
    expect(
      controller.state.model.sections[controller.state.model.sectionIndex]!
        .entries[controller.state.model.entryIndex]!.key,
    ).toBe("disabled-entry:suspended-entry");
    expect(planSessionSetup).not.toHaveBeenCalled();
    expect(executeSessionSetup).not.toHaveBeenCalled();

    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "focus", pane: "sections" });
    await controller.dispatch({ kind: "move", delta: 1 });
    if (controller.state.screen !== "browse") throw new Error();
    expect(
      controller.state.model.sections[
        controller.state.model.sectionIndex
      ]!.entries.some((entry) => entry.rowKind === "suspended-skill"),
    ).toBe(false);
  });

  it("opens setup disable and enable reviews from raw and line terminals in both views", async () => {
    const cases = [
      { view: "inventory" as const, input: "d", raw: true, action: "disable" },
      { view: "inventory" as const, input: "e", raw: true, action: "enable" },
      {
        view: "inventory" as const,
        input: "disable",
        raw: false,
        action: "disable",
      },
      {
        view: "inventory" as const,
        input: "enable",
        raw: false,
        action: "enable",
      },
      { view: "disabled" as const, input: "d", raw: true, action: "disable" },
      { view: "disabled" as const, input: "e", raw: true, action: "enable" },
      {
        view: "disabled" as const,
        input: "disable",
        raw: false,
        action: "disable",
      },
      {
        view: "disabled" as const,
        input: "enable",
        raw: false,
        action: "enable",
      },
    ];
    for (const item of cases) {
      const planner = vi.fn(
        (
          _snapshot: Parameters<typeof planSessionSetup>[0],
          _intent: Parameters<typeof planSessionSetup>[1],
        ) => {
          void _snapshot;
          void _intent;
          return buildSessionSetupPlan();
        },
      );
      const controller = new TuiController({
        scan: async () => buildInventory(),
        plan,
        execute: vi.fn(),
        scanSessionSetup: async () => mixedStateSnapshot(),
        planSessionSetup: planner,
      });
      await controller.start();
      await controller.dispatch({ kind: "switch-area", area: "setup" });
      if (item.view === "disabled")
        await controller.dispatch({ kind: "switch-view", view: "disabled" });
      await controller.dispatch({ kind: "focus", pane: "entries" });
      await controller.dispatch({ kind: "move", delta: 1 });
      const action = item.raw
        ? parseRawTuiAction(controller.state, item.input, { name: item.input })
        : parseLineTuiAction(controller.state, item.input);
      await controller.dispatch(action);
      expect(controller.state.screen).toBe("setup-plan");
      expect(planner).toHaveBeenCalledOnce();
      expect(planner.mock.calls[0]![1]).toMatchObject({
        action: item.action,
        targets: [
          {
            targetId:
              item.view === "inventory"
                ? "setup-target-1"
                : "disabled-setup-target",
          },
        ],
      });
    }
  });

  it("plans unsupported setup controls as blocks without executing them", async () => {
    const target = buildSessionSetupTarget({
      control: {
        ...buildSessionSetupTarget().control,
        availability: {
          disable: { kind: "unavailable", reason: "fixture control" },
          enable: { kind: "unavailable", reason: "fixture control" },
        },
      },
    });
    const snapshot = buildSessionSetupSnapshot({ targets: [target] });
    const planner = vi.fn(planSessionSetup);
    const executeSessionSetup = vi.fn();
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => snapshot,
      planSessionSetup: planner,
      executeSessionSetup,
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    if (controller.state.screen !== "browse") throw new Error();
    expect(
      controller.state.model.sections[controller.state.model.sectionIndex]!
        .entries[controller.state.model.entryIndex]!.selectable,
    ).toBe(true);
    await controller.dispatch({ kind: "disable-review" });
    expect(controller.state.screen).toBe("setup-plan");
    expect(renderTui(controller.state)).toContain("unsupported-control");
    await controller.dispatch({ kind: "confirm" });
    expect(executeSessionSetup).not.toHaveBeenCalled();
  });

  it("replans an owner gate for exactly its owner and cancels to the saved browse model", async () => {
    const owner = {
      kind: "skill-exposure" as const,
      targetId: "owner-target",
      installationId: "owner-installation",
    };
    const ownerTarget = buildSessionSetupTarget({
      id: owner.targetId,
      installationId: owner.installationId,
      name: "Owner Skill",
    });
    const ownerGate = {
      ...buildSessionSetupPlan({
        intent: buildSessionSetupIntent({ action: "enable" }),
        actions: [],
        blocks: [],
        verifications: [],
      }),
      targets: [buildSessionSetupTarget(), ownerTarget],
      blocks: [
        {
          kind: "owner-gate" as const,
          target: buildSessionSetupIntent().targets[0]!,
          owner,
        },
      ],
    };
    const ownerReview = {
      ...buildSessionSetupPlan({ actions: [], blocks: [], verifications: [] }),
      intent: buildSessionSetupIntent({
        action: "enable",
        targets: [owner],
      }),
      targets: [ownerTarget],
    };
    const planner = vi
      .fn()
      .mockReturnValueOnce(ownerGate)
      .mockReturnValueOnce(ownerReview);
    const executeSessionSetup = vi.fn();
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup: async () => buildSessionSetupSnapshot(),
      planSessionSetup: planner,
      executeSessionSetup,
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    if (controller.state.screen !== "browse") throw new Error();
    const browseModel = controller.state.model;
    await controller.dispatch({ kind: "enable-review" });
    expect(renderTui(controller.state)).toContain(
      "o owner review · esc cancel",
    );
    await controller.dispatch({ kind: "owner-review" });
    expect(controller.state.screen).toBe("setup-plan");
    expect(planner).toHaveBeenCalledTimes(2);
    expect(planner.mock.calls[1]![1]).toMatchObject({
      action: "enable",
      harnessId: "codex",
      targets: [owner],
    });
    expect(executeSessionSetup).not.toHaveBeenCalled();
    await controller.dispatch({ kind: "cancel" });
    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.model).toEqual(browseModel);
  });

  it("only confirms unblocked setup plans and renders the matching footer", async () => {
    const blocked = buildSessionSetupPlan({
      actions: [],
      blocks: [
        {
          kind: "unsupported-control",
          target: buildSessionSetupIntent().targets[0]!,
          reason: "fixture block",
        },
      ],
      verifications: [],
    });
    const plannerError = buildSessionSetupPlan({
      actions: [],
      errors: [{ kind: "planner", reason: "fixture error" }],
      verifications: [],
    });
    const unblocked = buildSessionSetupPlan();
    for (const item of [
      { plan: blocked, footer: "esc cancel", executable: false },
      { plan: plannerError, footer: "esc cancel", executable: false },
      { plan: unblocked, footer: "y confirm · esc cancel", executable: true },
    ]) {
      const executeSessionSetup = vi.fn(async () => buildSessionSetupReport());
      const controller = new TuiController({
        scan: async () => buildInventory(),
        plan,
        execute: vi.fn(),
        scanSessionSetup: async () => buildSessionSetupSnapshot(),
        planSessionSetup: () => item.plan,
        executeSessionSetup,
      });
      await controller.start();
      await controller.dispatch({ kind: "switch-area", area: "setup" });
      await controller.dispatch({ kind: "focus", pane: "entries" });
      await controller.dispatch({ kind: "move", delta: 1 });
      await controller.dispatch({ kind: "disable-review" });
      expect(renderTui(controller.state)).toContain(item.footer);
      await controller.dispatch({ kind: "confirm" });
      if (item.executable) {
        expect(controller.state.screen).toBe("setup-executing");
        await controller.waitForSetupExecution();
        expect(executeSessionSetup).toHaveBeenCalledOnce();
      } else {
        expect(controller.state.screen).toBe("setup-plan");
        expect(executeSessionSetup).not.toHaveBeenCalled();
      }
    }
  });

  it("refreshes every setup view and harness model while preserving only surviving selections", async () => {
    const { initial, refreshed } = refreshSnapshots();
    const scanSessionSetup = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan,
      execute: vi.fn(),
      scanSessionSetup,
      planSessionSetup: () => buildSessionSetupPlan(),
      executeSessionSetup: async () => buildSessionSetupReport(),
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-area", area: "setup" });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "focus", pane: "sections" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "disable-review" });
    await controller.dispatch({ kind: "confirm" });
    await controller.waitForSetupExecution();
    expect(controller.state.screen).toBe("setup-report");
    await controller.dispatch({ kind: "select" });

    if (controller.state.screen !== "browse") throw new Error();
    expect(controller.state.inventory).toBe(refreshed.legacyInventory);
    expect(controller.state.setupInventory).toBe(refreshed);
    expect(controller.state.areaSnapshots).toBeUndefined();
    expect(controller.state.viewSnapshots?.inventory?.setupInventory).toBe(
      refreshed,
    );
    expect(controller.state.viewSnapshots?.disabled?.setupInventory).toBe(
      refreshed,
    );
    const harnessStates = controller.state.setupHarnessStates;
    expect(harnessStates).toBeDefined();
    expect(harnessStates?.inventory?.codex?.selected).toEqual(new Set());
    expect(harnessStates?.inventory?.["claude-code"]?.selected).toEqual(
      new Set(["setup:claude-target"]),
    );
    expect(harnessStates?.disabled?.codex?.selected).toEqual(
      new Set(["setup:disabled-setup-target"]),
    );
    expect(controller.state.model).toEqual(harnessStates?.disabled?.codex);
    for (const view of ["inventory", "disabled"] as const)
      for (const harness of ["codex", "claude-code", "gemini-cli"] as const) {
        const model = harnessStates?.[view]?.[harness];
        expect(model).toBeDefined();
        if (!(
          (view === "inventory" && harness === "claude-code") ||
          (view === "disabled" && harness === "codex")
        ))
          expect(model?.selected).toEqual(new Set());
        expect(
          model?.sections
            .flatMap((section) => section.entries)
            .map((entry) => entry.key),
        ).not.toContain("setup:setup-target-1");
      }
  });
});
