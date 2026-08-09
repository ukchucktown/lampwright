# Reversible Skill availability

Disable makes a Skill unavailable without removing its identity or intentionally
deleting its content. Enable reverses that lifecycle change. Both commands use a
fresh Inventory, current Disabled Storage entries, an Availability Plan, explicit
confirmation, Availability Execution, and final verification.

## Recognizing every state

| State | Where it is recorded | What Enable does | Operator recovery |
| --- | --- | --- | --- |
| Enabled | Live `HarnessExposure.status` | Nothing; the target is already available | Rescan if the harness disagrees with Inventory. |
| Native disabled | The applicable Codex, Claude Code, or Gemini configuration document | Applies an exact preimage-checked configuration mutation | Resolve a reported configuration race or protection, rescan, review a new Enable plan, and confirm it. |
| Suspended | One non-expiring Disabled Storage entry containing every original path, integrity value, identity, ownership, Harness Exposure, and operation provenance | Restores the complete stored artifact set to its exact original paths without overwrite | Remove or relocate unrelated destination collisions; never edit the manifest or payloads. Run Enable again with `disabled-entry:<id>`. |
| Partially disabled | Different Harness Exposures have different live states | Plans every required exposure change; success requires every check | Read per-target and per-check report concerns, repair only the named harness/configuration, then replan. |
| Unresolved | Inventory could not prove an effective control or safe filesystem operation | Fails closed | Repair malformed, linked, hard-linked, unreadable, trust-unresolved, or protected evidence and rescan. |

Native disabled state never creates a Disabled Storage entry. Suspended content
never enters Trash, never expires, and has no purge action. A Disabled entry is
consumed only after exact restoration succeeds or recovery proves the exact
completed publication.

## Native controls

- **Codex** writes an ordered exact-path `skills.config` rule to user
  `config.toml`. The last matching rule is effective. CRLF and unrelated TOML
  content are preserved.
- **Claude Code** writes the highest-precedence safe writable
  `skillOverrides` layer: local workspace before user. Shared workspace settings
  are evidence, not a Lampwright mutation target. Name collisions across visible
  Skill identities block absolutely.
- **Gemini CLI** changes exact case-sensitive membership in `skills.disabled`.
  Enable removes the name from every applied layer that currently disables it.
  Workspace settings apply only when durable folder-trust evidence says they do.

Every native action groups all changes to one document behind one preimage.
Malformed documents, duplicate keys, links, hard links, read races, replacement
races, filesystem restrictions, and non-ignored Git paths fail closed. Unrelated
keys, comments, arrays, Skills, and configuration layers remain unchanged.

## Suspended lifecycle

Suspension is eligible when any represented Harness Exposure has no safe native
control and Planning can authorize the complete Installation artifact set. A
filesystem-owned Installation supplies one artifact. An explicitly supported
Manager-owned Installation supplies its primary location plus every declared
supplemental discovery artifact; the Manager record is preserved and no Manager
command runs. Plugin, agent-runtime/System, Git-protected, read-only,
incomplete, unsafe-state, duplicate, ancestor, and descendant paths are absolute
blocks; `--force` cannot bypass them.

One Disabled entry owns the complete set. Known destination collisions block
Enable before any publication. A race after mutation begins is reported as
partial, retains the Disabled payloads for recovery, and never overwrites an
unclaimed path. Running a Manager while its Skill is suspended may recreate a
declared path; Inventory and Enable surface that replacement as a conflict.

Disabled Storage copies and verifies every artifact before moving each source to
a same-directory pending name and committing the set as one entry. This avoids
cross-device rename assumptions: state-volume transfers are verified copies,
while renames stay within one directory or state volume. Files, directories,
symbolic links, Windows junctions, and broken links retain their artifact type
and link target without following unexpected targets. Case collisions follow
the host filesystem and are always treated as occupied rather than overwritten.

Mutation journals support stable retry after interruption. Recovery validates
every path, entry identity, integrity digest, and directory claim. It can roll
back an interrupted suspension, resume only a claimed partial directory, or
finalize an exact completed publication. Forged journals and unclaimed partial
destinations cannot redirect cleanup outside Disabled Storage.

## Plans, reports, and recovery procedure

1. Run `lampwright scan --json` when live state is uncertain.
2. Use an exact Availability selector. Disable accepts `installation:`,
   `logical-skill:`, or `group:`. Enable also accepts
   `disabled-entry:<opaque-id>`.
3. Review the plan or use `--dry-run --json`. A dry run creates no Lampwright state.
4. Resolve absolute blocks at their source. Use `--force` only for a plan that
   marks dependency risk overridable.
5. Confirm once. Execution performs its own fresh scan/list/replan before any
   write, then validates live protection and preimages again.
6. Read the final target, action, and verification results. A final rescan error
   is reported as partial/failed with `finalInventoryId: null`; it never claims
   verification.
7. After a collision, integrity failure, stale plan, or race, leave stored
   content untouched, repair the external condition, rescan, and create a new
   plan. Do not edit audit records, Disabled manifests, or payloads.

Availability report target statuses are `disabled`, `enabled`, `unchanged`,
`partial`, `failed`, or `blocked`. Action statuses are `succeeded`, `unchanged`,
`failed`, `blocked`, or `skipped`; checks are `passed`, `failed`, or `skipped`.
The top-level status is `succeeded`, `partial`, `failed`, or `blocked`.

## CLI, TUI, and public values

CLI JSON uses the version-1 envelopes in
[`schemas/cli-v1.schema.json`](../schemas/cli-v1.schema.json):
`availability-plan`, shared `confirmation-required` with operation
`disable | enable`, and `availability-report`.
Reports expose Disabled entry IDs created by Suspended Disable so they can be
used verbatim in a later Enable selector.

The TUI presents `Inventory | Disabled (N) | Trash (N)`. Inventory can open a
Disable review with `d`; Disabled can open an Enable review with `e`. Reviews
name Native versus Suspended actions, Skills, harnesses, storage/restoration,
warnings, and blocks. Execution shows approved target/action counts. Reports
show readable partial concerns; `d` reveals exact targets, paths, formats,
preimage hashes, entry/action/effect/check IDs, timestamps, and raw errors.
Returning from an Availability report refreshes Inventory and Disabled rather
than presenting pre-mutation state.

Public TypeScript exports include `AvailabilityIntent`, `AvailabilityTarget`,
`AvailabilityPlan`, `AvailabilityAction`, `AvailabilityReport`,
`DisabledEntry`, `DisabledStorageModule`, `planAvailability`, and the
Availability execution method. Presentation callers receive plans and reports
as values; only injected Inventory, Planning, Execution, and Disabled Storage
interfaces inspect or mutate external state.

See also [native control evidence](./availability-controls.md),
[planning](./planning.md), [execution](./execution.md),
[Disabled Storage](./disabled-storage.md), [CLI](./cli.md), and
[TUI](./tui.md).
