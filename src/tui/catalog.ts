import type {
  Installation,
  Inventory,
  JsonValue,
  LogicalSkill,
  NonInstallationFinding,
  PluginBoundary,
  ProtectionStatus,
  Scope,
} from "../model/types.js";
import type {
  TuiCatalogGroup,
  TuiRow,
  TuiSearchFields,
  TuiSummaryStatus,
  TuiVisibleRow,
} from "./types.js";

const filterNames = new Set([
  "plugin",
  "agent",
  "scope",
  "source",
  "manager",
  "status",
]);

interface QueryToken {
  readonly field: keyof Omit<TuiSearchFields, "all"> | null;
  readonly value: string;
}

interface MatchedGroup {
  readonly group: TuiCatalogGroup;
  readonly parentScore: number;
  readonly childScores: ReadonlyMap<string, number>;
  readonly score: number;
  readonly index: number;
}

export function createTuiCatalog(
  inventory: Inventory,
): readonly TuiCatalogGroup[] {
  const installations = new Map(
    inventory.installations.map((installation) => [
      installation.id,
      installation,
    ]),
  );
  const groupedIds = new Set(
    inventory.logicalSkills.flatMap((logical) => logical.installationIds),
  );
  const groups: TuiCatalogGroup[] = [];

  for (const logical of sorted(inventory.logicalSkills, logicalKey)) {
    const children = logical.installationIds
      .map((id) => installations.get(id))
      .filter((value): value is Installation => value !== undefined)
      .map((installation) => installationRow(installation, 1));
    groups.push({ row: logicalRow(logical, children), children });
  }
  for (const installation of sorted(
    inventory.installations.filter(
      (candidate) => !groupedIds.has(candidate.id),
    ),
    installationKey,
  )) {
    groups.push({ row: installationRow(installation, 0), children: [] });
  }
  for (const plugin of sorted(inventory.plugins, pluginKey)) {
    groups.push({ row: pluginRow(plugin, installations), children: [] });
  }
  for (const finding of sorted(inventory.otherFindings, findingKey)) {
    groups.push({ row: findingRow(finding), children: [] });
  }
  return groups;
}

export function visibleTuiRows(
  catalog: readonly TuiCatalogGroup[],
  expandedKeys: ReadonlySet<string>,
  query: string,
): readonly TuiVisibleRow[] {
  const tokens = parseQuery(query);
  const searching = tokens.length > 0;
  const inspection = tokens.some((token) => token.field === "status");
  const matches: MatchedGroup[] = [];

  catalog.forEach((group, index) => {
    if (group.row.hiddenByDefault && !inspection) return;
    const parentScore = searching ? scoreRow(group.row, tokens) : 0;
    const childScores = new Map<string, number>();
    for (const child of group.children) {
      const score = searching ? scoreRow(child, tokens) : 0;
      if (!searching || score >= 0) childScores.set(child.key, score);
    }
    const score = Math.max(parentScore, ...childScores.values());
    if (!searching || score >= 0)
      matches.push({ group, parentScore, childScores, score, index });
  });

  if (searching)
    matches.sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );

  return matches.flatMap(({ group, parentScore, childScores }) => {
    const expanded = expandedKeys.has(group.row.key);
    const parent: TuiVisibleRow = { ...group.row, expanded };
    const showSearchChildren =
      searching && parentScore < 0 && childScores.size > 0;
    if (!expanded && !showSearchChildren) return [parent];
    const children = group.children
      .filter((child) => !searching || childScores.has(child.key))
      .map((child): TuiVisibleRow => ({ ...child, expanded: false }));
    return [parent, ...children];
  });
}

export function parseTuiQuery(
  query: string,
): readonly { readonly field: string | null; readonly value: string }[] {
  return parseQuery(query);
}

function parseQuery(query: string): readonly QueryToken[] {
  return query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((raw): QueryToken => {
      const separator = raw.indexOf(":");
      const field = raw.slice(0, separator).toLocaleLowerCase("en-US");
      if (separator > 0 && filterNames.has(field))
        return {
          field: field as QueryToken["field"],
          value: raw.slice(separator + 1),
        };
      return { field: null, value: raw };
    })
    .filter((token) => token.value.length > 0);
}

function scoreRow(row: TuiRow, tokens: readonly QueryToken[]): number {
  let total = 0;
  for (const token of tokens) {
    const values =
      token.field === null ? row.search.all : row.search[token.field];
    const score = Math.max(
      ...values.map((value) => fuzzyScore(token.value, value)),
    );
    if (score < 0) return -1;
    total += score;
  }
  return total;
}

