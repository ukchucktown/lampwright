import { z } from "zod";

import {
  executionReportSchema,
  executionApprovalsSchema,
  installationSchema,
  inventorySchema,
  logicalSkillSchema,
  nonInstallationFindingSchema,
  removalPlanSchema,
} from "./schemas.js";
import { stringifyModel } from "./json.js";
import { artifactPathKey, physicalPathKey } from "./paths.js";
import type {
  ApprovalRequirement,
  ExecutionReport,
  ExecutionApprovals,
  Installation,
  Inventory,
  InventoryRecordReference,
  JsonValue,
  LogicalSkill,
  ManagedOwnership,
  NonInstallationFinding,
  RemovalEvidence,
  RemovalAction,
  RemovalPlan,
  RemovalTarget,
  StrongIdentityEvidence,
  VerificationCheck,
  WeakIdentityEvidence,
} from "./types.js";

function approvalKey(approval: ApprovalRequirement): string {
  return stringifyModel(approval, 0);
}

export function parseExecutionApprovals(input: unknown): ExecutionApprovals {
  const approvals = parseSchema<ExecutionApprovals>(
    executionApprovalsSchema,
    input,
  );
  const issues: MutableIssue[] = [];
  duplicateIndexes(approvals.grants, approvalKey).forEach((index) => {
    addIssue(issues, ["grants", index], "duplicate execution approval");
  });
  return finish(approvals, issues);
}

export interface ModelValidationIssue {
  readonly path: readonly (number | string)[];
  readonly message: string;
}

export class ModelValidationError extends Error {
  readonly issues: readonly ModelValidationIssue[];

  constructor(issues: readonly ModelValidationIssue[]) {
    super(issues.map(formatIssue).join("; "));
    this.name = "ModelValidationError";
    this.issues = deepFreeze([...issues]);
  }
}

type MutableIssue = {
  path: (number | string)[];
  message: string;
};

function formatIssue(issue: ModelValidationIssue): string {
  const path = issue.path.length === 0 ? "value" : issue.path.join(".");
  return `${path}: ${issue.message}`;
}

function parseSchema<T>(schema: z.ZodType, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ModelValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map((segment) =>
          typeof segment === "symbol" ? String(segment) : segment,
        ),
        message: issue.message,
      })),
    );
  }

  return result.data as T;
}

function finish<T>(value: T, issues: readonly MutableIssue[]): T {
  if (issues.length > 0) {
    throw new ModelValidationError(issues);
  }
  return deepFreeze(value);
}

function addIssue(
  issues: MutableIssue[],
  path: readonly (number | string)[],
  message: string,
): void {
  issues.push({ path: [...path], message });
}

function duplicateIndexes<T>(
  values: readonly T[],
  key: (value: T) => string,
): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  values.forEach((value, index) => {
    const identity = key(value);
    if (seen.has(identity)) {
      duplicates.push(index);
    }
    seen.add(identity);
  });
  return duplicates;
}

function targetKey(target: RemovalTarget): string {
  switch (target.kind) {
    case "installation":
      return `installation:${target.installationId}`;
    case "logical-skill":
      return `logical-skill:${target.logicalSkillId}`;
    case "plugin":
      return `plugin:${target.pluginBoundaryId}`;
  }
}

function referenceKey(reference: InventoryRecordReference): string {
  return reference.kind === "installation"
    ? `installation:${reference.installationId}`
    : `finding:${reference.findingId}`;
}

function hasSameStrongIdentity(
  left: StrongIdentityEvidence,
  right: StrongIdentityEvidence,
): boolean {
  switch (left.kind) {
    case "source":
      return (
        right.kind === "source" &&
        left.sourceId === right.sourceId &&
        left.skillPath === right.skillPath
      );
    case "plugin":
      return (
        right.kind === "plugin" &&
        left.pluginId === right.pluginId &&
        left.skillId === right.skillId
      );
    case "canonical-target":
      return (
        right.kind === "canonical-target" &&
        left.canonicalPath === right.canonicalPath
      );
    case "package":
      return right.kind === "package" && left.packageId === right.packageId;
  }
}

function hasSameWeakIdentity(
  left: WeakIdentityEvidence,
  right: WeakIdentityEvidence,
): boolean {
  switch (left.kind) {
    case "name":
      return (
        right.kind === "name" && left.normalizedName === right.normalizedName
      );
    case "content-hash":
      return (
        right.kind === "content-hash" &&
        left.algorithm === right.algorithm &&
        left.digest === right.digest
      );
  }
}

