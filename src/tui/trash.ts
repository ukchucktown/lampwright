import type {
  QuarantineOperation,
  RestoreOperationPreview,
} from "../quarantine/types.js";
import type { TuiEntry, TuiSection } from "./types.js";

/** A failed read-only preview is not evidence of an integrity failure. */
export type TrashRestoreReadiness =
  | RestoreOperationPreview
  | { readonly status: "preview-unavailable"; readonly message: string };

/** A read-only projection; Quarantine remains the storage and safety owner. */
export function createTrashSections(
  operations: readonly QuarantineOperation[],
  previews: ReadonlyMap<string, TrashRestoreReadiness>,
  now: Date = new Date(),
): readonly TuiSection[] {
  const buckets = new Map<string, QuarantineOperation[]>([
    ["recoverable", []],
    ["expired", []],
    ["attention", []],
  ]);
  for (const operation of operations) {
    const preview = previews.get(operation.id);
    const bucket =
      preview?.status === "blocked" || preview?.status === "preview-unavailable"
        ? "attention"
        : Date.parse(operation.expiresAt) <= now.getTime()
          ? "expired"
          : "recoverable";
    buckets.get(bucket)!.push(operation);
  }
  const sections: readonly [string, string, string][] = [
    ["recoverable", "Recoverable", "safe to preview and restore"],
    ["expired", "Past retention date", "eligible for permanent purge"],
    ["attention", "Needs attention", "restore preview needs attention"],
  ];
  return sections.map(([key, label, detail]) => ({
    key: `trash:${key}`,
    label,
    detail,
    selectable: false,
    target: null,
    entries: (buckets.get(key) ?? []).map((operation) =>
      entryFor(operation, previews, now),
    ),
  }));
}

function entryFor(
  operation: QuarantineOperation,
  previews: ReadonlyMap<string, TrashRestoreReadiness>,
  now: Date,
): TuiEntry {
  const preview = previews.get(operation.id);
  const paths = operation.entries.map((entry) => entry.originalLocation.path);
  const remaining = Math.ceil(
    (Date.parse(operation.expiresAt) - now.getTime()) / 86_400_000,
  );
  return {
    key: `trash-operation:${operation.id}`,
    name: operation.displayNames.join(", "),
    description: [
      `Removal method: Brute-force Removal (recoverable Quarantine).`,
      `Original locations: ${paths.join(" · ")}`,
      `Removed: ${operation.removedAt}`,
      `Expires: ${operation.expiresAt} (${String(Math.max(0, remaining))} days remaining)`,
      `Items: ${String(operation.entries.length)}`,
      `Restore readiness: ${preview?.status === "would-restore" ? "ready" : preview?.status === "preview-unavailable" ? "preview unavailable — inspect local Quarantine state" : "blocked — review conflicts"}`,
    ].join("\n"),
    exposedTo: [],
    paths,
    owner: "Quarantine",
    note:
      preview?.status === "would-restore"
        ? `${String(operation.entries.length)} items`
        : preview?.status === "preview-unavailable"
          ? "preview unavailable"
          : "blocked",
    target: null,
  };
}
