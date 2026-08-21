# Owner-managed Update

Status: Accepted product direction

This specification defines targeted Update for capabilities that already exist
in Inventory. Update asks the current Owner to refresh an existing lifecycle
boundary. Lampwright does not install a new capability, synchronize arbitrary
files, or replace Update with Remove followed by Install.

## Outcome

A user can select one existing target and request its newest revision under the
recorded source, ref, Scope, and Owner policy. Lampwright reviews the exact
Owner operation before execution. Lampwright then verifies the local result
with a fresh Inventory.

The first vertical slice supports Vercel Manager-owned Skills. Later slices add
complete Claude Code Plugin and Gemini extension boundaries through the same
Update interfaces.

## Terms

An **Update Target** is one selected Logical Skill, Installation, Installation
Group, or complete Plugin boundary.

A **Managed Update** is an Update that the current Owner performs through its
supported lifecycle operation.

An **Update Plan** is the complete review value for one Update intent. The plan
contains the resolved targets, actions, declared effects, approvals, warnings,
blocks, and verification checks.

Update preserves the lifecycle identity of a target. The Owner MAY replace,
add, or remove resources inside that existing boundary. The Owner MUST NOT add
an independent Installation or Plugin outside that boundary.

## Product rules

1. Lampwright MUST use a supported Owner operation for Update.
2. Lampwright MUST NOT construct Update from filesystem replacement.
3. Lampwright MUST NOT construct Update from Remove followed by Install.
4. Lampwright MUST NOT offer a brute-force Update.
5. Lampwright MUST preserve the recorded source, ref, Scope, and Owner.
6. Lampwright MUST use a fresh Inventory before each mutation.
7. Lampwright MUST perform a final Inventory scan after an attempted mutation.
8. Lampwright MUST NOT contact a remote source during scan, browse, plan, or dry-run.
9. Lampwright MUST disclose network access before the Owner operation starts.
10. Lampwright MUST keep `--all` and remote update discovery outside the first version.

The newest revision means the newest revision that the recorded Owner policy
permits. It does not mean the newest branch, tag, release, or marketplace entry
that exists outside the recorded policy.

## Targets

### Installation

An Installation target limits Update to that physical occurrence. The Owner
operation must identify that occurrence without a name-only ambiguity.

### Logical Skill

A Logical Skill target expands to every represented Installation. Planning
blocks the complete target if any member lacks safe Update authority. This rule
prevents a planned version split across one Skill Identity.

Execution can still produce a partial result after an Owner failure. The report
must identify each Installation that changed and each Installation that did not
change.

### Installation Group

An Installation Group target expands to its exact declared members. Planning
blocks the complete target if any member lacks safe Update authority. Group
membership does not merge Skill identities.

### Plugin boundary

Lampwright updates a Plugin only as one complete Plugin boundary. Plugin-owned
Skills are not independent Update Targets. An updated Plugin can contain a
different set of owned Skills and resources, but the Plugin identity and Scope
must stay unchanged.

Runtime-default Plugins remain outside Update authority. Administrator policy
also blocks an Update when that policy does not grant an explicit Owner
operation.

## Availability state

A Native Disable does not remove installed content. Lampwright MAY update a
natively disabled Installation or Plugin when the Owner operation preserves
the disabled state. Final verification must confirm both the Update result and
the prior availability state.

A Suspended Disable displaces the active artifact set. Lampwright MUST block
Update for a suspended target. The user must Enable that target before Update.

## Inventory evidence

Inventory materializes all Update facts that Planning needs. An Installation
or Plugin boundary has Update evidence with these facts:

- The Adapter and the Owner operation identifier.
- The operation availability and its reason when unavailable.
- The exact direct or ephemeral-package invocation.
- The required working directory.
- The current local revision evidence, such as a version, a content hash, or an
  Owner record digest.
- The recorded source, ref, and Scope.
- The complete declared mutation roots and configuration paths.
- The network and download disclosure.
- The Adapter trust state.
- The concrete verification evidence.
- The local-change state when the Owner record can prove that state.

Inventory reports Update support. Inventory does not report that a remote
Update is available because an ordinary scan does not contact a remote source.

Version 1 Adapters remain valid and provide no Update authority. Adapter schema
version 2 adds explicit lifecycle operation types. The schema distinguishes a
removal operation from an Update operation and does not infer the operation
from an identifier or a command.

## Planning

The Planning module adds this interface:

```ts
planUpdate(inventory: Inventory, intent: UpdateIntent): UpdatePlan
```

The interface is pure. Planning consumes only materialized Inventory evidence.
Planning does not load an Adapter, invoke an Owner, inspect a remote source, or
probe the live machine.

An Update Plan contains:

- The normalized Update intent.
- The resolved Update Targets.
- The current revision evidence for each target.
- The recorded source, ref, Scope, and Owner.
- The exact structured Owner invocation.
- The declared mutation roots and configuration paths.
- The expected network and package download behavior.
- The Adapter and package trust requirements.
- The local-change warnings or blocks.
- The dependency and Plugin impact warnings.
- The verification checks.

Planning blocks Update in these cases:

- The target has no supported Owner operation.
- The Owner selector is ambiguous.
- A Logical Skill or Installation Group contains an unsupported member.
- The target is a Plugin-owned child Skill.
- The target is a System Skill or a runtime-default Plugin.
- The target is in Disabled Storage.
- A declared effect can change a Git-protected Artifact.
- A declared effect can change a read-only artifact.
- The Adapter or the ephemeral package lacks required trust.
- Inventory detects local changes that the Owner operation can overwrite.
- The Owner operation can create a known independent lifecycle boundary.
- The Update evidence is stale, incomplete, malformed, or unresolved.

