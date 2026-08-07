# Core model

The core model is the shared, immutable value interface between Inventory,
Planning, Execution, and presentation modules. Import it from `skill-cleaner`.
Test-only fixture builders are available from `skill-cleaner/testing` and are
kept out of the production entry point.

The testing entry point publishes builders for Installation,
NonInstallationFinding, System Skill findings, Logical Skill, Inventory,
RemovalPlan, and ExecutionReport. Their recursive override types accept plain
string IDs at fixture boundaries; returned values still use the branded model
IDs and pass normal runtime validation.

## Boundary validation

Use the parser matching the external value being accepted:

```ts
import {
  parseExecutionReport,
  parseInstallation,
  parseInventory,
  parseLogicalSkill,
  parseNonInstallationFinding,
  parseRemovalPlan,
} from "skill-cleaner";
```

Each parser rejects unknown fields, malformed discriminated unions, unsupported
schema versions, invalid timestamps, and unsafe cross-record combinations. A
successful parse returns a recursively frozen value. A failure throws
`ModelValidationError`, whose `issues` contain serialization-safe paths and
messages without exposing the validation library.

## Inventory and identity

`Inventory` is a live scan result with scan-local IDs. It has three distinct
collections:

- `installations` contains active, removable skill placements.
- `otherFindings` contains source artifacts, cache or vendor artifacts, System
  Skills, and unknown findings that must not be treated as independently
  removable installations.
- `logicalSkills` groups installations only when every member shares the
  declared strong identity evidence.
- `identityHints` records shared names or hashes for display without merging
  Installation identities.
- `plugins` records ownership boundaries, owned Installation IDs, known
  collateral resources, and planner-ready removal evidence.
- `dependencies` stores Inventory-level relationships so hard dependencies and
  soft references can originate from either installations or other findings.

Names and content hashes are weak evidence. `LogicalSkill.identity` requires at
least one strong source, plugin, canonical-target, or package identity. Weak
evidence alone cannot create a Logical Skill.

Ownership, scope, artifact kind, Git protection, System Skill protection,
filesystem protection, and dependencies are discriminated unions. This keeps
callers from representing contradictory combinations such as a plugin resource
with filesystem ownership or a project skill outside workspace scope.

Each Installation has immutable `removal` evidence. It records an available or
unavailable managed operation, its concrete direct or ephemeral-package
invocation, Adapter trust, separately confirmed fallback availability, and
declarative record cleanup with exact document selectors and hashes. Managed
operations also carry protected expected remove-path and modify-path effects
and concrete Adapter verification rules. Inventory materializes these facts;
Planning never interprets Adapter templates or probes the machine.
`supplementalArtifacts` records additional exact paths owned by the same
Installation, such as manager-created agent links or copied installations.
Each carries its own protection evidence and is quarantined alongside the
primary location only in an explicitly confirmed brute-force plan.
`primaryArtifactPresent: false` distinguishes a manager record whose expected
primary path is already absent. It is valid only with exact record-cleanup
evidence, allowing a stale lock record to be cleaned without inventing a
Quarantine source.

An Installation owned by a Plugin carries a scan-unique `pluginBoundaryId`.
`PluginBoundary.id` is that physical ownership identity, while
`PluginBoundary.pluginId` is the external tool-supplied identifier. Plugin
Removal Targets use the boundary ID, so equal external IDs in user and
workspace roots never collapse. Path-backed Plugin collateral uses an Artifact
Location, including the `file` artifact kind, plus normal protection evidence.
Every pathless resource names the exact declarative cleanup that represents it;
an unresolved cleanup ID is invalid Inventory. Generic scanning represents the
physical declared root even when it contains no Skills.

## Plans and reports

`RemovalPlan` is a side-effect-free value. Actions are ordered; `dependsOn` may
only refer to an earlier action. Quarantine and declarative record cleanup
always require explicit brute-force confirmation. Managed removal and
brute-force actions cannot affect the same Installation in one plan, so
managed failure never silently activates fallback while heterogeneous Logical
Skills remain representable.
Non-overridable Git, System Skill, permission, and adapter-trust blocks cannot
have actions. Overridable dependency and ambiguity blocks require the matching
force approval.

