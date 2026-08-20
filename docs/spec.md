# Lampwright v1 specification

Status: Accepted product direction; implementation under active refinement
Last updated: 2026-08-20

## 1. Summary

`lampwright` is a cross-platform terminal application that discovers, disables, enables, and safely removes AI agent skills regardless of whether they were installed as standalone files, by a skill manager, or through an agent plugin system.

The application is outcome-oriented: a user chooses a logical skill, one physical installation, or a containing plugin and asks Lampwright to control that target in the selected scope. Disabling prefers a harness-supported control and may suspend a complete planner-authorized artifact set when no safe native control exists. For an explicitly supported Manager-owned Installation, suspension preserves the Manager record and displaces every declared discovery artifact. Removal determines ownership, prefers the owner's supported uninstall operation, and offers a separately confirmed recoverable filesystem fallback when managed removal is unavailable or fails.

The primary interface is an interactive terminal UI. The supported npm
invocation is version-pinned as `npx lampwright@0.1.0` for the first release.
Before registry publication is verified, it runs from a trusted checkout as
`node dist/cli.js`. A compact non-interactive interface and JSON output support
automation and agent sessions.

## 2. Product principles

1. **Live state over a second registry.** Inventory is rebuilt from the filesystem, manager records, plugin manifests, and adapter evidence on every run.
2. **Ownership before deletion.** A discovered `SKILL.md` does not by itself prove that a directory is an independently removable installation.
3. **Managed removal first.** Use an available owner's lifecycle operation before direct filesystem cleanup.
4. **Explicit fallback.** Never silently replace a failed managed removal with brute-force deletion.
5. **Recoverability.** Brute-force cleanup moves artifacts into quarantine instead of permanently deleting them.
6. **Native disable before suspension.** Prefer a harness-supported availability control and displace only a complete, planner-authorized artifact set when no safe native control exists.
7. **Strong identity.** Skill names and content hashes alone never merge installations into one logical skill or authorize a name-wide availability change.
8. **Project source is protected.** Files inside a Git worktree are immutable unless Git classifies them as ignored.
9. **Pluggable support without executable extensions.** Tool support is described through local, versioned JSONC adapters.
10. **Cross-platform behavior.** macOS, Linux, and Windows are first-class; adapters do not assume a shell or POSIX paths.
11. **Small command surface.** The interface stays focused on scan, disable, enable, remove, restore, and purge.

## 3. Goals

- Find installed skills across common agent, manager, and plugin layouts.
- Search installed skills by normalized and tool-specific metadata.
- Distinguish logical skills from their physical installations.
- Explain who owns each installation and what else would be affected by removal.
- Disable unused standalone and explicitly supported Manager-owned Skills without deleting their content, and enable them again.
- Remove standalone, manager-owned, and independently selectable plugin-owned skills.
- Explicitly uninstall a non-default containing Plugin selected from Inventory
  or included in a CLI plan.
- Fall back to recoverable brute-force cleanup when managed removal cannot be used.
- Preserve a reliable audit trail without maintaining an installation database.
- Allow new tool support through local declarative adapters.
- Provide deterministic JSON output and non-interactive execution for automation.

## 4. Non-goals for v1

- Installing skill managers, agent runtimes, or plugins globally or into a project.
- Executable adapter plugins or remote adapter downloads.
- A public adapter registry.
- Telemetry or transmission of local inventory data.
- Whole-machine or full-home-directory scans by default.
- Editing tracked or unignored project files.
- Removing system skills supplied as inseparable runtime components.
- Silently uninstalling plugins as part of an ordinary remove-all operation.
- Providing transactional rollback across external managers.
- Measuring or promising an exact token saving from disabled Skills.

## 5. Runtime and distribution

- Language: TypeScript.
- Runtime: Node.js 20 or newer.
- Distribution: npm package named `lampwright`.
- Executable: `lampwright`.
- First-release npm invocation: `npx lampwright@0.1.0`.
- Trusted-checkout invocation: `node dist/cli.js` after build.
- License: MIT.
- Supported operating systems: current macOS, mainstream Linux distributions, and supported Windows releases.

Lampwright may itself be downloaded by `npx`. It must not add dependencies to a user's project, install global packages, or install missing managers.

## 6. Inventory and discovery

