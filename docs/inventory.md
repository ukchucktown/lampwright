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
