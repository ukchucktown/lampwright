# Terminal UI

Running `skill-cleaner` with no arguments opens the interactive inventory. The
terminal UI is a thin presentation layer over Inventory, Planning, and
Execution: browsing reads an immutable Inventory, selecting a row requests a
RemovalPlan, and confirming that complete plan passes its exact approval
requirements to Execution.

## Layout

The header provides `Inventory | Trash (N)`. `ctrl-t` and either header label
switch views. Trash browsing and previews are read-only presentations backed by
Quarantine; a `y`-confirmed restore or purge mutates only through Quarantine's
safety checks. Trash groups only entries with persisted approved-plan
provenance, while legacy entries remain individually accessible. Its sections
are Recoverable, Past retention date, and Needs attention. Details preserve
names, Brute-force Removal method, locations, timestamps, retention, item count,
and restore readiness.

Enter opens a non-mutating restore review and `p` opens permanent-purge review.
Both preview every item; a known conflict blocks the whole restore and `y` is
the mutation boundary. A race can report an honest partial result but never
overwrites an occupied path, bypasses Git protection, or ignores integrity.
Purge is explicitly irreversible. Managed removals do not enter Trash because
their content is not recoverable by skill-cleaner.

Two navigation panes sit over a read-only detail pane in a fixed grid. The left
pane lists sections, the right lists the entries of the focused section, and
the pane below shows the focused entry. Each pane owns an independent viewport
that scrolls under a stationary frame, so long detail content remains reachable
without moving the rest of the interface.

Global search temporarily replaces that grid with a flat matching-Skill list
on the left and a read-only preview on the right. The preview carries the
focused Skill's description, category, Owner, agent exposure, and paths. Closing
search restores the exact inventory position and pane focus that opened it.
The application title and action hints remain in the header. Directly beneath
them, a bordered `> ` prompt row begins the search surface above the
results/preview split and shows the active regular expression in the theme's
active-input color. Match status follows the panes, so typed input cannot be
mistaken for header status or help text.

When detail content overflows, its right edge draws a scrollbar and the status
row reports the visible range. Moving to another entry resets detail scrolling
to the top. Resizing the window or detail pane clamps the range to the content,
so an old offset can never leave the pane blank.

Two rules keep the frame still, and both are covered by tests. Every line is
clipped one column short of the terminal width, because writing into the last
cell makes an auto-margin terminal wrap and silently add a row. And text is
fitted before it is styled, because fitting strips escape codes when it
truncates, which would otherwise leave the same column dim on one row and plain
on the next.

## Theme and color

The built-in `Nightfall` theme follows the restrained Subliminal Nightfall
palette used by Ghostty, Yazi, and tmux. Muted blue-gray borders keep the grid
quiet; cyan identifies structure and paths; yellow identifies the active or
selected item; green marks success; blue marks information; and pink-red marks
errors. Focused rows use a light foreground over a slate selection background.
The application never paints a base background, so terminal transparency and
blur remain owned by the terminal.

The inventory hint row presents each navigation or action key in bold cyan and
its description in muted text. Its contents follow the active pane: navigation
panes show movement and selection, while detail shows scrolling, paging, and
resizing. Pointer focus, pane changes, review, back, and quit remain separate
key/action pairs. Separators remain muted, so the row does not conflate
navigation with selection. Segment styling is applied after clipping,
preserving emphasis and reset boundaries on narrow terminals.

Colors are semantic decoration, not state. Checkboxes, focus position, labels,
and words such as `protected`, `broken`, and `failed` preserve the same meaning
when color is unavailable. Raw terminals select true color, 256-color ANSI, or
16-color ANSI from their advertised capabilities. `NO_COLOR`, `TERM=dumb`, and
non-TTY line output use the monochrome theme. No shell command, terminal probe,
or platform-specific executable is required.

Up and down move the highlighted row in a navigation pane or scroll a focused
detail pane. Page Up and Page Down step exactly one active viewport. Tab and
Shift-Tab cycle through sections, entries, and detail; left and right remain
shortcuts between the side-by-side navigation panes. Shift with left or right
moves the vertical pane split, and Shift with up or down changes the detail
height.

