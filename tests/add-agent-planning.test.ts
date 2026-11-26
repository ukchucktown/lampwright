import { describe, expect, it } from "vitest";

import {
  linkedAgentIds,
  planAddAgent,
  planAddAgentBatch,
} from "../src/index.js";
import { mutationPathKey, pathContains } from "../src/model/paths.js";
import { buildInstallation, buildInventory } from "../src/testing/index.js";

function plansFor(source: string, paths: readonly string[]) {
  const agents = paths.map((_path, index) => "agent-" + index);
  const installation = buildInstallation({
    location: {
      path: source,
      canonicalPath: source,
      artifactType: { kind: "directory" },
    },
    identity: {
      strongEvidence: [
        { kind: "canonical-target", strength: "strong", canonicalPath: source },
      ],
      weakEvidence: [],
    },
    manager: { id: "vercel-skills" },
    ownership: {
      kind: "manager",
      managerId: "vercel-skills",
      confidence: "declared",
    },
    agentDestinations: paths.map((path, index) => ({
      path,
      agents: [agents[index]!],
    })),
  });
  const inventory = buildInventory({ installations: [installation] });
  const plans = agents.map((agent) =>
    planAddAgent(inventory, installation, agent, {
      directories: [],
      reason: null,
      state: "linked",
    }),
  );
  return {
    installation,
    plans,
    batch: planAddAgentBatch(installation, agents, plans),
  };
}

describe("Add agent path comparisons for serialized Inventory", () => {
  it.each([
    ["C:\\Tools\\review", "c:/tools/./review/"],
    ["C:\\", "c:/"],
    ["\\\\Server\\Share\\", "//server/share"],
    [
      "//Server/Share/Tools/review",
      "\\\\server\\share\\tools\\old\\..\\REVIEW\\",
    ],
    ["/work/tools/review", "/work/tools/./review/"],
  ])(
    "recognizes the canonical path %s and equivalent destinations without consulting the host",
    (canonical, alias) => {
      expect(mutationPathKey(canonical)).toBe(mutationPathKey(alias));
      const { installation, plans, batch } = plansFor(canonical, [
        canonical,
        alias,
      ]);
      expect(linkedAgentIds(installation)).toEqual(
        new Set(["agent-0", "agent-1"]),
      );
      expect(plans.map((plan) => plan.action)).toEqual([
        "unchanged",
        "unchanged",
      ]);
      expect(batch.block).toBeNull();
      expect(batch.destinations).toHaveLength(1);
      expect(batch.destinations[0]!.agents).toEqual(["agent-0", "agent-1"]);
    },
  );
  it("preserves all affected agents and blocks the coalesced path if either alias is blocked", () => {
    const { installation, plans } = plansFor("C:/Canonical/skill", [
      "C:/Agents/skill/",
      "c:/agents/./skill",
    ]);
    const denied = plans.map((plan, index) => ({
      ...plan,
      agents: [plan.agent],
      action: index === 0 ? ("link" as const) : ("blocked" as const),
      reason: index === 0 ? null : "Denied at the alias",
    }));
    const batch = planAddAgentBatch(
      installation,
      denied.map((plan) => plan.agent),
      denied,
    );
    expect(batch).toMatchObject({
      block: "Denied at the alias",
      destinations: [{ agents: ["agent-0", "agent-1"], action: "blocked" }],
    });
  });
  it("keeps POSIX case and literal backslashes distinct", () => {
    const { batch } = plansFor("/source", [
      "/skills/Foo",
      "/skills/foo/",
      "/skills/a\\b",
      "/skills/a/b",
    ]);
    expect(batch.block).toBeNull();
    expect(batch.destinations).toHaveLength(4);
    expect(pathContains("/source", "/Source/child")).toBe(false);
  });
  it.each([
    ["/", "/etc", true],
    ["C:/", "c:\\Tools\\review", true],
    ["C:/", "D:/Tools/review", false],
    ["//server/share", "\\\\SERVER\\Share\\templates", true],
    ["//server/share", "//server/share-extra/demo", false],
    ["C:/tools", "/tools/example", false],
  ] as const)(
    "matches complete components for %s and %s",
    (root, child, contains) => {
      expect(pathContains(root, child)).toBe(contains);
    },
  );
});
