import { describe, expect, it, vi } from "vitest";

import {
  createTuiCatalog,
  parseLineTuiAction,
  plan,
  renderTui,
  runTui,
  TuiController,
  visibleTuiRows,
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
import {
  buildExecutionReport,
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildNonInstallationFinding,
  buildPluginBoundary,
} from "../src/testing/index.js";

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

function distinctInstallation(
  id: string,
  sourceId: string,
  overrides: Parameters<typeof buildInstallation>[0] = {},
): Installation {
  return buildInstallation({
    id,
    skill: { name: "shared-name", description: `${sourceId} description` },
    source: { id: sourceId, url: `https://example.test/${sourceId}` },
    location: {
      path: `/fixtures/${sourceId}/${id}`,
      canonicalPath: `/fixtures/${sourceId}/${id}`,
      artifactType: { kind: "directory" },
    },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "source",
          sourceId,
          skillPath: `skills/${id}`,
        },
      ],
      weakEvidence: [
        { strength: "weak", kind: "name", normalizedName: "shared-name" },
      ],
    },
    ...overrides,
  });
}

function logicalInventory(): Inventory {
  const sharedIdentity = {
    strongEvidence: [
      {
        strength: "strong" as const,
        kind: "source" as const,
        sourceId: "shared-source",
        skillPath: "skills/shared",
      },
    ] as const,
    weakEvidence: [
      {
        strength: "weak" as const,
        kind: "name" as const,
        normalizedName: "shared-skill",
      },
    ],
  };
  const first = buildInstallation({
    id: "installation-a",
    skill: { name: "shared-skill", description: "First physical copy" },
    source: { id: "shared-source", url: null },
    identity: sharedIdentity,
    location: {
      path: "/fixtures/a/shared-skill",
      canonicalPath: "/fixtures/a/shared-skill",
      artifactType: { kind: "directory" },
    },
  });
  const second = buildInstallation({
    id: "installation-b",
    skill: { name: "shared-skill", description: "Second physical copy" },
    source: { id: "shared-source", url: null },
    identity: sharedIdentity,
    location: {
      path: "/fixtures/b/shared-skill",
      canonicalPath: "/fixtures/b/shared-skill",
      artifactType: { kind: "directory" },
    },
  });
  return buildInventory({
    installations: [first, second],
    logicalSkills: [
      buildLogicalSkill({
        id: "logical-shared",
        skill: { name: "shared-skill", description: "Strong identity group" },
        identity: sharedIdentity,
        installationIds: [first.id, second.id],
      }),
    ],
  });
}

function managedInstallation(): Installation {
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
  });
}

describe("terminal inventory catalog", () => {
  it("keeps same-name Installations from different sources visibly separate", () => {
    const inventory = buildInventory({
      installations: [
        distinctInstallation("one", "source-a"),
        distinctInstallation("two", "source-b"),
      ],
    });

    const rows = visibleTuiRows(createTuiCatalog(inventory), new Set(), "");

    expect(
      rows.map((row) => [row.kind, row.name, row.search.source[0]]),
    ).toEqual([
      ["installation", "shared-name", "source-a"],
      ["installation", "shared-name", "source-b"],
    ]);
  });

  it("fuzzy-searches normalized metadata and applies every field filter", () => {
    const installation = distinctInstallation("observability", "catalog", {
      manager: { id: "skill-manager" },
      ownership: {
        kind: "manager",
        managerId: "skill-manager",
        confidence: "declared",
      },
      agentId: "codex",
      scope: { kind: "workspace", workspacePath: "/fixtures/project" },
      metadata: { vendor: { category: "Observabilité" } },
    });
    const pluginInstallation = distinctInstallation(
      "toolkit-skill",
      "registry",
      {
        classification: "managed-plugin-resource",
        plugin: { id: "toolkit", version: "2.0.0" },
        pluginBoundaryId: "toolkit-boundary",
        ownership: {
          kind: "plugin",
          pluginId: "toolkit",
          independentlySelectable: true,
          confidence: "declared",
        },
        agentId: "claude",
      },
    );
    const catalog = createTuiCatalog(
      buildInventory({
        installations: [installation, pluginInstallation],
        plugins: [
          {
            ...buildPluginBoundary(),
            id: "toolkit-boundary",
            pluginId: "toolkit",
            version: "2.0.0",
            installationIds: [pluginInstallation.id],
            ownership: {
              kind: "plugin",
              pluginId: "toolkit",
              independentlySelectable: true,
              confidence: "declared",
            },
          },
        ],
      }),
    );

    for (const [query, count] of [
      ["obsrvblt", 1],
      ["plugin:toolkit", 2],
      ["agent:codex", 1],
      ["scope:workspace", 1],
      ["source:catalog", 1],
      ["manager:skill-manager", 1],
      ["status:active manager:skill-manager", 1],
    ] as const)
      expect(visibleTuiRows(catalog, new Set(), query)).toHaveLength(count);
    expect(visibleTuiRows(catalog, new Set(), "agent:unknown")).toHaveLength(0);
  });

  it("keeps non-installation findings out of ordinary views and exposes them for status inspection", () => {
    const inventory = buildInventory({
      installations: [],
      otherFindings: [buildNonInstallationFinding()],
    });
    const catalog = createTuiCatalog(inventory);

    expect(visibleTuiRows(catalog, new Set(), "source-skill")).toEqual([]);
    expect(
      visibleTuiRows(catalog, new Set(), "status:source-only").map(
        (row) => row.kind,
      ),
    ).toEqual(["finding"]);
  });

  it("selects a Logical Skill as a group or an expanded physical Installation", async () => {
    const inventory = logicalInventory();
    const plannedTargets: RemovalPlan["targets"][] = [];
    const controller = new TuiController({
      scan: async () => inventory,
      plan: (current, intent) => {
        const removalPlan = plan(current, intent);
        plannedTargets.push(removalPlan.targets);
        return removalPlan;
      },
      execute: async () => buildExecutionReport(),
    });

    await controller.start();
    await controller.dispatch({ kind: "select" });
    expect(plannedTargets[0]).toEqual([
      { kind: "logical-skill", logicalSkillId: "logical-shared" },
    ]);
    await controller.dispatch({ kind: "cancel" });
    await controller.dispatch({ kind: "toggle-expand" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "select" });
    expect(plannedTargets[1]).toEqual([
      { kind: "installation", installationId: "installation-a" },
    ]);
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
      query: "",
      expandedKeys: new Set(),
      rows: [],
      cursor: 0,
    };

    expect(parseLineTuiAction(browse, "search manager:skills")).toEqual({
      kind: "set-query",
      value: "manager:skills",
    });
    expect(parseLineTuiAction(browse, "expand")).toEqual({
      kind: "toggle-expand",
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