A single click focuses a navigation row or the detail pane. A double-click on a
navigation row focuses it and toggles its selection, matching space on the
keyboard; detail remains read-only. The wheel focuses the pane under the
pointer and moves or scrolls only that pane. Dragging the vertical divider
resizes the navigation panes, while dragging the horizontal divider resizes
detail. Pointer motion alone does nothing unless a divider drag is active.
Terminal resize events update the viewport immediately, including while a plan
or report is open. Every terminal or pane-size change redraws the complete
frame from the new dimensions. If the window becomes too small for the grid,
the UI draws only a clipped resize prompt until the grid fits again; it never
draws beyond the real terminal or relies on wrapping to hide stale content.
The interactive terminal runs on the alternate screen. That is not decoration:
on the normal buffer a terminal treats the wheel as its own scrollback and never
forwards it, so a pane could not scroll however the application asked. Leaving
also restores whatever was on screen before. Pointer reporting is enabled only
for the raw terminal and is turned off again on exit, alongside the screen, so a
terminal is never left in mouse mode.

Reports are read from the raw input stream rather than from keypress events,
because Node's readline splits one report into eight separate keypresses; no
single event carries a whole report, and the leftover digits would otherwise be
typed into the filter. Motion is ignored unless a divider drag is in progress, since
otherwise every twitch of the pointer would re-select the row beneath it. SGR
reports are framed across raw-stream chunk boundaries after the complete SGR
sentinel (`ESC[<`) identifies mouse input, so split report data remains one
pointer action and its fragments do not become filter input. Incomplete or
malformed escape sequences remain ordinary keyboard input.

## Sections

Sections come from declared evidence, never from a name or a path:

- One section per Installation Group, labelled with its source.
- `No shared source` for Skills no Owner records together, including an
  Installation that belongs to no Logical Skill.
- `Plugins`, listing each Plugin boundary and the agent harness tied to it as
  ownership context. Plugin rows are informational and cannot be selected. A
  Plugin the agent runtime ships with itself is marked.
- `System skills`, present but not selectable. Its rows draw no checkbox,
  because offering one would invite a click that can only be refused.

A section header carries what its entries share — how many, the Owner, the
Scope, the path count, and the agents that can load them. A row repeats none of
that; it shows a note only where it departs from the section, such as an
unusual exposure, `protected`, `broken`, or `spans groups`. Descriptions are too
long to read in a row, so they are word-wrapped in the detail area with the
physical paths.

## Search and selection

Pressing `/` or typing from the inventory opens global search. Its raw input is
a case-insensitive regular expression matched against Skill names only; regex
delimiters are not required. For example, `^react`, `typescript|camunda`, and
`(test|spec)$` are valid. Invalid expressions show an explanation and cannot be
applied. Expressions that match empty text are also refused because they would
match every Skill: `^c` or `^c.*`, not `^c*`, means a name beginning with `c`.

Search is intentionally name-only so anchors retain their ordinary meaning.
Category, Owner, agent exposure, path, and description remain visible in the
preview but cannot make an unrelated Skill appear. Explicit field syntax such
as `category:` and `agent:` is deferred for later prototyping.

Up and down move through matches. Space stages the focused removable Skill and
Ctrl-A stages every visible removable match. System Skills stay visible without
a selectable marker. Enter adds the staged Skills to the existing inventory
selection and returns to the exact inventory position that opened search;
another `/` starts another additive search. Escape cancels search and discards
its staging without changing the inventory selection. Ctrl-U clears the regex
while preserving staging. From the inventory, Ctrl-U clears the complete
selection.

`space` on an entry selects it. `space` on a section takes or clears the whole
section, so a bundle of twenty-two is one keystroke; the left pane shows `[ ]`,
`[~]`, or `[x]` for none, some, or all taken. Selection spans sections, so
Skills from several bundles can be reviewed together.

Selection resolves to Removal Targets through the same rule the command line
uses. A fully selected Group collapses into one `source-group` target rather
than a list of its members; a partial selection stays a list of Logical Skill
targets. Plugin and System Skill rows remain visible but have no Removal Target.
With nothing selected, `enter` reviews the removable row under the cursor and
does nothing on an informational row.

`q` exits the TUI immediately from every screen except search, where it is valid
regex input; Ctrl-C remains an alternate exit everywhere. In the inventory,
`esc` unwinds pane focus and then selection before leaving, so a stray keypress
cannot discard a selection.

## Plans, fallback, and reports

