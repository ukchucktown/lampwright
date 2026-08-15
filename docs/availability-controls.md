# Native Skill and Plugin availability controls

This document defines the native configuration evidence that Inventory may
materialize for reversible Skill and complete-Plugin availability. It is the
source of truth for issues #72, #73, and #91. Presentation code does not read or
interpret these files.

## Canonical Inventory contract

An Installation contains one Harness Exposure value for every harness that can
discover it. A Harness Exposure records two independent facts:

- `status`: `enabled`, `disabled`, or `unresolved`.
- `control`: either a supported native mechanism with its current safety
  availability and exact evidence, or `unsupported` with a reason.

`unresolved` means Inventory cannot prove the runtime state from a stable,
unambiguous configuration snapshot. `unsupported` describes control
capability, not runtime state: a visible Skill can be enabled while Skill
Lampwright has no native control for that harness.

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

A Plugin boundary separately records `enabled`, `disabled`, or `unresolved`
status and a closed whole-Plugin native-control value. Its selector is the exact
Plugin identifier. This evidence never grants availability control to an owned
Installation, never authorizes Disabled Storage, and never changes Plugin
removal protection.

## Codex

- Document: `<codex-home>/config.toml`, normally `~/.codex/config.toml`.
- Format: TOML.
- Control: ordered `[[skills.config]]` entries with exactly one `path` or
  `name` selector and an `enabled` boolean.
- Effective value: matching rules are applied in document order and the last
  matching rule wins; no match means enabled.
- Lampwright mutation identity: the canonical absolute `SKILL.md` path. Name
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
- Writable candidates: user and local project. Lampwright never writes the
  shared project document. A local candidate is unavailable unless Git reports
  its path ignored.

When the workspace is the user's home directory, the user and shared project
paths name the same `settings.json`. Inventory represents that physical file
once as the higher-precedence shared project layer. It is evidence only: the
only writable candidate in this collision case is the local project document.

Managed policy and command-line/session overrides are outside this local-file
control. If observed evidence shows that one affects the Skill, the exposure is
`unresolved`; Lampwright never claims that a lower-precedence local edit can
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

## Whole-Plugin controls

Whole-Plugin availability changes the harness's Plugin boundary, not its child
Skills. Runtime-default Plugins and managed policy are absolute blocks. A
supported control must have one exact Plugin identifier, complete safe document
evidence, an operation-specific writable layer, and an effective status that
agrees with the harness's observed Plugin list. Otherwise the Plugin is
`unresolved` or its operation is unavailable.

### Codex Plugins

- Document: `<codex-home>/config.toml`, normally `~/.codex/config.toml`.
- Format: TOML.
- Control: `plugins.<plugin-id>.enabled`; no value means enabled.
- Writable candidate: the user Codex document only.

Lampwright parses the complete TOML document and cross-checks the effective
value with `codex plugin list`. Mutation updates the existing Plugin table or
adds its canonical table while preserving unrelated settings, comments, and
line endings.

### Claude Code Plugins

- User document: `<claude-home>/settings.json`, normally
  `~/.claude/settings.json`.
- Shared project document: `<workspace>/.claude/settings.json`.
- Local project document: `<workspace>/.claude/settings.local.json`.
- Format: JSON.
- Control: `enabledPlugins[plugin-id]`; no value means enabled.
- Effective precedence, low to high: user, shared project, local project.
- Writable candidates: user and safe Git-ignored local project. Shared project
  settings are evidence only.

The same home-workspace collision rule applies to Plugin evidence: the shared
project layer represents the coincident `settings.json` once, and only the
local project document remains a writable candidate.

Managed settings are unsupported. Mutation uses the highest-precedence safe
writable layer without altering unrelated JSON members.

### Gemini CLI extensions

- Document: `<gemini-home>/extensions/extension-enablement.json`, normally
  `~/.gemini/extensions/extension-enablement.json`.
- Format: JSON.
- Control: the extension's ordered `overrides` array evaluated for the current
  workspace path. Later matching rules win.
- Writable candidate: the user enablement document only.

Lampwright validates every extension record before trusting the document,
cross-checks the evaluated value with Gemini's observed extension state, and
uses Gemini's user-scope include/exclude rule semantics. Mutation preserves
unrelated extension records and configuration.

## Verification and serialization

Harness Exposures and native evidence are part of the stable Inventory JSON
schema and semantic Inventory fingerprint. Ordering is deterministic:
exposures by harness identifier, configuration layers by documented
precedence, and same-layer rule evidence by source order.

Planning consumes only this materialized evidence. Execution verifies the full
document preimage immediately before a comment-preserving mutation, then a
fresh Inventory verifies the requested exposure state. Neither module reparses
an undocumented harness convention.
