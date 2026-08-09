import { describe, expect, it, vi } from "vitest";

import type {
  AvailabilityPlan,
  AvailabilityReport,
} from "../src/availability/types.js";
import type { DisabledEntry } from "../src/disabled-storage/types.js";
import { plan } from "../src/planning/index.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
  buildSystemSkillFinding,
} from "../src/testing/index.js";
import {
  createDisabledSections,
  createTuiSections,
  selectionTargets,
  TuiController,
  availabilityPlanScrollMetrics,
  availabilityReportScrollMetrics,
  renderTui,
  plainTuiTheme,
} from "../src/tui/index.js";
import {
  mouseAction,
  parseLineTuiAction,
  parseRawTuiAction,
} from "../src/tui/terminal.js";
import type { TuiBrowseState, TuiState } from "../src/tui/types.js";

function exposure(harnessId: string, status: "enabled" | "disabled") {
  return {
    harnessId,
    status,
    control: { kind: "unsupported" as const, reason: "fixture" },
  };
}

function fixture() {
  const enabled = buildInstallation({
    id: "enabled",
    skill: { name: "Enabled", description: null },
    exposedTo: ["codex"],
    harnessExposures: [exposure("codex", "enabled")],
  });
  const disabled = buildInstallation({
    id: "disabled",
    skill: { name: "Fully disabled", description: null },
    location: {
      path: "/fixtures/disabled",
      canonicalPath: "/fixtures/disabled",
      artifactType: { kind: "directory" },
    },
    exposedTo: ["claude-code"],
    harnessExposures: [exposure("claude-code", "disabled")],
  });
  const partial = buildInstallation({
    id: "partial",
    skill: { name: "Partly disabled", description: null },
    location: {
      path: "/fixtures/partial",
      canonicalPath: "/fixtures/partial",
      artifactType: { kind: "directory" },
    },
    exposedTo: ["codex", "gemini-cli"],
    harnessExposures: [
      exposure("codex", "enabled"),
      exposure("gemini-cli", "disabled"),
    ],
  });
  const pluginInstallation = buildInstallation({
    id: "plugin-installation",
    classification: "managed-plugin-resource",
    skill: { name: "Plugin skill", description: null },
    location: {
      path: "/fixtures/plugin-skill",
      canonicalPath: "/fixtures/plugin-skill",
      artifactType: { kind: "directory" },
    },
    pluginBoundaryId: "plugin-boundary",
    plugin: { id: "plugin-boundary", version: "1.0.0" },
    ownership: {
      kind: "plugin",
      pluginId: "plugin-boundary",
      independentlySelectable: false,
      confidence: "declared",
    },
    exposedTo: ["claude-code"],
    harnessExposures: [exposure("claude-code", "disabled")],
  });
  const inventory = buildInventory({
    installations: [enabled, disabled, partial, pluginInstallation],
    logicalSkills: [
      buildLogicalSkill({
        id: "logical-enabled",
        skill: enabled.skill,
        identity: enabled.identity,
        installationIds: [enabled.id],
      }),
      buildLogicalSkill({
        id: "logical-disabled",
        skill: disabled.skill,
        identity: disabled.identity,
        installationIds: [disabled.id],
      }),
      buildLogicalSkill({
        id: "logical-partial",
        skill: partial.skill,
        identity: partial.identity,
        installationIds: [partial.id],
      }),
    ],
    plugins: [
      {
        ...buildPluginBoundary({
          id: "plugin-boundary",
          pluginId: "plugin-boundary",
          exposedTo: ["claude-code"],
          ownership: {
            kind: "plugin",
            pluginId: "plugin-boundary",
            independentlySelectable: false,
            confidence: "declared",
          },
        }),
        installationIds: [pluginInstallation.id],
      },
    ],
    otherFindings: [buildSystemSkillFinding()],
  });
  return { inventory, enabled, disabled, partial };
}

