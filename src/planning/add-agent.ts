import type {
  Installation,
  Inventory,
  RemovalTarget,
  Scope,
} from "../model/types.js";
import { pathContains } from "../model/paths.js";
import { PlanningError } from "./types.js";

export interface AddAgentPlan {
  readonly inventoryId: string;
  readonly installationId: Installation["id"];
  readonly skill: string;
  readonly scope: Scope;
  readonly agent: string;
  readonly source: string;
  readonly destination: string | null;
  readonly agents: readonly string[];
  readonly directories: readonly string[];
  readonly action: "link" | "unchanged" | "blocked";
  readonly reason: string | null;
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

export interface AgentDestinationPreview {
  readonly directories: readonly string[];
  readonly state: "absent" | "linked" | "blocked";
  readonly reason: string | null;
}

export function planAddAgent(
  inventory: Inventory,
  installation: Installation,
  agent: string,
  preview: AgentDestinationPreview | null,
): AddAgentPlan {
  const destination = installation.agentDestinations?.find((entry) =>
    entry.agents.includes(agent),
  );
  const source = installation.location.path;
  const path = destination?.path;
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
        (pathContains(root, source) ||
          (path !== undefined && pathContains(root, path))),
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
      : path && path !== source && pathContains(source, path)
        ? "The destination would create a link inside the selected Skill."
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
    agents: destination?.agents ?? [],
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
