import { describe, expect, it, vi } from "vitest";

import {
  createBrowseModel,
  createTuiSections,
  createNightfallTheme,
  parseLineTuiAction,
  plan,
  plainTuiTheme,
  renderTui,
  styleTui,
  TuiController,
  updatePlanScrollMetrics,
  updateReportScrollMetrics,
  type ApprovalRequirement,
  type Inventory,
  type DisabledEntry,
  type LogicalSkillId,
  type UpdateAvailabilityExpectation,
  type UpdateIntent,
  type UpdatePlan,
  type UpdateReport,
  type UpdateTarget,
  type TuiState,
} from "../src/index.js";
import { parseRawTuiAction } from "../src/tui/terminal.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
  buildSystemSkillFinding,
} from "../src/testing/index.js";

function browseState(): TuiState {
  const inventory = buildInventory();
  return {
    screen: "browse",
    inventory,
    model: createBrowseModel(createTuiSections(inventory), {
      rows: 24,
      columns: 100,
    }),
    view: "inventory",
    disabledEntries: [],
  };
}

function reviewPlan(inventory: Inventory, target: UpdateTarget): UpdatePlan {
  return {
    schemaVersion: 1,
    id: "update-plan-1",
    inventoryId: inventory.id,
    createdAt: inventory.scannedAt,
    intent: { target, force: false },
    targets: [target],
    actions: [],
    blocks: [],
    warnings: [],
    verificationChecks: [],
  };
}

function detailedPlan(inventory: Inventory): UpdatePlan {
  const target = {
    kind: "installation" as const,
    installationId: inventory.installations[0]!.id,
  };
  const approvals: readonly ApprovalRequirement[] = [
    { kind: "confirmation" },
    {
      kind: "package-trust",
      runner: "npx",
      packageName: "@fixture/manager",
      packageVersion: "1.2.3",
      adapterHash: "a".repeat(64),
    },
    {
      kind: "adapter-trust",
      adapterId: "fixture-adapter",
      contentHash: "b".repeat(64),
    },
  ];
  return {
    ...reviewPlan(inventory, target),
    actions: [
      {
        id: "update-action-1",
        kind: "managed-update",
        target,
        affectedInstallationIds: [inventory.installations[0]!.id],
        dependsOn: [],
        approvals,
        operation: {
          adapterId: "fixture-adapter",
          operationId: "update",
          availability: { kind: "available" },
          trust: { kind: "trusted" },
          owner: {
            kind: "manager",
            managerId: "fixture-manager",
            confidence: "declared",
          },
          externalId: "fixture-lock-key",
          invocation: {
            kind: "ephemeral-package",
            packageExecution: {
              runner: "npx",
              packageName: "@fixture/manager",
              packageVersion: "1.2.3",
              adapterHash: "a".repeat(64),
              mayDownload: true,
            },
            packageArguments: ["update", "fixture-lock-key", "--yes"],
            workingDirectory: { kind: "isolated-temporary" },
          },
          source: {
            id: "fixture-source",
            url: "https://example.test/source",
          },
          ref: "main",
          scope: {
            kind: "workspace",
            workspacePath: "/fixtures/workspace",
          },
          currentRevision: [
            {
              kind: "owner-value",
              path: "/fixtures/manager.json",
              format: "json",
              recordPointer: "/skills/fixture/revision",
              value: 1,
            },
          ],
          ownerRecordDigest: {
            algorithm: "sha256",
            digest: "c".repeat(64),
          },
          effects: [
            {
              kind: "mutation-root",
              path: "/fixtures/skills/example-skill",
              exists: true,
              protection: {
                git: { kind: "outside-worktree" },
                system: { kind: "none" },
                filesystem: { kind: "writable" },
              },
            },
            {
              kind: "configuration-path",
              path: "/fixtures/manager.json",
              exists: true,
              protection: {
                git: { kind: "outside-worktree" },
                system: { kind: "none" },
                filesystem: { kind: "writable" },
              },
            },
          ],
          network: {
            kind: "required",
            reason: "Owner fetches the recorded source",
          },
          packageDownload: {
            kind: "possible",
            packageName: "@fixture/manager",
            packageVersion: "1.2.3",
          },
          localChanges: {
            kind: "unavailable",
            reason: "Owner cannot compare local content",
          },
          verifications: [
            {
              kind: "revision-manifest-value",
              path: "/fixtures/manager.json",
              format: "json",
              recordPointer: "/skills/fixture/revision",
              value: 1,
            },
          ],
        },
        availabilityExpectation: {
          harnessStatuses: [],
          pluginStatus: null,
        },
        selectedInstallations: [],
        selectedPlugin: null,
      },
    ],
    warnings: [
      {
        kind: "network-access",
        target,
        actionId: "update-action-1",
        reason: "Owner fetches the recorded source",
      },
      {
        kind: "package-download",
        target,
        actionId: "update-action-1",
        packageName: "@fixture/manager",
        packageVersion: "1.2.3",
      },
    ],
    verificationChecks: [
      {
        id: "update-check-1",
        actionId: "update-action-1",
        target,
        installationId: inventory.installations[0]!.id,
        pluginBoundaryId: null,
        identity: inventory.installations[0]!.identity,
        pluginId: null,
        source: {
          id: "fixture-source",
          url: "https://example.test/source",
        },
        ref: "main",
        scope: {
          kind: "workspace",
          workspacePath: "/fixtures/workspace",
        },
        owner: {
          kind: "manager",
          managerId: "fixture-manager",
          confidence: "declared",
        },
        currentRevision: [
          {
            kind: "owner-value",
            path: "/fixtures/manager.json",
            format: "json",
            recordPointer: "/skills/fixture/revision",
            value: 1,
          },
        ],
        availabilityExpectation: {
          harnessStatuses: [],
          pluginStatus: null,
        },
      },
    ],
  };
}

