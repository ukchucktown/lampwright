# Skill lifecycle and session availability

This context describes how `lampwright` identifies AI agent skills, attributes lifecycle ownership, controls their availability, and removes installed capabilities without damaging unrelated tools or project source.

It also describes native availability for the capabilities that a selected harness can use in a future session.

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
A Skill supplied as an inseparable part of an agent runtime and outside Lampwright's removal boundary.
_Avoid_: Installed skill, managed skill

**Source Artifact**:
A Skill or plugin definition found in source code, a vendored dependency, or a cache without evidence that it is an active Installation.
_Avoid_: Installation

**MCP Registration**:
A declaration that supplies an MCP server to one harness from an exact source and definition scope, with an Owner when a package supplies it. The declaration does not prove a live server connection.
_Avoid_: Skill, server process

**App Binding**:
A declaration that associates an installed Plugin with an app connector through an exact alias and connector identity. A binding does not prove account authorization or an MCP Registration.
_Avoid_: Connection, MCP server

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
A live, disposable snapshot of discovered capabilities, ownership evidence, dependencies, and protection status.
_Avoid_: Registry, database

**Removal Target**:
A selected Logical Skill, individual Installation, declared Installation Group, or Plugin ownership boundary that the user intends to remove.

**Removal Plan**:
The ordered, reviewable set of actions, warnings, blocked operations, and verification checks required to remove one or more Removal Targets.

**Availability Target**:
A selected Logical Skill, individual Installation, declared Installation Group, or complete Plugin boundary that the user intends to disable or enable without removal. Skill targets change their represented Harness Exposures; a Plugin target changes the harness-native availability of the complete Plugin while keeping its contents installed.

**Availability Plan**:
The ordered, reviewable set of actions, warnings, blocked operations, and verification checks required to disable or enable one or more Availability Targets.

**Session Setup Target**:
A selected Skill Harness Exposure, complete Plugin, MCP Registration, or App Binding whose native availability the user intends to change for a harness. Its actual Control Scope can extend beyond the selected workspace.
_Avoid_: Availability Target, active session

**Session Setup Plan**:
The reviewable native availability changes, complete scope effects, blocks, and verification expectations for exact Session Setup Targets.

**Update Target**:
A selected Logical Skill, individual Installation, declared Installation Group, or complete Plugin boundary that the user intends the current Owner to update.

**Update Plan**:
The ordered, reviewable set of Owner actions, warnings, blocked operations, and verification checks required to update one or more Update Targets.

**Managed Update**:
An Owner-controlled refresh of an existing Installation or complete Plugin boundary under its recorded source, ref, and Scope.
_Avoid_: Reinstall, sync, upgrade

**Native Disable**:
A reversible change through a harness-supported control that preserves a capability's definition and installed content.
_Avoid_: Remove, uninstall

**Suspended Disable**:
A reversible change that makes an Installation unavailable by displacing its complete authorized artifact set from every discovery location while retaining its lifecycle identity.
_Avoid_: Remove, quarantine

**Disabled Storage**:
Inert, non-expiring recoverable storage for complete artifact sets displaced by Suspended Disable.
_Avoid_: Quarantine, Trash

**Enable**:
The reversal of Native Disable or Suspended Disable that makes the selected capability available within its approved scope.
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
A structured declaration that one installed capability requires another. Hard Dependencies block removal or disablement unless the relevant operation permits an explicit override.

**Soft Reference**:
Heuristic evidence that another Skill mentions, links to, or may invoke a Removal Target. Soft References warn but do not block.

**Git-protected Artifact**:
An artifact inside a Git worktree that Git does not classify as ignored. Git-protected Artifacts are visible but immutable to Lampwright.

**Scope**:
The availability boundary of an Installation, such as user-wide, workspace-local, or agent-specific.

**Definition Scope**:
The boundary in which a capability declaration belongs, independently of the control that governs its availability.

**Control Scope**:
The complete boundary affected by a native availability policy. A user-wide Control Scope can govern declarations from several workspaces or owners.

**Installation Group**:
A navigational batch-selection group made only from declared Manager, source, and Scope evidence. It is not a Skill Identity claim and does not merge its member Skills. Structural grouping is deferred until separately justified.
