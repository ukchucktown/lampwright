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
11. Lampwright MUST NOT let an Update add the target to an agent harness that did not have it.

Rule 3 forbids an Update that Lampwright builds from two Owner operations,
where the first operation removes the target. It does not forbid one Owner
operation that installs a new revision of a target that is installed. In such
an operation, the Owner keeps its record of the target and replaces the content
in place.

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

### Normalized Inventory state

Each Installation and Plugin boundary contains one closed `UpdateEvidence`
value. The value has one of these states:

- `managed`: Inventory contains the complete Owner operation.
- `unsupported`: The target has no supported Owner Update operation.
- `unresolved`: Inventory cannot prove a complete and safe Owner operation.

The `unsupported` and `unresolved` states contain a reason and no mutation
authority. The `managed` state contains these values:

- The Adapter, the Owner, the operation ID, and the exact Owner selector.
- The operation availability and the Adapter trust state.
- The exact invocation and the required working directory.
- The recorded source, ref, Scope, and Owner record digest.
- One or more current revision values.
- The complete effect set with existence and protection evidence for each path.
- The network and package download disclosures.
- The closed local-change state.
- The concrete verification values.

A current revision value is an Owner-record primitive or a content hash with
its exact path. A primitive value also contains the exact record pointer and
document path. Inventory keeps all declared revision values in deterministic
order. Inventory does not select one value as more authoritative than another
value.

The local-change state is `unchanged`, `changed`, or `unavailable`. The first
two states contain the expected and actual SHA-256 values. The `unavailable`
state contains the Adapter reason and does not claim that the content matches.

Every declared effect contains Git, System, and filesystem protection evidence.
An absent path also contains an `exists: false` value. Inventory derives the
filesystem evidence from the nearest safe parent of an absent path.

Plugin-owned child Installations always contain an `unsupported` state.
Lampwright can put Update authority only on the complete Plugin boundary.

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
  or content changes for at least one represented Installation. Every Owner
  action succeeds, and every final verification passes. Other represented
  Installations can remain unchanged.
- `unchanged`: The Owner succeeds and the observable local evidence does not
  change for any represented Installation. Every final verification passes.
- `partially-updated`: At least one represented Installation changes, but
  another action fails, is skipped, or is blocked, or another final
  verification fails.
- `blocked`: Planning or approval prevents execution.
- `failed`: The Owner operation fails.
- `unresolved`: Execution cannot prove the final lifecycle state.

`unchanged` does not mean `up-to-date`. Lampwright can use that phrase only when
the Owner supplies verifiable evidence for the permitted remote revision.

Human reports for targets with more than one represented Installation show the
number updated and the number unchanged. This count does not add a status or
change the stable Update Report schema.

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
change. The plan also names each bounded agent path that the nested Manager
operation can create. Each absent path includes `exists: false` and protection
evidence from its nearest existing parent. Final presence checks apply only to
artifacts that existed before Update. The plan warns when Inventory cannot
prove that the installed content matches the Owner record. Proven local changes
block Update.

An Update does not add the Skill to an agent harness. The Manager has two
commands that install the newest permitted revision of a Skill that is
installed, and Lampwright selects one of them for each target.

The `add` command has an `--agent` option. When the option names agents, the
Manager uses that list and does not detect agents. Lampwright names each agent
that has the Skill and no other agent:

```text
skills add <source> --skill <lock key> --agent <agent>... [--global] [--copy] --yes
```

- `<source>` is the recorded source, with the folder of the Skill and the
  recorded ref, in the form that the `update` command of the Manager gives to
  its own installer. An example is `owner/repository/skills/name#ref`. When
  the Manager cannot add a folder to the source, as for an SSH address,
  `<source>` is the recorded source and the ref.
- `--global` is present for the global Scope. For the project Scope, the option
  is absent and the command runs in the recorded workspace.
- `--copy` is present when the lock records the `copy` install mode.

The Manager writes the same source, ref, and Skill path to the lock again. It
installs the Skill also when the source has no new revision. The lock revision
and the content are then the same as before, and the result is `unchanged`.

Lampwright uses the `add` command only when each of these conditions is true:

- The recorded source type is `github`, or the lock records no source type.
- The lock key is the name of the Skill in the source. A lock record with a
  `skillName` field does not satisfy this condition.
- The Manager accepts each agent of the target by name. An Eve agent or an Eve
  subagent does not satisfy this condition.
- The source and the lock key are safe arguments, and neither starts with `-`.

For each other target, Lampwright uses the `update` command:

```text
skills update <lock key> --global|--project --yes
```

The `update` command has no option that selects agents. When it installs a new
version, it can create a link to the Skill in each agent directory that it uses
as a default target.

For the two commands, Lampwright records each declared mutation root that is
absent before the Owner command. This is the only correction for the `update`
command, and it is a safeguard for the `add` command. After the command, Lampwright removes each symbolic
link or junction that the Owner created at one of those paths. It then removes
each directory that the Owner created only to hold that link. The action result
gives the number of removed links in `removedAgentLinks`.

