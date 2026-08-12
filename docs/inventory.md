# Inventory scanning

The Inventory module exposes one interface:

```ts
scan(request: ScanRequest): Promise<Inventory>
```

The normal scanner resolves the bounded generic `.agents/skills` roots under
the current user's home and current workspace, Codex's standalone
`<CODEX_HOME>/skills` root, and Claude's standalone `<CLAUDE_CONFIG_DIR>/skills`
and `<workspace>/.claude/skills` roots. Callers may add explicit, absolute
discovery roots.
The module owns root resolution, traversal, metadata parsing, hashing,
classification, Git inspection, identity grouping, and result validation. It
never scans the home or workspace itself.

For deterministic tests, create an `InventoryScanner` with an injected clock,
isolated path environment, and structured command runner:

```ts
import { createInventoryScanner } from "lampwright";

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
  adapterCatalog: compiledCatalog,
});
const inventory = await scanner.scan({ roots });
```

The default `scan(request)` function uses the system clock, home, workspace,
and a non-shell process runner. Both entry points run the same implementation.

`adapterCatalog` is the already-compiled, trusted Adapter seam; Inventory
evaluates its bounded roots, probes, manifests, and planner-ready evidence.
Request roots cannot claim an Adapter ID present in that catalog, so callers
cannot forge catalog provenance or bypass an Adapter root's probe requirements.

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

When two roots claim one path and classify it differently, the root declared
strictly inside the other describes the narrower boundary and wins. Roots that
do not contain one another remain a contradiction and are rejected. A declared
root — a default or one an Adapter supplies — may only narrow toward
protection, so a nested Adapter root can never widen what is removable inside a
`source`, `cache-or-vendor`, `system`, or `unknown` root. A root the caller
supplied for the current invocation may narrow in either direction except that
it can never widen a marked `system` boundary: an explicit path is discovery
authority, not authority to make inseparable runtime content removable.

Claude's standalone Skill roots are bounded to `<CLAUDE_CONFIG_DIR>/skills` and
`<workspace>/.claude/skills`, defaulting to `~/.claude` when the variable is
unset. Plugin caches, marketplaces, and source checkouts live elsewhere under
the config directory and are never swept by these roots. Where a Manager or
Plugin already claims a path, that stronger ownership wins: an agent-native
copy or link the Vercel reconciliation records as supplemental removal
collateral is not materialized again as a separate Installation. A link to an
unmanaged target stays a distinct Installation at its own path and joins its
target's Logical Skill through canonical-target evidence, so removing the Skill
covers both while removing one Installation removes only that entry.

Claude may expose capabilities compiled into its runtime that do not correspond
to a filesystem `SKILL.md`, installed Plugin, or manager record. Inventory does
not invent findings for those capabilities: there is no bounded artifact to
inspect or safe removal boundary to plan. This differs from Codex System Skills,
whose marked runtime subtree contains filesystem Skills that can be shown as
visible, immutable evidence.

Codex marks the Skills shipped with its own runtime. When
`<CODEX_HOME>/skills/.system/.codex-system-skills.marker` is a regular file,
that subtree is a `system` root and its Skills become protected System Skill
findings, while the rest of `<CODEX_HOME>/skills` stays an ordinary agent root.
The marker must be a regular file, never a link, so a planted link cannot make
the scanner treat a user's own Skills as inseparable runtime content. Without
the marker the subtree stays ordinary: a missing marker never hides Skills.

`Inventory.id` is a deterministic fingerprint of the complete normalized
snapshot, excluding `scannedAt`. Repeating an unchanged scan at another time
therefore retains the ID, while changed ownership, protection, removal,
availability, dependency, or record evidence changes it. Execution can use
this semantic identity when it fresh-scans and replans an approved Removal or
Availability Plan.

Each physical declared Plugin root receives a stable scan-local boundary ID.
Installations reference that boundary separately from the Plugin system's
external ID, so the same external Plugin installed in user and workspace scope
remains two independently reviewable ownership boundaries. Generic discovery
and built-in Plugin scanners record the owning agent harness in
`PluginBoundary.exposedTo`, including for a Plugin with no discovered Skill
children, so presentation never has to infer the harness from an adapter ID or
path. Generic discovery materializes the declared root itself as protected,
recoverable collateral plus
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

## Agent exposure

`Installation.agentId` names the agent that owns the lifecycle location.
`exposedTo` names every agent that can actually load the Skill there. They
differ whenever a Manager owns an Installation while placing agent-native
copies or links that several agents read: a Vercel-managed Skill reports
`vercel-skills` as its owner and `claude-code`, `codex`, and `universal` as its
exposure.

Each discovery path supplies its own declared evidence — a root's declared
agent, the Manager's resolved agent-native locations, or a Plugin's owning
agent. Exposure is never derived from the shape of a path. It is empty only
when nothing can load the Skill, as for a lock-only record whose artifacts are
absent; an active Installation always names at least one agent.

