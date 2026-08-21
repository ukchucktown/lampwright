import { describe, expect, it } from "vitest";

import {
  ModelSerializationError,
  ModelValidationError,
  parseExecutionApprovals,
  parseExecutionReport,
  parseInstallation,
  parseInventory,
  parseLogicalSkill,
  parseRemovalPlan,
  stringifyModel,
  toDeterministicJson,
  type Inventory,
} from "../src/index.js";
import {
  buildExecutionReport,
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildRemovalPlan,
  buildSystemSkillFinding,
} from "../src/testing/index.js";

function summarizeInventory(inventory: Inventory): string[] {
  return inventory.installations.map((installation) => installation.skill.name);
}

const directInvocation = {
  kind: "direct" as const,
  command: {
    executable: "fixture-manager",
    arguments: ["remove", "fixture-skill"],
  },
};

const writableProtection = buildInstallation().protection;
const unsupportedPluginAvailability = () => ({
  status: "enabled" as const,
  control: {
    kind: "unsupported" as const,
    reason: "fixture Plugin availability is unsupported",
  },
});
const fixtureFileHash = {
  algorithm: "sha256" as const,
  digest: "a".repeat(64),
};
const fixtureRecordHash = {
  algorithm: "sha256" as const,
  digest: "b".repeat(64),
};

function managedUpdateInstallation() {
  const base = buildInstallation();
  const owner = {
    kind: "manager" as const,
    managerId: "fixture-manager",
    confidence: "declared" as const,
  };
  const source = { id: "fixture/source", url: null };
  return parseInstallation({
    ...base,
    source,
    manager: { id: owner.managerId },
    ownership: owner,
    suspension: {
      kind: "unavailable",
      reason: "fixture Manager has no suspension authority",
    },
    update: {
      kind: "managed",
      operation: {
        adapterId: base.adapterId,
        operationId: "update",
        availability: { kind: "available" },
        trust: { kind: "trusted" },
        owner,
        externalId: "fixture/skill",
        invocation: {
          kind: "direct",
          command: {
            executable: "fixture-manager",
            arguments: ["update", "fixture/skill"],
          },
          workingDirectory: { kind: "isolated-temporary" },
        },
        source,
        ref: null,
        scope: base.scope,
        currentRevision: [
          {
            kind: "owner-value",
            path: "/fixtures/manager/record.json",
            format: "json",
            recordPointer: "/skills/fixture-skill",
            value: "1.0.0",
          },
        ],
        ownerRecordDigest: fixtureRecordHash,
        effects: [
          {
            kind: "mutation-root",
            path: base.location.path,
            exists: true,
            protection: base.protection,
          },
        ],
        network: { kind: "none" },
        packageDownload: { kind: "none" },
        localChanges: {
          kind: "unavailable",
          reason: "the fixture Owner has no content digest",
        },
        verifications: [
          {
            kind: "revision-manifest-value",
            path: "/fixtures/manager/record.json",
            format: "json",
            recordPointer: "/skills/fixture-skill",
            value: "1.0.0",
          },
          {
            kind: "command-succeeds",
            command: {
              executable: "fixture-manager",
              arguments: ["show", "fixture/skill"],
            },
            successExitCodes: [0],
          },
        ],
      },
    },
  });
}

const declarativeRecord = {
  id: "cleanup-fixture-skill",
  location: {
    path: "/fixtures/manager/record.json",
    canonicalPath: "/fixtures/manager/record.json",
    artifactType: { kind: "file" as const },
  },
  adapterId: "fixture-adapter",
  format: "json" as const,
  recordPointer: "/skills/fixture-skill",
  expectedFileHash: fixtureFileHash,
  expectedRecordHash: fixtureRecordHash,
  protection: writableProtection,
};

const declarativeRecordAction = {
  location: declarativeRecord.location,
  adapterId: declarativeRecord.adapterId,
  format: declarativeRecord.format,
  expectedFileHash: declarativeRecord.expectedFileHash,
  protection: declarativeRecord.protection,
  records: [
    {
      recordPointer: declarativeRecord.recordPointer,
      expectedRecordHash: declarativeRecord.expectedRecordHash,
    },
  ],
};

function buildPluginClaimChild(id: string, cleanupId: string) {
  return buildInstallation({
    id,
    classification: "managed-plugin-resource",
    skill: { name: id, description: null },
    identity: {
      strongEvidence: [
        {
          strength: "strong",
          kind: "plugin",
          pluginId: "plugin-domain",
          skillId: id,
        },
      ],
      weakEvidence: [],
    },
    plugin: { id: "plugin-domain", version: "1.0.0" },
    pluginBoundaryId: "plugin-domain-boundary",
    ownership: {
      kind: "plugin",
      pluginId: "plugin-domain",
      independentlySelectable: true,
      confidence: "declared",
    },
    location: {
      path: `/fixtures/plugins/plugin-domain/${id}`,
      canonicalPath: `/fixtures/plugins/plugin-domain/${id}`,
      artifactType: { kind: "directory" },
    },
    removal: {
      managed: null,
      fallback: {
        kind: "available",
        requiresSeparateConfirmation: true,
      },
      recordCleanups: [{ ...declarativeRecord, id: cleanupId }],
    },
  });
}

