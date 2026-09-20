import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  SessionSetupValidationError,
  parseSessionSetupPlan,
  parseSessionSetupPublicValue,
  parseSessionSetupSnapshot,
  recoveredSourceProfiles,
  sessionSetupTargetSchema,
  sessionSetupJsonSchema,
} from "../src/session-setup/index.js";
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
  SetupNativeControl,
  SetupNativeSelector,
  SetupSourceRef,
  SkillHarnessExposure,
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