function validateInstallation(
  installation: Installation,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  const ownership = installation.ownership;

  if (
    installation.scope.kind === "agent" &&
    installation.scope.agentId !== installation.agentId
  ) {
    addIssue(
      issues,
      [...path, "scope", "agentId"],
      "agent scope must match the installation agent",
    );
  }

  if (
    installation.classification === "standalone-project-skill" &&
    installation.scope.kind !== "workspace"
  ) {
    addIssue(
      issues,
      [...path, "scope"],
      "a standalone project skill must use workspace scope",
    );
  }

  if (
    installation.classification === "managed-plugin-resource" &&
    ownership.kind !== "plugin"
  ) {
    addIssue(
      issues,
      [...path, "ownership"],
      "a managed plugin resource must have plugin ownership",
    );
  }

  if (
    ownership.kind === "plugin" &&
    installation.classification !== "managed-plugin-resource"
  ) {
    addIssue(
      issues,
      [...path, "classification"],
      "plugin ownership is reserved for managed plugin resources",
    );
  }

  if (ownership.kind === "plugin") {
    if (installation.plugin?.id !== ownership.pluginId) {
      addIssue(
        issues,
        [...path, "plugin"],
        "plugin reference must match plugin ownership",
      );
    }
    if (installation.pluginBoundaryId === null) {
      addIssue(
        issues,
        [...path, "pluginBoundaryId"],
        "plugin ownership requires a plugin boundary id",
      );
    }
  } else if (installation.plugin !== null) {
    addIssue(
      issues,
      [...path, "plugin"],
      "plugin reference requires plugin ownership",
    );
  } else if (installation.pluginBoundaryId !== null) {
    addIssue(
      issues,
      [...path, "pluginBoundaryId"],
      "plugin boundary id requires plugin ownership",
    );
  }

  if (ownership.kind === "manager") {
    if (installation.manager?.id !== ownership.managerId) {
      addIssue(
        issues,
        [...path, "manager"],
        "manager reference must match manager ownership",
      );
    }
  } else if (installation.manager !== null) {
    addIssue(
      issues,
      [...path, "manager"],
      "manager reference requires manager ownership",
    );
  }

  if (ownership.kind === "agent-runtime") {
    addIssue(
      issues,
      [...path, "ownership"],
      "agent runtime content must be represented as a system finding",
    );
  }

  if (installation.protection.system.kind === "system-skill") {
    addIssue(
      issues,
      [...path, "protection", "system"],
      "a system skill cannot be represented as an installation",
    );
  }

  (installation.removal.supplementalArtifacts ?? []).forEach(
    (artifact, index) => {
      if (
        artifactPathKey(artifact.location) ===
        artifactPathKey(installation.location)
      ) {
        addIssue(
          issues,
          [...path, "removal", "supplementalArtifacts", index, "location"],
          "supplemental removal artifact duplicates the primary location",
        );
      }
    },
  );

  if (
    installation.removal.primaryArtifactPresent === false &&
    installation.removal.fallback.kind === "available" &&
    installation.removal.recordCleanups.length === 0
  ) {
    addIssue(
      issues,
      [...path, "removal", "primaryArtifactPresent"],
      "an absent primary artifact requires exact record cleanup evidence",
    );
  }

  validateRemovalEvidence(
    installation.removal,
    ownership,
    installation.adapterId,
    [...path, "removal"],
    issues,
  );
}

function validateRemovalEvidence(
  removal: RemovalEvidence,
  ownership: ManagedOwnership | Installation["ownership"],
  adapterId: string | null,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  const managed = removal.managed;
  if (managed !== null) {
    if (ownership.kind !== "manager" && ownership.kind !== "plugin") {
      addIssue(
        issues,
        [...path, "managed"],
        "managed removal evidence requires manager or plugin ownership",
      );
    }
    if (managed.adapterId !== adapterId) {
      addIssue(
        issues,
        [...path, "managed", "adapterId"],
        "managed removal adapter must match the inventory record adapter",
      );
    }
    if (
      managed.trust.kind === "blocked" &&
      managed.trust.adapterId !== managed.adapterId
    ) {
      addIssue(
        issues,
        [...path, "managed", "trust", "adapterId"],
        "blocked trust must identify the managed removal adapter",
      );
    }
    duplicateIndexes(managed.effects, (effect) => effect.path).forEach(
      (index) => {
        addIssue(
          issues,
          [...path, "managed", "effects", index, "path"],
          "duplicate managed removal effect path",
        );
      },
    );
    duplicateIndexes(managed.verifications, (verification) =>
      stringifyModel(verification, 0),
    ).forEach((index) => {
      addIssue(
        issues,
        [...path, "managed", "verifications", index],
        "duplicate managed verification",
      );
    });
    managed.verifications.forEach((verification, index) => {
      if (
        verification.kind === "command-succeeds" &&
        new Set(verification.successExitCodes).size !==
          verification.successExitCodes.length
      ) {
        addIssue(
          issues,
          [...path, "managed", "verifications", index, "successExitCodes"],
          "success exit codes must be unique",
        );
      }
    });
  }

  duplicateIndexes(removal.supplementalArtifacts ?? [], (artifact) =>
    artifactPathKey(artifact.location),
  ).forEach((index) => {
    addIssue(
      issues,
      [...path, "supplementalArtifacts", index, "location"],
      "duplicate supplemental removal artifact",
    );
  });
  duplicateIndexes(removal.recordCleanups, (cleanup) => cleanup.id).forEach(
    (index) => {
      addIssue(
        issues,
        [...path, "recordCleanups", index, "id"],
        "duplicate declarative record cleanup id",
      );
    },
  );
  duplicateIndexes(
    removal.recordCleanups,
    (cleanup) =>
      `${physicalPathKey(cleanup.location)}\0${cleanup.recordPointer}`,
  ).forEach((index) => {
    addIssue(
      issues,
      [...path, "recordCleanups", index, "recordPointer"],
      "duplicate declarative record cleanup",
    );
  });
  removal.recordCleanups.forEach((cleanup, index) => {
    if (cleanup.location.artifactType.kind !== "file") {
      addIssue(
        issues,
        [...path, "recordCleanups", index, "location", "artifactType"],
        "record cleanup location must be a file",
      );
    }
    if (adapterId === null || cleanup.adapterId !== adapterId) {
      addIssue(
        issues,
        [...path, "recordCleanups", index, "adapterId"],
        "record cleanup adapter must match a non-null inventory record adapter",
      );
    }
    const firstForPath = removal.recordCleanups.find(
      (candidate) =>
        physicalPathKey(candidate.location) ===
        physicalPathKey(cleanup.location),
    );
    if (
      firstForPath !== undefined &&
      (firstForPath.adapterId !== cleanup.adapterId ||
        firstForPath.format !== cleanup.format ||
        stringifyModel(firstForPath.expectedFileHash, 0) !==
          stringifyModel(cleanup.expectedFileHash, 0) ||
        stringifyModel(firstForPath.protection, 0) !==
          stringifyModel(cleanup.protection, 0))
    ) {
      addIssue(
        issues,
        [...path, "recordCleanups", index],
        "record cleanups for one document require consistent file evidence",
      );
    }
  });
}