function equivalentInstallationPlan(count: number): {
  readonly inventory: Inventory;
  readonly plan: UpdatePlan;
} {
  const installations = Array.from({ length: count }, (_, index) => {
    const number = String(index + 1);
    const path = `/fixtures/skills/example-skill-${number}`;
    return buildInstallation({
      id: `installation-${number}`,
      location: {
        path,
        canonicalPath: path,
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          { strength: "strong", kind: "canonical-target", canonicalPath: path },
        ],
        weakEvidence: [],
      },
    });
  });
  const inventory = buildInventory({ installations });
  const fixture = detailedPlan(inventory);
  const firstAction = fixture.actions[0]!;
  const firstCheck = fixture.verificationChecks[0]!;
  const target = {
    kind: "logical-skill" as const,
    logicalSkillId: "logical-skill-1" as LogicalSkillId,
  };
  const actions = installations.map((installation, index) => {
    const number = String(index + 1);
    const availabilityExpectation: UpdateAvailabilityExpectation = {
      harnessStatuses: ["claude", "codex", "gemini"].map((harnessId) => ({
        installationId: installation.id,
        strongEvidence: [installation.identity.strongEvidence[0]!],
        harnessId,
        status: "enabled" as const,
      })),
      pluginStatus: null,
    };
    return {
      ...firstAction,
      id: `update-action-${number}`,
      target,
      affectedInstallationIds: [installation.id],
      operation: {
        ...firstAction.operation,
        externalId: `fixture-lock-key-${number}`,
        invocation: {
          ...firstAction.operation.invocation,
          packageArguments: ["update", `fixture-lock-key-${number}`, "--yes"],
        },
        effects: firstAction.operation.effects.map((effect) => ({
          ...effect,
          path:
            effect.kind === "mutation-root"
              ? installation.location.path
              : effect.path,
        })),
      },
      availabilityExpectation,
    };
  });
  return {
    inventory,
    plan: {
      ...fixture,
      intent: { target, force: false },
      targets: [target],
      actions,
      warnings: actions.flatMap((action) => [
        {
          kind: "network-access" as const,
          target,
          actionId: action.id,
          reason: "Owner fetches the recorded source",
        },
        {
          kind: "package-download" as const,
          target,
          actionId: action.id,
          packageName: "@fixture/manager",
          packageVersion: "1.2.3",
        },
        {
          kind: "local-change-unavailable" as const,
          target,
          installationId: action.affectedInstallationIds[0]!,
          reason: "Owner cannot compare local content",
        },
      ]),
      verificationChecks: installations.map((installation, index) => ({
        ...firstCheck,
        id: `update-check-${String(index + 1)}`,
        actionId: `update-action-${String(index + 1)}`,
        target,
        installationId: installation.id,
        identity: installation.identity,
        availabilityExpectation: actions[index]!.availabilityExpectation,
      })),
    },
  };
}

function updateReport(
  planValue: UpdatePlan,
  targetStatus: UpdateReport["targetResults"][0]["status"] = "updated",
): UpdateReport {
  const status =
    targetStatus === "updated" || targetStatus === "unchanged"
      ? "succeeded"
      : targetStatus === "partially-updated"
        ? "partial"
        : targetStatus === "blocked"
          ? "blocked"
          : "failed";
  return {
    schemaVersion: 1,
    planId: planValue.id,
    inventoryId: planValue.inventoryId,
    finalInventoryId: planValue.inventoryId,
    rescanError: null,
    startedAt: "2026-08-21T12:00:00.000Z",
    completedAt: "2026-08-21T12:01:00.000Z",
    status,
    actionResults: planValue.actions.map((action) => ({
      actionId: action.id,
      status: "succeeded" as const,
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:01:00.000Z",
      details: {},
    })),
    targetResults: [
      {
        target: planValue.intent.target,
        status: targetStatus,
        actionIds: planValue.actions.map((action) => action.id),
        reason:
          targetStatus === "updated" || targetStatus === "unchanged"
            ? null
            : "fixture result",
      },
    ],
    verificationResults: planValue.verificationChecks.map((check) => ({
      checkId: check.id,
      status: "passed" as const,
      changed: targetStatus === "updated",
      details: {},
    })),
  };
}