### 6.1 Scan boundaries

A normal scan includes:

- Built-in adapter locations for supported agents, managers, and plugin systems.
- User-wide locations appropriate to the current operating system.
- The current project and its recognized agent skill locations.
- Explicit custom roots supplied for the current invocation.
- Roots declared by local adapters.

A normal scan must not recursively crawl the entire home directory. Arbitrary locations require an explicit scan root. Deep scanning is not part of the v1 default interface.

### 6.2 Finding classification

Every finding is classified as one of:

- Active installation
- Managed plugin resource
- Standalone project skill
- Source artifact
- Cache or vendor artifact
- System skill
- Unknown

Source, cache, vendor, and unknown findings are hidden from ordinary cleanup results unless the user enables the relevant inspection filter. System Skills remain visible in their own non-selectable section so their protected status is clear. Their discovery never authorizes deletion.

### 6.3 Inventory fields

The normalized inventory schema includes:

- Stable inventory ID for the current scan
- Skill name and description
- Skill identity evidence
- Source identifier and URL
- Plugin identifier and version
- Manager and adapter identifiers
- Agent and scope
- Per-harness enabled or disabled status and native availability-control evidence
- Filesystem path and canonical path
- Link type and target
- Content hash and modification time
- Ownership classification and confidence
- Installation status
- Tags
- Hard dependencies and soft references
- Git protection status
- Adapter-specific namespaced metadata

The inventory is never a durable source of truth. A disposable cache may accelerate search, but deleting the cache must not change behavior.

### 6.4 Logical grouping

Installations may be grouped into a Logical Skill only with strong evidence:

- Same normalized source and skill path
- Same plugin identifier and skill identifier
- Same canonical directory or link target
- Same explicit package identity

Matching names or hashes are displayed as possible relationships but never merge records automatically.

Installation Groups are a separate navigational batch-selection mechanism. In v1 they form only from declared manager-and-source evidence in one Scope; structural grouping is deferred until a concrete discovery path and safety boundary justify it.

## 7. Search and terminal UI

Running `lampwright` without a subcommand opens the terminal UI. The
version-pinned first-release invocation is `npx lampwright@0.1.0`; before that
registry release is verified, `node dist/cli.js` runs the same entry point from
a built trusted checkout.

The UI must:

- Open a global search overlay when the user presses `/` or begins typing from
  the inventory. Search uses a case-insensitive regular expression against
  Skill names only. Invalid expressions and expressions that match empty text
  cannot be applied. Category, Owner, agent exposure, path, and description
  remain visible in the preview but do not affect matching; explicit metadata
  field syntax is deferred for later prototyping.
- Present matching Skill names in a flat list with the focused Skill's
  description, category, ownership, exposure, and paths in a right-hand
  preview. System Skills remain visible but cannot be staged.
- Stage individual matches with Space, stage every visible removable match with
  Ctrl-A, and add staged matches to the existing inventory selection with
  Enter. Enter returns to the prior inventory position, `/` can start another
  additive search, Escape cancels search without changing the inventory
  selection, Ctrl-U clears the search expression, and Ctrl-U in the inventory
  clears its selection.
- Show one row per Logical Skill by default.
- Show the focused Logical Skill's physical paths in the detail pane. Selecting
  an individual Installation in the terminal is deferred; the CLI accepts that
  target directly.
- Keep long descriptions and physical paths reachable through an independently
  scrollable and resizable detail pane. Detail navigation never changes the
  selected Removal Targets.
- Permit terminal selection of a Logical Skill, declared Installation Group,
  or non-default Plugin boundary. Show each Plugin's owning agent harness,
  owned Skill names, descriptions, and other known resources before removal.
  A Plugin's child Skill rows are read-only and use normal entry scrolling; only
  the Plugin boundary row selects complete Plugin removal or whole-Plugin
  availability. Enter reviews removal and `d` reviews Native Disable. The CLI
  also permits an individual Installation target.
- Display ownership, dependency, Git protection, and removal-method summaries before planning.
- Clearly distinguish removable, blocked, unresolved, and source-only findings.
- Present `Inventory | Disabled (N) | Trash (N)` as peer views. Inventory shows
  every Skill with at least one enabled Harness Exposure; Disabled shows every
  Skill with a natively disabled Harness Exposure plus every Suspended Disable.
  A natively disabled Plugin appears once as its complete Plugin boundary in
  Disabled. A partially disabled Skill may appear in both views with its
  per-harness state explained.
