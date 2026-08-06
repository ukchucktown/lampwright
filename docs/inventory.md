# Inventory scanning

The Inventory module exposes one interface:

```ts
scan(request: ScanRequest): Promise<Inventory>
```

Callers supply explicit, absolute discovery roots. The module owns traversal,
metadata parsing, hashing, classification, Git inspection, identity grouping,
and result validation. It does not infer or scan a home directory, and it never
traverses a sibling or parent of a declared root.

For deterministic tests, create an `InventoryScanner` with an injected clock:

```ts
import { createInventoryScanner } from "skill-cleaner";

const scanner = createInventoryScanner({
  now: () => new Date("2026-01-01T00:00:00.000Z"),
});
const inventory = await scanner.scan({ roots });
```

The default `scan(request)` function uses the system clock. Both entry points
run the same implementation.

## Discovery roots

Every `DiscoveryRoot` carries the evidence needed to classify findings without
guessing from a directory name:

- `user` and `agent` roots produce active Installations.
- `workspace` roots produce standalone project skills and must be contained by
  their declared workspace.
- `plugin` roots produce plugin-owned Installations with the declared ownership
  boundary.
- `source`, `cache-or-vendor`, `system`, and `unknown` roots produce
  `otherFindings`, never ordinary removal candidates.

Missing roots are ignored because known agent locations commonly do not exist.
Duplicate or contradictory root declarations are rejected with
`InventoryScanError`.

## Filesystem behavior

Traversal is recursive only within a declared root and stops once it finds a
directory containing a regular `SKILL.md`. Directory copies are hashed from
sorted relative entry names, types, link targets, and file bytes, without
including timestamps or platform separators.

Directory links are represented at their physical installation paths. The
scanner resolves the top-level target to collect metadata and strong canonical
identity evidence, but it does not traverse nested symbolic links or junctions.
Broken links remain visible with `broken` status and no canonical path or hash.
On Windows, the scanner queries the reparse tag to distinguish junctions from
symbolic links, with a conservative path-shape fallback if that query is
unavailable.

Frontmatter `name`, `description`, and string-array `tags` are normalized.
Malformed frontmatter leaves the finding visible with fallback metadata and an
`unresolved` Installation status.

## Protection and identity

Every discovered path is checked against its containing Git worktree. Ignored
paths are marked `ignored`; tracked and unignored paths are marked `protected`.
Git command errors are conservative: if a `.git` worktree marker is present,
the artifact remains protected.

Canonical targets, declared source coordinates, and plugin coordinates are
strong identity evidence and may form Logical Skills. Shared normalized names
or content hashes create `identityHints` only; they never merge Installations.

Scanning performs reads and structured Git queries only. It creates no config,
state, cache, quarantine, or temporary files.