Lampwright removes links only. A file or a directory that the Owner creates at
one of those paths stays, because that content belongs to Quarantine and not to
Update. The final verification then reports that the Harness Exposure set
changed, and the target result is `unresolved`.

The version 1 declarative Vercel Adapter grants Managed Removal authority only.
Trusted package reconciliation code materializes Vercel Update authority
because conditional lock locations and a dynamic set of agent artifacts cannot
fit the declarative operation. The global ephemeral approval binds to the exact
Update arguments, package version, and effect policy that the package code
materializes. The approval does not reuse the version 1 Removal Adapter hash.

### Claude Code Plugins

Lampwright supports one complete, non-default Claude Code Plugin boundary with
`claude plugin update`. The exact arguments are `plugin update <qualified-id>
--scope <scope> --yes`. A user operation uses a new isolated directory. A
project or local operation uses the exact recorded workspace.

The Update operation preserves the qualified Plugin identity, Scope, settings,
and Native Disable state. Inventory corroborates the registry record with the
known-marketplace record and the bounded marketplace manifest. The plan names
the stable Plugin cache parent and each configuration path that the Owner can
change. A marketplace refresh is outside this action.

The plan contains opaque hashes and presence bits for the selected Plugin's
`enabledPlugins` and `pluginConfigs` records. It does not contain their values.
An npm source requires a valid npm package identifier and an exact semantic
version. Local specifiers, URLs, tags, and version ranges are blocked.

A command source grants no Update authority because Claude Code runs the
command through a platform shell. A declared Plugin dependency also blocks the
operation because Claude Code can install an independent Plugin. The network
warning states that Claude can fetch the Plugin source. The warning also states
that Claude can install package dependencies inside the new cache entry.

Final verification accepts a new version root inside the selected Plugin cache
boundary. The Plugin ID, the Scope, the source policy, the settings, and the
availability state must stay unchanged. The report names the prior and final
versions. The report also lists added and removed owned resources. A removed
owned Skill does not fail Plugin verification by itself.

### Gemini extensions

Lampwright supports one complete Gemini extension boundary with `gemini
extensions update <name>`. The operation uses the exact manifest name and a new
isolated directory. It never updates every extension.

The plan preserves the source, ref, install type, automatic Update policy,
prerelease policy, and Native Disable state. The effects contain the management
root and the exact enablement and integrity configuration paths. A linked source
path is not an effect. Git extensions include `HEAD` and dirty-state evidence.
GitHub release extensions include the recorded release tag. Local copies and
GitHub release copies do not claim proof of unchanged local content.

For a Git copy, the dirty-state check excludes only the root Owner metadata
file. It retains every other tracked or untracked change. Recorded `git@`, SSO,
`github:`, and `gitlab:` source forms remain structured source evidence. They
never become shell text.

Lampwright blocks linked, migrated, malformed, ambiguous, escaping, protected,
unsupported, and proven-dirty extension state. Final verification reports
version and owned-resource changes inside the stable extension boundary.
Gemini standalone Skills remain unsupported because the Owner has no standalone
Skill Update operation.

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

The command accepts `--json`, `--dry-run`, `--yes`, `--adapter`,
`--trust-adapter`, and `--trust-package`. The first version requires exactly one
explicit Installation, Logical Skill, Installation Group, or complete Plugin
selector. It does not accept `--all`, `--force`, `--brute-force`, or
`--include-plugins`.

Press `u` in the terminal UI to review Update for exactly one staged or focused
Inventory or Native Disable target. A fully staged Group is one target.
Suspended entries direct the operator to Enable first. Plugin child rows and
System Skills remain read-only. The review shows the current evidence, the
Owner, source policy, affected boundary, network disclosure, lack of automatic
rollback, and verification summary. The report shows every target status.
Escape runs a fresh Inventory scan, reads Disabled Storage, and returns to
Inventory with the result. The terminal UI does not add an Updates view, remote
check, or remote update badge.

The CLI and the terminal UI call the same Planning and Execution interfaces.
Neither presentation module invokes an Owner or interprets Update evidence.

## Stable output

The stable JSON schema adds `update-plan` and `update-report` envelopes. The schema
uses deterministic target, action, warning, block, approval, and verification
ordering. A dry-run returns a complete Update Plan and creates no local state.
An Update confirmation uses the existing `confirmation-required` envelope with
`operation: "update"`.

Target results map to CLI exit statuses as follows:

- `updated` and `unchanged` use `0`.
- `partially-updated`, `failed`, and `unresolved` use `1`.
- `blocked` uses `3`.
- Invalid command usage uses `2`.

## Acceptance criteria

1. A targeted Vercel Installation produces a complete offline Update Plan.
2. A managed Vercel Update preserves the source, ref, Scope, strong identity, and Harness Exposures.
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
14. A successful target with changed and unchanged Installations reports
    `updated` and shows both counts in human output.
15. `partially-updated` requires an action or verification that does not
    complete successfully after another Installation changes.

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