- Let an Inventory selection open a Disable review and let a Disabled selection
  open an Enable review. Both reviews name every affected harness, distinguish
  Native Disable from Suspended Disable, and remain scrollable before execution.
- Keep Disabled Storage separate from Trash. Disabled items do not expire and
  the Disabled view offers no purge action.
- Lead Removal Plan review with a plain-language outcome, affected capabilities,
  actions, warnings, blocks, recovery behavior, and verification summary. Keep
  exact commands and internal records available through an explicit technical
  details view, and keep long reviews scrollable within the terminal.

Selecting a Logical Skill means making that identity unavailable across all selected installations. Selecting one Installation limits removal to that occurrence.

## 8. Adapters

### 8.1 Model

Adapters are declarative JSONC files validated against a versioned JSON Schema. They may be built into the package or explicitly loaded from a local file. HTTPS and other remote adapter sources are not supported in v1.

An adapter may declare:

- Adapter ID and schema version
- Supported operating systems
- Tool and executable probes
- Discovery roots and recognized manifests
- Inventory extraction and metadata mappings
- Ownership and grouping rules
- Hard-dependency declarations
- Managed removal actions
- Native enable and disable actions when the harness exposes a safe declarative
  lifecycle control
- Ephemeral package runner actions
- Verification rules

Commands are represented as an executable plus an argument array with optional operating-system variants. Shell command strings, pipes, redirection, and implicit shell interpolation are forbidden.

### 8.2 Trust

Built-in adapters are trusted as package content. A local adapter that can invoke commands requires approval for its exact content hash. A changed file requires renewed approval.

Read-only adapters that only describe roots and parse files may be used without command-execution approval, subject to schema validation.

### 8.3 Initial built-in adapters

The first release supports:

1. Generic Agent Skills directories and links
2. Vercel `npx skills`
3. Claude Code plugins
4. Codex plugins
5. Gemini CLI standalone skills and extensions

The generic fallback remains available when no adapter claims ownership.

## 9. Removal planning

Every mutation starts with a Removal Plan built from a fresh inventory.

The plan contains:

- Selected targets and resolved ownership boundaries
- Actions in dependency order
- Files, links, manager records, and plugins affected
- Hard dependencies and soft references
- Git-protected and system-owned blocks
- Whether an action may download an ephemeral package
- Expected verification checks
- Fallback availability

Hard dependencies block removal by default. Soft references warn but do not block. An explicit force override may bypass dependency and ambiguity safeguards, but never Git protection, operating-system permissions, system-skill protection, or adapter package trust.

### 9.1 Plugin boundaries

A plugin-owned skill may be removed independently only when the owning plugin or adapter declares that its skills are independently selectable. Otherwise the skill is blocked as an individual target. The containing Plugin remains visible with its harness and owned Skills, and a non-default Plugin boundary may be selected explicitly from the Inventory TUI or CLI.

Removing a Plugin must show all owned skills, agents, commands, hooks, configuration, and other known resources. Ordinary `--all` removal excludes plugins; including them requires an explicit `--include-plugins` choice. A runtime-default Plugin supplied by an agent harness is never removable, including when explicitly targeted or forced.

A non-default Plugin may be disabled or enabled only as one complete Plugin
boundary through a supported harness-native control. The Plugin and every owned
Skill or resource remain installed and change availability together. Plugin
availability never displaces content into Disabled Storage, and Plugin-owned
Skills remain nonselectable as individual Availability Targets. Runtime-default,
managed-policy, unsupported, unresolved, malformed, ambiguous, protected,
read-only, stale, or raced Plugin controls fail closed and cannot be forced.
Removal and availability protections are evaluated independently.

### 9.2 Project protection

For every path inside a Git worktree, the planner asks Git whether the path is ignored. If Git does not classify it as ignored, the path is Git-protected and no Lampwright action may mutate it. This invariant is not bypassed by force.

### 9.3 Availability planning

Every disable or enable mutation starts with an Availability Plan built from a
fresh Inventory and the current Disabled Storage entries. A disable target
expands to every represented Harness Exposure. The plan succeeds only when the
selected capability will be unavailable across all of those exposures; a
partial result must not be presented as fully disabled.

