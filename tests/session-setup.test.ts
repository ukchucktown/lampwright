import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  SessionSetupValidationError,
  executeSessionSetup,
  planSessionSetup,
  parseSessionSetupPlan,
  parseSessionSetupPublicValue,
  parseSessionSetupSnapshot,
  recoveredSourceProfiles,
  sessionSetupTargetSchema,
  sessionSetupJsonSchema,
} from "../src/session-setup/index.js";
import { createSessionSetupConfigurationWriter } from "../src/execution/index.js";
import {
  buildSessionSetupIntent,
  buildSessionSetupPlan,
  buildSessionSetupReport,
  buildSessionSetupSnapshot,
  buildSessionSetupTarget,
  targetRef,
} from "../src/testing/session-setup-builders.js";
import {
  buildInstallation,
  buildInventory,
  buildPluginBoundary,
} from "../src/testing/model-builders.js";
import type {
  AppBinding,
  McpRegistration,
  PluginTarget,
  SessionSetupSnapshot,
  SessionSetupTarget,
  SetupNativeControl,
  SetupNativeSelector,
  SetupSourceRef,
  SkillHarnessExposure,
  SetupMutation,
} from "../src/session-setup/types.js";

function completeFixture(): {
  readonly snapshot: SessionSetupSnapshot;
  readonly skill: SkillHarnessExposure;
  readonly plugin: PluginTarget;
  readonly mcp: McpRegistration;
  readonly firstApp: AppBinding;
  readonly secondApp: AppBinding;
} {
  const template = buildSessionSetupTarget() as SkillHarnessExposure;
  const base = {
    id: template.id,
    harnessId: template.harnessId,
    workspace: template.workspace,
    name: template.name,
    source: template.source,
    owner: template.owner,
    definitionScope: template.definitionScope,
    state: template.state,
    control: template.control,
  };
  const source = (name: string): SetupSourceRef => ({
    sourceId: `${name}-source`,
    path: `/fixtures/${name}.toml`,
  });
  const control = (
    selector: SetupNativeSelector,
    controlSource: SetupSourceRef,
  ): SetupNativeControl => {
    const layer = {
      ...template.control.layers[0]!,
      source: controlSource,
      canonicalPath: controlSource.path,
    };
    const authority = {
      kind: "configuration" as const,
      source: controlSource,
      layerSourceId: controlSource.sourceId,
      layerCanonicalPath: controlSource.path,
    };
    return {
      selector,
      layers: [layer],
      availability: {
        enable: {
          kind: "available",
          controlScope: { kind: "user" },
          authority,
        },
        disable: {
          kind: "available",
          controlScope: { kind: "user" },
          authority,
        },
      },
    };
  };
  const pluginSource = source("plugin");
  const skillSource = source("skill");
  const mcpSource = source("mcp");
  const appSource = source("app");
  const owner = {
    kind: "plugin" as const,
    pluginBoundaryId: "plugin-boundary",
  };
  const plugin = {
    ...base,
    id: "plugin-target",
    kind: "plugin",
    name: "example-owner",
    source: pluginSource,
    owner,
    pluginBoundaryId: owner.pluginBoundaryId,
    pluginId: "example-plugin",
    childTargetIds: ["skill-target"],
    control: control(
      {
        kind: "plugin-id",
        id: "plugin-selector",
        pluginId: "example-plugin",
        authority: "exact-target",
        governedTargetIds: ["plugin-target"],
      },
      pluginSource,
    ),
  } as const satisfies PluginTarget;
  const skill = {
    ...template,
    id: "skill-target",
    name: "same-name",
    source: skillSource,
    owner,
    installationId: "installation-1",
    control: control(
      {
        kind: "skill-path",
        id: "skill-selector",
        path: "/fixtures/skills/example-skill",
        authority: "exact-target",
        governedTargetIds: ["skill-target"],
      },
      skillSource,
    ),
  } as const satisfies SkillHarnessExposure;
  const mcp = {
    ...base,
    id: "mcp-target",
    kind: "mcp-registration",
    name: "same-name",
    source: mcpSource,
    owner,
    declarationSource: mcpSource,
    serverKey: "same-name",
    requiredAppBindingId: "app-target-a",
    control: control(
      {
        kind: "mcp-server-key",
        id: "mcp-selector",
        serverKey: "same-name",
        policyOwner: { kind: "plugin", pluginId: "example-plugin" },
        authority: "exact-target",
        governedTargetIds: ["mcp-target"],
      },
      mcpSource,
    ),
  } as const satisfies McpRegistration;
  const appSelector = {
    kind: "app-connector-id" as const,
    id: "app-selector",
    connectorId: "connector-1",
    authority: "shared-connector" as const,
    governedTargetIds: ["app-target-a", "app-target-b"] as const,
    collateralComplete: true,
  };
  const firstApp = {
    ...base,
    id: "app-target-a",
    kind: "app-binding",
    name: "first-alias",
    source: appSource,
    owner,
    declarationSource: appSource,
    alias: "first-alias",
    connectorId: "connector-1",
    requiredByTargetIds: ["mcp-target"],
    control: control(appSelector, appSource),
  } as const satisfies AppBinding;
  const secondApp = {
    ...base,
    id: "app-target-b",
    kind: "app-binding",
    name: "second-alias",
    source: appSource,
    owner,
    declarationSource: appSource,
    alias: "second-alias",
    connectorId: "connector-1",
    requiredByTargetIds: [],
    control: control(appSelector, appSource),
  } as const satisfies AppBinding;
  const targets = [plugin, skill, mcp, firstApp, secondApp] as const;
  const profile = recoveredSourceProfiles[0]!;
  const result = (
    resultSource: SetupSourceRef,
    kind: (typeof targets)[number]["kind"],
    targetIds: readonly string[],
  ) => ({
    source: resultSource,
    profileId: profile.id,
    harnessId: "codex" as const,
    kind,
    scope: { kind: "user" as const },
    status: "success" as const,
    reason: null,
    targetIds,
    collateralTargetIds: targetIds,
  });
  const installation = buildInstallation({
    classification: "managed-plugin-resource",
    plugin: { id: "example-plugin", version: "1.0.0" },
    pluginBoundaryId: owner.pluginBoundaryId,
    agentId: "codex",
    exposedTo: ["codex"],
    ownership: {
      kind: "plugin",
      pluginId: "example-plugin",
      independentlySelectable: false,
      confidence: "declared",
    },
  });
  const pluginBoundary = {
    ...buildPluginBoundary({
      id: owner.pluginBoundaryId,
      pluginId: "example-plugin",
      exposedTo: ["codex"],
      ownership: {
        kind: "plugin",
        pluginId: "example-plugin",
        independentlySelectable: false,
        confidence: "declared",
      },
    }),
    installationIds: [installation.id],
  };
  const dependency = {
    kind: "hard" as const,
    dependent: targetRef(mcp),
    required: targetRef(firstApp),
    reason: "the MCP descriptor requires this App Binding",
  };
  const snapshot = buildSessionSetupSnapshot({
    harnesses: ["codex", "claude-code"],
    targets,
    sources: [
      result(pluginSource, "plugin", [plugin.id]),
      result(skillSource, "skill-exposure", [skill.id]),
      result(mcpSource, "mcp-registration", [mcp.id]),
      result(appSource, "app-binding", [firstApp.id, secondApp.id]),
      {
        source: { sourceId: "claude-account-apps", path: null },
        profileId: recoveredSourceProfiles[1]!.id,
        harnessId: "claude-code",
        kind: "app-binding",
        scope: { kind: "user" },
        status: "unavailable",
        reason: "no qualified authoritative offline provider",
        targetIds: [],
        collateralTargetIds: [],
      },
      {
        source: { sourceId: "invalid-source", path: null },
        profileId: profile.id,
        harnessId: "codex",
        kind: "mcp-registration",
        scope: { kind: "user" },
        status: "invalid",
        reason: "malformed fixture",
        targetIds: [],
        collateralTargetIds: [],
      },
      {
        source: { sourceId: "incomplete-source", path: null },
        profileId: profile.id,
        harnessId: "codex",
        kind: "mcp-registration",
        scope: { kind: "user" },
        status: "incomplete",
        reason: "partial fixture",
        targetIds: [],
        collateralTargetIds: [],
      },
    ],
    profiles: [profile, recoveredSourceProfiles[1]!],
    dependencies: [dependency],
    legacyInventory: buildInventory({
      installations: [installation],
      plugins: [pluginBoundary],
    }),
  });
  return { snapshot, skill, plugin, mcp, firstApp, secondApp };
}