function disabledEntry(
  installation: ReturnType<typeof buildInstallation>,
  id: string,
): DisabledEntry {
  return {
    schemaVersion: 1,
    id: id as DisabledEntry["id"],
    suspendedAt: "2026-08-08T12:00:00.000Z",
    originalLocation: installation.location,
    integrity: { algorithm: "sha256", digest: "a".repeat(64) },
    skillIdentity: installation.identity,
    installationIds: [installation.id],
    ownership: installation.ownership,
    harnessExposures: installation.harnessExposures,
    operation: {
      id: `operation-${id}`,
      displayNames: [installation.skill.name],
    },
    restoration: { mode: null, modifiedAt: null },
  };
}

function availabilityPlan(
  inventoryId: AvailabilityPlan["inventoryId"],
  operation: "disable" | "enable",
  entry: DisabledEntry,
): AvailabilityPlan {
  return {
    schemaVersion: 1,
    id: `availability-${operation}`,
    inventoryId,
    createdAt: "2026-08-08T12:00:00.000Z",
    intent: {
      operation,
      targets: [
        { kind: "installation", installationId: entry.installationIds[0] },
      ],
      force: false,
    },
    targets: [
      { kind: "installation", installationId: entry.installationIds[0] },
    ],
    disabledEntryIds: operation === "enable" ? [entry.id] : [],
    actions:
      operation === "enable"
        ? [
            {
              id: "restore-entry",
              kind: "suspended-enable",
              targets: [
                {
                  kind: "installation",
                  installationId: entry.installationIds[0],
                },
              ],
              affectedInstallationIds: entry.installationIds,
              dependsOn: [],
              approvals: [],
              entry,
            },
          ]
        : [],
    blocks: [],
    warnings: [],
    verificationChecks: [],
  };
}

function availabilityReport(planValue: AvailabilityPlan): AvailabilityReport {
  return {
    schemaVersion: 1,
    planId: planValue.id,
    inventoryId: planValue.inventoryId,
    finalInventoryId: planValue.inventoryId,
    rescanError: null,
    startedAt: "2026-08-08T12:00:00.000Z",
    completedAt: "2026-08-08T12:01:00.000Z",
    status: "succeeded",
    actionResults: planValue.actions.map((action) => ({
      actionId: action.id,
      status: "succeeded" as const,
      startedAt: "2026-08-08T12:00:00.000Z",
      completedAt: "2026-08-08T12:01:00.000Z",
      details: { entryId: "disabled-entry" },
    })),
    targetResults: planValue.targets.map((target) => ({
      target,
      status: planValue.intent.operation === "enable" ? "enabled" : "disabled",
      actionIds: planValue.actions.map((action) => action.id),
      reason: null,
    })),
    verificationResults: [],
  };
}