function validatePluginBoundaries(
  inventory: Inventory,
  installationsById: ReadonlyMap<string, Installation>,
  issues: MutableIssue[],
): void {
  const claimedInstallations = new Set<string>();

  inventory.plugins.forEach((plugin, pluginIndex) => {
    const path = ["plugins", pluginIndex];
    if (plugin.ownership.pluginId !== plugin.pluginId) {
      addIssue(
        issues,
        [...path, "ownership", "pluginId"],
        "plugin ownership must match the external plugin id",
      );
    }
    validateRemovalEvidence(
      plugin.removal,
      plugin.ownership,
      plugin.adapterId,
      [...path, "removal"],
      issues,
    );
    const cleanupIds = new Set(
      plugin.removal.recordCleanups.map((cleanup) => cleanup.id),
    );

    duplicateIndexes(plugin.installationIds, String).forEach((index) => {
      addIssue(
        issues,
        [...path, "installationIds", index],
        "installation appears more than once in the plugin boundary",
      );
    });
    plugin.installationIds.forEach((installationId, installationIndex) => {
      const installation = installationsById.get(installationId);
      const installationPath = [...path, "installationIds", installationIndex];
      if (installation === undefined) {
        addIssue(issues, installationPath, "installation does not exist");
        return;
      }
      if (
        installation.ownership.kind !== "plugin" ||
        installation.ownership.pluginId !== plugin.pluginId ||
        installation.pluginBoundaryId !== plugin.id
      ) {
        addIssue(
          issues,
          installationPath,
          "installation is not owned by the plugin boundary",
        );
      } else if (
        installation.ownership.independentlySelectable !==
        plugin.ownership.independentlySelectable
      ) {
        addIssue(
          issues,
          installationPath,
          "plugin child selection must match the plugin boundary",
        );
      }
      if (installation.plugin?.version !== plugin.version) {
        addIssue(
          issues,
          installationPath,
          "plugin child version must match the plugin boundary",
        );
      }
      if (installation.adapterId !== plugin.adapterId) {
        addIssue(
          issues,
          installationPath,
          "plugin child adapter must match the plugin boundary",
        );
      }
      if (claimedInstallations.has(installationId)) {
        addIssue(
          issues,
          installationPath,
          "installation already belongs to another plugin boundary",
        );
      }
      claimedInstallations.add(installationId);
    });

    duplicateIndexes(
      plugin.resources,
      (resource) => `${resource.kind}:${resource.id}`,
    ).forEach((index) => {
      addIssue(
        issues,
        [...path, "resources", index],
        "duplicate plugin resource",
      );
    });
    plugin.resources.forEach((resource, resourceIndex) => {
      if ((resource.location === null) !== (resource.protection === null)) {
        addIssue(
          issues,
          [...path, "resources", resourceIndex],
          "plugin resource location and protection must be provided together",
        );
      }
      if (resource.cleanupId !== null && !cleanupIds.has(resource.cleanupId)) {
        addIssue(
          issues,
          [...path, "resources", resourceIndex, "cleanupId"],
          "plugin resource cleanup does not exist in the plugin boundary",
        );
      }
    });
  });

  inventory.installations.forEach((installation, installationIndex) => {
    if (
      installation.ownership.kind === "plugin" &&
      !claimedInstallations.has(installation.id)
    ) {
      addIssue(
        issues,
        ["installations", installationIndex, "ownership"],
        "plugin-owned installation requires a plugin boundary",
      );
    }
  });
}

function validateGlobalRecordCleanupEvidence(
  inventory: Inventory,
  issues: MutableIssue[],
): void {
  const entries = [
    ...inventory.installations.flatMap((installation, installationIndex) =>
      installation.removal.recordCleanups.map((cleanup, cleanupIndex) => ({
        cleanup,
        claimant: {
          kind: "installation" as const,
          installationId: installation.id,
          pluginBoundaryId: installation.pluginBoundaryId,
          independentlySelectable:
            installation.ownership.kind === "plugin" &&
            installation.ownership.independentlySelectable,
          ownedByBoundary:
            installation.pluginBoundaryId !== null &&
            inventory.plugins.some(
              (plugin) =>
                plugin.id === installation.pluginBoundaryId &&
                plugin.installationIds.includes(installation.id),
            ),
        },
        path: [
          "installations",
          installationIndex,
          "removal",
          "recordCleanups",
          cleanupIndex,
        ] as const,
      })),
    ),
    ...inventory.plugins.flatMap((plugin, pluginIndex) =>
      plugin.removal.recordCleanups.map((cleanup, cleanupIndex) => ({
        cleanup,
        claimant: {
          kind: "plugin-boundary" as const,
          pluginBoundaryId: plugin.id,
        },
        path: [
          "plugins",
          pluginIndex,
          "removal",
          "recordCleanups",
          cleanupIndex,
        ] as const,
      })),
    ),
  ];
  const firstByDocument = new Map<string, (typeof entries)[number]>();
  const claimsByRecord = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const documentKey = physicalPathKey(entry.cleanup.location);
    const firstDocument = firstByDocument.get(documentKey);
    if (firstDocument === undefined) {
      firstByDocument.set(documentKey, entry);
    } else if (
      firstDocument.cleanup.adapterId !== entry.cleanup.adapterId ||
      firstDocument.cleanup.format !== entry.cleanup.format ||
      stringifyModel(firstDocument.cleanup.expectedFileHash, 0) !==
        stringifyModel(entry.cleanup.expectedFileHash, 0) ||
      stringifyModel(firstDocument.cleanup.protection, 0) !==
        stringifyModel(entry.cleanup.protection, 0)
    ) {
      addIssue(
        issues,
        entry.path,
        "record cleanups for one physical document require consistent file evidence",
      );
    }

    const recordKey = `${documentKey}\0${entry.cleanup.recordPointer}`;
    claimsByRecord.set(recordKey, [
      ...(claimsByRecord.get(recordKey) ?? []),
      entry,
    ]);
  }

  for (const claims of claimsByRecord.values()) {
    if (claims.length <= 1) {
      continue;
    }
    const boundaryClaims = claims.filter(
      (claim) => claim.claimant.kind === "plugin-boundary",
    );
    const childClaims = claims.filter(
      (claim) => claim.claimant.kind === "installation",
    );
    const boundary = boundaryClaims[0];
    const child = childClaims[0];
    const isExactAlternatePair =
      claims.length === 2 &&
      boundaryClaims.length === 1 &&
      childClaims.length === 1 &&
      boundary?.claimant.kind === "plugin-boundary" &&
      child?.claimant.kind === "installation" &&
      child.claimant.pluginBoundaryId === boundary.claimant.pluginBoundaryId &&
      child.claimant.independentlySelectable &&
      child.claimant.ownedByBoundary;
    if (!isExactAlternatePair) {
      claims
        .slice(1)
        .forEach((claim) =>
          addIssue(
            issues,
            [...claim.path, "recordPointer"],
            "one physical cleanup selector is claimed by multiple removal owners",
          ),
        );
      continue;
    }

    const firstHash = stringifyModel(claims[0]!.cleanup.expectedRecordHash, 0);
    claims.slice(1).forEach((claim) => {
      if (stringifyModel(claim.cleanup.expectedRecordHash, 0) !== firstHash) {
        addIssue(
          issues,
          [...claim.path, "expectedRecordHash"],
          "alternate Plugin cleanup claims require consistent record evidence",
        );
      }
    });
  }
}

