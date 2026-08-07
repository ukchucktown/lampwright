# Removal planning

The Planning module exposes one side-effect-free interface:

```ts
plan(inventory: Inventory, intent: RemovalIntent): RemovalPlan
```

`RemovalIntent` either selects explicit Installation, Logical Skill, or Plugin
boundary targets, or requests remove-all. Ordinary remove-all includes Plugin
children only when their boundary declares them independently selectable. It
excludes nonselectable children and containing Plugin boundaries unless
`includePlugins` is true. `mode` is
`managed-first` for an ordinary plan or `brute-force` for a separately
requested fallback plan. `force` can override dependency and ambiguity blocks
only.

Planning resolves targets from the supplied Inventory, expands strong Logical
Skill groups and explicit Plugin boundaries, orders Hard Dependencies, reports
Soft References, chooses actions from planner-ready ownership evidence, and
returns expected verification checks. It performs no filesystem, process,
network, trust-store, clock, or other I/O.

## Determinism and target resolution

Plan timestamps come from `Inventory.scannedAt`. `Inventory.id` is a semantic
fingerprint of every normalized evidence collection except scan time, so an
unchanged fresh scan retains its identity while any safety-relevant evidence
change invalidates it. Target, block, warning, action, approval, and verification
ordering is deterministic and independent of caller selection order.

The plan preserves normalized intent for a later fresh-scan/replan check:
explicit targets are stored in canonical resolved order, while remove-all keeps
its `includePlugins` choice. Plan identity hashes that intent and the resolved
targets—not the caller's raw target array. Overlapping selections collapse when
a broader target completely owns the same installations and are rejected when
their ownership boundaries only partially overlap.

Freshness validation must compare the replanned actions, blocks, warnings, and
checks as well as semantic identity, excluding only `createdAt`. A supplied plan
ID is not trusted as a checksum for caller-modified actions.

A Logical Skill expands only to its declared strongly grouped Installation
IDs. Weak name or content-hash hints never expand a target. System Skills and
other non-installation findings are not Removal Targets and remove-all never
turns them into actions.

## Ownership and fallback

An available Owner operation produces Managed Removal. An unavailable Owner
operation yields a reviewable block and fallback availability; it never
silently becomes filesystem cleanup. A later, explicit `brute-force` intent
may produce Quarantine and declarative record-cleanup actions, each requiring
separate brute-force confirmation. Managed and brute-force actions cannot
affect the same Installation in one plan; a heterogeneous Logical Skill may
legitimately use Managed Removal for one Installation and Quarantine for a
different filesystem-owned Installation.

Managed operations disclose a complete invocation plus expected remove-path and
modify-path effects with Inventory-time protection evidence. Direct invocation
uses an executable and argument array and may pin an absolute working directory
or request a fresh isolated temporary directory. Ephemeral invocation is a separate
package-runner value containing an exact package tuple and only package
arguments; it is not an arbitrary runner command. Protected effects block the
entire target even with force. Successful remove-path effects receive
path-absent verification; modify-path effects are disclosed but are not
incorrectly verified as absent.

Brute-force planning treats every present primary Installation location and
every `supplementalArtifacts` entry as one removal unit. A stale manager record
may mark its expected primary path absent and proceed directly to exact record
cleanup. Planning checks every artifact's Git,
System Skill, and filesystem protection before creating actions, and emits one
Quarantine action per distinct physical artifact before the shared declarative
record cleanup. This lets an adapter remove all known copies and links without
duplicating them as false independent Installations.

Declarative record cleanup includes its format, fully resolved RFC 6901 record
pointer, expected file and record SHA-256 digests, Adapter provenance, and
protection. This gives Execution both precise mutation authority and
time-of-check evidence. Every cleanup for the same cross-platform physical path
becomes one plan-global atomic action with all affected targets, Installation
IDs, approvals, prerequisites, and record pointers. Inventory rejects
inconsistent Adapter, format, file-hash, or protection evidence for that shared
document. It also rejects one physical document-and-pointer selector claimed by
multiple removal owners, including owners outside the requested targets. The
original file digest is therefore checked once before the grouped mutation.
The resulting record-absent checks and all Adapter
path, record, Owner-state, and structured-command verifications are concrete
plan values; Execution does not reload Adapter templates.

Exactly one Plugin boundary and one of its owned independently selectable
children may expose identical selector and hash evidence as alternate
whole-Plugin or child plans. This is validated as a two-claim set rather than a
shared boundary-wide owner domain: sibling-child claims, a third boundary claim,
unrelated owners, and inconsistent record hashes are rejected.

Two participants related by a Hard Dependency cannot share one atomic cleanup
document without erasing the action failure boundary between them. Planning
emits a non-overridable `cleanup-conflict` block for every such participant
instead of authorizing any of their mutations.
Likewise, if an actionable Quarantine path contains or equals a planned cleanup
document, Planning blocks every cleanup participant and every covering
Quarantine target. Moving the ancestor first would make the later exact-record
mutation operate on a missing file, so neither contradictory mutation is
authorized. Real directory artifacts compare both their mutation paths and
canonical physical paths so aliases cannot hide containment. Symbolic links and
junctions use only mutation paths; quarantining a link never implies its
canonical target is removed.

Plugin children are independently targetable only when their Plugin boundary
declares that capability. Otherwise Planning emits a non-overridable boundary
block and identifies the containing Plugin target. Explicit Plugin removal
expands every owned Installation and lists known skills, agents, commands,
hooks, configuration, and other collateral in a Plugin impact warning.
Path-backed collateral is represented as an Artifact Location and enters
Quarantine during an explicit brute-force Plugin plan. Generic Inventory always
includes the physical declared root, including empty or otherwise non-Skill
roots, so nested child paths collapse into one recoverable root quarantine.
Non-filesystem collateral names the exact declarative cleanup that represents
it; a pathless resource without that association blocks fallback, so an
incomplete plan never claims target-unavailable verification. When brute-force
cleanup cannot reconcile an Owner's records, the warning carries the canonical
Owner value rather than a manager-only identifier.
An otherwise available Plugin fallback with no Installations, path-backed
resources, or associated cleanup effects is likewise blocked as unavailable;
an empty action list is not a successful removal plan.

## Dependencies, protection, and approval

If a selected capability depends on another selected target, the dependent's
actions run first. An installed dependent outside the selection blocks by
default. Dependency cycles also block by default. With force, Planning
topologically orders the strongly connected component graph, preserves every
acyclic edge entering or leaving a cycle, and uses lexical order only inside
the cyclic component. That lexical sequence and all component edges are encoded
in action `dependsOn` values, not merely the returned array order. Original
intra-component back-edges are omitted because the lexical chain replaces them;
all external component edges remain. Every affected action requires dependency
force.
Soft References are warnings only.

Git-protected paths, System Skill protection, read-only filesystem evidence,
Plugin boundary restrictions, unavailable required Owner operations, and
blocked Adapter trust never produce actions and cannot be bypassed by force.
Unknown ownership and unresolved metadata are ambiguity blocks; force may
permit recoverable cleanup with both ambiguity and brute-force approval.
Exact ephemeral package execution adds matching package-trust approval and a
possible-download warning. V1 accepts only the closed `npx` runner, a valid npm
package identifier, and an exact Semantic Version; direct commands remain a
separate invocation variant.