describe("session setup contracts", () => {
  it("round-trips an immutable snapshot and all recovered baseline profiles", () => {
    const snapshot = buildSessionSetupSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.targets[0]?.kind).toBe("skill-exposure");
    expect(
      recoveredSourceProfiles.map((profile) => profile.sourceVersion),
    ).toEqual(["0.154.0", "2.1.270", "0.59.0"]);
    expect(Object.isFrozen(recoveredSourceProfiles)).toBe(true);
    expect(recoveredSourceProfiles.every(Object.isFrozen)).toBe(true);
  });

  it("rejects duplicate ids and forged plan mutation references", () => {
    const snapshot = buildSessionSetupSnapshot();
    expect(() =>
      parseSessionSetupSnapshot({
        ...snapshot,
        targets: [snapshot.targets[0], snapshot.targets[0]],
      }),
    ).toThrow(SessionSetupValidationError);
    const plan = buildSessionSetupPlan();
    expect(() =>
      parseSessionSetupPlan({
        ...plan,
        actions: [
          {
            ...plan.actions[0],
            mutations: [
              { ...plan.actions[0]!.mutations[0], selectorId: "missing" },
            ],
          },
        ],
      }),
    ).toThrow(SessionSetupValidationError);
    expect(() =>
      parseSessionSetupPlan({
        ...plan,
        actions: [
          {
            ...plan.actions[0],
            approvals: [{ kind: "confirmation", required: true }],
          },
        ],
      }),
    ).toThrow(SessionSetupValidationError);
    expect(() =>
      parseSessionSetupPlan({
        ...plan,
        actions: [
          plan.actions[0],
          { ...plan.actions[0], id: "duplicate-selector-action" },
        ],
      }),
    ).toThrow(SessionSetupValidationError);
  });

  it("rejects MCP selector owners that disagree with their declaration owner", () => {
    const { snapshot, mcp } = completeFixture();
    const standalone = {
      ...mcp,
      owner: { kind: "standalone" as const },
      control: {
        ...mcp.control,
        selector: {
          ...mcp.control.selector,
          policyOwner: { kind: "plugin" as const, pluginId: "example-plugin" },
        },
      },
    };
    expect(() =>
      replaceTargets(snapshot, [
        ...snapshot.targets.filter((target) => target.id !== mcp.id),
        standalone,
      ]),
    ).toThrow(SessionSetupValidationError);
    const mismatchedPlugin = {
      ...mcp,
      control: {
        ...mcp.control,
        selector: {
          ...mcp.control.selector,
          policyOwner: { kind: "plugin" as const, pluginId: "another-plugin" },
        },
      },
    };
    expect(() =>
      replaceTargets(snapshot, [
        ...snapshot.targets.filter((target) => target.id !== mcp.id),
        mismatchedPlugin,
      ]),
    ).toThrow(SessionSetupValidationError);
  });

  it("parses all target kinds, shared connector collateral, owner gates, and dependencies", () => {
    const { snapshot, skill, plugin, mcp, firstApp, secondApp } =
      completeFixture();
    expect(snapshot.targets.map((target) => target.kind)).toEqual([
      "plugin",
      "skill-exposure",
      "mcp-registration",
      "app-binding",
      "app-binding",
    ]);
    expect(firstApp.control.selector.governedTargetIds).toEqual([
      firstApp.id,
      secondApp.id,
    ]);
    expect(skill.name).toBe(mcp.serverKey);
    expect(skill.id).not.toBe(mcp.id);
    expect(snapshot.sources.map((source) => source.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
      "unavailable",
      "invalid",
      "incomplete",
    ]);

    const plan = parseSessionSetupPlan({
      schemaVersion: 1,
      kind: "session-setup-plan",
      id: "blocked-plan",
      snapshotId: snapshot.id,
      snapshotFingerprint: snapshot.semanticFingerprint,
      createdAt: "2026-01-01T00:01:00.000Z",
      intent: {
        schemaVersion: 1,
        kind: "session-setup-intent",
        action: "enable",
        harnessId: "codex",
        workspace: snapshot.workspace,
        targets: [targetRef(skill), targetRef(mcp)],
      },
      targets: snapshot.targets,
      actions: [],
      blocks: [
        {
          kind: "owner-gate",
          target: targetRef(skill),
          owner: targetRef(plugin),
        },
        {
          kind: "hard-dependency",
          target: targetRef(mcp),
          dependency: snapshot.dependencies[0],
        },
      ],
      warnings: [],
      verifications: [],
      errors: [],
    });
    expect(plan.blocks.map((block) => block.kind)).toEqual([
      "owner-gate",
      "hard-dependency",
    ]);

    const missing = {
      kind: "mcp-registration" as const,
      targetId: "missing-mcp",
      declarationSourceId: "missing-source",
      serverKey: "missing-server",
    };
    expect(
      parseSessionSetupPlan({
        ...plan,
        id: "missing-target-plan",
        intent: { ...plan.intent, targets: [missing] },
        targets: [],
        blocks: [{ kind: "missing-target", target: missing }],
      }).blocks[0]?.kind,
    ).toBe("missing-target");
  });

  it("rejects unknown sources, secret payloads, and mutation authority forgery", () => {
    const snapshot = buildSessionSetupSnapshot();
    expect(() =>
      parseSessionSetupSnapshot({
        ...snapshot,
        targets: [
          {
            ...snapshot.targets[0],
            source: { sourceId: "missing", path: null },
          },
        ],
      }),
    ).toThrow(SessionSetupValidationError);
    expect(
      sessionSetupTargetSchema.safeParse({
        ...snapshot.targets[0],
        secret: "not-public",
      }).success,
    ).toBe(false);
    const plan = buildSessionSetupPlan();
    const mutation = plan.actions[0]!.mutations[0]!;
    const forged = {
      ...mutation,
      authority: {
        ...mutation.authority,
        source: { sourceId: "forged", path: "/tmp/forged" },
      },
    };
    expect(() =>
      parseSessionSetupPlan({
        ...plan,
        actions: [{ ...plan.actions[0]!, mutations: [forged] }],
      }),
    ).toThrow(SessionSetupValidationError);
  });

  it("rejects malformed nested references, incomplete collateral, and forged snapshot authority", () => {
    const { snapshot, skill, mcp, firstApp } = completeFixture();
    expect(() =>
      parseSessionSetupSnapshot({
        ...snapshot,
        targets: snapshot.targets.map((target) =>
          target.id === skill.id
            ? {
                ...target,
                control: {
                  ...target.control,
                  availability: {
                    ...target.control.availability,
                    enable: {
                      ...target.control.availability.enable,
                      authority: {
                        kind: "configuration",
                        source: target.source,
                        layerSourceId: target.source.sourceId,
                        layerCanonicalPath: "/fixtures/forged.toml",
                      },
                    },
                  },
                },
              }
            : target,
        ),
      }),
    ).toThrow(SessionSetupValidationError);
    expect(() =>
      parseSessionSetupSnapshot({
        ...snapshot,
        targets: snapshot.targets.map((target) =>
          target.id === firstApp.id
            ? {
                ...target,
                control: {
                  ...target.control,
                  availability: {
                    ...target.control.availability,
                    enable: {
                      kind: "available",
                      controlScope: { kind: "user" },
                      authority: {
                        kind: "native-command",
                        executable: "fixture-app",
                        arguments: ["enable", firstApp.connectorId],
                        source: firstApp.source,
                        scope: { kind: "user" },
                        effects: [
                          {
                            selectorId: firstApp.control.selector.id,
                            targets: [targetRef(firstApp)],
                          },
                        ],
                      },
                    },
                  },
                },
              }
            : target,
        ),
      }),
    ).toThrow(SessionSetupValidationError);
    expect(() =>
      parseSessionSetupSnapshot({
        ...snapshot,
        targets: snapshot.targets.map((target) =>
          target.id === firstApp.id
            ? {
                ...target,
                control: {
                  ...target.control,
                  selector: {
                    ...target.control.selector,
                    governedTargetIds: [firstApp.id],
                  },
                },
              }
            : target,
        ),
      }),
    ).toThrow(SessionSetupValidationError);
    expect(() =>
      parseSessionSetupSnapshot({
        ...snapshot,
        dependencies: [
          {
            ...snapshot.dependencies[0],
            required: {
              ...targetRef(firstApp),
              alias: "forged-alias",
            },
          },
        ],
      }),
    ).toThrow(SessionSetupValidationError);
    expect(mcp.requiredAppBindingId).toBe(firstApp.id);
  });

  it("accepts safe Windows executable paths and omits secret sentinels", () => {
    const target = buildSessionSetupTarget() as SkillHarnessExposure;
    const ref = targetRef(target);
    const commandTarget = {
      ...target,
      control: {
        ...target.control,
        availability: {
          ...target.control.availability,
          enable: {
            kind: "available" as const,
            controlScope: { kind: "user" as const },
            authority: {
              kind: "native-command" as const,
              executable: "C:\\Program Files\\Fixture\\fixture.exe",
              arguments: ["enable", target.id] as const,
              source: target.source,
              scope: { kind: "user" as const },
              effects: [
                {
                  selectorId: target.control.selector.id,
                  targets: [ref] as const,
                },
              ] as const,
            },
          },
        },
      },
    } satisfies SkillHarnessExposure;
    expect(sessionSetupTargetSchema.safeParse(commandTarget).success).toBe(
      true,
    );
    const commandSnapshot = buildSessionSetupSnapshot({
      targets: [commandTarget],
    });
    expect(commandSnapshot.targets[0]?.control.availability.enable.kind).toBe(
      "available",
    );
    const sentinel = "SECRET_SENTINEL_149";
    let error: unknown;
    try {
      parseSessionSetupSnapshot({
        ...buildSessionSetupSnapshot(),
        secret: sentinel,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SessionSetupValidationError);
    expect(String(error)).not.toContain(sentinel);
    expect(JSON.stringify(completeFixture().snapshot)).not.toContain(sentinel);
  });

  it("serializes validated public values deterministically and dispatches semantic parsing", () => {
    const snapshot = completeFixture().snapshot;
    expect(JSON.stringify(parseSessionSetupPublicValue(snapshot))).toBe(
      JSON.stringify(parseSessionSetupSnapshot(snapshot)),
    );
    expect(JSON.stringify(completeFixture().snapshot)).toBe(
      JSON.stringify(snapshot),
    );
    expect(() =>
      parseSessionSetupPublicValue({
        ...snapshot,
        targets: [snapshot.targets[0], snapshot.targets[0]],
      }),
    ).toThrow(SessionSetupValidationError);
  });

  it("publishes the exact generated schema accepted by AJV", () => {
    const schema = JSON.parse(
      readFileSync(resolve("schemas/session-setup-v1.schema.json"), "utf8"),
    ) as object;
    expect(schema).toEqual(sessionSetupJsonSchema());
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(buildSessionSetupSnapshot())).toBe(true);
    expect(validate(completeFixture().snapshot)).toBe(true);
    expect(validate(buildSessionSetupPlan())).toBe(true);
    expect(validate(buildSessionSetupIntent())).toBe(true);
    expect(validate(buildSessionSetupReport())).toBe(true);
  });
});