describe("core model boundary validation", () => {
  it("returns immutable values through the public interface", () => {
    const inventory = buildInventory();

    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.installations)).toBe(true);
    expect(Object.isFrozen(inventory.installations[0]?.identity)).toBe(true);
    expect(summarizeInventory(inventory)).toEqual(["example-skill"]);
  });

  it("rejects unknown fields at external boundaries", () => {
    expect(() =>
      parseInstallation({
        ...buildInstallation(),
        undeclaredField: true,
      }),
    ).toThrow(ModelValidationError);
  });

  it("preserves leading and trailing whitespace in filesystem paths", () => {
    const path = " /tmp/skill ";
    const base = buildInstallation();
    const installation = parseInstallation({
      ...base,
      location: {
        path,
        canonicalPath: path,
        artifactType: { kind: "directory" },
      },
      suspension: {
        kind: "available",
        artifacts: [
          {
            location: {
              path,
              canonicalPath: path,
              artifactType: { kind: "directory" },
            },
            protection: base.protection,
          },
        ],
        managerRecord: "not-applicable",
        managerMayRecreate: false,
      },
    });

    expect(installation.location.path).toBe(path);
    expect(installation.location.canonicalPath).toBe(path);
    expect(() =>
      parseInstallation({ ...buildInstallation(), id: "   " }),
    ).toThrow(/must not be blank/);
  });

  it("rejects invalid ownership and scope combinations", () => {
    expect(() =>
      parseInstallation({
        ...buildInstallation(),
        classification: "managed-plugin-resource",
      }),
    ).toThrow(/plugin ownership/);

    expect(() =>
      parseInstallation({
        ...buildInstallation(),
        classification: "standalone-project-skill",
        scope: { kind: "user" },
      }),
    ).toThrow(/workspace scope/);

    expect(() =>
      parseInstallation({
        ...buildInstallation(),
        ownership: {
          kind: "plugin",
          pluginId: "plugin-a",
          independentlySelectable: false,
          confidence: "declared",
        },
      }),
    ).toThrow(/managed plugin resources/);
  });

  it("keeps System Skills out of installations and validates their agent", () => {
    const systemSkill = buildSystemSkillFinding();
    expect(systemSkill.classification).toBe("system-skill");

    expect(() =>
      parseInventory({
        ...buildInventory(),
        otherFindings: [
          {
            ...systemSkill,
            agentId: "other-agent",
          },
        ],
      }),
    ).toThrow(/same agent/);

    expect(() =>
      parseInstallation({
        ...buildInstallation(),
        ownership: {
          kind: "agent-runtime",
          agentId: "fixture-agent",
          confidence: "declared",
        },
      }),
    ).toThrow(/system finding/);
  });

  it("does not create a Logical Skill from name or hash evidence alone", () => {
    expect(() =>
      parseLogicalSkill({
        ...buildLogicalSkill(),
        identity: {
          strongEvidence: [],
          weakEvidence: [
            {
              strength: "weak",
              kind: "name",
              normalizedName: "example-skill",
            },
            {
              strength: "weak",
              kind: "content-hash",
              algorithm: "sha256",
              digest: "same-content",
            },
          ],
        },
      }),
    ).toThrow(ModelValidationError);
  });

  it("requires every grouped installation to share strong evidence", () => {
    const first = buildInstallation();
    const second = buildInstallation({
      id: "installation-2",
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: "/fixtures/skills/different-skill",
          },
        ],
        weakEvidence: first.identity.weakEvidence,
      },
      location: {
        path: "/fixtures/skills/different-skill",
        canonicalPath: "/fixtures/skills/different-skill",
        artifactType: { kind: "directory" },
      },
    });

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [first, second],
        logicalSkills: [
          buildLogicalSkill({
            installationIds: ["installation-1", "installation-2"],
          }),
        ],
      }),
    ).toThrow(/strong evidence is not present/);
  });

  it("compares structured identity evidence without delimiter collisions", () => {
    const first = buildInstallation({
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "source",
            sourceId: "source:a",
            skillPath: "skill",
          },
        ],
        weakEvidence: [],
      },
    });
    const second = buildInstallation({
      id: "installation-2",
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "source",
            sourceId: "source",
            skillPath: "a:skill",
          },
        ],
        weakEvidence: [],
      },
      location: {
        path: "/fixtures/skills/second-skill",
        canonicalPath: "/fixtures/skills/second-skill",
        artifactType: { kind: "directory" },
      },
    });

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [first, second],
        logicalSkills: [
          buildLogicalSkill({
            identity: first.identity,
            installationIds: [first.id, second.id],
          }),
        ],
      }),
    ).toThrow(/strong evidence is not present/);
  });

  it("rejects duplicate IDs and dangling dependency references", () => {
    const installation = buildInstallation();
    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [
          installation,
          buildInstallation({ id: "installation-1" }),
        ],
      }),
    ).toThrow(/duplicate installation id/);

    expect(() =>
      parseInventory({
        ...buildInventory(),
        dependencies: [
          {
            kind: "hard",
            dependentInstallationId: "installation-1",
            target: {
              kind: "installation",
              installationId: "missing-installation",
            },
            source: {
              kind: "adapter",
              adapterId: "fixture-adapter",
            },
            reason: "required by fixture",
          },
        ],
      }),
    ).toThrow(/does not exist/);
  });

  it("allows a Soft Reference to originate from another finding", () => {
    const finding = buildSystemSkillFinding();
    expect(
      parseInventory({
        ...buildInventory(),
        otherFindings: [finding],
        dependencies: [
          {
            kind: "soft",
            referringRecord: {
              kind: "finding",
              findingId: finding.id,
            },
            target: {
              kind: "installation",
              installationId: "installation-1",
            },
            evidence: "runtime documentation mentions the skill",
          },
        ],
      }).dependencies,
    ).toEqual([
      {
        kind: "soft",
        referringRecord: { kind: "finding", findingId: "finding-1" },
        target: {
          kind: "installation",
          installationId: "installation-1",
        },
        evidence: "runtime documentation mentions the skill",
      },
    ]);
  });

  it("requires weak-match hints to reference shared evidence", () => {
    const first = buildInstallation();
    const second = buildInstallation({
      id: "installation-2",
      location: {
        path: "/fixtures/skills/second-skill",
        canonicalPath: "/fixtures/skills/second-skill",
        artifactType: { kind: "directory" },
      },
    });

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [first, second],
        identityHints: [
          {
            evidence: {
              strength: "weak",
              kind: "name",
              normalizedName: "not-shared",
            },
            installationIds: [first.id, second.id],
          },
        ],
      }),
    ).toThrow(/weak evidence is not present/);
  });

  it("validates planner-ready removal evidence against ownership", () => {
    expect(() =>
      parseInstallation({
        ...buildInstallation(),
        removal: {
          ...buildInstallation().removal,
          managed: {
            adapterId: "fixture-adapter",
            operationId: "remove",
            availability: { kind: "available" },
            trust: { kind: "trusted" },
            externalId: null,
            invocation: directInvocation,
            effects: [],
            verifications: [],
          },
        },
      }),
    ).toThrow(/manager or plugin ownership/);
  });

  it("rejects forged suspension protection and duplicate or overlapping artifact authority", () => {
    const installation = buildInstallation();
    if (installation.suspension.kind !== "available")
      throw new Error("expected available fixture suspension evidence");
    const primarySuspensionArtifact = installation.suspension.artifacts[0];
    expect(() =>
      parseInstallation({
        ...installation,
        suspension: {
          ...installation.suspension,
          kind: "available",
          artifacts: [
            {
              location: installation.location,
              protection: {
                ...installation.protection,
                filesystem: { kind: "read-only", reason: "forged downgrade" },
              },
            },
          ],
        },
      }),
    ).toThrow(/exactly match primary and supplemental artifacts/);

    expect(() =>
      parseInstallation({
        ...installation,
        suspension: {
          kind: "available",
          artifacts: [primarySuspensionArtifact, primarySuspensionArtifact],
          managerRecord: "not-applicable",
          managerMayRecreate: false,
        },
      }),
    ).toThrow(/unique and non-overlapping/);

    const child = {
      location: {
        path: `${installation.location.path}/nested-copy`,
        canonicalPath: `${installation.location.path}/nested-copy`,
        artifactType: { kind: "directory" as const },
      },
      protection: installation.protection,
    };
    expect(() =>
      parseInstallation({
        ...installation,
        removal: {
          ...installation.removal,
          supplementalArtifacts: [child],
        },
        suspension: {
          kind: "available",
          artifacts: [
            {
              location: installation.location,
              protection: installation.protection,
            },
            child,
          ],
          managerRecord: "not-applicable",
          managerMayRecreate: false,
        },
      }),
    ).toThrow(/unique and non-overlapping/);

    const low = {
      location: {
        path: "/fixtures/a-copy",
        canonicalPath: "/fixtures/a-copy",
        artifactType: { kind: "directory" as const },
      },
      protection: installation.protection,
    };
    const high = {
      location: {
        path: "/fixtures/z-copy",
        canonicalPath: "/fixtures/z-copy",
        artifactType: { kind: "directory" as const },
      },
      protection: installation.protection,
    };
    expect(() =>
      parseInstallation({
        ...installation,
        removal: {
          ...installation.removal,
          supplementalArtifacts: [high, low],
        },
        suspension: {
          kind: "available",
          artifacts: [high, low, primarySuspensionArtifact],
          managerRecord: "not-applicable",
          managerMayRecreate: false,
        },
      }),
    ).toThrow(/sorted by physical path/);
  });

  it("requires removal evidence to retain exact Adapter provenance", () => {
    const managed = {
      adapterId: "fixture-adapter",
      operationId: "remove",
      availability: { kind: "available" as const },
      trust: { kind: "trusted" as const },
      externalId: null,
      invocation: directInvocation,
      effects: [],
      verifications: [],
    };
    const managerOwned = {
      ...buildInstallation(),
      manager: { id: "fixture-manager" },
      ownership: {
        kind: "manager" as const,
        managerId: "fixture-manager",
        confidence: "declared" as const,
      },
    };

    expect(() =>
      parseInstallation({
        ...managerOwned,
        adapterId: null,
        removal: { ...managerOwned.removal, managed },
      }),
    ).toThrow(/must match the inventory record adapter/);

    expect(() =>
      parseInstallation({
        ...managerOwned,
        removal: {
          ...managerOwned.removal,
          recordCleanups: [
            {
              ...declarativeRecord,
              adapterId: "other-adapter",
            },
          ],
        },
      }),
    ).toThrow(/must match a non-null inventory record adapter/);
  });

  it("rejects duplicate managed effect paths", () => {
    const effect = {
      kind: "remove-path" as const,
      path: "/fixtures/managed/effect",
      protection: buildInstallation().protection,
    };
    const installation = buildInstallation();
    expect(() =>
      parseInstallation({
        ...installation,
        manager: { id: "fixture-manager" },
        ownership: {
          kind: "manager",
          managerId: "fixture-manager",
          confidence: "declared",
        },
        removal: {
          ...installation.removal,
          managed: {
            adapterId: "fixture-adapter",
            operationId: "remove",
            availability: { kind: "available" },
            trust: { kind: "trusted" },
            externalId: null,
            invocation: directInvocation,
            effects: [effect, effect],
            verifications: [],
          },
        },
      }),
    ).toThrow(/duplicate managed removal effect path/);
  });

  it("requires direct Owner working directories to be absolute", () => {
    const installation = buildInstallation();
    expect(() =>
      parseInstallation({
        ...installation,
        adapterId: "fixture-adapter",
        manager: { id: "fixture-manager" },
        ownership: {
          kind: "manager",
          managerId: "fixture-manager",
          confidence: "declared",
        },
        removal: {
          ...installation.removal,
          managed: {
            adapterId: "fixture-adapter",
            operationId: "remove",
            availability: { kind: "available" },
            trust: { kind: "trusted" },
            externalId: "fixture-skill",
            invocation: {
              ...directInvocation,
              workingDirectory: {
                kind: "exact",
                path: "relative/project",
              },
            },
            effects: [],
            verifications: [],
          },
        },
      }),
    ).toThrow(/absolute filesystem path/);
  });

  it("validates complete managed Installation Update evidence", () => {
    const valid = managedUpdateInstallation();
    expect(valid.update.kind).toBe("managed");
    expect(Object.isFrozen(valid.update)).toBe(true);
    if (valid.update.kind !== "managed") throw new Error("fixture is invalid");
    const operation = valid.update.operation;

    expect(() => parseInstallation({ ...valid, status: "broken" })).toThrow(
      /requires active status/,
    );
    const inferredOwner = {
      kind: "manager" as const,
      managerId: "fixture-manager",
      confidence: "inferred" as const,
    };
    expect(() =>
      parseInstallation({
        ...valid,
        ownership: inferredOwner,
        update: {
          kind: "managed",
          operation: { ...operation, owner: inferredOwner },
        },
      }),
    ).toThrow(/requires declared Manager ownership/);
    expect(() => parseInstallation({ ...valid, source: null })).toThrow(
      /requires a recorded source/,
    );
    expect(() =>
      parseInstallation({
        ...valid,
        identity: { ...valid.identity, strongEvidence: [] },
      }),
    ).toThrow(/requires strong identity evidence/);
  });

  it("matches unique Update revisions, effects, and command exit codes", () => {
    const valid = managedUpdateInstallation();
    if (valid.update.kind !== "managed") throw new Error("fixture is invalid");
    const operation = valid.update.operation;
    const revision = operation.currentRevision[0];
    expect(revision).toBeDefined();

    expect(() =>
      parseInstallation({
        ...valid,
        update: {
          kind: "managed",
          operation: {
            ...operation,
            currentRevision: [revision, revision],
          },
        },
      }),
    ).toThrow(/current Update revisions must be unique/);
    expect(() =>
      parseInstallation({
        ...valid,
        update: {
          kind: "managed",
          operation: {
            ...operation,
            currentRevision: [{ ...revision, value: "2.0.0" }],
          },
        },
      }),
    ).toThrow(/must match revision verifications exactly/);
    expect(() =>
      parseInstallation({
        ...valid,
        update: {
          kind: "managed",
          operation: {
            ...operation,
            effects: [
              { ...operation.effects[0], path: "C:\\Fixtures\\Update" },
              { ...operation.effects[0], path: "c:/fixtures/update" },
            ],
          },
        },
      }),
    ).toThrow(/effect paths must be unique/);
    expect(() =>
      parseInstallation({
        ...valid,
        update: {
          kind: "managed",
          operation: {
            ...operation,
            verifications: operation.verifications.map((verification) =>
              verification.kind === "command-succeeds"
                ? { ...verification, successExitCodes: [0, 0] }
                : verification,
            ),
          },
        },
      }),
    ).toThrow(/success exit codes must be unique/);
  });

  it("requires plugin-owned installations to have one consistent boundary", () => {
    const child = buildInstallation({
      classification: "managed-plugin-resource",
      plugin: { id: "plugin-a", version: "1.0.0" },
      pluginBoundaryId: "plugin-a-boundary",
      ownership: {
        kind: "plugin",
        pluginId: "plugin-a",
        independentlySelectable: false,
        confidence: "declared",
      },
    });

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [child],
      }),
    ).toThrow(/requires a plugin boundary/);

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [child],
        plugins: [
          {
            id: "plugin-a-boundary",
            pluginId: "plugin-a",
            version: "1.0.0",
            adapterId: "fixture-adapter",
            exposedTo: child.exposedTo,
            runtimeDefault: false,
            availability: unsupportedPluginAvailability(),
            update: child.update,
            ownership: child.ownership,
            installationIds: [child.id],
            resources: [
              {
                kind: "hook",
                id: "pre-run",
                location: {
                  path: "/fixtures/plugin/hook",
                  canonicalPath: "/fixtures/plugin/hook",
                  artifactType: { kind: "file" },
                },
                protection: null,
                cleanupId: null,
              },
            ],
            removal: child.removal,
          },
        ],
      }),
    ).toThrow(/location and protection/);

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [child],
        plugins: [
          {
            id: "plugin-a-boundary",
            pluginId: "plugin-a",
            version: "1.0.0",
            adapterId: "fixture-adapter",
            exposedTo: child.exposedTo,
            runtimeDefault: false,
            availability: unsupportedPluginAvailability(),
            update: child.update,
            ownership: child.ownership,
            installationIds: [child.id],
            resources: [
              {
                kind: "command",
                id: "manifest-command",
                location: null,
                protection: null,
                cleanupId: "missing-cleanup",
              },
            ],
            removal: child.removal,
          },
        ],
      }),
    ).toThrow(/cleanup does not exist/);
  });

  it("rejects inconsistent evidence for one physical cleanup document", () => {
    const firstCleanup = {
      ...declarativeRecord,
      id: "cleanup-first",
      location: {
        ...declarativeRecord.location,
        path: "C:\\State\\records.json",
        canonicalPath: "C:\\State\\records.json",
      },
    };
    const secondCleanup = {
      ...firstCleanup,
      id: "cleanup-second",
      location: {
        ...firstCleanup.location,
        path: "c:\\state\\RECORDS.json",
        canonicalPath: "c:\\state\\RECORDS.json",
      },
      recordPointer: "/skills/second",
      expectedFileHash: {
        algorithm: "sha256" as const,
        digest: "d".repeat(64),
      },
    };
    const first = buildInstallation({
      removal: {
        ...buildInstallation().removal,
        recordCleanups: [firstCleanup],
      },
    });
    const second = buildInstallation({
      id: "installation-2",
      location: {
        path: "/fixtures/skills/second",
        canonicalPath: "/fixtures/skills/second",
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: "/fixtures/skills/second",
          },
        ],
        weakEvidence: [],
      },
      removal: {
        ...buildInstallation().removal,
        recordCleanups: [secondCleanup],
      },
    });

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [first, second],
      }),
    ).toThrow(/physical document require consistent file evidence/);
  });

  it("rejects one cleanup selector claimed by selected and unselected owners", () => {
    const firstCleanup = {
      ...declarativeRecord,
      id: "cleanup-selected",
    };
    const secondCleanup = {
      ...declarativeRecord,
      id: "cleanup-unselected",
    };
    const selected = buildInstallation({
      removal: {
        ...buildInstallation().removal,
        recordCleanups: [firstCleanup],
      },
    });
    const unselected = buildInstallation({
      id: "installation-unselected",
      location: {
        path: "/fixtures/skills/unselected",
        canonicalPath: "/fixtures/skills/unselected",
        artifactType: { kind: "directory" },
      },
      identity: {
        strongEvidence: [
          {
            strength: "strong",
            kind: "canonical-target",
            canonicalPath: "/fixtures/skills/unselected",
          },
        ],
        weakEvidence: [],
      },
      protection: {
        git: {
          kind: "protected",
          worktreeRoot: "/fixtures/project",
        },
        system: { kind: "none" },
        filesystem: { kind: "writable" },
      },
      removal: {
        ...buildInstallation().removal,
        recordCleanups: [secondCleanup],
      },
    });

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [selected, unselected],
      }),
    ).toThrow(/cleanup selector is claimed by multiple removal owners/);
  });

  it("accepts one selector exposed by a Plugin boundary and its owned child", () => {
    const boundaryCleanup = {
      ...declarativeRecord,
      id: "cleanup-plugin-boundary",
    };
    const child = buildPluginClaimChild(
      "plugin-domain-child",
      "cleanup-plugin-child",
    );

    const inventory = parseInventory({
      ...buildInventory(),
      installations: [child],
      plugins: [
        {
          id: "plugin-domain-boundary",
          pluginId: "plugin-domain",
          version: "1.0.0",
          adapterId: "fixture-adapter",
          exposedTo: child.exposedTo,
          runtimeDefault: false,
          availability: unsupportedPluginAvailability(),
          update: child.update,
          ownership: child.ownership,
          installationIds: [child.id],
          resources: [],
          removal: {
            managed: null,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
            recordCleanups: [boundaryCleanup],
          },
        },
      ],
    });

    expect(inventory.plugins[0]?.installationIds).toEqual([child.id]);
    const boundary = inventory.plugins[0]!;
    expect(() =>
      parseInventory({
        ...inventory,
        plugins: [
          {
            ...boundary,
            removal: {
              ...boundary.removal,
              recordCleanups: boundary.removal.recordCleanups.map(
                (cleanup) => ({
                  ...cleanup,
                  expectedRecordHash: {
                    algorithm: "sha256",
                    digest: "c".repeat(64),
                  },
                }),
              ),
            },
          },
        ],
      }),
    ).toThrow(
      /alternate Plugin cleanup claims require consistent record evidence/,
    );
  });

  it("rejects a selector claim set containing sibling Plugin children", () => {
    const first = buildPluginClaimChild(
      "plugin-domain-first",
      "cleanup-plugin-first",
    );
    const sibling = buildPluginClaimChild(
      "plugin-domain-sibling",
      "cleanup-plugin-sibling",
    );

    expect(() =>
      parseInventory({
        ...buildInventory(),
        installations: [first, sibling],
        plugins: [
          {
            id: "plugin-domain-boundary",
            pluginId: "plugin-domain",
            version: "1.0.0",
            adapterId: "fixture-adapter",
            exposedTo: first.exposedTo,
            runtimeDefault: false,
            availability: unsupportedPluginAvailability(),
            update: first.update,
            ownership: first.ownership,
            installationIds: [first.id, sibling.id],
            resources: [],
            removal: {
              managed: null,
              fallback: {
                kind: "available",
                requiresSeparateConfirmation: true,
              },
              recordCleanups: [
                {
                  ...declarativeRecord,
                  id: "cleanup-plugin-boundary",
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/cleanup selector is claimed by multiple removal owners/);
  });
});

describe("removal plan invariants", () => {
  const target = {
    kind: "installation" as const,
    installationId: "installation-1",
  };

  it("requires explicit brute-force approval for quarantine", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "quarantine",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            location: buildInstallation().location,
          },
        ],
      }),
    ).toThrow(/brute-force confirmation/);
  });

  it("requires actions to declare affected Installation IDs explicitly", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "quarantine",
            target,
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: buildInstallation().location,
          },
        ],
      }),
    ).toThrow(ModelValidationError);
  });

  it("requires normalized target intent to match resolved plan targets", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        intent: {
          kind: "targets",
          targets: [
            { kind: "installation", installationId: "another-installation" },
          ],
          force: false,
          mode: "managed-first",
        },
      }),
    ).toThrow(/normalized target intent/);
  });

  it("rejects shell executables in materialized managed invocations", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: {
              kind: "direct",
              command: { executable: "sh", arguments: ["-c", "remove"] },
            },
            fallback: { kind: "unavailable", reason: "manager owns state" },
            effects: [],
          },
        ],
      }),
    ).toThrow(/shell executable/);
  });

  it.each([
    "npx",
    "/usr/local/bin/npm",
    "C:\\Tools\\YARN.CMD",
    "pnpm.exe",
    "C:\\Tools\\PNPX.CMD",
    "BUNX.PS1",
  ])("rejects generic package-runner command %s", (executable) => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: {
              kind: "direct",
              command: { executable, arguments: ["remove"] },
            },
            fallback: { kind: "unavailable", reason: "manager owns state" },
            effects: [],
          },
        ],
      }),
    ).toThrow(/package runners require exact ephemeral package execution/);
  });

  it("rejects package runners in generic verification commands", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: directInvocation,
            fallback: { kind: "unavailable", reason: "manager owns state" },
            effects: [],
            verifications: [
              {
                kind: "command-succeeds",
                command: { executable: "NPX.CMD", arguments: ["--version"] },
                successExitCodes: [0],
              },
            ],
          },
        ],
      }),
    ).toThrow(/package runners require exact ephemeral package execution/);
  });

  it("binds each concrete verification to evidence on its exact action", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: directInvocation,
            fallback: { kind: "unavailable", reason: "manager owns state" },
            effects: [],
            verifications: [
              { kind: "path-absent", path: "/fixtures/owned-by-action" },
            ],
          },
        ],
        verificationChecks: [
          {
            id: "forged-check",
            kind: "path-absent",
            actionId: "action-managed",
            path: "/fixtures/unrelated",
          },
        ],
      }),
    ).toThrow(/not authorized by its owning action/);
  });

  it("requires exact record cleanup selectors and SHA-256 evidence", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-cleanup",
            kind: "record-cleanup",
            affectedTargets: [target],
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            ...declarativeRecordAction,
            records: [
              {
                recordPointer: "/skills/fixture-skill",
                expectedRecordHash: { algorithm: "sha256", digest: "short" },
              },
            ],
          },
        ],
      }),
    ).toThrow(/SHA-256 digest/);
  });

  it("keeps managed removal and fallback in separate plans", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: directInvocation,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
            effects: [],
          },
          {
            id: "action-quarantine",
            kind: "quarantine",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: ["action-managed"],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: buildInstallation().location,
          },
        ],
      }),
    ).toThrow(/separate plans/);
  });

  it("allows heterogeneous methods for different Installations in one Logical Skill", () => {
    const logicalTarget = {
      kind: "logical-skill" as const,
      logicalSkillId: "logical-skill-1",
    };
    expect(
      parseRemovalPlan({
        ...buildRemovalPlan(),
        intent: {
          kind: "targets",
          targets: [logicalTarget],
          force: false,
          mode: "managed-first",
        },
        targets: [logicalTarget],
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target: logicalTarget,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: directInvocation,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
            effects: [],
          },
          {
            id: "action-quarantine",
            kind: "quarantine",
            target: logicalTarget,
            affectedInstallationIds: ["installation-2"],
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: buildInstallation().location,
          },
        ],
      }).actions,
    ).toHaveLength(2);
  });

  it("requires action dependencies to refer to earlier actions", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "record-cleanup",
            affectedTargets: [target],
            affectedInstallationIds: ["installation-1"],
            dependsOn: ["action-later"],
            approvals: [{ kind: "confirmation" }],
            ...declarativeRecordAction,
          },
        ],
      }),
    ).toThrow(/earlier action/);
  });

  it("rejects actions for non-overridable protection blocks", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "quarantine",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: buildInstallation().location,
          },
        ],
        blocks: [
          {
            kind: "git-protection",
            target,
            path: "/fixtures/project/skill",
            overridable: false,
          },
        ],
      }),
    ).toThrow(/non-overridable block/);
  });

  it("applies blocks to every target affected by a global cleanup action", () => {
    const basePlan = buildRemovalPlan();
    const firstTarget = {
      kind: "installation" as const,
      installationId: "installation-1",
    };
    const secondTarget = {
      kind: "installation" as const,
      installationId: "installation-2",
    };
    expect(() =>
      parseRemovalPlan({
        ...basePlan,
        intent: {
          kind: "targets",
          targets: [firstTarget, secondTarget],
          force: false,
          mode: "brute-force",
        },
        targets: [firstTarget, secondTarget],
        actions: [
          {
            id: "action-global-cleanup",
            kind: "record-cleanup",
            affectedTargets: [firstTarget, secondTarget],
            affectedInstallationIds: ["installation-1", "installation-2"],
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            ...declarativeRecordAction,
          },
        ],
        blocks: [
          {
            kind: "git-protection",
            target: secondTarget,
            path: declarativeRecord.location.path,
            overridable: false,
          },
        ],
      }),
    ).toThrow(/non-overridable block/);
  });

  it("rejects protected expected effects on managed actions", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: directInvocation,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
            effects: [
              {
                kind: "modify-path",
                path: "/fixtures/project/settings.json",
                protection: {
                  git: {
                    kind: "protected",
                    worktreeRoot: "/fixtures/project",
                  },
                  system: { kind: "none" },
                  filesystem: { kind: "writable" },
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(/cannot mutate a protected expected effect/);
  });

  it("requires exact package trust before ephemeral execution", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [
              { kind: "confirmation" },
              {
                kind: "package-trust",
                runner: "npx",
                packageName: "fixture-manager",
                packageVersion: "1.2.3",
                adapterHash: "different-adapter-hash",
              },
            ],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: {
              kind: "ephemeral-package",
              packageExecution: {
                runner: "npx",
                packageName: "fixture-manager",
                packageVersion: "1.2.3",
                adapterHash: "adapter-hash",
                mayDownload: true,
              },
              packageArguments: ["remove", "fixture-skill"],
            },
            fallback: { kind: "unavailable", reason: "manager owns state" },
            effects: [],
          },
        ],
      }),
    ).toThrow(/matching package trust/);
  });

  it.each(["latest", "^1.2.3"])(
    "rejects non-exact ephemeral package version %s",
    (packageVersion) => {
      expect(() =>
        parseRemovalPlan({
          ...buildRemovalPlan(),
          actions: [
            {
              id: "action-1",
              kind: "managed-removal",
              target,
              affectedInstallationIds: ["installation-1"],
              dependsOn: [],
              approvals: [
                {
                  kind: "package-trust",
                  runner: "npx",
                  packageName: "fixture-manager",
                  packageVersion,
                  adapterHash: "adapter-hash",
                },
              ],
              owner: {
                kind: "manager",
                managerId: "fixture-manager",
                confidence: "declared",
              },
              adapterId: "fixture-adapter",
              operationId: "remove",
              invocation: {
                kind: "ephemeral-package",
                packageExecution: {
                  runner: "npx",
                  packageName: "fixture-manager",
                  packageVersion,
                  adapterHash: "adapter-hash",
                  mayDownload: true,
                },
                packageArguments: ["remove", "fixture-skill"],
              },
              fallback: { kind: "unavailable", reason: "manager owns state" },
              effects: [],
            },
          ],
        }),
      ).toThrow(/exact package version/);
    },
  );

  it("requires a hard-dependency block to identify its dependency target", () => {
    const otherTarget = {
      kind: "installation" as const,
      installationId: "installation-2",
    };

    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        targets: [target, otherTarget],
        actions: [
          {
            id: "action-1",
            kind: "quarantine",
            target: otherTarget,
            affectedInstallationIds: ["installation-2"],
            dependsOn: [],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: buildInstallation().location,
          },
        ],
        blocks: [
          {
            kind: "hard-dependency",
            target,
            dependency: {
              kind: "hard",
              dependentInstallationId: "dependent-installation",
              target: otherTarget,
              source: { kind: "adapter", adapterId: "fixture-adapter" },
              reason: "required by another installation",
            },
            overridable: true,
          },
        ],
      }),
    ).toThrow(/dependency target/);
  });

  it("treats declarative record cleanup as separately confirmed brute force", () => {
    const recordCleanup = {
      id: "action-cleanup",
      kind: "record-cleanup" as const,
      affectedTargets: [target],
      affectedInstallationIds: ["installation-1"],
      dependsOn: [],
      approvals: [{ kind: "confirmation" as const }],
      ...declarativeRecordAction,
    };

    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [recordCleanup],
      }),
    ).toThrow(/brute-force confirmation/);

    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-managed",
            kind: "managed-removal",
            target,
            affectedInstallationIds: ["installation-1"],
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            invocation: directInvocation,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
            effects: [],
          },
          {
            ...recordCleanup,
            dependsOn: ["action-managed"],
            approvals: [{ kind: "brute-force-confirmation" }],
          },
        ],
      }),
    ).toThrow(/separate plans/);
  });
});

