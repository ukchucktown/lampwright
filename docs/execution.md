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

Cleaner-owned changes are closed over the plan:

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
system temporary directory with a cleaner-owned npm cache, so acquisition does
not operate from or add dependencies to the user's project. Every direct and
ephemeral Owner invocation receives cleaner-owned `DO_NOT_TRACK=1` and
`DISABLE_TELEMETRY=1` environment values; Adapters cannot override them.
Generic direct and verification commands reject `npx`, `npm`, `yarn`, `pnpm`,
`pnpx`, and `bunx` names, including case-insensitive Windows launcher suffixes,
so a package runner cannot bypass the exact ephemeral-package trust path.
When a direct invocation declares an exact working directory, Execution passes
that directory to the structured process runner. A direct invocation may
instead request a fresh operating-system temporary directory, which Execution
removes afterward. Both choices are part of the approved plan and freshness
comparison; neither is inferred from Execution's own process directory.
Ephemeral packages likewise run only from a fresh cleaner-owned temporary
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
property is not treated as absent. The report retains the planned
`inventoryId`, final rescan result, action results, target results, verification
results, and zero or more complete fallback plans. Target status distinguishes
`removed`, `unchanged`, `partially-removed`, `blocked`, `failed`, and
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
