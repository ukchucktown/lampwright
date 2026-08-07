import { describe, expect, it } from "vitest";

import {
  assignGroupsToLogicalSkills,
  buildInstallationGroups,
} from "../src/inventory/groups.js";
import {
  buildInstallation,
  buildInventory,
  buildLogicalSkill,
  buildPluginBoundary,
} from "../src/testing/index.js";
import { parseInventory } from "../src/model/validation.js";
import type { InstallationGroupId, InstallationId } from "../src/index.js";

function managed(
  id: string,
  sourceId: string,
  overrides: Record<string, unknown> = {},
) {
  return buildInstallation({
    id,
    manager: { id: "vercel-skills" },
    source: { id: sourceId, url: null },
    ownership: {
      kind: "manager",
      managerId: "vercel-skills",
      confidence: "declared",
    },
    location: {
      path: `/fixtures/skills/${id}`,
      canonicalPath: `/fixtures/skills/${id}`,
      artifactType: { kind: "directory" },
    },
    ...overrides,
  });
}

describe("installation groups", () => {
  it("groups only Installations sharing a declared manager, source, and scope", () => {
    const groups = buildInstallationGroups([
      managed("a", "acme/toolkit"),
      managed("b", "acme/toolkit"),
      managed("c", "other/toolkit"),
      managed("d", "acme/toolkit", {
        scope: { kind: "workspace", workspacePath: "/work" },
      }),
      buildInstallation({ id: "unowned" }),
    ]);

    expect(
      groups.map((group) => ({
        label: group.label,
        tier: group.tier,
        scope: group.scope.kind,
        members: [...group.installationIds].sort(),
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          label: "acme/toolkit",
          tier: "declared",
          scope: "user",
          members: ["a", "b"],
        },
        {
          label: "acme/toolkit",
          tier: "declared",
          scope: "workspace",
          members: ["d"],
        },
        {
          label: "other/toolkit",
          tier: "declared",
          scope: "user",
          members: ["c"],
        },
      ]),
    );
    expect(groups.flatMap((group) => group.installationIds)).not.toContain(
      "unowned",
    );
  });

  it("rejects a Group claiming a plugin-owned Installation, which its boundary represents", () => {
    const child = buildInstallation({
      id: "plugin-child",
      classification: "managed-plugin-resource",
      pluginBoundaryId: "boundary-1",
      plugin: { id: "acme-bundle", version: "1.0.0" },
      ownership: {
        kind: "plugin",
        pluginId: "acme-bundle",
        independentlySelectable: false,
        confidence: "declared",
      },
    });

    const boundary = {
      ...buildPluginBoundary({
        id: "boundary-1",
        pluginId: "acme-bundle",
        ownership: {
          kind: "plugin",
          pluginId: "acme-bundle",
          independentlySelectable: false,
          confidence: "declared",
        },
      }),
      installationIds: [child.id],
    };

    expect(() =>
      parseInventory({
        ...buildInventory({ installations: [child], plugins: [boundary] }),
        groups: [
          {
            id: "installation-group-1",
            label: "acme/toolkit",
            tier: "declared",
            evidence: {
              tier: "declared",
              kind: "manager-source",
              managerId: "vercel-skills",
              sourceId: "acme/toolkit",
            },
            scope: { kind: "user" },
            installationIds: [child.id],
          },
        ],
      }),
    ).toThrow(/represented by their plugin boundary/);
  });

  it("is deterministic across repeated builds", () => {
    const installations = [
      managed("b", "acme/toolkit"),
      managed("a", "acme/toolkit"),
    ];

    expect(buildInstallationGroups(installations)).toEqual(
      buildInstallationGroups([...installations].reverse()),
    );
  });

  it("assigns a Logical Skill to a Group only when every Installation belongs to it", () => {
    const groups = buildInstallationGroups([
      managed("a", "acme/toolkit"),
      managed("b", "acme/toolkit"),
      managed("c", "other/toolkit"),
    ]);
    const groupFor = (sourceId: string): InstallationGroupId =>
      groups.find((group) => group.label === sourceId)!.id;

    const [contained, spanning, ungrouped] = assignGroupsToLogicalSkills(
      [
        buildLogicalSkill({
          id: "logical-contained",
          installationIds: ["a", "b"],
        }),
        buildLogicalSkill({
          id: "logical-spanning",
          installationIds: ["a", "c"],
        }),
        buildLogicalSkill({
          id: "logical-ungrouped",
          installationIds: ["installation-1"],
        }),
      ],
      groups,
    );

    expect(contained).toMatchObject({
      groupId: groupFor("acme/toolkit"),
      spansGroups: false,
    });
    expect(spanning).toMatchObject({ groupId: null, spansGroups: true });
    expect(ungrouped).toMatchObject({ groupId: null, spansGroups: false });
  });

  it("marks a Skill spanning a Group and an ungrouped Installation as spanning", () => {
    const groups = buildInstallationGroups([managed("a", "acme/toolkit")]);

    const [logical] = assignGroupsToLogicalSkills(
      [
        buildLogicalSkill({
          id: "logical-mixed",
          installationIds: ["a", "loose" as InstallationId],
        }),
      ],
      groups,
    );

    expect(logical).toMatchObject({ groupId: null, spansGroups: true });
  });
});