describe("Disabled TUI projection", () => {
  it("hides only fully disabled ordinary Skills and preserves every Disabled identity", () => {
    const { inventory, enabled } = fixture();
    const entries = [
      disabledEntry(enabled, "stored-a"),
      disabledEntry(enabled, "stored-b"),
    ];
    const inventoryNames = createTuiSections(inventory)
      .flatMap((section) => section.entries)
      .map((entry) => entry.name);
    expect(inventoryNames).toContain("Enabled");
    expect(inventoryNames).toContain("Partly disabled");
    expect(inventoryNames).not.toContain("Fully disabled");
    expect(
      createTuiSections(inventory)
        .flatMap((section) => section.entries)
        .find((row) => row.name === "Partly disabled")?.note,
    ).toBe("disabled in gemini-cli · enabled in codex");

    const sections = createDisabledSections(inventory, entries);
    expect(
      sections.find((section) => section.key === "disabled-native")?.entries,
    ).toHaveLength(3);
    expect(
      sections
        .find((section) => section.key === "disabled-suspended")
        ?.entries.map((entry) => entry.key),
    ).toEqual(["disabled-entry:stored-a", "disabled-entry:stored-b"]);
    expect(
      sections.find((section) => section.key === "plugins")?.selectable,
    ).toBe(false);
    expect(
      sections.find((section) => section.key === "system")?.selectable,
    ).toBe(false);
    const pluginRow = sections
      .flatMap((section) => section.entries)
      .find((entry) => entry.key.includes("plugin-installation"));
    expect(pluginRow?.selectable).toBe(false);
  });

  it("does not let a hidden disabled Group member ride along in a Removal target", () => {
    const { enabled, disabled } = fixture();
    const inventory = buildInventory({
      installations: [enabled, disabled],
      logicalSkills: [
        buildLogicalSkill({
          id: "logical-enabled",
          skill: enabled.skill,
          identity: enabled.identity,
          installationIds: [enabled.id],
          groupId: "mixed-group",
        }),
        buildLogicalSkill({
          id: "logical-disabled",
          skill: disabled.skill,
          identity: disabled.identity,
          installationIds: [disabled.id],
          groupId: "mixed-group",
        }),
      ],
      groups: [
        {
          id: "mixed-group",
          label: "Mixed group",
          tier: "declared",
          evidence: {
            tier: "declared",
            kind: "manager-source",
            managerId: "fixture-manager",
            sourceId: "fixture-source",
          },
          scope: { kind: "user" },
          installationIds: [enabled.id, disabled.id],
        },
      ],
    });
    const sections = createTuiSections(inventory);
    expect(sections[0]?.target).toBeNull();
    expect(
      selectionTargets(sections, new Set(["skill:logical-enabled"])),
    ).toEqual([{ kind: "logical-skill", logicalSkillId: "logical-enabled" }]);
  });

  it("preserves independent Inventory, Disabled, and Trash snapshots through resize and review", async () => {
    const { inventory, enabled } = fixture();
    const entry = disabledEntry(enabled, "stored-a");
    const planner = vi.fn((_, __, intent) =>
      availabilityPlan(inventory.id, intent.operation, entry),
    );
    const executor = vi.fn(async (planned: AvailabilityPlan) =>
      availabilityReport(planned),
    );
    const scan = vi.fn(async () => inventory);
    const listDisabled = vi
      .fn<() => Promise<readonly DisabledEntry[]>>()
      .mockResolvedValueOnce([entry])
      .mockResolvedValue([]);
    const controller = new TuiController(
      {
        scan,
        plan,
        execute: vi.fn(),
        listDisabled,
        planAvailability: planner,
        executeAvailability: executor,
        quarantine: {
          listOperations: async () => [],
        } as never,
      },
      { rows: 24, columns: 100 },
    );
    await controller.start();
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "move", delta: 1 });
    const inventoryIndex = (controller.state as TuiBrowseState).model
      .entryIndex;
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "point-section", index: 1 });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "toggle-select" });
    const disabledState = controller.state as TuiBrowseState;
    const disabledIndex = disabledState.model.entryIndex;
    const selected = [...disabledState.model.selected];
    await controller.dispatch({ kind: "switch-view", view: "trash" });
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 18, columns: 72 },
    });
    await controller.dispatch({ kind: "cancel" });
    expect((controller.state as TuiBrowseState).model.entryIndex).toBe(
      inventoryIndex,
    );
    expect((controller.state as TuiBrowseState).model.viewport).toEqual({
      rows: 18,
      columns: 72,
    });
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    expect((controller.state as TuiBrowseState).model.entryIndex).toBe(
      disabledIndex,
    );
    expect([...(controller.state as TuiBrowseState).model.selected]).toEqual(
      selected,
    );
    expect((controller.state as TuiBrowseState).model.viewport).toEqual({
      rows: 18,
      columns: 72,
    });
    await controller.dispatch({ kind: "open-search" });
    await controller.dispatch({ kind: "cancel" });
    expect([...(controller.state as TuiBrowseState).model.selected]).toEqual(
      selected,
    );
    await controller.dispatch({ kind: "enable-review" });
    expect(controller.state.screen).toBe("availability-plan");
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "Suspended: restore",
    );
    await controller.dispatch({ kind: "confirm" });
    expect(controller.state.screen).toBe("availability-executing");
    expect(executor).not.toHaveBeenCalled();
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "final scan and verification",
    );
    await controller.waitForAvailabilityExecution();
    expect(controller.state.screen).toBe("availability-report");
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "Availability result",
    );
    await controller.dispatch({ kind: "cancel" });
    expect((controller.state as TuiBrowseState).view).toBe("disabled");
    expect(
      (controller.state as TuiBrowseState).model.sections
        .flatMap((section) => section.entries)
        .some((row) => row.key === `disabled-entry:${entry.id}`),
    ).toBe(false);
    expect([
      ...(controller.state as TuiBrowseState).model.selected,
    ]).not.toContain(`disabled-entry:${entry.id}`);
    expect(executor).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(listDisabled).toHaveBeenCalledTimes(2);
  });

  it("maps line, raw keyboard, mouse tabs, and additive Disabled selection", () => {
    const { inventory, enabled } = fixture();
    const model = {
      ...new TuiController({
        scan: async () => inventory,
        plan,
        execute: vi.fn(),
      }).state,
    };
    void model;
    const state = {
      screen: "browse" as const,
      inventory,
      model: {
        sections: createDisabledSections(inventory, [
          disabledEntry(enabled, "stored-a"),
        ]),
        viewport: { rows: 20, columns: 100 },
        focus: "entries" as const,
        sectionIndex: 0,
        entryIndex: 0,
        sectionScroll: 0,
        entryScroll: 0,
        detailScroll: 0,
        leftPercent: 35,
        detailRows: 6,
        query: "",
        selected: new Set<string>(),
        notice: null,
      },
      view: "disabled" as const,
      disabledEntries: [disabledEntry(enabled, "stored-a")],
    };
    expect(parseLineTuiAction(state, "enable")).toEqual({
      kind: "enable-review",
    });
    expect(parseRawTuiAction(state, "e", { name: "e", ctrl: false })).toEqual({
      kind: "enable-review",
    });
    expect(parseRawTuiAction(state, "d", { name: "d", ctrl: false })).toEqual({
      kind: "noop",
    });
    expect(
      mouseAction(
        state,
        { button: 0, column: 28, row: 1, pressed: true },
        { dragging: false, doubleClick: false },
      ),
    ).toEqual({ kind: "switch-view", view: "disabled" });
  });

  it("searches Disabled rows and describes protected selection in Enable language", async () => {
    const { inventory, enabled } = fixture();
    const entry = disabledEntry(enabled, "stored-search");
    const controller = new TuiController({
      scan: async () => inventory,
      plan,
      execute: vi.fn(),
      listDisabled: async () => [entry],
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "append-query", value: "Enabled" });
    expect(controller.state.screen).toBe("search");
    if (controller.state.screen !== "search")
      throw new Error("expected search");
    expect(
      controller.state.model.results.map((result) => result.entry.name),
    ).toContain("Enabled");
    await controller.dispatch({ kind: "cancel" });
    await controller.dispatch({ kind: "point-section", index: 2 });
    await controller.dispatch({ kind: "toggle-select" });
    const browseState = controller.state as TuiState;
    expect(browseState.screen).toBe("browse");
    if (browseState.screen !== "browse") throw new Error("expected browse");
    expect(browseState.model.notice).toBe("Plugins cannot be enabled here.");
    expect(browseState.model.selected.size).toBe(0);
  });

  it("renders multi-harness Native work and honest partial reports with technical details", () => {
    const { inventory, partial } = fixture();
    const entry = disabledEntry(partial, "stored-partial");
    const base = availabilityPlan(inventory.id, "enable", entry);
    const native = {
      ...base,
      disabledEntryIds: [entry.id],
      actions: [
        {
          id: "native-action",
          kind: "native-control",
          targets: base.targets,
          affectedInstallationIds: [partial.id],
          dependsOn: ["prepare-config"],
          approvals: [],
          effects: [
            {
              installationId: partial.id,
              harnessId: "codex",
              operation: "enable",
            },
            {
              installationId: partial.id,
              harnessId: "gemini-cli",
              operation: "enable",
            },
          ],
          mutations: [
            {
              path: "/fixtures/config.json",
              format: "json",
              documentScope: "user",
              exists: true,
              expectedPreimageHash: {
                algorithm: "sha256",
                digest: "b".repeat(64),
              },
              protection: {
                git: { kind: "outside-worktree" },
                system: { kind: "none" },
                filesystem: { kind: "writable" },
              },
              operation: {
                kind: "gemini-disabled-skills",
                skillName: "Partly disabled",
                disabled: false,
              },
            },
          ],
        },
      ],
      verificationChecks: [
        {
          id: "check-native",
          kind: "harness-exposure-state",
          target: base.targets[0]!,
          actionId: "native-action",
          installationId: partial.id,
          harnessId: "gemini-cli",
          expectedStatus: "enabled",
        },
      ],
    } as unknown as AvailabilityPlan;
    const browse = {
      inventory,
      model: {
        sections: createDisabledSections(inventory, [entry]),
        viewport: { rows: 14, columns: 100 },
        focus: "entries" as const,
        sectionIndex: 0,
        entryIndex: 0,
        sectionScroll: 0,
        entryScroll: 0,
        detailScroll: 0,
        leftPercent: 35,
        detailRows: 4,
        query: "",
        selected: new Set<string>(),
        notice: null,
      },
      view: "disabled" as const,
      disabledEntries: [entry],
    };
    const review = {
      screen: "availability-plan" as const,
      browse,
      plan: native,
      label: "Partly disabled",
      technicalDetails: false,
      scrollOffset: 0,
    };
    expect(renderTui(review, plainTuiTheme)).toContain(
      "Native: show Partly disabled in codex, gemini-cli",
    );
    const technicalReview = renderTui(
      {
        ...review,
        browse: {
          ...review.browse,
          model: {
            ...review.browse.model,
            viewport: { rows: 40, columns: 120 },
          },
        },
        technicalDetails: true,
      },
      plainTuiTheme,
    );
    expect(technicalReview).toContain("Target:");
    expect(technicalReview).toContain("Action native-action: native-control");
    expect(technicalReview).toContain("Effect: partial · codex · enable");
    expect(technicalReview).toContain(
      "Config: /fixtures/config.json · json · user · preimage",
    );
    expect(technicalReview.replaceAll(/\s/g, "")).toContain("b".repeat(64));
    expect(technicalReview).toContain("Depends on: prepare-config");
    expect(technicalReview).toContain("Approvals: []");
    expect(technicalReview).toContain("Disabled entry ID: stored-partial");
    expect(technicalReview).toContain(
      "Check check-native: harness-exposure-state",
    );
    const report: AvailabilityReport = {
      ...availabilityReport(native),
      status: "partial",
      actionResults: [
        {
          actionId: "native-action",
          status: "failed",
          startedAt: "2026-08-08T12:00:00.000Z",
          completedAt: "2026-08-08T12:01:00.000Z",
          error: {
            code: "CONFIG_RACE",
            message: "configuration changed before publication",
            details: { path: "/fixtures/config.json" },
          },
        },
      ],
      targetResults: [
        {
          target: native.targets[0]!,
          status: "partial",
          actionIds: ["native-action"],
          reason: "Codex enabled; Gemini remained disabled",
        },
      ],
      verificationResults: [
        {
          checkId: "check-native",
          status: "failed",
          error: {
            code: "EXPOSURE_STILL_DISABLED",
            message: "Gemini still reports disabled",
            details: { harnessId: "gemini-cli" },
          },
        },
      ],
    };
    const reportState = {
      screen: "availability-report" as const,
      browse,
      report,
      label: "Partly disabled",
      technicalDetails: false,
      scrollOffset: 0,
    };
    const rendered = renderTui(reportState, plainTuiTheme);
    expect(rendered).toContain("completed only in part");
    expect(rendered).toContain("Partly disabled (codex, gemini-cli): partial");
    expect(rendered).toContain("Gemini remained disabled");
    expect(rendered).toContain(
      "Action failed: configuration changed before publication",
    );
    expect(rendered).toContain(
      "Verification failed: Gemini still reports disabled",
    );
    expect(rendered).not.toContain("native-action");
    const technicalReport = renderTui(
      {
        ...reportState,
        browse: {
          ...reportState.browse,
          model: {
            ...reportState.browse.model,
            viewport: { rows: 40, columns: 120 },
          },
        },
        technicalDetails: true,
      },
      plainTuiTheme,
    );
    expect(technicalReport).toContain("Action native-action");
    expect(technicalReport).toContain("Raw error CONFIG_RACE");

    const goneEntry = {
      ...entry,
      installationIds: ["gone-installation" as typeof partial.id],
      operation: { ...entry.operation, displayNames: ["Stored-only skill"] },
    } as DisabledEntry;
    const goneReport = {
      ...reportState,
      browse: {
        ...reportState.browse,
        inventory: buildInventory({ installations: [] }),
        disabledEntries: [goneEntry],
      },
      report: {
        ...report,
        targetResults: [
          {
            target: {
              kind: "installation" as const,
              installationId: goneEntry.installationIds[0],
            },
            status: "enabled" as const,
            actionIds: ["restore-gone"],
            reason: null,
          },
        ],
      },
    };
    expect(renderTui(goneReport, plainTuiTheme)).toContain(
      "Stored-only skill: enabled",
    );
    expect(renderTui(goneReport, plainTuiTheme)).not.toContain(
      "gone-installation: enabled",
    );
  });

  it("keeps long Availability review/report content reachable and clamps compact resize", async () => {
    const { inventory, enabled } = fixture();
    const entry = disabledEntry(enabled, "stored-long");
    const base = availabilityPlan(inventory.id, "enable", entry);
    const longPlan = {
      ...base,
      actions: Array.from({ length: 24 }, (_, index) => ({
        ...(base.actions[0] as Extract<
          AvailabilityPlan["actions"][number],
          { kind: "suspended-enable" }
        >),
        id: `restore-${String(index).padStart(2, "0")}`,
      })),
    } as AvailabilityPlan;
    const controller = new TuiController(
      {
        scan: async () => inventory,
        plan,
        execute: vi.fn(),
        listDisabled: async () => [entry],
        planAvailability: () => longPlan,
        executeAvailability: async () => availabilityReport(longPlan),
      },
      { rows: 10, columns: 60 },
    );
    await controller.start();
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "point-section", index: 1 });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "enable-review" });
    if (controller.state.screen !== "availability-plan")
      throw new Error("expected review");
    expect(
      availabilityPlanScrollMetrics(controller.state).maximumOffset,
    ).toBeGreaterThan(0);
    await controller.dispatch({ kind: "page", delta: 1 });
    expect(
      controller.state.screen === "availability-plan" &&
        controller.state.scrollOffset,
    ).toBeGreaterThan(0);
    expect(
      mouseAction(
        controller.state,
        { button: 64, column: 2, row: 2, pressed: true },
        { dragging: false, doubleClick: false },
      ),
    ).toEqual({ kind: "move", delta: -1 });
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 5, columns: 30 },
    });
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "Resize the terminal",
    );
    expect(
      controller.state.screen === "availability-plan" &&
        controller.state.scrollOffset,
    ).toBe(0);
    await controller.dispatch({
      kind: "viewport",
      viewport: { rows: 10, columns: 60 },
    });
    await controller.dispatch({ kind: "confirm" });
    await controller.waitForAvailabilityExecution();
    const finalState = controller.state as TuiState;
    if (finalState.screen !== "availability-report")
      throw new Error("expected report");
    expect(
      availabilityReportScrollMetrics(finalState).maximumOffset,
    ).toBeGreaterThanOrEqual(0);
  });

  it("keeps read-only browsing, blocked review, and cancellation at zero mutation", async () => {
    const { inventory, enabled } = fixture();
    const entry = disabledEntry(enabled, "stored-safe");
    const executeRemoval = vi.fn();
    const executeAvailability = vi.fn();
    const planner = vi.fn(() => ({
      ...availabilityPlan(inventory.id, "enable", entry),
      actions: [],
      blocks: [
        {
          kind: "entry-not-found" as const,
          target: { kind: "installation" as const, installationId: enabled.id },
          reason: "stored entry is unavailable",
          path: null,
          overridable: false as const,
        },
      ],
    }));
    const controller = new TuiController({
      scan: vi.fn(async () => inventory),
      plan,
      execute: executeRemoval,
      listDisabled: vi.fn(async () => [entry]),
      planAvailability: planner,
      executeAvailability,
    });
    await controller.start();
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "point-section", index: 1 });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "enable-review" });
    expect(controller.state.screen).toBe("availability-plan");
    await controller.dispatch({ kind: "confirm" });
    expect(executeAvailability).not.toHaveBeenCalled();
    expect(executeRemoval).not.toHaveBeenCalled();
    await controller.dispatch({ kind: "cancel" });
    await controller.dispatch({ kind: "cancel" });
    expect(executeAvailability).not.toHaveBeenCalled();
    expect(executeRemoval).not.toHaveBeenCalled();
  });

  it("completes Availability with line, raw-keyboard, and mouse interactions", async () => {
    const { inventory, enabled } = fixture();
    const entry = disabledEntry(enabled, "stored-input");
    for (const input of ["line", "raw", "mouse"] as const) {
      const executeAvailability = vi.fn(async (planned: AvailabilityPlan) =>
        availabilityReport(planned),
      );
      const controller = new TuiController({
        scan: async () => inventory,
        plan,
        execute: vi.fn(),
        listDisabled: async () => [entry],
        planAvailability: (_, __, intent) =>
          availabilityPlan(inventory.id, intent.operation, entry),
        executeAvailability,
        quarantine: { listOperations: async () => [] } as never,
      });
      await controller.start();
      if (input === "line") {
        await controller.dispatch(
          parseLineTuiAction(controller.state, "disabled"),
        );
        await controller.dispatch(parseLineTuiAction(controller.state, "down"));
        await controller.dispatch(parseLineTuiAction(controller.state, "in"));
        await controller.dispatch(
          parseLineTuiAction(controller.state, "space"),
        );
        await controller.dispatch(
          parseLineTuiAction(controller.state, "enable"),
        );
        await controller.dispatch(parseLineTuiAction(controller.state, "yes"));
      } else if (input === "raw") {
        await controller.dispatch(
          parseRawTuiAction(controller.state, "", { name: "t", ctrl: true }),
        );
        await controller.dispatch(
          parseRawTuiAction(controller.state, "", {
            name: "down",
            ctrl: false,
          }),
        );
        await controller.dispatch(
          parseRawTuiAction(controller.state, "", {
            name: "right",
            ctrl: false,
          }),
        );
        await controller.dispatch(
          parseRawTuiAction(controller.state, " ", {
            name: "space",
            ctrl: false,
          }),
        );
        await controller.dispatch(
          parseRawTuiAction(controller.state, "e", { name: "e", ctrl: false }),
        );
        await controller.dispatch(
          parseRawTuiAction(controller.state, "y", { name: "y", ctrl: false }),
        );
      } else {
        await controller.dispatch(
          mouseAction(
            controller.state,
            { button: 0, column: 28, row: 1, pressed: true },
            { dragging: false, doubleClick: false },
          ),
        );
        await controller.dispatch(
          mouseAction(
            controller.state,
            { button: 0, column: 2, row: 6, pressed: true },
            { dragging: false, doubleClick: false },
          ),
        );
        await controller.dispatch(
          mouseAction(
            controller.state,
            { button: 0, column: 45, row: 6, pressed: true },
            { dragging: false, doubleClick: true },
          ),
        );
        await controller.dispatch({ kind: "enable-review" });
        await controller.dispatch({ kind: "confirm" });
      }
      expect(controller.state.screen).toBe("availability-executing");
      expect(executeAvailability).not.toHaveBeenCalled();
      await controller.waitForAvailabilityExecution();
      expect(controller.state.screen).toBe("availability-report");
      expect(executeAvailability).toHaveBeenCalledOnce();
      await controller.dispatch(
        input === "line"
          ? parseLineTuiAction(controller.state, "quit")
          : parseRawTuiAction(controller.state, "q", {
              name: "q",
              ctrl: false,
            }),
      );
      expect(controller.state.screen).toBe("done");
      if (controller.state.screen === "done")
        expect(controller.state.report).toMatchObject({
          planId: "availability-enable",
        });
    }
  });
});
