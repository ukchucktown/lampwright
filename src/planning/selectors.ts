import type {
  InstallationId,
  Inventory,
  LogicalSkillId,
  RemovalTarget,
} from "../model/types.js";
import type {
  AvailabilityTarget,
  AvailabilityIntent,
} from "../availability/types.js";
import type { DisabledEntry } from "../disabled-storage/types.js";

import { PlanningError } from "./types.js";

/** Converts the documented CLI selector syntax into canonical planner targets. */
export function resolveTargetSelectors(
  inventory: Inventory,
  selectors: readonly string[],
): readonly RemovalTarget[] {
  const targets: RemovalTarget[] = [];
  for (const selector of selectors) {
    const separator = selector.indexOf(":");
    const kind = selector.slice(0, separator);
    const id = selector.slice(separator + 1);
    if (separator < 1 || id.length === 0) {
      throw new PlanningError(
        "invalid-intent",
        `invalid selector: ${selector}`,
      );
    }
    switch (kind) {
      case "installation":
        targets.push({
          kind: "installation",
          installationId: id as InstallationId,
        });
        break;
      case "logical-skill":
        targets.push({
          kind: "logical-skill",
          logicalSkillId: id as LogicalSkillId,
        });
        break;
      case "plugin":
        targets.push({ kind: "plugin", pluginBoundaryId: id });
        break;
      case "group": {
        const group = inventory.groups.find((candidate) => candidate.id === id);
        if (group === undefined) {
          throw new PlanningError(
            "target-not-found",
            `group selector did not match a Group: ${id}`,
          );
        }
        targets.push({ kind: "source-group", groupId: group.id });
        break;
      }
      case "source": {
        // A declared Group is the source, so name it directly. Without one the
        // selector keeps its original meaning and expands to each Installation.
        const groups = inventory.groups.filter(
          (candidate) =>
            candidate.evidence.kind === "manager-source" &&
            candidate.evidence.sourceId === id,
        );
        if (groups.length > 1) {
          throw new PlanningError(
            "invalid-intent",
            `source selector matches ${String(groups.length)} groups; use group:<id>: ${id}`,
          );
        }
        const group = groups[0];
        if (group !== undefined) {
          targets.push({ kind: "source-group", groupId: group.id });
          break;
        }
        const matches = inventory.installations.filter(
          (installation) => installation.source?.id === id,
        );
        if (matches.length === 0) {
          throw new PlanningError(
            "target-not-found",
            `source selector did not match an Installation: ${id}`,
          );
        }
        targets.push(
          ...matches.map((installation) => ({
            kind: "installation" as const,
            installationId: installation.id,
          })),
        );
        break;
      }
      default:
        throw new PlanningError(
          "invalid-intent",
          `unknown selector kind: ${kind}`,
        );
    }
  }
  return targets;
}

/** Resolves only stable Availability identifiers; names are never selectors. */
export function resolveAvailabilitySelectors(
  inventory: Inventory,
  disabledEntries: readonly DisabledEntry[],
  operation: AvailabilityIntent["operation"],
  selectors: readonly string[],
): readonly AvailabilityTarget[] {
  const targets: AvailabilityTarget[] = [];
  for (const selector of selectors) {
    const separator = selector.indexOf(":");
    const kind = selector.slice(0, separator);
    const id = selector.slice(separator + 1);
    if (separator < 1 || id.length === 0)
      throw new PlanningError(
        "invalid-intent",
        `invalid selector: ${selector}`,
      );
    if (kind === "disabled-entry") {
      if (operation !== "enable")
        throw new PlanningError(
          "invalid-intent",
          "disabled-entry selectors are valid only for enable",
        );
      const entry = disabledEntries.find((candidate) => candidate.id === id);
      if (entry === undefined)
        throw new PlanningError(
          "target-not-found",
          `disabled-entry selector did not match Disabled Storage: ${id}`,
        );
      targets.push(
        ...entry.installationIds.map((installationId) => ({
          kind: "installation" as const,
          installationId,
        })),
      );
      continue;
    }
    if (kind === "installation") {
      const installation = inventory.installations.find(
        (candidate) => candidate.id === id,
      );
      if (installation === undefined)
        throw new PlanningError(
          "target-not-found",
          `installation selector did not match Inventory: ${id}`,
        );
      requireEnableCandidate(operation, selector, [installation]);
      targets.push({ kind: "installation", installationId: installation.id });
      continue;
    }
    if (kind === "logical-skill") {
      const logical = inventory.logicalSkills.find(
        (candidate) => candidate.id === id,
      );
      if (logical === undefined)
        throw new PlanningError(
          "target-not-found",
          `logical-skill selector did not match Inventory: ${id}`,
        );
      requireEnableCandidate(
        operation,
        selector,
        inventory.installations.filter((installation) =>
          logical.installationIds.includes(installation.id),
        ),
      );
      targets.push({ kind: "logical-skill", logicalSkillId: logical.id });
      continue;
    }
    if (kind === "group") {
      const group = inventory.groups.find((candidate) => candidate.id === id);
      if (group === undefined)
        throw new PlanningError(
          "target-not-found",
          `group selector did not match a Group: ${id}`,
        );
      requireEnableCandidate(
        operation,
        selector,
        inventory.installations.filter((installation) =>
          group.installationIds.includes(installation.id),
        ),
      );
      targets.push({ kind: "source-group", groupId: group.id });
      continue;
    }
    throw new PlanningError(
      "invalid-intent",
      `unknown Availability selector kind: ${kind}`,
    );
  }
  return targets;
}

function requireEnableCandidate(
  operation: AvailabilityIntent["operation"],
  selector: string,
  installations: Inventory["installations"],
): void {
  if (
    operation === "enable" &&
    !installations.some((installation) =>
      installation.harnessExposures.some(
        (exposure) => exposure.status === "disabled",
      ),
    )
  )
    throw new PlanningError(
      "target-not-found",
      `enable selector is not natively disabled: ${selector}`,
    );
}