function validateFinding(
  finding: NonInstallationFinding,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  if (finding.classification !== "system-skill") {
    if (finding.protection.system.kind === "system-skill") {
      addIssue(
        issues,
        [...path, "protection", "system"],
        "system protection requires system-skill classification",
      );
    }
    return;
  }

  const expectedAgentId = finding.agentId;
  if (
    finding.ownership.agentId !== expectedAgentId ||
    finding.protection.system.agentId !== expectedAgentId
  ) {
    addIssue(
      issues,
      path,
      "system skill agent, owner, and protection must identify the same agent",
    );
  }

  if (
    finding.scope?.kind === "agent" &&
    finding.scope.agentId !== expectedAgentId
  ) {
    addIssue(
      issues,
      [...path, "scope", "agentId"],
      "agent scope must match the system skill agent",
    );
  }
}

function validateTargetExists(
  target: RemovalTarget,
  path: readonly (number | string)[],
  installationIds: ReadonlySet<string>,
  logicalSkillIds: ReadonlySet<string>,
  pluginIds: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  const exists =
    target.kind === "installation"
      ? installationIds.has(target.installationId)
      : target.kind === "logical-skill"
        ? logicalSkillIds.has(target.logicalSkillId)
        : pluginIds.has(target.pluginBoundaryId);

  if (!exists) {
    addIssue(issues, path, `target ${targetKey(target)} does not exist`);
  }
}

function validateInventoryDependencies(
  inventory: Inventory,
  installationIds: ReadonlySet<string>,
  findingIds: ReadonlySet<string>,
  logicalSkillIds: ReadonlySet<string>,
  pluginIds: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  inventory.dependencies.forEach((dependency, dependencyIndex) => {
    const path = ["dependencies", dependencyIndex];

    validateTargetExists(
      dependency.target,
      [...path, "target"],
      installationIds,
      logicalSkillIds,
      pluginIds,
      issues,
    );

    if (dependency.kind === "hard") {
      if (!installationIds.has(dependency.dependentInstallationId)) {
        addIssue(
          issues,
          [...path, "dependentInstallationId"],
          "dependent installation does not exist",
        );
      }
      if (
        dependency.target.kind === "installation" &&
        dependency.target.installationId === dependency.dependentInstallationId
      ) {
        addIssue(
          issues,
          [...path, "target"],
          "a dependency cannot target itself",
        );
      }
    } else {
      const reference = referenceKey(dependency.referringRecord);
      const exists =
        dependency.referringRecord.kind === "installation"
          ? installationIds.has(dependency.referringRecord.installationId)
          : findingIds.has(dependency.referringRecord.findingId);
      if (!exists) {
        addIssue(
          issues,
          [...path, "referringRecord"],
          `${reference} does not exist`,
        );
      }
    }
  });
}

function validateLogicalSkills(
  inventory: Inventory,
  installationsById: ReadonlyMap<string, Installation>,
  issues: MutableIssue[],
): void {
  const groupedInstallations = new Set<string>();

  inventory.logicalSkills.forEach((logicalSkill, logicalIndex) => {
    duplicateIndexes(logicalSkill.installationIds, String).forEach((index) => {
      addIssue(
        issues,
        ["logicalSkills", logicalIndex, "installationIds", index],
        "installation appears more than once in the logical skill",
      );
    });

    logicalSkill.installationIds.forEach(
      (installationId, installationIndex) => {
        const installation = installationsById.get(installationId);
        if (installation === undefined) {
          addIssue(
            issues,
            [
              "logicalSkills",
              logicalIndex,
              "installationIds",
              installationIndex,
            ],
            "installation does not exist",
          );
          return;
        }

        if (groupedInstallations.has(installationId)) {
          addIssue(
            issues,
            [
              "logicalSkills",
              logicalIndex,
              "installationIds",
              installationIndex,
            ],
            "installation already belongs to another logical skill",
          );
        }
        groupedInstallations.add(installationId);

        logicalSkill.identity.strongEvidence.forEach(
          (sharedEvidence, evidenceIndex) => {
            if (
              !installation.identity.strongEvidence.some((evidence) =>
                hasSameStrongIdentity(evidence, sharedEvidence),
              )
            ) {
              addIssue(
                issues,
                [
                  "logicalSkills",
                  logicalIndex,
                  "identity",
                  "strongEvidence",
                  evidenceIndex,
                ],
                `strong evidence is not present on installation ${installationId}`,
              );
            }
          },
        );
      },
    );
  });
}