The plan contains normalized intent in addition to resolved targets. This
preserves remove-all plugin inclusion and the managed-first or brute-force mode
for Execution's required fresh-scan/replan comparison. A scanner-generated
`Inventory.id` fingerprints all normalized evidence except `scannedAt`, making
plan identity stable across unchanged rescans and sensitive to evidence changes.

Actions identify the Installation IDs they affect even when their selected
target is a Logical Skill or Plugin; Plugin collateral actions may explicitly
use an empty affected-Installation list. Managed actions disclose their
resolved invocation and protected expected effects. Direct invocations are
structured executable/argument arrays and may carry an exact absolute working
directory or request a fresh isolated temporary working directory. Ephemeral invocation remains a distinct
exact package-runner envelope with package arguments. Record-cleanup actions
carry a document format, fully resolved RFC 6901 pointer, expected file and
record SHA-256 digests, Adapter provenance, and protection. All pointers for
one physical document are grouped across the complete plan in one atomic action
with every affected target and Installation ID, so its expected file digest is
checked only before the complete mutation. A physical document-and-pointer
selector may belong to only one Inventory removal-owner domain, preventing a
selected target from deleting state also claimed by an unselected owner. A
single Plugin boundary and exactly one owned independently selectable child may
carry identical evidence for alternate selection paths. The claim set must be
that exact pair with consistent hashes; sibling claims, additional claims,
unrelated Installations, and unrelated boundaries remain invalid.
Plugin-boundary, cleanup-conflict, and unavailable-managed-operation blocks are
non-overridable. Plugin impact warnings list all known collateral before a
Plugin action is approved.

Verification checks are executable values: target and path absence, exact
record absence, Owner state, or a structured command with accepted exit codes.
Every non-target check is bound to the exact action that authorized it. A check
must match verification evidence retained by its managed action, an exact
remove-path effect, a Quarantine location, or a record-cleanup selector. It is
skipped when that action did not complete successfully. Record cleanup
checks also carry the removed record's exact hash so array index compaction
cannot make an unrelated shifted record fail verification, while a changed
object property still fails. No verification
requires Execution to recover an Adapter definition by ID.

Ephemeral package execution accepts exact Semantic Version values, including
prerelease and build metadata. The v1 runner is the closed `npx` strategy and
package names must be valid exact npm package identifiers. Alternate runners,
mutable tags, embedded versions, and version ranges are rejected at the model
boundary before package trust can be approved. Package approval repeats the
exact runner, package, version, and Adapter hash tuple.
Generic direct commands and command verifications reject known package-runner
executables, including Windows launcher suffixes, so they cannot bypass this
typed route.

`ExecutionApprovals.grants` contains exact approval values and rejects duplicate
grants. Force, Adapter trust, and package trust are separate variants, so force
cannot be interpreted as new trust.

`ExecutionReport` records action, target, and verification outcomes. It keeps
the planned `inventoryId`, a nullable final rescan `finalInventoryId`, a typed
`rescanError`, and complete offerable `fallbackPlans`. A failed post-mutation
rescan is reported and audited rather than thrown, and cannot claim verification
or fallback. Every fallback must use the final Inventory and a separately
confirmed `brute-force` intent. Result IDs must be unique, completion timestamps
cannot precede start timestamps, and the top-level status must agree with the
contained failures, blocks, or incomplete outcomes. Target outcomes include an
explicit `failed` state. A blocked action may name a prior failed, blocked, or
skipped prerequisite.

## Deterministic JSON

`toDeterministicJson(value)` recursively orders object keys while preserving
array order. `stringifyModel(value, indentation)` returns deterministic JSON and
rejects non-JSON values, non-finite numbers, and class instances. Model schema
version `1` is represented explicitly on Inventory, RemovalPlan, and
ExecutionReport.
