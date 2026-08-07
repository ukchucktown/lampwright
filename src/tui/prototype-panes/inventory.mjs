// PROTOTYPE — read-only projection from the product Inventory into panes.
// Performs the same bounded scan as `skill-cleaner scan`. Cannot plan, execute,
// or persist anything.

import { homedir } from "node:os";
import { relative, sep } from "node:path";

import { SECTION_KINDS } from "./model.mjs";

export async function loadSections() {
  const { scan } = await import("../../../dist/inventory/index.js");
  const inventory = await scan({});
  return project(inventory);
}

function short(path) {
  const rel = relative(homedir(), path);
  return rel.startsWith("..") ? path : `~${sep}${rel}`;
}

function project(inventory) {
  const byId = new Map(inventory.installations.map((i) => [i.id, i]));

  const skillOf = (logical) => {
    const members = logical.installationIds
      .map((id) => byId.get(id))
      .filter(Boolean);
    const paths = members.flatMap((m) => [
      m.location.path,
      ...(m.removal.supplementalArtifacts ?? []).map((a) => a.location.path),
    ]);
    const first = members[0];
    return {
      key: logical.id,
      name: logical.skill.name,
      description: logical.skill.description ?? "",
      exposedTo: [...new Set(members.flatMap((m) => m.exposedTo))].sort(),
      paths: paths.map(short),
      owner: first?.manager?.id ?? first?.ownership.kind ?? "unknown",
      protectedSkill: members.some(
        (m) =>
          m.protection.git.kind === "protected" ||
          m.protection.system.kind === "system-skill",
      ),
      pluginOwned: first?.ownership.kind === "plugin",
      groupId: logical.groupId,
      spansGroups: logical.spansGroups,
      bundle: "",
    };
  };

  const skills = inventory.logicalSkills.map(skillOf);
  const sections = [];

  for (const group of inventory.groups) {
    const members = skills.filter((s) => s.groupId === group.id);
    if (members.length === 0) continue;
    for (const m of members) m.bundle = group.label;
    sections.push({
      id: `bundle:${group.id}`,
      kind: SECTION_KINDS.bundle,
      label: group.label,
      detail: `${group.evidence.managerId} · ${group.tier} evidence · ${group.scope.kind} scope`,
      selectable: true,
      skills: members.sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  sections.sort((a, b) => b.skills.length - a.skills.length);

  const loose = skills.filter(
    (s) => !s.groupId && !s.pluginOwned && !s.protectedSkill,
  );
  for (const m of loose) m.bundle = "—";
  sections.push({
    id: "loose",
    kind: SECTION_KINDS.loose,
    label: "No shared source",
    detail: "installed individually; no Owner records them together",
    selectable: true,
    skills: loose.sort((a, b) => a.name.localeCompare(b.name)),
  });

  const runtime = skills.filter((s) => s.pluginOwned);
  for (const m of runtime) m.bundle = "runtime plugin";
  sections.push({
    id: "runtime",
    kind: SECTION_KINDS.runtime,
    label: "Runtime plugins",
    detail: "shipped by the agent; removable, but never by a bulk sweep",
    selectable: true,
    skills: runtime.sort((a, b) => a.name.localeCompare(b.name)),
  });

  const system = inventory.otherFindings
    .filter((f) => f.classification === "system-skill")
    .map((f) => ({
      key: f.id,
      name: f.skill.name,
      description: f.skill.description ?? "",
      exposedTo: [f.agentId ?? "unknown"],
      paths: [short(f.location.path)],
      owner: "agent runtime",
      protectedSkill: true,
      pluginOwned: false,
      groupId: null,
      spansGroups: false,
      bundle: "system",
    }));
  sections.push({
    id: "system",
    kind: SECTION_KINDS.system,
    label: "System skills",
    detail: "inseparable runtime content; outside the removal boundary",
    selectable: false,
    skills: system.sort((a, b) => a.name.localeCompare(b.name)),
  });

  return sections;
}
