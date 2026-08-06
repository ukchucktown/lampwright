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
- `dependencies` stores Inventory-level relationships so hard dependencies and
  soft references can originate from either installations or other findings.

Names and content hashes are weak evidence. `LogicalSkill.identity` requires at
least one strong source, plugin, canonical-target, or package identity. Weak
evidence alone cannot create a Logical Skill.

Ownership, scope, artifact kind, Git protection, System Skill protection,
filesystem protection, and dependencies are discriminated unions. This keeps
callers from representing contradictory combinations such as a plugin resource
with filesystem ownership or a project skill outside workspace scope.

## Plans and reports

`RemovalPlan` is a side-effect-free value. Actions are ordered; `dependsOn` may
only refer to an earlier action. Quarantine always requires explicit
brute-force confirmation. Managed removal and quarantine for one target cannot
appear in the same plan, so managed failure never silently activates fallback.
Non-overridable Git, System Skill, permission, and adapter-trust blocks cannot
have actions. Overridable dependency and ambiguity blocks require the matching
force approval.

`ExecutionReport` records action, target, and verification outcomes. Result IDs
must be unique, completion timestamps cannot precede start timestamps, and the
top-level status must agree with the contained failures, blocks, or incomplete
outcomes.

## Deterministic JSON

`toDeterministicJson(value)` recursively orders object keys while preserving
array order. `stringifyModel(value, indentation)` returns deterministic JSON and
rejects non-JSON values, non-finite numbers, and class instances. Model schema
version `1` is represented explicitly on Inventory, RemovalPlan, and
ExecutionReport.