function validateWeakIdentityHints(
  inventory: Inventory,
  installationsById: ReadonlyMap<string, Installation>,
  issues: MutableIssue[],
): void {
  inventory.identityHints.forEach((hint, hintIndex) => {
    duplicateIndexes(hint.installationIds, String).forEach((index) => {
      addIssue(
        issues,
        ["identityHints", hintIndex, "installationIds", index],
        "installation appears more than once in the identity hint",
      );
    });

    hint.installationIds.forEach((installationId, installationIndex) => {
      const installation = installationsById.get(installationId);
      const path = [
        "identityHints",
        hintIndex,
        "installationIds",
        installationIndex,
      ];
      if (installation === undefined) {
        addIssue(issues, path, "installation does not exist");
      } else if (
        !installation.identity.weakEvidence.some((evidence) =>
          hasSameWeakIdentity(evidence, hint.evidence),
        )
      ) {
        addIssue(
          issues,
          path,
          `weak evidence is not present on installation ${installationId}`,
        );
      }
    });
  });
}

export function parseInstallation(input: unknown): Installation {
  const installation = parseSchema<Installation>(installationSchema, input);
  const issues: MutableIssue[] = [];
  validateInstallation(installation, [], issues);
  return finish(installation, issues);
}

export function parseNonInstallationFinding(
  input: unknown,
): NonInstallationFinding {
  const finding = parseSchema<NonInstallationFinding>(
    nonInstallationFindingSchema,
    input,
  );
  const issues: MutableIssue[] = [];
  validateFinding(finding, [], issues);
  return finish(finding, issues);
}

export function parseLogicalSkill(input: unknown): LogicalSkill {
  return deepFreeze(parseSchema<LogicalSkill>(logicalSkillSchema, input));
}

export function parseInventory(input: unknown): Inventory {
  const inventory = parseSchema<Inventory>(inventorySchema, input);
  const issues: MutableIssue[] = [];

  duplicateIndexes(inventory.installations, (item) => item.id).forEach(
    (index) => {
      addIssue(
        issues,
        ["installations", index, "id"],
        "duplicate installation id",
      );
    },
  );
  duplicateIndexes(inventory.otherFindings, (item) => item.id).forEach(
    (index) => {
      addIssue(issues, ["otherFindings", index, "id"], "duplicate finding id");
    },
  );
  duplicateIndexes(inventory.logicalSkills, (item) => item.id).forEach(
    (index) => {
      addIssue(
        issues,
        ["logicalSkills", index, "id"],
        "duplicate logical skill id",
      );
    },
  );
  duplicateIndexes(inventory.plugins, (plugin) => plugin.id).forEach(
    (index) => {
      addIssue(issues, ["plugins", index, "id"], "duplicate plugin id");
    },
  );

  inventory.installations.forEach((installation, index) => {
    validateInstallation(installation, ["installations", index], issues);
  });
  inventory.otherFindings.forEach((finding, index) => {
    validateFinding(finding, ["otherFindings", index], issues);
  });

  const installationsById = new Map(
    inventory.installations.map((installation) => [
      installation.id,
      installation,
    ]),
  );
  const installationIds = new Set(installationsById.keys());
  const findingIds = new Set(
    inventory.otherFindings.map((finding) => finding.id),
  );
  const logicalSkillIds = new Set(
    inventory.logicalSkills.map((logicalSkill) => logicalSkill.id),
  );
  const pluginIds = new Set(inventory.plugins.map((plugin) => plugin.id));

  validateLogicalSkills(inventory, installationsById, issues);
  validateWeakIdentityHints(inventory, installationsById, issues);
  validatePluginBoundaries(inventory, installationsById, issues);
  validateGlobalRecordCleanupEvidence(inventory, issues);
  validateInventoryDependencies(
    inventory,
    installationIds,
    findingIds,
    logicalSkillIds,
    pluginIds,
    issues,
  );

  return finish(inventory, issues);
}

function hasApproval(
  approvals: readonly ApprovalRequirement[],
  predicate: (approval: ApprovalRequirement) => boolean,
): boolean {
  return approvals.some(predicate);
}

function isBruteForceAction(action: RemovalAction): boolean {
  return action.kind === "quarantine" || action.kind === "record-cleanup";
}

function actionTargets(action: RemovalAction): readonly RemovalTarget[] {
  return action.kind === "record-cleanup"
    ? action.affectedTargets
    : [action.target];
}

