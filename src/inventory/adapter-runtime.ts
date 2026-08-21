import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { parse as parseJsonc, parseTree } from "jsonc-parser";
import { parseDocument } from "yaml";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  AdapterCatalog,
  AdapterHardDependencyDefinition,
  AdapterMetadataMapping,
  AdapterOwnershipRule,
  AdapterRuleSource,
  AdapterValueSelector,
  AdapterCommandArgument,
  CompiledAdapter,
  CompiledAdapterManifest,
} from "../adapter/types.js";
import type {
  Dependency,
  HardDependency,
  Installation,
  InstallationId,
  ManagedRemovalEvidence,
  ManagedVerificationEvidence,
  Ownership,
  ProtectionStatus,
  StrongIdentityEvidence,
  JsonObject,
  JsonValue,
} from "../model/types.js";
import { inspectGitProtection } from "./git-protection.js";
import { groupInstallations } from "./identity.js";
import type { InventoryCommandRunner } from "./types.js";
import { readStableRegularFile, hasDuplicateKeys } from "./evidence.js";

interface ManifestRecord {
  readonly key: string;
  readonly pointer: string;
  readonly value: Record<string, unknown>;
}

interface BoundRecord extends ManifestRecord {
  readonly adapter: CompiledAdapter;
  readonly manifest: CompiledAdapterManifest;
  readonly installation: Installation;
  /** Only an explicit, unambiguous manifest rule conflicts with root ownership. */
  readonly ownershipClaim: boolean;
}

