# Removal execution

Execution consumes one immutable, approved `RemovalPlan` through the same deep
module used by future CLI and terminal UI callers:

```ts
const execution = createExecutionModule(options);
const report = await execution.execute(plan, { grants });
```

`grants` use the same discriminated values as plan approval requirements.
Confirmation, Brute-force confirmation, dependency/ambiguity force, exact
Adapter hash trust, and exact package tuple trust remain distinct. A force
grant never satisfies either trust requirement. Package trust may instead be
satisfied by the injected persistent trust store after its first exact grant.

## Freshness and mutation authority

Before any approval is consumed or mutation begins, Execution scans live
Inventory and replans the normalized intent. It compares the complete semantic
plan—including ID, Inventory ID, targets, actions, dependencies, effects,
blocks, warnings, approvals, and verification checks—while excluding only
`createdAt`. A changed or forged plan returns a blocked report and creates no
audit or trust state.

Lampwright-owned changes are closed over the plan:

- A Quarantine action passes its exact `ArtifactLocation` and Inventory-derived
  ownership subjects to the Quarantine module.
- A record action verifies the raw document hash and every deterministic record
  hash, captures the complete preimage in Quarantine, then edits only the
  planned RFC 6901 pointers through an open regular-file handle. Array entries
  are removed from highest index to lowest so earlier removals cannot retarget
  later pointers. Links,
  hard-linked documents, malformed documents, duplicate JSON keys, and races
  fail closed, and writes account for partial filesystem writes before the
  document is truncated and synchronized.
- Managed effects and direct mutation paths receive a fresh Git protection
  check immediately before use. Project protection cannot be bypassed by
  force.

Owner processes are the declared mutation boundary described by
[ADR 0005](./adr/0005-treat-owner-processes-as-declared-mutation-boundaries.md).
Commands are always structured executable/argument values and the production
runner sets `shell: false`. Exact-version `npx` runs from a fresh operating
system temporary directory with a Lampwright-owned npm cache, so acquisition does
not operate from or add dependencies to the user's project. Every direct and
ephemeral Owner invocation receives Lampwright-owned `DO_NOT_TRACK=1` and
`DISABLE_TELEMETRY=1` environment values; Adapters cannot override them.
Generic direct and verification commands reject `npx`, `npm`, `yarn`, `pnpm`,
`pnpx`, and `bunx` names, including case-insensitive Windows launcher suffixes,
so a package runner cannot bypass the exact ephemeral-package trust path.
When a direct invocation declares an exact working directory, Execution passes
that directory to the structured process runner. A direct invocation may
instead request a fresh operating-system temporary directory, which Execution
removes afterward. Both choices are part of the approved plan and freshness
comparison; neither is inferred from Execution's own process directory.
Ephemeral packages likewise run only from a fresh Lampwright-owned temporary
directory.

## Scheduling and fallback

The bounded scheduler starts only actions whose `dependsOn` results are
complete. Independent ready actions may run concurrently. A failed, blocked,
or unapproved action blocks its dependents while other branches continue.
Ready managed actions declaring the same `modify-path` resource are serialized
without turning that resource constraint into a failure dependency; this
prevents concurrent Owner processes from losing updates to a shared manifest.
Managed failure never dispatches Quarantine or record cleanup from the same
plan. After the final rescan, Execution asks Planning for a new `brute-force`
plan only when the failed action advertised fallback availability and the live
target remains offerable. Returned fallback plans therefore carry their own
Brute-force confirmation requirement.

## Verification, reports, and local state

Every non-stale execution attempts a live rescan. If it fails after an action
was attempted, Execution returns and audits a typed `rescanError`, leaves
`finalInventoryId` null, and does not claim verification or offer fallback.
Otherwise, concrete plan checks cover target, path, record, Owner-state, and
structured command absence. Each non-target check names its owning action and
is skipped unless that action completed successfully, so another target cannot
cause the check to run or inherit its result. Managed actions retain their
declared verification evidence, and validation requires each concrete check to
match that evidence or the action's exact declared effect. Record checks for
cleanup bind to the expected record hash, allowing array compaction without
mistaking a shifted unrelated value for the removed record; a changed object
property is not treated as absent. Successful Quarantine action details state
that content entered Trash and record its retention deadline. The report retains
the planned `inventoryId`, final rescan result, action results, target results,
verification results, and zero or more complete fallback plans. Target status
distinguishes `removed`, `unchanged`, `partially-removed`, `blocked`, `failed`, and
`unresolved`; top-level status distinguishes `succeeded`, `partial`, `failed`,
and `blocked`.

Each audit record contains the complete approved plan, granted approval values,
and resulting report, so a structured invocation and its outcome remain
reviewable without a separate plan registry. Audit and package-trust adapters use the shared operating-system local-state
root supplied by the application. Their directories are created lazily and
rejected if an existing state component is a link or non-directory. No audit
file is written when freshness fails, every action is unapproved/protected, or
the plan performs no mutation attempt. Package trust is stored as one
content-addressed file per exact runner/package/version/Adapter-hash tuple.

