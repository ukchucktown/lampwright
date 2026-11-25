import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inspectAgentDestination,
  hasCode,
  type AgentDestinationAccess,
} from "../inventory/agent-destination.js";
import { pathKey } from "../inventory/evidence.js";
import type { Installation, Inventory } from "../model/types.js";
import { planAddAgent, type AddAgentPlan } from "../planning/add-agent.js";

export interface AddAgentReport {
  readonly status: "added" | "unchanged" | "blocked" | "failed" | "unresolved";
  readonly message: string;
}

export function createAddAgentModule(
  options: AgentDestinationAccess & { readonly scan: () => Promise<Inventory> },
) {
  async function preview(
    inventory: Inventory,
    installation: Installation,
    agent: string,
  ) {
    const destination = installation.agentDestinations?.find((item) =>
      item.agents.includes(agent),
    );
    const evidence = destination
      ? await inspectAgentDestination(
          installation.location.path,
          destination.path,
          options,
        )
      : null;
    return planAddAgent(inventory, installation, agent, evidence);
  }
  async function execute(
    reviewed: AddAgentPlan,
    confirmed: boolean,
  ): Promise<AddAgentReport> {
    if (!confirmed)
      return {
        status: "blocked",
        message: "Review and confirm the Add agent plan.",
      };
    const fresh = await options.scan();
    const before = fresh.installations.find(
      (item) => item.id === reviewed.installationId,
    );
    if (!before)
      return {
        status: "blocked",
        message: "The selected Installation is no longer present.",
      };
    const plan = await preview(fresh, before, reviewed.agent);
    if (!isDeepStrictEqual(plan, reviewed))
      return {
        status: "blocked",
        message: "The Add agent plan changed. Review a fresh plan.",
      };
    if (plan.action === "blocked" || !plan.destination)
      return {
        status: "blocked",
        message: plan.reason ?? "Add agent is blocked.",
      };
    const { fileSystem } = options;
    let added = false;
    if (plan.action === "link") {
      const destination = plan.destination;
      for (const path of [...plan.directories, destination]) {
        try {
          const parent = dirname(path);
          if (
            pathKey(await fileSystem.realpath(parent)) !== pathKey(parent) ||
            (await options.inspectGit(path, path !== destination)).kind ===
              "protected"
          )
            return {
              status: "blocked",
              message: `The parent or Git protection changed for ${path}.`,
            };
          if (path === destination) {
            if (
              (await fileSystem.lstat(plan.source)).kind !== "directory" ||
              pathKey(await fileSystem.realpath(plan.source)) !==
                pathKey(plan.source)
            )
              return {
                status: "blocked",
                message: "The canonical Skill directory changed.",
              };
            await fileSystem.symlink(
              plan.source,
              destination,
              process.platform === "win32" ? "junction" : "dir",
            );
            added = true;
          } else await fileSystem.mkdir(path);
        } catch (error) {
          if (!hasCode(error, "EEXIST"))
            return {
              status: "failed",
              message: error instanceof Error ? error.message : String(error),
            };
          if (
            path !== destination &&
            (await fileSystem.lstat(path)).kind !== "directory"
          )
            return {
              status: "blocked",
              message: `Another entry occupies ${path}.`,
            };
        }
      }
    }
    try {
      const after = (await options.scan()).installations.find(
        (item) => item.id === before.id,
      );
      const stable =
        after &&
        after.status === "active" &&
        after.location.path === before.location.path &&
        after.contentHash === before.contentHash &&
        isDeepStrictEqual(after.ownership, before.ownership) &&
        isDeepStrictEqual(after.source, before.source) &&
        isDeepStrictEqual(after.scope, before.scope) &&
        isDeepStrictEqual(
          after.removal.recordCleanups,
          before.removal.recordCleanups,
        ) &&
        before.exposedTo.every((agent) => after.exposedTo.includes(agent)) &&
        (before.removal.supplementalArtifacts ?? []).every((original) =>
          after.removal.supplementalArtifacts?.some((artifact) =>
            isDeepStrictEqual(original, artifact),
          ),
        );
      const present =
        after &&
        (pathKey(plan.source) === pathKey(plan.destination) ||
          (plan.agents.every((agent) => after.exposedTo.includes(agent)) &&
            after.removal.supplementalArtifacts?.some(
              (artifact) =>
                pathKey(artifact.location.path) ===
                  pathKey(plan.destination!) &&
                artifact.location.canonicalPath !== null &&
                pathKey(artifact.location.canonicalPath) ===
                  pathKey(plan.source),
            )));
      if (
        !stable ||
        !present ||
        (await inspectAgentDestination(plan.source, plan.destination, options))
          .state !== "linked"
      )
        return {
          status: "unresolved",
          message:
            "A fresh scan could not verify the requested destination and original Installation.",
        };
      return {
        status: added ? "added" : "unchanged",
        message: `${plan.skill} is available to ${plan.agent} at ${plan.destination}.`,
      };
    } catch (error) {
      return {
        status: "unresolved",
        message: `Unable to verify the destination: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { preview, execute };
}
export type AddAgentModule = ReturnType<typeof createAddAgentModule>;