function setupIntent(
  snapshot: SessionSetupSnapshot,
  action: "enable" | "disable",
  targets: readonly [
    ReturnType<typeof targetRef>,
    ...ReturnType<typeof targetRef>[],
  ],
) {
  return buildSessionSetupIntent({
    action,
    harnessId: "codex",
    workspace: snapshot.workspace,
    targets,
  });
}

function withTargetState<T extends SessionSetupTarget>(
  target: T,
  policy: "enabled" | "disabled" | "unresolved",
  effectiveWorkspaceState: "enabled" | "disabled" | "unresolved" = policy,
): T {
  return {
    ...target,
    state: { ...target.state, policy, effectiveWorkspaceState },
  };
}

function replaceTargets(
  snapshot: SessionSetupSnapshot,
  targets: readonly SessionSetupTarget[],
  overrides: Partial<SessionSetupSnapshot> = {},
): SessionSetupSnapshot {
  return parseSessionSetupSnapshot({ ...snapshot, targets, ...overrides });
}

function grantsFor(plan: ReturnType<typeof planSessionSetup>) {
  return {
    grants: [
      ...new Map(
        plan.actions
          .flatMap((action) => action.approvals)
          .map((approval) => [JSON.stringify(approval), approval]),
      ).values(),
    ],
  };
}