`ExecutionModuleOptions` keeps scanning, replanning, Quarantine, process
execution, Git inspection, audit writing, package trust, clock, and concurrency
behind injected seams. Tests can therefore prove scheduling and safety without
touching real installations or invoking real managers.

## Availability execution

The same module exposes reviewed reversible changes:

```ts
const report = await execution.executeAvailability(plan, { grants });
```

Availability Execution performs a fresh Inventory scan, lists Disabled
Storage, and calls the injected pure Availability planner before using an
approval or opening a mutation path. It compares the complete semantic plan,
excluding only `createdAt`; stale or caller-modified plans return `blocked`
without configuration, Disabled Storage, or audit writes.

For native controls, Execution verifies the exact regular, single-link file
preimage and immediately rechecks Git protection. It applies every grouped
selector mutation to one in-memory postimage and commits the document once.
Codex TOML receives an exact-path `skills.config` rule; Claude JSON changes the
exact `skillOverrides` member; Gemini JSONC changes exact membership in
`skills.disabled`. Existing comments and unrelated values are retained.
Existing line-ending style is retained, including CRLF Codex TOML documents.
Malformed or duplicate-key documents, links, hard links, occupied missing-file
paths, changed hashes, and replacement races fail closed. Suspended Disable and
Enable call only the Disabled Storage module; Execution never moves those
payloads itself.

Whole-Plugin native actions use the same preimage and live-protection boundary.
Codex changes the Plugin table's `enabled` value, Claude Code changes the exact
`enabledPlugins` member, and Gemini CLI changes the extension's ordered
user-scope enablement rules. Every owned Skill and resource remains installed;
Execution never turns a Plugin action into per-Skill edits or Disabled Storage.
Final verification evaluates the complete Plugin's observed enabled/disabled
state.

Actions run only after their `dependsOn` actions succeed or remain unchanged.
A failed branch blocks its dependents while independent branches continue.
Afterward, Execution rescans Inventory, relists Disabled Storage, and evaluates
every planned Harness Exposure and entry check. A multi-exposure target is
successful only if every check passes. Version-1 reports retain plan and
Inventory IDs, timestamps, final-scan errors, per-action results, per-target
`disabled | enabled | unchanged | partial | failed | blocked` status, and
per-check results; top-level status is `succeeded | partial | failed |
blocked`.

Availability audit records contain the approved plan, exact grants, and full
report. They are written lazily only when a native commit or Disabled Storage
operation is actually attempted. Freshness rejection, missing approval, and a
live protection failure therefore create no local state.

## Update execution

The same module executes an approved Update Plan:

```ts
const report = await execution.executeUpdate(plan, { grants });
```

Update Execution scans Inventory and calls the injected pure Update planner
before the first mutation. It compares the complete semantic plan and excludes
only `createdAt`. A stale plan, a forged command, a changed effect, or a changed
approval returns a blocked report without an Owner invocation or an audit
write.

Execution invokes only the structured command in the approved action. The
process runner never uses a shell. A direct operation uses the approved exact
directory or a new isolated directory. An ephemeral operation uses the exact
package version, a Lampwright-owned cache, and its approved exact or isolated
directory. Every Owner process receives the Lampwright privacy environment.

The scheduler continues independent actions after an Owner failure. It blocks
an action when one of its dependencies did not succeed. Update Execution does
not create a filesystem fallback, a Remove plan, a Quarantine entry, or a
Disabled Storage entry.

After an attempted action, Execution scans Inventory again. The final scan
must prove that the strong identity, source, ref, Scope, Owner, and availability
state did not change. The final operation must also retain every approved
verification locator. Execution runs only a structured verification command
from the approved plan, never a command from the final Inventory.

A new independent Installation or Plugin inside an approved mutation root
fails verification. Strong identity alone does not identify a selected
boundary. Execution also compares the location, source, ref, Scope, Owner, and
exact Owner selector. The selected complete Plugin boundary can contain changed
children. For other targets, a new Harness Exposure fails verification.

The report uses `updated` when every Owner action succeeds, every final
verification passes, and at least one represented local revision changes. It
uses `unchanged` when those actions and checks succeed and no represented
revision changes. A successful mix of changed and unchanged Installations is
therefore `updated`. Its human summary gives both counts. The value `unchanged`
does not claim that a remote source is current. The value
`partially-updated` requires a failed, skipped, or blocked action, or a failed
verification, after another Installation changes. Owner failures use `failed`,
approval and plan blocks use `blocked`, and an unproved final state uses
`unresolved`. A final scan failure cannot produce an `updated` result.

For a complete Plugin, the verification result compares the version and the
owned-resource keys. The result lists the prior version, the final version, and
the added or removed resources. A versioned cache-root change does not create a
new Plugin boundary. The Update can remove an owned Skill. Execution still
preserves the complete Plugin's availability and its opaque settings record
hashes and presence bits.

For a Gemini extension, Execution also preserves the install type, automatic
Update policy, and prerelease policy. It accepts changed owned resources inside
the same management boundary. It rejects a changed enablement record even when
the effective enabled or disabled state stays the same.

An Update audit record contains the approved plan, the exact grants, and the
complete report. Execution writes this record only after an Owner process
starts. Freshness rejection, a missing approval, and a live protection failure
create no Update audit state.
