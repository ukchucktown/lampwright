# Terminal UI

Running `skill-cleaner` with no arguments opens the interactive inventory. The
terminal UI is a thin presentation layer over Inventory, Planning, and
Execution: browsing reads an immutable Inventory, selecting a row requests a
RemovalPlan, and confirming that complete plan passes its exact approval
requirements to Execution.

## Layout

Two panes over a detail area, in a fixed grid. The left pane lists sections,
the right lists the entries of the focused section, and the area below shows
the focused entry in full. Panes never grow to fit their contents: each owns a
viewport that scrolls under a stationary frame, so nothing below shifts as you
move.

Two rules keep the frame still, and both are covered by tests. Every line is
clipped one column short of the terminal width, because writing into the last
cell makes an auto-margin terminal wrap and silently add a row. And text is
fitted before it is styled, because fitting strips escape codes when it
truncates, which would otherwise leave the same column dim on one row and plain
on the next.

Arrows move; left and right change pane; Page Up and Page Down step exactly one
viewport; shift with left or right moves the pane split and with up or down
changes the detail height. A pointer can click a row, double-click to select it,
wheel over either pane, and drag the divider. The wheel moves the cursor rather
than only the viewport, so the focused row cannot scroll out from under it.

## Sections

Sections come from declared evidence, never from a name or a path:

- One section per Installation Group, labelled with its source.
- `No shared source` for Skills no Owner records together, including an
  Installation that belongs to no Logical Skill.
- `Plugins`, listing each Plugin boundary rather than its owned Skills, since
  the boundary is what can be removed. A Plugin the agent runtime ships with
  itself is marked.
- `System skills`, present but not selectable. Its rows draw no checkbox,
  because offering one would invite a click that can only be refused.

A section header carries what its entries share — how many, the Owner, the
Scope, the path count, and the agents that can load them. A row repeats none of
that; it shows a note only where it departs from the section, such as an
unusual exposure, `protected`, `broken`, or `spans groups`. Descriptions are too
long to read in a row, so they are word-wrapped in the detail area with the
physical paths.

## Search and selection

Typing filters every section at once; sections keep their identity while their
contents shrink. A term matches a name as a subsequence, or a section label,
agent, or path as a substring. Descriptions are deliberately excluded: they are
ordinary English, so a two-letter query matched almost everything through words
like "can" and "because".

`space` on an entry selects it. `space` on a section takes or clears the whole
section, so a bundle of twenty-two is one keystroke; the left pane shows `[ ]`,
`[~]`, or `[x]` for none, some, or all taken. Selection spans sections, so
Skills from several bundles can be reviewed together.

Selection resolves to Removal Targets through the same rule the command line
uses. A fully selected Group collapses into one `source-group` target rather
than a list of its members; a partial selection stays a list of Logical Skill
targets; a Plugin row is its own boundary. With nothing selected, `enter`
reviews the row under the cursor.

`esc` unwinds the narrowest thing first — the filter, then the pane, then the
selection — and only leaves once there is nothing left to undo, so a stray
keypress cannot discard a selection.

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
