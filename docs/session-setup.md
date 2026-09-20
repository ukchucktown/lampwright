# Session setup

Status: Accepted direction and implementation contract for [#148](https://github.com/ukchucktown/lampwright/issues/148).
Application support follows the delivery issues below. This document does not claim that the feature already exists.

## Outcome

Before a new agent session, the user chooses which capabilities the harness can use. Session setup provides native Enable and Disable controls for Skill Harness Exposures, complete Plugins, MCP Registrations, and App Bindings. It preserves definitions, credentials, and installed content.

The first harness is Codex. Claude Code and Gemini CLI follow through the same module interfaces and TUI. The user chose a separate Session setup area on 2026-09-19. Existing Skills & plugins lifecycle operations retain their behavior.

Session setup changes durable native configuration. It does not launch an agent, attach to an active session, disconnect an account, or promise an exact token reduction. Presets, token measurement, per-tool filters, arbitrary harness configuration, and permanent MCP deletion are outside this increment.

## Targets and state

Each target belongs to one harness and a selected workspace context:

| Target kind      | Identity and boundary                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill exposure   | One Installation ID and one Harness ID. Equal names never merge Installations.                                                                                  |
| Plugin           | One installed Plugin boundary in its harness. A Gemini extension uses this boundary.                                                                            |
| MCP registration | The harness, exact declaration source, definition scope, owner when present, and native server key.                                                             |
| App binding      | The harness, installed owner, exact declaration source, alias, and native connector ID. A binding is not an MCP registration or proof of an account connection. |

Discovery retains disabled owners and packages with no Skills. Plugin-owned Skills appear as read-only children of their owner. A suspended Skill appears as an informational Disabled row with a route to the existing lifecycle view. Session setup does not restore or suspend files. System Skills and runtime-default or policy-managed owners remain protected.

Each row distinguishes its own configured policy from effective availability in the selected workspace. Effective availability includes the owner gate, applicable configuration layers, trust, and any verified higher-precedence constraints. Account authorization and live session state remain unknown. A policy that permits an app does not prove that the account connection works.

Each source reports `success`, `unavailable`, `invalid`, or `incomplete`. Success with zero results differs from an unavailable source. An agent section stays visible even when its sources return no targets. Incomplete evidence must not become an empty successful scan or an invented target.

## Scope and control rules

The selected harness limits the requested target. It does not imply that the change is workspace-local. A Codex user policy or a Gemini server toggle can affect future sessions in other projects. The review states the actual Control Scope before confirmation.

Session setup uses a distinct intent from legacy Availability. Existing Logical Skill, Installation, and Group actions still expand across their represented Harness Exposures. A new Skill exposure action changes only its selected harness through a supported native control. It never uses Suspended Disable as a fallback. A native selector that could affect a different Skill Identity remains an absolute block.

The planner prefers a safe override for the selected workspace when the verified native contract supports one. Otherwise, it may propose a user-scope control with an explicit user-wide disclosure. An Enable that requires changes in several applied layers lists every layer and its wider effects. Managed configuration and tracked or unignored project files remain immutable. The planner never creates an ignored-file exception or assumes that project trust grants write authority.

An independently supported MCP or app policy can change without a whole-Plugin operation. The adapter must prove the exact selector and its effects. The policy never grants authority to edit a package manifest or control a Plugin-owned Skill. A complete Plugin operation changes the owner gate and preserves independent child policies. Thus, Plugin Enable can leave a child disabled by its own policy.

Enable requires the target to become effectively enabled in the selected workspace. If the owner is disabled, the review blocks Enable and identifies the owner. The user can explicitly select the owner for Enable in the same batch or use a fresh owner review. The planner never enables an owner implicitly. Unresolved ownership or policy blocks the affected operation.

Disable sets the target's own native policy even when an owner already makes it effectively disabled. This preserves the user's choice after a later owner Enable. A no-op requires both the requested policy and the expected effective state to hold. Existing non-binary Skill modes remain unchanged on a no-op. A later Enable follows the harness's documented enabled mode and does not promise restoration of an earlier custom mode.

One native app policy can govern several declarations of the same connector. The review identifies every known affected binding and states the full native scope, including effects outside the selected workspace. Incomplete relevant local discovery blocks a claim of complete collateral. A known user-wide scope does not require a crawl of every project or online account discovery.

Hard Dependencies block by default. A required App Binding is a Hard Dependency when the installed descriptor proves that requirement. An absent `required` field means unspecified. Session setup has no force option. An explicit batch may disable a dependent owner and its required capability together when the planner can prove a safe order or a single atomic document change. Soft References warn. Conflicting requested values for one native selector block the batch.

## TUI integration

The area row is `Skills & plugins | Session setup`. The default area remains Skills & plugins. `ctrl-o` cycles areas and both labels accept a click. `ctrl-t` cycles the views inside the active area:

| Area             | Views                      |
| ---------------- | -------------------------- |
| Skills & plugins | Inventory, Disabled, Trash |
| Session setup    | Inventory, Disabled        |

The selected workspace comes from the existing launch directory. A new `--workspace <path>` option can supply it explicitly. The header always names it. The first version changes workspace through a new invocation, so the TUI needs no directory picker or hidden process-directory change.

Session setup keeps the existing two navigation panes and lower detail pane. The left pane lists Codex, Claude Code, and Gemini CLI in that fixed order. The right pane lists targets for the focused harness under nonselectable Skills, Plugins, Apps, and MCP servers headings. These headings are presentation groups, not Installation Groups or identity claims. Plugin Skill children appear only beneath their owner. MCP and app rows identify their owner in details and in a short suffix when names collide.

```text
Lampwright   Skills & plugins | [Session setup]
Workspace: /work/example       [Inventory] | Disabled (7)
ctrl-o area   ctrl-t view   tab pane   / search
d disable   e enable   space select   ctrl-a select view
┌ Harnesses ───────┬ Capabilities ───────────────────────┐
│ > Codex         │ Skills                              │
│   Claude Code   │ [ ] code-review          enabled    │
│   Gemini CLI    │ Plugins                             │
│                 │ [ ] GitHub               enabled    │
│                 │ Apps                                │
│                 │ [ ] Gmail                enabled    │
│                 │ MCP servers                         │
│                 │ [ ] docs                 unresolved │
├─────────────────┴─────────────────────────────────────┤
│ Gmail · App binding · Owner: Gmail plugin              │
│ Policy: enabled · Workspace availability: enabled      │
│ Change scope: Codex user settings, all projects        │
│ Account connection: unknown · Active session: unknown  │
└───────────────────────────────────────────────────────┘
```

The wireframe defines information order, not literal widths or fabricated live inventory. The current Nightfall theme, terminal-controlled background, pane resize, scrolling, mouse behavior, and narrow-terminal clipping remain the visual contract.

Inventory includes effectively enabled and unresolved targets. Disabled includes effectively disabled targets and informational suspended entries. A child whose owner disables it shows that cause. Counts belong to the selected harness and view. Source warnings remain visible independently of target counts.

`d` and `e` open their respective reviews from either setup view. With a staged selection, the action uses exactly those targets. Without a selection, it uses the focused target. Enter on a browse row opens its availability details, never removal. `y` confirms an unblocked review and Escape cancels it. Removal, Update, Restore, and Purge are unavailable in Session setup.

Search uses the existing name-only, case-insensitive regular expression behavior within the selected harness and setup view. Space stages a row, `ctrl-a` stages every target row in that filtered view, and Enter applies additive search selection. Invalid and empty-match expressions remain invalid. Unsupported targets can enter review and appear as blocks, so a batch never silently omits them. Protected System rows and informational children have no checkbox.

Each area, view, and harness retains its own cursor, search, selection, pane focus, dimensions, and scroll positions. A harness change cannot carry a previous harness's selection into a new action. Area changes cannot reuse legacy lifecycle targets as setup targets. A review freezes its harness and workspace context. Escape returns to the exact prior browse state.

An explicit `o` action in details opens a complete-owner availability review when that route exists. This is a fresh setup review with only the owner target, no inherited child selection, and all known owner effects. It never opens removal or enables an owner automatically. A suspended Skill instead offers a read-only route to its existing Disabled lifecycle entry. Any later lifecycle action uses that area's ordinary review.

The report distinguishes saved policy, effective workspace availability, unchanged state, blocks, partial failures, and unverified active sessions. After execution, shared discovery refreshes both setup views and invalidates affected lifecycle snapshots. Selection remains only for still-existing exact targets. A failed rescan cannot report verified success.

## Shared contracts and compatibility

The Inventory module owns `scanSessionSetup(request)`. Its request includes the selected workspace and harness filter. Its immutable `SessionSetupInventory` contains the relevant legacy Inventory, typed setup targets, source results, native-control evidence, and a semantic fingerprint. Discovery must collect complete collateral for the plan even when the UI filters rows. There is no persistent capability registry.

The Planning module owns `planSessionSetup(snapshot, intent)`. The intent contains `enable` or `disable`, exact typed targets, one harness, and one workspace. The planner returns a `SessionSetupPlan` with normalized intent, blocks, warnings, complete scope effects, dependencies, approvals, native mutations, and verification expectations. It performs no file reads, command discovery, or network requests.

The Execution module owns `executeSessionSetup(plan, approvals)`. It reuses the existing availability writer, freshness checks, Git and filesystem inspection, document grouping, dependency scheduler, audit, and rescan primitives. It returns a `SessionSetupReport`. New public functions do not justify a second safety implementation or a general MCP lifecycle service.

Session setup admits only native availability actions. Typed mutation variants cannot express registration deletion, credential changes, owner installation, or filesystem suspension. A verified native command can run only inside its declared effects. A command failure never triggers an automatic configuration edit. If a profile supports a direct native-format edit, planning chooses that method before confirmation.

The TUI receives these functions as optional injected dependencies for source compatibility with existing embedding hosts. An absent setup provider produces an unavailable-area explanation. Presentation code never reads configuration or constructs native commands.

Existing v1 Inventory, Availability, Removal, Update, and CLI JSON remain unchanged. Session setup has a separately versioned `session-setup-v1.schema.json` for its snapshot, plans, reports, confirmation requirements, and errors. New selectors cannot enter legacy lifecycle operations. Cross-record validation checks ownership, identity, scope, target references, mutation authority, and shared selectors.

## CLI parity

The new surface uses existing verbs with an explicit setup mode:

```console
lampwright --workspace /work/example
lampwright scan --session-setup --harness codex --workspace /work/example --json
lampwright disable setup:<opaque-target-id> --harness codex --workspace /work/example --dry-run --json
lampwright enable setup:<opaque-target-id> --harness codex --workspace /work/example --yes
```

Setup mutation requires an explicit `--harness` and one or more exact setup selectors from the snapshot. Workspace defaults to the invocation directory. Setup scans without a harness filter return all supported harnesses. Mixed setup and legacy selectors, multiple harnesses in one mutation, `--force`, `--all`, and removal/update verbs with setup selectors are invalid before any mutation. For TUI launch, `--workspace` supplies the same root to both areas. For CLI operations, the new workspace option applies only to setup commands. Legacy CLI scope continues to use the invocation directory. The legacy `scan` output and selectors keep their defaults.

`--yes` grants the ordinary approval for the complete disclosed setup plan. It cannot override protection, dependencies, unsupported controls, or stale evidence. JSON reports use the new schema. Exit codes retain existing meanings: 0 for verified success or unchanged state, 1 for execution/verification failure or partial failure, 2 for invalid usage, and 3 for blocked, stale, missing-target, or confirmation-required results.

## Safety and acceptance

Read-only scans, search, browse, and dry runs create no files and start no MCP servers, agent sessions, credential helpers, or network probes. Metadata-only native probes require a verified offline contract. An unavailable authoritative local source remains unavailable. Historical account names and unreferenced cache contents never become mutation targets.

Every configuration change preserves unrelated values, comments, line endings, credentials, and declarations. The writer rejects symlinks, junctions, hard links, duplicate relevant keys, stale preimages, protected paths, and unsafe missing-file parents. The planner blocks known contradictions before execution. Runtime failures stop dependent actions while independent actions can continue. Exact selected-file integrity checks precede each write.

Public values and errors omit credential values, headers, environment values, sensitive URL components, and raw configuration payloads. Tests use temporary homes, workspaces, state, and caches plus fake process runners. Validation includes same-document batches, shared connectors, inherited policies, disabled owners, name collisions, source failures, non-target preservation, races, partial failures, and legacy lifecycle regressions.

Context overhead can exist before a tool call. Deferred loading can reduce that overhead while names, descriptions, and other metadata still occupy context. The UI does not infer zero cost from no observed use or display invented savings. [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) explains the distinction. Exact footprint and usage analysis remain in [the separate usage idea](./ideas/skill-usage-and-cost.md).

## Delivery sequence

| Slice                                                        | Dependency                                                                                                                                                                               | Outcome                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [#149](https://github.com/ukchucktown/lampwright/issues/149) | This design                                                                                                                                                                              | Typed contracts, source profiles, baseline fixtures, and a bounded reuse manifest      |
| [#150](https://github.com/ukchucktown/lampwright/issues/150) | [#149](https://github.com/ukchucktown/lampwright/issues/149)                                                                                                                             | Native-only setup planning and execution through injected fixtures                     |
| [#151](https://github.com/ukchucktown/lampwright/issues/151) | [#150](https://github.com/ukchucktown/lampwright/issues/150)                                                                                                                             | Codex discovery and controls for all four supported target kinds                       |
| [#152](https://github.com/ukchucktown/lampwright/issues/152) | [#151](https://github.com/ukchucktown/lampwright/issues/151)                                                                                                                             | Explicit setup selectors, scope, dry runs, and versioned JSON                          |
| [#153](https://github.com/ukchucktown/lampwright/issues/153) | [#152](https://github.com/ukchucktown/lampwright/issues/152)                                                                                                                             | Session setup area, complete reviews, and the first Codex operator journey             |
| [#154](https://github.com/ukchucktown/lampwright/issues/154) | [#153](https://github.com/ukchucktown/lampwright/issues/153)                                                                                                                             | Claude Code setup support through the same interfaces                                  |
| [#155](https://github.com/ukchucktown/lampwright/issues/155) | [#154](https://github.com/ukchucktown/lampwright/issues/154)                                                                                                                             | Gemini CLI setup support through the same interfaces                                   |
| [#156](https://github.com/ukchucktown/lampwright/issues/156) | [#153](https://github.com/ukchucktown/lampwright/issues/153), [#154](https://github.com/ukchucktown/lampwright/issues/154), [#155](https://github.com/ukchucktown/lampwright/issues/155) | Full Node/OS matrix, real-terminal QA, regression evidence, and operator documentation |

The sequence prioritizes one usable Codex path before additional harnesses. Each issue owns its own gates and a reviewable commit. The parent remains open until final acceptance. No issue authorizes publication or a release.

## Reuse assessment

The retired work ends at [229f8cd](https://github.com/ukchucktown/lampwright/commit/229f8cd3af49c374a7dc92b4f1f9782b1a7fea23). This plan does not merge that branch. Its old tests are historical evidence, not a current acceptance result.

| Existing code at that commit                                           | Disposition                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/inventory/codex-mcp.ts`, `claude-gemini-mcp.ts`, `package-mcp.ts` | Reuse bounded parsers and source/owner evidence after profile and fixture review. Remove Delete capability construction.                                                          |
| Plugin discovery changes in `src/inventory/`                           | Review mixed local/remote descriptors, MCP-only packages, app manifests, and disabled-owner coverage. An offline source contract gates adoption.                                  |
| `src/mcp/identity.ts`, `configuration.ts`, `redaction.ts`              | Reuse exact identity, safe evidence access, and redaction where they fit the new target contracts.                                                                                |
| `src/planning/mcp.ts`, `src/execution/mcp.ts`                          | Extract availability-specific logic into the owning modules. Do not import permanent-delete approvals, credential effects, fallback orchestration, or duplicate execution policy. |
| `src/execution/*mcp-configuration.ts`                                  | Reuse comment-preserving availability edits through the shared writer. Delete and credential mutation variants are excluded.                                                      |
| `src/tui/mcp.ts` and area-state changes                                | Reuse pane/state lessons and tests. Replace the MCP-only projection with all four setup target kinds and a non-destructive Enter action.                                          |
| `src/mcp/schemas.ts`, `schemas/mcp-v1.schema.json`                     | Do not publish the abandoned MCP lifecycle schema. Define the smaller native-only setup schema.                                                                                   |
| MCP, package, CLI, and TUI tests                                       | Port relevant fixtures and assertions. Add selected-harness, owner-gate, shared-policy, and legacy compatibility cases.                                                           |
| The unmerged permanent-deletion ADR and operator plan                  | Retired. They grant no authority under this plan.                                                                                                                                 |

The source-profile contract and qualification requirements are in [Session setup controls](./session-setup-controls.md). [ADR 0015](./adr/0015-scope-session-setup-to-native-availability.md) reconciles the legacy boundaries.