function fuzzyScore(needleValue: string, haystackValue: string): number {
  const needle = normalize(needleValue);
  const haystack = normalize(haystackValue);
  if (needle.length === 0) return 0;
  if (haystack === needle) return 1_000;
  if (haystack.startsWith(needle))
    return 800 - (haystack.length - needle.length);
  const index = haystack.indexOf(needle);
  if (index >= 0) return 600 - index;
  let needleIndex = 0;
  let first = -1;
  let last = -1;
  for (
    let index = 0;
    index < haystack.length && needleIndex < needle.length;
    index += 1
  ) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (first < 0) first = index;
    last = index;
    needleIndex += 1;
  }
  if (needleIndex !== needle.length) return -1;
  return 300 - (last - first + 1 - needle.length) - first;
}

function logicalRow(
  logical: LogicalSkill,
  children: readonly TuiRow[],
): TuiRow {
  const statuses = children.map((child) => child.summaryStatus);
  const summaryStatus = aggregateStatus(statuses);
  return {
    key: `logical:${logical.id}`,
    kind: "logical-skill",
    name: logical.skill.name,
    description: logical.skill.description,
    summaryStatus,
    target: { kind: "logical-skill", logicalSkillId: logical.id },
    depth: 0,
    childCount: children.length,
    hiddenByDefault: false,
    search: mergeSearchFields(
      baseFields(
        [logical.skill.name, logical.skill.description ?? "", logical.id],
        [summaryStatus],
      ),
      children.map((child) => child.search),
    ),
    installation: null,
    logicalSkill: logical,
    plugin: null,
    finding: null,
  };
}

function installationRow(installation: Installation, depth: 0 | 1): TuiRow {
  const summaryStatus = installationStatus(installation);
  const scope = scopeValues(installation.scope);
  const plugin = compact([
    installation.plugin?.id,
    installation.pluginBoundaryId,
  ]);
  const source = compact([installation.source?.id, installation.source?.url]);
  const manager = compact([
    installation.manager?.id,
    installation.ownership.kind === "manager"
      ? installation.ownership.managerId
      : null,
  ]);
  const status = compact([
    summaryStatus,
    installation.status,
    installation.classification,
  ]);
  const metadata = flattenJson(installation.metadata);
  return {
    key: `installation:${installation.id}`,
    kind: "installation",
    name: installation.skill.name,
    description: installation.skill.description,
    summaryStatus,
    target: { kind: "installation", installationId: installation.id },
    depth,
    childCount: 0,
    hiddenByDefault: false,
    search: {
      all: compact([
        installation.skill.name,
        installation.skill.description,
        installation.id,
        installation.adapterId,
        installation.agentId,
        installation.location.path,
        installation.location.canonicalPath,
        installation.ownership.kind,
        ...installation.tags,
        ...plugin,
        ...scope,
        ...source,
        ...manager,
        ...status,
        ...metadata,
      ]),
      plugin,
      agent: [installation.agentId],
      scope,
      source,
      manager,
      status,
    },
    installation,
    logicalSkill: null,
    plugin: null,
    finding: null,
  };
}

function pluginRow(
  plugin: PluginBoundary,
  installations: ReadonlyMap<string, Installation>,
): TuiRow {
  const ownedInstallations = plugin.installationIds
    .map((id) => installations.get(id))
    .filter((value): value is Installation => value !== undefined);
  const status = pluginStatus(plugin, ownedInstallations);
  const agents = compact(ownedInstallations.map((value) => value.agentId));
  const scopes = compact(
    ownedInstallations.flatMap((value) => scopeValues(value.scope)),
  );
  const sources = compact(
    ownedInstallations.flatMap((value) => [
      value.source?.id,
      value.source?.url,
    ]),
  );
  const managers = compact(
    ownedInstallations.flatMap((value) => [value.manager?.id]),
  );
  const statuses = compact([
    status,
    ...ownedInstallations.flatMap((value) => [
      value.status,
      value.classification,
    ]),
  ]);
  return {
    key: `plugin:${plugin.id}`,
    kind: "plugin",
    name: plugin.pluginId,
    description:
      plugin.version === null ? "Plugin" : `Plugin ${plugin.version}`,
    summaryStatus: status,
    target: { kind: "plugin", pluginBoundaryId: plugin.id },
    depth: 0,
    childCount: plugin.installationIds.length,
    hiddenByDefault: false,
    search: {
      all: compact([
        plugin.id,
        plugin.pluginId,
        plugin.version,
        plugin.adapterId,
        plugin.ownership.kind,
        ...plugin.resources.flatMap((resource) => [
          resource.kind,
          resource.id,
          resource.location?.path,
        ]),
        ...agents,
        ...scopes,
        ...sources,
        ...managers,
        ...statuses,
      ]),
      plugin: [plugin.id, plugin.pluginId],
      agent: agents,
      scope: scopes,
      source: sources,
      manager: managers,
      status: statuses,
    },
    installation: null,
    logicalSkill: null,
    plugin,
    finding: null,
  };
}

