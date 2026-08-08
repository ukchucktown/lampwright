# Native Skill availability controls

This document defines the native configuration evidence that Inventory may
materialize for reversible Skill availability. It is the source of truth for
issues #72 and #73. Presentation code does not read or interpret these files.

## Canonical Inventory contract

An Installation contains one Harness Exposure value for every harness that can
discover it. A Harness Exposure records two independent facts:

- `status`: `enabled`, `disabled`, or `unresolved`.
- `control`: either a supported native mechanism with its current safety
  availability and exact evidence, or `unsupported` with a reason.

`unresolved` means Inventory cannot prove the runtime state from a stable,
unambiguous configuration snapshot. `unsupported` describes control
capability, not runtime state: a visible Skill can be enabled while Skill
Cleaner has no native control for that harness.

Native control evidence contains:

- The harness and mechanism.
- The exact path- or name-based selector used by the harness.
- Every configuration layer that contributes to the effective value, in
  precedence order.
- The intended writable candidate layers, without authorizing a mutation.
- For each document: its absolute path, format, ordinary Skill Scope and exact
  harness document scope (for example Claude's shared or local project layer),
  whether the layer applies, existence, canonical path when present, complete
  SHA-256 preimage when present, Git and filesystem protection, and the
  selector's exact current value.
- The effective value and the evidence that produced it.

A missing regular configuration file is a valid empty snapshot. It has no
preimage hash, but its intended path and parent-derived protection are still
recorded. Scanning never creates it. A malformed document, duplicate relevant
key or selector, symbolic link, junction, hard link, unstable read, or
unreadable document makes the affected exposure `unresolved` and the native
control unavailable. A protected or read-only document may have a resolved
status. Native control availability is operation-specific: an unrelated
non-writable Claude shared layer does not prevent a safe local override, while
Gemini Enable is unavailable until every applied disabled-name membership can
be changed.

Name selectors never establish Skill Identity. Inventory records the selector;
Planning checks the complete Inventory and blocks a change when the same name
could affect another identity.

Plugin-owned and System Skills retain Harness Exposure status for display, but
their individual control is always `unsupported`. Installation lifecycle state
remains separate: disabling an exposure does not change an Installation from
`active` to another lifecycle status.

## Codex

- Document: `<codex-home>/config.toml`, normally `~/.codex/config.toml`.
- Format: TOML.
- Control: ordered `[[skills.config]]` entries with exactly one `path` or
  `name` selector and an `enabled` boolean.
- Effective value: matching rules are applied in document order and the last
  matching rule wins; no match means enabled.
- Cleaner mutation identity: the canonical absolute `SKILL.md` path. Name
  rules are read because they affect the current value, but Planning may only
  authorize an exact-path rule for a Skill.
- Writable candidate: the user Codex document only. Current Codex skill-rule
  loading does not apply project `.codex/config.toml` files, so Inventory must
  not invent a project-layer control. A workspace-scoped Skill still uses the
  user document with its exact path.

The model preserves every matching rule and its array index so Planning can
append an exact-path rule without confusing a name match with identity.

## Claude Code

- User document: `<claude-home>/settings.json`, normally
  `~/.claude/settings.json`.
- Shared project document: `<workspace>/.claude/settings.json`.
- Local project document: `<workspace>/.claude/settings.local.json`.
- Format: JSON.
- Control: `skillOverrides[skill-name]` with `on`, `name-only`,
  `user-invocable-only`, or `off`.
- Effective precedence, low to high: user, shared project, local project.
  `off` is disabled; every other valid value remains enabled with its exact
  mode preserved.
- Writable candidates: user and local project. Skill Cleaner never writes the
  shared project document. A local candidate is unavailable unless Git reports
  its path ignored.

Managed policy and command-line/session overrides are outside this local-file
control. If observed evidence shows that one affects the Skill, the exposure is
`unresolved`; Skill Cleaner never claims that a lower-precedence local edit can
override it.

## Gemini CLI

- User document: `<gemini-home>/settings.json`, normally
  `~/.gemini/settings.json`.
- Workspace document: `<workspace>/.gemini/settings.json`.
- Format: JSONC, matching Gemini CLI's settings reader.
- Control: the exact Skill name in `skills.disabled`.
- Effective value: Gemini merges the user and trusted-workspace disabled arrays
  by union. Membership in either applied layer means disabled. Matching is
  case-sensitive.
- Writable candidates: user and workspace. Enablement must account for both
  lists because removing the name from only one applied layer may leave the
  Skill disabled.

When Gemini folder trust is enabled, an untrusted workspace's settings do not
apply. Inventory may use durable local trust evidence when it can prove the
state. If workspace applicability depends on an IDE signal, environment or
session flag, is malformed, or otherwise cannot be proven from the scan,
workspace-derived availability is `unresolved` rather than guessed.

System defaults, system overrides, remote administration, and session-only
overrides are not writable native controls. Observed higher-precedence evidence
must make the control unavailable; absence of such evidence is not authority to
edit those sources.

## Verification and serialization

Harness Exposures and native evidence are part of the stable Inventory JSON
schema and semantic Inventory fingerprint. Ordering is deterministic:
exposures by harness identifier, configuration layers by documented
precedence, and same-layer rule evidence by source order.

Planning consumes only this materialized evidence. Execution verifies the full
document preimage immediately before a comment-preserving mutation, then a
fresh Inventory verifies the requested exposure state. Neither module reparses
an undocumented harness convention.
