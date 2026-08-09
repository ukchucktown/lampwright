# Skill Cleanup

This context describes how `skill-cleaner` identifies AI agent skills, attributes lifecycle ownership, controls their availability, and removes installed capabilities without damaging unrelated tools or project source.

## Installed capabilities

**Skill**:
A named AI agent capability defined by a `SKILL.md` file and any resources contained with it.
_Avoid_: Prompt, rule, extension

**Skill Identity**:
The provenance-backed identity of a Skill. A matching name or content hash alone is evidence, but is not sufficient to establish identity.

**Installation**:
A concrete occurrence of a Skill that an agent can discover, including a copied directory, link, manager entry, or plugin-owned resource. A broken lock-only manager record remains an Installation for diagnosis even when no agent can currently load it.
_Avoid_: Skill, copy

**Harness Exposure**:
The relationship through which one agent harness can discover and load an Installation. One Installation may have several independently enabled or disabled Harness Exposures.
_Avoid_: Agent, installation

**Logical Skill**:
A group of Installations known through strong evidence to share one Skill Identity.
_Avoid_: Duplicate, package

**System Skill**:
A Skill supplied as an inseparable part of an agent runtime and outside the cleaner's removal boundary.
_Avoid_: Installed skill, managed skill

**Source Artifact**:
A Skill or plugin definition found in source code, a vendored dependency, or a cache without evidence that it is an active Installation.
_Avoid_: Installation

## Ownership

**Owner**:
The lifecycle authority responsible for an Installation, such as a Manager, Plugin, agent runtime, or the filesystem itself.

**Manager**:
A tool that records and controls the lifecycle of one or more Skill Installations.
_Avoid_: Installer, adapter

**Plugin**:
An installed capability bundle that may own Skills together with commands, agents, hooks, settings, or other resources.
_Avoid_: Skill package

**Adapter**:
A declarative description of how to discover, interpret, remove, and verify Installations owned by a particular system.
_Avoid_: Plugin, manager

## Cleanup

**Inventory**:
A live, disposable snapshot of discovered Installations, ownership evidence, dependencies, and protection status.
_Avoid_: Registry, database

**Removal Target**:
A selected Logical Skill, individual Installation, declared Installation Group, or Plugin ownership boundary that the user intends to remove.

**Removal Plan**:
The ordered, reviewable set of actions, warnings, blocked operations, and verification checks required to remove one or more Removal Targets.

**Availability Target**:
A selected Logical Skill, individual Installation, or declared Installation Group whose Harness Exposures the user intends to disable or enable without removal.

**Availability Plan**:
The ordered, reviewable set of actions, warnings, blocked operations, and verification checks required to disable or enable one or more Availability Targets.

**Native Disable**:
A reversible change through a harness-supported control that keeps the Installation at its original location.
_Avoid_: Remove, uninstall

**Suspended Disable**:
A reversible change that makes an Installation unavailable by displacing its complete authorized artifact set from every discovery location while retaining its lifecycle identity.
_Avoid_: Remove, quarantine

**Disabled Storage**:
Inert, non-expiring recoverable storage for complete artifact sets displaced by Suspended Disable.
_Avoid_: Quarantine, Trash

**Enable**:
The reversal of Native Disable or Suspended Disable that makes the affected Harness Exposures available again.
_Avoid_: Restore, install

**Managed Removal**:
Removal performed through an available Owner's supported lifecycle operation.
_Avoid_: Native deletion

**Brute-force Removal**:
Explicitly confirmed cleanup performed without a successful Owner lifecycle operation.
_Avoid_: Force, purge

**Quarantine**:
Inert recoverable storage for artifacts displaced by Brute-force Removal.
_Avoid_: Trash, backup

**Trash**:
The approachable presentation of Quarantine entries and removal operations.
Trash is not storage and does not imply permanent deletion.
_Avoid_: Quarantine (when referring to the user interface)

**Purge**:
Permanent deletion of quarantined artifacts.
_Avoid_: Remove, force

## Relationships and protection

**Hard Dependency**:
A structured declaration that another installed capability requires a Removal Target. Hard Dependencies block removal unless explicitly overridden.

**Soft Reference**:
Heuristic evidence that another Skill mentions, links to, or may invoke a Removal Target. Soft References warn but do not block.

**Git-protected Artifact**:
An artifact inside a Git worktree that Git does not classify as ignored. Git-protected Artifacts are visible but immutable to the cleaner.

**Scope**:
The availability boundary of an Installation, such as user-wide, workspace-local, or agent-specific.

**Installation Group**:
A navigational batch-selection group made only from declared Manager, source, and Scope evidence. It is not a Skill Identity claim and does not merge its member Skills. Structural grouping is deferred until separately justified.
