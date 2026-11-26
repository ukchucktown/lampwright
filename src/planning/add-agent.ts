import type {
  Installation,
  AgentDestinationPreview,
  Inventory,
  RemovalTarget,
  Scope,
} from "../model/types.js";
export type { AgentDestinationPreview } from "../model/types.js";
import { pathContains, mutationPathKey } from "../model/paths.js";
import { PlanningError } from "./types.js";

export interface AddAgentPlan {
  readonly inventoryId: string;
  readonly installationId: Installation["id"];
  readonly skill: string;
  readonly scope: Scope;
  /** Agent requested by the caller. */
  readonly agent: string;
  readonly source: string;
  readonly destination: string | null;
  /** Every Manager agent sharing this physical destination. */
  readonly agents: readonly string[];
  readonly directories: readonly string[];
  readonly action: "link" | "unchanged" | "blocked";
  readonly reason: string | null;
}

export interface AddAgentBatchPlan {
  readonly installationId: Installation["id"];
  readonly selectedAgents: readonly string[];
  readonly destinations: readonly AddAgentPlan[];
  readonly block: string | null;
}

export function planAddAgentBatch(
  installation: Installation,
  selectedAgents: readonly string[],
  plans: readonly AddAgentPlan[],
): AddAgentBatchPlan {
  const groups = new Map<string, AddAgentPlan[]>();
  for (const plan of plans) {
    const key = plan.destination
      ? mutationPathKey(plan.destination)
      : `unavailable:${plan.agent}`;
    const group = groups.get(key);
    if (group) group.push(plan);
    else groups.set(key, [plan]);
  }
  const destinations = Array.from(groups.values(), (group) => {
    const first = group[0]!;
    if (group.length === 1) return first;
    const agents = [...new Set(group.flatMap((plan) => plan.agents))].sort();
    const blocked = group.find((plan) => plan.action === "blocked");
    const inconsistent = group.some(
      (plan) =>
        plan.action !== first.action ||
        plan.directories.length !== first.directories.length ||
        plan.directories.some(
          (path, index) =>
            mutationPathKey(path) !==
            mutationPathKey(first.directories[index]!),
        ),
    );
    if (blocked || inconsistent)
      return {
        ...first,
        agents,
        action: "blocked" as const,
        reason:
          blocked?.reason ?? "Conflicting evidence for the shared destination.",
      };
    return { ...first, agents };
  });
  const overlap = destinations.some(
    (a) =>
      a.destination !== null &&
      destinations.some(
        (b) =>
          b !== a &&
          b.destination !== null &&
          pathContains(a.destination!, b.destination),
      ),
  );
  const blockedDestination = destinations.find(
    (plan) => plan.action === "blocked",
  );
  const block = !selectedAgents.length
    ? "Select at least one agent."
    : overlap
      ? "The selected destinations overlap."
      : blockedDestination
        ? (blockedDestination.reason ?? "Add agent is blocked.")
        : null;
  return {
    installationId: installation.id,
    selectedAgents,
    destinations,
    block,
  };
}

/** Targets that Inventory already resolves to the canonical Skill at their current destination. */
export function linkedAgentIds(
  installation: Installation,
): ReadonlySet<string> {
  const canonical = mutationPathKey(installation.location.path);
  const present = new Set([canonical]);
  for (const { location } of installation.removal.supplementalArtifacts ?? []) {
    if (
      (location.artifactType.kind === "symbolic-link" ||
        location.artifactType.kind === "junction") &&
      location.canonicalPath &&
      mutationPathKey(location.canonicalPath) === canonical
    )
      present.add(mutationPathKey(location.path));
  }
  return new Set(
    installation.agentDestinations?.flatMap((item) =>
      present.has(mutationPathKey(item.path)) ? item.agents : [],
    ),
  );
}

export function installedAgentIds(
  installation: Installation,
): ReadonlySet<string> {
  return new Set([
    ...linkedAgentIds(installation),
    ...(installation.agentDestinations ?? []).flatMap((item) =>
      item.verifiedCopy ? item.agents : [],
    ),
  ]);
}

export function addAgentInstallation(
  inventory: Inventory,
  target: RemovalTarget,
): Installation {
  let id;
  if (target.kind === "installation") id = target.installationId;
  else if (target.kind === "logical-skill") {
    const members = inventory.logicalSkills.find(
      (item) => item.id === target.logicalSkillId,
    )?.installationIds;
    if (members?.length === 1) id = members[0];
  }
  if (!id)
    throw new PlanningError(
      "invalid-intent",
      "Add agent requires one Installation. Select an installation:<id> when a Logical Skill contains multiple Installations.",
    );
  const installation = inventory.installations.find((item) => item.id === id);
  if (!installation)
    throw new PlanningError(
      "target-not-found",
      "The selected Installation is absent from Inventory.",
    );
  return installation;
}

export function planAddAgent(
  inventory: Inventory,
  installation: Installation,
  agent: string,
  preview: AgentDestinationPreview | null,
): AddAgentPlan {
  const registry = installation.agentDestinations ?? [];
  const destination = registry.find((entry) => entry.agents.includes(agent));
  const source = installation.location.path;
  const path = destination?.path;
  const affectedAgents = registry
    .filter(
      (entry) =>
        path !== undefined &&
        mutationPathKey(entry.path) === mutationPathKey(path),
    )
    .flatMap((entry) => entry.agents);
  const otherBoundaries = [
    ...inventory.otherFindings
      .filter((item) => item.classification === "system-skill")
      .map((item) => item.location),
    ...inventory.plugins.flatMap((item) =>
      item.resources.flatMap((resource) => resource.location ?? []),
    ),
    ...inventory.installations
      .filter((item) => item.id !== installation.id)
      .flatMap((item) => [
        item.location,
        ...(item.removal.supplementalArtifacts ?? []).map(
          (artifact) => artifact.location,
        ),
      ]),
  ];
  const incompatible = otherBoundaries.some((boundary) =>
    [boundary.path, boundary.canonicalPath].some(
      (root) =>
        root !== null &&
        (pathsOverlap(root, source) ||
          (path !== undefined && pathsOverlap(root, path))),
    ),
  );
  const reason =
    installation.status !== "active" ||
    installation.ownership.kind !== "manager" ||
    installation.manager?.id !== "vercel-skills" ||
    installation.pluginBoundaryId !== null ||
    installation.protection.system.kind !== "none" ||
    !installation.agentDestinations
      ? "Add agent requires an active canonical Skill with a supported Vercel Manager record."
      : path &&
          mutationPathKey(path) !== mutationPathKey(source) &&
          pathsOverlap(source, path)
        ? "The destination overlaps the canonical Skill directory."
        : incompatible
          ? "The selected source or destination overlaps another ownership boundary."
          : !destination
            ? `Unknown agent for this Scope: ${agent}.`
            : !preview
              ? "The destination could not be inspected."
              : preview.reason;
  return {
    inventoryId: inventory.id,
    installationId: installation.id,
    skill: installation.skill.name,
    scope: installation.scope,
    agent,
    source,
    destination: path ?? null,
    agents: [...new Set(affectedAgents)].sort(),
    directories: preview?.directories ?? [],
    action:
      reason !== null || preview?.state === "blocked"
        ? "blocked"
        : preview?.state === "linked"
          ? "unchanged"
          : "link",
    reason,
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}
