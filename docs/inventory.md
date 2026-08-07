# Inventory scanning

The Inventory module exposes one interface:

```ts
scan(request: ScanRequest): Promise<Inventory>
```

The normal scanner resolves the bounded generic `.agents/skills` roots under
the current user's home and current workspace and Codex's standalone
`<CODEX_HOME>/skills` root. Callers may add explicit, absolute discovery roots.
The module owns root resolution, traversal, metadata parsing, hashing,
classification, Git inspection, identity grouping, and result validation. It
never scans the home or workspace itself.

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

## Claude Code plugin reconciliation

Inventory reads Claude Code's version 2 installed-plugin registry from
`<claude-config>/plugins/installed_plugins.json`. The config root is
`CLAUDE_CONFIG_DIR` when supplied to the normal scanner and otherwise
`~/.claude`; injected scanners use the `claude-code` agent home override. User
and administrator-managed records apply globally. Project and local records
apply only when their absolute `projectPath` exactly identifies the scanned
workspace, and their scope settings are read from `.claude/settings.json` or
`.claude/settings.local.json` in that workspace.

Each applicable registry record becomes its own physical Plugin boundary,
even when another scope contains the same qualified Plugin ID. The boundary ID
includes the declared installed root, scope, and workspace evidence. Installed
roots must remain under the exact versioned cache location
`plugins/cache/<marketplace>/<plugin>/...`; a mismatched or externally resolved
root is visible only as blocked Plugin state and grants no fallback authority.

The scanner reads `.claude-plugin/plugin.json`, the default component
directories, safe manifest-declared component paths, and inline hook, MCP, LSP,
and monitor configuration. This includes workflow, output-style, theme, monitor,
and executable collateral when present. Every in-root `SKILL.md` child is a
`managed-plugin-resource` Installation with strong Plugin-plus-Skill identity
evidence and `independentlySelectable: false`. Directory, symbolic link,
junction, and broken-link locations remain distinct filesystem facts. A Skill
link resolving outside the cached Plugin root is a source-only finding, not an
active Installation. The complete Plugin root is also retained as collateral
so fallback moves the bundle entry without traversing link targets.

Marketplace checkout metadata is bounded to
`plugins/marketplaces/*/.claude-plugin/marketplace.json`. Relative Plugin
sources declared there, Plugin trees in the current project, and unreferenced
versioned cache entries are `otherFindings`, not Installations. Their Skills
are therefore visible for diagnosis without becoming removal targets. The
scanner does not crawl arbitrary marketplace repositories or follow manifest
paths, linked marketplace roots, or linked source roots outside their declared
boundary.

Registry and settings mutation evidence is accepted only from stable regular
JSON files with unique keys and a single hard link. Declarative cleanup records
carry exact file and record hashes. Shared cache paths, duplicate scope records,
invalid manifests/settings, and administrator-managed records remain blocked
instead of widening the removal boundary.

## Codex plugin reconciliation

Inventory obtains installed Codex Plugin state only from the supported
`codex plugin list --json` command. The command receives the injected or
environment-derived `CODEX_HOME`; its temporary-directory variables point to
that same root so Codex cannot create its helper alias during a read-only scan.
`DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` are also fixed by the scanner. Tests
can observe the complete structured command and environment through
`InventoryCommandRunner` without invoking the developer's Codex installation.

List output must be unique-key JSON with `installed` and `available` arrays.
Every installed record must attest `installed: true`, a safe Plugin and
marketplace segment, an exact matching `<plugin>@<marketplace>` identifier, and
a version containing only Codex's safe version characters. The active root is
derived rather than accepted from output:

```text
<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>
```

The scanner rejects missing, linked, non-directory, or canonically escaping
cache hierarchy segments. The containing Plugin resource is the unversioned
Plugin cache directory, so all stale versions are collateral of one lifecycle
operation and never independent Installations. If the supported command is
unavailable or invalid, bounded direct cache entries and their manifest Skills
remain visible as `cache-or-vendor-artifact` findings with no removal authority.

Manifest lookup first recognizes a regular root `plugin.json` only when its
`$schema` is exactly Agent Plugins v1's
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`; unrelated root
files fall back to legacy precedence: `.codex-plugin/plugin.json`, then
`.claude-plugin/plugin.json`, then `.cursor-plugin/plugin.json`. Agent Plugins
use direct `skills/` children and `mcp.json` by default; their Codex hooks,
apps, and interface assets come from `extensions.com.openai` or a regular
`.codex-plugin/plugin.json` overlay. Legacy manifests retain recursive Skill
discovery and generated migrated-command Skills. Commands, hooks, MCP, apps,
generated migrated-command Skills, custom `./` paths, and interface assets are
inspected only within the active root. A nonempty legacy custom Skills
declaration replaces the default `skills/` root.
Lexically escaping paths and custom paths that resolve outside the Plugin root
block Managed Removal. A child Skill link resolving outside the cache is
source-only evidence and never an active Plugin Installation.

Local source paths explicitly returned by Codex may contribute bounded
`source-artifact` findings. Linked roots and linked children that resolve
outside such a source are not crawled. Equal names in source trees, cache
versions, standalone Codex Skills, generic Agent Skills, and active Plugin
children do not merge identities or transfer ownership.

Each attested Plugin is one user-scope Plugin boundary. Its active Skills use
strong Plugin-plus-Skill identity and `independentlySelectable: false`; ordinary
remove-all therefore excludes the containing Plugin. Managed effects cover the
whole unversioned cache boundary and the stable or safely absent
`<CODEX_HOME>/config.toml`. The retained
`plugins/data/<plugin>-<marketplace>` directory for legacy Plugins, or
`plugins/data/agent-plugins/<sha256(marketplace + NUL + plugin)[:32]>` for
Agent Plugins, is reported as orphanable collateral but is not an effect or
absence verification. Because v1 cannot
perform an exact declarative TOML edit, Codex Plugin fallback is unavailable.