function mixedSuccessfulUpdateReport(planValue: UpdatePlan): UpdateReport {
  const actionIds = Array.from(
    { length: 25 },
    (_, index) => `update-action-${String(index + 1)}`,
  );
  return {
    schemaVersion: 1,
    planId: planValue.id,
    inventoryId: planValue.inventoryId,
    finalInventoryId: planValue.inventoryId,
    rescanError: null,
    startedAt: "2026-08-21T12:00:00.000Z",
    completedAt: "2026-08-21T12:01:00.000Z",
    status: "succeeded",
    actionResults: actionIds.map((actionId) => ({
      actionId,
      status: "succeeded",
      startedAt: "2026-08-21T12:00:00.000Z",
      completedAt: "2026-08-21T12:01:00.000Z",
      details: {},
    })),
    targetResults: [
      {
        target: planValue.intent.target,
        status: "updated",
        actionIds,
        reason: null,
      },
    ],
    verificationResults: actionIds.map((_, index) => ({
      checkId: `update-check-${String(index + 1)}`,
      status: "passed",
      changed: index < 24,
      details: {},
    })),
  };
}

function dependencies(
  inventory: Inventory,
  planner = vi.fn((value: Inventory, intent: UpdateIntent) =>
    reviewPlan(value, intent.target),
  ),
) {
  return {
    planner,
    value: {
      scan: async () => inventory,
      plan,
      execute: vi.fn(),
      listDisabled: async () => [],
      planUpdate: planner,
      executeUpdate: vi.fn(),
    },
  };
}

function suspendedEntry(installation = buildInstallation()): DisabledEntry {
  return {
    schemaVersion: 1,
    id: "disabled-entry-1" as DisabledEntry["id"],
    suspendedAt: "2026-08-21T12:00:00.000Z",
    originalLocation: installation.location,
    integrity: { algorithm: "sha256", digest: "c".repeat(64) },
    skillIdentity: installation.identity,
    installationIds: [installation.id],
    ownership: installation.ownership,
    harnessExposures: installation.harnessExposures,
    operation: { id: "suspended", displayNames: [installation.skill.name] },
    restoration: { mode: null, modifiedAt: null },
  };
}