Codex path-based skill configuration, Claude Code skill overrides, and Gemini
CLI disabled-skill settings are the initial Skill Native Disable controls.
Codex Plugin settings, Claude Code enabled-Plugin settings, and Gemini extension
enablement rules are the initial whole-Plugin Native Disable controls. A
name-based Skill control is blocked when it could affect another Skill Identity
with the same harness-visible name. Plugin-owned and System Skills are never
individually disabled by Lampwright.

Inventory represents runtime status separately from native-control support and
materializes the exact, fail-closed configuration evidence defined in
[Native availability controls](./availability-controls.md). Planning and
Execution must not infer additional harness configuration conventions.

When any exposure lacks a safe native control, Planning may choose one
Suspended Disable for the complete Installation artifact set. An independently
filesystem-owned Installation contributes its one artifact. An explicitly
supported Manager-owned Installation contributes its primary location and every
declared supplemental discovery artifact while its Manager record remains
unchanged. The set must be complete, active, writable, outside Git protection,
free of path overlap, and outside Plugin or System ownership. Hard Dependencies
block disabling by default. Force may override dependency or ambiguity
safeguards, but never ownership, completeness, Git, System Skill, filesystem,
integrity, collision, or configuration-protection blocks. A Manager-created
replacement at a displaced path is an Enable conflict and is never overwritten.

## 10. Removal execution

### 10.1 Managed removal

If an Owner and its lifecycle operation are available, Lampwright uses Managed Removal. A manager executable already present on the machine may be invoked directly.

An adapter may request ephemeral execution through an existing package runner when:

- The adapter pins an exact package and version.
- The plan discloses that the package may be downloaded into the runner's cache.
- The user approves the package, version, runner, and adapter hash on first use.
- No project manifest, lock file, or global tool installation is modified by acquiring the package.

### 10.2 Failed managed removal

If Managed Removal fails, Lampwright stops actions that depend on it, reports the failure, and rescans the affected target. Brute-force Removal may then be offered as a second, separately confirmed action. Lampwright must never silently fall back.

### 10.3 Brute-force removal

Brute-force Removal may clean removable files, links, and declaratively supported manager records even when the Owner cannot execute. The plan must identify any manager state it cannot reconcile.

Filesystem artifacts are moved into Quarantine rather than permanently deleted. Brute-force behavior must remain inside known or explicitly supplied roots and must honor all Git and system protections.

### 10.4 Batch behavior

Execution follows dependency order. A failed action blocks its dependents but independent actions continue. The final result reports removed, unchanged, partially removed, blocked, and unresolved targets. A final rescan verifies outcomes.

### 10.5 Disable and enable execution

Availability execution accepts only the native configuration mutations or
Suspended Disable paths contained in an approved fresh plan. Native mutations
validate exact configuration preimages and preserve unrelated settings.
Suspension and re-enablement use Disabled Storage rather than Quarantine.
Enabling never overwrites an occupied or changed destination. A final rescan
and Disabled Storage listing verify every affected exposure and report blocked,
partial, failed, unchanged, disabled, or enabled outcomes honestly.

## 11. Quarantine and local state

Read-only scans, TUI browsing, and dry runs create no files.

Persistent state is created lazily only for:

- Local adapter trust decisions
- Ephemeral package trust decisions
- Removal audit records
- Quarantine manifests and content
- Disabled Storage manifests and suspended content
- Optional rebuildable search cache

State follows one canonical application identifier and supports an explicit
directory override. macOS and Linux use `$XDG_STATE_HOME/lampwright` when that
variable is an absolute path and otherwise use `~/.local/state/lampwright`.
Windows uses `%LOCALAPPDATA%\\lampwright`, then `%APPDATA%\\lampwright`, then
`~/AppData/Local/lampwright`. Transaction, recovery, and claim filenames use
the `.lampwright-` prefix.

Quarantine entries record original path, link information, content hash, ownership evidence, adapter, removal time, and restoration metadata. Entries are retained for 30 days by default and may be restored or purged explicitly. Automatic expiry may remove entries during a later mutating Lampwright run, never during read-only use.

Restoration must not overwrite an occupied destination without an explicit conflict decision. Managed uninstalls are logged but are not represented as automatically reversible unless the Owner itself supports restoration.

