import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inspectAgentDestination,
  isCanonicalDirectory,
  hasCode,
  type AgentDestinationAccess,
} from "../inventory/agent-destination.js";
import { pathKey } from "../inventory/evidence.js";
import type { Installation, Inventory } from "../model/types.js";
import {
  planAddAgent,
  planAddAgentBatch,
  type AddAgentBatchPlan,
  type AddAgentPlan,
} from "../planning/add-agent.js";

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
  async function previewBatch(
    inventory: Inventory,
    installation: Installation,
    agents: readonly string[],
  ): Promise<AddAgentBatchPlan> {
    const selectedAgents = [...new Set(agents)].sort();
    const plans = await Promise.all(
      selectedAgents.map((agent) => preview(inventory, installation, agent)),
    );
    return planAddAgentBatch(installation, selectedAgents, plans);
  }

  async function apply(
    plan: AddAgentPlan,
    directoriesCreated: Set<string>,
  ): Promise<AddAgentReport> {
    const { fileSystem } = options;
    let added = false;
    if (!plan.destination || plan.action === "blocked")
      return {
        status: "blocked",
        message: plan.reason ?? "Add agent is blocked.",
      };
    if (plan.action === "link") {
      const destination = plan.destination;
      for (const path of [...plan.directories, destination]) {
        try {
          const parent = dirname(path);
          if (
            !(await isCanonicalDirectory(fileSystem, parent)) ||
            (await options.inspectGit(path, path !== destination)).kind ===
              "protected"
          )
            return {
              status: "blocked",
              message: `The parent or Git protection changed for ${path}.`,
            };
          if (path === destination) {
            if (!(await isCanonicalDirectory(fileSystem, plan.source)))
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
          } else {
            await fileSystem.mkdir(path);
            directoriesCreated.add(pathKey(path));
          }
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            if (path === destination) {
              const occupant = await inspectAgentDestination(
                plan.source,
                destination,
                options,
              );
              if (occupant.state !== "linked")
                return {
                  status: "blocked",
                  message:
                    occupant.reason ??
                    `The destination changed: ${destination}.`,
                };
            } else if (!(await isCanonicalDirectory(fileSystem, path))) {
              return {
                status: "blocked",
                message: `Another entry occupies ${path}.`,
              };
            }
          } else if (
            hasCode(error, "EPERM") ||
            hasCode(error, "EACCES") ||
            hasCode(error, "EROFS")
          ) {
            return {
              status: "blocked",
              message: `The filesystem denied write access to ${path}.`,
            };
          } else {
            return {
              status: "failed",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
    }
    return {
      status: added ? "added" : "unchanged",
      message: `${plan.skill} is available to ${plan.agent} at ${plan.destination}.`,
    };
  }

  async function destinationVerified(
    after: Installation,
    plan: AddAgentPlan,
  ): Promise<boolean> {
    if (!plan.destination) return false;
    return (
      (pathKey(plan.source) === pathKey(plan.destination) ||
        (plan.agents.every((agent) => after.exposedTo.includes(agent)) &&
          after.removal.supplementalArtifacts?.some(
            (artifact) =>
              pathKey(artifact.location.path) === pathKey(plan.destination!) &&
              artifact.location.canonicalPath !== null &&
              pathKey(artifact.location.canonicalPath) === pathKey(plan.source),
          ))) === true &&
      (await inspectAgentDestination(plan.source, plan.destination, options))
        .state === "linked"
    );
  }

  async function executeBatch(
    reviewed: AddAgentBatchPlan,
    confirmed: boolean,
  ): Promise<AddAgentBatchReport> {
    const blocked = (message: string): AddAgentBatchReport => ({
      status: "blocked",
      message,
      results: [],
    });
    if (!confirmed) return blocked("Review and confirm the Add agent plan.");
    const inventory = await options.scan();
    const original = inventory.installations.find(
      (item) => item.id === reviewed.installationId,
    );
    if (!original)
      return blocked("The selected Installation is no longer present.");
    const fresh = await previewBatch(
      inventory,
      original,
      reviewed.selectedAgents,
    );
    if (!isDeepStrictEqual(fresh, reviewed))
      return blocked("The Add agent plan changed. Review a fresh plan.");
    if (fresh.block) return blocked(fresh.block);
    const results: AddAgentDestinationResult[] = [];
    const directoriesCreated = new Set<string>();
    for (const plan of fresh.destinations) {
      let currentPlan = plan;
      let result: AddAgentReport;
      try {
        if (results.length > 0) {
          const current = await options.scan();
          const installation = current.installations.find(
            (item) => item.id === original.id,
          );
          const selectedAliases = fresh.selectedAgents.filter((agent) =>
            plan.agents.includes(agent),
          );
          const refreshed =
            installation &&
            (await previewBatch(current, installation, selectedAliases));
          const next =
            refreshed &&
            refreshed.block === null &&
            refreshed.destinations.length === 1
              ? refreshed.destinations[0]
              : undefined;
          // Earlier links change the Inventory fingerprint and can create common parents.
          const expected = {
            ...plan,
            inventoryId: current.id,
            directories: plan.directories.filter(
              (path) => !directoriesCreated.has(pathKey(path)),
            ),
          };
          if (
            !next ||
            !installation ||
            !installationPreserved(original, installation) ||
            !isDeepStrictEqual(next, expected)
          ) {
            results.push({
              ...resultDestination(plan),
              status: "blocked",
              message: "The Installation or destination changed after review.",
            });
            continue;
          }
          currentPlan = next;
        }
        result = await apply(currentPlan, directoriesCreated);
      } catch (error) {
        result = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      results.push({ ...resultDestination(plan), ...result });
    }
    try {
      const final = (await options.scan()).installations.find(
        (item) => item.id === original.id,
      );
      for (const [index, result] of results.entries()) {
        if (
          succeeded(result) &&
          (!final ||
            !installationPreserved(original, final) ||
            !(await destinationVerified(final, fresh.destinations[index]!)))
        )
          results[index] = {
            ...result,
            status: "unresolved",
            message:
              "A fresh scan could not verify the requested destination and original Installation.",
          };
      }
    } catch (error) {
      for (const [index, result] of results.entries())
        if (succeeded(result))
          results[index] = {
            ...result,
            status: "unresolved",
            message: `Unable to verify the destination: ${error instanceof Error ? error.message : String(error)}`,
          };
    }
    const completed = results.filter(succeeded).length;
    const status =
      completed === results.length
        ? "succeeded"
        : completed > 0
          ? "partial"
          : results.every((result) => result.status === "blocked")
            ? "blocked"
            : "failed";
    const message =
      results.length === 1
        ? results[0]!.message
        : `${completed} of ${results.length} destinations verified for ${original.skill.name}.`;
    return { status, results, message };
  }

  async function execute(
    plan: AddAgentPlan,
    confirmed: boolean,
  ): Promise<AddAgentReport> {
    const batch: AddAgentBatchPlan = {
      installationId: plan.installationId,
      selectedAgents: [plan.agent],
      destinations: [plan],
      block: plan.action === "blocked" ? plan.reason : null,
    };
    const report = await executeBatch(batch, confirmed);
    const result = report.results[0];
    return result
      ? { status: result.status, message: result.message }
      : { status: "blocked", message: report.message };
  }
  return { preview, execute, previewBatch, executeBatch };
}

function resultDestination(plan: AddAgentPlan) {
  return { destination: plan.destination, agents: plan.agents };
}

function succeeded(result: AddAgentReport): boolean {
  return result.status === "added" || result.status === "unchanged";
}

function installationPreserved(
  before: Installation,
  after: Installation,
): boolean {
  return (
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
    )
  );
}
export interface AddAgentDestinationResult extends AddAgentReport {
  readonly destination: string | null;
  readonly agents: readonly string[];
}

export interface AddAgentBatchReport {
  readonly status: "succeeded" | "partial" | "blocked" | "failed";
  readonly message: string;
  readonly results: readonly AddAgentDestinationResult[];
}
export type AddAgentModule = ReturnType<typeof createAddAgentModule>;
