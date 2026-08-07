# Terminal UI

Running `skill-cleaner` with no arguments opens the interactive inventory. The
terminal UI is a thin presentation layer over Inventory, Planning, and
Execution: browsing reads an immutable Inventory, selecting a row requests a
RemovalPlan, and confirming that complete plan passes its exact approval
requirements to Execution.

## Search and selection

Typing performs case- and accent-normalized fuzzy matching across Skill names,
descriptions, namespaced adapter metadata, IDs, tags, sources, owners, and
locations. Whitespace-separated field filters narrow results:

- `plugin:<value>`
- `agent:<value>`
- `scope:<value>`
- `source:<value>`
- `manager:<value>`
- `status:<value>`

The inventory supplies Logical Skill groups; the UI never groups records from a
matching name or hash. A collapsed Logical Skill is one selectable row for the
whole strong-identity group. Expanding it exposes each physical Installation as
an independently selectable child. Same-name Installations outside such a group
remain separate rows, including their source details. Plugins are explicit
Plugin rows. Non-installation findings are hidden from ordinary removal views
and appear only when a `status:` inspection filter is present; they are not
selectable.

Use the arrow keys to move, Enter to review the selected target's plan, and
Right Arrow or Tab to expand a Logical Skill. Backspace edits the query and
Escape leaves the inventory. The details panel shows ownership, dependencies
and references, Plugin collateral, Git and System Skill protection, and the
available removal path.

## Plans, fallback, and reports

The review screen renders exact targets, actions, blocks, warnings,
verifications, commands, paths, and approval tuples. A blocked plan cannot be
confirmed. `f` asks Planning for a force plan only when every reported block is
marked overridable; force cannot override Git, System Skill, filesystem,
adapter-trust, Plugin-boundary, or unavailable-managed-removal blocks.

Pressing `y` on an unblocked plan is the mutation boundary. Package trust is
shown as an exact runner/package/version/adapter-hash tuple before this
confirmation. A managed-removal failure is reported without running a
filesystem fallback. If Execution returns fallback plans, `f` opens one as a
new brute-force review and a second `y` is required. That plan uses Quarantine
for filesystem removal. The final screen reports target, action, and
verification outcomes, rescan failure, and any still-available fallbacks.

## Limited terminals

When raw terminal controls are unavailable, the same UI uses line-oriented
commands. In the inventory, enter a query directly or use `search <query>`,
`up`, `down`, `expand`, `select`, `clear`, and `quit`. Plan screens accept
`yes`, `no`, `force`, and `quit`; report screens accept `up`, `down`,
`fallback`, and `quit`. End-of-input cancels safely.

Read-only scanning, searching, expanding, cancellation, and plan review create
no files or persistent state. The terminal UI does not scan paths, infer
ownership, invoke a manager, or mutate the filesystem itself.

## Embedding interface

`runTui(dependencies, terminal?)` is exported for alternate presentation hosts
and interaction tests. `TuiDependencies` requires `scan`, `plan`, and `execute`
functions using the public Inventory, RemovalPlanIntent, RemovalPlan,
ApprovalRequirement, and ExecutionReport values. `TuiTerminal` consumes
rendered state through `render`, supplies semantic `TuiAction` values through
`readAction`, and is always closed when the session ends.