function validateAction(
  action: RemovalAction,
  actionIndex: number,
  priorActionIds: ReadonlySet<string>,
  targetKeys: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  const path = ["actions", actionIndex];
  const targets = actionTargets(action);
  duplicateIndexes(targets, targetKey).forEach((index) => {
    addIssue(
      issues,
      action.kind === "record-cleanup"
        ? [...path, "affectedTargets", index]
        : [...path, "target"],
      "duplicate action target",
    );
  });
  targets.forEach((target, index) => {
    if (!targetKeys.has(targetKey(target))) {
      addIssue(
        issues,
        action.kind === "record-cleanup"
          ? [...path, "affectedTargets", index]
          : [...path, "target"],
        "action target is not a plan target",
      );
    }
  });

  duplicateIndexes(action.dependsOn, String).forEach((index) => {
    addIssue(
      issues,
      [...path, "dependsOn", index],
      "dependency appears more than once",
    );
  });
  duplicateIndexes(action.affectedInstallationIds, String).forEach((index) => {
    addIssue(
      issues,
      [...path, "affectedInstallationIds", index],
      "affected installation appears more than once",
    );
  });
  action.dependsOn.forEach((dependency, dependencyIndex) => {
    if (!priorActionIds.has(dependency)) {
      addIssue(
        issues,
        [...path, "dependsOn", dependencyIndex],
        "action dependencies must reference an earlier action",
      );
    }
  });

  if (
    isBruteForceAction(action) &&
    !hasApproval(
      action.approvals,
      (approval) => approval.kind === "brute-force-confirmation",
    )
  ) {
    addIssue(
      issues,
      [...path, "approvals"],
      "brute-force removal requires separate brute-force confirmation",
    );
  }

  if (action.kind === "managed-removal") {
    if (
      action.owner.kind === "manager" &&
      action.owner.managerId.length === 0
    ) {
      addIssue(issues, [...path, "owner"], "managed removal requires an owner");
    }

    if (action.invocation.kind === "ephemeral-package") {
      const packageExecution = action.invocation.packageExecution;
      const approved = hasApproval(action.approvals, (approval) =>
        approval.kind === "package-trust"
          ? approval.runner === packageExecution.runner &&
            approval.packageName === packageExecution.packageName &&
            approval.packageVersion === packageExecution.packageVersion &&
            approval.adapterHash === packageExecution.adapterHash
          : false,
      );
      if (!approved) {
        addIssue(
          issues,
          [...path, "approvals"],
          "ephemeral package execution requires matching package trust",
        );
      }
    }
    duplicateIndexes(action.effects, (effect) => effect.path).forEach(
      (index) => {
        addIssue(
          issues,
          [...path, "effects", index, "path"],
          "duplicate managed removal effect path",
        );
      },
    );
    duplicateIndexes(action.verifications, (verification) =>
      stringifyModel(verification, 0),
    ).forEach((index) => {
      addIssue(
        issues,
        [...path, "verifications", index],
        "duplicate managed verification",
      );
    });
    action.effects.forEach((effect, index) => {
      if (
        effect.protection.git.kind === "protected" ||
        effect.protection.system.kind === "system-skill" ||
        effect.protection.filesystem.kind === "read-only"
      ) {
        addIssue(
          issues,
          [...path, "effects", index],
          "managed removal cannot mutate a protected expected effect",
        );
      }
    });
  }

  if (
    action.kind === "record-cleanup" &&
    (action.protection.git.kind === "protected" ||
      action.protection.system.kind === "system-skill" ||
      action.protection.filesystem.kind === "read-only")
  ) {
    addIssue(
      issues,
      [...path, "protection"],
      "record cleanup cannot mutate a protected document",
    );
  }
  if (action.kind === "record-cleanup") {
    if (action.location.artifactType.kind !== "file") {
      addIssue(
        issues,
        [...path, "location", "artifactType"],
        "record cleanup location must be a file",
      );
    }
    duplicateIndexes(action.records, (record) => record.recordPointer).forEach(
      (index) => {
        addIssue(
          issues,
          [...path, "records", index, "recordPointer"],
          "duplicate record cleanup pointer",
        );
      },
    );
  }
}

function validateBlocks(
  plan: RemovalPlan,
  actionsByTarget: ReadonlyMap<string, readonly RemovalAction[]>,
  targetKeys: ReadonlySet<string>,
  issues: MutableIssue[],
): void {
  plan.blocks.forEach((block, blockIndex) => {
    const key = targetKey(block.target);
    if (!targetKeys.has(key)) {
      addIssue(
        issues,
        ["blocks", blockIndex, "target"],
        "block target is not a plan target",
      );
    }
    if (
      block.kind === "hard-dependency" &&
      targetKey(block.dependency.target) !== key
    ) {
      addIssue(
        issues,
        ["blocks", blockIndex, "dependency", "target"],
        "hard dependency target must match the block target",
      );
    }
    const targetActions = actionsByTarget.get(key) ?? [];
    if (!block.overridable && targetActions.length > 0) {
      addIssue(
        issues,
        ["blocks", blockIndex],
        "a non-overridable block cannot have removal actions",
      );
    }
    if (block.overridable && targetActions.length > 0) {
      const safeguard =
        block.kind === "hard-dependency" ? "dependency" : "ambiguity";
      const overridden = targetActions.every((action) =>
        hasApproval(
          action.approvals,
          (approval) =>
            approval.kind === "force-override" &&
            approval.safeguards.includes(safeguard),
        ),
      );
      if (!overridden) {
        addIssue(
          issues,
          ["blocks", blockIndex],
          `actions require a force override for ${safeguard}`,
        );
      }
    }
  });
}

