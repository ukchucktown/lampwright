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
      availabilityTargets: [
        { kind: "logical-skill", logicalSkillId: logical.id },
      ],
    };
  };

  const visibleInstallation = (item: Installation): boolean =>
    item.harnessExposures.length === 0 ||
    item.harnessExposures.some((exposure) => exposure.status !== "disabled");
  const ordinarySkills = inventory.logicalSkills.filter(
    (logical) => !logical.installationIds.some((id) => pluginOwned.has(id)),
  );
  const skills = ordinarySkills.filter((logical) =>
    logical.installationIds
      .map((id) => installations.get(id))
      .filter((item): item is Installation => item !== undefined)
      .some(visibleInstallation),
  );
  // An Installation with no strong identity evidence belongs to no Logical
  // Skill. Listing only Logical Skills would make it invisible, so it stands
  // for itself and targets its own physical occurrence.
  const covered = new Set(
    inventory.logicalSkills.flatMap((logical) => logical.installationIds),
  );
  const loneEntries = inventory.installations
    .filter(
      (item) =>
        !covered.has(item.id) &&
        !pluginOwned.has(item.id) &&
        visibleInstallation(item),
    )
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
      availabilityTargets: [{ kind: "installation", installationId: item.id }],
    }));
  const sections: TuiSection[] = [];

  for (const group of [...inventory.groups].sort(
    (left, right) => memberCount(right, skills) - memberCount(left, skills),
  )) {
    const members = skills.filter((logical) => logical.groupId === group.id);
    const allMembers = ordinarySkills.filter(
      (logical) => logical.groupId === group.id,
    );
    if (members.length === 0) continue;
    sections.push({
      key: `group:${group.id}`,
      label: group.label,
      detail: `${evidenceLabel(group)} · ${group.scope.kind}`,
      selectable: true,
      // A hidden fully disabled member must not ride along in a Removal Group
      // target merely because every visible row was selected.
      target:
        members.length === allMembers.length
          ? { kind: "source-group", groupId: group.id }
          : null,
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

  const inventoryPlugins = inventory.plugins.filter(
    (plugin) => plugin.availability.status !== "disabled",
  );
  if (inventoryPlugins.length > 0)
    sections.push({
      key: "plugins",
      label: "Plugins",
      detail:
        "select a custom Plugin parent; enter reviews removal and d reviews disable",
      selectable: inventoryPlugins.some((plugin) => !plugin.runtimeDefault),
      target: null,
      entries: [...inventoryPlugins]
        .sort((left, right) =>
          compare(pluginDisplayName(left), pluginDisplayName(right)),
        )
        .flatMap((plugin) => pluginEntries(plugin, installations)),
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

export function pluginEntries(
  plugin: PluginBoundary,
  installations: ReadonlyMap<Installation["id"], Installation>,
): readonly TuiEntry[] {
  const ownedSkills = plugin.installationIds
    .map((id) => installations.get(id))
    .filter((item): item is Installation => item !== undefined)
    .sort((left, right) => compare(left.skill.name, right.skill.name));
  const resources = plugin.resources
    .map((resource) => resource.location?.path)
    .filter((path): path is string => path !== undefined);
  const boundary: TuiEntry = {
    key: `plugin:${plugin.id}`,
    name: pluginDisplayName(plugin),
    description: plugin.runtimeDefault
      ? `Agent-supplied Plugin with ${String(ownedSkills.length)} owned Skills and ${String(plugin.resources.length)} other known resources.`
      : `Custom Plugin with ${String(ownedSkills.length)} owned Skills and ${String(plugin.resources.length)} other known resources. Enter reviews complete removal; d reviews whole-Plugin disable while everything remains installed.`,
    exposedTo: [...plugin.exposedTo].sort(compare),
    paths: [...new Set(resources)],
    owner: plugin.adapterId ?? "plugin",
    note: [
      plugin.exposedTo.join(", "),
      plugin.runtimeDefault ? "agent default · protected" : "custom Plugin",
    ]
      .filter((value): value is string => value !== null && value !== "")
      .join(" · "),
    showNoteInRow: false,
    target: plugin.runtimeDefault
      ? null
      : { kind: "plugin", pluginBoundaryId: plugin.id },
    availabilityTargets: plugin.runtimeDefault
      ? []
      : [{ kind: "plugin", pluginBoundaryId: plugin.id }],
  };
  const skillRows = ownedSkills.map((installation, index): TuiEntry => ({
    key: `plugin-skill:${plugin.id}:${installation.id}`,
    rowKind: "plugin-skill",
    treeBranch: index === ownedSkills.length - 1 ? "last" : "middle",
    name: installation.skill.name,
    description: installation.skill.description,
    exposedTo: [...installation.exposedTo].sort(compare),
    paths: [
      installation.location.path,
      ...(installation.removal.supplementalArtifacts ?? []).map(
        (artifact) => artifact.location.path,
      ),
    ],
    owner: plugin.pluginId,
    note: "owned Skill · view only",
    showNoteInRow: false,
    target: null,
    selectable: false,
  }));
  return [boundary, ...skillRows];
}

function pluginDisplayName(plugin: PluginBoundary): string {
  return plugin.version === null
    ? plugin.pluginId
    : `${plugin.pluginId}@${plugin.version}`;
}

/** Only worth a column when it departs from what the section already says. */
function entryNote(
  logical: LogicalSkill | null,
  members: readonly Installation[],
): string | null {
  const notes: string[] = [];
  if (logical?.spansGroups === true) notes.push("spans groups");
  const exposures = members.flatMap((item) => item.harnessExposures);
  const disabled = [
    ...new Set(
      exposures
        .filter((exposure) => exposure.status === "disabled")
        .map((exposure) => exposure.harnessId),
    ),
  ].sort(compare);
  const enabled = [
    ...new Set(
      exposures
        .filter((exposure) => exposure.status === "enabled")
        .map((exposure) => exposure.harnessId),
    ),
  ].sort(compare);
  const unresolved = [
    ...new Set(
      exposures
        .filter((exposure) => exposure.status === "unresolved")
        .map((exposure) => exposure.harnessId),
    ),
  ].sort(compare);
  if (disabled.length > 0 && enabled.length + unresolved.length > 0) {
    notes.push(`disabled in ${disabled.join(", ")}`);
    if (enabled.length > 0) notes.push(`enabled in ${enabled.join(", ")}`);
    if (unresolved.length > 0)
      notes.push(`unresolved in ${unresolved.join(", ")}`);
  }
  if (
    members.some(
      (item) =>
        item.protection.git.kind === "protected" ||
        item.protection.system.kind === "system-skill" ||
        item.protection.filesystem.kind === "read-only",
    )
  )
    notes.push("protected");
  if (members.some((item) => item.status === "broken")) notes.push("broken");
  return notes.length === 0 ? null : notes.join(" · ");
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