`--force` MUST NOT override these blocks. The first version does not define an
override for local changes.

## Execution

The Execution module adds this interface:

```ts
execution.executeUpdate(
  plan: UpdatePlan,
  approvals: Approvals,
): Promise<UpdateReport>
```

Execution uses the approved plan as its complete mutation authority. Execution
fresh-scans and replans before it invokes an Owner. A difference in the fresh
plan rejects the stale request.

Execution invokes only the approved executable and argument array. Execution
does not use a shell. A direct invocation uses the approved exact directory or
a new isolated temporary directory. An ephemeral invocation uses the approved
exact package version and the Lampwright-owned package cache.

The Owner process can access the network when the plan discloses that behavior.
Lampwright sets its privacy environment values for the Owner process. Lampwright
does not claim that it can confine the Owner process with one portable network
or filesystem sandbox.

Execution stops dependent actions after a failure. Independent actions can
continue. Execution records the approved plan, the process result, the final
Inventory, and the Update Report in the audit log.

Update has no automatic rollback in the first version. Lampwright does not copy
the old content into Quarantine or Disabled Storage. A future Owner rollback
operation requires a separate specification.

## Verification and results

Final verification compares the approved pre-update evidence with a fresh
Inventory. Verification checks these properties:

- The same strong identity remains installed.
- The source, ref, Scope, and Owner stay unchanged.
- The target remains inside the approved lifecycle boundary.
- No new independent Installation or Plugin appears as a declared result of the
  selected operation.
- A prior Native Disable stays effective.
- The final revision or content evidence is readable and internally consistent.

An Update Report uses these target results:

- `updated`: The target keeps its lifecycle identity and its observable revision
  or content changes.
- `unchanged`: The Owner succeeds and the observable local evidence does not
  change.
- `partially-updated`: Some represented Installations update and others do not.
- `blocked`: Planning or approval prevents execution.
- `failed`: The Owner operation fails.
- `unresolved`: Execution cannot prove the final lifecycle state.

`unchanged` does not mean `up-to-date`. Lampwright can use that phrase only when
the Owner supplies verifiable evidence for the permitted remote revision.

## Initial Owner support

### Vercel Skills

The first vertical slice supports targeted Vercel Manager-owned Installations.
The Update operation uses the exact lock key and the recorded global or project
Scope. A project operation uses the recorded workspace as its exact directory.
A global operation uses an isolated temporary directory.

When an installed `skills` executable is not available, a global operation MAY
use the approved exact-version `npx` envelope. A project operation requires an
installed executable because the Manager derives project Scope from its current
directory.

The plan names every known artifact and Manager record that the operation can
change. The plan warns when Inventory cannot prove that the installed content
matches the Owner record. Proven local changes block Update.

### Claude Code Plugins

A later slice supports one complete, non-default Plugin boundary with
`claude plugin update`. The operation preserves the qualified Plugin identity
and its installation Scope. Known marketplace commands and dependency
installation must not create an unselected lifecycle boundary.

### Gemini extensions

A later slice supports one complete extension boundary with `gemini extensions
update`. Gemini standalone Skills remain unsupported because the current Owner
interface has no Skill Update operation.

### Codex Plugins and filesystem ownership

Codex Plugins remain unsupported until Codex provides an installed-Plugin
Update operation. A marketplace refresh does not update one installed Plugin.

Filesystem-owned Installations remain unsupported because Lampwright lacks an
Owner policy that defines a permitted revision and mutation boundary.

## Presentation

The CLI adds this command:

```console
lampwright update <target>
```

The command accepts the existing `--json`, `--dry-run`, `--yes`, and `--adapter`
options. The first version requires an explicit target and does not accept
`--all`.

The terminal UI adds an Update review for one selected target. The review shows
the current evidence, the Owner, the source policy, the affected boundary, the
network disclosure, the lack of automatic rollback, and the verification
summary. The terminal UI does not add an Updates view or a remote update badge.

The CLI and the terminal UI call the same Planning and Execution interfaces.
Neither presentation module invokes an Owner or interprets Update evidence.

## Stable output

The stable JSON schema adds Update Plan and Update Report envelopes. The schema
uses deterministic target, action, warning, block, approval, and verification
ordering. A dry-run returns a complete Update Plan and creates no local state.

## Acceptance criteria

1. A targeted Vercel Installation produces a complete offline Update Plan.
2. A managed Vercel Update preserves the source, ref, Scope, and strong identity.
3. A successful Owner command with changed content reports `updated`.
4. A successful Owner command with unchanged content reports `unchanged`.
5. Lampwright never describes `unchanged` as `up-to-date` without remote proof.
6. A failed Owner command produces no Update fallback.
7. A stale plan, forged invocation, or changed effect rejects execution.
8. Git-protected, System, suspended, ambiguous, and locally changed targets stay untouched.
9. A Logical Skill or Group with one unsupported member does not start a planned Update.
10. A natively disabled target stays disabled after Update.
11. The final rescan detects identity loss, scope change, and an unexpected lifecycle boundary.
12. The CLI and the terminal UI use the same Update Plan and Update Report values.
13. Isolated tests cover macOS, Linux, and Windows without access to real Skill installations.

## Non-goals

- Install a new Skill, Manager, Plugin, dependency, or agent runtime.
- Find remote updates during Inventory scan or dry-run.
- Add an Updates view or an update-available badge.
- Update every target with one `--all` intent.
- Synchronize an arbitrary filesystem-owned Skill with a remote source.
- Merge local changes with Owner content.
- Override detected local changes.
- Construct Update from Remove followed by Install.
- Provide automatic rollback or a snapshot store.
- Update a Plugin-owned child Skill independently.
- Publish a release or change repository visibility.
