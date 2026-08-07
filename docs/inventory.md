# Inventory scanning

The Inventory module exposes one interface:

```ts
scan(request: ScanRequest): Promise<Inventory>
```

The normal scanner resolves the bounded generic `.agents/skills` roots under
the current user's home and current workspace. Callers may add explicit,
absolute discovery roots. The module owns root resolution, traversal, metadata
parsing, hashing, classification, Git inspection, identity grouping, and result
validation. It never scans the home or workspace itself.

For deterministic tests, create an `InventoryScanner` with an injected clock,
isolated path environment, and structured command runner:

```ts
import { createInventoryScanner } from "skill-cleaner";

const scanner = createInventoryScanner({
  now: () => new Date("2026-01-01T00:00:00.000Z"),
  environment: {
    homeDirectory: fixture.home,
    workspaceDirectory: fixture.workspace,
    configDirectory: fixture.config,
    stateDirectory: fixture.state,
    nodeVersion: "22.20.0",
  },
  commandRunner: fakeCommandRunner,
});
const inventory = await scanner.scan({ roots });
```

The default `scan(request)` function uses the system clock, home, workspace,
and a non-shell process runner. Both entry points run the same implementation.

## Discovery roots

Default roots and every explicit `DiscoveryRoot` carry the evidence needed to
classify findings without guessing from a directory name:

- `user` and `agent` roots produce active Installations.
- `workspace` roots produce standalone project skills and must be contained by
  their declared workspace.
- `plugin` roots produce plugin-owned Installations with the declared ownership
  boundary.
- `source`, `cache-or-vendor`, `system`, and `unknown` roots produce
  `otherFindings`, never ordinary removal candidates.

Explicit roots augment the normal roots. Missing roots are ignored because
known agent locations commonly do not exist. Duplicate equivalent roots are
deduplicated by filesystem identity; contradictory declarations are rejected
with `InventoryScanError`.

`Inventory.id` is a deterministic fingerprint of the complete normalized
snapshot, excluding `scannedAt`. Repeating an unchanged scan at another time
therefore retains the ID, while changed ownership, protection, removal,
dependency, or record evidence changes it. Execution can use this semantic
identity when it fresh-scans and replans an approved Removal Plan.

Each physical declared Plugin root receives a stable scan-local boundary ID.
Installations reference that boundary separately from the Plugin system's
external ID, so the same external Plugin installed in user and workspace scope
remains two independently reviewable ownership boundaries. Generic discovery
materializes the declared root itself as protected, recoverable collateral plus
an explicit filesystem fallback, even when that root contains no Skills. A
fallback can therefore quarantine the complete Plugin root—including unknown
files and directories—instead of treating only discovered `SKILL.md` children
as the Plugin. Adapters may later add stronger planner-ready evidence.

## Filesystem behavior

Traversal is recursive only within a declared root and stops once it finds a
directory containing a regular `SKILL.md`. Directory copies are hashed from
sorted relative entry names, types, link targets, and file bytes, without
including timestamps or platform separators.

Directory links are represented at their physical installation paths. A link
is inspected only when it directly represents a Skill; the scanner never uses
a linked root or nested link to recurse into its target. Direct Skill links are
resolved to collect metadata and strong canonical identity evidence.
Broken links remain visible with `broken` status and no canonical path or hash.
On Windows, the scanner queries the reparse tag to distinguish junctions from
symbolic links, with a conservative path-shape fallback if that query is
unavailable.
Filesystem permission evidence for a broken Plugin-root link or junction comes
from its parent directory, because Quarantine removes the directory entry and
must not follow the absent target.

Frontmatter `name`, `description`, and string-array `tags` are normalized.
Malformed frontmatter leaves the finding visible with fallback metadata and an
`unresolved` Installation status.

## Protection and identity

Every discovered path, including a Skill directory that is itself a worktree
root, is checked against Git. Ignored paths are marked `ignored`; tracked and
unignored paths are marked `protected`. Git command errors are conservative: if
a `.git` worktree marker is present, the artifact remains protected.

Canonical targets, declared source coordinates, and plugin coordinates are
strong identity evidence and may form Logical Skills. Shared normalized names
or content hashes create `identityHints` only; they never merge Installations.

Scanning performs reads and structured Git queries only. It creates no config,
state, cache, quarantine, or temporary files.

## Vercel `skills` reconciliation

When either `<workspace>/skills-lock.json` or the global Vercel lock exists,
Inventory reads the regular JSON file and reconciles every lock key against
the bounded path registry pinned to `skills@1.5.22`. The global lock is
`$XDG_STATE_HOME/skills/.skill-lock.json` when a state directory is supplied,
and `~/.agents/.skill-lock.json` otherwise. Global and project canonical
installations are respectively under `~/.agents/skills` and
`<workspace>/.agents/skills`. Known agent-native copies, links, legacy
universal paths, and bounded Eve subagent directories are inspected without
crawling the home or workspace.

One manager-owned Installation represents one lock key in one scope. Its
primary location is the canonical directory when present, otherwise the first
exact copy; every other exact link or copy is retained as supplemental removal
collateral. A lock-only record remains visible with `broken` status, marks its
expected primary artifact absent, and can use record-only declarative fallback.
Namespaced
`vercel-skills` metadata records the exact lock key, sanitized name, lock
format/version, source type, source/plugin fields, agents, install mode, ref,
and stale state. Only a present `(source, skillPath)` pair becomes strong
identity evidence. A source or plugin name alone remains searchable metadata
and never merges unrelated Skills.

Manager ownership is limited to paths produced by the pinned registry for the
exact sanitized lock key. A link is accepted only when it targets that entry's
canonical path. Current project copies must match the lock's `computedHash`
using the manager's own hashing algorithm; a changed copy remains visible but
native and declarative removal are unavailable. Legacy copy records without a
hash retain the lock's declared ownership evidence.

The same namespace exposes deterministic `sourceGroupId` and `pluginGroupId`
selection hints. Source groups bind scope plus source; plugin-name groups bind
scope, source, and plugin name so equal labels from unrelated sources cannot
collide. Selecting one of these hints expands to the group's exact Installation
targets in a normal multi-target intent. These are batch-selection groups, not
Logical Skill identity evidence, and they never merge their member Skills.

The parser accepts numeric lock versions while ignoring unknown fields. Native
removal is available only for versions understood by `skills@1.5.22` (global
version 3 or newer and project version 1 or newer); older records retain exact
declarative fallback. It rejects malformed documents, duplicate keys, non-object
records, symlinked or hard-linked lock files, and sanitized lock-key collisions
for mutation. A canonical Skill underneath an invalid lock remains visible as
unresolved but exposes no cleanup authority. Collision entries likewise expose
neither native nor declarative fallback, because the manager's sanitized
selector could otherwise remove the wrong artifact. A lock key that the
manager would parse as a command option or unsafe argument disables only native
removal; its exact declarative fallback remains separately confirmable.
Injected `configDirectory` and `agentHomeDirectories` keep XDG and supported
manager environment overrides explicit and make tests independent of the
developer's real paths.
