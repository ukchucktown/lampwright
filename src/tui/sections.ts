import type {
  Installation,
  InstallationGroup,
  Inventory,
  LogicalSkill,
  PluginBoundary,
  RemovalTarget,
} from "../model/types.js";
import type { TuiEntry, TuiSection } from "./types.js";

/**
 * Projects an Inventory into the sections the terminal browses.
 *
 * Every fact here is read from declared evidence: Groups decide bundles,
 * `exposedTo` decides agents, `runtimeDefault` decides what an agent ships with
 * itself, and System Skill findings decide what is out of reach. Nothing is
 * inferred from a name or a path.
 */
export function createTuiSections(inventory: Inventory): readonly TuiSection[] {
  const installations = new Map(
    inventory.installations.map((item) => [item.id, item]),
  );
  const groupById = new Map(inventory.groups.map((group) => [group.id, group]));
  const pluginOwned = new Set(
    inventory.plugins.flatMap((plugin) => plugin.installationIds),
  );

  const entryFor = (logical: LogicalSkill): TuiEntry => {
    const members = logical.installationIds
      .map((id) => installations.get(id))
      .filter((item): item is Installation => item !== undefined);
    const paths = members.flatMap((item) => [
      item.location.path,
      ...(item.removal.supplementalArtifacts ?? []).map(
        (artifact) => artifact.location.path,
      ),
    ]);
    return {
      key: `skill:${logical.id}`,
      name: logical.skill.name,
      description: logical.skill.description,
      exposedTo: [...new Set(members.flatMap((item) => item.exposedTo))].sort(
        compare,
      ),
      paths,
      owner: ownerLabel(members),
      note: entryNote(logical, members),
      target: { kind: "logical-skill", logicalSkillId: logical.id },
    };
  };

  const skills = inventory.logicalSkills.filter(
    (logical) => !logical.installationIds.some((id) => pluginOwned.has(id)),
  );
  // An Installation with no strong identity evidence belongs to no Logical
  // Skill. Listing only Logical Skills would make it invisible, so it stands
  // for itself and targets its own physical occurrence.
  const covered = new Set(
    inventory.logicalSkills.flatMap((logical) => logical.installationIds),
  );
  const loneEntries = inventory.installations
    .filter((item) => !covered.has(item.id) && !pluginOwned.has(item.id))
    .map((item): TuiEntry => ({
      key: `installation:${item.id}`,
      name: item.skill.name,
      description: item.skill.description,
      exposedTo: [...item.exposedTo].sort(compare),
      paths: [
        item.location.path,
        ...(item.removal.supplementalArtifacts ?? []).map(
          (artifact) => artifact.location.path,
        ),
      ],
      owner: item.manager?.id ?? item.ownership.kind,
      note: entryNote(null, [item]),
      target: { kind: "installation", installationId: item.id },
    }));
  const sections: TuiSection[] = [];

  for (const group of [...inventory.groups].sort(
    (left, right) => memberCount(right, skills) - memberCount(left, skills),
  )) {
    const members = skills.filter((logical) => logical.groupId === group.id);
    if (members.length === 0) continue;
    sections.push({
      key: `group:${group.id}`,
      label: group.label,
      detail: `${evidenceLabel(group)} · ${group.scope.kind}`,
      selectable: true,
      target: { kind: "source-group", groupId: group.id },
      entries: sorted(members.map(entryFor)),
    });
  }

  const ungrouped = skills.filter(
    (logical) => logical.groupId === null || !groupById.has(logical.groupId),
  );
  if (ungrouped.length > 0 || loneEntries.length > 0)
    sections.push({
      key: "ungrouped",
      label: "No shared source",
      detail: "no Owner records these together",
      selectable: true,
      target: null,
      entries: sorted([...ungrouped.map(entryFor), ...loneEntries]),
    });

  if (inventory.plugins.length > 0)
    sections.push({
      key: "plugins",
      label: "Plugins",
      detail: "removable through their own manager, never by a bulk sweep",
      selectable: true,
      target: null,
      entries: sorted(inventory.plugins.map((plugin) => pluginEntry(plugin))),
    });

  const system = inventory.otherFindings.filter(
    (finding) => finding.classification === "system-skill",
  );
  if (system.length > 0)
    sections.push({
      key: "system",
      label: "System skills",
      detail: "inseparable runtime content; not removable",
      selectable: false,
      target: null,
      entries: sorted(
        system.map((finding) => ({
          key: `finding:${finding.id}`,
          name: finding.skill.name,
          description: finding.skill.description,
          exposedTo: finding.agentId === null ? [] : [finding.agentId],
          paths: [finding.location.path],
          owner: "agent runtime",
          note: "protected",
          target: null,
        })),
      ),
    });

  return sections;
}

function evidenceLabel(group: InstallationGroup): string {
  return group.evidence.kind === "manager-source"
    ? group.evidence.managerId
    : group.evidence.remoteUrl;
}

function pluginEntry(plugin: PluginBoundary): TuiEntry {
  const resources = plugin.resources
    .map((resource) => resource.location?.path)
    .filter((path): path is string => path !== undefined);
  return {
    key: `plugin:${plugin.id}`,
    name:
      plugin.version === null
        ? plugin.pluginId
        : `${plugin.pluginId}@${plugin.version}`,
    description: `${String(plugin.installationIds.length)} owned skills, ${String(plugin.resources.length)} resources`,
    exposedTo: [plugin.ownership.pluginId],
    paths: resources,
    owner: plugin.adapterId ?? "plugin",
    note: plugin.runtimeDefault ? "agent default" : null,
    target: { kind: "plugin", pluginBoundaryId: plugin.id },
  };
}

/** Only worth a column when it departs from what the section already says. */
function entryNote(
  logical: LogicalSkill | null,
  members: readonly Installation[],
): string | null {
  if (logical?.spansGroups === true) return "spans groups";
  if (
    members.some(
      (item) =>
        item.protection.git.kind === "protected" ||
        item.protection.system.kind === "system-skill" ||
        item.protection.filesystem.kind === "read-only",
    )
  )
    return "protected";
  if (members.some((item) => item.status === "broken")) return "broken";
  return null;
}

function ownerLabel(members: readonly Installation[]): string {
  const first = members[0];
  if (first === undefined) return "unknown";
  return first.manager?.id ?? first.ownership.kind;
}

function memberCount(
  group: InstallationGroup,
  skills: readonly LogicalSkill[],
): number {
  return skills.filter((logical) => logical.groupId === group.id).length;
}

function sorted(entries: readonly TuiEntry[]): readonly TuiEntry[] {
  return [...entries].sort((left, right) => compare(left.name, right.name));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Targets a selection expands to, collapsing a whole bundle into its Group. */
export function selectionTargets(
  sections: readonly TuiSection[],
  selected: ReadonlySet<string>,
): readonly RemovalTarget[] {
  const targets: RemovalTarget[] = [];
  for (const section of sections) {
    const chosen = section.entries.filter((entry) => selected.has(entry.key));
    if (chosen.length === 0) continue;
    if (
      section.target !== null &&
      chosen.length === section.entries.length &&
      section.entries.length > 0
    ) {
      targets.push(section.target);
      continue;
    }
    for (const entry of chosen)
      if (entry.target !== null) targets.push(entry.target);
  }
  return targets;
}