## Installation Groups

`Inventory.groups` records Installations that one act of installation put in
place together. Only declared evidence forms a Group: an Owner's own record
naming both the Manager that installed a Skill and the source it came from,
within one Scope. A shared name, a shared directory, or a shared install time is
not evidence and forms nothing.

Every Group carries a `tier`. `declared` is the evidence above. `structural` is
reserved for evidence derived from the filesystem, such as a shared repository
remote; the type exists so adding it later needs no schema change, and no
discovery path emits it today. Plugin-owned Installations are never grouped,
because their bundle is already a `PluginBoundary` and representing it twice
would let one selection expand through two different boundaries.

A Group is navigational and selectable, not an identity claim. Membership never
merges Skills, and a Group expands to its exact member Installations when
planned. A Logical Skill records the `groupId` that contains **every** one of
its Installations, or `null` when they disagree, in which case `spansGroups` is
set so presentation can surface the split rather than filing a Skill under one
source it only partly came from.

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
the bounded path registry pinned to `skills@1.5.22`.

The manager resolves exactly one global lock: `$XDG_STATE_HOME/skills/.skill-lock.json`
when `XDG_STATE_HOME` is set, and `~/.agents/.skill-lock.json` when it is not.
`InventoryScanEnvironment.stateDirectory` therefore carries the environment
variable itself and is `null` when unset; substituting a conventional default
such as `~/.local/state` would make the unset branch unreachable.

Discovery and authority are separate. A lock written under one environment
stays on disk when the variable later changes, so Inventory reads whichever of
the two known locations is present, preferring the manager-resolved one when
both exist. Skills recorded in a lock the manager cannot currently resolve
remain fully visible with their Manager, source, and supplemental collateral
evidence, but managed removal reports `unavailable` with that reason, leaving
the exact declarative fallback and Quarantine. A malformed lock at a candidate
location is reported rather than skipped, so an unreadable authoritative lock
never silently promotes a stale one. Global and project canonical
installations are respectively under `~/.agents/skills` and
`<workspace>/.agents/skills`. Known agent-native copies, links, legacy
universal paths, and bounded Eve subagent directories are inspected without
crawling the home or workspace.

One manager-owned Installation represents one lock key in one scope. Its
primary location is the canonical directory when present, otherwise the first
exact copy; every other exact link or copy is retained as supplemental removal
collateral. A lock-only record remains visible with `broken` status, marks its
expected primary artifact absent, and can use record-only declarative fallback.
For an active, complete, safe topology, the Vercel adapter also emits available
top-level suspension evidence containing that primary plus every supplemental
copy or link in deterministic physical-path order with each artifact's exact
protection. It states that the Manager record is preserved and that running the
Manager may recreate displaced paths. Missing, changed, ambiguous, overlapping,
or otherwise unsafe topology emits unavailable suspension evidence with a
reason; Planning never reconstructs the set from Vercel metadata.
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

## Gemini CLI reconciliation

Gemini discovery is bounded to extension Skills, user
`~/.gemini/skills`, user `~/.agents/skills`, workspace `.gemini/skills`, and
workspace `.agents/skills`, in that low-to-high precedence order. Every
physical Installation is retained; `gemini-cli` metadata records its source,
precedence, exact-case effective winner, case-insensitive disabled state, and
copy/link or junction form. Disabled state is searchable evidence only.

Native `.gemini/skills` copies and links are Gemini lifecycle targets. The
`.agents/skills` locations are discovery aliases and remain filesystem-owned.
Vercel-owned canonical or link-equivalent paths take precedence during
reconciliation, so one physical occurrence never gains competing removal
authority.

Extensions are bounded to immediate management entries under
`~/.gemini/extensions`. Stable install metadata and manifests establish the
management root, effective root (a linked source for `type: link`), context,
commands, hooks, agents, policies, `.env`, Skills, and manifest configuration
impact. Extension Skills are plugin-owned, non-independently-selectable
children. Enablement rules and disabled extensions remain inventory evidence;
unsafe, malformed, escaping, linked-management, or ambiguous state fails
closed. Linked sources are never declared as removal effects.

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

A Plugin whose declared `marketplaceSource` resolves inside a runtime-managed
marketplace root is marked `runtimeDefault` on its boundary. Two are in use:
`<XDG_CACHE_HOME>/codex-runtimes`, defaulting to `~/.cache/codex-runtimes`, and
`<CODEX_HOME>/.tmp/bundled-marketplaces`. Codex
ships those Plugins with itself. They remain visible inventory evidence, but
are outside every removal boundary even when
`codex plugin` advertises an uninstall operation. The flag lets presentation
mark them and makes bulk, explicit, and forced Plugin removal refuse them.
Matching on the managed location rather than a marketplace name survives the
runtime adding or renaming a marketplace, and a user marketplace whose name
collides with a runtime one is never flagged.

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
