import { createHash } from "node:crypto";

import { stringifyModel } from "../model/json.js";
import type {
  Installation,
  InstallationId,
  LogicalSkill,
  LogicalSkillId,
  StrongIdentityEvidence,
  WeakIdentityEvidence,
  WeakIdentityHint,
} from "../model/types.js";

interface StrongGroupCandidate {
  readonly evidence: StrongIdentityEvidence;
  readonly evidenceKey: string;
  readonly installations: readonly Installation[];
}

export function stableId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
  }
  return `${prefix}-${hash.digest("hex").slice(0, 24)}`;
}

export function groupInstallations(
  installations: readonly Installation[],
): readonly LogicalSkill[] {
  const buckets = new Map<
    string,
    { evidence: StrongIdentityEvidence; installations: Installation[] }
  >();

  for (const installation of installations) {
    for (const evidence of installation.identity.strongEvidence) {
      const key = stringifyModel(evidence, 0);
      const bucket = buckets.get(key) ?? { evidence, installations: [] };
      if (!bucket.installations.some((item) => item.id === installation.id)) {
        bucket.installations.push(installation);
      }
      buckets.set(key, bucket);
    }
  }

  const candidates: StrongGroupCandidate[] = [...buckets.entries()]
    .map(([evidenceKey, bucket]) => ({
      evidence: bucket.evidence,
      evidenceKey,
      installations: [...bucket.installations].sort(compareInstallation),
    }))
    .sort(
      (left, right) =>
        right.installations.length - left.installations.length ||
        compareText(left.evidenceKey, right.evidenceKey),
    );

  const assigned = new Set<InstallationId>();
  const logicalSkills: LogicalSkill[] = [];
  for (const candidate of candidates) {
    const members = candidate.installations.filter(
      (installation) => !assigned.has(installation.id),
    );
    if (members.length === 0) {
      continue;
    }
    members.forEach((installation) => assigned.add(installation.id));

    const installationIds = members.map((installation) => installation.id) as [
      InstallationId,
      ...InstallationId[],
    ];
    const first = members[0];
    if (first === undefined) {
      continue;
    }

    logicalSkills.push({
      id: stableId(
        "logical-skill",
        candidate.evidenceKey,
        ...installationIds,
      ) as LogicalSkillId,
      skill: first.skill,
      identity: {
        strongEvidence: [candidate.evidence],
        weakEvidence: commonWeakEvidence(members),
      },
      installationIds,
      // Group membership is assigned once Groups exist; see groups.ts.
      groupId: null,
      spansGroups: false,
    });
  }

  return logicalSkills.sort((left, right) => compareText(left.id, right.id));
}

export function createWeakIdentityHints(
  installations: readonly Installation[],
  logicalSkills: readonly LogicalSkill[],
): readonly WeakIdentityHint[] {
  const logicalSkillByInstallation = new Map<InstallationId, LogicalSkillId>();
  for (const logicalSkill of logicalSkills) {
    logicalSkill.installationIds.forEach((installationId) => {
      logicalSkillByInstallation.set(installationId, logicalSkill.id);
    });
  }

  const buckets = new Map<
    string,
    { evidence: WeakIdentityEvidence; installationIds: Set<InstallationId> }
  >();
  for (const installation of installations) {
    for (const evidence of installation.identity.weakEvidence) {
      const key = stringifyModel(evidence, 0);
      const bucket =
        buckets.get(key) ??
        ({ evidence, installationIds: new Set() } satisfies {
          evidence: WeakIdentityEvidence;
          installationIds: Set<InstallationId>;
        });
      bucket.installationIds.add(installation.id);
      buckets.set(key, bucket);
    }
  }

  const hints: WeakIdentityHint[] = [];
  for (const [, bucket] of [...buckets.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const installationIds = [...bucket.installationIds].sort(compareText);
    if (installationIds.length < 2) {
      continue;
    }
    const logicalIds = new Set(
      installationIds.map((installationId) =>
        logicalSkillByInstallation.get(installationId),
      ),
    );
    if (logicalIds.size === 1 && !logicalIds.has(undefined)) {
      continue;
    }

    hints.push({
      evidence: bucket.evidence,
      installationIds: installationIds as [
        InstallationId,
        InstallationId,
        ...InstallationId[],
      ],
    });
  }

  return hints;
}

function commonWeakEvidence(
  installations: readonly Installation[],
): readonly WeakIdentityEvidence[] {
  const first = installations[0];
  if (first === undefined) {
    return [];
  }

  return first.identity.weakEvidence
    .filter((evidence) => {
      const key = stringifyModel(evidence, 0);
      return installations.every((installation) =>
        installation.identity.weakEvidence.some(
          (candidate) => stringifyModel(candidate, 0) === key,
        ),
      );
    })
    .sort((left, right) =>
      compareText(stringifyModel(left, 0), stringifyModel(right, 0)),
    );
}

function compareInstallation(left: Installation, right: Installation): number {
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