describe("Update TUI", () => {
  it("counts one logical skill once when two installations change", () => {
    const fixture = equivalentInstallationPlan(2);
    const installationIds = fixture.inventory.installations.map(
      (item) => item.id,
    );
    const logicalInstallationIds: [
      (typeof installationIds)[number],
      ...(typeof installationIds)[number][],
    ] = [installationIds[0]!, ...installationIds.slice(1)];
    const inventory = {
      ...fixture.inventory,
      logicalSkills: [
        buildLogicalSkill({
          id: "logical-skill-1",
          installationIds: logicalInstallationIds,
        }),
      ],
    };
    const state = {
      screen: "update-plan" as const,
      browse: {
        inventory,
        model: createBrowseModel(createTuiSections(inventory), {
          rows: 1_000,
          columns: 80,
        }),
        view: "inventory" as const,
        disabledEntries: [],
      },
      plan: fixture.plan,
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
    };
    const rendered = renderTui(state, plainTuiTheme);
    expect(rendered).toContain("1 skill");
    expect(rendered).not.toContain("2 skills");
  });

  it("keeps an equivalent 25-skill Update review decision-focused", () => {
    const fixture = equivalentInstallationPlan(25);
    const state = {
      screen: "update-plan" as const,
      browse: {
        inventory: fixture.inventory,
        model: createBrowseModel(createTuiSections(fixture.inventory), {
          rows: 1_000,
          columns: 80,
        }),
        view: "inventory" as const,
        disabledEntries: [],
      },
      plan: fixture.plan,
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
    };

    const rendered = renderTui(state, plainTuiTheme);
    const renderedLines = rendered.trimEnd().split("\n");
    const footerLineCount = 1;
    expect(renderedLines.length - footerLineCount).toBeLessThanOrEqual(60);
    expect(rendered).toContain("25 skills");
    expect(rendered).toContain("This update needs internet access");
    expect(rendered).toContain("The same 25 skills stay installed");
    expect(rendered).toContain("Lampwright cannot undo this update for you");
    expect(rendered).not.toContain("Owner action");
    expect(rendered).not.toContain("affected Installation");
    expect(rendered).not.toContain("Scope:");
    expect(rendered).not.toContain("Invocation:");
    expect(rendered).not.toContain("Trust:");
    expect(rendered.replaceAll(/\s+/g, " ")).toContain(
      "Lampwright cannot check for edits, so this update may overwrite them.",
    );
    for (const machineLabel of [
      "network-access",
      "package-download",
      "local-change-unavailable",
    ])
      expect(rendered).not.toContain(machineLabel);
    expect(rendered.match(/Allow npx to run/g)).toHaveLength(1);
    expect(rendered).not.toContain("update-action-25");
    expect(rendered).not.toContain("fixture-lock-key-25");
    expect(rendered).not.toContain("/fixtures/skills/example-skill-25");

    const technicalTop = renderTui(
      { ...state, technicalDetails: true },
      plainTuiTheme,
    );
    expect(technicalTop).toContain('"actionId":"update-action-1"');
    expect(technicalTop).toContain('"installationId":"installation-1"');
    expect(technicalTop).toContain('"kind":"network-access"');

    const technicalState = { ...state, technicalDetails: true };
    const details = renderTui(
      {
        ...technicalState,
        scrollOffset: updatePlanScrollMetrics(technicalState).maximumOffset,
      },
      plainTuiTheme,
    );
    expect(details).toContain("Action ID: update-action-25");
    expect(details).toContain("Check ID: update-check-25");
    expect(details).toContain("fixture-lock-key-25");
    expect(details).toContain(
      "• Invocation: npx @fixture/manager@1.2.3 update",
    );
    expect(details).toContain("/fixtures/skills/example-skill-25");
  });

  it("keeps unlike Owner actions and a Plugin boundary in separate summaries", () => {
    const fixture = equivalentInstallationPlan(2);
    const first = fixture.plan.actions[0]!;
    const second = fixture.plan.actions[1]!;
    const unlikePlan: UpdatePlan = {
      ...fixture.plan,
      actions: [
        first,
        {
          ...second,
          operation: {
            ...second.operation,
            source: { id: "other-source", url: "https://example.test/other" },
          },
        },
      ],
    };
    const state = {
      screen: "update-plan" as const,
      browse: {
        inventory: fixture.inventory,
        model: createBrowseModel(createTuiSections(fixture.inventory), {
          rows: 100,
          columns: 80,
        }),
        view: "inventory" as const,
        disabledEntries: [],
      },
      plan: unlikePlan,
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
    };
    const unlike = renderTui(state, plainTuiTheme);
    expect(unlike.match(/• 1 skill/g)).toHaveLength(2);
    expect(unlike).toContain("1 skill from fixture-source");
    expect(unlike).toContain("1 skill from other-source");

    const firstCheck = fixture.plan.verificationChecks[0]!;
    const secondCheck = fixture.plan.verificationChecks[1]!;
    const unlikeVerificationPlan: UpdatePlan = {
      ...fixture.plan,
      warnings: [],
      verificationChecks: [
        firstCheck,
        {
          ...secondCheck,
          currentRevision: [
            {
              kind: "content-hash",
              path: "/fixtures/skills/example-skill-2",
              digest: { algorithm: "sha256", digest: "d".repeat(64) },
            },
          ],
        },
      ],
    };
    const unlikeVerification = renderTui(
      { ...state, plan: unlikeVerificationPlan },
      plainTuiTheme,
    );
    expect(unlikeVerification).toContain("stays installed");

    const pluginTarget = {
      kind: "plugin" as const,
      pluginBoundaryId: "fixture-plugin",
    };
    const pluginPlan: UpdatePlan = {
      ...fixture.plan,
      intent: { target: pluginTarget, force: false },
      targets: [pluginTarget],
      actions: [{ ...first, target: pluginTarget }],
      warnings: [],
      verificationChecks: [],
    };
    expect(
      renderTui(
        { ...state, plan: pluginPlan, label: "fixture-plugin" },
        plainTuiTheme,
      ),
    ).toContain("Plugin fixture-plugin");
  });

  it("maps the Update command and key only from Inventory or Disabled browse", () => {
    for (const state of [
      browseState(),
      { ...browseState(), view: "disabled" as const },
    ]) {
      expect(parseLineTuiAction(state, "update")).toEqual({
        kind: "update-review",
      });
      expect(parseRawTuiAction(state, "u", { name: "u", ctrl: false })).toEqual(
        { kind: "update-review" },
      );
    }
    const trash = { ...browseState(), view: "trash" as const };
    expect(parseLineTuiAction(trash, "update")).toEqual({ kind: "noop" });
    expect(parseRawTuiAction(trash, "u", { name: "u", ctrl: false })).toEqual({
      kind: "noop",
    });
  });

  it("opens one focused or staged Group Update target through Planning", async () => {
    const focused = dependencies(buildInventory());
    const focusedController = new TuiController(focused.value);
    await focusedController.start();
    await focusedController.dispatch({ kind: "update-review" });
    expect(focusedController.state).toMatchObject({
      screen: "update-plan",
      plan: {
        intent: {
          target: { kind: "installation", installationId: "installation-1" },
        },
      },
    });

    const one = buildInstallation({ id: "one" });
    const two = buildInstallation({
      id: "two",
      location: {
        path: "/fixtures/skills/two",
        canonicalPath: "/fixtures/skills/two",
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: "/fixtures/skills/two",
          },
        ],
        weakEvidence: [],
      },
    });
    const groupedInventory = buildInventory({
      installations: [one, two],
      logicalSkills: [
        buildLogicalSkill({
          id: "logical-one",
          identity: one.identity,
          installationIds: [one.id],
          groupId: "group-1",
        }),
        buildLogicalSkill({
          id: "logical-two",
          identity: two.identity,
          installationIds: [two.id],
          groupId: "group-1",
        }),
      ],
      groups: [
        {
          id: "group-1",
          label: "Complete Group",
          tier: "declared",
          evidence: {
            tier: "declared",
            kind: "manager-source",
            managerId: "fixture-manager",
            sourceId: "fixture-source",
          },
          scope: { kind: "user" },
          installationIds: [one.id, two.id],
        },
      ],
    });
    const grouped = dependencies(groupedInventory);
    const groupedController = new TuiController(grouped.value);
    await groupedController.start();
    await groupedController.dispatch({ kind: "toggle-select" });
    await groupedController.dispatch({ kind: "update-review" });
    expect(groupedController.state).toMatchObject({
      screen: "update-plan",
      plan: {
        intent: {
          target: { kind: "source-group", groupId: "group-1" },
        },
      },
    });
    expect(grouped.planner).toHaveBeenCalledOnce();
  });

  it("opens a focused Native Disable target but rejects more than one target", async () => {
    const disabledOne = buildInstallation({
      id: "disabled-one",
      harnessExposures: [
        {
          harnessId: "fixture-agent",
          status: "disabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
      ],
    });
    const disabledTwo = buildInstallation({
      id: "disabled-two",
      location: {
        path: "/fixtures/skills/disabled-two",
        canonicalPath: "/fixtures/skills/disabled-two",
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: "/fixtures/skills/disabled-two",
          },
        ],
        weakEvidence: [],
      },
      harnessExposures: [
        {
          harnessId: "fixture-agent",
          status: "disabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
      ],
    });
    const inventory = buildInventory({
      installations: [disabledOne, disabledTwo],
    });
    const fixture = dependencies(inventory);
    const controller = new TuiController(fixture.value);
    await controller.start();
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "update-review" });
    expect(controller.state).toMatchObject({
      screen: "update-plan",
      plan: {
        intent: {
          target: { kind: "installation", installationId: "disabled-one" },
        },
      },
    });

    const multiple = new TuiController(fixture.value);
    await multiple.start();
    await multiple.dispatch({ kind: "switch-view", view: "disabled" });
    await multiple.dispatch({ kind: "toggle-select" });
    await multiple.dispatch({ kind: "update-review" });
    expect(multiple.state).toMatchObject({
      screen: "browse",
      model: { notice: "Update requires exactly one target." },
    });
  });

  it("directs Suspended targets to Enable and keeps Plugin children and System Skills read-only", async () => {
    const installation = buildInstallation();
    const suspended = suspendedEntry(installation);
    const suspendedFixture = dependencies(
      buildInventory({ installations: [installation] }),
    );
    const suspendedController = new TuiController({
      ...suspendedFixture.value,
      listDisabled: async () => [suspended],
    });
    await suspendedController.start();
    await suspendedController.dispatch({
      kind: "switch-view",
      view: "disabled",
    });
    await suspendedController.dispatch({ kind: "update-review" });
    expect(suspendedController.state).toMatchObject({
      screen: "browse",
      model: { notice: "Enable a Suspended target before Update." },
    });
    expect(suspendedFixture.planner).not.toHaveBeenCalled();

    const child = buildInstallation({
      classification: "managed-plugin-resource",
      plugin: { id: "fixture-plugin", version: "1.0.0" },
      pluginBoundaryId: "fixture-plugin",
      ownership: {
        kind: "plugin",
        pluginId: "fixture-plugin",
        independentlySelectable: false,
        confidence: "declared",
      },
    });
    const pluginFixture = dependencies(
      buildInventory({
        installations: [child],
        plugins: [
          {
            ...buildPluginBoundary(),
            installationIds: [child.id],
          },
        ],
      }),
    );
    const pluginController = new TuiController(pluginFixture.value);
    await pluginController.start();
    await pluginController.dispatch({ kind: "update-review" });
    expect(pluginController.state).toMatchObject({
      screen: "update-plan",
      plan: {
        intent: {
          target: {
            kind: "plugin",
            pluginBoundaryId: "fixture-plugin",
          },
        },
      },
    });
    expect(pluginFixture.planner).toHaveBeenCalledOnce();
    await pluginController.dispatch({ kind: "cancel" });
    pluginFixture.planner.mockClear();
    await pluginController.dispatch({ kind: "focus", pane: "entries" });
    await pluginController.dispatch({ kind: "move", delta: 1 });
    await pluginController.dispatch({ kind: "update-review" });
    expect(pluginController.state).toMatchObject({
      screen: "browse",
      model: {
        notice:
          "Plugin-owned Skills are read-only. Select the complete Plugin.",
      },
    });
    expect(pluginFixture.planner).not.toHaveBeenCalled();

    const systemFixture = dependencies(
      buildInventory({
        installations: [],
        otherFindings: [buildSystemSkillFinding()],
      }),
    );
    const systemController = new TuiController(systemFixture.value);
    await systemController.start();
    await systemController.dispatch({ kind: "update-review" });
    expect(systemController.state).toMatchObject({
      screen: "browse",
      model: { notice: "System Skills are read-only." },
    });
    expect(systemFixture.planner).not.toHaveBeenCalled();
  });

  it("renders the complete Owner boundary and keeps a long Update review scrollable", () => {
    const inventory = buildInventory();
    const planValue = detailedPlan(inventory);
    const model = createBrowseModel(createTuiSections(inventory), {
      rows: 80,
      columns: 120,
    });
    const state = {
      screen: "update-plan" as const,
      browse: {
        inventory,
        model,
        view: "inventory" as const,
        disabledEntries: [],
      },
      plan: planValue,
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
    };
    const defaultRendered = renderTui(state, plainTuiTheme);
    for (const expected of [
      "1 skill",
      "1 skill from fixture-source",
      "After the update",
      "Lampwright cannot undo this update for you",
    ])
      expect(defaultRendered).toContain(expected);
    expect(defaultRendered).not.toContain("Owner record digest");
    const truecolorTheme = createNightfallTheme("truecolor");
    const colored = renderTui(state, truecolorTheme);
    expect(colored).toContain(
      styleTui(truecolorTheme, "title", "Lampwright - Update example-skill"),
    );
    for (const heading of [
      "Review these warnings",
      "Planned updates",
      "Before update",
      "After the update",
    ])
      expect(colored).toContain(styleTui(truecolorTheme, "title", heading));
    for (const warning of [
      "! This update needs internet access.",
      "! Lampwright may download @fixture/manager@1.2.3 before the update.",
      "Lampwright cannot undo this update for you.",
    ])
      expect(colored).toContain(styleTui(truecolorTheme, "warning", warning));
    for (const key of ["y", "d", "Esc", "q"])
      expect(colored).toContain(styleTui(truecolorTheme, "title", key));
    expect(colored).toContain(styleTui(truecolorTheme, "muted", " update · "));
    expect(colored).toContain(
      styleTui(truecolorTheme, "muted", " returns to the previous view · "),
    );
    const top = defaultRendered.split("Review these warnings")[0]!;
    expect(top).not.toContain("Update example-skill?");
    expect(top).not.toContain("READY TO UPDATE");
    expect(top).not.toContain("REVIEW BEFORE UPDATE");
    expect(top).not.toContain("1 skill");

    const rendered = renderTui(
      { ...state, technicalDetails: true },
      plainTuiTheme,
    );
    for (const expected of [
      "Lampwright - Update example-skill",
      "Owner: Manager fixture-manager",
      "Adapter fixture-adapter",
      "selector fixture-lock-key",
      "npx @fixture/manager@1.2.3 update fixture-lock-key --yes",
      "Source: fixture-source (https://example.test/source)",
      "Ref: main",
      "Scope: workspace /fixtures/workspace",
      "json value 1 at /fixtures/manager.json /skills/fixture/revision",
      `Owner record digest: sha256:${"c".repeat(64)}`,
      "mutation-root /fixtures/skills/example-skill",
      "Network: required",
      "@fixture/manager@1.2.3 may download or use a cache",
      `package trust: npx:@fixture/manager@1.2.3:${"a".repeat(64)}`,
      "revision manifest value: json 1 at /fixtures/manager.json /skills/fixture/revision",
      "keeps its strong identity, Owner, source, ref, Scope, boundary, and availability",
      "Lampwright cannot undo this update for you",
    ])
      expect(rendered).toContain(expected);
    expect(rendered.toLowerCase()).not.toContain("up-to-date");

    const compact = {
      ...state,
      browse: {
        ...state.browse,
        model: {
          ...state.browse.model,
          viewport: { rows: 12, columns: 100 },
        },
      },
    };
    const metrics = updatePlanScrollMetrics(compact);
    expect(metrics.maximumOffset).toBeGreaterThan(0);
    expect(renderTui(compact, plainTuiTheme)).toContain("review 1-");
    expect(
      renderTui(
        { ...compact, scrollOffset: metrics.maximumOffset },
        plainTuiTheme,
      ),
    ).toContain("Lampwright cannot undo this update for you");
  });

  it("discloses exact Native Disable and Plugin availability expectations before confirmation", () => {
    const installation = buildInstallation({
      harnessExposures: [
        {
          harnessId: "fixture-agent",
          status: "disabled",
          control: { kind: "unsupported", reason: "fixture" },
        },
      ],
    });
    const inventory = buildInventory({ installations: [installation] });
    const base = detailedPlan(inventory);
    const check = base.verificationChecks[0]!;
    const availabilityExpectation: UpdateAvailabilityExpectation = {
      harnessStatuses: [
        {
          installationId: installation.id,
          strongEvidence: [
            installation.identity.strongEvidence[0]!,
            ...installation.identity.strongEvidence.slice(1),
          ],
          harnessId: "fixture-agent",
          status: "disabled" as const,
        },
      ],
      pluginStatus: null,
    };
    const nativePlan: UpdatePlan = {
      ...base,
      verificationChecks: [{ ...check, availabilityExpectation }],
    };
    const state = {
      screen: "update-plan" as const,
      browse: {
        inventory,
        model: createBrowseModel(createTuiSections(inventory), {
          rows: 80,
          columns: 120,
        }),
        view: "disabled" as const,
        disabledEntries: [],
      },
      plan: nativePlan,
      label: installation.skill.name,
      technicalDetails: false,
      scrollOffset: 0,
    };
    expect(renderTui(state, plainTuiTheme)).toContain(
      "The same skill stays installed, and each app keeps its prior on/off setting.",
    );

    const pluginTarget = {
      kind: "plugin" as const,
      pluginBoundaryId: "fixture-plugin",
    };
    const pluginPlan: UpdatePlan = {
      ...nativePlan,
      intent: { target: pluginTarget, force: false },
      targets: [pluginTarget],
      actions: nativePlan.actions.map((action) => ({
        ...action,
        target: pluginTarget,
      })),
      verificationChecks: [
        {
          ...check,
          target: pluginTarget,
          installationId: null,
          pluginBoundaryId: "fixture-plugin",
          identity: null,
          pluginId: "fixture-plugin",
          availabilityExpectation: {
            ...availabilityExpectation,
            pluginStatus: "enabled",
          },
        },
      ],
    };
    expect(renderTui({ ...state, plan: pluginPlan }, plainTuiTheme)).toContain(
      "The plugin stays installed, and it keeps its prior on/off setting.",
    );
  });

  it("executes through the injected interface and grants shown approvals except Adapter trust", async () => {
    const inventory = buildInventory();
    const planValue = detailedPlan(inventory);
    const executeUpdate = vi.fn(
      async (
        planned: UpdatePlan,
        approvals: readonly ApprovalRequirement[],
      ): Promise<UpdateReport> => {
        void approvals;
        return updateReport(planned);
      },
    );
    const controller = new TuiController({
      scan: async () => inventory,
      plan,
      execute: vi.fn(),
      listDisabled: async () => [],
      planUpdate: () => planValue,
      executeUpdate,
    });
    await controller.start();
    await controller.dispatch({ kind: "update-review" });
    await controller.dispatch({ kind: "confirm" });
    expect(controller.state.screen).toBe("update-executing");
    expect(executeUpdate).not.toHaveBeenCalled();
    expect(renderTui(controller.state, plainTuiTheme)).toContain(
      "Updating example-skill",
    );
    await controller.waitForUpdateExecution();
    expect(controller.state.screen).toBe("update-report");
    expect(executeUpdate.mock.calls[0]![1]).toEqual([
      { kind: "confirmation" },
      {
        kind: "package-trust",
        runner: "npx",
        packageName: "@fixture/manager",
        packageVersion: "1.2.3",
        adapterHash: "a".repeat(64),
      },
    ]);
  });

  it.each([
    "updated",
    "unchanged",
    "partially-updated",
    "blocked",
    "failed",
    "unresolved",
  ] as const)(
    "renders the %s target status without a remote claim",
    (status) => {
      const inventory = buildInventory();
      const planValue = detailedPlan(inventory);
      const state = {
        screen: "update-report" as const,
        browse: {
          inventory,
          model: createBrowseModel(createTuiSections(inventory), {
            rows: 40,
            columns: 110,
          }),
          view: "inventory" as const,
          disabledEntries: [],
        },
        report: updateReport(planValue, status),
        label: "example-skill",
        technicalDetails: false,
        scrollOffset: 0,
      };
      const rendered = renderTui(state, plainTuiTheme);
      const reportLines = rendered.split("\n");
      expect(reportLines[0]?.trimEnd()).toBe(
        "Lampwright - Update example-skill",
      );
      expect(reportLines[1]?.trim()).toBe("");
      expect(reportLines[2]).toContain("example-skill:");
      expect(reportLines[3]?.trim()).toBe("");
      expect(reportLines[4]?.trimEnd()).toBe(
        "d technical details · Esc refreshes Inventory · q quits",
      );
      expect(rendered).not.toContain("Installation Group");
      expect(rendered).not.toContain("Final Inventory scan");
      expect(rendered).not.toContain("verification check");
      expect(rendered).not.toContain("completed");
      expect(rendered).toContain(
        `example-skill: ${status === "updated" ? 1 : 0} updated, ${status === "updated" ? 0 : 1} unchanged${status === "updated" || status === "unchanged" ? "" : ` (${status === "partially-updated" ? "partially updated" : status})`}`,
      );
      expect(rendered.toLowerCase()).not.toContain("up-to-date");
      const truecolorTheme = createNightfallTheme("truecolor");
      const colored = renderTui(state, truecolorTheme);
      const summary = `example-skill: ${status === "updated" ? 1 : 0} updated, ${status === "updated" ? 0 : 1} unchanged${status === "updated" || status === "unchanged" ? "" : ` (${status === "partially-updated" ? "partially updated" : status})`}`;
      expect(colored).toContain(
        styleTui(
          truecolorTheme,
          status === "updated" || status === "unchanged"
            ? "success"
            : status === "partially-updated"
              ? "warning"
              : "error",
          summary,
        ),
      );
      const compact = {
        ...state,
        browse: {
          ...state.browse,
          model: {
            ...state.browse.model,
            viewport: { rows: 9, columns: 90 },
          },
        },
      };
      expect(
        updateReportScrollMetrics(compact).maximumOffset,
      ).toBeGreaterThanOrEqual(0);
    },
  );

  it("uses the shared header and footer styling and keeps report details behind d", () => {
    const inventory = buildInventory();
    const planValue = detailedPlan(inventory);
    const state = {
      screen: "update-report" as const,
      browse: {
        inventory,
        model: createBrowseModel(createTuiSections(inventory), {
          rows: 40,
          columns: 110,
        }),
        view: "inventory" as const,
        disabledEntries: [],
      },
      report: updateReport(planValue, "unchanged"),
      label: "example-skill",
      technicalDetails: false,
      scrollOffset: 0,
    };
    const truecolorTheme = createNightfallTheme("truecolor");
    const rendered = renderTui(state, truecolorTheme);

    expect(rendered).toContain(
      styleTui(truecolorTheme, "title", "Lampwright - Update example-skill"),
    );
    for (const key of ["d", "Esc", "q"])
      expect(rendered).toContain(styleTui(truecolorTheme, "title", key));
    for (const description of [
      " technical details · ",
      " refreshes Inventory · ",
      " quits",
    ])
      expect(rendered).toContain(
        styleTui(truecolorTheme, "muted", description),
      );

    const details = renderTui(
      { ...state, technicalDetails: true },
      plainTuiTheme,
    );
    expect(details).toContain("Technical details");
    expect(details).toContain("Target Installation installation-1: unchanged");
    expect(details).toContain("Final Inventory scan completed.");
    expect(details).toContain(
      "d hide technical details · Esc refreshes Inventory · q quits",
    );
  });

  it("reports updated and unchanged Installation counts for a successful mixed Update", () => {
    const inventory = buildInventory();
    const planValue = detailedPlan(inventory);
    const rendered = renderTui(
      {
        screen: "update-report",
        browse: {
          inventory,
          model: createBrowseModel(createTuiSections(inventory), {
            rows: 40,
            columns: 110,
          }),
          view: "inventory",
          disabledEntries: [],
        },
        report: mixedSuccessfulUpdateReport(planValue),
        label: "example-skill",
        technicalDetails: false,
        scrollOffset: 0,
      },
      plainTuiTheme,
    );

    expect(rendered).toContain("example-skill: 24 updated, 1 unchanged");
  });

  it.each(["unsupported-update", "git-protection", "local-changes"] as const)(
    "does not execute a %s blocked plan",
    async (kind) => {
      const before = buildInventory({ id: "inventory-before" });
      const blockedPlan = {
        ...reviewPlan(before, {
          kind: "installation",
          installationId: before.installations[0]!.id,
        }),
        blocks: [
          {
            kind,
            target: {
              kind: "installation" as const,
              installationId: before.installations[0]!.id,
            },
            installationId: before.installations[0]!.id,
            path: before.installations[0]!.location.path,
            reason: "Local content changed",
            overridable: false as const,
          },
        ],
      };
      const blockedExecute = vi.fn();
      const blocked = new TuiController({
        scan: async () => before,
        plan,
        execute: vi.fn(),
        planUpdate: () => blockedPlan,
        executeUpdate: blockedExecute,
      });
      await blocked.start();
      await blocked.dispatch({ kind: "update-review" });
      expect(renderTui(blocked.state, plainTuiTheme)).toContain(kind);
      await blocked.dispatch({ kind: "toggle-details" });
      const exact = renderTui(blocked.state, plainTuiTheme).replaceAll(
        /\s+/g,
        " ",
      );
      expect(exact).toContain(`"kind":"${kind}"`);
      expect(exact).toContain(
        `"installationId":"${before.installations[0]!.id}"`,
      );
      expect(exact).toContain(
        `"path":"${before.installations[0]!.location.path}"`,
      );
      await blocked.dispatch({ kind: "confirm" });
      expect(blocked.state.screen).toBe("update-plan");
      expect(blockedExecute).not.toHaveBeenCalled();
    },
  );

  it("returns to a fresh startup state after an Update report", async () => {
    const before = buildInventory({ id: "inventory-before" });
    const after = buildInventory({
      id: "inventory-after",
      installations: [],
      logicalSkills: [],
      groups: [],
    });
    let scans = 0;
    const planValue = detailedPlan(before);
    const controller = new TuiController({
      scan: vi.fn(async () => (scans++ === 0 ? before : after)),
      plan,
      execute: vi.fn(),
      listDisabled: async () => [],
      quarantine: { listOperations: async () => [] } as never,
      planUpdate: () => planValue,
      executeUpdate: async () => updateReport(planValue, "updated"),
    });
    await controller.start();
    await controller.dispatch({ kind: "toggle-select" });
    await controller.dispatch({ kind: "switch-view", view: "disabled" });
    await controller.dispatch({ kind: "switch-view", view: "trash" });
    await controller.dispatch({ kind: "cancel" });
    await controller.dispatch({ kind: "update-review" });
    await controller.dispatch({ kind: "confirm" });
    await controller.waitForUpdateExecution();
    await controller.dispatch({ kind: "cancel" });
    const returned = controller.state;
    expect(returned.screen).toBe("browse");
    if (returned.screen !== "browse") throw new Error("Expected browse state");
    expect(returned.model).toEqual(
      createBrowseModel(createTuiSections(after), returned.model.viewport),
    );
    expect(controller.state).toMatchObject({
      screen: "browse",
      inventory: { id: "inventory-after" },
      view: "inventory",
      model: {
        focus: "sections",
        sectionIndex: 0,
        entryIndex: 0,
        selected: new Set(),
        notice: null,
      },
    });
  });
});