The review screen leads with the decision a person must make: what is selected,
whether removal is ready or blocked, what will happen, whether files remain
recoverable, and how the result will be checked. Actions use capability names
and readable sub-lines for methods, paths, and recovery behavior. Repeated
actions that use the same removal method and Owner are shown once with an
affected-capability count. Repeated verification types are likewise condensed
into counted outcomes. Empty warning and block sections are omitted. Safety
warnings and blocks remain prominent and use plain explanations;
package-download consent still shows the exact pinned package, runner, and
adapter identity.

`d` toggles technical details containing exact targets, action and verification
identifiers, commands, hashes, and approval records. Up and down, Page Up and
Page Down, and the mouse wheel scroll an overflowing review while its action
row remains visible. The status row reports the visible range. A blocked plan
cannot be confirmed. `f` asks Planning for a force plan only when every reported
block is marked overridable; force cannot override Git, System Skill,
filesystem, adapter-trust, Plugin-boundary, or unavailable-managed-removal
blocks.

Pressing `y` on an unblocked plan is the mutation boundary. Package trust is
shown as an exact runner/package/version/adapter-hash tuple before this
confirmation. It immediately opens a non-interactive execution screen naming
the selected capability or selection and its approved target and action counts.
That screen explains that the approved removal, verification, and final
inventory scan are running; it intentionally shows no percentage or per-action
progress because Execution returns a final report rather than progress events.
A managed-removal failure is reported without running a
filesystem fallback. If Execution returns fallback plans, `f` opens one as a
new brute-force review and a second `y` is required. That plan uses Quarantine
for filesystem removal. The final screen leads with `Completed`, `Completed
with concerns`, `Could not complete`, or `Blocked`. It uses capability and
category names from the saved Inventory, condenses successful outcomes into
counts, and expands only actionable concerns. `d` exposes exact identifiers
and raw errors. Its body scrolls with Up/Down, Page Up/Page Down, or the wheel;
the status/action footer remains visible and gives the visible range. Resizing
clamps that viewport. Left/Right selects an offered fallback, while vertical
scrolling never changes that selection.

### Technical report reference

The review, execution-feedback, and final-report screens describe the same
execution model at different times. A **target** is the requested capability,
source group, or Plugin boundary. An **action** is an approved managed removal,
recoverable quarantine, or record cleanup. A **verification check** tests the
promised post-removal condition. Review shows their planned forms;
execution-feedback intentionally shows only approved target/action counts
because Execution returns one final report; that report gives their results.

Technical details expose the `planId`, the source `inventoryId`, and the
`finalInventoryId` when the final scan succeeds. The report and every action
carry `startedAt`/`completedAt` timestamps; they are for audit correlation, not
progress. Target statuses are `removed`, `unchanged`, `partially-removed`,
`unresolved`, `failed`, and `blocked`; action statuses are `succeeded`,
`unchanged`, `failed`, `blocked`, and `skipped`; verification statuses are
`passed`, `failed`, and `skipped`. Raw target/action/check IDs, error codes,
messages, and rescan errors are technical-detail material.

A fallback plan is a new complete brute-force plan from the final Inventory.
It is offered for separate review only and never runs automatically: select it,
open it with `f`, then confirm it independently. It has its own targets,
actions, verification checks, identifiers, and approval boundary.

## Limited terminals

When raw terminal controls are unavailable, the same UI uses line-oriented
commands. In the inventory, use `search <regex>`, `up`, `down`, `in`, `out`,
`detail`, `pageup`, `pagedown`, `grow-detail`, `shrink-detail`, `take`, `clear`,
and `quit`. Search accepts a regex, `up`, `down`, `take`, `all`, `clear`, `done`,
and `cancel`. Plan screens accept `yes`, `no`, `details`, `up`, `down`,
`pageup`, `pagedown`, `force`, and `quit`; report screens accept `up`, `down`,
`pageup`, `pagedown`, `details`, `previous`, `next`, `fallback`, and `quit`.
End-of-input cancels safely.
After `yes`, the line-oriented interface also renders the non-interactive
execution screen until the final report or error is ready.

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

`renderTui(state, theme?)` and `renderBrowseLines(state, theme?)` accept a
declarative `TuiTheme`. `createNodeTuiTerminal(input?, output?, options?)`
accepts an explicit theme for embedding; otherwise it selects a Nightfall color
mode from the output terminal and environment. `createNightfallTheme(mode)`,
`nightfallTheme`, and `plainTuiTheme` are exported with the theme types.