export function parseRemovalPlan(input: unknown): RemovalPlan {
  const plan = parseSchema<RemovalPlan>(removalPlanSchema, input);
  const issues: MutableIssue[] = [];

  duplicateIndexes(plan.targets, targetKey).forEach((index) => {
    addIssue(issues, ["targets", index], "duplicate removal target");
  });
  if (plan.intent.kind === "targets") {
    duplicateIndexes(plan.intent.targets, targetKey).forEach((index) => {
      addIssue(
        issues,
        ["intent", "targets", index],
        "duplicate removal target",
      );
    });
    if (
      plan.intent.targets.length !== plan.targets.length ||
      plan.intent.targets.some(
        (target, index) =>
          targetKey(target) !== targetKey(plan.targets[index]!),
      )
    ) {
      addIssue(
        issues,
        ["intent", "targets"],
        "normalized target intent must match plan targets",
      );
    }
  }
  duplicateIndexes(plan.actions, (action) => action.id).forEach((index) => {
    addIssue(issues, ["actions", index, "id"], "duplicate removal action id");
  });
  duplicateIndexes(plan.verificationChecks, (check) => check.id).forEach(
    (index) => {
      addIssue(
        issues,
        ["verificationChecks", index, "id"],
        "duplicate verification check id",
      );
    },
  );

  const targetKeys = new Set(plan.targets.map(targetKey));
  const actionsByTarget = new Map<string, RemovalAction[]>();
  const actionsById = new Map<string, RemovalAction>();
  const priorActionIds = new Set<string>();
  plan.actions.forEach((action, index) => {
    validateAction(action, index, priorActionIds, targetKeys, issues);
    priorActionIds.add(action.id);
    actionsById.set(action.id, action);
    for (const target of actionTargets(action)) {
      const key = targetKey(target);
      actionsByTarget.set(key, [...(actionsByTarget.get(key) ?? []), action]);
    }
  });

  const managedInstallationIds = new Set(
    plan.actions.flatMap((action) =>
      action.kind === "managed-removal" ? action.affectedInstallationIds : [],
    ),
  );
  plan.actions.forEach((action, index) => {
    if (
      isBruteForceAction(action) &&
      action.affectedInstallationIds.some((installationId) =>
        managedInstallationIds.has(installationId),
      )
    ) {
      addIssue(
        issues,
        ["actions", index],
        "managed and brute-force removal for one installation require separate plans",
      );
    }
  });

  validateBlocks(plan, actionsByTarget, targetKeys, issues);

  plan.warnings.forEach((warning, index) => {
    if (!targetKeys.has(targetKey(warning.target))) {
      addIssue(
        issues,
        ["warnings", index, "target"],
        "warning target is not a plan target",
      );
    }
  });
  plan.verificationChecks.forEach((check, index) => {
    if (
      check.kind === "target-unavailable" &&
      !targetKeys.has(targetKey(check.target))
    ) {
      addIssue(
        issues,
        ["verificationChecks", index, "target"],
        "verification target is not a plan target",
      );
    }
    if (
      check.kind !== "target-unavailable" &&
      !priorActionIds.has(check.actionId)
    ) {
      addIssue(
        issues,
        ["verificationChecks", index, "actionId"],
        "verification action does not exist in the plan",
      );
    } else if (check.kind !== "target-unavailable") {
      const action = actionsById.get(check.actionId);
      if (action !== undefined && !verificationBelongsToAction(check, action)) {
        addIssue(
          issues,
          ["verificationChecks", index, "actionId"],
          "verification check is not authorized by its owning action",
        );
      }
    }
    if (
      check.kind === "command-succeeds" &&
      new Set(check.successExitCodes).size !== check.successExitCodes.length
    ) {
      addIssue(
        issues,
        ["verificationChecks", index, "successExitCodes"],
        "success exit codes must be unique",
      );
    }
  });

  return finish(plan, issues);
}

function verificationBelongsToAction(
  check: Exclude<VerificationCheck, { kind: "target-unavailable" }>,
  action: RemovalAction,
): boolean {
  if (action.kind === "quarantine") {
    return check.kind === "path-absent" && check.path === action.location.path;
  }
  if (action.kind === "record-cleanup") {
    return (
      check.kind === "record-absent" &&
      check.path === action.location.path &&
      check.format === action.format &&
      action.records.some(
        (record) =>
          record.recordPointer === check.recordPointer &&
          stringifyModel(record.expectedRecordHash, 0) ===
            stringifyModel(check.expectedRecordHash, 0),
      )
    );
  }

  switch (check.kind) {
    case "path-absent":
      return (
        action.effects.some(
          (effect) =>
            effect.kind === "remove-path" && effect.path === check.path,
        ) ||
        action.verifications.some(
          (verification) =>
            verification.kind === "path-absent" &&
            verification.path === check.path,
        )
      );
    case "record-absent":
      return (
        check.expectedRecordHash === null &&
        action.verifications.some(
          (verification) =>
            verification.kind === "record-absent" &&
            verification.path === check.path &&
            verification.format === check.format &&
            verification.recordPointer === check.recordPointer,
        )
      );
    case "owner-state-absent":
      return (
        stringifyModel(check.owner, 0) === stringifyModel(action.owner, 0) &&
        action.verifications.some(
          (verification) =>
            verification.kind === "owner-state-absent" &&
            verification.externalId === check.externalId,
        )
      );
    case "command-succeeds":
      return action.verifications.some(
        (verification) =>
          verification.kind === "command-succeeds" &&
          stringifyModel(verification.command, 0) ===
            stringifyModel(check.command, 0) &&
          stringifyModel(verification.successExitCodes, 0) ===
            stringifyModel(check.successExitCodes, 0),
      );
  }
}

function validateCompletedAfterStarted(
  startedAt: string,
  completedAt: string,
  path: readonly (number | string)[],
  issues: MutableIssue[],
): void {
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    addIssue(issues, path, "completion time cannot precede start time");
  }
}

function validateExecutionStatus(
  report: ExecutionReport,
  issues: MutableIssue[],
): void {
  const failed =
    report.actionResults.some((result) => result.status === "failed") ||
    report.verificationResults.some((result) => result.status === "failed") ||
    report.targetResults.some((result) => result.status === "failed") ||
    report.rescanError !== null;
  const blocked =
    report.actionResults.some((result) => result.status === "blocked") ||
    report.targetResults.some((result) => result.status === "blocked");
  const incomplete =
    report.actionResults.some((result) => result.status === "skipped") ||
    report.targetResults.some((result) =>
      ["partially-removed", "unresolved"].includes(result.status),
    );

  if (report.status === "succeeded" && (failed || blocked || incomplete)) {
    addIssue(
      issues,
      ["status"],
      "a succeeded report cannot contain failed, blocked, skipped, or incomplete results",
    );
  }
  if (report.status === "failed" && !failed) {
    addIssue(issues, ["status"], "a failed report requires a failed result");
  }
  if (report.status === "blocked" && !blocked) {
    addIssue(issues, ["status"], "a blocked report requires a blocked result");
  }
  if (report.status === "partial" && !(failed || blocked || incomplete)) {
    addIssue(
      issues,
      ["status"],
      "a partial report requires an incomplete result",
    );
  }
}