Disabled Storage is a separate, non-expiring lifecycle store. It records every
original Artifact Location and integrity value in one suspended set, affected
Harness Exposures, Skill identity and ownership evidence, disable time, and
exact re-enablement metadata.
It has no retention purge and never appears in Trash. Native disabled state
remains live harness evidence and is not copied into Disabled Storage.

## 12. Command-line interface

The intended minimal command surface is:

```console
lampwright                  # interactive fuzzy-search UI
lampwright scan             # print inventory
lampwright disable <target> # disable selected target(s) without removal
lampwright enable <target>  # enable native or suspended target(s)
lampwright remove <target>  # plan and remove selected target(s)
lampwright restore <entry>  # restore quarantined artifacts
lampwright purge <entry>    # permanently delete quarantine entries
```

Shared automation options include:

- `--json` for structured output
- `--dry-run` for a complete non-mutating plan
- `--yes` to accept ordinary confirmations
- `--force` to override removable safety blocks such as dependencies or ambiguity
- `--adapter <path>` to load a local adapter

The exact target-selector syntax will be finalized with the core inventory model. Interactive and non-interactive paths must call the same planners, executors, and Disabled Storage module.

## 13. Cross-platform requirements

- Use platform path APIs; never construct paths with hard-coded separators.
- Recognize directories, symbolic links, Windows junctions, and broken links.
- Avoid shell-specific behavior in the core and adapters.
- Resolve user configuration, state, and cache locations according to operating-system conventions.
- Tests must use temporary homes and workspaces; they must not inspect or mutate the developer's real skill installations.
- CI must exercise supported Node versions across macOS, Linux, and Windows.

## 14. Privacy and network behavior

Lampwright has no telemetry. Inventory, paths, skill metadata, and search queries remain local.

Network access is not required for scanning, search, planning, quarantine, restoration, or local adapters. An explicitly approved ephemeral package runner may access the network as described in its plan.

## 15. MVP acceptance criteria

The v1 MVP is complete when:

1. A published package can run through `npx` on macOS, Linux, and Windows.
   Before publication, the built executable is run from a trusted checkout;
   publication and `npx` verification require separate explicit approval.
2. A zero-footprint scan inventories generic, Vercel, Claude Code, Codex, and Gemini skill installations from isolated fixtures.
3. The TUI provides additive, name-only regular-expression search and can
   select Logical Skills, declared Installation Groups, and non-default Plugin
   boundaries. Plugin rows show their owning harnesses, owned Skill names, and
   other resource impact; runtime-default Plugins remain protected. The
   non-interactive CLI additionally accepts an individual Installation target;
   exposing individual paths in the TUI remains future prototyping work.
4. The planner reports ownership, dependencies, plugin impact, Git protection, and exact actions.
5. Supported managers/plugins are used for removal when available.
6. Failed managed removal never silently triggers fallback.
7. Brute-force removal quarantines artifacts and can restore them.
8. Non-ignored Git worktree files and System Skills cannot be mutated, including with force.
9. Local JSONC adapters can extend discovery and removal without changing application code.
10. Non-interactive scan, disable, enable, dry-run, remove, restore, and purge workflows produce stable JSON.
11. A final rescan verifies and reports the result of every removal.
12. Tests demonstrate that unrelated installations, plugin resources, and project files remain untouched.
13. Native and suspended disable operations can be enabled again without
    deleting Skill content. Complete explicitly supported Manager-owned artifact
    sets may be suspended without changing Manager records, while System,
    Plugin-owned, incomplete, ambiguous-name, and Git-protected cases remain
    untouched.

## 16. Delivery sequence

Implementation should proceed in dependency-ordered slices:

1. Package and cross-platform test foundation
2. Domain types, inventory, identity, and protection model
3. Generic discovery and Git protection
4. Adapter schema, loader, and trust
5. Removal planner and dependency graph
6. Quarantine, executor, and verification
7. Built-in adapters developed in parallel
8. Terminal UI and non-interactive CLI developed against the same application services
9. Cross-platform hardening, documentation, and npm release readiness

The GitHub issue tracker is the authoritative execution backlog.

The implementation seams and parallel work boundaries are defined in [Module design](./module-design.md).
