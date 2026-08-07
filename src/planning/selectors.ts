import type {
  InstallationId,
  Inventory,
  LogicalSkillId,
  RemovalTarget,
} from "../model/types.js";

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
      case "source": {
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