function findingRow(finding: NonInstallationFinding): TuiRow {
  const scope = finding.scope === null ? [] : scopeValues(finding.scope);
  const plugin = compact([finding.plugin?.id]);
  const source = compact([finding.source?.id, finding.source?.url]);
  const manager = compact([
    finding.manager?.id,
    finding.ownership.kind === "manager" ? finding.ownership.managerId : null,
  ]);
  const status = compact([
    "source-only",
    finding.classification,
    finding.classification === "system-skill" ? "protected" : null,
  ]);
  return {
    key: `finding:${finding.id}`,
    kind: "finding",
    name: finding.skill.name,
    description: finding.skill.description,
    summaryStatus: "source-only",
    target: null,
    depth: 0,
    childCount: 0,
    hiddenByDefault: true,
    search: {
      all: compact([
        finding.skill.name,
        finding.skill.description,
        finding.id,
        finding.adapterId,
        finding.agentId,
        finding.location.path,
        finding.ownership.kind,
        ...finding.tags,
        ...plugin,
        ...scope,
        ...source,
        ...manager,
        ...status,
        ...flattenJson(finding.metadata),
      ]),
      plugin,
      agent: compact([finding.agentId]),
      scope,
      source,
      manager,
      status,
    },
    installation: null,
    logicalSkill: null,
    plugin: null,
    finding,
  };
}

function installationStatus(installation: Installation): TuiSummaryStatus {
  if (installation.status !== "active") return "unresolved";
  if (isProtected(installation.protection)) return "protected";
  if (
    installation.removal.managed?.trust.kind === "blocked" ||
    installation.removal.managed?.availability.kind === "unavailable"
  )
    return "protected";
  return "removable";
}

function pluginStatus(
  plugin: PluginBoundary,
  installations: readonly Installation[],
): TuiSummaryStatus {
  const childStatus = aggregateStatus(installations.map(installationStatus));
  if (childStatus !== "removable") return childStatus;
  if (
    plugin.removal.managed?.trust.kind === "blocked" ||
    plugin.removal.managed?.availability.kind === "unavailable" ||
    plugin.removal.managed?.effects.some((effect) =>
      isProtected(effect.protection),
    ) ||
    plugin.resources.some(
      (resource) =>
        resource.protection !== null && isProtected(resource.protection),
    )
  )
    return "protected";
  return "removable";
}

function aggregateStatus(
  statuses: readonly TuiSummaryStatus[],
): TuiSummaryStatus {
  if (statuses.includes("protected")) return "protected";
  if (statuses.includes("unresolved")) return "unresolved";
  if (statuses.includes("source-only")) return "source-only";
  return "removable";
}

function isProtected(protection: ProtectionStatus): boolean {
  return (
    protection.git.kind === "protected" ||
    protection.system.kind === "system-skill" ||
    protection.filesystem.kind === "read-only"
  );
}

function scopeValues(scope: Scope): readonly string[] {
  if (scope.kind === "user") return ["user"];
  if (scope.kind === "workspace") return ["workspace", scope.workspacePath];
  return ["agent", scope.agentId];
}

function baseFields(
  all: readonly string[],
  status: readonly string[],
): TuiSearchFields {
  return {
    all: [...all, ...status],
    plugin: [],
    agent: [],
    scope: [],
    source: [],
    manager: [],
    status,
  };
}

function mergeSearchFields(
  base: TuiSearchFields,
  fields: readonly TuiSearchFields[],
): TuiSearchFields {
  const merge = (key: keyof TuiSearchFields): readonly string[] =>
    compact([base[key], ...fields.map((field) => field[key])].flat());
  return {
    all: merge("all"),
    plugin: merge("plugin"),
    agent: merge("agent"),
    scope: merge("scope"),
    source: merge("source"),
    manager: merge("manager"),
    status: merge("status"),
  };
}

function flattenJson(value: JsonValue, prefix = "metadata"): readonly string[] {
  if (value === null) return [`${prefix}:null`];
  if (typeof value !== "object")
    return [prefix, `${prefix}:${String(value)}`, String(value)];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      flattenJson(item, `${prefix}.${index}`),
    );
  return Object.entries(value).flatMap(([key, item]) =>
    flattenJson(item, `${prefix}.${key}`),
  );
}

function compact(
  values: readonly (string | null | undefined)[],
): readonly string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          value !== null && value !== undefined && value.length > 0,
      ),
    ),
  ];
}

function sorted<T>(
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  return [...values].sort((left, right) => compare(key(left), key(right)));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function logicalKey(value: LogicalSkill): string {
  return `${normalize(value.skill.name)}\0${value.id}`;
}

function installationKey(value: Installation): string {
  return `${normalize(value.skill.name)}\0${value.source?.id ?? ""}\0${value.id}`;
}

function pluginKey(value: PluginBoundary): string {
  return `${normalize(value.pluginId)}\0${value.id}`;
}

function findingKey(value: NonInstallationFinding): string {
  return `${normalize(value.skill.name)}\0${value.id}`;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US");
}