describe("execution reports and deterministic JSON", () => {
  it("validates exact, unique execution approval grants", () => {
    const approvals = parseExecutionApprovals({
      grants: [
        { kind: "confirmation" },
        {
          kind: "package-trust",
          runner: "npx",
          packageName: "fixture-manager",
          packageVersion: "1.2.3",
          adapterHash: "a".repeat(64),
        },
      ],
    });
    expect(Object.isFrozen(approvals)).toBe(true);
    expect(() =>
      parseExecutionApprovals({
        grants: [{ kind: "confirmation" }, { kind: "confirmation" }],
      }),
    ).toThrow(/duplicate execution approval/);
    expect(() =>
      parseExecutionApprovals({ grants: [{ kind: "force" }] }),
    ).toThrow(ModelValidationError);
  });

  it("rejects inconsistent status and result timestamps", () => {
    expect(() =>
      parseExecutionReport({
        ...buildExecutionReport(),
        status: "succeeded",
        actionResults: [
          {
            actionId: "action-1",
            startedAt: "2026-01-01T00:02:30.000Z",
            completedAt: "2026-01-01T00:02:20.000Z",
            status: "failed",
            error: { code: "manager-failed", message: "failed", details: {} },
          },
        ],
      }),
    ).toThrow(ModelValidationError);

    expect(() =>
      parseExecutionReport({
        ...buildExecutionReport(),
        status: "failed",
      }),
    ).toThrow(/requires a failed result/);
  });

  it("rejects verification results when the final rescan failed", () => {
    expect(() =>
      parseExecutionReport({
        ...buildExecutionReport(),
        status: "failed",
        finalInventoryId: null,
        rescanError: {
          code: "final-rescan-failed",
          message: "scanner unavailable",
          details: {},
        },
        verificationResults: [
          { checkId: "check-1", status: "passed", details: {} },
        ],
      }),
    ).toThrow(/failed final rescan cannot claim verification/);
  });

  it("rejects dangling action relationships in reports", () => {
    expect(() =>
      parseExecutionReport({
        ...buildExecutionReport(),
        status: "blocked",
        actionResults: [
          {
            actionId: "action-2",
            startedAt: "2026-01-01T00:02:30.000Z",
            completedAt: "2026-01-01T00:02:40.000Z",
            status: "blocked",
            blockedByActionIds: ["missing-action"],
            reason: "dependency failed",
          },
        ],
      }),
    ).toThrow(/blocking action result does not exist/);

    expect(() =>
      parseExecutionReport({
        ...buildExecutionReport(),
        targetResults: [
          {
            target: {
              kind: "installation",
              installationId: "installation-1",
            },
            status: "removed",
            actionIds: ["missing-action"],
          },
        ],
      }),
    ).toThrow(/action result does not exist/);
  });

  it("binds fallback offers to executable brute-force plans from the final Inventory", () => {
    expect(() =>
      parseExecutionReport({
        ...buildExecutionReport(),
        status: "failed",
        actionResults: [
          {
            actionId: "action-1",
            startedAt: "2026-01-01T00:02:30.000Z",
            completedAt: "2026-01-01T00:02:40.000Z",
            status: "failed",
            error: { code: "manager-failed", message: "failed", details: {} },
          },
        ],
        targetResults: [
          {
            target: {
              kind: "installation",
              installationId: "installation-1",
            },
            status: "unresolved",
            actionIds: ["action-1"],
            reason: "managed removal failed",
          },
        ],
        fallbackPlans: [buildRemovalPlan()],
      }),
    ).toThrow(/fallback offer/);
  });

  it("serializes equivalent values deterministically", () => {
    const first = buildInstallation({
      metadata: { zebra: 1, alpha: { two: 2, one: 1 } },
    });
    const second = buildInstallation({
      metadata: { alpha: { one: 1, two: 2 }, zebra: 1 },
    });

    expect(stringifyModel(first)).toBe(stringifyModel(second));
    const normalized = toDeterministicJson(first);
    expect(normalized).not.toBeNull();
    expect(Array.isArray(normalized)).toBe(false);
    expect(typeof normalized).toBe("object");
    if (
      normalized === null ||
      Array.isArray(normalized) ||
      typeof normalized !== "object"
    ) {
      throw new Error("expected a normalized JSON object");
    }
    expect(Object.keys(normalized)).toEqual([...Object.keys(first)].sort());
  });

  it("rejects values JSON cannot represent safely", () => {
    expect(() => stringifyModel({ value: Number.NaN })).toThrow(
      ModelSerializationError,
    );
    expect(() => stringifyModel({ value: undefined })).toThrow(
      /cannot serialize undefined/,
    );
  });

  it("preserves an own __proto__ JSON property without changing prototypes", () => {
    const input: unknown = JSON.parse(
      '{"safe":1,"__proto__":{"polluted":true}}',
    );
    const normalized = toDeterministicJson(input);

    expect(stringifyModel(input, 0)).toBe(
      '{"__proto__":{"polluted":true},"safe":1}',
    );
    expect(normalized).not.toBeNull();
    expect(Array.isArray(normalized)).toBe(false);
    if (
      normalized === null ||
      Array.isArray(normalized) ||
      typeof normalized !== "object"
    ) {
      throw new Error("expected a normalized JSON object");
    }
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
