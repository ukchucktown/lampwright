// PROTOTYPE: read-only projection from the product Inventory into navigation groups.

export async function loadRealGroups() {
  const { runCli } = await import("../../../dist/cli.js");
  const result = await runCli(["scan", "--json"]);
  if (result.exitCode !== 0 || !isInventory(result.output))
    throw new Error(
      "The read-only skill-cleaner scan did not return an Inventory",
    );
  return projectInventory(result.output);
}

function projectInventory(inventory) {
  const installations = new Map(
    inventory.installations.map((installation) => [
      installation.id,
      installation,
    ]),
  );
  const groupedInstallationIds = new Set();
  const result = [];

  for (const plugin of sorted(inventory.plugins, (value) => value.pluginId)) {
    const owned = plugin.installationIds
      .map((id) => installations.get(id))
      .filter(Boolean);
    for (const installation of owned)
      groupedInstallationIds.add(installation.id);
    const sources = unique(
      owned.map((value) => value.source?.id).filter(Boolean),
    );
    const scopes = unique(owned.map((value) => scopeLabel(value.scope)));
    result.push({
      id: `plugin:${plugin.id}`,
      name: `${plugin.pluginId}${plugin.version === null ? "" : `@${plugin.version}`}`,
      kind: "Plugin",
      owner: plugin.ownership.pluginId,
      source:
        sources.length === 0 ? `plugin:${plugin.pluginId}` : sources.join(", "),
      scope: scopes.join(", ") || "unknown",
      evidence: "declared Plugin boundary",
      removalBoundary: true,
      skills: sorted(owned.map(projectSkill), (value) => value.name),
    });
  }

  const sourceGroups = new Map();
  for (const installation of inventory.installations) {
    if (groupedInstallationIds.has(installation.id)) continue;
    if (installation.manager === null || installation.source === null) continue;
    const key = [
      installation.manager.id,
      installation.source.id,
      scopeKey(installation.scope),
    ].join("\u0000");
    const existing = sourceGroups.get(key) ?? {
      id: `source:${key}`,
      name: installation.source.id,
      kind: "Source Group",
      owner: installation.manager.id,
      source: installation.source.url ?? installation.source.id,
      scope: scopeLabel(installation.scope),
      evidence: "manager + source + scope",
      removalBoundary: false,
      skills: [],
    };
    existing.skills.push(projectSkill(installation));
    sourceGroups.set(key, existing);
    groupedInstallationIds.add(installation.id);
  }
  for (const group of sourceGroups.values()) {
    group.skills = sorted(group.skills, (value) => value.name);
    result.push(group);
  }

  const collections = new Map();
  for (const installation of inventory.installations) {
    if (groupedInstallationIds.has(installation.id)) continue;
    const owner = ownerLabel(installation);
    const scope = scopeLabel(installation.scope);
    const key = `${installation.agentId}\u0000${scope}\u0000${owner}`;
    const existing = collections.get(key) ?? {
      id: `collection:${key}`,
      name: `${installation.agentId} · ${scope}`,
      kind: "Navigation collection",
      owner,
      source: "no shared Manager/source evidence",
      scope,
      evidence: "display-only collection",
      removalBoundary: false,
      skills: [],
    };
    existing.skills.push(projectSkill(installation));
    collections.set(key, existing);
  }
  for (const group of collections.values()) {
    group.skills = sorted(group.skills, (value) => value.name);
    result.push(group);
  }

  return result.sort(
    (left, right) =>
      groupRank(left) - groupRank(right) || compare(left.name, right.name),
  );
}

function projectSkill(installation) {
  const tags = [
    ...installation.tags,
    ...(installation.protection.git.kind === "protected"
      ? ["git-protected"]
      : []),
    ...(installation.protection.system.kind === "system-skill"
      ? ["system-skill"]
      : []),
    ...(installation.protection.filesystem.kind === "read-only"
      ? ["read-only"]
      : []),
    ...(installation.status === "broken" ? ["broken-link"] : []),
  ];
  return {
    id: installation.id,
    name: installation.skill.name,
    description: installation.skill.description ?? "No description",
    status: removalLabel(installation),
    path: installation.location.path,
    tags: unique(tags),
  };
}

function removalLabel(installation) {
  if (installation.protection.git.kind === "protected") return "Git protected";
  if (installation.protection.system.kind === "system-skill")
    return "System Skill";
  if (installation.status === "broken") return "broken";
  if (installation.removal.managed?.availability.kind === "available")
    return installation.ownership.kind === "plugin"
      ? "plugin-owned"
      : "managed";
  if (installation.removal.fallback.kind === "available") return "quarantine";
  return "unavailable";
}

function ownerLabel(installation) {
  if (installation.manager !== null) return installation.manager.id;
  if (installation.plugin !== null) return installation.plugin.id;
  if (installation.ownership.kind === "agent-runtime")
    return installation.ownership.agentId;
  return installation.ownership.kind;
}

function scopeKey(scope) {
  if (scope.kind === "user") return "user";
  if (scope.kind === "agent") return `agent:${scope.agentId}`;
  return `workspace:${scope.workspacePath}`;
}

function scopeLabel(scope) {
  if (scope.kind === "user") return "user";
  if (scope.kind === "agent") return `agent:${scope.agentId}`;
  return `workspace:${scope.workspacePath}`;
}

function groupRank(group) {
  return group.kind === "Source Group" ? 0 : group.kind === "Plugin" ? 1 : 2;
}

function isInventory(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    value.schemaVersion === 1 &&
    Array.isArray(value.installations) &&
    Array.isArray(value.plugins)
  );
}

function unique(values) {
  return [...new Set(values)];
}

function sorted(values, key) {
  return [...values].sort((left, right) => compare(key(left), key(right)));
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
