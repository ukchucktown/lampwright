import type {
  SessionSetupSnapshot,
  SessionSetupTarget,
} from "../session-setup/types.js";
import type { TuiEntry, TuiSection } from "./types.js";

const harnesses = ["codex", "claude-code", "gemini-cli"] as const;
export function createSetupSections(
  snapshot: SessionSetupSnapshot,
  view: "inventory" | "disabled",
): readonly TuiSection[] {
  return harnesses.map((harnessId) => {
    const targets = snapshot.targets
      .filter((target) => target.harnessId === harnessId)
      .filter((target) =>
        view === "disabled"
          ? target.state.effectiveWorkspaceState === "disabled"
          : target.state.effectiveWorkspaceState !== "disabled",
      );
    const sources = snapshot.sources.filter(
      (source) => source.harnessId === harnessId,
    );
    return {
      key: `setup:${harnessId}`,
      label:
        harnessId === "codex"
          ? "Codex"
          : harnessId === "claude-code"
            ? "Claude Code"
            : "Gemini CLI",
      detail: `${targets.length} target(s) · ${sources.length} source(s)${sources.some((source) => source.status !== "success") ? " · unavailable/incomplete evidence" : ""}`,
      selectable: targets.some(selectable),
      target: null,
      entries: typedEntries(targets),
    };
  });
}
function typedEntries(
  targets: readonly SessionSetupTarget[],
): readonly TuiEntry[] {
  const names = new Map<string, number>();
  for (const target of targets)
    names.set(target.name, (names.get(target.name) ?? 0) + 1);
  const kinds = [
    "skill-exposure",
    "plugin",
    "mcp-registration",
    "app-binding",
  ] as const;
  return kinds.flatMap((kind) => {
    const members = targets.filter((target) => target.kind === kind);
    if (members.length === 0) return [];
    return [
      {
        key: `setup-heading:${kind}`,
        name: heading(kind),
        description: null,
        exposedTo: [],
        paths: [],
        owner: "",
        note: null,
        target: null,
        selectable: false,
      },
      ...members.map((target) =>
        entry(target, (names.get(target.name) ?? 0) > 1),
      ),
    ];
  });
}
function heading(kind: SessionSetupTarget["kind"]): string {
  return kind === "skill-exposure"
    ? "Skills"
    : kind === "mcp-registration"
      ? "MCP servers"
      : kind === "app-binding"
        ? "Apps"
        : "Plugins";
}
function entry(target: SessionSetupTarget, duplicate = false): TuiEntry {
  const child =
    target.kind === "skill-exposure" && target.owner.kind === "plugin";
  return {
    key: `setup:${target.id}`,
    ...(child ? { rowKind: "plugin-skill" as const } : {}),
    name: duplicate ? `${target.name} · ${target.owner.kind}` : target.name,
    description: [
      `Type: ${target.kind}`,
      `Source: ${target.source.path ?? target.source.sourceId}`,
      `Owner: ${target.owner.kind}`,
      `Policy: ${target.state.policy}`,
      `Effective state: ${target.state.effectiveWorkspaceState}`,
      `Scope: ${target.definitionScope.kind}`,
      "Account: unknown",
      "Live session: unknown",
    ].join("\n"),
    exposedTo: [target.harnessId],
    paths: target.source.path === null ? [] : [target.source.path],
    owner: target.owner.kind,
    note: `${target.kind} · ${target.state.effectiveWorkspaceState}`,
    target: null,
    selectable: selectable(target),
  };
}
function selectable(target: SessionSetupTarget): boolean {
  return (
    !(target.kind === "skill-exposure" && target.owner.kind === "plugin") &&
    target.owner.kind !== "runtime" &&
    target.state.policy !== "unresolved"
  );
}
export function selectedSetupTargetIds(
  sections: readonly TuiSection[],
  selected: ReadonlySet<string>,
  sectionIndex: number,
  entryIndex: number,
): readonly string[] {
  const selectedIds = (sections[sectionIndex]?.entries ?? [])
    .filter((entry) => selected.has(entry.key))
    .map((entry) => entry.key.slice(6));
  if (selectedIds.length) return selectedIds;
  const entry = sections[sectionIndex]?.entries[entryIndex];
  return entry?.selectable ? [entry.key.slice(6)] : [];
}
