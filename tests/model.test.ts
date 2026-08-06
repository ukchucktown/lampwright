import { describe, expect, it } from "vitest";

import {
  ModelSerializationError,
  ModelValidationError,
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
    const installation = parseInstallation({
      ...buildInstallation(),
      location: {
        path,
        canonicalPath: path,
        artifactType: { kind: "directory" },
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
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            location: buildInstallation().location,
          },
        ],
      }),
    ).toThrow(/brute-force confirmation/);
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
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            packageExecution: null,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
          },
          {
            id: "action-quarantine",
            kind: "quarantine",
            target,
            dependsOn: ["action-managed"],
            approvals: [{ kind: "brute-force-confirmation" }],
            location: buildInstallation().location,
          },
        ],
      }),
    ).toThrow(/separate plans/);
  });

  it("requires action dependencies to refer to earlier actions", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "record-cleanup",
            target,
            dependsOn: ["action-later"],
            approvals: [{ kind: "confirmation" }],
            path: "/fixtures/manager/record.json",
            adapterId: "fixture-adapter",
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

  it("requires exact package trust before ephemeral execution", () => {
    expect(() =>
      parseRemovalPlan({
        ...buildRemovalPlan(),
        actions: [
          {
            id: "action-1",
            kind: "managed-removal",
            target,
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            packageExecution: {
              runner: "npx",
              packageName: "fixture-manager",
              packageVersion: "1.2.3",
              adapterHash: "adapter-hash",
              mayDownload: true,
            },
            fallback: { kind: "unavailable", reason: "manager owns state" },
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
              packageExecution: {
                runner: "npx",
                packageName: "fixture-manager",
                packageVersion,
                adapterHash: "adapter-hash",
                mayDownload: true,
              },
              fallback: { kind: "unavailable", reason: "manager owns state" },
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
      target,
      dependsOn: [],
      approvals: [{ kind: "confirmation" as const }],
      path: "/fixtures/manager/record.json",
      adapterId: "fixture-adapter",
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
            dependsOn: [],
            approvals: [{ kind: "confirmation" }],
            owner: {
              kind: "manager",
              managerId: "fixture-manager",
              confidence: "declared",
            },
            adapterId: "fixture-adapter",
            operationId: "remove",
            packageExecution: null,
            fallback: {
              kind: "available",
              requiresSeparateConfirmation: true,
            },
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
