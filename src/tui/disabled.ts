import type { AvailabilityTarget } from "../availability/types.js";
import type { DisabledEntry } from "../disabled-storage/types.js";
import type { Installation, Inventory } from "../model/types.js";
import type { TuiEntry, TuiSection } from "./types.js";
import { createTuiSections } from "./sections.js";

/** A display projection only; it never infers identity or mutates availability. */
export function createDisabledSections(
  inventory: Inventory,
  entries: readonly DisabledEntry[],
): readonly TuiSection[] {
  const pluginOwned = new Set(
    inventory.plugins.flatMap((plugin) => plugin.installationIds),
  );
  const native: TuiEntry[] = [];
  for (const installation of inventory.installations) {
    for (const exposure of installation.harnessExposures) {
      if (exposure.status !== "disabled") continue;
      const selectable = selectableInstallation(installation, pluginOwned);
      native.push({
        key: `disabled-native:${installation.id}:${exposure.harnessId}`,
        name: installation.skill.name,
        description: installation.skill.description,
        exposedTo: [exposure.harnessId],
        paths: [installation.location.path],
        owner: installation.manager?.id ?? installation.ownership.kind,
        note: selectable
          ? `Native · selecting enables all disabled harnesses for this Installation`
          : "Native · informational only",
        target: null,
        availabilityTargets: selectable
          ? [installationTarget(installation)]
          : [],
        selectable,
      });
    }
  }

  const suspended = entries.map((entry): TuiEntry => {
    const selectable =
      entry.ownership.kind !== "plugin" &&
      entry.ownership.kind !== "agent-runtime";
    return {
      key: `disabled-entry:${entry.id}`,
      name: entry.operation.displayNames.join(", "),
      description: null,
      exposedTo: [...new Set(entry.harnessExposures.map((x) => x.harnessId))],
      paths: [entry.originalLocation.path],
      owner: entry.ownership.kind,
      note: selectable
        ? `Suspended · restores one stored artifact for ${String(entry.installationIds.length)} Installation(s)`
        : "Suspended · informational only",
      target: null,
      availabilityTargets: selectable
        ? entry.installationIds.map((installationId) => ({
            kind: "installation" as const,
            installationId,
          }))
        : [],
      selectable,
    };
  });

  const sections: TuiSection[] = [];
  if (native.length > 0)
    sections.push(
      section(
        "disabled-native",
        "Native",
        "disabled by harness configuration",
        native,
      ),
    );
  if (suspended.length > 0)
    sections.push(
      section(
        "disabled-suspended",
        "Suspended",
        "stored outside Trash with no expiry",
        suspended,
      ),
    );
  sections.push(
    ...createTuiSections(inventory).filter(
      (candidate) => candidate.key === "plugins" || candidate.key === "system",
    ),
  );
  return sections;
}

function section(
  key: string,
  label: string,
  detail: string,
  entries: readonly TuiEntry[],
): TuiSection {
  return {
    key,
    label,
    detail,
    selectable: true,
    target: null,
    entries: [...entries].sort((a, b) =>
      a.name === b.name
        ? a.key.localeCompare(b.key)
        : a.name.localeCompare(b.name),
    ),
  };
}

function selectableInstallation(
  installation: Installation,
  pluginOwned: ReadonlySet<Installation["id"]>,
): boolean {
  return (
    !pluginOwned.has(installation.id) &&
    installation.ownership.kind !== "plugin" &&
    installation.ownership.kind !== "agent-runtime" &&
    installation.protection.system.kind !== "system-skill"
  );
}

function installationTarget(installation: Installation): AvailabilityTarget {
  return { kind: "installation", installationId: installation.id };
}

export function disabledSelectionTargets(
  sections: readonly TuiSection[],
  selected: ReadonlySet<string>,
): readonly AvailabilityTarget[] {
  const targets = sections
    .flatMap((section) => section.entries)
    .filter((entry) => selected.has(entry.key))
    .flatMap((entry) => entry.availabilityTargets ?? []);
  return targets.filter(
    (target, index) =>
      targets.findIndex(
        (candidate) => targetKey(candidate) === targetKey(target),
      ) === index,
  );
}

function targetKey(target: AvailabilityTarget): string {
  if (target.kind === "installation")
    return `installation:${target.installationId}`;
  if (target.kind === "logical-skill")
    return `logical-skill:${target.logicalSkillId}`;
  return `group:${target.groupId}`;
}
