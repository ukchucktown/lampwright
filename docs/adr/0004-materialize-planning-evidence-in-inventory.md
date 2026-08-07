# Materialize planner-ready evidence in Inventory

The Planning module retains the accepted pure interface
`plan(inventory, intent): RemovalPlan`. Adapter definitions and catalogs are
not a third planner input and Planning does not interpret adapter templates.

Inventory instead materializes the immutable facts Planning needs after
adapter discovery and probes have been resolved: available Owner operations,
their resolved invocation, protected remove-path and modify-path effects,
concrete verification checks, exact package execution and trust status,
fallback and declarative record cleanup evidence, and Plugin ownership
boundaries with known collateral. A Plugin boundary has a scan-unique ID rooted
in its physical declared root; its tool-supplied Plugin ID remains separate
because the same Plugin may exist in user and workspace scope. Generic
discovery supplies explicit filesystem fallback evidence and represents the
physical declared Plugin root even when it contains no Skills, so the complete
root remains the recoverable fallback boundary where no Adapter adds stronger
facts.

This keeps adapter interpretation and live probing in Inventory, makes plans
deterministic functions of one snapshot plus intent, and leaves Execution with
a self-contained value rather than a hidden Adapter-catalog lookup. Direct
managed operations carry an executable and argument array. Ephemeral operations
remain a distinct package-runner invocation with an exact package tuple and
package arguments, so Execution constructs the approved acquisition envelope
instead of accepting arbitrary runner flags. Adding an Adapter cannot change
Planning's interface or bypass its central dependency and protection rules.
V1 closes that envelope to `npx`, validates npm package identifiers and exact
Semantic Versions, and keeps direct commands as a separate invocation variant.

Declarative record cleanup carries the document format, fully resolved RFC 6901
record pointer, expected file and record SHA-256 digests, Adapter provenance,
and protection evidence. Adapter verification rules are likewise materialized
as concrete path, record, Owner-state, or structured-command checks. Planning
copies those values into actions and checks without interpreting templates.
Multiple removals from one document are grouped into one action so its original
file digest is checked once before any record is changed. Grouping is global to
the plan and uses normalized cross-platform physical paths. The action names
every affected target and Installation and preserves their combined approvals
and prerequisites; Inventory rejects inconsistent evidence for a shared
document and rejects one physical selector claimed by multiple removal owners.
A pathless Plugin resource must name the exact cleanup representing it. If
Hard-Dependency-related participants would share an atomic cleanup document,
Planning blocks every participant because no ordering can preserve the failure
boundary through that single mutation.
Exactly one Plugin boundary and one owned independently selectable child may
claim identical cleanup selector and hash evidence for alternate plans. The
model validates that exact two-claim set; sibling or additional claims and
inconsistent hashes remain invalid. If a Quarantine path contains a cleanup
document, Planning blocks both every cleanup participant and every covering
Quarantine target before creating actions; moving the ancestor and then editing
the file would be an internally contradictory plan. Containment uses canonical
physical paths only for real directories. Link and junction targets are not
followed because quarantining a link does not remove its target.

`Inventory.id` is a semantic fingerprint of the complete normalized evidence
and excludes `scannedAt`. A fresh unchanged scan therefore has the same ID,
while a change to ownership, protection, removal, dependency, or other evidence
changes it. `RemovalPlan` also preserves normalized intent. Execution can
fresh-scan and replan that intent, compare semantic plan identity, and reject a
stale plan without reconstructing intent from presentation state. Execution
must also compare the normalized actions, blocks, warnings, and checks from the
fresh plan (excluding only `createdAt`) rather than trusting a caller-supplied
plan ID, so altered executable behavior is rejected as forged.

Managed effects and path-backed Plugin collateral carry the same protection
evidence as Installations. Planning can therefore block protected indirect
effects and can quarantine every represented fallback path. A Plugin fallback
with non-filesystem collateral is blocked unless that collateral gains an
explicit declarative representation; an optimistic fallback flag alone is not
deletion authority.
An available Plugin fallback with no Installation, path-backed collateral, or
record cleanup is also blocked rather than represented as an empty success.

Forced dependency cycles are condensed only for graph analysis. Planning emits
lexically sequenced action dependencies inside each component and materializes
every incoming and outgoing component edge in `dependsOn`, so Execution does
not need hidden graph knowledge to preserve the planned order. The lexical
chain replaces rather than supplements original intra-component back-edges.