export function parseExecutionReport(input: unknown): ExecutionReport {
  const report = parseSchema<ExecutionReport>(executionReportSchema, input);
  const issues: MutableIssue[] = [];

  duplicateIndexes(report.actionResults, (result) => result.actionId).forEach(
    (index) => {
      addIssue(
        issues,
        ["actionResults", index, "actionId"],
        "duplicate action result",
      );
    },
  );
  duplicateIndexes(report.targetResults, (result) =>
    targetKey(result.target),
  ).forEach((index) => {
    addIssue(
      issues,
      ["targetResults", index, "target"],
      "duplicate target result",
    );
  });
  duplicateIndexes(
    report.verificationResults,
    (result) => result.checkId,
  ).forEach((index) => {
    addIssue(
      issues,
      ["verificationResults", index, "checkId"],
      "duplicate verification result",
    );
  });

  validateCompletedAfterStarted(
    report.startedAt,
    report.completedAt,
    ["completedAt"],
    issues,
  );
  if ((report.finalInventoryId === null) !== (report.rescanError !== null)) {
    addIssue(
      issues,
      ["finalInventoryId"],
      "final Inventory ID and rescan error must describe one rescan outcome",
    );
  }
  if (report.rescanError !== null && report.verificationResults.length > 0) {
    addIssue(
      issues,
      ["verificationResults"],
      "a failed final rescan cannot claim verification results",
    );
  }
  report.actionResults.forEach((result, index) => {
    validateCompletedAfterStarted(
      result.startedAt,
      result.completedAt,
      ["actionResults", index, "completedAt"],
      issues,
    );
  });

  const actionResultsById = new Map(
    report.actionResults.map((result, index) => [
      result.actionId,
      { index, result },
    ]),
  );
  report.actionResults.forEach((result, index) => {
    if (result.status !== "blocked") {
      return;
    }
    duplicateIndexes(result.blockedByActionIds, String).forEach(
      (duplicateIndex) => {
        addIssue(
          issues,
          ["actionResults", index, "blockedByActionIds", duplicateIndex],
          "blocking action appears more than once",
        );
      },
    );
    result.blockedByActionIds.forEach((blockingId, blockingIndex) => {
      const blocking = actionResultsById.get(blockingId);
      const path = [
        "actionResults",
        index,
        "blockedByActionIds",
        blockingIndex,
      ];
      if (blocking === undefined) {
        addIssue(issues, path, "blocking action result does not exist");
      } else if (blocking.index >= index) {
        addIssue(issues, path, "blocking action result must appear earlier");
      } else if (
        blocking.result.status !== "failed" &&
        blocking.result.status !== "blocked" &&
        blocking.result.status !== "skipped"
      ) {
        addIssue(
          issues,
          path,
          "blocking action must have failed, been blocked, or been skipped",
        );
      }
    });
  });

  report.targetResults.forEach((result, index) => {
    duplicateIndexes(result.actionIds, String).forEach((duplicateIndex) => {
      addIssue(
        issues,
        ["targetResults", index, "actionIds", duplicateIndex],
        "action appears more than once in the target result",
      );
    });
    result.actionIds.forEach((actionId, actionIndex) => {
      if (!actionResultsById.has(actionId)) {
        addIssue(
          issues,
          ["targetResults", index, "actionIds", actionIndex],
          "action result does not exist",
        );
      }
    });
  });
  validateExecutionStatus(report, issues);

  report.fallbackPlans.forEach((fallbackPlan, index) => {
    try {
      parseRemovalPlan(fallbackPlan);
    } catch (error: unknown) {
      if (error instanceof ModelValidationError) {
        for (const issue of error.issues) {
          addIssue(
            issues,
            ["fallbackPlans", index, ...issue.path],
            issue.message,
          );
        }
      } else {
        throw error;
      }
    }
    if (
      report.finalInventoryId === null ||
      fallbackPlan.inventoryId !== report.finalInventoryId
    ) {
      addIssue(
        issues,
        ["fallbackPlans", index, "inventoryId"],
        "fallback plan must be built from the final Inventory",
      );
    }
    if (fallbackPlan.intent.mode !== "brute-force") {
      addIssue(
        issues,
        ["fallbackPlans", index, "intent", "mode"],
        "fallback offer must be a separately confirmed brute-force plan",
      );
    }
    if (fallbackPlan.actions.length === 0) {
      addIssue(
        issues,
        ["fallbackPlans", index, "actions"],
        "fallback offer must contain an executable action",
      );
    }
    const reportTargets = new Set(
      report.targetResults.map((result) => targetKey(result.target)),
    );
    fallbackPlan.targets.forEach((target, targetIndex) => {
      if (!reportTargets.has(targetKey(target))) {
        addIssue(
          issues,
          ["fallbackPlans", index, "targets", targetIndex],
          "fallback target is not an execution target",
        );
      }
    });
  });
  duplicateIndexes(report.fallbackPlans, (fallbackPlan) =>
    stringifyModel(fallbackPlan.targets, 0),
  ).forEach((index) => {
    addIssue(issues, ["fallbackPlans", index], "duplicate fallback offer");
  });
  if (
    report.fallbackPlans.length > 0 &&
    report.status !== "failed" &&
    report.status !== "partial"
  ) {
    addIssue(
      issues,
      ["fallbackPlans"],
      "fallback offers require a failed or partial execution",
    );
  }

  return finish(report, issues);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child as JsonValue);
  }
  return value;
}