describe("session setup planning and execution", () => {
  it("keeps distinct missing configuration documents in separate actions", () => {
    const fixture = completeFixture();
    const withMissingDocument = <T extends SessionSetupTarget>(
      target: T,
    ): T => {
      const source = target.control.layers[0]!.source;
      const layer = {
        ...target.control.layers[0]!,
        exists: false,
        canonicalPath: null,
        expectedPreimage: null,
        integrity: "missing" as const,
        protection: {
          git: { kind: "outside-worktree" as const },
          system: { kind: "none" as const },
          filesystem: { kind: "writable" as const },
        },
      };
      const operation = {
        kind: "available" as const,
        controlScope: { kind: "user" as const },
        authority: {
          kind: "configuration" as const,
          source,
          layerSourceId: source.sourceId,
          layerCanonicalPath: source.path,
        },
      };
      return {
        ...target,
        control: {
          ...target.control,
          layers: [layer],
          availability: { enable: operation, disable: operation },
        },
      };
    };
    const plugin = withMissingDocument(fixture.plugin);
    const skill = withMissingDocument(fixture.skill);
    const snapshot = replaceTargets(fixture.snapshot, [
      plugin,
      skill,
      fixture.mcp,
      fixture.firstApp,
      fixture.secondApp,
    ]);

    const plan = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "disable", [targetRef(plugin), targetRef(skill)]),
    );

    expect(plan.blocks).toEqual([]);
    expect(plan.actions).toHaveLength(2);
    expect(
      plan.actions.map(
        (action) =>
          (
            action.mutations[0] as Extract<
              SetupMutation,
              { kind: "configuration" }
            >
          ).authority.layerCanonicalPath,
      ),
    ).toEqual([plugin.source.path, skill.source.path].sort());
  });

  it("plans one selected exposure with complete native scope and activation disclosure", () => {
    const snapshot = buildSessionSetupSnapshot();
    const target = snapshot.targets[0]!;
    const plan = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "disable", [targetRef(target)]),
    );

    expect(plan.blocks).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.targets).toEqual([targetRef(target)]);
    expect(plan.actions[0]!.mutations).toEqual([
      expect.objectContaining({
        kind: "configuration",
        selectorId: target.control.selector.id,
        policy: "disabled",
      }),
    ]);
    expect(plan.actions[0]!.approvals).toEqual([
      { kind: "confirmation", required: true },
      { kind: "scope-disclosure", scope: { kind: "user" }, required: true },
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        {
          kind: "control-scope",
          target: targetRef(target),
          scope: { kind: "user" },
        },
        {
          kind: "activation",
          target: targetRef(target),
          activation: "new-session",
        },
      ]),
    );
    expect(plan.verifications.map((item) => item.kind)).toEqual([
      "native-policy",
      "effective-workspace-state",
      "new-session-required",
    ]);
    expect(JSON.stringify(plan)).not.toContain("disabled-storage");
  });

  it("enforces owner gates while preserving independent child policies", () => {
    const fixture = completeFixture();
    const plugin = withTargetState(fixture.plugin, "disabled", "disabled");
    const skill = withTargetState(fixture.skill, "disabled", "disabled");
    const snapshot = replaceTargets(fixture.snapshot, [
      plugin,
      skill,
      fixture.mcp,
      fixture.firstApp,
      fixture.secondApp,
    ]);

    const blocked = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "enable", [targetRef(skill)]),
    );
    expect(blocked.blocks).toEqual([
      {
        kind: "owner-gate",
        target: targetRef(skill),
        owner: targetRef(plugin),
      },
    ]);
    expect(blocked.actions).toEqual([]);

    const enabled = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "enable", [targetRef(plugin), targetRef(skill)]),
    );
    const pluginAction = enabled.actions.find((action) =>
      action.targets.some((target) => target.targetId === plugin.id),
    )!;
    const skillAction = enabled.actions.find((action) =>
      action.targets.some((target) => target.targetId === skill.id),
    )!;
    expect(skillAction.dependsOn).toEqual([pluginAction.id]);

    const disabledChild = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "disable", [targetRef(skill)]),
    );
    expect(disabledChild.blocks).toEqual([]);
    expect(disabledChild.actions[0]!.mutations[0]).toEqual(
      expect.objectContaining({
        selectorId: skill.control.selector.id,
        policy: "disabled",
      }),
    );

    const wholePlugin = planSessionSetup(
      fixture.snapshot,
      setupIntent(fixture.snapshot, "disable", [targetRef(fixture.plugin)]),
    );
    expect(wholePlugin.targets.map((target) => target.id)).toEqual(
      expect.arrayContaining([
        fixture.plugin.id,
        fixture.skill.id,
        fixture.mcp.id,
        fixture.firstApp.id,
        fixture.secondApp.id,
      ]),
    );
    expect(wholePlugin.actions.flatMap((action) => action.mutations)).toEqual([
      expect.objectContaining({
        selectorId: fixture.plugin.control.selector.id,
      }),
    ]);
  });

  it("discloses shared connector collateral and schedules hard dependencies safely", () => {
    const fixture = completeFixture();
    const blocked = planSessionSetup(
      fixture.snapshot,
      setupIntent(fixture.snapshot, "disable", [targetRef(fixture.firstApp)]),
    );
    expect(blocked.blocks.map((block) => block.kind)).toContain(
      "hard-dependency",
    );
    expect(blocked.targets.map((target) => target.id)).toEqual(
      expect.arrayContaining([fixture.firstApp.id, fixture.secondApp.id]),
    );

    const ordered = planSessionSetup(
      fixture.snapshot,
      setupIntent(fixture.snapshot, "disable", [
        targetRef(fixture.mcp),
        targetRef(fixture.firstApp),
      ]),
    );
    expect(ordered.blocks).toEqual([]);
    const mcpAction = ordered.actions.find((action) =>
      action.targets.some((target) => target.targetId === fixture.mcp.id),
    )!;
    const appAction = ordered.actions.find((action) =>
      action.targets.some((target) => target.targetId === fixture.firstApp.id),
    )!;
    expect(appAction.dependsOn).toEqual([mcpAction.id]);
    expect(
      appAction.mutations.filter(
        (mutation) =>
          mutation.selectorId === fixture.firstApp.control.selector.id,
      ),
    ).toHaveLength(1);

    const appPath = fixture.firstApp.control.layers[0]!.canonicalPath;
    const mcp = {
      ...fixture.mcp,
      control: {
        ...fixture.mcp.control,
        layers: fixture.mcp.control.layers.map((layer) => ({
          ...layer,
          canonicalPath: appPath,
        })),
        availability: {
          enable: {
            kind: "available" as const,
            controlScope: { kind: "user" as const },
            authority: {
              kind: "configuration" as const,
              source: fixture.mcp.source,
              layerSourceId: fixture.mcp.source.sourceId,
              layerCanonicalPath: appPath,
            },
          },
          disable: {
            kind: "available" as const,
            controlScope: { kind: "user" as const },
            authority: {
              kind: "configuration" as const,
              source: fixture.mcp.source,
              layerSourceId: fixture.mcp.source.sourceId,
              layerCanonicalPath: appPath,
            },
          },
        },
      },
    } satisfies McpRegistration;
    const atomicSnapshot = replaceTargets(fixture.snapshot, [
      fixture.plugin,
      fixture.skill,
      mcp,
      fixture.firstApp,
      fixture.secondApp,
    ]);
    const atomic = planSessionSetup(
      atomicSnapshot,
      setupIntent(atomicSnapshot, "disable", [
        targetRef(mcp),
        targetRef(fixture.firstApp),
      ]),
    );
    expect(atomic.actions).toHaveLength(1);
    expect(atomic.actions[0]!.mutations).toHaveLength(2);
    expect(atomic.actions[0]!.dependsOn).toEqual([]);

    const ownerSnapshot = replaceTargets(fixture.snapshot, [
      withTargetState(fixture.plugin, "disabled", "disabled"),
      fixture.skill,
      withTargetState(fixture.mcp, "enabled", "disabled"),
      withTargetState(fixture.firstApp, "disabled", "disabled"),
      withTargetState(fixture.secondApp, "disabled", "disabled"),
    ]);
    const unsafeOwnerEnable = planSessionSetup(
      ownerSnapshot,
      setupIntent(ownerSnapshot, "enable", [targetRef(fixture.plugin)]),
    );
    expect(unsafeOwnerEnable.blocks.map((block) => block.kind)).toContain(
      "hard-dependency",
    );
  });

  it("blocks ambiguous names, incomplete sources, and protected configuration", () => {
    const initial = buildSessionSetupSnapshot();
    const first = initial.targets[0] as SkillHarnessExposure;
    const secondInstallation = buildInstallation({
      id: "installation-2" as never,
      exposedTo: ["codex"],
    });
    const secondSource = {
      sourceId: "fixture-source-2",
      path: "/fixtures/config-2.toml",
    };
    const second = {
      ...first,
      id: "setup-target-2",
      installationId: secondInstallation.id,
      source: secondSource,
      control: {
        ...first.control,
        selector: {
          kind: "skill-path" as const,
          id: "selector-skill-2",
          path: "/fixtures/skills/example-skill-2",
          authority: "exact-target" as const,
          governedTargetIds: ["setup-target-2"] as [string],
        },
        layers: [
          {
            ...first.control.layers[0]!,
            source: secondSource,
            canonicalPath: secondSource.path,
            protection: {
              ...first.control.layers[0]!.protection,
              git: { kind: "protected" as const, worktreeRoot: "/fixtures" },
            },
          },
        ],
        availability: {
          enable: {
            kind: "available" as const,
            controlScope: { kind: "user" as const },
            authority: {
              kind: "configuration" as const,
              source: secondSource,
              layerSourceId: secondSource.sourceId,
              layerCanonicalPath: secondSource.path,
            },
          },
          disable: {
            kind: "available" as const,
            controlScope: { kind: "user" as const },
            authority: {
              kind: "configuration" as const,
              source: secondSource,
              layerSourceId: secondSource.sourceId,
              layerCanonicalPath: secondSource.path,
            },
          },
        },
      },
    } satisfies SkillHarnessExposure;
    const snapshot = buildSessionSetupSnapshot({
      targets: [first, second],
      sources: [
        initial.sources[0]!,
        {
          source: secondSource,
          profileId: initial.profiles[0]!.id,
          harnessId: "codex",
          kind: "skill-exposure",
          scope: { kind: "user" },
          status: "incomplete",
          reason: "fixture discovery is partial",
          targetIds: [second.id],
          collateralTargetIds: [second.id],
        },
      ],
      legacyInventory: buildInventory({
        installations: [
          initial.legacyInventory.installations[0]!,
          secondInstallation,
        ],
      }),
    });
    const plan = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "disable", [targetRef(second)]),
    );
    expect(plan.blocks.map((block) => block.kind)).toEqual(
      expect.arrayContaining([
        "selector-collision",
        "source-incomplete",
        "protected",
      ]),
    );
    expect(plan.actions).toEqual([]);
  });

  it("fresh-scans, verifies saved and effective state, and audits attempted writes", async () => {
    const initial = buildSessionSetupSnapshot();
    const target = initial.targets[0]!;
    const final = replaceTargets(
      initial,
      [withTargetState(target, "disabled", "disabled")],
      { id: "setup-snapshot-final" },
    );
    const plan = planSessionSetup(
      initial,
      setupIntent(initial, "disable", [targetRef(target)]),
    );
    let scans = 0;
    let commits = 0;
    const audits: unknown[] = [];
    const report = await executeSessionSetup(plan, grantsFor(plan), {
      scan: async () => (scans++ === 0 ? initial : final),
      replan: planSessionSetup,
      configurationWriter: {
        async prepare() {
          return { token: "prepared", status: "changed" };
        },
        async commit() {
          commits += 1;
        },
        async discard() {},
      },
      processRunner: {
        async run() {
          throw new Error("unexpected command");
        },
      },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: {
        async write(record) {
          audits.push(record);
        },
      },
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    });

    expect(commits).toBe(1);
    expect(audits).toHaveLength(1);
    expect(report.status).toBe("succeeded");
    expect(report.targetResults).toEqual([
      { target: targetRef(target), status: "disabled" },
    ]);
    expect(report.verificationResults).toEqual([
      { verificationId: `policy:${target.id}`, status: "passed" },
      { verificationId: `effective:${target.id}`, status: "passed" },
      { verificationId: `activation:${target.id}`, status: "passed" },
    ]);
  });

  it("rejects stale or unapproved authority without writes or audit state", async () => {
    const initial = buildSessionSetupSnapshot();
    const target = initial.targets[0]!;
    const plan = planSessionSetup(
      initial,
      setupIntent(initial, "disable", [targetRef(target)]),
    );
    const stale = replaceTargets(initial, initial.targets, {
      id: "new-snapshot",
      semanticFingerprint: {
        algorithm: "sha256",
        digest: "1".repeat(64),
      },
    });
    let prepares = 0;
    let audits = 0;
    const dependencies = {
      replan: planSessionSetup,
      configurationWriter: {
        async prepare() {
          prepares += 1;
          return { token: "prepared", status: "changed" as const };
        },
        async commit() {},
        async discard() {},
      },
      processRunner: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }) as const,
      auditWriter: {
        async write() {
          audits += 1;
        },
      },
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    };
    const staleReport = await executeSessionSetup(plan, grantsFor(plan), {
      ...dependencies,
      scan: async () => stale,
    });
    expect(staleReport.status).toBe("blocked");
    expect(prepares).toBe(0);
    expect(audits).toBe(0);

    let scans = 0;
    const unapproved = await executeSessionSetup(
      plan,
      { grants: [] },
      {
        ...dependencies,
        scan: async () => {
          scans += 1;
          return initial;
        },
      },
    );
    expect(scans).toBe(2);
    expect(unapproved.status).toBe("blocked");
    expect(prepares).toBe(0);
    expect(audits).toBe(0);

    await expect(
      executeSessionSetup(
        plan,
        {
          grants: [
            ...grantsFor(plan).grants,
            {
              kind: "confirmation",
              required: true,
              secret: "SECRET_APPROVAL",
            } as never,
          ],
        },
        { ...dependencies, scan: async () => initial },
      ),
    ).rejects.toThrow("invalid grant");
    expect(prepares).toBe(0);
    expect(audits).toBe(0);
  });

  it("continues independent commands, blocks dependents, and never falls back", async () => {
    const fixture = completeFixture();
    const byId = new Map(
      fixture.snapshot.targets.map((target) => [target.id, target]),
    );
    const commandTarget = <T extends SessionSetupTarget>(
      target: T,
      executable: string,
    ): T => {
      const effects = target.control.selector.governedTargetIds.map((id) =>
        targetRef(byId.get(id)!),
      ) as [ReturnType<typeof targetRef>, ...ReturnType<typeof targetRef>[]];
      return {
        ...target,
        control: {
          ...target.control,
          availability: {
            ...target.control.availability,
            disable: {
              kind: "available" as const,
              controlScope: { kind: "user" as const },
              authority: {
                kind: "native-command" as const,
                executable,
                arguments: ["disable", target.control.selector.id],
                source: target.source,
                scope: { kind: "user" as const },
                effects: [
                  {
                    selectorId: target.control.selector.id,
                    targets: effects,
                  },
                ],
              },
            },
          },
        },
      } as T;
    };
    const skill = commandTarget(fixture.skill, "independent-command");
    const mcp = commandTarget(fixture.mcp, "failing-command");
    const firstApp = commandTarget(fixture.firstApp, "dependent-command");
    const snapshot = replaceTargets(fixture.snapshot, [
      fixture.plugin,
      skill,
      mcp,
      firstApp,
      fixture.secondApp,
    ]);
    const plan = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "disable", [
        targetRef(skill),
        targetRef(mcp),
        targetRef(firstApp),
      ]),
    );
    const final = replaceTargets(
      snapshot,
      [
        fixture.plugin,
        withTargetState(skill, "disabled", "disabled"),
        mcp,
        firstApp,
        fixture.secondApp,
      ],
      { id: "command-final" },
    );
    const commands: string[] = [];
    let scans = 0;
    let writerCalls = 0;
    const audits: unknown[] = [];
    const secret = "SECRET_COMMAND_STDERR";
    const report = await executeSessionSetup(plan, grantsFor(plan), {
      scan: async () => (scans++ === 0 ? snapshot : final),
      replan: planSessionSetup,
      configurationWriter: {
        async prepare() {
          writerCalls += 1;
          throw new Error("configuration fallback must not run");
        },
        async commit() {},
        async discard() {},
      },
      processRunner: {
        async run(request) {
          commands.push(request.command.executable);
          return request.command.executable === "failing-command"
            ? { exitCode: 1, stdout: secret, stderr: secret }
            : { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: {
        async write(record) {
          audits.push(record);
        },
      },
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    });

    expect(commands).toEqual(
      expect.arrayContaining(["independent-command", "failing-command"]),
    );
    expect(commands).not.toContain("dependent-command");
    expect(writerCalls).toBe(0);
    expect(audits).toHaveLength(1);
    expect(report.status).toBe("partial");
    expect(report.targetResults).toEqual(
      expect.arrayContaining([
        { target: targetRef(skill), status: "disabled" },
        expect.objectContaining({
          target: targetRef(mcp),
          status: "failed",
        }),
        expect.objectContaining({
          target: targetRef(firstApp),
          status: "blocked",
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(audits)).not.toContain(secret);
  });

  it("reports successful mutations as unverified when the final scan fails", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const target = snapshot.targets[0]!;
    const plan = planSessionSetup(
      snapshot,
      setupIntent(snapshot, "disable", [targetRef(target)]),
    );
    let scans = 0;
    const audits: unknown[] = [];
    const report = await executeSessionSetup(plan, grantsFor(plan), {
      scan: async () => {
        if (scans++ === 0) return snapshot;
        throw new Error("SECRET_RESCAN_FAILURE");
      },
      replan: planSessionSetup,
      configurationWriter: {
        async prepare() {
          return { token: "prepared", status: "changed" };
        },
        async commit() {},
        async discard() {},
      },
      processRunner: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      inspectGitProtection: async () => ({ kind: "outside-worktree" }),
      auditWriter: {
        async write(record) {
          audits.push(record);
        },
      },
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    });
    expect(report.status).toBe("partial");
    expect(report.finalSnapshotId).toBeNull();
    expect(report.targetResults).toEqual([
      expect.objectContaining({
        target: targetRef(target),
        status: "unverified",
      }),
    ]);
    expect(
      report.verificationResults.every((item) => item.status === "skipped"),
    ).toBe(true);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("SECRET_RESCAN_FAILURE");
  });

  it("distinguishes unchanged policy and rejects runtime Git protection", async () => {
    const initial = buildSessionSetupSnapshot();
    const target = initial.targets[0]!;
    const unchangedSnapshot = replaceTargets(initial, [
      withTargetState(target, "disabled", "disabled"),
    ]);
    const unchangedPlan = planSessionSetup(
      unchangedSnapshot,
      setupIntent(unchangedSnapshot, "disable", [targetRef(target)]),
    );
    let prepares = 0;
    let commits = 0;
    let audits = 0;
    const unchanged = await executeSessionSetup(
      unchangedPlan,
      grantsFor(unchangedPlan),
      {
        scan: async () => unchangedSnapshot,
        replan: planSessionSetup,
        configurationWriter: {
          async prepare() {
            prepares += 1;
            return { token: "unchanged", status: "unchanged" };
          },
          async commit() {
            commits += 1;
          },
          async discard() {},
        },
        processRunner: {
          async run() {
            throw new Error("unexpected command");
          },
        },
        inspectGitProtection: async () => ({ kind: "outside-worktree" }),
        auditWriter: {
          async write() {
            audits += 1;
          },
        },
        now: () => new Date("2026-09-20T12:00:00.000Z"),
      },
    );
    expect(unchanged.status).toBe("unchanged");
    expect(prepares).toBe(0);
    expect(commits).toBe(0);
    expect(audits).toBe(0);

    const protectedPlan = planSessionSetup(
      initial,
      setupIntent(initial, "disable", [targetRef(target)]),
    );
    let discarded = 0;
    const protectedReport = await executeSessionSetup(
      protectedPlan,
      grantsFor(protectedPlan),
      {
        scan: async () => initial,
        replan: planSessionSetup,
        configurationWriter: {
          async prepare() {
            return { token: "protected", status: "changed" };
          },
          async commit() {
            commits += 1;
          },
          async discard() {
            discarded += 1;
          },
        },
        processRunner: {
          async run() {
            throw new Error("unexpected command");
          },
        },
        inspectGitProtection: async () => ({
          kind: "protected",
          worktreeRoot: "/fixtures/worktree",
        }),
        auditWriter: {
          async write() {
            audits += 1;
          },
        },
        now: () => new Date("2026-09-20T12:00:00.000Z"),
      },
    );
    expect(protectedReport.status).toBe("failed");
    expect(protectedReport.targetResults[0]!.status).toBe("failed");
    expect(discarded).toBe(1);
    expect(commits).toBe(0);
    expect(audits).toBe(0);
  });

  it("uses the shared checked writer for preservation, races, links, and missing parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "lampwright-setup-writer-"));
    const path = join(root, "settings.json");
    const original =
      '{\n  "secret": "SECRET_SENTINEL",\n  "enabled": true\n}\n';
    await writeFile(path, original);
    const digest = (value: string) => ({
      algorithm: "sha256" as const,
      digest: createHash("sha256").update(value).digest("hex"),
    });
    const mutation = planSessionSetup(
      buildSessionSetupSnapshot(),
      buildSessionSetupIntent(),
    ).actions[0]!.mutations[0] as Extract<
      SetupMutation,
      { kind: "configuration" }
    >;
    const editor = {
      edit(document: string) {
        const value = JSON.parse(document) as Record<string, unknown>;
        value.enabled = false;
        return `${JSON.stringify(value, null, 2)}\n`;
      },
    };
    const request = {
      path,
      format: "json" as const,
      exists: true,
      expectedPreimage: digest(original),
      selectors: [buildSessionSetupTarget().control.selector] as const,
      mutations: [mutation] as const,
    };
    const writer = createSessionSetupConfigurationWriter(editor);
    const prepared = await writer.prepare(request);
    await writer.commit(prepared);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("SECRET_SENTINEL");
    expect(JSON.parse(saved)).toEqual({
      secret: "SECRET_SENTINEL",
      enabled: false,
    });

    const raceWriter = createSessionSetupConfigurationWriter({
      edit(document: string) {
        const value = JSON.parse(document) as Record<string, unknown>;
        value.race = true;
        return `${JSON.stringify(value, null, 2)}\n`;
      },
    });
    const raceRequest = {
      ...request,
      expectedPreimage: digest(saved),
    };
    const raced = await raceWriter.prepare(raceRequest);
    await writeFile(path, `${saved} `);
    await expect(raceWriter.commit(raced)).rejects.toThrow(
      "changed before mutation",
    );

    await writeFile(path, saved);
    const hardLink = join(root, "hard-link.json");
    await link(path, hardLink);
    await expect(
      createSessionSetupConfigurationWriter(editor).prepare({
        ...request,
        expectedPreimage: digest(saved),
      }),
    ).rejects.toThrow("single-link regular file");

    const safeMissing = createSessionSetupConfigurationWriter({
      edit() {
        return '{"created":true}\n';
      },
    });
    const missingPath = join(root, "created.json");
    const missing = await safeMissing.prepare({
      path: missingPath,
      format: "json",
      exists: false,
      expectedPreimage: null,
      selectors: request.selectors,
      mutations: [mutation],
    });
    await safeMissing.commit(missing);
    expect(await readFile(missingPath, "utf8")).toBe('{"created":true}\n');

    const occupiedPath = join(root, "occupied.json");
    const occupied = await safeMissing.prepare({
      path: occupiedPath,
      format: "json",
      exists: false,
      expectedPreimage: null,
      selectors: request.selectors,
      mutations: [mutation],
    });
    await writeFile(occupiedPath, '{"external":true}\n');
    await expect(safeMissing.commit(occupied)).rejects.toThrow("EEXIST");
    expect(await readFile(occupiedPath, "utf8")).toBe('{"external":true}\n');

    if (process.platform !== "win32") {
      const symbolic = join(root, "symbolic.json");
      await symlink(path, symbolic, "file");
      await expect(
        createSessionSetupConfigurationWriter(editor).prepare({
          ...request,
          path: symbolic,
          expectedPreimage: digest(saved),
        }),
      ).rejects.toThrow("single-link regular file");

      const realParent = join(root, "real-parent");
      const linkedParent = join(root, "linked-parent");
      const realDirectory = await mkdtemp(`${realParent}-`);
      await symlink(realDirectory, linkedParent, "dir");
      const unsafe = createSessionSetupConfigurationWriter({
        edit() {
          return '{"changed":true}\n';
        },
      });
      const pending = await unsafe.prepare({
        path: join(linkedParent, "new.json"),
        format: "json",
        exists: false,
        expectedPreimage: null,
        selectors: request.selectors,
        mutations: [mutation],
      });
      await expect(unsafe.commit(pending)).rejects.toThrow("parent is unsafe");
    }
  });
});