/** Materializes only complete, exact adapter evidence. Invalid declarations are inert. */
export async function applyAdapterManifests(
  installations: readonly Installation[],
  catalog: AdapterCatalog | undefined,
  commandRunner: InventoryCommandRunner,
  activeProbes: ReadonlyMap<string, ReadonlySet<string>>,
  activeRootIds: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<{
  readonly installations: readonly Installation[];
  readonly dependencies: readonly Dependency[];
}> {
  if (catalog === undefined) return { installations, dependencies: [] };
  const replacements = new Map<string, Installation>();
  const bound: BoundRecord[] = [];
  const ambiguousOwnership = new Set<string>();

  for (const adapter of catalog.adapters) {
    for (const manifest of adapter.manifests) {
      if (
        !(manifest.requiresProbes ?? []).every((id) =>
          (activeProbes.get(adapter.id) ?? new Set()).has(id),
        )
      )
        continue;
      const root =
        manifest.rootId === undefined
          ? undefined
          : adapter.roots.find((item) => item.id === manifest.rootId);
      if (root === undefined) continue;
      if (!(activeRootIds.get(adapter.id) ?? new Set()).has(root.id)) continue;
      const parsed = await readManifest(manifest);
      if (parsed === null) continue;
      for (const record of parsed) {
        const skillPath = text(
          select(manifest.fields.skillPath, record.value, record.key),
        );
        if (skillPath === null || isAbsolute(skillPath)) continue;
        const absolute = resolve(root.path, skillPath);
        if (!inside(root.path, absolute)) continue;
        const matches = installations.filter(
          (item) =>
            item.adapterId === adapter.id &&
            samePath(item.location.path, absolute),
        );
        if (matches.length !== 1 || matches[0] === undefined) continue;
        const item = enrichRecord(matches[0], adapter, manifest, record);
        if (item === null) continue;
        replacements.set(item.id, item);
        bound.push({
          adapter,
          manifest,
          installation: item,
          ownershipClaim: manifestOwnershipClaim(adapter, manifest),
          ...record,
        });
      }
    }
  }

  const validatedBound = bound.filter((record) => {
    const rootOwnership = rootOwnershipFor(
      record.adapter,
      record.installation,
      activeRootIds.get(record.adapter.id) ?? new Set(),
    );
    const boundInstallation =
      rootOwnership === null
        ? record.installation
        : withOwnership(record.installation, rootOwnership);
    if (ownerFieldsMatch(record, boundInstallation)) return true;
    const original = installations.find(
      (item) => item.id === record.installation.id,
    );
    if (original !== undefined) replacements.set(original.id, original);
    return false;
  });

  // A root rule can strengthen an unambiguous installation even without a
  // manifest. Competing claims deliberately leave generic authority intact.
  for (const adapter of catalog.adapters)
    for (const root of adapter.roots) {
      if (!(activeRootIds.get(adapter.id) ?? new Set()).has(root.id)) continue;
      const rules = adapter.ownershipRules.filter(
        (rule) => rule.source.kind === "root" && rule.source.rootId === root.id,
      );
      if (rules.length !== 1) continue;
      for (const original of installations) {
        if (
          original.adapterId !== adapter.id ||
          !inside(root.path, original.location.path)
        )
          continue;
        if (
          validatedBound.some(
            (record) =>
              record.installation.id === original.id && record.ownershipClaim,
          )
        ) {
          // A root rule and a manifest rule (or overlapping roots) are two
          // ownership claims. Do not pick one by iteration order.
          replacements.set(original.id, original);
          ambiguousOwnership.add(original.id);
          continue;
        }
        const existing = replacements.get(original.id) ?? original;
        const ownership = ownershipFor(rules[0], {}, "");
        if (ownership === null || !ownershipCompatible(existing, ownership))
          continue;
        replacements.set(original.id, withOwnership(existing, ownership));
      }
    }

  let result = installations.map((item) => replacements.get(item.id) ?? item);
  const applicableByInstallation = new Map<string, BoundRecord[]>();
  for (const item of validatedBound) {
    const values = applicableByInstallation.get(item.installation.id) ?? [];
    values.push(item);
    applicableByInstallation.set(item.installation.id, values);
  }
  // A record must be a one-to-one claim; duplicate manifest records cannot
  // create an accidental lifecycle authority.
  const validBound: BoundRecord[] = [];
  for (const [id, records] of applicableByInstallation) {
    if (records.length !== 1 || ambiguousOwnership.has(id)) {
      const generic = installations.find((item) => item.id === id);
      if (generic !== undefined) replacements.set(id, generic);
      continue;
    }
    const record = records[0];
    if (record === undefined) continue;
    const current = replacements.get(id) ?? record.installation;
    const managed = await managedFor(
      record,
      current,
      commandRunner,
      activeProbes.get(record.adapter.id) ?? new Set(),
      activeRootIds.get(record.adapter.id) ?? new Set(),
    );
    if (managed !== null)
      replacements.set(id, {
        ...current,
        removal: { ...current.removal, managed },
      });
    validBound.push(record);
  }
  result = result.map((item) => replacements.get(item.id) ?? item);
  const finalById = new Map(result.map((item) => [item.id, item]));
  return {
    installations: result,
    dependencies: dependenciesFor(validBound, finalById),
  };
}

async function readManifest(
  manifest: CompiledAdapterManifest,
): Promise<readonly ManifestRecord[] | null> {
  if (!(await canonicallyWithinBase(manifest.path, manifest.pathBase)))
    return null;
  const stats = await lstat(manifest.path).catch(() => null);
  if (stats === null) return null;
  const stable = await readStableRegularFile(manifest.path, stats);
  if (stable === null) return null;
  if (!(await canonicalPathWithinBase(stable.canonicalPath, manifest.pathBase)))
    return null;
  const value = document(manifest.format, stable.bytes.toString("utf8"));
  if (value === null) return null;
  return records(value, manifest.records.pointer, manifest.records.collection);
}

function enrichRecord(
  item: Installation,
  adapter: CompiledAdapter,
  manifest: CompiledAdapterManifest,
  record: ManifestRecord,
): Installation | null {
  const rules = adapter.ownershipRules.filter(
    (rule) =>
      rule.source.kind === "manifest" && rule.source.manifestId === manifest.id,
  );
  // A manifest with no ownership rule may contribute read-only metadata, but
  // an ambiguous rule must never change ownership.
  const ownership =
    rules.length === 0
      ? item.ownership
      : rules.length === 1
        ? ownershipFor(rules[0], record.value, record.key)
        : null;
  if (ownership === null) return null;
  if (!ownershipCompatible(item, ownership)) return null;
  const fields = manifest.fields;
  const name = text(select(fields.skillName, record.value, record.key));
  const description = select(fields.description, record.value, record.key);
  const sourceId = text(select(fields.sourceId, record.value, record.key));
  const sourceUrl = select(fields.sourceUrl, record.value, record.key);
  const tags = select(fields.tags, record.value, record.key);
  const status = text(select(fields.status, record.value, record.key));
  const next = rules.length === 0 ? item : withOwnership(item, ownership);
  if (
    (sourceUrl !== undefined &&
      sourceUrl !== null &&
      (typeof sourceUrl !== "string" || !validSourceUrl(sourceUrl))) ||
    (tags !== undefined &&
      (!Array.isArray(tags) ||
        !tags.every((tag) => typeof tag === "string" && tag.trim().length > 0)))
  )
    return null;
  const strongEvidence = adapter.groupingRules
    .filter((rule) => rule.manifestId === manifest.id)
    .map((rule) => groupingEvidence(rule.evidence, record.value, record.key))
    .filter(
      (evidence): evidence is StrongIdentityEvidence => evidence !== null,
    );
  return {
    ...next,
    skill: {
      name: name ?? next.skill.name,
      description:
        typeof description === "string" ? description : next.skill.description,
    },
    source:
      sourceId === null
        ? next.source
        : {
            id: sourceId,
            url: typeof sourceUrl === "string" ? sourceUrl : null,
          },
    plugin: next.plugin,
    status:
      status === "active" || status === "broken" || status === "unresolved"
        ? status
        : next.status,
    tags:
      Array.isArray(tags) && tags.every((tag) => typeof tag === "string")
        ? [...new Set(tags)].sort(compareText)
        : next.tags,
    identity: {
      ...next.identity,
      strongEvidence: uniqueEvidence([
        ...next.identity.strongEvidence,
        ...strongEvidence,
      ]),
      weakEvidence:
        name === null
          ? next.identity.weakEvidence
          : next.identity.weakEvidence.map((evidence) =>
              evidence.kind === "name"
                ? {
                    ...evidence,
                    normalizedName: name.normalize("NFKC").toLowerCase(),
                  }
                : evidence,
            ),
    },
    metadata: mergeMetadata(
      next.metadata,
      metadata(manifest.metadata ?? [], record.value, record.key),
    ),
  };
}

function manifestOwnershipClaim(
  adapter: CompiledAdapter,
  manifest: CompiledAdapterManifest,
): boolean {
  return (
    adapter.ownershipRules.filter(
      (rule) =>
        rule.source.kind === "manifest" &&
        rule.source.manifestId === manifest.id,
    ).length === 1
  );
}

function rootOwnershipFor(
  adapter: CompiledAdapter,
  installation: Installation,
  activeRootIds: ReadonlySet<string>,
): Ownership | null {
  const candidates = adapter.roots.flatMap((root) => {
    if (
      !activeRootIds.has(root.id) ||
      !inside(root.path, installation.location.path)
    )
      return [];
    const rules = adapter.ownershipRules.filter(
      (rule) => rule.source.kind === "root" && rule.source.rootId === root.id,
    );
    if (rules.length !== 1) return [];
    const ownership = ownershipFor(rules[0], {}, "");
    return ownership !== null && ownershipCompatible(installation, ownership)
      ? [ownership]
      : [];
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function ownerFieldsMatch(
  record: BoundRecord,
  installation: Installation,
): boolean {
  const fields = record.manifest.fields;
  const managerId =
    fields.managerId === undefined
      ? undefined
      : text(select(fields.managerId, record.value, record.key));
  const pluginId =
    fields.pluginId === undefined
      ? undefined
      : text(select(fields.pluginId, record.value, record.key));
  const pluginVersion =
    fields.pluginVersion === undefined
      ? undefined
      : select(fields.pluginVersion, record.value, record.key);
  const agentId =
    fields.agentId === undefined
      ? undefined
      : text(select(fields.agentId, record.value, record.key));
  return (
    (managerId === undefined ||
      (managerId !== null &&
        installation.ownership.kind === "manager" &&
        installation.ownership.managerId === managerId)) &&
    (pluginId === undefined ||
      (pluginId !== null &&
        installation.ownership.kind === "plugin" &&
        installation.ownership.pluginId === pluginId &&
        installation.plugin?.id === pluginId)) &&
    (pluginVersion === undefined ||
      ((pluginVersion === null || typeof pluginVersion === "string") &&
        installation.plugin?.version === pluginVersion)) &&
    (agentId === undefined ||
      (agentId !== null && installation.agentId === agentId))
  );
}

function groupingEvidence(
  evidence: import("../adapter/types.js").AdapterGroupingEvidence,
  record: Record<string, unknown>,
  key: string,
): StrongIdentityEvidence | null {
  if (evidence.kind === "source") {
    const sourceId = text(select(evidence.sourceId, record, key));
    const skillPath = text(select(evidence.skillPath, record, key));
    return sourceId === null || skillPath === null
      ? null
      : { strength: "strong", kind: "source", sourceId, skillPath };
  }
  if (evidence.kind === "plugin") {
    const pluginId = text(select(evidence.pluginId, record, key));
    const skillId = text(select(evidence.skillId, record, key));
    return pluginId === null || skillId === null
      ? null
      : { strength: "strong", kind: "plugin", pluginId, skillId };
  }
  if (evidence.kind === "canonical-target") {
    const canonicalPath = text(select(evidence.canonicalPath, record, key));
    return canonicalPath === null
      ? null
      : { strength: "strong", kind: "canonical-target", canonicalPath };
  }
  const packageId = text(select(evidence.packageId, record, key));
  return packageId === null
    ? null
    : { strength: "strong", kind: "package", packageId };
}
function uniqueEvidence(
  evidence: readonly StrongIdentityEvidence[],
): readonly StrongIdentityEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withOwnership(item: Installation, ownership: Ownership): Installation {
  return {
    ...item,
    ownership,
    manager: ownership.kind === "manager" ? { id: ownership.managerId } : null,
    plugin:
      ownership.kind === "plugin"
        ? { id: ownership.pluginId, version: item.plugin?.version ?? null }
        : null,
    // A manifest may not fabricate a plugin boundary. Plugin ownership without
    // a physical plugin root is therefore not a valid installation mutation.
    pluginBoundaryId:
      ownership.kind === "plugin" ? item.pluginBoundaryId : null,
    suspension:
      ownership.kind === "filesystem"
        ? item.suspension
        : {
            kind: "unavailable",
            reason: "adapter ownership has no declared suspension authority",
          },
    removal:
      ownership.kind === "filesystem"
        ? item.removal
        : {
            ...item.removal,
            managed: null,
            fallback: {
              kind: "unavailable",
              reason: "managed ownership requires exact cleanup evidence",
            },
          },
  };
}

async function managedFor(
  record: BoundRecord,
  installation: Installation,
  runner: InventoryCommandRunner,
  activeProbes: ReadonlySet<string>,
  activeRootIds: ReadonlySet<string>,
): Promise<ManagedRemovalEvidence | null> {
  const actions = record.adapter.actions.filter(
    (action) =>
      action.source !== undefined &&
      sourceMatches(
        action.source,
        record.manifest.id,
        record.adapter,
        installation,
        activeRootIds,
      ) &&
      action.ownerKind === installation.ownership.kind,
  );
  if (
    actions.length !== 1 ||
    (installation.ownership.kind !== "manager" &&
      installation.ownership.kind !== "plugin")
  )
    return null;
  const action = actions[0];
  if (action === undefined) return null;
  const externalId = text(
    select(record.manifest.fields.externalId, record.value, record.key),
  );
  if (externalId === null) return null;
  const context = valuesFor(record, installation, externalId);
  const commandArguments =
    action.kind === "managed"
      ? resolveArguments(action.command.arguments, context)
      : resolveArguments(action.arguments, context);
  if (commandArguments === null || action.effects.length === 0) return null;
  const effects = await Promise.all(
    action.effects.map(async (effect) => {
      const path =
        "path" in effect
          ? effect.path
          : effect.value === "installationPath"
            ? installation.location.path
            : record.manifest.path;
      if (
        ("path" in effect &&
          !(await canonicallyWithinBase(effect.path, effect.pathBase))) ||
        (!("path" in effect) &&
          !samePath(path, installation.location.path) &&
          !samePath(path, record.manifest.path))
      )
        return null;
      const protection = await protectionFor(path, runner);
      return protection === null
        ? null
        : ({ kind: effect.kind, path, protection } as const);
    }),
  );
  if (effects.some((effect) => effect === null)) return null;
  const verifications = resolveVerifications(
    record,
    installation,
    action.verificationRules ?? [],
    context,
  );
  if (verifications === null) return null;
  return {
    adapterId: record.adapter.id,
    operationId: action.operationId,
    availability: probesAvailable(action.requiresProbes, activeProbes)
      ? { kind: "available" }
      : {
          kind: "unavailable",
          reason: "required adapter probe is unavailable",
        },
    trust:
      record.adapter.trust.kind === "approved" ||
      record.adapter.trust.kind === "built-in"
        ? { kind: "trusted" }
        : {
            kind: "blocked",
            adapterId: record.adapter.id,
            contentHash:
              record.adapter.source.kind === "local"
                ? record.adapter.source.contentHash
                : "",
          },
    externalId,
    invocation:
      action.kind === "managed"
        ? {
            kind: "direct",
            command: {
              executable: action.command.executable,
              arguments: commandArguments,
            },
            workingDirectory: { kind: "isolated-temporary" },
          }
        : {
            kind: "ephemeral-package",
            packageExecution: {
              runner: "npx",
              packageName: action.packageName,
              packageVersion: action.packageVersion,
              adapterHash:
                record.adapter.source.kind === "local"
                  ? record.adapter.source.contentHash
                  : record.adapter.id,
              mayDownload: true,
            },
            packageArguments: commandArguments,
          },
    effects: effects.filter(
      (effect): effect is NonNullable<typeof effect> => effect !== null,
    ),
    verifications,
  };
}

function sourceMatches(
  source: AdapterRuleSource,
  manifestId: string,
  adapter: CompiledAdapter,
  installation: Installation,
  activeRootIds: ReadonlySet<string>,
): boolean {
  return source.kind === "manifest"
    ? source.manifestId === manifestId
    : adapter.roots.some(
        (root) =>
          activeRootIds.has(root.id) &&
          root.id === source.rootId &&
          root.id ===
            adapter.manifests.find((manifest) => manifest.id === manifestId)
              ?.rootId &&
          inside(root.path, installation.location.path),
      );
}
function probesAvailable(
  ids: readonly string[] | undefined,
  active: ReadonlySet<string>,
): boolean {
  return (ids ?? []).every((id) => active.has(id));
}
function valuesFor(
  record: BoundRecord,
  installation: Installation,
  externalId: string,
): Readonly<Record<string, string | null>> {
  return {
    installationPath: installation.location.path,
    canonicalPath: installation.location.canonicalPath,
    skillName: installation.skill.name,
    sourceId: installation.source?.id ?? null,
    pluginId: installation.plugin?.id ?? null,
    managerId: installation.manager?.id ?? null,
    externalId,
    manifestPath: record.manifest.path,
    scopePath:
      installation.scope.kind === "workspace"
        ? installation.scope.workspacePath
        : null,
  };
}
function resolveArguments(
  arguments_: readonly AdapterCommandArgument[],
  values: Readonly<Record<string, string | null>>,
): readonly string[] | null {
  const result: string[] = [];
  for (const argument of arguments_) {
    const value =
      argument.kind === "literal" ? argument.value : values[argument.from];
    if (typeof value !== "string" || value.length === 0) return null;
    result.push(value);
  }
  return result;
}
function resolveVerifications(
  record: BoundRecord,
  installation: Installation,
  ids: readonly string[],
  values: Readonly<Record<string, string | null>>,
): readonly ManagedVerificationEvidence[] | null {
  const rules = ids.map((id) =>
    record.adapter.verificationRules.find((rule) => rule.id === id),
  );
  if (rules.some((rule) => rule === undefined)) return null;
  const result: ManagedVerificationEvidence[] = [];
  for (const rule of rules) {
    if (rule === undefined) continue;
    if (rule.kind === "path-absent")
      result.push({ kind: "path-absent", path: rule.path });
    else if (rule.kind === "manifest-record-absent") {
      if (
        rule.manifestId !== record.manifest.id ||
        text(select(rule.selector, record.value, record.key)) === null
      )
        return null;
      result.push({
        kind: "record-absent",
        path: record.manifest.path,
        format: record.manifest.format,
        recordPointer: record.pointer,
      });
    } else if (rule.kind === "owner-state-absent") {
      if (rule.ownerKind !== installation.ownership.kind) return null;
      const externalId = text(
        select(rule.externalId, record.value, record.key),
      );
      if (externalId === null) return null;
      result.push({ kind: "owner-state-absent", externalId });
    } else if (rule.kind === "command") {
      const arguments_ = resolveArguments(rule.command.arguments, values);
      if (arguments_ === null) return null;
      result.push({
        kind: "command-succeeds",
        command: { executable: rule.command.executable, arguments: arguments_ },
        successExitCodes: rule.successExitCodes,
      });
    } else return null;
  }
  return result;
}

function dependenciesFor(
  records: readonly BoundRecord[],
  installations: ReadonlyMap<string, Installation>,
): readonly Dependency[] {
  const logicalSkills = groupInstallations([...installations.values()]);
  const output: HardDependency[] = [];
  for (const record of records)
    for (const rule of record.adapter.hardDependencies) {
      if (rule.manifestId !== record.manifest.id) continue;
      const dependency = dependencyFor(
        rule,
        record,
        installations,
        logicalSkills,
      );
      if (dependency !== null) output.push(dependency);
    }
  return output.sort((a, b) =>
    compareText(
      `${a.dependentInstallationId}\0${JSON.stringify(a.target)}`,
      `${b.dependentInstallationId}\0${JSON.stringify(b.target)}`,
    ),
  );
}
function dependencyFor(
  rule: AdapterHardDependencyDefinition,
  record: BoundRecord,
  installations: ReadonlyMap<string, Installation>,
  logicalSkills: readonly import("../model/types.js").LogicalSkill[],
): HardDependency | null {
  const dependent = text(
    select(rule.dependentInstallationId, record.value, record.key),
  );
  const reason = text(select(rule.reason, record.value, record.key));
  if (dependent === null || reason === null || !installations.has(dependent))
    return null;
  const target =
    rule.target.kind === "installation"
      ? (() => {
          const id = text(
            select(rule.target.installationId, record.value, record.key),
          );
          return id !== null && installations.has(id)
            ? {
                kind: "installation" as const,
                installationId: id as InstallationId,
              }
            : null;
        })()
      : rule.target.kind === "logical-skill"
        ? (() => {
            const id = text(
              select(rule.target.logicalSkillId, record.value, record.key),
            );
            return id !== null && logicalSkills.some((skill) => skill.id === id)
              ? {
                  kind: "logical-skill" as const,
                  logicalSkillId:
                    id as import("../model/types.js").LogicalSkillId,
                }
              : null;
          })()
        : (() => {
            const pluginId = text(
              select(rule.target.pluginId, record.value, record.key),
            );
            const owners =
              pluginId === null
                ? []
                : [...installations.values()].filter(
                    (item) =>
                      item.plugin?.id === pluginId &&
                      item.pluginBoundaryId !== null,
                  );
            const boundaryIds = [
              ...new Set(owners.map((item) => item.pluginBoundaryId)),
            ];
            return boundaryIds.length !== 1 ||
              boundaryIds[0] === null ||
              boundaryIds[0] === undefined
              ? null
              : {
                  kind: "plugin" as const,
                  pluginBoundaryId: boundaryIds[0],
                };
          })();
  if (target === null) return null;
  return {
    kind: "hard",
    dependentInstallationId: dependent as InstallationId,
    target,
    source: { kind: "adapter", adapterId: record.adapter.id },
    reason,
  };
}

async function protectionFor(
  path: string,
  runner: InventoryCommandRunner,
): Promise<ProtectionStatus | null> {
  const stats = await lstat(path).catch(() => null);
  if (stats === null) return null;
  let writable = true;
  try {
    await access(path, constants.W_OK);
  } catch {
    writable = false;
  }
  return {
    git: await inspectGitProtection(path, stats.isDirectory(), runner),
    system: { kind: "none" },
    filesystem: writable
      ? { kind: "writable" }
      : { kind: "read-only", reason: "filesystem denied write access" },
  };
}
function document(format: string, text_: string): unknown | null {
  try {
    if (format === "json" || format === "jsonc") {
      const tree = parseTree(text_);
      const value =
        tree === undefined || hasDuplicateKeys(tree)
          ? null
          : format === "json"
            ? JSON.parse(text_)
            : parseJsonc(text_);
      return value === null || !json(value) ? null : value;
    }
    const doc = parseDocument(text_, { uniqueKeys: true });
    const value = doc.errors.length ? null : doc.toJS();
    return value === null || !json(value) ? null : value;
  } catch {
    return null;
  }
}
function records(
  value: unknown,
  pointer: string,
  collection: string,
): readonly ManifestRecord[] {
  const target = pointerValue(value, pointer);
  if (collection === "array" && Array.isArray(target))
    return target.flatMap((value, i) =>
      isRecord(value) ? [{ key: "", pointer: `${pointer}/${i}`, value }] : [],
    );
  if (
    (collection === "object-entries" || collection === "object-values") &&
    isRecord(target)
  )
    return Object.entries(target).flatMap(([key, value]) =>
      isRecord(value)
        ? [
            {
              key: collection === "object-entries" ? key : "",
              pointer: `${pointer}/${escapePointer(key)}`,
              value,
            },
          ]
        : [],
    );
  return collection === "single" && isRecord(target)
    ? [{ key: "", pointer, value: target }]
    : [];
}
function pointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (current, part) =>
        isRecord(current) || Array.isArray(current)
          ? (current as Record<string, unknown>)[unescapePointer(part)]
          : undefined,
      value,
    );
}
function select(
  selector: AdapterValueSelector | undefined,
  record: Record<string, unknown>,
  key: string,
): unknown {
  if (!selector) return undefined;
  if (selector.kind === "literal") return selector.value;
  if (selector.kind === "record-key") return key.length === 0 ? undefined : key;
  return pointerValue(record, selector.pointer);
}
function ownershipFor(
  rule: AdapterOwnershipRule | undefined,
  record: Record<string, unknown>,
  key: string,
): Ownership | null {
  if (!rule) return null;
  const value = rule.ownership;
  if (value.kind === "filesystem")
    return { kind: "filesystem", confidence: rule.confidence };
  if (value.kind === "manager") {
    const managerId = text(select(value.managerId, record, key));
    return managerId === null
      ? null
      : { kind: "manager", managerId, confidence: rule.confidence };
  }
  if (value.kind === "plugin") {
    const pluginId = text(select(value.pluginId, record, key));
    return pluginId === null
      ? null
      : {
          kind: "plugin",
          pluginId,
          independentlySelectable: value.independentlySelectable,
          confidence: rule.confidence,
        };
  }
  return null;
}
function ownershipCompatible(
  item: Installation,
  ownership: Ownership,
): boolean {
  if (ownership.kind !== "plugin") return item.ownership.kind !== "plugin";
  return (
    item.ownership.kind === "plugin" &&
    item.plugin !== null &&
    item.pluginBoundaryId !== null &&
    item.ownership.pluginId === ownership.pluginId &&
    item.plugin.id === ownership.pluginId &&
    item.ownership.independentlySelectable === ownership.independentlySelectable
  );
}
function validSourceUrl(value: string): boolean {
  try {
    return new URL(value).protocol.length > 0;
  } catch {
    return false;
  }
}
function metadata(
  mappings: readonly AdapterMetadataMapping[],
  record: Record<string, unknown>,
  key: string,
): JsonObject {
  const result: Record<string, Record<string, JsonValue>> = {};
  for (const mapping of mappings) {
    const value = select(mapping.value, record, key);
    if (json(value)) (result[mapping.namespace] ??= {})[mapping.key] = value;
  }
  return result;
}
function mergeMetadata(
  existing: JsonObject,
  additions: JsonObject,
): JsonObject {
  const result: Record<string, JsonValue> = { ...existing };
  for (const [namespace, values] of Object.entries(additions))
    result[namespace] = {
      ...(isRecord(result[namespace]) ? result[namespace] : {}),
      ...(values as Record<string, JsonValue>),
    };
  return result;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function json(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every(json)) ||
    (isPlainRecord(value) && Object.values(value).every(json))
  );
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function inside(root: string, path: string): boolean {
  if (!root) return false;
  const result = relative(resolve(root), resolve(path));
  return (
    result === "" ||
    (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result))
  );
}
function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
/** Declared paths must not leave their selected base through a link parent. */
async function canonicallyWithinBase(
  path: string,
  base: string,
): Promise<boolean> {
  try {
    return inside(await realpath(base), await realpath(path));
  } catch {
    return false;
  }
}
async function canonicalPathWithinBase(
  canonicalPath: string,
  base: string,
): Promise<boolean> {
  try {
    return inside(await realpath(base), canonicalPath);
  } catch {
    return false;
  }
}
function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
